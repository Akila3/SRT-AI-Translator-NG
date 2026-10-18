/**
 * OpenSubtitles (opensubtitles.com REST API): Check, search and a selected download, all in main
 * (implementation_plan.md §9.9 / §14.6; feature_decisions.md §3.1a, §3.1c, §3.5; live facts codebase_map.md §34).
 * AUTHORED-BY: opus-5.5-high
 *
 * Credentials, all optional (tester, 2026-10-16): the user's own API key, and/or a username and password.
 * An own key is used when present; with none, each request carries a key from the shared pool (osKeyPool.ts).
 * A login rides with whichever key: a download is then charged to the account, not the key. The session token
 * lives in this object only, never in settings or a log, and one client logs in at most once — plus at most one
 * re-login when the service says the token itself expired. A login refused with 401 is never retried: ten
 * failures lock the account.
 *
 * Every request sends `User-Agent: SRT AI Translator v<version>` (D8) and goes through an injected transport;
 * the app passes Electron's `net.fetch`, so the operating system's certificates and proxy settings apply and
 * this file carries no network configuration of its own.
 *
 * The remainder of a download allowance is read from the response that reports it (`remaining`, or
 * `remaining_downloads` from `/infos/user`). When neither is present it is `null` — unknown, never zero and
 * never a guessed figure. Nothing here downloads automatically; the walk that spends it is H.10's.
 */
import { promises as dnsPromises } from 'dns'
import { isIP } from 'net'
import { readBoundedBody, readSubtitleBody, type ArchiveMember, type ArchiveRefusal } from './subtitleArchive'
import type { KeyPool } from './osKeyPool'
import type { OsCandidate } from '../shared/types'

export type { OsCandidate }

export const OS_API_ORIGIN = 'https://api.opensubtitles.com'
export const OS_CONSUMERS_URL = 'https://www.opensubtitles.com/en/consumers'
export const OS_REQUEST_TIMEOUT_MS = 30_000
/** Search pages read at most; a title with more is reported `partial`, never as complete. */
export const OS_SEARCH_MAX_PAGES = 10
/** The service allows five requests a second; requests are spaced at least this far apart. */
export const OS_REQUEST_SPACING_MS = 250
/** A rate-limit wait longer than this is not waited out: the request fails as rateLimit. */
export const OS_MAX_RATE_WAIT_MS = 10_000
const API_BODY_LIMIT = 1024 * 1024

export function osUserAgent(version: string): string {
  return `SRT AI Translator v${version}`
}

// ── transport ───────────────────────────────────────────────────────────────────────────────────

export interface OsHttpRequest {
  readonly url: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  /**
   * Nothing follows a redirect on its own. API calls refuse one (`error`); a file fetch takes the 3xx back
   * unfollowed (`manual`, its target in `location`) and `getCheckedRedirects` settles the next hop first.
   */
  readonly redirect: 'error' | 'manual'
  readonly signal: AbortSignal
}

export interface OsHttpResponse {
  readonly status: number
  /** The final URL after any redirect. */
  readonly url: string
  readonly headers: { get(name: string): string | null }
  readonly body: ReadableStream<Uint8Array> | null
}

export type OsTransport = (request: OsHttpRequest) => Promise<OsHttpResponse>

/**
 * The app's transport: API calls over a fetch with the standard shape (Electron's `net.fetch`), and `manual`
 * requests over `manualImpl` — Electron 31's `net.fetch` throws on a manual redirect without naming its target.
 */
export function fetchTransport(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, manualImpl?: OsTransport): OsTransport {
  return async (r) => {
    if (r.redirect === 'manual') {
      if (!manualImpl) throw new Error('redirect: no manual transport')
      return manualImpl(r)
    }
    const res = await fetchImpl(r.url, { method: r.method, headers: r.headers, body: r.body, redirect: r.redirect, signal: r.signal })
    return { status: res.status, url: res.url || r.url, headers: res.headers, body: res.body }
  }
}

/** Every address a host name resolves to on this machine. */
export type HostLookup = (hostname: string) => Promise<readonly string[]>

export const systemLookup: HostLookup = async (hostname) => (await dnsPromises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address)

/**
 * Thrown by a lookup that cannot answer a name the system sends through a proxy: the proxy resolves it on its own
 * network, so a local failure is not a refusal (tester decision, 2026-10-17). An answer this machine does give
 * is still checked, proxy or not.
 */
