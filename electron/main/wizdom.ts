/**
 * Wizdom (wizdom.xyz, Hebrew only, no credentials): search by IMDb id and fetch one archive into the helper
 * picker (feature_decisions.md §3.1, §3.1a, §3.1b; implementation_plan.md §9.9).
 * AUTHORED-BY: opus-5.5-high
 *
 * Picker only. The site carries unmarked AI / machine-translated Hebrew, so a Wizdom file is never a gender
 * reference: it takes no part in the automatic walk, is never gender-eligible, and spends nothing from the
 * OpenSubtitles download cap. The setting that allows it is off by default.
 *
 * Endpoints as the Kodi add-on calls them (0.2.533 `subs_engine/sources/wizdom.py:26-28,47-58,113`) and as probed
 * live (§3.1a): search returns a flat array of `{id, versioname, score}` — `score` was 0 on every entry, so it is
 * never a rank — and a file is a ZIP that may hold several subtitles. The archive is read by subtitleArchive.ts
 * and a member is chosen by alignment against the source, never by name or score (§3.1a multi-entry rule).
 */
import { alignSubtitles, oracleGatePasses } from '../engine/align'
import type { Cue } from '../engine/srt'
import { readBoundedBody, readCandidate, readSubtitleBody, type ArchiveMember, type ArchiveRefusal } from './subtitleArchive'
import { getCheckedRedirects, publicHttpsUrl, systemLookup, type HostLookup, type OsHttpResponse, type OsTransport } from './opensubtitles'

export const WIZDOM_ORIGIN = 'https://wizdom.xyz'
const API_BODY_LIMIT = 1024 * 1024
const TIMEOUT_MS = 30_000

export interface WizdomEntry {
  readonly id: string
  readonly versionName: string
}

export type WizdomFailureKind = 'cancelled' | 'timeout' | 'transport' | 'redirect' | 'unavailable' | 'malformed' | 'body'
export interface WizdomFailure {
  readonly kind: WizdomFailureKind
  readonly status: number | null
  readonly bodyReason?: ArchiveRefusal
}

export type WizdomSearch = { readonly ok: true; readonly entries: readonly WizdomEntry[] } | { readonly ok: false; readonly failure: WizdomFailure }
export type WizdomFetch = { readonly ok: true; readonly members: readonly ArchiveMember[] } | { readonly ok: false; readonly failure: WizdomFailure }

/** The search URL: `imdb`, and for an episode two-digit `season` and `episode` (the add-on's `zfill(2)`). */
export function wizdomSearchUrl(imdbId: string, season?: number, episode?: number): string | null {
  const id = imdbId.trim().toLowerCase()
  if (!/^tt\d{1,10}$/.test(id)) return null
  const tv = Number.isInteger(season) && Number.isInteger(episode) && season! >= 0 && episode! >= 0
  return `${WIZDOM_ORIGIN}/api/search?action=by_id&imdb=${id}${tv ? `&season=${String(season).padStart(2, '0')}&episode=${String(episode).padStart(2, '0')}` : ''}`
}

/** The array's entries that carry an id, in the site's order. Null when the body is not an array. */
export function parseWizdomSearch(json: unknown): WizdomEntry[] | null {
  if (!Array.isArray(json)) return null
  const out: WizdomEntry[] = []
  for (const e of json) {
    if (!e || typeof e !== 'object') continue
    const id = (e as { id?: unknown }).id
    const idText = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : typeof id === 'string' && /^\d{1,12}$/.test(id) ? id : null
    if (!idText) continue
    const v = (e as { versioname?: unknown }).versioname
    out.push({ id: idText, versionName: typeof v === 'string' ? v.slice(0, 260) : '' })
  }
  return out
}

/**
 * One GET and its body, read under `limit`. The search refuses any redirect; the file host may redirect, and
 * every hop is settled public HTTPS — its DNS answer included — before it is contacted (`getCheckedRedirects`).
 * A stream that fails after the headers (Stop, timeout, a dropped connection) is a typed failure like any other.
 */
async function get(
  transport: OsTransport,
  url: string,
  userAgent: string,
  signal: AbortSignal,
  follow: boolean,
  lookup: HostLookup,
  limit?: number
): Promise<{ ok: true; bytes: Buffer } | { ok: false; failure: WizdomFailure }> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const both = AbortSignal.any([signal, timeout])
  try {
    let res: OsHttpResponse
    if (follow) {
      const got = await getCheckedRedirects(transport, lookup, url, { 'User-Agent': userAgent }, both)
      if (!got.ok) return { ok: false, failure: { kind: 'redirect', status: got.status } }
      res = got.res
    } else {
      res = await transport({ url, method: 'GET', headers: { 'User-Agent': userAgent }, redirect: 'error', signal: both })
      if (!publicHttpsUrl(res.url)) {
        await res.body?.cancel().catch(() => undefined)
        return { ok: false, failure: { kind: 'redirect', status: res.status } }
      }
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined)
      return { ok: false, failure: { kind: 'unavailable', status: res.status } }
    }
    const body = await readBoundedBody(res, limit)
    if (!body.ok) return { ok: false, failure: { kind: 'body', status: 200, bodyReason: 'body' } }
    return { ok: true, bytes: body.bytes }
  } catch (err) {
    if (signal.aborted) return { ok: false, failure: { kind: 'cancelled', status: null } }
    if (timeout.aborted) return { ok: false, failure: { kind: 'timeout', status: null } }
    return { ok: false, failure: { kind: /redirect/i.test(String((err as Error)?.message ?? err)) ? 'redirect' : 'transport', status: null } }
  }
}

