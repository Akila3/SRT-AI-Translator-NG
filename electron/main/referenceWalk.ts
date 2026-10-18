/**
 * Bundle H Feature 2: the automatic gender-reference walk (feature_decisions.md §3.4–§3.6). One search, then
 * OpenSubtitles candidates one at a time in quality order until one aligns with the source. Serial, never
 * round-robin; Wizdom is never part of it. The client is injected, so nothing here speaks HTTP.
 * AUTHORED-BY: opus-5.5-high
 *
 * Budget (§3.5): every download attempt counts against both `PER_LANG_LIMIT` (its language) and the run's cap.
 * The cap freezes once, from the first usable remainder: `min(remaining + downloads so far, perRunLimit)`, and
 * a later smaller remainder never shrinks it — except an observed remainder below 1, which stops the walk.
 * That remainder rule is about the user's allowance (an own key, or a login charging the account). A download
 * served by the shared pool reports one community key's remainder while the client rotates keys on quota, so
 * there the cap is the run's limit and only a quota failure (every key tried) stops the walk.
 */
import fs from 'fs'
import type { Cue } from '../engine/srt'
import { alignSubtitles, oracleGatePasses } from '../engine/align'
import type { HelperProvenance } from '../engine/genderReaders'
import type { RunReference } from '../engine/run'
import { PER_LANG_LIMIT, REF_CHAIN_WITH_DE, referenceCode, type GenderReferenceArgs } from '../shared/genderReference'
import type { OsCandidate } from '../shared/types'
import type { OsDownload, OsSearch, OsSearchQuery } from './opensubtitles'
import { candidateLanguage, readCandidate, type ArchiveMember, type CandidateRead } from './subtitleArchive'

export interface WalkClient {
  search(query: OsSearchQuery, signal: AbortSignal): Promise<OsSearch>
  download(fileId: number, signal: AbortSignal, fileNameHint?: string): Promise<OsDownload>
}

export interface WalkInput {
  readonly imdbId: string
  readonly season?: number
  readonly episode?: number
  /** Request 2b: this run's preferred language, or null. */
  readonly prefer: string | null
  readonly perRunLimit: number
  /** The source the reference must line up with. */
  readonly source: readonly Cue[]
}

export type WalkOutcome = 'aligned' | 'not_aligned' | 'mislabelled' | 'unreadable' | 'download_failed'

/** One download attempt — metadata only (H-log-1). */
export interface WalkAttempt {
  readonly language: string
  readonly provider: 'opensubtitles'
  /** 1-based among this language's attempts this run. */
  readonly ordinal: number
  readonly outcome: WalkOutcome
  /** Tried in the 2b pass. */
  readonly preferred: boolean
}

export type WalkStop =
  | 'aligned'
  | 'exhausted'
  | 'no_candidates'
  | 'run_cap'
  | 'remainder_empty'
  | 'remainder_unknown'
  | 'quota'
  | 'rate_limited'
  | 'auth'
  | 'unavailable'
  | 'search_failed'
  | 'cancelled'

export interface WalkResult {
  /**
   * The aligned reference: an OpenSubtitles file flagged human (`machineTranslated === false`), and the member
   * it came from, for the page's reference field (§3.3).
   */
  readonly reference: { readonly cues: readonly Cue[]; readonly language: string; readonly file: { readonly bytes: Buffer; readonly name: string } } | null
  readonly attempts: readonly WalkAttempt[]
  readonly stop: WalkStop
  /** Null until a usable remainder (or a pool download) froze it. */
  readonly runOsCap: number | null
  /** The service's quota or remainder is what stopped the walk. */
  readonly remainderStopped: boolean
  readonly downloads: number
  readonly prefer: string | null
}

/** §3.4 step 3: German is walked only when this run prefers it (E47). */
export function walkLanguages(prefer: string | null): string[] {
  const p = referenceCode(prefer)
  const first = p && REF_CHAIN_WITH_DE.includes(p) ? [p] : []
  return [...first, ...REF_CHAIN_WITH_DE.filter((c) => c !== p && c !== 'de')]
}

/** §3.4 step 1 / §3.6: only a file the service flags human; unknown (null) is not human. */
export function walkEligible(c: OsCandidate): boolean {
  if (c.machineTranslated !== false) return false
  return !/HebrewMachineTranslated/i.test(`${c.fileName} ${c.release}`)
}

