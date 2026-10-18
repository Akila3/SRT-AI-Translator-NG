/**
 * The Align timing diagnostic, `ng-alignment-timing/v1` (Bundle M, implementation_plan.md §16.0.6).
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * The one encoder, the one bounded fail-closed decoder and the one replay. A diagnostic is text-free:
 * per cue it holds the A–I input times and one bit, whether `independent-align` counts that cue as
 * dialogue. That bit is everything A–I reads from text when its inputs are structurally sound, so replay
 * puts a placeholder in each cue (`ab` for dialogue, `♪` otherwise) and reruns the same calls. A call whose
 * inputs did not pass A–I's own preflight is recorded as `not_stored`: its verdict depended on the text and
 * the file's structure, which this file does not hold, so it is not replayed. A diagnostic is evidence for
 * a person to look at. It has no result id and can never preview, apply or write a subtitle.
 */
import { createHash } from 'crypto'
import { alignSubtitles, arbitrateTracks, audioSettles, dialogueBit, type ArbitrationTrack, type IndependentAlignment } from './align'
import type { Cue } from './srt'
import { ALIGNMENT_REASONS, ARBITRATION_REASONS, type AlignmentReferenceKind } from '../shared/alignment'
import type { AlignDiagnosticReplay, AlignTrackEvidence } from '../shared/types'

export const DIAGNOSTIC_SCHEMA = 'ng-alignment-timing/v1'
export const DIAGNOSTIC_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  tracks: 128,
  cuesPerList: 20_000,
  cuesTotal: 1_000_000,
  /** One per text track and one for the audio. */
  calls: 129
})

/** `[startMs, endMs, dialogue]`, dialogue 1 or 0. */
export type TimingRow = [number, number, 0 | 1]

export type DiagnosticCall =
  | {
      id: number
      kind: AlignmentReferenceKind
      track: number | null
      inputs: 'stored'
      reference: TimingRow[]
      verdict: 'accept' | 'check' | 'refuse'
      reason: string
      transform: { scale: number; offsetMs: number } | null
      keptIdentity: boolean
    }
  | { id: number; kind: AlignmentReferenceKind; track: number | null; inputs: 'not_stored'; verdict: 'refuse'; reason: 'malformed' }

export interface DiagnosticTrack {
  ordinal: number
  codec: string
  kind: AlignTrackEvidence['kind']
  outcome: AlignTrackEvidence['outcome']
  family: number | null
  side: number | null
  call: number | null
}

export interface DiagnosticArbitration {
  tolerance: number
  sides: { id: number; representative: number; members: number[]; witnesses: number }[]
  winner: number | null
  tieBroken: 'audio' | null
  /** The audio call that refereed a tie, when the audio ran. */
  audioCall: number | null
}

export interface DiagnosticOutcome {
  verdict: 'accept' | 'check' | 'refuse'
  reason: string
  transform: { scale: number; offsetMs: number } | null
  keptIdentity: boolean
  /** SHA-256 of the source's moved times, `[[start,end],…]`, when the outcome is usable. */
  vectorSha256: string | null
  /** The A–I call whose verdict is the outcome (stage `ai`), or the winning representative's (stage `arbitration`). */
  call: number | null
}