export class ResolvedByProxy extends Error {
  constructor() {
    super('the proxy resolves this name')
    this.name = 'ResolvedByProxy'
  }
}

/** Redirects a file fetch follows before it gives up. */
export const MAX_REDIRECT_HOPS = 5

// ── results ─────────────────────────────────────────────────────────────────────────────────────

export type OsFailureKind =
  | 'cancelled'
  | 'timeout'
  | 'transport'
  | 'redirect'
  | 'unavailable'
  | 'rateLimit'
  | 'auth'
  | 'quota'
  | 'notAccepted'
  | 'malformed'
  | 'body'

export interface OsFailure {
  readonly kind: OsFailureKind
  /** The HTTP status that decided it; null when no response arrived. */
  readonly status: number | null
  readonly retryAfterSeconds?: number
  readonly bodyReason?: ArchiveRefusal
}

export type KeySource = 'own' | 'pool'
export type LoginState = 'notEntered' | 'notTried' | 'ok' | 'rejected' | 'unavailable'

export interface OsCredentials {
  readonly apiKey: string
  readonly username: string
  readonly password: string
}

export interface OsSearchQuery {
  /** `tt0133093` or `133093`. For an episode, the episode's own id or the show's with season and episode. */
  readonly imdbId: string
  readonly season?: number
  readonly episode?: number
  readonly languages: readonly string[]
}

export type OsSearch =
  | { readonly state: 'complete'; readonly candidates: readonly OsCandidate[] }
  | { readonly state: 'partial'; readonly candidates: readonly OsCandidate[]; readonly failure: OsFailure | null; readonly pagesRead: number; readonly totalPages: number }
  | { readonly state: 'failed'; readonly failure: OsFailure }

export type OsDownload =
  | {
      readonly ok: true
      readonly members: readonly ArchiveMember[]
      readonly fileName: string
      readonly remaining: number | null
      readonly resetUtc: string | null
      readonly keySource: KeySource
      readonly charged: 'key' | 'account'
      readonly keysTried: number
      readonly login: LoginState
    }
  | {
      readonly ok: false
      readonly failure: OsFailure
      readonly remaining: number | null
      readonly resetUtc: string | null
      readonly keysTried: number
      readonly login: LoginState
      /**
       * Set when `/download` granted the file (200, so the allowance was spent) and fetching or reading it then
       * failed; null when nothing was granted. The walk's allowance decisions read it as they read a success.
       */
      readonly allocation: { readonly keySource: KeySource; readonly charged: 'key' | 'account' } | null
    }

export type KeyCheck =
  | { readonly state: 'accepted'; readonly source: KeySource; readonly atDailyLimit: boolean }
  | { readonly state: 'notAccepted'; readonly source: KeySource }
  | { readonly state: 'notAcceptedOrUnavailable'; readonly source: KeySource }
  | { readonly state: 'failed'; readonly source: KeySource; readonly failure: OsFailure }

export type LoginCheck =
  | { readonly state: 'notEntered' }
  | { readonly state: 'ok'; readonly remaining: number | null; readonly allowed: number | null; readonly level: string | null; readonly resetUtc: string | null }
  | { readonly state: 'rejected' }
  | { readonly state: 'failed'; readonly failure: OsFailure }

export interface OsCheck {
  readonly key: KeyCheck
  readonly login: LoginCheck
}

// ── pure readers ────────────────────────────────────────────────────────────────────────────────

/** A response's remainder: `remaining` (download) or `remaining_downloads` (`/infos/user`); null when neither is a number. */
export function readRemainder(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const data = o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : null
  for (const v of [o.remaining, o.remaining_downloads, data?.remaining_downloads]) {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  }
  return null
}

function readReset(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const data = o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : null
  const v = o.reset_time_utc ?? data?.reset_time_utc
  return typeof v === 'string' && v.length <= 64 ? v : null
}

function messageOf(json: unknown): string {
  if (typeof json === 'string') return json
  if (!json || typeof json !== 'object') return ''
  const o = json as Record<string, unknown>
  return [o.message, o.error, o.errors].map((v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '')).join(' ')
}

