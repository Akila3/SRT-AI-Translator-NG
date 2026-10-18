/**
 * The app's subtitle-source session: the shared OpenSubtitles key pool, one client per set of credentials,
 * Wizdom's picker fetch, and the IPC result shapes (Bundle H). The protocols are `opensubtitles.ts` and
 * `wizdom.ts`; nothing here speaks HTTP. A source turned off in Settings refuses here.
 * AUTHORED-BY: opus-5.5-high
 *
 * Downloaded subtitles are written to the app's scratch folder under generated names, one file per subtitle
 * the download held, and only after each has decoded and parsed as SRT — the picker then reads that file
 * exactly as it reads one the user chose from disk.
 */
import fs from 'fs'
import { Readable } from 'stream'
import { app, net, session as electronSession, type Session } from 'electron'
import { createRoutePool, downloadProxyRules, startCheckedProxy, systemRouteIsDirect, type CheckedProxy } from './checkedProxy'
import type { AppSettings, OsCheckResult, OsSearchResult, SubtitleFetchResult, WizdomSearchResult } from '../shared/types'
import { parseCues, type Cue } from '../engine/srt'
import { decodeSubtitleBuffer, inspectSubtitleFile } from '../engine/subtitleInput'
import { chooseMember, fetchWizdom, searchWizdom, wizdomFailureMessage } from './wizdom'
import { KeyPool, POOL_LIST_MAX_BYTES, POOL_URL } from './osKeyPool'
import {
  OpenSubtitlesClient,
  fetchTransport,
  osFailureMessage,
  osUserAgent,
  ResolvedByProxy,
  type HostLookup,
  type KeyCheck,
  type LoginCheck,
  type OsHttpResponse,
  type OsSearchQuery,
  type OsTransport
} from './opensubtitles'
import { candidateLanguage, readBoundedBody, readCandidate, type ArchiveMember } from './subtitleArchive'
import { tempOutputPath } from './tempFiles'

/** The loopback address check that stands in for every direct route of a file request (`checkedProxy.ts`). */
let relay: Promise<CheckedProxy> | null = null
function relayGate(): Promise<CheckedProxy> {
  relay ??= startCheckedProxy().catch((err) => {
    relay = null
    throw err
  })
  return relay
}

/**
 * The in-memory download sessions, one route list (`downloadProxyRules`) each at a time (`createRoutePool`): its
 * proxies are the system's, in order, and its direct route is the address check. `<-loopback>` removes Chromium's
 * implicit loopback bypass: no destination skips the list. Re-routing an idle session closes its pooled
 * connections, which would otherwise keep the previous route. Certificates are the system's, as in every session.
 * An in-memory session cannot be freed, so their number is bounded; past it, a new list waits for an idle one.
 */
const MAX_ROUTE_SESSIONS = 16
const routePool = createRoutePool<Session>({
  max: MAX_ROUTE_SESSIONS,
  open: (index) => electronSession.fromPartition(`subtitle-downloads-${index}`),
  route: async (ses, rules) => {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: rules, proxyBypassRules: '<-loopback>' })
    await ses.closeAllConnections()
  }
})

/** Whether the system's proxy settings (PAC, WPAD or manual) send this URL straight out and nowhere else. */
const routesDirect = async (url: string): Promise<boolean> => systemRouteIsDirect(await electronSession.defaultSession.resolveProxy(url))

/**
 * One file request that hands a redirect back unfollowed: `net.request` reports the 3xx and its target before
 * the target is contacted, and the request is abandoned there. The system's whole route list for the URL is kept:
 * each proxy stays a proxy (tester decision, 2026-10-17: the proxy picks the address, after `sessionLookup`'s own
 * answer, where this machine has one, passed the public check), and every direct route — a fallback after a proxy
 * included — is the address check, bound to the address it checked. The certificate is checked against the name
 * on every route. An answer that cannot be mapped is not sent.
 */
const manualRequest: OsTransport = async (r) => {
  if (r.signal.aborted) throw new Error('aborted')
  const rules = downloadProxyRules(await electronSession.defaultSession.resolveProxy(r.url), `127.0.0.1:${(await relayGate()).port}`)
  if (rules === null) throw new Error('unsupported proxy route')
  const lease = await routePool.lease(rules, r.signal)
  try {
    return await requestIn(lease.session, r, lease.release)
  } catch (err) {
    lease.release()
    throw err
  }
}