export interface DiagnosticV1 {
  schema: typeof DIAGNOSTIC_SCHEMA
  engine: 'independent-align'
  contract: 1
  mode: 'global'
  stage: 'ai' | 'arbitration'
  source: TimingRow[]
  calls: DiagnosticCall[]
  tracks: DiagnosticTrack[]
  arbitration: DiagnosticArbitration | null
  outcome: DiagnosticOutcome
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex')

/** The moved source times as the outcome digest hashes them. */
export function vectorSha256(cues: readonly Cue[]): string {
  return sha256Hex(JSON.stringify(cues.map((c) => [c.startMs, c.endMs])))
}

const rowsOf = (cues: readonly Cue[]): TimingRow[] => cues.map((c) => [c.startMs, c.endMs, dialogueBit(c.text) ? 1 : 0])

/** v1's timing rule: whole non-negative milliseconds, each cue ending after it starts, starts never going back. */
function timingOk(cues: readonly Cue[]): boolean {
  let prev = -1
  for (const c of cues) {
    if (!Number.isSafeInteger(c.startMs) || !Number.isSafeInteger(c.endMs) || c.startMs < 0 || c.endMs <= c.startMs || c.startMs < prev) return false
    prev = c.startMs
  }
  return cues.length > 0
}

/**
 * Did this A–I call's inputs pass its own preflight? Only then are its times and dialogue bits its whole
 * input. `malformed` is A–I's one preflight answer; its later `insufficient` also names a side
 * (`source:dialogue:N`), but is decided by the dialogue bits alone and is replayed like any verdict.
 */
function preflightPassed(r: IndependentAlignment): boolean {
  return r.reason !== 'malformed'
}

/** Collects one analysis's A–I calls as they are made, text-free. */
export class DiagnosticRecorder {
  private readonly sourceRows: TimingRow[] | null
  private readonly calls: DiagnosticCall[] = []

  constructor(source: readonly Cue[]) {
    this.sourceRows = timingOk(source) ? rowsOf(source) : null
  }

  /** Record one A–I call; returns its id. */
  call(kind: AlignmentReferenceKind, track: number | null, reference: readonly Cue[], r: IndependentAlignment): number {
    const id = this.calls.length + 1
    if (this.sourceRows && preflightPassed(r) && timingOk(reference)) {
      this.calls.push({
        id,
        kind,
        track,
        inputs: 'stored',
        reference: rowsOf(reference),
        verdict: r.verdict,
        reason: r.reason,
        transform: r.verdict === 'refuse' ? null : { scale: r.transform.scale, offsetMs: r.transform.offsetMs },
        keptIdentity: r.evidence.identity?.keptIdentity === true
      })
    } else {
      this.calls.push({ id, kind, track, inputs: 'not_stored', verdict: 'refuse', reason: 'malformed' })
    }
    return id
  }

  stored(id: number | null): boolean {
    return id !== null && this.calls[id - 1]?.inputs === 'stored'
  }