/**
 * A 406 that says the daily allowance is spent (the service names the allowance, or reports a remainder below
 * one), as opposed to a 406 about this request — `Invalid file_id`, or a query the service will not serve,
 * which says nothing about quota (feature_decisions.md §3.5).
 */
export function isQuota406(json: unknown): boolean {
  const remaining = readRemainder(json)
  if (remaining !== null && remaining < 1) return true
  return /allowed\s+\d+\s+subtitles|downloaded\s+your\s+allowed|download\s+(?:limit|quota)|daily\s+(?:limit|quota)/i.test(messageOf(json))
}

/** A 401/403 whose body says the session token is the problem — the only case a re-login can mend. */
export function isTokenProblem(json: unknown): boolean {
  return /\b(?:token|jwt)\b|expired/i.test(typeof json === 'string' ? json : JSON.stringify(json ?? ''))
}

/** OpenSubtitles language codes for one app language value. */
export function osLanguageCodes(language: string): string[] {
  const v = language.trim()
  if (v === 'pt') return ['pm', 'pt-br', 'pt-pt']
  if (/^pt-br$/i.test(v)) return ['pt-br']
  if (/^pt-pt$/i.test(v)) return ['pt-pt']
  if (v === 'zh') return ['zh-cn']
  if (/^zh-tw$/i.test(v)) return ['zh-tw']
  return [v.split(/[-_]/)[0].toLowerCase()]
}

/** The app's language value for a code the service returned. */
export function fromOsLanguage(code: string): string {
  const v = code.trim().toLowerCase()
  if (v === 'pt-br' || v === 'pt-pt' || v === 'pm') return 'pt'
  if (v === 'zh-cn') return 'zh'
  if (v === 'zh-tw') return 'zh-TW'
  return v.split(/[-_]/)[0]
}

function imdbNumber(id: string): number | null {
  const m = /^(?:tt)?0*(\d{1,10})$/i.exec(id.trim())
  return m ? Number(m[1]) : null
}

/** The search URL with its parameters in alphabetical order, as the service asks, so its cache is hit. */
export function searchUrl(origin: string, query: OsSearchQuery, page: number): string | null {
  const imdb = imdbNumber(query.imdbId)
  const codes = [...new Set(query.languages.flatMap(osLanguageCodes))].sort()
  if (imdb === null || !codes.length) return null
  // The service answers a default-valued `page=1` with a 301 to the URL without it; API calls follow no redirect.
  const params: [string, string][] = [['languages', codes.join(',')], ...(page > 1 ? [['page', String(page)] as [string, string]] : [])]
  if (query.season !== undefined && query.episode !== undefined) {
    params.push(['episode_number', String(query.episode)], ['parent_imdb_id', String(imdb)], ['season_number', String(query.season)])
  } else {
    params.push(['imdb_id', String(imdb)])
  }
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `${origin}/api/v1/subtitles?${params.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+').replace(/%2C/g, ',')}`).join('&')}`
}

/** One search page: its single-file subtitles in the service's order, and its page count. Null when malformed. */
export function parseSearchPage(json: unknown): { candidates: OsCandidate[]; totalPages: number } | null {
  if (!json || typeof json !== 'object' || !Array.isArray((json as { data?: unknown }).data)) return null
  const o = json as { data: unknown[]; total_pages?: unknown }
  const totalPages = typeof o.total_pages === 'number' && Number.isFinite(o.total_pages) && o.total_pages >= 0 ? Math.trunc(o.total_pages) : 1
  const candidates: OsCandidate[] = []
  for (const item of o.data) {
    const a = item && typeof item === 'object' ? ((item as { attributes?: unknown }).attributes as Record<string, unknown> | undefined) : undefined
    if (!a || typeof a !== 'object') continue
    const files = Array.isArray(a.files) ? a.files : []
    // A subtitle split over several CDs is not one timeline; only single-file subtitles can be a reference.
    if (files.length !== 1 || (typeof a.nb_cd === 'number' && a.nb_cd > 1)) continue
    const file = files[0] as { file_id?: unknown; file_name?: unknown }
    if (typeof file.file_id !== 'number' || !Number.isSafeInteger(file.file_id) || file.file_id <= 0) continue
    const ai = a.ai_translated
    const mt = a.machine_translated
    const machineTranslated = ai === true || mt === true ? true : typeof ai === 'boolean' && typeof mt === 'boolean' ? false : null
    candidates.push({
      fileId: file.file_id,
      fileName: typeof file.file_name === 'string' ? file.file_name.slice(0, 260) : '',
      subtitleId: typeof a.subtitle_id === 'string' ? a.subtitle_id : String((item as { id?: unknown }).id ?? ''),
      language: typeof a.language === 'string' ? fromOsLanguage(a.language) : '',
      release: typeof a.release === 'string' ? a.release.slice(0, 260) : '',
      machineTranslated,
      hearingImpaired: a.hearing_impaired === true,
      foreignPartsOnly: a.foreign_parts_only === true,
      fromTrusted: a.from_trusted === true,
      downloadCount: typeof a.download_count === 'number' && Number.isFinite(a.download_count) ? a.download_count : 0,
      uploadDate: typeof a.upload_date === 'string' ? a.upload_date.slice(0, 40) : '',
      fps: typeof a.fps === 'number' && Number.isFinite(a.fps) && a.fps > 0 ? a.fps : null
    })
  }
  return { candidates, totalPages }
}

/** The login's `base_url`, kept only when it is an opensubtitles.com host: credentials go nowhere else. */
export function loginOrigin(baseUrl: unknown): string | null {
  if (typeof baseUrl !== 'string') return null
  const host = baseUrl.trim().replace(/^https:\/\//i, '').replace(/\/.*$/, '')
  return /^(?:[a-z0-9-]+\.)*opensubtitles\.com$/i.test(host) ? `https://${host.toLowerCase()}` : null
}

