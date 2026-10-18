/**
 * Which proxy (if any) a provider request goes through, and which certificates it trusts — decided
 * exactly as the shipping engine decides them, so a computer on which 1.1.0 reached Google reaches it
 * the same way here.
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * gst 3.7.0 bundles Python 3.14, google-genai 2.18.1 and httpx 0.28.1 (`gst.exe` strings; the
 * google-genai version is pinned by its dist-info). Its client is created with default options
 * (`main.py:1059`), so the rules are those three libraries' defaults:
 * - Proxies: `urllib.request.getproxies()` — `*_proxy` environment variables, or, only when there is
 *   none at all, Windows' per-user Internet Settings (`ProxyEnable` / `ProxyServer`). httpx turns that
 *   into URL patterns (`get_environment_proxies`) and NO_PROXY exclusions, most specific first.
 *   ProxyOverride and automatic configuration (a PAC script) are not read by any of the three.
 * - Trust: google-genai builds the TLS context from `SSL_CERT_FILE` (replacing the bundled Mozilla
 *   roots) and `SSL_CERT_DIR` (adding to them) — `_api_client.py:1108-1111`.
 * gate_ledger.md §5.25 records the source reads and the measurements of gst against a loopback proxy.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'

/** Windows' per-user Internet Settings, as `reg query` reports them. Missing values are null. */
export interface InternetSettings {
  proxyEnable: string | null
  proxyServer: string | null
}

/** Everything the decision reads from the computer. Gates pass their own; production reads the real ones. */
export interface NetworkSources {
  env: Readonly<Record<string, string | undefined>>
  /** null off Windows, or when the settings cannot be read (urllib then returns no proxies). */
  internetSettings: () => Promise<InternetSettings | null>
  readFile: (file: string) => Promise<Buffer>
  listDir: (dir: string) => Promise<string[]>
}

export interface ProxyRoute {
  secure: boolean
  host: string
  port: number
  /** `Basic …` when the proxy URL carried a user name or password. Never logged. */
  authorization: string | null
}

export interface NetworkRoute {
  proxy: ProxyRoute | null
  /** Trusted roots for the provider's TLS; undefined keeps Node's bundled Mozilla set. */
  ca: string[] | undefined
}

/** A setting on this computer that cannot be used. Its message names no address and no credential. */
export class NetworkConfigError extends Error {
  readonly code: 'ERR_NG_PROXY_CONFIG' | 'ERR_NG_CA_FILE'
  constructor(code: NetworkConfigError['code'], message: string) {
    super(message)
    this.name = 'NetworkConfigError'
    this.code = code
  }
}

// ── urllib.request (Python 3.14) ─────────────────────────────────────────────

/** `getproxies_environment()`: two passes, so an all-lowercase variable wins; empty values skip or clear. */
export function environmentProxies(env: NetworkSources['env']): Map<string, string> {
  const proxies = new Map<string, string>()
  const seen: Array<[string, string, string]> = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (name.length > 5 && name[name.length - 6] === '_' && name.slice(-5).toLowerCase() === 'proxy') {
      const scheme = name.slice(0, -6).toLowerCase()
      seen.push([name, value, scheme])
      if (value) proxies.set(scheme, value)
    }
  }
  if ('REQUEST_METHOD' in env) proxies.delete('http')
  for (const [name, value, scheme] of seen) {
    if (name.slice(-6) !== '_proxy') continue
    if (value) proxies.set(scheme, value)
    else proxies.delete(scheme)
  }
  return proxies
}

/** `getproxies_registry()`, including its habit of keeping what it parsed before a malformed entry. */
export function registryProxies(settings: InternetSettings | null): Map<string, string> {
  const proxies = new Map<string, string>()
  if (!settings || settings.proxyEnable === null) return proxies
  const enable = /^0x[0-9a-f]+$/i.test(settings.proxyEnable) ? parseInt(settings.proxyEnable, 16) : settings.proxyEnable
  if (!enable) return proxies
  if (settings.proxyServer === null) return proxies
  let server = settings.proxyServer
  if (!server.includes('=') && !server.includes(';')) server = `http=${server};https=${server};ftp=${server}`
  for (const part of server.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) return proxies
    const protocol = part.slice(0, eq)
    let address = part.slice(eq + 1)
    if (!/^[^/:]+:\/\//.test(address)) {
      if (protocol === 'http' || protocol === 'https' || protocol === 'ftp') address = `http://${address}`
      else if (protocol === 'socks') address = `socks://${address}`
    }
    proxies.set(protocol, address)
  }
  const socks = proxies.get('socks')
  if (socks) {
    const address = socks.replace(/^socks:\/\//, 'socks4://')
    proxies.set('http', proxies.get('http') || address)
    proxies.set('https', proxies.get('https') || address)
  }
  return proxies
}