  /**
   * The diagnostic of the final outcome, or null when it is not exportable: a deciding call that was not
   * stored, an arbitration whose usable or audio call was not stored, or anything over the v1 bounds.
   */
  build(stage: 'ai' | 'arbitration', outcome: DiagnosticOutcome, tracks: DiagnosticTrack[], arbitration: DiagnosticArbitration | null): DiagnosticV1 | null {
    if (!this.sourceRows) return null
    if (stage === 'ai' && !this.stored(outcome.call)) return null
    if (stage === 'arbitration') {
      if (!arbitration) return null
      if (tracks.some((t) => t.outcome === 'usable' && !this.stored(t.call))) return null
      if (arbitration.audioCall !== null && !this.stored(arbitration.audioCall)) return null
    }
    const d: DiagnosticV1 = {
      schema: DIAGNOSTIC_SCHEMA,
      engine: 'independent-align',
      contract: 1,
      mode: 'global',
      stage,
      source: this.sourceRows,
      calls: this.calls.map((c) => ({ ...c })),
      tracks: tracks.map((t) => ({ ...t })),
      arbitration,
      outcome
    }
    return withinBounds(d) && graphProblem(d) === null && encodeDiagnostic(d).length <= DIAGNOSTIC_LIMITS.bytes ? d : null
  }
}

/**
 * What makes the record impossible, or null. The links between calls, tracks, sides and the outcome must
 * be the ones an analysis makes (`arbitrateTracks`): a usable track is a stored usable embedded call of its
 * own and a member of the side it names; sides are numbered in their representatives' order, each led by
 * its lowest member; a family's one witness sits on the side of its lowest-ordinal usable track. Replay
 * checks what the calls compute; this checks that the record does not contradict itself.
 */
function graphProblem(d: DiagnosticV1): string | null {
  const calls = d.calls
  const callOf = (id: number | null) => (id === null ? undefined : calls[id - 1])
  for (const c of calls) if ((c.kind === 'embedded') !== (c.track !== null)) return `call ${c.id} names a track only an embedded call may have`
  const byOrdinal = new Map(d.tracks.map((t) => [t.ordinal, t]))
  for (const t of d.tracks) {
    const what = `track ${t.ordinal}`
    if (t.kind !== 'text' && t.outcome !== 'listed') return `${what} is not text and cannot have been read`
    if (t.outcome === 'listed' || t.outcome === 'unread' || t.outcome === 'excluded') {
      if (t.family !== null || t.side !== null || t.call !== null) return `${what} was never compared and cannot have a family, side or call`
      continue
    }
    const c = callOf(t.call)
    if (!c || c.kind !== 'embedded' || c.track !== t.ordinal) return `${what} does not name its own embedded call`
    if (t.family === null) return `${what} was compared and has no family`
    if (t.outcome === 'refused') {
      if (t.side !== null || (c.inputs === 'stored' && c.verdict !== 'refuse')) return `${what} is refused but its call is not`
    } else if (t.side === null || c.inputs !== 'stored' || c.verdict === 'refuse') return `${what} is usable without a stored usable call and a side`
  }
  if (d.tracks.length > 0) {
    for (const c of calls) if (c.kind === 'embedded' && byOrdinal.get(c.track as number)?.call !== c.id) return `call ${c.id} belongs to no track`
  }
  const usable = d.tracks.filter((t) => t.outcome === 'usable')
  const a = d.arbitration
  if (d.stage === 'ai') {
    if (a !== null || usable.length > 0) return 'an ai-stage outcome has no arbitration'
    return null
  }
  if (!a || a.sides.length === 0) return 'an arbitration-stage outcome has no sides'
  const lowest = new Map<number, number>()
  for (const t of usable) if (!lowest.has(t.family as number)) lowest.set(t.family as number, t.side as number)
  let prevRep = 0
  let members = 0
  for (const [i, s] of a.sides.entries()) {
    const what = `side ${i + 1}`
    if (s.id !== i + 1) return `${what} is out of order`
    if (s.representative !== s.members[0] || s.representative <= prevRep) return `${what} is not led by its lowest member`
    prevRep = s.representative
    for (const [j, m] of s.members.entries()) {
      if (j > 0 && m <= s.members[j - 1]) return `${what}'s members are not in order`
      const t = byOrdinal.get(m)
      if (!t || t.outcome !== 'usable' || t.side !== s.id) return `${what} names a member that is not a usable track on it`
    }
    members += s.members.length
    if (s.witnesses !== [...lowest.values()].filter((x) => x === s.id).length) return `${what}'s witness count is not its families'`
  }
  if (members !== usable.length) return 'a usable track is on no side'
  if (a.winner !== null && a.winner > a.sides.length) return 'the winner is not a side'
  if (a.audioCall !== null && callOf(a.audioCall)?.kind !== 'audio') return 'the tie-break call is not the audio'
  if (a.tieBroken === 'audio' && (a.winner === null || a.audioCall === null)) return 'a tie settled by the audio names no winner or audio call'
  const o = d.outcome
  if (a.winner === null) {
    if (o.verdict !== 'refuse' || o.reason !== 'embedded_track_conflict' || o.call !== null) return 'an outcome with no winner is not the conflict'
  } else if (o.verdict === 'refuse' || o.call !== byOrdinal.get(a.sides[a.winner - 1].representative)?.call) {
    return "the outcome is not the winning side's representative"
  }
  return null
}

function withinBounds(d: DiagnosticV1): boolean {
  const lists = [d.source, ...d.calls.flatMap((c) => (c.inputs === 'stored' ? [c.reference] : []))]
  return (
    d.tracks.length <= DIAGNOSTIC_LIMITS.tracks &&
    d.calls.length <= DIAGNOSTIC_LIMITS.calls &&
    lists.every((l) => l.length <= DIAGNOSTIC_LIMITS.cuesPerList) &&
    lists.reduce((n, l) => n + l.length, 0) <= DIAGNOSTIC_LIMITS.cuesTotal
  )
}

// ── canonical form ───────────────────────────────────────────────────────────────────────────────

/** Every object rebuilt in the one key order, so the same diagnostic always encodes to the same bytes. */
function canonical(d: DiagnosticV1): Omit<DiagnosticV1, never> {
  return {
    schema: d.schema,
    engine: d.engine,
    contract: d.contract,
    mode: d.mode,
    stage: d.stage,
    source: d.source.map((r) => [r[0], r[1], r[2]] as TimingRow),
    calls: d.calls.map((c) =>
      c.inputs === 'stored'
        ? {
            id: c.id,
            kind: c.kind,
            track: c.track,
            inputs: c.inputs,
            reference: c.reference.map((r) => [r[0], r[1], r[2]] as TimingRow),
            verdict: c.verdict,
            reason: c.reason,
            transform: c.transform ? { scale: c.transform.scale, offsetMs: c.transform.offsetMs } : null,
            keptIdentity: c.keptIdentity
          }
        : { id: c.id, kind: c.kind, track: c.track, inputs: c.inputs, verdict: c.verdict, reason: c.reason }
    ),
    tracks: d.tracks.map((t) => ({ ordinal: t.ordinal, codec: t.codec, kind: t.kind, outcome: t.outcome, family: t.family, side: t.side, call: t.call })),
    arbitration: d.arbitration
      ? {
          tolerance: d.arbitration.tolerance,
          sides: d.arbitration.sides.map((s) => ({ id: s.id, representative: s.representative, members: [...s.members], witnesses: s.witnesses })),
          winner: d.arbitration.winner,
          tieBroken: d.arbitration.tieBroken,
          audioCall: d.arbitration.audioCall
        }
      : null,
    outcome: {
      verdict: d.outcome.verdict,
      reason: d.outcome.reason,
      transform: d.outcome.transform ? { scale: d.outcome.transform.scale, offsetMs: d.outcome.transform.offsetMs } : null,
      keptIdentity: d.outcome.keptIdentity,
      vectorSha256: d.outcome.vectorSha256,
      call: d.outcome.call
    }
  }
}

/** The digest the file carries: SHA-256 of the canonical JSON of everything else. */
export function diagnosticDigest(d: DiagnosticV1): string {
  return sha256Hex(JSON.stringify(canonical(d)))
}

/** UTF-8 JSON, canonical key order, with its digest last. */
export function encodeDiagnostic(d: DiagnosticV1): string {
  return JSON.stringify({ ...canonical(d), digest: diagnosticDigest(d) })
}

// ── decoding: exact keys, closed enums, bounded, fail-closed ─────────────────────────────────────

class Invalid extends Error {}
const fail = (what: string): never => {
  throw new Invalid(what)
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
function exactKeys(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!isObj(v)) fail(`${what} is not an object`)
  const o = v as Record<string, unknown>
  const have = Object.keys(o)
  if (have.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))) fail(`${what} has the wrong fields`)
  return o
}
const int = (v: unknown, min: number, max: number, what: string): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail(`${what} is not a whole number in range`)
const nullable = <T>(v: unknown, read: (x: unknown) => T): T | null => (v === null ? null : read(v))
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fail(`${what} is not one of the known values`)
}
const finite = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail(`${what} is not a number`))