/** An IP address that is not loopback, private, link-local, shared (CGNAT), unspecified, multicast or v4-mapped. */
export function publicAddress(ip: string): boolean {
  const host = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if ((a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false
    return true
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')) return false
  }
  return true
}

/**
 * A URL the app may fetch a file from: HTTPS to a named public host. A loopback, private or link-local address,
 * `localhost` and single-label or `.local`/`.internal` names are refused. The name's DNS answer is settled
 * separately, by `publicDestination`, before each hop is contacted.
 */
export function publicHttpsUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host.includes('.') && !host.includes(':')) return false
  if (host === 'localhost' || /\.(?:localhost|local|internal|lan|home|corp)$/.test(host)) return false
  return publicAddress(host)
}

/**
 * `publicHttpsUrl`, and the resolver gives the name at least one address and every one is public. A name the
 * resolver cannot answer, or answers with nothing, is refused: an unverified destination is never contacted —
 * unless the lookup reports `ResolvedByProxy`, where the proxy resolves it and the certificate check remains.
 * Production resolves through the session the transport connects with (`osService.ts` `sessionLookup`).
 */
export async function publicDestination(raw: string, lookup: HostLookup): Promise<boolean> {
  if (!publicHttpsUrl(raw)) return false
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return true
  let addresses: readonly string[]
  try {
    addresses = await lookup(host)
  } catch (err) {
    return err instanceof ResolvedByProxy
  }
  return addresses.length > 0 && addresses.every(publicAddress)
}

/**
 * A GET that follows redirects by hand: each destination — the first included — passes `publicDestination`
 * before it is contacted, at most `MAX_REDIRECT_HOPS` redirects are taken, and no header but the given ones is
 * sent to any hop. A refused hop is `redirect` (status: the 3xx that named it, or null for the first URL).
 * Transport errors (Stop, timeout, network) are thrown, as the transport throws them.
 */