// ── httpx 0.28.1 ─────────────────────────────────────────────────────────────

interface Pattern {
  scheme: string
  host: string
  port: number | null
  hostRegex: RegExp | null
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { ftp: 21, http: 80, https: 443, ws: 80, wss: 443 }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** httpx `URLPattern`, for the pattern shapes `get_environment_proxies` can produce. */
function parsePattern(pattern: string): Pattern {
  const sep = pattern.indexOf('://')
  const rawScheme = (sep < 0 ? pattern : pattern.slice(0, sep)).toLowerCase()
  let rest = sep < 0 ? '' : pattern.slice(sep + 3)
  const slash = rest.search(/[/?#]/)
  if (slash >= 0) rest = rest.slice(0, slash)
  const at = rest.lastIndexOf('@')
  if (at >= 0) rest = rest.slice(at + 1)
  let host = rest
  let port: number | null = null
  const v6 = /^\[([^\]]*)\](?::(\d+))?$/.exec(rest)
  if (v6) {
    host = v6[1]
    if (v6[2]) port = Number(v6[2])
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon >= 0 && /^\d+$/.test(rest.slice(colon + 1))) {
      host = rest.slice(0, colon)
      port = Number(rest.slice(colon + 1))
    }
  }
  host = host.toLowerCase()
  if (port !== null && DEFAULT_PORTS[rawScheme] === port) port = null
  let hostRegex: RegExp | null = null
  if (host && host !== '*') {
    if (host.startsWith('*.')) hostRegex = new RegExp(`^.+\\.${escapeRegex(host.slice(2))}$`)
    else if (host.startsWith('*')) hostRegex = new RegExp(`^(.+\\.)?${escapeRegex(host.slice(1))}$`)
    else hostRegex = new RegExp(`^${escapeRegex(host)}$`)
  }
  return { scheme: rawScheme === 'all' ? '' : rawScheme, host: host === '*' ? '' : host, port, hostRegex }
}

/** httpx `is_ipv4_hostname` / `is_ipv6_hostname`: the part before any `/` is an address. */
const isIPv4 = (host: string): boolean => net.isIPv4(host.split('/')[0])
const isIPv6 = (host: string): boolean => net.isIPv6(host.split('/')[0])

export interface ProxyMount {
  pattern: string
  /** null: this destination is excluded from proxying (NO_PROXY). */
  proxy: string | null
}

/** `get_environment_proxies()` over `getproxies()`, in httpx's match order (most specific first). */
export function proxyMounts(proxies: Map<string, string>): ProxyMount[] {
  const mounts = new Map<string, string | null>()
  for (const scheme of ['http', 'https', 'all']) {
    const value = proxies.get(scheme)
    if (value) mounts.set(`${scheme}://`, value.includes('://') ? value : `http://${value}`)
  }
  for (const raw of (proxies.get('no') ?? '').split(',')) {
    const hostname = raw.trim()
    if (hostname === '*') return []
    if (!hostname) continue
    if (hostname.includes('://')) mounts.set(hostname, null)
    else if (isIPv4(hostname)) mounts.set(`all://${hostname}`, null)
    else if (isIPv6(hostname)) mounts.set(`all://[${hostname}]`, null)
    else if (hostname.toLowerCase() === 'localhost') mounts.set(`all://${hostname}`, null)
    else mounts.set(`all://*${hostname}`, null)
  }
  const priority = (p: Pattern): [number, number, number] => [p.port !== null ? 0 : 1, -p.host.length, -p.scheme.length]
  return [...mounts.entries()]
    .map(([pattern, proxy], order) => ({ pattern, proxy, order, key: priority(parsePattern(pattern)) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.order - b.order)
    .map(({ pattern, proxy }) => ({ pattern, proxy }))
}

function matches(pattern: Pattern, url: URL): boolean {
  const scheme = url.protocol.replace(/:$/, '')
  if (pattern.scheme && pattern.scheme !== scheme) return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (pattern.host && pattern.hostRegex && !pattern.hostRegex.test(host)) return false
  const port = url.port === '' ? null : Number(url.port)
  if (pattern.port !== null && pattern.port !== port) return false
  return true
}

/** httpx `Proxy(url)`: only http/https proxies are usable; credentials become Proxy-Authorization. */
function proxyRoute(value: string): ProxyRoute {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new NetworkConfigError('ERR_NG_PROXY_CONFIG', 'The proxy address set on this computer is not a valid URL.')
  }
  const scheme = url.protocol.replace(/:$/, '')
  if (scheme !== 'http' && scheme !== 'https') {
    // socks5/socks5h need httpx's optional `socksio`, which gst does not bundle; anything else is
    // refused by httpx itself. Either way gst cannot use it (gate_ledger.md §5.25).
    throw new NetworkConfigError('ERR_NG_PROXY_CONFIG', `A ${scheme} proxy is set on this computer; only http and https proxies are supported.`)
  }
  const user = decodeURIComponent(url.username)
  const pass = decodeURIComponent(url.password)
  return {
    secure: scheme === 'https',
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : scheme === 'https' ? 443 : 80,
    authorization: user || pass ? `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}` : null
  }
}

/**
 * The proxy for `url`, or null for a direct connection. Like httpx, every configured proxy is
 * validated, not only the one that matches: a client with an unusable proxy setting is not created.
 */
export function selectProxy(url: URL, proxies: Map<string, string>): ProxyRoute | null {
  const mounts = proxyMounts(proxies)
  const routes = new Map<string, ProxyRoute>()
  for (const m of mounts) if (m.proxy !== null) routes.set(m.pattern, proxyRoute(m.proxy))
  for (const m of mounts) {
    if (matches(parsePattern(m.pattern), url)) return m.proxy === null ? null : routes.get(m.pattern) ?? null
  }
  return null
}

// ── google-genai 2.18.1: the TLS trust store ────────────────────────────────

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
/** OpenSSL looks a `capath` certificate up by its subject-hash file name, so only those names count. */
const HASHED_NAME = /^[0-9a-f]{8}\.\d+$/i

async function trustedRoots(sources: NetworkSources): Promise<string[] | undefined> {
  const file = sources.env.SSL_CERT_FILE
  const dir = sources.env.SSL_CERT_DIR
  if (!file && !dir) return undefined
  const roots: string[] = []
  if (file) {
    let text: string
    try {
      text = (await sources.readFile(file)).toString('latin1')
    } catch {
      throw new NetworkConfigError('ERR_NG_CA_FILE', 'The certificate file named by SSL_CERT_FILE could not be read.')
    }
    const certs = text.match(PEM_CERT) ?? []
    if (certs.length === 0) throw new NetworkConfigError('ERR_NG_CA_FILE', 'The certificate file named by SSL_CERT_FILE holds no certificate.')
    roots.push(...certs)
  } else {
    roots.push(...tls.rootCertificates)
  }
  if (dir) {
    // A directory that cannot be read adds nothing, as OpenSSL's lazy lookup does (measured: gst runs).
    const names = await sources.listDir(dir).catch(() => [] as string[])
    for (const name of names.filter((n) => HASHED_NAME.test(n))) {
      const text = await sources.readFile(path.join(dir, name)).then((b) => b.toString('latin1'), () => '')
      roots.push(...(text.match(PEM_CERT) ?? []))
    }
  }
  return roots
}

// ── the decision ─────────────────────────────────────────────────────────────

/** Where one https request goes, and what it trusts. Plain http (loopback gates only) never asks. */
export async function resolveNetworkRoute(url: URL, sources: NetworkSources): Promise<NetworkRoute> {
  let proxies = environmentProxies(sources.env)
  if (proxies.size === 0) proxies = registryProxies(await sources.internetSettings())
  const proxy = selectProxy(url, proxies)
  return { proxy, ca: await trustedRoots(sources) }
}

// ── the real computer ────────────────────────────────────────────────────────

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const SETTINGS_TTL_MS = 30_000
let cachedSettings: { at: number; value: Promise<InternetSettings | null> } | null = null

/** Parses `reg query` output: `    Name    REG_TYPE    data`. Exported for the gates. */
export function parseRegQuery(stdout: string): InternetSettings {
  const out: InternetSettings = { proxyEnable: null, proxyServer: null }
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s{4}(REG_\w+)(?:\s{4}(.*))?$/.exec(line)
    if (!m) continue
    if (m[1] === 'ProxyEnable') out.proxyEnable = m[3] ?? ''
    else if (m[1] === 'ProxyServer') out.proxyServer = m[3] ?? ''
  }
  return out
}

function readInternetSettings(): Promise<InternetSettings | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const now = Date.now()
  if (cachedSettings && now - cachedSettings.at < SETTINGS_TTL_MS) return cachedSettings.value
  const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  const value = new Promise<InternetSettings | null>((resolve) => {
    execFile(reg, ['query', INTERNET_SETTINGS_KEY], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      resolve(error ? null : parseRegQuery(String(stdout)))
    })
  })
  cachedSettings = { at: now, value }
  return value
}

/** The settings of the computer the app runs on, read when each request is routed. */
export const systemNetworkSources: NetworkSources = {
  get env() {
    return process.env
  },
  internetSettings: readInternetSettings,
  readFile: (file) => fs.readFile(file),
  listDir: (dir) => fs.readdir(dir)
}
