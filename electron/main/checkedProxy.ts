/**
 * The subtitle-download connection's own address check (R19-06). File requests run in dedicated Electron
 * sessions where this loopback server takes the place of every direct route (`downloadProxyRules`); a real proxy
 * in the system's answer stays a proxy. Through this server, Chromium sends `CONNECT host:port` and keeps TLS end to end
 * (the operating system's certificates, the URL's host name verified), while this server resolves the name once,
 * refuses unless every address is public, and opens the TCP connection to an address from that same answer.
 * The address checked is the address connected to — there is no second lookup for a changed answer to win.
 * Nothing but CONNECT is served. No Electron import: gates drive it over loopback.
 * AUTHORED-BY: opus-5.5-high
 */
import http from 'http'
import net from 'net'
import type { Duplex } from 'stream'
import { publicAddress, systemLookup, type HostLookup } from './opensubtitles'

/** Opens the TCP connection to one checked address. The socket reports `connect` or `error`. */
export type Connector = (address: string, port: number) => net.Socket

export interface CheckedProxy {
  readonly port: number
  close(): Promise<void>
}

/** A connection attempt that has not connected by then is abandoned and the next address is tried. */
const CONNECT_TIMEOUT_MS = 15_000

/** `host:port` or `[v6]:port` from a CONNECT line; null for anything else. */
export function connectTarget(raw: string): { host: string; port: number } | null {
  const m = /^(?:\[([0-9a-f:.]+)\]|([^\s:[\]/@]+)):(\d{1,5})$/i.exec(raw)
  if (!m) return null
  const port = Number(m[3])
  if (port < 1 || port > 65535) return null
  return { host: (m[1] ?? m[2]).toLowerCase(), port }
}

/** The name's addresses from one lookup, or null when it fails, answers nothing, or any address is not public. */
export async function checkedAddresses(host: string, lookup: HostLookup): Promise<readonly string[] | null> {
  let addresses: readonly string[]
  if (net.isIP(host)) addresses = [host]
  else {
    try {
      addresses = await lookup(host)
    } catch {
      return null
    }
  }
  return addresses.length > 0 && addresses.every(publicAddress) ? addresses : null
}

/** A system proxy answer (`session.resolveProxy`) that sends the URL straight out and nowhere else. */
export function systemRouteIsDirect(answer: string): boolean {
  return /^\s*DIRECT\s*;?\s*$/i.test(answer)
}

const PAC_SCHEMES: Record<string, string> = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5' }

/**
 * A system proxy answer — PAC syntax, an ordered list of routes Chromium may fall back along — as the download
 * session's `fixed_servers` rules: the same proxies in the same order, and every `DIRECT`, a fallback included,
 * replaced by the checked proxy (`relay`, `host:port`). No connection the list allows is ever direct and unchecked.
 * Null for an empty answer or any entry this cannot map (the download is then not made).
 */
export function downloadProxyRules(answer: string, relay: string): string | null {
  const routes: string[] = []
  for (const entry of answer.split(';').map((e) => e.trim()).filter(Boolean)) {
    const m = /^(DIRECT)$|^([A-Z0-9]+)\s+(\[[0-9a-f:.]+\]:\d{1,5}|[a-z0-9.-]+:\d{1,5})$/i.exec(entry)
    if (!m) return null
    const route = m[1] ? relay : PAC_SCHEMES[m[2].toUpperCase()] ? `${PAC_SCHEMES[m[2].toUpperCase()]}://${m[3]}` : null
    if (route === null) return null
    if (!routes.includes(route)) routes.push(route)
  }
  return routes.length > 0 ? routes.join(',') : null
}

/** One request's hold on a download session; `release` once the request is finished (repeat calls do nothing). */
export interface RouteLease<S> {
  readonly session: S
  release(): void
}

/**
 * At most `max` download sessions, each serving one route list at a time (R19-17). Requests on the same list
 * share its session. A new list takes a new session while under `max`, else the idle one released longest ago,
 * re-routed by `route` before anyone uses it; while every session has a request in flight, it waits for one to
 * go idle (its signal ends the wait). A session is only re-routed with nothing in flight, so no request is moved
 * to another list. A failed `route` leaves the session idle and listed under no route.
 */