/** `done` runs once the request holds the session no longer: redirect, failure, Stop, or its body closed. */
const requestIn = (ses: Session, r: Parameters<OsTransport>[0], done: () => void): Promise<OsHttpResponse> =>
  new Promise<OsHttpResponse>((resolve, reject) => {
    if (r.signal.aborted) return reject(new Error('aborted'))
    const req = net.request({ url: r.url, method: r.method, redirect: 'manual', session: ses })
    for (const [k, v] of Object.entries(r.headers)) req.setHeader(k, v)
    let settled = false
    let stream: Readable | null = null
    const onAbort = (): void => {
      req.abort()
      stream?.destroy(new Error('aborted'))
      if (!settled) {
        settled = true
        reject(new Error('aborted'))
      }
      release()
    }
    r.signal.addEventListener('abort', onAbort, { once: true })
    const release = (): void => {
      r.signal.removeEventListener('abort', onAbort)
      done()
    }
    req.on('redirect', (status, _method, redirectUrl) => {
      if (settled) return
      settled = true
      release()
      req.abort()
      resolve({ status, url: r.url, headers: { get: (n) => (n.toLowerCase() === 'location' ? redirectUrl : null) }, body: null })
    })
    req.on('response', (res) => {
      if (settled) return
      settled = true
      stream = res as unknown as Readable
      stream.once('close', release)
      stream.once('end', release)
      stream.once('error', release)
      const headers = res.headers
      resolve({
        status: res.statusCode,
        url: r.url,
        headers: {
          get: (n) => {
            const v = headers[n.toLowerCase()]
            return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v
          }
        },
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>
      })
    })
    req.on('error', (err) => {
      release()
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    if (r.body !== undefined) req.write(r.body)
    req.end()
  })

/**
 * The redirect guard's DNS check, before a hop is requested. On every direct route, a fallback included, the binding
 * check is the address check's own lookup at connection time (`checkedProxy.ts`). A name this machine cannot resolve
 * is refused on a direct-only route; on one with a proxy it is `ResolvedByProxy`, since proxy-only networks resolve
 * names at the proxy (a direct fallback then meets the address check, which refuses it). The route is asked for
 * the host's root URL: the lookup sees only the name.
 */
const sessionLookup: HostLookup = async (hostname) => {
  try {
    const addresses = (await net.resolveHost(hostname)).endpoints.map((e) => e.address)
    if (addresses.length > 0) return addresses
  } catch {
    // settled by the route below
  }
  if (!(await routesDirect(`https://${hostname}/`))) throw new ResolvedByProxy()
  return []
}

let transport: OsTransport | null = null
function osTransport(): OsTransport {
  transport ??= fetchTransport((url, init) => net.fetch(url, init), manualRequest)
  return transport
}

let pool: KeyPool | null = null
function keyPool(): KeyPool {
  pool ??= new KeyPool({
    fetchList: async () => {
      const res = await osTransport()({
        url: POOL_URL,
        method: 'GET',
        headers: { 'User-Agent': osUserAgent(app.getVersion()), Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      })
      if (res.status !== 200) throw new Error(`pool list HTTP ${res.status}`)
      const body = await readBoundedBody(res, POOL_LIST_MAX_BYTES)
      if (!body.ok) throw new Error('pool list too large')
      return JSON.parse(body.bytes.toString('utf8'))
    }
  })
  return pool
}

let session: { fingerprint: string; client: OpenSubtitlesClient } | null = null

/** One client per set of credentials: its login (if any) is reused until the credentials change. */
export function openSubtitlesClient(s: Pick<AppSettings, 'openSubtitlesApiKey' | 'openSubtitlesUsername' | 'openSubtitlesPassword'>): OpenSubtitlesClient {
  const fingerprint = JSON.stringify([s.openSubtitlesApiKey.trim(), s.openSubtitlesUsername.trim(), s.openSubtitlesPassword])
  if (session?.fingerprint === fingerprint) return session.client
  session = {
    fingerprint,
    client: new OpenSubtitlesClient({
      transport: osTransport(),
      userAgent: osUserAgent(app.getVersion()),
      credentials: { apiKey: s.openSubtitlesApiKey, username: s.openSubtitlesUsername, password: s.openSubtitlesPassword },
      pool: keyPool(),
      lookup: sessionLookup
    })
  }
  return session.client
}

/** Every OpenSubtitles secret the app holds right now — entered credentials, the session token and pool keys. */
export function openSubtitlesSecrets(s: Pick<AppSettings, 'openSubtitlesApiKey' | 'openSubtitlesUsername' | 'openSubtitlesPassword'>): string[] {
  return [s.openSubtitlesApiKey, s.openSubtitlesUsername, s.openSubtitlesPassword, ...(session?.client.secrets() ?? []), ...keyPool().all()]
}

export function keyCheckView(k: KeyCheck): OsCheckResult['key'] {
  const who = k.source === 'own' ? 'Your API key' : 'The shared key pool'
  switch (k.state) {
    case 'accepted':
      return k.atDailyLimit
        ? { state: 'acceptedAtLimit', source: k.source, message: `${who} is accepted, but its daily download allowance is used up.` }
        : { state: 'accepted', source: k.source, message: k.source === 'own' ? 'Your API key is accepted.' : 'No API key entered: the shared key pool is reachable and will be used.' }
    case 'notAccepted':
      return { state: 'notAccepted', source: k.source, message: `${who} was not accepted.` }
    case 'notAcceptedOrUnavailable':
      return {
        state: 'notAcceptedOrUnavailable',
        source: k.source,
        message: `${who} was not accepted, or OpenSubtitles is unavailable right now — the service gives both the same answer. Try again later to tell them apart.`
      }
    case 'failed':
      return { state: 'failed', source: k.source, message: osFailureMessage(k.failure) }
  }
}

export function loginCheckView(l: LoginCheck): OsCheckResult['login'] {
  switch (l.state) {
    case 'notEntered':
      return { state: 'notEntered', remaining: null, message: 'No login entered: downloads use the API key’s allowance.' }
    case 'ok':
      return {
        state: 'ok',
        remaining: l.remaining,
        message:
          l.remaining === null
            ? 'Login accepted. Downloads are charged to your account.'
            : `Login accepted. Downloads are charged to your account: ${l.remaining}${l.allowed !== null ? ` of ${l.allowed}` : ''} left today.`
      }
    case 'rejected':
      return {
        state: 'rejected',
        remaining: null,
        message: 'The username or password was not accepted. It is not retried: repeated failures lock the account.'
      }
    case 'failed':
      return { state: 'failed', remaining: null, message: osFailureMessage(l.failure) }
  }
}

export async function checkOpenSubtitles(s: AppSettings, signal: AbortSignal): Promise<OsCheckResult> {
  // A Check is its own session: it logs in once and out again, whatever the cached client holds.
  const client = new OpenSubtitlesClient({
    transport: osTransport(),
    userAgent: osUserAgent(app.getVersion()),
    credentials: { apiKey: s.openSubtitlesApiKey, username: s.openSubtitlesUsername, password: s.openSubtitlesPassword },
    pool: keyPool()
  })
  const r = await client.check(signal)
  return { key: keyCheckView(r.key), login: loginCheckView(r.login) }
}

export async function searchOpenSubtitles(s: AppSettings, query: OsSearchQuery, signal: AbortSignal): Promise<OsSearchResult> {
  if (!s.subtitleSourceOpenSubtitles) return { state: 'failed', message: OS_OFF }
  const r = await openSubtitlesClient(s).search(query, signal)
  if (r.state === 'failed') return { state: 'failed', message: osFailureMessage(r.failure) }
  if (r.state === 'partial') {
    return {
      state: 'partial',
      candidates: r.candidates,
      message: r.failure ? `Only part of the results arrived: ${osFailureMessage(r.failure)}` : `Showing the first ${r.pagesRead} of ${r.totalPages} result pages.`
    }
  }
  return { state: 'complete', candidates: r.candidates, message: null }
}

export interface StageIo {
  readonly path: (suffix: string) => string
  readonly write: (file: string, bytes: Buffer) => void
  readonly remove: (file: string) => void
}

const scratchIo: StageIo = {
  path: tempOutputPath,
  write: (file, bytes) => fs.writeFileSync(file, bytes, { flag: 'wx' }),
  remove: (file) => fs.rmSync(file, { force: true })
}

type StagedFile = { path: string; name: string; cues: number; language: string | null; mislabelled: boolean }

/**
 * Stage each parsed member under a generated scratch name; members that do not parse as SRT are left out.
 * Each carries the language it is used as: the listed one, or the one detection is certain of over it (§3.3).
 * Null when the scratch folder refuses a write (full disk, permissions): the files this call already wrote are
 * removed, so a failed download leaves nothing behind.
 */
export function stageMembers(members: readonly ArchiveMember[], tag: string, language?: string, io: StageIo = scratchIo): StagedFile[] | null {
  const files: StagedFile[] = []
  let writing: string | null = null
  try {
    for (const m of members) {
      const c = readCandidate(m, language)
      if (!c.ok) continue
      const used = candidateLanguage(c, language ?? null)
      writing = io.path(`-${tag}-${m.ordinal}-${Math.random().toString(36).slice(2, 8)}.srt`)
      io.write(writing, m.bytes)
      files.push({ path: writing, name: m.originalName, cues: c.cues.length, language: used.language, mislabelled: used.mislabelled })
      writing = null
    }
    return files
  } catch {
    for (const f of [...files.map((x) => x.path), ...(writing ? [writing] : [])]) {
      try {
        io.remove(f)
      } catch {
        /* best effort: the startup sweep removes what is left */
      }
    }
    return null
  }
}

const OS_OFF = 'OpenSubtitles is turned off in Settings → Subtitle sources.'
const WIZDOM_OFF = 'Wizdom is turned off in Settings → Subtitle sources.'
export const STAGE_FAILED = 'The subtitle arrived but could not be saved to the app’s scratch folder. Check the free disk space.'

export async function downloadOpenSubtitles(s: AppSettings, fileId: number, fileName: string, language: string | undefined, signal: AbortSignal): Promise<SubtitleFetchResult> {
  if (!s.subtitleSourceOpenSubtitles) return { ok: false, message: OS_OFF, remaining: null }
  const r = await openSubtitlesClient(s).download(fileId, signal, fileName)
  if (!r.ok) return { ok: false, message: osFailureMessage(r.failure), remaining: r.remaining }
  const files = stageMembers(r.members, 'os', language)
  if (!files) return { ok: false, message: STAGE_FAILED, remaining: r.remaining }
  if (!files.length) return { ok: false, message: 'The downloaded file is not a subtitle the app can read.', remaining: r.remaining }
  return { ok: true, files, remaining: r.remaining, chosenBy: files.length === 1 ? 'only' : 'none' }
}

export async function searchWizdomView(s: AppSettings, imdbId: string, signal: AbortSignal, season?: number, episode?: number): Promise<WizdomSearchResult> {
  if (!s.subtitleSourceWizdom) return { ok: false, message: WIZDOM_OFF }
  const r = await searchWizdom(osTransport(), osUserAgent(app.getVersion()), imdbId, signal, season, episode)
  return r.ok ? { ok: true, entries: r.entries } : { ok: false, message: wizdomFailureMessage(r.failure) }
}

/** The source's cues for choosing among an archive's members; null when it is not a readable SRT. */
function sourceCues(sourcePath: string | undefined): Cue[] | null {
  if (!sourcePath || !/\.srt$/i.test(sourcePath)) return null
  try {
    const seen = inspectSubtitleFile(sourcePath)
    if (!seen.ok) return null
    const parsed = parseCues(decodeSubtitleBuffer(fs.readFileSync(seen.inspection.receipt.path), seen.inspection.receipt.encoding))
    return parsed.ok ? parsed.cues : null
  } catch {
    return null
  }
}

export async function fetchWizdomView(s: AppSettings, id: string, sourcePath: string | undefined, signal: AbortSignal): Promise<SubtitleFetchResult> {
  if (!s.subtitleSourceWizdom) return { ok: false, message: WIZDOM_OFF, remaining: null }
  const r = await fetchWizdom(osTransport(), osUserAgent(app.getVersion()), id, signal, sessionLookup)
  if (!r.ok) return { ok: false, message: wizdomFailureMessage(r.failure), remaining: null }
  const choice = chooseMember(r.members, sourceCues(sourcePath))
  const files = stageMembers(choice.order, 'wizdom', 'he')
  if (!files) return { ok: false, message: STAGE_FAILED, remaining: null }
  if (!files.length) return { ok: false, message: 'The archive holds no subtitle the app can read.', remaining: null }
  return { ok: true, files, remaining: null, chosenBy: choice.by }
}