const KINDS: readonly AlignmentReferenceKind[] = ['subtitle', 'embedded', 'audio', 'transcription']
const VERDICTS = ['accept', 'check', 'refuse'] as const
const REASONS: readonly string[] = [...ALIGNMENT_REASONS, ...ARBITRATION_REASONS]
const MAX_MS = 359_999_999

function rows(v: unknown, what: string, budget: { left: number }): TimingRow[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > DIAGNOSTIC_LIMITS.cuesPerList) fail(`${what} has no cues or too many`)
  budget.left -= (v as unknown[]).length
  if (budget.left < 0) fail('the diagnostic holds too many cues in total')
  let prev = -1
  return (v as unknown[]).map((r, i) => {
    if (!Array.isArray(r) || r.length !== 3) fail(`${what} cue ${i + 1} is not a timing`)
    const row = r as unknown[]
    const start = int(row[0], 0, MAX_MS, `${what} cue ${i + 1} start`)
    const end = int(row[1], 0, MAX_MS, `${what} cue ${i + 1} end`)
    const bit = int(row[2], 0, 1, `${what} cue ${i + 1} dialogue flag`) as 0 | 1
    if (end <= start || start < prev) fail(`${what} cue ${i + 1} breaks the timing rule`)
    prev = start
    return [start, end, bit]
  })
}