export function createRoutePool<S>(o: { max: number; open: (index: number) => S; route: (session: S, rules: string) => Promise<void> }): {
  lease(rules: string, signal: AbortSignal): Promise<RouteLease<S>>
} {
  type Slot = { session: S; rules: string | null; users: number; ready: Promise<void>; idleSince: number }
  const slots: Slot[] = []
  const waiting = new Set<() => void>()
  let clock = 0

  const assign = (slot: Slot, rules: string): void => {
    slot.rules = rules
    slot.ready = slot.ready.catch(() => undefined).then(() => o.route(slot.session, rules))
    slot.ready.catch(() => {
      if (slot.rules === rules) slot.rules = null
    })
  }
  const take = (rules: string): Slot | null => {
    const same = slots.find((s) => s.rules === rules)
    if (same) return same
    if (slots.length < o.max) {
      const slot: Slot = { session: o.open(slots.length), rules: null, users: 0, ready: Promise.resolve(), idleSince: 0 }
      slots.push(slot)
      assign(slot, rules)
      return slot
    }
    let idle: Slot | null = null
    for (const s of slots) if (s.users === 0 && (!idle || s.idleSince < idle.idleSince)) idle = s
    if (idle) assign(idle, rules)
    return idle
  }

  return {
    async lease(rules, signal) {
      for (;;) {
        if (signal.aborted) throw new Error('aborted')
        const slot = take(rules)
        if (slot) {
          slot.users += 1
          let held = true
          const release = (): void => {
            if (!held) return
            held = false
            slot.users -= 1
            if (slot.users > 0) return
            slot.idleSince = ++clock
            for (const wake of [...waiting]) wake()
          }
          try {
            await slot.ready
          } catch (err) {
            release()
            throw err
          }
          return { session: slot.session, release }
        }
        await new Promise<void>((resolve, reject) => {
          const wake = (): void => {
            waiting.delete(wake)
            signal.removeEventListener('abort', stop)
            resolve()
          }
          const stop = (): void => {
            waiting.delete(wake)
            reject(new Error('aborted'))
          }
          waiting.add(wake)
          signal.addEventListener('abort', stop, { once: true })
        })
      }
    }
  }
}

const REASONS: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 502: 'Bad Gateway' }

function refuse(client: Duplex, code: number): void {
  client.end(`HTTP/1.1 ${code} ${REASONS[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * Joins an accepted tunnel both ways. A normal end of the upstream ends the client through the pipe, after the
 * bytes queued for it are written: the upstream closing does not mean the client has received them. Only a
 * failure tears both down at once; the client going away closes the upstream.
 */
export function joinTunnel(client: Duplex, upstream: Duplex, head: Buffer, open: Set<Duplex>): void {
  open.add(upstream)
  upstream.on('close', () => open.delete(upstream))
  upstream.on('error', () => {
    upstream.destroy()
    client.destroy()
  })
  client.on('close', () => upstream.destroy())
  if (head.length) upstream.write(head)
  upstream.pipe(client)
  client.pipe(upstream)
}

export function startCheckedProxy(o: { lookup?: HostLookup; connect?: Connector } = {}): Promise<CheckedProxy> {
  const lookup = o.lookup ?? systemLookup
  const connect: Connector = o.connect ?? ((address, port) => net.connect({ host: address, port }))
  const open = new Set<Duplex>()

  function attempt(address: string, port: number): Promise<net.Socket | null> {
    return new Promise((resolve) => {
      const s = connect(address, port)
      const done = (ok: boolean): void => {
        s.off('connect', onConnect)
        s.off('error', onError)
        s.setTimeout(0)
        if (!ok) s.destroy()
        resolve(ok ? s : null)
      }
      const onConnect = (): void => done(true)
      const onError = (): void => done(false)
      s.once('connect', onConnect)
      s.once('error', onError)
      s.setTimeout(CONNECT_TIMEOUT_MS, () => done(false))
    })
  }

  async function tunnel(target: string, client: Duplex, head: Buffer): Promise<void> {
    open.add(client)
    client.on('close', () => open.delete(client))
    client.on('error', () => client.destroy())
    const t = connectTarget(target)
    if (!t) return refuse(client, 400)
    const addresses = await checkedAddresses(t.host, lookup)
    if (!addresses) return refuse(client, 403)
    for (const address of addresses) {
      if (client.destroyed) return
      const upstream = await attempt(address, t.port)
      if (!upstream) continue
      if (client.destroyed) {
        upstream.destroy()
        return
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      joinTunnel(client, upstream, head, open)
      return
    }
    refuse(client, 502)
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(405, { Connection: 'close', 'Content-Length': '0' }).end()
  })
  server.on('connect', (req: http.IncomingMessage, client: Duplex, head: Buffer) => void tunnel(req.url ?? '', client, head))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      server.unref()
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of open) s.destroy()
            server.close(() => done())
          })
      })
    })
  })
}