export async function getCheckedRedirects(
  transport: OsTransport,
  lookup: HostLookup,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<{ ok: true; res: OsHttpResponse } | { ok: false; status: number | null }> {
  let at = url
  let status: number | null = null
  for (let hop = 0; ; hop += 1) {
    if (!(await publicDestination(at, lookup))) return { ok: false, status }
    if (signal.aborted) throw new Error('aborted')
    const res = await transport({ url: at, method: 'GET', headers, redirect: 'manual', signal })
    const location = res.headers.get('location')
    if (res.status < 300 || res.status > 399 || res.status === 304 || location === null) return { ok: true, res }
    await res.body?.cancel().catch(() => undefined)
    status = res.status
    if (hop >= MAX_REDIRECT_HOPS) return { ok: false, status }
    try {
      at = new URL(location, at).toString()
    } catch {
      return { ok: false, status }
    }
  }
}

function retryAfterSeconds(headers: { get(name: string): string | null }): number | undefined {
  for (const name of ['retry-after', 'ratelimit-reset', 'x-ratelimit-reset']) {
    const n = Number(headers.get(name))
    if (Number.isFinite(n) && n >= 0) return n
  }
  return undefined
}

// ── the client ──────────────────────────────────────────────────────────────────────────────────

export interface OsClientOptions {
  readonly transport: OsTransport
  readonly userAgent: string
  readonly credentials: OsCredentials
  readonly pool: KeyPool
  /** A wait that ends early when the signal aborts. Injected by gates. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly now?: () => number
  readonly timeoutMs?: number
  /** Resolves a download host before it is contacted. Injected by gates; the system resolver otherwise. */
  readonly lookup?: HostLookup
}

type Call = { ok: true; status: number; json: unknown; headers: { get(name: string): string | null } } | { ok: false; failure: OsFailure }

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export class OpenSubtitlesClient {
  private jwt: string | null = null
  private origin = OS_API_ORIGIN
  private loginState: LoginState
  private relogins = 0
  private lastRequestAt = Number.NEGATIVE_INFINITY
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly creds: OsCredentials

  constructor(private readonly o: OsClientOptions) {
    this.creds = { apiKey: o.credentials.apiKey.trim(), username: o.credentials.username.trim(), password: o.credentials.password }
    this.loginState = this.hasLogin ? 'notTried' : 'notEntered'
    this.sleep = o.sleep ?? defaultSleep
    this.now = o.now ?? Date.now
    this.timeoutMs = o.timeoutMs ?? OS_REQUEST_TIMEOUT_MS
  }

  get hasLogin(): boolean {
    return this.creds.username.length > 0 && this.creds.password.length > 0
  }

  get keySource(): KeySource {
    return this.creds.apiKey ? 'own' : 'pool'
  }

  get login(): LoginState {
    return this.loginState
  }

  /** Every secret this client holds or may send, for the redaction sweep. */
  secrets(): string[] {
    return [this.creds.apiKey, this.creds.username, this.creds.password, this.jwt ?? '', ...this.o.pool.all()].filter((s) => s.length > 0)
  }

  private async keyOrder(): Promise<{ key: string; source: KeySource }[]> {
    if (this.creds.apiKey) return [{ key: this.creds.apiKey, source: 'own' }]
    return (await this.o.pool.attemptOrder()).map((key) => ({ key, source: 'pool' as const }))
  }

  private async call(url: string, method: OsHttpRequest['method'], key: string, signal: AbortSignal, body?: unknown, bearer = true): Promise<Call> {
    const wait = this.lastRequestAt + OS_REQUEST_SPACING_MS - this.now()
    if (wait > 0) await this.sleep(wait, signal)
    if (signal.aborted) return { ok: false, failure: { kind: 'cancelled', status: null } }
    this.lastRequestAt = this.now()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const both = AbortSignal.any([signal, timeout])
    const headers: Record<string, string> = { 'Api-Key': key, 'User-Agent': this.o.userAgent, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (bearer && this.jwt) headers.Authorization = `Bearer ${this.jwt}`
    try {
      const res = await this.o.transport({ url, method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: both })
      const read = await readBoundedBody(res, API_BODY_LIMIT)
      if (!read.ok) return { ok: false, failure: { kind: 'body', status: res.status, bodyReason: 'body' } }
      const text = read.bytes.toString('utf8')
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = text.slice(0, 512)
      }
      return { ok: true, status: res.status, json, headers: res.headers }
    } catch (err) {
      if (signal.aborted) return { ok: false, failure: { kind: 'cancelled', status: null } }
      if (timeout.aborted) return { ok: false, failure: { kind: 'timeout', status: null } }
      return { ok: false, failure: { kind: /redirect/i.test(String((err as Error)?.message ?? err)) ? 'redirect' : 'transport', status: null } }
    }
  }

  /** One login for this client. 401 is final: never retried. */
  private async ensureLogin(signal: AbortSignal): Promise<LoginState> {
    if (this.loginState !== 'notTried') return this.loginState
    const order = await this.keyOrder()
    for (const { key, source } of order) {
      const r = await this.call(`${OS_API_ORIGIN}/api/v1/login`, 'POST', key, signal, { username: this.creds.username, password: this.creds.password }, false)
      if (!r.ok) {
        if (r.failure.kind === 'cancelled') return 'notTried'
        this.loginState = 'unavailable'
        return this.loginState
      }
      if (r.status === 200) {
        const o = (r.json ?? {}) as { token?: unknown; base_url?: unknown }
        if (typeof o.token !== 'string' || !o.token) {
          this.loginState = 'unavailable'
          return this.loginState
        }
        this.jwt = o.token
        this.origin = loginOrigin(o.base_url) ?? OS_API_ORIGIN
        this.loginState = 'ok'
        return this.loginState
      }
      if (r.status === 401) {
        this.loginState = 'rejected'
        return this.loginState
      }
      // A pool key the service will not accept answers 503; the next key may be accepted.
      if (source === 'pool' && (r.status === 503 || r.status === 403)) continue
      break
    }
    this.loginState = 'unavailable'
    return this.loginState
  }

  private async relogin(signal: AbortSignal): Promise<boolean> {
    if (this.relogins >= 1 || !this.hasLogin) return false
    this.relogins += 1
    this.jwt = null
    this.origin = OS_API_ORIGIN
    this.loginState = 'notTried'
    return (await this.ensureLogin(signal)) === 'ok'
  }

  /**
   * Check what is entered: the key by asking to download file 0 (no allowance is spent; 406 `Invalid file_id`
   * means accepted, 503 means not accepted or the service is down — the service gives both the same answer),
   * and the login by one login, the account's remainder and a logout.
   */
  async check(signal: AbortSignal): Promise<OsCheck> {
    const key = await this.checkKey(signal)
    if (!this.hasLogin) return { key, login: { state: 'notEntered' } }
    const state = await this.ensureLogin(signal)
    if (state === 'rejected') return { key, login: { state: 'rejected' } }
    if (state !== 'ok') return { key, login: { state: 'failed', failure: { kind: signal.aborted ? 'cancelled' : 'unavailable', status: null } } }
    const loginKey = (await this.keyOrder())[0]?.key ?? ''
    const info = await this.call(`${this.origin}/api/v1/infos/user`, 'GET', loginKey, signal)
    const login: LoginCheck =
      info.ok && info.status === 200
        ? (() => {
            const data = ((info.json as { data?: unknown } | null)?.data ?? {}) as Record<string, unknown>
            return {
              state: 'ok' as const,
              remaining: readRemainder(info.json),
              allowed: typeof data.allowed_downloads === 'number' && Number.isFinite(data.allowed_downloads) ? data.allowed_downloads : null,
              level: typeof data.level === 'string' ? data.level.slice(0, 40) : null,
              resetUtc: readReset(info.json)
            }
          })()
        : { state: 'ok', remaining: null, allowed: null, level: null, resetUtc: null }
    await this.logout(signal)
    return { key, login }
  }

  private async checkKey(signal: AbortSignal): Promise<KeyCheck> {
    const first = (await this.keyOrder())[0]
    const source = this.keySource
    if (!first) return { state: 'failed', source, failure: { kind: 'unavailable', status: null } }
    const r = await this.call(`${OS_API_ORIGIN}/api/v1/download`, 'POST', first.key, signal, { file_id: 0 }, false)
    if (!r.ok) return { state: 'failed', source, failure: r.failure }
    if (r.status === 406) return { state: 'accepted', source, atDailyLimit: isQuota406(r.json) }
    if (r.status === 503) return { state: 'notAcceptedOrUnavailable', source }
    if (r.status === 401 || r.status === 403) return { state: 'notAccepted', source }
    if (r.status === 429) return { state: 'failed', source, failure: { kind: 'rateLimit', status: 429, retryAfterSeconds: retryAfterSeconds(r.headers) } }
    return { state: 'failed', source, failure: { kind: r.status >= 500 ? 'unavailable' : 'malformed', status: r.status } }
  }

  /** End the session; the token is forgotten whatever the service answers. */
  async logout(signal: AbortSignal): Promise<void> {
    if (!this.jwt) return
    const key = (await this.keyOrder())[0]?.key ?? ''
    try {
      await this.call(`${this.origin}/api/v1/logout`, 'DELETE', key, signal)
    } finally {
      this.jwt = null
      this.origin = OS_API_ORIGIN
      if (this.loginState === 'ok') this.loginState = 'notTried'
    }
  }

  /**
   * Every page of a search, in the service's order. A page that fails after the first leaves the result
   * `partial` — never empty and never complete; a failed first page is `failed`. Cancellation is a failure.
   */
  async search(query: OsSearchQuery, signal: AbortSignal): Promise<OsSearch> {
    const order = await this.keyOrder()
    if (!searchUrl(OS_API_ORIGIN, query, 1)) return { state: 'failed', failure: { kind: 'malformed', status: null } }
    const seen = new Set<number>()
    const out: OsCandidate[] = []
    let totalPages = 1
    let k = 0
    for (let page = 1; page <= Math.min(totalPages, OS_SEARCH_MAX_PAGES); page += 1) {
      let failure: OsFailure | null = null
      let parsed: ReturnType<typeof parseSearchPage> = null
      for (let rateWaits = 0; ; ) {
        const entry = order[k]
        if (!entry) {
          failure ??= { kind: 'unavailable', status: null }
          break
        }
        failure = null
        const r = await this.call(searchUrl(OS_API_ORIGIN, query, page)!, 'GET', entry.key, signal, undefined, false)
        if (!r.ok) {
          failure = r.failure
          break
        }
        if (r.status === 200) {
          parsed = parseSearchPage(r.json)
          if (!parsed) failure = { kind: 'malformed', status: 200 }
          break
        }
        if (r.status === 429) {
          const after = retryAfterSeconds(r.headers) ?? 1
          if (rateWaits++ < 1 && after * 1000 <= OS_MAX_RATE_WAIT_MS) {
            await this.sleep(after * 1000, signal)
            continue
          }
          failure = { kind: 'rateLimit', status: 429, retryAfterSeconds: after }
          break
        }
        failure = { kind: r.status === 401 || r.status === 403 ? 'auth' : 'unavailable', status: r.status }
        if (entry.source === 'pool' && (r.status === 503 || r.status === 401 || r.status === 403) && k + 1 < order.length) {
          k += 1
          continue
        }
        break
      }
      if (failure || !parsed) {
        if (page === 1) return { state: 'failed', failure: failure ?? { kind: 'malformed', status: null } }
        return { state: 'partial', candidates: out, failure, pagesRead: page - 1, totalPages }
      }
      if (page === 1) totalPages = Math.max(1, parsed.totalPages)
      for (const c of parsed.candidates) {
        if (seen.has(c.fileId)) continue
        seen.add(c.fileId)
        out.push(c)
      }
    }
    if (totalPages > OS_SEARCH_MAX_PAGES) return { state: 'partial', candidates: out, failure: null, pagesRead: OS_SEARCH_MAX_PAGES, totalPages }
    return { state: 'complete', candidates: out }
  }

  /**
   * Download one file. A quota 406 on a pool key with no login moves to the next pool key (at most
   * `POOL_ATTEMPTS`); with an own key, or charged to an account, it stops. A generic 406 is about this file
   * and keeps the session. 401/403 re-logs in once, and only when the body blames the token.
   */
  async download(fileId: number, signal: AbortSignal, fileNameHint = 'subtitle.srt'): Promise<OsDownload> {
    if (this.hasLogin) await this.ensureLogin(signal)
    const order = await this.keyOrder()
    let remaining: number | null = null
    let resetUtc: string | null = null
    let tried = 0
    let last: OsFailure = { kind: 'unavailable', status: null }
    const fail = (failure: OsFailure, allocation: { keySource: KeySource; charged: 'key' | 'account' } | null = null): OsDownload => ({
      ok: false,
      failure,
      remaining,
      resetUtc,
      keysTried: tried,
      login: this.loginState,
      allocation
    })
    for (const { key, source } of order) {
      tried += 1
      for (;;) {
        if (signal.aborted) return fail({ kind: 'cancelled', status: null })
        const r = await this.call(`${this.origin}/api/v1/download`, 'POST', key, signal, { file_id: fileId })
        if (!r.ok) return fail(r.failure)
        const rem = readRemainder(r.json)
        if (rem !== null) remaining = rem
        resetUtc = readReset(r.json) ?? resetUtc
        const charged: 'key' | 'account' = this.jwt ? 'account' : 'key'
        if (r.status === 200) {
          const granted = { keySource: source, charged }
          const o = (r.json ?? {}) as { link?: unknown; file_name?: unknown }
          if (typeof o.link !== 'string' || !publicHttpsUrl(o.link)) return fail({ kind: 'malformed', status: 200 }, granted)
          const name = typeof o.file_name === 'string' && o.file_name ? o.file_name.slice(0, 260) : fileNameHint
          const body = await this.fetchLink(o.link, signal)
          if (!body.ok) return fail(body.failure, granted)
          const read = readSubtitleBody(body.bytes, name)
          if (!read.ok) return fail({ kind: 'body', status: 200, bodyReason: read.reason }, granted)
          return { ok: true, members: read.members, fileName: name, remaining, resetUtc, keySource: source, charged, keysTried: tried, login: this.loginState }
        }
        if (r.status === 406) {
          if (!isQuota406(r.json)) return fail({ kind: 'notAccepted', status: 406 })
          last = { kind: 'quota', status: 406 }
          if (source === 'pool' && charged === 'key') break
          return fail(last)
        }
        if (r.status === 401 || r.status === 403) {
          if (this.jwt && isTokenProblem(r.json) && (await this.relogin(signal))) continue
          last = { kind: 'auth', status: r.status }
          if (source === 'pool' && !this.jwt) break
          return fail(last)
        }
        if (r.status === 429) return fail({ kind: 'rateLimit', status: 429, retryAfterSeconds: retryAfterSeconds(r.headers) })
        last = { kind: r.status >= 500 ? 'unavailable' : 'malformed', status: r.status }
        if (source === 'pool' && r.status === 503) break
        return fail(last)
      }
    }
    return fail(last)
  }

  /** The link carries no credential. Every hop is settled public HTTPS before it is contacted; the body is bounded. */
  private async fetchLink(link: string, signal: AbortSignal): Promise<{ ok: true; bytes: Buffer } | { ok: false; failure: OsFailure }> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const both = AbortSignal.any([signal, timeout])
    try {
      const got = await getCheckedRedirects(this.o.transport, this.o.lookup ?? systemLookup, link, { 'User-Agent': this.o.userAgent }, both)
      if (!got.ok) return { ok: false, failure: { kind: 'redirect', status: got.status } }
      const res = got.res
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined)
        return { ok: false, failure: { kind: res.status === 429 ? 'rateLimit' : 'unavailable', status: res.status } }
      }
      const read = await readBoundedBody(res)
      if (!read.ok) return { ok: false, failure: { kind: 'body', status: 200, bodyReason: 'body' } }
      return { ok: true, bytes: read.bytes }
    } catch {
      if (signal.aborted) return { ok: false, failure: { kind: 'cancelled', status: null } }
      if (timeout.aborted) return { ok: false, failure: { kind: 'timeout', status: null } }
      return { ok: false, failure: { kind: 'transport', status: null } }
    }
  }
}