function verdictReason(verdict: 'accept' | 'check' | 'refuse', reason: string, what: string, arbitration = false): void {
  const ok =
    verdict === 'accept'
      ? reason === 'ok'
      : verdict === 'check'
        ? reason === 'partial_coverage'
        : reason !== 'ok' && reason !== 'partial_coverage' && (arbitration || (ALIGNMENT_REASONS as readonly string[]).includes(reason))
  if (!ok) fail(`${what}'s reason does not belong to its verdict`)
}

function transformOf(v: unknown, what: string): { scale: number; offsetMs: number } {
  const t = exactKeys(v, ['scale', 'offsetMs'], `${what} transform`)
  return { scale: finite(t.scale, `${what} scale`), offsetMs: finite(t.offsetMs, `${what} offset`) }
}

function decodeValue(v: unknown): DiagnosticV1 {
  const o = exactKeys(v, ['schema', 'engine', 'contract', 'mode', 'stage', 'source', 'calls', 'tracks', 'arbitration', 'outcome', 'digest'], 'the diagnostic')
  if (o.schema !== DIAGNOSTIC_SCHEMA) fail('it is not an ng-alignment-timing/v1 file')
  if (o.engine !== 'independent-align' || o.contract !== 1 || o.mode !== 'global') fail('its engine, contract or mode is not one this app writes')
  const stage = oneOf(o.stage, ['ai', 'arbitration'] as const, 'stage')
  const budget = { left: DIAGNOSTIC_LIMITS.cuesTotal }
  const source = rows(o.source, 'the source', budget)
  if (!Array.isArray(o.calls) || o.calls.length === 0 || o.calls.length > DIAGNOSTIC_LIMITS.calls) fail('it has no calls or too many')
  const calls: DiagnosticCall[] = (o.calls as unknown[]).map((raw, i) => {
    const what = `call ${i + 1}`
    const base = isObj(raw) && raw.inputs === 'not_stored'
    const c = exactKeys(raw, base ? ['id', 'kind', 'track', 'inputs', 'verdict', 'reason'] : ['id', 'kind', 'track', 'inputs', 'reference', 'verdict', 'reason', 'transform', 'keptIdentity'], what)
    if (int(c.id, 1, DIAGNOSTIC_LIMITS.calls, `${what} id`) !== i + 1) fail(`${what} is out of order`)
    const kind = oneOf(c.kind, KINDS, `${what} kind`)
    const track = nullable(c.track, (x) => int(x, 1, 1_000_000, `${what} track`))
    if (base) {
      if (c.verdict !== 'refuse' || c.reason !== 'malformed') fail(`${what} is not stored but claims a verdict`)
      return { id: i + 1, kind, track, inputs: 'not_stored', verdict: 'refuse', reason: 'malformed' }
    }
    if (c.inputs !== 'stored') fail(`${what} inputs`)
    const verdict = oneOf(c.verdict, VERDICTS, `${what} verdict`)
    const reason = oneOf(c.reason, ALIGNMENT_REASONS, `${what} reason`)
    verdictReason(verdict, reason, what)
    const transform = nullable(c.transform, (x) => transformOf(x, what))
    if ((verdict === 'refuse') !== (transform === null)) fail(`${what} transform does not match its verdict`)
    if (typeof c.keptIdentity !== 'boolean') fail(`${what} keptIdentity`)
    return { id: i + 1, kind, track, inputs: 'stored', reference: rows(c.reference, what, budget), verdict, reason, transform, keptIdentity: c.keptIdentity as boolean }
  })
  const callId = (x: unknown, what: string): number => int(x, 1, calls.length, what)
  if (!Array.isArray(o.tracks) || o.tracks.length > DIAGNOSTIC_LIMITS.tracks) fail('it has too many tracks')
  let prevOrdinal = 0
  const tracks: DiagnosticTrack[] = (o.tracks as unknown[]).map((raw, i) => {
    const what = `track ${i + 1}`
    const t = exactKeys(raw, ['ordinal', 'codec', 'kind', 'outcome', 'family', 'side', 'call'], what)
    const ordinal = int(t.ordinal, prevOrdinal + 1, 1_000_000, `${what} ordinal`)
    prevOrdinal = ordinal
    if (typeof t.codec !== 'string' || !/^[a-z0-9_]{1,32}$/.test(t.codec)) fail(`${what} codec`)
    return {
      ordinal,
      codec: t.codec as string,
      kind: oneOf(t.kind, ['text', 'image', 'not_text'] as const, `${what} kind`),
      outcome: oneOf(t.outcome, ['usable', 'refused', 'excluded', 'unread', 'listed'] as const, `${what} outcome`),
      family: nullable(t.family, (x) => int(x, 1, DIAGNOSTIC_LIMITS.tracks, `${what} family`)),
      side: nullable(t.side, (x) => int(x, 1, DIAGNOSTIC_LIMITS.tracks, `${what} side`)),
      call: nullable(t.call, (x) => callId(x, `${what} call`))
    }
  })
  const arbitration = nullable(o.arbitration, (raw) => {
    const a = exactKeys(raw, ['tolerance', 'sides', 'winner', 'tieBroken', 'audioCall'], 'arbitration')
    if (!Array.isArray(a.sides) || a.sides.length > DIAGNOSTIC_LIMITS.tracks) fail('arbitration sides')
    return {
      tolerance: int(a.tolerance, 0, 60_000, 'arbitration tolerance'),
      sides: (a.sides as unknown[]).map((rs, i) => {
        const s = exactKeys(rs, ['id', 'representative', 'members', 'witnesses'], `side ${i + 1}`)
        if (!Array.isArray(s.members) || s.members.length === 0 || s.members.length > DIAGNOSTIC_LIMITS.tracks) fail(`side ${i + 1} members`)
        return {
          id: int(s.id, 1, DIAGNOSTIC_LIMITS.tracks, `side ${i + 1} id`),
          representative: int(s.representative, 1, 1_000_000, `side ${i + 1} representative`),
          members: (s.members as unknown[]).map((m) => int(m, 1, 1_000_000, `side ${i + 1} member`)),
          witnesses: int(s.witnesses, 0, DIAGNOSTIC_LIMITS.tracks, `side ${i + 1} witnesses`)
        }
      }),
      winner: nullable(a.winner, (x) => int(x, 1, DIAGNOSTIC_LIMITS.tracks, 'arbitration winner')),
      tieBroken: nullable(a.tieBroken, (x) => oneOf(x, ['audio'] as const, 'arbitration tie-break')),
      audioCall: nullable(a.audioCall, (x) => callId(x, 'arbitration audio call'))
    }
  })
  const out = exactKeys(o.outcome, ['verdict', 'reason', 'transform', 'keptIdentity', 'vectorSha256', 'call'], 'the outcome')
  const verdict = oneOf(out.verdict, VERDICTS, 'outcome verdict')
  const reason = oneOf(out.reason, REASONS, 'outcome reason')
  verdictReason(verdict, reason, 'the outcome', true)
  const transform = nullable(out.transform, (x) => transformOf(x, 'outcome'))
  const vector = nullable(out.vectorSha256, (x) => (typeof x === 'string' && /^[0-9a-f]{64}$/.test(x) ? x : fail('outcome vector digest')))
  if ((verdict === 'refuse') !== (transform === null) || (verdict === 'refuse') !== (vector === null)) fail('the outcome transform does not match its verdict')
  if (typeof out.keptIdentity !== 'boolean') fail('outcome keptIdentity')
  const outcome: DiagnosticOutcome = { verdict, reason, transform, keptIdentity: out.keptIdentity as boolean, vectorSha256: vector, call: nullable(out.call, (x) => callId(x, 'outcome call')) }
  if (stage === 'ai' && (outcome.call === null || calls[outcome.call - 1].inputs !== 'stored')) fail('an ai-stage outcome must name a stored call')
  if (stage === 'arbitration' && arbitration === null) fail('an arbitration-stage outcome has no arbitration')
  const d: DiagnosticV1 = { schema: DIAGNOSTIC_SCHEMA, engine: 'independent-align', contract: 1, mode: 'global', stage, source, calls, tracks, arbitration, outcome }
  const problem = graphProblem(d)
  if (problem) fail(problem)
  if (o.digest !== diagnosticDigest(d)) fail('its digest does not match its contents')
  return d
}