export async function searchWizdom(
  transport: OsTransport,
  userAgent: string,
  imdbId: string,
  signal: AbortSignal,
  season?: number,
  episode?: number,
  lookup: HostLookup = systemLookup
): Promise<WizdomSearch> {
  const url = wizdomSearchUrl(imdbId, season, episode)
  if (!url) return { ok: false, failure: { kind: 'malformed', status: null } }
  const r = await get(transport, url, userAgent, signal, false, lookup, API_BODY_LIMIT)
  if (!r.ok) return r
  let json: unknown
  try {
    json = JSON.parse(r.bytes.toString('utf8'))
  } catch {
    return { ok: false, failure: { kind: 'malformed', status: 200 } }
  }
  const entries = parseWizdomSearch(json)
  return entries ? { ok: true, entries } : { ok: false, failure: { kind: 'malformed', status: 200 } }
}

/** One archive, read inside the §14.8 envelope. The file host may redirect; each hop is settled before it is contacted. */
export async function fetchWizdom(transport: OsTransport, userAgent: string, id: string, signal: AbortSignal, lookup: HostLookup = systemLookup): Promise<WizdomFetch> {
  if (!/^\d{1,12}$/.test(id)) return { ok: false, failure: { kind: 'malformed', status: null } }
  const r = await get(transport, `${WIZDOM_ORIGIN}/api/files/sub/${id}`, userAgent, signal, true, lookup)
  if (!r.ok) return r
  const read = readSubtitleBody(r.bytes, `wizdom-${id}.srt`)
  if (!read.ok) return { ok: false, failure: { kind: 'body', status: 200, bodyReason: read.reason } }
  return { ok: true, members: read.members }
}

export interface MemberChoice {
  /** Archive order of the members that parsed as SRT, the chosen one first when there is one. */
  readonly order: readonly ArchiveMember[]
  readonly chosen: ArchiveMember | null
  readonly by: 'only' | 'alignment' | 'none'
}

/**
 * §3.1a: keep members that parse as SRT; align each against the source with the oracle profile; among those
 * that pass the confidence gate the highest overlap wins, then the highest vote, then archive order. None
 * passing — or no source to align against with several members — chooses nothing, and the user picks.
 */
export function chooseMember(members: readonly ArchiveMember[], source: readonly Cue[] | null): MemberChoice {
  const parsed = members.map((m) => ({ m, c: readCandidate(m, 'he') })).filter((x) => x.c.ok) as { m: ArchiveMember; c: { ok: true; cues: readonly Cue[] } }[]
  if (parsed.length === 1) return { order: [parsed[0].m], chosen: parsed[0].m, by: 'only' }
  if (!parsed.length || !source?.length) return { order: parsed.map((x) => x.m), chosen: null, by: 'none' }
  let best: { i: number; overlap: number; vote: number } | null = null
  parsed.forEach((x, i) => {
    const a = alignSubtitles('oracle', source, x.c.cues)
    if (!a.evidence || !oracleGatePasses(a.evidence.scale, a.evidence.vote, a.evidence.overlap)) return
    const { overlap, vote } = a.evidence
    if (!best || overlap > best.overlap || (overlap === best.overlap && vote > best.vote)) best = { i, overlap, vote }
  })
  if (!best) return { order: parsed.map((x) => x.m), chosen: null, by: 'none' }
  const chosen = parsed[(best as { i: number }).i].m
  return { order: [chosen, ...parsed.map((x) => x.m).filter((m) => m !== chosen)], chosen, by: 'alignment' }
}

export function wizdomFailureMessage(f: WizdomFailure): string {
  switch (f.kind) {
    case 'cancelled':
      return 'Stopped.'
    case 'timeout':
      return 'Wizdom did not answer in time.'
    case 'transport':
      return 'Wizdom could not be reached. Check the internet connection.'
    case 'redirect':
      return 'Wizdom sent the request somewhere the app will not follow.'
    case 'unavailable':
      return f.status ? `Wizdom is unavailable right now (HTTP ${f.status}).` : 'Wizdom is unavailable right now.'
    case 'malformed':
      return 'Wizdom sent an answer the app could not read.'
    case 'body':
      return f.bodyReason === 'html' || f.bodyReason === 'json' ? 'Wizdom sent a page instead of a subtitle.' : 'The downloaded file is not a subtitle archive the app can safely open.'
  }
}