/** One sentence for a failure, naming no key, account, token or link. */
export function osFailureMessage(f: OsFailure): string {
  switch (f.kind) {
    case 'cancelled':
      return 'Stopped.'
    case 'timeout':
      return 'OpenSubtitles did not answer in time.'
    case 'transport':
      return 'OpenSubtitles could not be reached. Check the internet connection.'
    case 'redirect':
      return 'OpenSubtitles sent the download somewhere the app will not follow.'
    case 'unavailable':
      return f.status ? `OpenSubtitles is unavailable right now (HTTP ${f.status}).` : 'OpenSubtitles is unavailable right now.'
    case 'rateLimit':
      return 'OpenSubtitles asked the app to slow down. Try again in a moment.'
    case 'auth':
      return 'OpenSubtitles did not accept the credentials.'
    case 'quota':
      return 'The OpenSubtitles daily download allowance is used up.'
    case 'notAccepted':
      return 'OpenSubtitles would not serve this file.'
    case 'malformed':
      return 'OpenSubtitles sent an answer the app could not read.'
    case 'body':
      return f.bodyReason === 'html' || f.bodyReason === 'json'
        ? 'OpenSubtitles sent a page instead of a subtitle.'
        : 'The downloaded file is not a subtitle the app can safely open.'
  }
}