export type DecodedDiagnostic = { ok: true; diagnostic: DiagnosticV1 } | { ok: false; code: 'too_large' | 'invalid'; message: string }

/** Size first, then JSON, then every key, enum, bound and the digest. One refusal, no partial state. */
export function decodeDiagnostic(bytes: Buffer): DecodedDiagnostic {
  if (bytes.length > DIAGNOSTIC_LIMITS.bytes) return { ok: false, code: 'too_large', message: 'The file is larger than a timing diagnostic can be (32 MiB).' }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { ok: false, code: 'invalid', message: 'The file is not a timing diagnostic: it is not UTF-8 JSON.' }
  }
  try {
    return { ok: true, diagnostic: decodeValue(value) }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, code: 'invalid', message: `The file is not a valid timing diagnostic: ${e.message}.` }
    throw e
  }
}

// ── replay ───────────────────────────────────────────────────────────────────────────────────────

const placeholderCues = (rs: readonly TimingRow[]): Cue[] => rs.map((r, i) => ({ index: i + 1, startMs: r[0], endMs: r[1], text: r[2] === 1 ? 'ab' : '\u266a' }))

/**
 * Rebuild each stored call's cues with placeholder text and rerun it; for an arbitration outcome, rerun the
 * arbitration at the stored tolerance with the stored family ids. A difference is reported, never smoothed.
 */