/**
 * The best member that passes the oracle gate: highest overlap, then vote, then archive order. A member that
 * detection is certain is in another language than the one listed is not a candidate (§3.3).
 */
export function alignedMember(members: readonly ArchiveMember[], language: string, source: readonly Cue[]): { readonly cues: readonly Cue[]; readonly member: ArchiveMember } | null {
  return bestAligned(readMembers(members, language), language, source)
}

/** Each member decoded once, for both choosing the reference and naming the attempt's outcome. */
function readMembers(members: readonly ArchiveMember[], language: string): { member: ArchiveMember; read: CandidateRead }[] {
  return members.map((member) => ({ member, read: readCandidate(member, language) }))
}

function bestAligned(reads: readonly { member: ArchiveMember; read: CandidateRead }[], language: string, source: readonly Cue[]): { readonly cues: readonly Cue[]; readonly member: ArchiveMember } | null {
  let best: { cues: readonly Cue[]; member: ArchiveMember; overlap: number; vote: number } | null = null
  for (const { member: m, read: c } of reads) {
    if (!c.ok || candidateLanguage(c, language).mislabelled) continue
    const a = alignSubtitles('oracle', source, c.cues)
    if (!a.hinted || !oracleGatePasses(a.evidence.scale, a.evidence.vote, a.evidence.overlap)) continue
    const { overlap, vote } = a.evidence
    if (!best || overlap > best.overlap || (overlap === best.overlap && vote > best.vote)) best = { cues: c.cues, member: m, overlap, vote }
  }
  return best ? { cues: best.cues, member: best.member } : null
}

const STOP_FOR: Partial<Record<string, WalkStop>> = {
  quota: 'quota',
  rateLimit: 'rate_limited',
  auth: 'auth',
  cancelled: 'cancelled',
  timeout: 'unavailable',
  transport: 'unavailable',
  redirect: 'unavailable',
  unavailable: 'unavailable'
}

export async function walkForReference(client: WalkClient, input: WalkInput, signal: AbortSignal): Promise<WalkResult> {
  const prefer = referenceCode(input.prefer)
  const languages = walkLanguages(prefer)
  const attempts: WalkAttempt[] = []
  let downloads = 0
  let cap: number | null = null
  let remainderStopped = false
  const done = (stop: WalkStop, reference: WalkResult['reference'] = null): WalkResult =>
    Object.freeze({ reference, attempts: Object.freeze([...attempts]), stop, runOsCap: cap, remainderStopped, downloads, prefer })

  if (signal.aborted) return done('cancelled')
  const query: OsSearchQuery = {
    imdbId: input.imdbId,
    ...(input.season !== undefined && input.episode !== undefined ? { season: input.season, episode: input.episode } : {}),
    languages
  }
  const found = await client.search(query, signal)
  if (found.state === 'failed') return done(found.failure.kind === 'cancelled' ? 'cancelled' : 'search_failed')
  const byLanguage = new Map<string, OsCandidate[]>()
  for (const c of found.candidates) {
    const code = referenceCode(c.language)
    if (!code || !languages.includes(code) || !walkEligible(c)) continue
    byLanguage.set(code, [...(byLanguage.get(code) ?? []), c])
  }
  if (![...byLanguage.values()].some((l) => l.length)) return done('no_candidates')

  for (const language of languages) {
    const candidates = (byLanguage.get(language) ?? []).slice(0, PER_LANG_LIMIT)
    for (let i = 0; i < candidates.length; i++) {
      if (signal.aborted) return done('cancelled')
      if (downloads >= (cap ?? input.perRunLimit)) return done('run_cap')
      const c = candidates[i]
      const preferred = language === prefer
      downloads += 1
      const r = await client.download(c.fileId, signal, c.fileName)
      let stopAfter: WalkStop | null = null
      // Only a granted download names its key: one served, or granted and then unusable (the allowance is spent
      // either way). An ungranted failure's remainder may be one pool key's, so it is not read.
      const granted = r.ok ? { keySource: r.keySource, charged: r.charged } : r.allocation
      if (granted && granted.keySource === 'pool' && granted.charged === 'key') {
        cap ??= input.perRunLimit
      } else if (granted && r.remaining !== null) {
        cap ??= Math.min(r.remaining + downloads, input.perRunLimit)
        if (r.remaining < 1) {
          remainderStopped = true
          stopAfter = 'remainder_empty'
        }
      } else if (granted && cap === null) {
        // The bootstrap download said nothing about the allowance: no further spend can be justified.
        remainderStopped = true
        stopAfter = 'remainder_unknown'
      }
      if (!r.ok) {
        attempts.push({ language, provider: 'opensubtitles', ordinal: i + 1, outcome: 'download_failed', preferred })
        const stop = STOP_FOR[r.failure.kind]
        if (stop) {
          if (stop === 'quota') remainderStopped = true
          return done(stop)
        }
        if (stopAfter) return done(stopAfter)
        continue
      }
      const reads = readMembers(r.members, language)
      const best = bestAligned(reads, language, input.source)
      const readable = reads.flatMap(({ read }) => (read.ok ? [read] : []))
      const listed = readable.filter((x) => !candidateLanguage(x, language).mislabelled)
      const outcome: WalkOutcome = best ? 'aligned' : listed.length ? 'not_aligned' : readable.length ? 'mislabelled' : 'unreadable'
      attempts.push({ language, provider: 'opensubtitles', ordinal: i + 1, outcome, preferred })
      if (best) return done('aligned', Object.freeze({ cues: best.cues, language, file: Object.freeze({ bytes: best.member.bytes, name: best.member.originalName }) }))
      if (stopAfter) return done(stopAfter)
    }
  }
  return done('exhausted')
}