export function replayDiagnostic(d: DiagnosticV1): AlignDiagnosticReplay {
  const mismatches: string[] = []
  const source = placeholderCues(d.source)
  const reruns = new Map<number, IndependentAlignment>()
  for (const c of d.calls) {
    if (c.inputs !== 'stored') continue
    const r = alignSubtitles('independent-align', source, placeholderCues(c.reference), c.kind)
    reruns.set(c.id, r)
    if (r.verdict !== c.verdict) mismatches.push(`call:${c.id}:verdict`)
    if (r.reason !== c.reason) mismatches.push(`call:${c.id}:reason`)
    const t = r.verdict === 'refuse' ? null : r.transform
    if (JSON.stringify(t) !== JSON.stringify(c.transform)) mismatches.push(`call:${c.id}:transform`)
    if ((r.evidence.identity?.keptIdentity === true) !== c.keptIdentity) mismatches.push(`call:${c.id}:identity`)
  }

  let verdict: AlignDiagnosticReplay['verdict'] = 'refuse'
  let reason = 'malformed'
  let transform: AlignDiagnosticReplay['transform'] = null
  let keptIdentity = false
  let vector: string | null = null
  let winner: number | null = null
  let sides = 0
  const usableOf = (r: IndependentAlignment | undefined): r is Extract<IndependentAlignment, { verdict: 'accept' | 'check' }> => r !== undefined && r.verdict !== 'refuse'

  if (d.stage === 'ai') {
    const r = reruns.get(d.outcome.call ?? -1)
    if (r) {
      verdict = r.verdict
      reason = r.reason
      if (usableOf(r)) {
        transform = { scale: r.transform.scale, offsetMs: r.transform.offsetMs }
        keptIdentity = r.evidence.identity?.keptIdentity === true
        vector = vectorSha256(r.cues)
      }
    }
  } else if (d.arbitration) {
    const a = d.arbitration
    const usable: ArbitrationTrack[] = []
    for (const t of d.tracks) {
      const r = t.call === null ? undefined : reruns.get(t.call)
      if (usableOf(r) && t.family !== null) usable.push({ ordinal: t.ordinal, family: t.family, verdict: r.verdict, cues: r.cues })
    }
    const arb = arbitrateTracks(usable, a.tolerance)
    sides = arb.sides.length
    const recorded = a.sides.map((s) => [s.id, s.representative, s.members, s.witnesses])
    const replayed = arb.sides.map((s) => [s.id, s.representative, s.members, s.witnesses.length])
    if (JSON.stringify(recorded) !== JSON.stringify(replayed)) mismatches.push('arbitration:sides')
    const cuesOf = (ordinal: number): readonly Cue[] => usable.find((u) => u.ordinal === ordinal)?.cues ?? []
    if (arb.leaders.length === 1) winner = arb.leaders[0]
    else if (arb.leaders.length > 1 && a.audioCall !== null) {
      const audio = reruns.get(a.audioCall)
      winner = usableOf(audio) ? audioSettles(arb, cuesOf, audio.cues) : null
    }
    const tieBroken = arb.leaders.length > 1 && winner !== null ? 'audio' : null
    if (winner !== a.winner) mismatches.push('arbitration:winner')
    if (tieBroken !== a.tieBroken) mismatches.push('arbitration:tie_break')
    const side = arb.sides.find((s) => s.id === winner)
    const rep = side ? reruns.get(d.tracks.find((t) => t.ordinal === side.representative)?.call ?? -1) : undefined
    if (side && usableOf(rep)) {
      verdict = side.verdict
      reason = side.verdict === 'accept' ? 'ok' : 'partial_coverage'
      transform = { scale: rep.transform.scale, offsetMs: rep.transform.offsetMs }
      keptIdentity = rep.evidence.identity?.keptIdentity === true
      vector = vectorSha256(rep.cues)
    } else if (!side) {
      reason = 'embedded_track_conflict'
    }
  }
  if (verdict !== d.outcome.verdict) mismatches.push('outcome:verdict')
  if (reason !== d.outcome.reason) mismatches.push('outcome:reason')
  if (JSON.stringify(transform) !== JSON.stringify(d.outcome.transform)) mismatches.push('outcome:transform')
  if (keptIdentity !== d.outcome.keptIdentity) mismatches.push('outcome:identity')
  if (vector !== d.outcome.vectorSha256) mismatches.push('outcome:vector')

  return {
    stage: d.stage,
    verdict: d.outcome.verdict,
    reason: d.outcome.reason,
    transform: d.outcome.transform,
    keptIdentity: d.outcome.keptIdentity,
    matches: mismatches.length === 0,
    mismatches,
    sourceCues: d.source.length,
    calls: d.calls.length,
    tracks: d.tracks.length,
    sides: d.arbitration ? d.arbitration.sides.length : sides,
    winner: d.arbitration ? d.arbitration.winner : null,
    tieBroken: d.arbitration ? d.arbitration.tieBroken : null
  }
}