const STOP_TEXT: Record<WalkStop, string> = {
  aligned: 'a reference aligned',
  exhausted: 'no candidate aligned',
  no_candidates: 'no human-flagged subtitle in a reference language',
  run_cap: 'the run’s download limit was reached',
  remainder_empty: 'the OpenSubtitles allowance is used up',
  remainder_unknown: 'OpenSubtitles did not report a remaining allowance',
  quota: 'the OpenSubtitles allowance is used up',
  rate_limited: 'OpenSubtitles asked the app to slow down',
  auth: 'OpenSubtitles did not accept the credentials',
  unavailable: 'OpenSubtitles could not be reached',
  search_failed: 'the OpenSubtitles search failed',
  cancelled: 'stopped'
}

const OUTCOME_TEXT: Record<WalkOutcome, string> = {
  aligned: 'aligned',
  not_aligned: 'did not align',
  mislabelled: 'not in its listed language',
  unreadable: 'not a readable subtitle',
  download_failed: 'download failed'
}

/** Source `Cue.index` → aligned reference line, when the oracle gate passes; otherwise empty. */
export function oracleLines(source: readonly Cue[], reference: readonly Cue[]): Map<number, string> {
  const a = alignSubtitles('oracle', source, reference)
  if (!a.hinted || !oracleGatePasses(a.evidence.scale, a.evidence.vote, a.evidence.overlap)) return new Map()
  return new Map(a.hints.map((h) => [h.sourceIndex, h.referenceText]))
}

/** H19a's provenance for a file the user chose. An OpenSubtitles pick the service did not flag human is MT. */
export function fileProvenance(args: Extract<GenderReferenceArgs, { mode: 'file' }>): HelperProvenance {
  if (args.provenance === 'wizdom') return { kind: 'wizdom' }
  if (args.provenance === 'opensubtitles') return { kind: 'opensubtitles', language: args.language ?? '', machineTranslated: args.machineTranslated !== false }
  return { kind: 'disk', language: args.language, humanHebrew: args.humanHebrew }
}

/** The staged file a run's automatic walk accepted, for the page's reference field (§3.3). */
export interface AcceptedReference {
  readonly path: string
  readonly name: string
  readonly language: string | null
}

/** The run log's line when the accepted file is used but its scratch copy could not be written. */
export const REFERENCE_NOT_KEPT =
  'Gender reference: the downloaded file is used for this run, but the app could not keep a copy of it, so the reference field cannot offer “Use this file”.'

const ACCEPTED_KEPT = 8
const accepted = new Map<string, AcceptedReference>()

/** Hold a run's accepted file until its page asks for it; only the latest few runs are kept. */
export function offerAcceptedReference(runId: string, file: AcceptedReference): void {
  accepted.delete(runId)
  accepted.set(runId, Object.freeze({ ...file }))
  while (accepted.size > ACCEPTED_KEPT) accepted.delete(accepted.keys().next().value as string)
}

/** The run's accepted file; null for a run that accepted none or is no longer among the latest few. */
export function acceptedReferenceOf(runId: string): AcceptedReference | null {
  return accepted.get(runId) ?? null
}

/**
 * §3.3: stage the walk's accepted file and offer it under the run id. When the copy cannot be written, nothing
 * is offered and the run log says so; the run still uses the reference it holds in memory.
 */
export function keepAcceptedReference(runId: string, ref: RunReference, stage: (bytes: Buffer, name: string) => string | null): RunReference {
  if (!ref.accepted) return ref
  const staged = stage(ref.accepted.bytes, ref.accepted.name)
  if (staged === null) return { ...ref, log: [...ref.log, REFERENCE_NOT_KEPT] }
  offerAcceptedReference(runId, { path: staged, name: ref.accepted.name, language: ref.language })
  return ref
}

export interface ReferenceDeps {
  /** The OpenSubtitles client captured at Start; null when OpenSubtitles is off in Settings. */
  readonly client: WalkClient | null
  /** Gates: reads a chosen file. Absent in production, which reads the disk. */
  readonly readFile?: (path: string) => Buffer
}

/**
 * The run's reference (H.11): the chosen file read and aligned, or the automatic walk. A failure leaves an empty
 * map and says so in closed words; the run then translates without a reference.
 */
export async function resolveReference(args: GenderReferenceArgs, source: readonly Cue[], deps: ReferenceDeps, signal: AbortSignal): Promise<RunReference> {
  if (args.mode === 'file') {
    const helper = fileProvenance(args)
    const language = referenceCode(args.language)
    const none = (why: string): RunReference => ({ helper, language, lines: new Map(), log: [`Gender reference: ${why}.`] })
    let bytes: Buffer
    try {
      bytes = (deps.readFile ?? fs.readFileSync)(args.path)
    } catch {
      return none('the chosen file could not be read')
    }
    const read = readCandidate({ bytes, safeName: 'reference.srt', originalName: 'reference.srt', ordinal: 1 }, language ?? undefined)
    if (!read.ok) return none('the chosen file is not a readable subtitle')
    const lines = oracleLines(source, read.cues)
    return { helper, language, lines, log: lines.size ? [] : ['Gender reference: the chosen file did not line up with this subtitle.'] }
  }
  const none = (why: string): RunReference => ({ helper: { kind: 'opensubtitles', language: '', machineTranslated: true }, language: null, lines: new Map(), log: [`Gender reference: ${why}.`] })
  if (!deps.client) return none('OpenSubtitles is off in Settings, so nothing was downloaded')
  const walk = await walkForReference(
    deps.client,
    {
      imdbId: args.imdbId,
      ...(args.season !== undefined && args.episode !== undefined ? { season: args.season, episode: args.episode } : {}),
      prefer: args.prefer,
      perRunLimit: args.perRunLimit,
      source
    },
    signal
  )
  const log = walkLogLines(walk)
  if (!walk.reference) return { ...none('no reference was downloaded'), log }
  return {
    helper: { kind: 'opensubtitles', language: walk.reference.language, machineTranslated: false },
    language: walk.reference.language,
    lines: oracleLines(source, walk.reference.cues),
    log,
    accepted: walk.reference.file
  }
}

/**
 * H-log-1: the attempt log, built only from closed values and counts — language code, provider, ordinal,
 * outcome, 2b state, stop reason, frozen cap and the remainder flag. No title, file name, id or text.
 */
export function walkLogLines(r: WalkResult): string[] {
  const code = (c: string | null): string => (c && REF_CHAIN_WITH_DE.includes(c) ? c : 'none')
  const lines = r.attempts.map(
    (a) => `Gender reference: OpenSubtitles ${code(a.language)} #${a.ordinal}${a.preferred ? ' (preferred)' : ''} — ${OUTCOME_TEXT[a.outcome]}.`
  )
  lines.push(
    `Gender reference walk: ${STOP_TEXT[r.stop]}; ${r.downloads} download${r.downloads === 1 ? '' : 's'}, cap ${r.runOsCap ?? 'not frozen'}; ` +
      `preferred language ${code(r.prefer)}; stopped by the allowance: ${r.remainderStopped ? 'yes' : 'no'}.`
  )
  return lines
}
