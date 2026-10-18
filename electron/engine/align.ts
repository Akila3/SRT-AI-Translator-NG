/**
 * Global SubRip-to-SubRip timing alignment (implementation_plan.md §17.4, Bundle B).
 * AUTHORED-BY: opus-5.5-high
 *
 * Pure and offline: cues in, a result out. No file, network, clock, randomness, main-process or
 * renderer code. The estimator reads cue start/end times; text decides only which cues are
 * dialogue (feature_decisions.md §4.1, "language-agnostic").
 *
 * Every caller names its profile and there is no default (feature_decisions.md §2.3 Registry-13
 * fence). The two profiles may share parsing and estimation, never a gate threshold.
 *
 * `oracle` is Kodi's `arabic_gender.align_one` (0.2.528 `arabic_gender.py:44-242`; the code is
 * identical in 0.2.520 and 0.2.533): field-tested, constants load-bearing, ported rather than
 * re-derived. Any miss — too few cues, a failed gate, an empty map or an exception — returns no
 * map, and the caller translates unhinted exactly as if there were no reference.
 *
 * `independent-align` retimes a whole file onto a reference (feature_decisions.md §4): strict
 * preflight, Kodi's coarse proposal, unique monotonic pairs, a MAD-trimmed refit over every pair,
 * then `accept`, `check` or `refuse` with one stable reason. It never edits text, never adds,
 * drops or reorders a cue, and refuses rather than clamping a time it cannot write.
 */
/*
 * The `oracle` profile and the shared dialogue/estimation primitives are a TypeScript port of
 * `resources/lib/arabic_gender.py` from the Kodi add-on service.subtitles.kodipovilai 0.2.528,
 * modified for NG (opus-5.5-high, 2026-10-07). The add-on's licence (`LICENSE.txt`, SHA-256
 * 5F42357C…B67D5F) follows; it covers the ported portions:
 *
 * MIT License
 *
 * Copyright (c) 2026 MoranTheKing
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { CueWriteError, cueTimestamp, parseCues, serializeCues, writtenCueText, type Cue } from './srt'

/** The caller profile. Mandatory: there is no default and nothing infers one. */
export type AlignProfile = 'oracle' | 'independent-align'

/** §2.3's gate, verbatim from `arabic_gender.py:221,240`. Never read by another profile. */
export const ORACLE_PROFILE = Object.freeze({
  minDialogueCues: 8,
  voteMin: 0.65,
  overlapMin: 0.65,
  scaleMin: 0.9,
  scaleMax: 1.11
})

/**
 * E66's selected production starting values (implementation_plan.md §9.4b Bundle B items 1–6;
 * feature_decisions.md §4.1b). Searched or inherited, never tuned here. Never read by the oracle.
 */
export const INDEPENDENT_PROFILE = Object.freeze({
  minDialogueCues: 8,
  voteMin: 0.55,
  overlapMin: 0.55,
  scaleMin: 0.9,
  scaleMax: 1.11,
  pairToleranceMs: 250,
  acceptCoveragePct: 85,
  checkCoveragePct: 60,
  retainedMinPct: 65,
  madK: 3.5,
  madMaxIterations: 8,
  residualOkMs: 400,
  wrongTitleVoteMax: 0.42,
  wrongTitleOverlapMax: 0.35
})

/**
 * E66's local-window and drift values (implementation_plan.md §9.4b Bundle B item 5; ledger E66,
 * `alass_evaluation.md` §17). Ported from the private research mirror (a Python detector) with its
 * selected values: nine windows at vote 0.55 and a 1,000 ms residual step. Every step event in the
 * mirror is measured against that residual step; its `local_step_min_ms` seed is read nowhere, so it
 * has no constant here. Never read by the oracle.
 */
export const INDEPENDENT_LOCAL_PROFILE = Object.freeze({
  windows: 9,
  windowVoteMin: 0.55,
  residualStepMinMs: 1000,
  stepMinFraction: 0.15,
  stepMinWindows: 2,
  supportedCoveragePct: 80,
  unsupportedCoveragePct: 20,
  linearDriftR2Min: 0.85,
  driftWarnMs: 3000,
  /** A histogram-only step binds only when some local window votes at least this strongly (`:909`). */
  strongWindowVoteMin: 0.8
})

/**
 * Round 8A's reference-density rules (implementation_plan.md §9.4c R1–R3; tester decisions 2026-10-08).
 * Every threshold reads the exact ratio `referenceCount / sourceCues`, never the rounded display value.
 * `edgeDensityMin` stays at or above `edgeCoverageBelowPct / 100`, so a window that only lacks reference
 * lines (density ≈ coverage) can never be an edge contradiction. Never read by the oracle.
 */
export const INDEPENDENT_DENSITY_PROFILE = Object.freeze({
  /** R2: a ≤20%-covered window counts against the map only when the reference has lines there. */
  referenceDensityMin: 0.5,
  /** R3: the first or last window has the reference's lines but pairs few of them … */
  edgeDensityMin: 0.8,
  edgeCoverageBelowPct: 70,
  /** … and sits this many points below the median window. */
  edgeGapMin: 20
})

/** What the selected reference is. Mirrors `AlignmentReferenceKind` (`electron/shared/alignment.ts`); align.ts imports only `./srt`. */
export type IndependentReferenceKind = 'subtitle' | 'embedded' | 'audio' | 'transcription'

export const INDEPENDENT_REFERENCE_KINDS: readonly IndependentReferenceKind[] = Object.freeze(['subtitle', 'embedded', 'audio', 'transcription'] as const)

/** R3 runs only where Global judges a fit of its own, never where a candidate timeline is judged. */
type IndependentEntry = 'global' | 'candidate'

/** R4: the reference kind is mandatory on both independent entries; there is no default. */
function referenceKindOf(entry: string, referenceKind: unknown): IndependentReferenceKind {
  if (typeof referenceKind === 'string' && (INDEPENDENT_REFERENCE_KINDS as readonly string[]).includes(referenceKind)) return referenceKind as IndependentReferenceKind
  throw new TypeError(`${entry} needs a reference kind ('subtitle' | 'embedded' | 'audio' | 'transcription'); got ${JSON.stringify(referenceKind)}`)
}

// ── Kodi estimator primitives (`arabic_gender.py:106-112`) ─────────────────────────────────────

const FPS = [24000 / 1001, 24.0, 25.0, 30000 / 1001, 30.0]
const BUCKET_MS = 500
/** Per-cue map tolerance in `_arabic_for_blocks`, distinct from the histogram bucket. */
const TIGHT_MS = 250
/** ±10 minutes: a file further out than this cannot align at all. */
const MAXOFF_MS = 600_000
/** The histogram votes on at most this many source cues; the vote is normalised to that sample. */
const SAMPLE = 500

/** Python's `round(x)`: nearest integer, exact ties to even. */
function pyRound(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** `{1.0} ∪ {round(p/q, 6) : p, q ∈ FPS, 0.9 ≤ p/q ≤ 1.11}`, ascending. */
export const KODI_SCALES: readonly number[] = Object.freeze(
  [...new Set([1.0, ...FPS.flatMap((p) => FPS.filter((q) => p / q >= 0.9 && p / q <= 1.11).map((q) => Number((p / q).toFixed(6))))])].sort(
    (a, b) => a - b
  )
)

function bisectLeft(a: readonly number[], x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

function bisectRight(a: readonly number[], x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x < a[mid]) hi = mid
    else lo = mid + 1
  }
  return lo
}

// ── dialogue (`arabic_gender.py:49-50,59-101`) ─────────────────────────────────────────────────

const NONDIALOG = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|<[^>]+>/g
const MUSIC = ['♪', '♫', '#']
/** Kodi's letters: the scripts of its reference chain only. Kana, Han, Hangul, Thai and others are not letters here. */
const NOT_LETTER = /[^A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F]/g
/** Any Unicode letter, as E66's detector counts them (`str.isalpha`). `independent-align` aligns every script. */
const NOT_ANY_LETTER = /\P{L}/gu

/**
 * Whether `independent-align` counts this cue as dialogue: exactly what its `dialogueOf` decides. A timing
 * diagnostic stores this one bit per cue instead of the text (Bundle M §16.0.6).
 */
export function dialogueBit(text: string): boolean {
  return isDialogue(cleanedBody(text), NOT_ANY_LETTER)
}

/** `_is_dialogue`: no music mark, and at least two letters once bracketed/tagged text is removed. */
function isDialogue(text: string, notLetter: RegExp): boolean {
  if (MUSIC.some((mark) => text.includes(mark))) return false
  return text.replace(NONDIALOG, ' ').replace(notLetter, '').length >= 2
}

/** A cue's non-blank lines joined by spaces — the block body `_parse` and `_arabic_for_blocks` read. */
function joinedBody(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== '')
    .join(' ')
}

/** `_parse`'s cleaned body: bracketed/tagged text removed, whitespace runs collapsed. */
function cleanedBody(text: string): string {
  return joinedBody(text).replace(NONDIALOG, ' ').replace(/\s{2,}/g, ' ').trim()
}

interface Timed {
  start: number
  end: number
  text: string
  index: number
}

/** `_parse` + `_is_dialogue`: dialogue cues by start (stable), a reversed end clamped to its start. */
function dialogueOf(cues: readonly Cue[], notLetter: RegExp): Timed[] {
  return cues
    .map((c) => ({ start: c.startMs, end: Math.max(c.startMs, c.endMs), text: cleanedBody(c.text), index: c.index }))
    .sort((a, b) => a.start - b.start)
    .filter((c) => isDialogue(c.text, notLetter))
}

// ── estimation (`_best_offset`, `_estimate_map`, `_overlap_rate`) ──────────────────────────────

function bestOffset(srcOn: readonly number[], refOn: readonly number[], scale: number): [number, number] {
  const step = Math.max(1, Math.floor(srcOn.length / SAMPLE))
  const hist = new Map<number, number>()
  for (let i = 0; i < srcOn.length; i += step) {
    const pe = scale * srcOn[i]
    const lo = bisectLeft(refOn, pe - MAXOFF_MS)
    const hi = bisectRight(refOn, pe + MAXOFF_MS)
    for (let j = lo; j < hi; j += 1) {
      const b = pyRound((refOn[j] - pe) / BUCKET_MS)
      hist.set(b, (hist.get(b) ?? 0) + 1)
    }
  }
  if (hist.size === 0) return [0, 0]
  const triple = (k: number): number => (hist.get(k - 1) ?? 0) + (hist.get(k) ?? 0) + (hist.get(k + 1) ?? 0)
  let peak = 0
  let best = -1
  for (const k of hist.keys()) {
    const score = triple(k)
    if (score > best) {
      best = score
      peak = k
    }
  }
  return [peak * BUCKET_MS, triple(peak)]
}

export interface MapEstimate {
  scale: number
  offsetMs: number
  /** Votes in the winning three buckets over the sampled source count. Not a coverage figure. */
  vote: number
}

function estimateMap(src: readonly Timed[], ref: readonly Timed[]): MapEstimate {
  const srcOn = src.map((c) => c.start)
  const refOn = ref.map((c) => c.start)
  if (srcOn.length === 0 || refOn.length === 0) return { scale: 1.0, offsetMs: 0, vote: 0 }
  const sampled = Math.ceil(srcOn.length / Math.max(1, Math.floor(srcOn.length / SAMPLE)))
  let best: [number, number, number] = [1.0, 0, -1]
  for (const scale of KODI_SCALES) {
    const [offset, votes] = bestOffset(srcOn, refOn, scale)
    if (votes > best[2]) best = [scale, offset, votes]
  }
  return { scale: best[0], offsetMs: best[1], vote: sampled ? best[2] / sampled : 0 }
}

/** Fraction of source dialogue whose mapped span overlaps any reference span. */
function overlapRate(src: readonly Timed[], ref: readonly Timed[], scale: number, offset: number): number {
  const refStarts = ref.map((c) => c.start)
  const refEnds = ref.map((c) => c.end)
  let ok = 0
  for (const c of src) {
    const es = scale * c.start + offset
    const ee = scale * c.end + offset
    // Kodi bisects the end list in start order, which need not be sorted; kept as shipped.
    for (let k = bisectLeft(refEnds, es); k < ref.length && refStarts[k] < ee; k += 1) {
      if (Math.min(ee, refEnds[k]) - Math.max(es, refStarts[k]) > 0) {
        ok += 1
        break
      }
    }
  }
  return src.length ? ok / src.length : 0
}

// ── the oracle ─────────────────────────────────────────────────────────────────────────────────

/** One hinted source cue: its NG `Cue.index` and the aligned reference dialogue as Kodi cleaned it. */
export interface OracleHint {
  sourceIndex: number
  referenceIndex: number
  referenceText: string
}

export interface OracleEvidence extends MapEstimate {
  overlap: number
  sourceDialogue: number
  referenceDialogue: number
}

export type OracleMiss = 'insufficient' | 'weak_correspondence' | 'error'

export type OracleAlignment =
  | { profile: 'oracle'; hinted: true; hints: OracleHint[]; evidence: OracleEvidence; diag: string }
  | { profile: 'oracle'; hinted: false; reason: OracleMiss; evidence: OracleEvidence | null; diag: string }

/** §2.3's confidence gate: scale band, then vote, then coverage overlap. */
export function oracleGatePasses(scale: number, vote: number, overlap: number): boolean {
  const g = ORACLE_PROFILE
  return g.scaleMin <= scale && scale <= g.scaleMax && vote >= g.voteMin && overlap >= g.overlapMin
}

/** `%.0f` as Python formats it: ties to even. */
function pyPercent(fraction: number): string {
  return String(pyRound(fraction * 100))
}

function oracleDiag(e: OracleEvidence): string {
  const off = Math.trunc(e.offsetMs)
  return `scale=${e.scale.toFixed(4)} offset=${off >= 0 ? '+' : ''}${off}ms vote=${pyPercent(e.vote)}% overlap=${pyPercent(e.overlap)}%`
}

/**
 * `_arabic_for_blocks`: each source dialogue cue takes the reference cue it overlaps most once mapped
 * (ties to the later cue), else the nearest reference centre within 250 ms. Keyed by `Cue.index`, the
 * identity the batch loop requests, so it survives however batching later chunks the file.
 */
function oracleHints(source: readonly Cue[], ref: readonly Timed[], scale: number, offset: number): OracleHint[] {
  const centers = ref.map((c) => (c.start + c.end) / 2)
  const starts = ref.map((c) => c.start)
  const ends = ref.map((c) => c.end)
  const out: OracleHint[] = []
  for (const cue of source) {
    if (!isDialogue(joinedBody(cue.text).trim(), NOT_LETTER)) continue
    const es = scale * cue.startMs + offset
    const ee = scale * cue.endMs + offset
    let bestOv = 0
    let bestK = -1
    for (let k = bisectLeft(ends, es); k < ref.length && starts[k] < ee; k += 1) {
      const ov = Math.min(ee, ends[k]) - Math.max(es, starts[k])
      if (ov > 0 && (bestK < 0 || ov >= bestOv)) {
        bestOv = ov
        bestK = k
      }
    }
    if (bestK < 0) {
      const pred = scale * ((cue.startMs + cue.endMs) / 2) + offset
      const j = bisectLeft(centers, pred)
      let bd = 1e9
      for (const kk of [j - 1, j, j + 1]) {
        if (kk >= 0 && kk < ref.length && Math.abs(centers[kk] - pred) < bd) {
          bd = Math.abs(centers[kk] - pred)
          bestK = kk
        }
      }
      if (bestK < 0 || bd > TIGHT_MS) continue
    }
    out.push({ sourceIndex: cue.index, referenceIndex: ref[bestK].index, referenceText: ref[bestK].text })
  }
  return out
}

function alignOracle(source: readonly Cue[], reference: readonly Cue[]): OracleAlignment {
  try {
    const src = dialogueOf(source, NOT_LETTER)
    const ref = dialogueOf(reference, NOT_LETTER)
    if (src.length < ORACLE_PROFILE.minDialogueCues || ref.length < ORACLE_PROFILE.minDialogueCues) {
      return {
        profile: 'oracle',
        hinted: false,
        reason: 'insufficient',
        evidence: null,
        diag: `too few dialogue cues (en=${src.length} ar=${ref.length})`
      }
    }
    const map = estimateMap(src, ref)
    const evidence: OracleEvidence = {
      ...map,
      overlap: overlapRate(src, ref, map.scale, map.offsetMs),
      sourceDialogue: src.length,
      referenceDialogue: ref.length
    }
    const detail = oracleDiag(evidence)
    if (!oracleGatePasses(evidence.scale, evidence.vote, evidence.overlap)) {
      return { profile: 'oracle', hinted: false, reason: 'weak_correspondence', evidence, diag: `gate FAILED (${detail})` }
    }
    const hints = oracleHints(source, ref, evidence.scale, evidence.offsetMs)
    if (hints.length === 0) {
      return { profile: 'oracle', hinted: false, reason: 'weak_correspondence', evidence, diag: `gate OK (${detail})` }
    }
    return { profile: 'oracle', hinted: true, hints, evidence, diag: `gate OK (${detail})` }
  } catch (err) {
    return { profile: 'oracle', hinted: false, reason: 'error', evidence: null, diag: `align crashed: ${(err as Error).name}` }
  }
}

// ── independent-align ──────────────────────────────────────────────────────────────────────────

/** The exact reason taxonomy (§9.4b Bundle B item 9), in the order `electron/shared/alignment.ts` lists it. */
export const INDEPENDENT_REASONS = Object.freeze([
  'ok',
  'partial_coverage',
  'malformed',
  'insufficient',
  'wrong_title',
  'weak_correspondence',
  'likely_different_cut',
  'invariant_failure'
] as const)

export type IndependentReason = (typeof INDEPENDENT_REASONS)[number]

export type IndependentVerdict = 'accept' | 'check' | 'refuse'

/** The refit over unique monotonic pairs. Coverage counts retained pairs against source dialogue. */
export interface IndependentFit {
  scale: number
  offsetMs: number
  pairs: number
  retained: number
  retainedPct: number
  coveragePct: number
  residualMedianMs: number
  residualAbsMedianMs: number
  residualAbsP95Ms: number
  residualAbsMaxMs: number
}

export type LocalPattern =
  | 'stable_local_offset'
  | 'likely_fps_or_scale_drift'
  | 'likely_different_cut'
  | 'mixed_local_anomaly'
  | 'insufficient_local_evidence'

/** One of the nine source regions, paired under the single global map. */
export interface LocalSupportWindow {
  window: number
  sourceStartMs: number
  sourceEndMs: number
  sourceCues: number
  matchedPairs: number
  coveragePct: number
  residualMedianMs: number | null
  /** Reference dialogue starts inside the window's mapped span, widened by the 250 ms pairing tolerance (R1). */
  referenceCount: number
  /** `referenceCount / sourceCues` to three places. Display only: every threshold reads the exact ratio. */
  referenceDensity: number
}

/** §4.1b item 5: whether the global map holds everywhere, or one part of the film disagrees with another. */
export interface IndependentLocal {
  pattern: LocalPattern
  /** Sustained step evidence that is not smooth drift: refuses as `likely_different_cut`. */
  piecewiseSteps: boolean
  /** Offset changes smoothly with time (R² ≥ 0.85, no step): drift, not a cut. */
  linearDrift: boolean
  driftR2: number | null
  stepEvents: number
  thirdJumpEvents: number
  histogramWindows: number
  strongestWindowVote: number
  supportedWindows: number
  unsupportedWindows: number
  /** R2: windows at most 20% covered that a subtitle or embedded reference has too few lines for to count against the map. */
  noEvidenceWindows: number
  /** R3, Global entry only: an edge window the reference has lines for disagrees with the rest of the film. */
  edgeContradiction: boolean
  globalTrustworthy: boolean
  windows: LocalSupportWindow[]
}

/** Residual offset of the first and last third of the pairs under the global map. */
export interface IndependentDrift {
  firstThirdOffsetMs: number | null
  lastThirdOffsetMs: number | null
  driftMs: number | null
  /** |drift| above 3,000 ms: reported, never a refusal by itself. */
  warning: boolean
}

/** §4.1b item 7: the source as it already is, against the reference. */
export interface IndependentIdentity {
  coveragePct: number
  medianDeltaMs: number | null
  /** Median |reference − source| over the identity pairs: the file's typical miss as it is. */
  residualAbsMedianMs: number | null
  pairs: number
  alreadyAligned: boolean
  /** The fitted map would cover less than leaving the file alone, so the file is left alone. */
  keptIdentity: boolean
}

/** Numbers and text-free issue codes only: a reason must be explainable without quoting a line. */
export interface IndependentEvidence {
  sourceCues: number
  referenceCues: number
  sourceDialogue: number
  referenceDialogue: number
  issues: string[]
  coarse: (MapEstimate & { overlap: number }) | null
  fit: IndependentFit | null
  local: IndependentLocal | null
  drift: IndependentDrift | null
  identity: IndependentIdentity | null
}

export type IndependentAlignment =
  | {
      profile: 'independent-align'
      verdict: 'accept' | 'check'
      reason: 'ok' | 'partial_coverage'
      transform: { scale: number; offsetMs: number }
      cues: Cue[]
      evidence: IndependentEvidence
    }
  | {
      profile: 'independent-align'
      verdict: 'refuse'
      reason: Exclude<IndependentReason, 'ok' | 'partial_coverage'>
      evidence: IndependentEvidence
    }

/** What the correspondence verdict reads; preflight and invariants are decided around it. */
export interface IndependentMeasures {
  coveragePct: number
  vote: number
  overlap: number
  scale: number
  retainedPct: number
  residualMedianMs: number
}

/**
 * The verdict after a valid preflight and before the post-transform invariants, in order: coverage
 * below the CHECK floor refuses (as `wrong_title` only when vote and overlap both sit in the random
 * band), then the 0.55 vote/overlap floors and scale band, the retained-pair floor and the residual
 * bound refuse as `weak_correspondence`; what survives is `accept` at ≥85% coverage, else `check`.
 */
export function independentVerdict(m: IndependentMeasures): { verdict: IndependentVerdict; reason: IndependentReason } {
  const p = INDEPENDENT_PROFILE
  if (!(m.coveragePct >= p.checkCoveragePct)) {
    const random = m.vote <= p.wrongTitleVoteMax && m.overlap <= p.wrongTitleOverlapMax
    return { verdict: 'refuse', reason: random ? 'wrong_title' : 'weak_correspondence' }
  }
  if (!(m.vote >= p.voteMin && m.overlap >= p.overlapMin && p.scaleMin <= m.scale && m.scale <= p.scaleMax)) {
    return { verdict: 'refuse', reason: 'weak_correspondence' }
  }
  if (!(m.retainedPct >= p.retainedMinPct)) return { verdict: 'refuse', reason: 'weak_correspondence' }
  if (!(Math.abs(m.residualMedianMs) <= p.residualOkMs)) return { verdict: 'refuse', reason: 'weak_correspondence' }
  return m.coveragePct >= p.acceptCoveragePct ? { verdict: 'accept', reason: 'ok' } : { verdict: 'check', reason: 'partial_coverage' }
}

/** SubRip cannot write a time outside 00:00:00,000–99:59:59,999 or a fractional millisecond. */
function writableMs(ms: unknown): boolean {
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0) return false
  try {
    cueTimestamp(ms)
    return true
  } catch {
    return false
  }
}

/** §4.1b A: structure only, no estimator. Issue codes name the side, the rule and the cue number. */
function preflightIssues(side: 'source' | 'reference', cues: readonly Cue[]): string[] {
  if (!Array.isArray(cues) || cues.length === 0) return [`${side}:empty`]
  const issues: string[] = []
  let prevStart = -1
  for (let i = 0; i < cues.length; i += 1) {
    const c = cues[i] as Partial<Cue> | null
    const n = i + 1
    if (!c || typeof c !== 'object') {
      issues.push(`${side}:not_a_cue:${n}`)
      continue
    }
    if (c.index !== n) issues.push(`${side}:index:${n}`)
    if (typeof c.text !== 'string') issues.push(`${side}:text:${n}`)
    if (!writableMs(c.startMs) || !writableMs(c.endMs)) {
      issues.push(`${side}:time:${n}`)
      continue
    }
    const start = c.startMs as number
    if ((c.endMs as number) <= start) issues.push(`${side}:duration:${n}`)
    if (start < prevStart) issues.push(`${side}:order:${n}`)
    prevStart = start
  }
  if (issues.length > 0) return issues
  // Text is judged by the writer itself; the reparse comparison holds the writer and reader to each other.
  let written: string
  try {
    written = serializeCues(cues, '\n')
  } catch (err) {
    return [err instanceof CueWriteError && err.problem === 'text' ? `${side}:text:${err.index}` : `${side}:round_trip`]
  }
  const back = parseCues(written)
  const same =
    back.ok &&
    back.cues.length === cues.length &&
    back.cues.every(
      (b, i) => b.index === cues[i].index && b.startMs === cues[i].startMs && b.endMs === cues[i].endMs && b.text === writtenCueText(cues[i].text)
    )
  return same ? [] : [`${side}:round_trip`]
}

interface Pair {
  x: number
  y: number
}

/**
 * §4.1b C: walk source dialogue in order, mapping each start and taking the nearest unused reference
 * start within `tolMs`. The cursor only moves forward, so each reference cue is used at most once and
 * order is preserved; an equidistant pair of candidates is ambiguous and pairs nothing.
 */
function monotonicPairs(src: readonly Timed[], refStarts: readonly number[], scale: number, offset: number, tolMs: number): Pair[] {
  const pairs: Pair[] = []
  let cursor = 0
  for (const s of src) {
    const mapped = scale * s.start + offset
    let best = -1
    let bestD = Infinity
    let tied = false
    for (let j = Math.max(cursor, bisectLeft(refStarts, mapped - tolMs)); j < refStarts.length && refStarts[j] <= mapped + tolMs; j += 1) {
      const d = Math.abs(refStarts[j] - mapped)
      if (d < bestD) {
        bestD = d
        best = j
        tied = false
      } else if (d === bestD) {
        tied = true
      }
    }
    if (best < 0 || tied) continue
    pairs.push({ x: s.start, y: refStarts[best] })
    cursor = best + 1
  }
  return pairs
}

function leastSquares(pairs: readonly Pair[]): { scale: number; offset: number } {
  const n = pairs.length
  const mx = pairs.reduce((a, p) => a + p.x, 0) / n
  const my = pairs.reduce((a, p) => a + p.y, 0) / n
  let sxx = 0
  let sxy = 0
  for (const p of pairs) {
    sxx += (p.x - mx) * (p.x - mx)
    sxy += (p.x - mx) * (p.y - my)
  }
  if (n < 2 || sxx <= 0) return { scale: 1, offset: my - mx }
  const scale = sxy / sxx
  return { scale, offset: my - scale * mx }
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * §4.1a: least squares, drop pairs whose residual exceeds k·MAD, refit, until nothing more drops or
 * the iteration cap. The cut is on the raw residual, as E66 searched k in the research mirror. A MAD
 * of zero uses 1 ms; if a round would drop every pair the previous set stands. The returned map is
 * fitted to the returned set.
 */
function madRefit(pairs: readonly Pair[]): { scale: number; offset: number; kept: Pair[] } | null {
  if (pairs.length === 0) return null
  const p = INDEPENDENT_PROFILE
  let kept = [...pairs]
  let fit = leastSquares(kept)
  for (let it = 0; it < p.madMaxIterations; it += 1) {
    const residuals = kept.map((q) => q.y - (fit.scale * q.x + fit.offset))
    const mid = median(residuals)
    const mad = median(residuals.map((r) => Math.abs(r - mid)))
    const cutoff = p.madK * (mad > 1e-9 ? mad : 1)
    const next = kept.filter((_, i) => Math.abs(residuals[i]) <= cutoff)
    if (next.length === 0 || next.length === kept.length) break
    kept = next
    fit = leastSquares(kept)
  }
  return { ...fit, kept }
}

/** `_scale_refine_values`: `center ± radius` in `step`s inside the scale band, plus `center` at 2–4 digits. */
function refineScales(center: number, step: number, radius: number): number[] {
  const p = INDEPENDENT_PROFILE
  const values = new Set<number>()
  const steps = pyRound((2 * radius) / step) + 1
  for (let i = 0; i < steps; i += 1) {
    const s = rounded(center - radius + i * step, 6)
    if (p.scaleMin <= s && s <= p.scaleMax) values.add(s)
  }
  for (const digits of [2, 3, 4]) values.add(rounded(center, digits))
  return [...values].sort((a, b) => a - b)
}

/**
 * E66's coarse search for `independent-align` (`align_detector.py:312-403`): Kodi's frame-rate
 * ratios, then a 0.002 grid across the scale band, then 0.0001 steps within ±0.002 of the best —
 * the step that lets a non-frame-rate scale such as 1.03 align at all. Highest vote wins, then
 * highest overlap. The oracle keeps Kodi's own `estimateMap` and never calls this.
 *
 * The winning three-bucket run is 1,500 ms wide and its lowest centre wins a tie, so the proposal
 * can sit a whole 500 ms bucket off a plain offset — twice the 250 ms pairing tolerance — and then
 * pair nothing. The offset is therefore the median of the deltas that voted inside the winning run.
 */
function coarseIndependent(src: readonly Timed[], ref: readonly Timed[]): MapEstimate & { overlap: number } {
  const p = INDEPENDENT_PROFILE
  const srcOn = src.map((c) => c.start)
  const refOn = ref.map((c) => c.start)
  const step = Math.max(1, Math.floor(srcOn.length / SAMPLE))
  const sample: number[] = []
  for (let i = 0; i < srcOn.length; i += step) sample.push(i)
  const seen = new Set<number>()
  let best: { scale: number; offsetMs: number; vote: number; overlap: number } | null = null
  const consider = (scales: readonly number[]): void => {
    for (const scale of scales) {
      if (seen.has(scale)) continue
      seen.add(scale)
      const h = windowHistogram(srcOn, refOn, scale, sample)
      const vote = rounded(h.vote, 6)
      const overlap = rounded(overlapRate(src, ref, scale, h.offsetMs), 6)
      if (!best || vote > best.vote || (vote === best.vote && overlap > best.overlap)) best = { scale, offsetMs: h.offsetMs, vote, overlap }
    }
  }
  consider(KODI_SCALES)
  consider(Array.from({ length: pyRound((p.scaleMax - p.scaleMin) / 0.002) + 1 }, (_, i) => rounded(p.scaleMin + i * 0.002, 6)))
  consider(refineScales((best as unknown as { scale: number }).scale, 0.0001, 0.002))
  const chosen = best as unknown as { scale: number; offsetMs: number; vote: number; overlap: number }
  const deltas: number[] = []
  for (const i of sample) {
    const mapped = chosen.scale * srcOn[i]
    const hi = bisectRight(refOn, mapped + chosen.offsetMs + 1.5 * BUCKET_MS)
    for (let j = bisectLeft(refOn, mapped + chosen.offsetMs - 1.5 * BUCKET_MS); j < hi; j += 1) deltas.push(refOn[j] - mapped)
  }
  return deltas.length ? { ...chosen, offsetMs: median(deltas) } : chosen
}

const REPAIR_ROUNDS = 4

/**
 * Pair at 250 ms from the coarse proposal, refit, and re-pair from each refit until the map stops
 * moving (implementation_plan.md §9.4b Bundle B item 2; E66's `_iterative_pair_refit`). The coarse
 * map is quantised, so the first pass may pair only where it happens to be close; the refit from
 * those pairs is what reaches the rest of the film.
 */
function fitIndependent(src: readonly Timed[], ref: readonly Timed[], coarse: MapEstimate): { fit: IndependentFit; pairs: Pair[] } | null {
  const refStarts = ref.map((c) => c.start)
  let scale = coarse.scale
  let offset = coarse.offsetMs
  let pairs: Pair[] = []
  let kept: Pair[] = []
  for (let round = 0; round < REPAIR_ROUNDS; round += 1) {
    const nextPairs = monotonicPairs(src, refStarts, scale, offset, INDEPENDENT_PROFILE.pairToleranceMs)
    const next = madRefit(nextPairs)
    if (!next) break
    const stable = Math.abs(next.scale - scale) < 1e-6 && Math.abs(next.offset - offset) < 0.5
    pairs = nextPairs
    kept = next.kept
    scale = next.scale
    offset = next.offset
    if (stable) break
  }
  if (kept.length === 0) return null
  const residuals = kept.map((q) => q.y - (scale * q.x + offset))
  const abs = residuals.map(Math.abs).sort((a, b) => a - b)
  return {
    fit: {
      scale,
      offsetMs: offset,
      pairs: pairs.length,
      retained: kept.length,
      retainedPct: (kept.length / pairs.length) * 100,
      coveragePct: (kept.length / src.length) * 100,
      residualMedianMs: median(residuals),
      residualAbsMedianMs: median(abs),
      residualAbsP95Ms: abs[Math.min(abs.length - 1, Math.ceil(0.95 * abs.length) - 1)],
      residualAbsMaxMs: abs[abs.length - 1]
    },
    pairs
  }
}

// ── local windows, drift and identity (§9.4b Bundle B items 5 and 7; E66 mirror :590-995) ──────

/** `_segment_index_ranges`: `segments` equal runs of cue positions, the last taking the remainder. */
function segmentRanges(count: number, segments: number): [number, number][] {
  if (count <= 0) return []
  const chunk = Math.max(1, Math.floor(count / segments))
  const out: [number, number][] = []
  for (let seg = 0; seg < segments; seg += 1) {
    const start = seg * chunk
    const end = seg === segments - 1 ? count : Math.min(count, (seg + 1) * chunk)
    if (start < end) out.push([start, end])
  }
  return out
}

function mean(values: readonly number[]): number {
  return values.reduce((a, v) => a + v, 0) / values.length
}

function mad(values: readonly number[]): number {
  if (values.length === 0) return 0
  const mid = median(values)
  return median(values.map((v) => Math.abs(v - mid)))
}

/** `round(x, digits)` for evidence the mirror rounds before it compares (`:749`). */
function rounded(x: number, digits: number): number {
  return Number(x.toFixed(digits))
}

interface SeriesPoint {
  kind: 'whole' | 'third' | 'sliding'
  timeMs: number
  offsetMs: number
  vote: number
}

/**
 * `_histogram_offset` over chosen source positions at the fitted scale: every reference start within
 * ±10 minutes votes for its 500 ms bucket; the winning three-bucket run, lowest centre on a tie.
 */
function windowHistogram(srcOn: readonly number[], refOn: readonly number[], scale: number, idx: readonly number[]): { offsetMs: number; vote: number } {
  const votes = new Map<number, number>()
  for (const i of idx) {
    const mapped = scale * srcOn[i]
    const hi = bisectRight(refOn, mapped + MAXOFF_MS)
    for (let j = bisectLeft(refOn, mapped - MAXOFF_MS); j < hi; j += 1) {
      const b = pyRound((refOn[j] - mapped) / BUCKET_MS) * BUCKET_MS
      votes.set(b, (votes.get(b) ?? 0) + 1)
    }
  }
  if (idx.length === 0 || votes.size === 0) return { offsetMs: 0, vote: 0 }
  let center = 0
  let best = -1
  for (const c of [...votes.keys()].sort((a, b) => a - b)) {
    const score = (votes.get(c - BUCKET_MS) ?? 0) + (votes.get(c) ?? 0) + (votes.get(c + BUCKET_MS) ?? 0)
    if (score > best) {
      best = score
      center = c
    }
  }
  return { offsetMs: center, vote: best / idx.length }
}

/** `_local_histogram_series`: whole, thirds and nine sliding windows; a window under vote 0.55 says nothing. */
function localSeries(srcOn: readonly number[], refOn: readonly number[], scale: number): SeriesPoint[] {
  if (srcOn.length < 8) return []
  const L = INDEPENDENT_LOCAL_PROFILE
  const series: SeriesPoint[] = []
  const add = (kind: SeriesPoint['kind'], from: number, to: number): void => {
    let idx = Array.from({ length: to - from }, (_, k) => from + k)
    if (idx.length === 0) return
    if (idx.length > SAMPLE) {
      const step = Math.max(1, Math.floor(idx.length / SAMPLE))
      idx = idx.filter((_, k) => k % step === 0)
    }
    const h = windowHistogram(srcOn, refOn, scale, idx)
    if (h.vote < L.windowVoteMin) return
    series.push({ kind, timeMs: mean(idx.map((i) => srcOn[i])), offsetMs: h.offsetMs, vote: h.vote })
  }
  const n = srcOn.length
  add('whole', 0, n)
  for (const [a, b] of segmentRanges(n, 3)) add('third', a, b)
  const count = Math.max(3, L.windows)
  const width = Math.max(8, Math.floor(n / count))
  if (n >= width) {
    const maxStart = n - width
    for (let w = 0; w < count; w += 1) {
      const start = pyRound((w * maxStart) / Math.max(count - 1, 1))
      add('sliding', start, Math.min(n, start + width))
    }
  }
  return series.sort((a, b) => a.timeMs - b.timeMs)
}

/** `_pair_third_raw_offsets`: per third of the pairs, the median of `ref − scale·src`. */
function pairThirds(pairs: readonly Pair[], scale: number): [number, number][] {
  if (pairs.length < 3) return []
  const chunk = Math.max(1, Math.floor(pairs.length / 3))
  const out: [number, number][] = []
  for (let seg = 0; seg < 3; seg += 1) {
    const subset = pairs.slice(seg * chunk, seg === 2 ? pairs.length : (seg + 1) * chunk)
    if (subset.length === 0) continue
    out.push([mean(subset.map((p) => p.x)), rounded(median(subset.map((p) => p.y - scale * p.x)), 3)])
  }
  return out
}

/** `_local_support_windows`: nine source regions, each paired on its own under the one global map. */
function supportWindows(src: readonly Timed[], refStarts: readonly number[], scale: number, offset: number): LocalSupportWindow[] {
  return segmentRanges(src.length, Math.max(3, INDEPENDENT_LOCAL_PROFILE.windows)).map(([a, b], window) => {
    const subset = src.slice(a, b)
    const pairs = monotonicPairs(subset, refStarts, scale, offset, INDEPENDENT_PROFILE.pairToleranceMs)
    const residuals = pairs.map((p) => p.y - (scale * p.x + offset))
    const lo = scale * subset[0].start + offset - INDEPENDENT_PROFILE.pairToleranceMs
    const hi = scale * subset[subset.length - 1].start + offset + INDEPENDENT_PROFILE.pairToleranceMs
    const referenceCount = bisectRight(refStarts, hi) - bisectLeft(refStarts, lo)
    return {
      window,
      sourceStartMs: subset[0].start,
      sourceEndMs: subset[subset.length - 1].end,
      sourceCues: subset.length,
      matchedPairs: pairs.length,
      coveragePct: rounded((100 * pairs.length) / subset.length, 3),
      residualMedianMs: residuals.length ? rounded(median(residuals), 3) : null,
      referenceCount,
      referenceDensity: rounded(referenceCount / subset.length, 3)
    }
  })
}

/** R2's density gate is on only for a subtitle reference: a file or an embedded text track. */
function densityGated(referenceKind: IndependentReferenceKind): boolean {
  return referenceKind === 'subtitle' || referenceKind === 'embedded'
}

/**
 * R2: whether a window counts as unsupported. At most 20% covered, and — for a subtitle reference — the
 * reference has at least half as many lines in the window's mapped span as the window has. A window the
 * reference simply has no lines for is no evidence against the map. Audio and transcript references keep
 * the plain 20% rule.
 */
export function densityUnsupported(window: LocalSupportWindow, referenceKind: IndependentReferenceKind): boolean {
  if (!(window.coveragePct <= INDEPENDENT_LOCAL_PROFILE.unsupportedCoveragePct)) return false
  return !densityGated(referenceKind) || window.referenceCount / window.sourceCues >= INDEPENDENT_DENSITY_PROFILE.referenceDensityMin
}

/**
 * R3: the first or last window has the reference's lines (exact density ≥ 0.8) yet pairs under 70% of
 * them, at least 20 points below the median window (`sorted[floor(n/2)]`). Needs at least three windows.
 */
export function edgeContradiction(windows: readonly LocalSupportWindow[]): boolean {
  if (windows.length < 3) return false
  const D = INDEPENDENT_DENSITY_PROFILE
  const covs = windows.map((w) => w.coveragePct).sort((a, b) => a - b)
  const mid = covs[Math.floor(covs.length / 2)]
  return [windows[0], windows[windows.length - 1]].some(
    (w) => w.coveragePct < D.edgeCoverageBelowPct && w.referenceCount / w.sourceCues >= D.edgeDensityMin && mid - w.coveragePct >= D.edgeGapMin
  )
}

/** `_linear_fit_quality`, with the mirror's rounding: the step test reads the rounded line. */
function linearQuality(points: readonly [number, number][]): { slope: number; intercept: number; r2: number } | null {
  if (points.length < 2) return null
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const mx = mean(xs)
  const my = mean(ys)
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < xs.length; i += 1) {
    sxx += (xs[i] - mx) ** 2
    sxy += (xs[i] - mx) * (ys[i] - my)
  }
  const slope = sxx === 0 ? 1 : sxy / sxx
  const intercept = my - slope * mx
  const ssTot = ys.reduce((a, y) => a + (y - my) ** 2, 0)
  const ssRes = ys.reduce((a, y, i) => a + (y - (slope * xs[i] + intercept)) ** 2, 0)
  return { slope: rounded(slope, 6), intercept: rounded(intercept, 3), r2: rounded(ssTot === 0 ? 1 : 1 - ssRes / ssTot, 6) }
}

/** `_residual_step_events`: jumps of at least `stepMin` between neighbouring residuals once the line is removed. */
function residualSteps(points: readonly [number, number][], stepMin: number): { steps: number; residuals: number[]; line: ReturnType<typeof linearQuality> } {
  const line = linearQuality(points)
  const slope = line?.slope ?? 0
  const intercept = line?.intercept ?? 0
  const residuals = points.map(([t, y]) => y - (slope * t + intercept))
  let steps = 0
  for (let i = 0; i + 1 < residuals.length; i += 1) if (Math.abs(residuals[i + 1] - residuals[i]) >= stepMin) steps += 1
  return { steps, residuals, line }
}

/**
 * `_detect_step_vs_drift`: a sustained step that is not smooth drift. Mixed support — one region the
 * global map covers at ≥80% and another at ≤20% — is sufficient on its own. Step events bind only when
 * the global map is not already trustworthy and a local window votes ≥0.80, and histogram-only steps
 * also need an unsupported region (a regular missing-cue cadence can alias a small window, `:891-898`).
 * For a subtitle or embedded reference a window counts as unsupported only where the reference has lines
 * (R2); on the Global entry an edge window that has the reference's lines but pairs far below the rest
 * is a different cut too (R3). A judged candidate never gets R3.
 */
function localPattern(
  series: readonly SeriesPoint[],
  thirds: readonly [number, number][],
  windows: LocalSupportWindow[],
  globalTrustworthy: boolean,
  referenceKind: IndependentReferenceKind,
  entry: IndependentEntry
): IndependentLocal {
  const L = INDEPENDENT_LOCAL_PROFILE
  const stepMin = L.residualStepMinMs
  const hist = series.filter((s) => s.kind === 'sliding').map((s): [number, number] => [s.timeMs, s.offsetMs])
  const supported = windows.filter((w) => w.coveragePct >= L.supportedCoveragePct).length
  const unsupported = windows.filter((w) => densityUnsupported(w, referenceKind)).length
  const strongest = Math.max(0, ...series.filter((s) => s.kind !== 'whole').map((s) => s.vote))
  const base: IndependentLocal = {
    pattern: 'insufficient_local_evidence',
    piecewiseSteps: false,
    linearDrift: false,
    driftR2: null,
    stepEvents: 0,
    thirdJumpEvents: 0,
    histogramWindows: hist.length,
    strongestWindowVote: rounded(strongest, 6),
    supportedWindows: supported,
    unsupportedWindows: unsupported,
    noEvidenceWindows: windows.filter((w) => w.coveragePct <= L.unsupportedCoveragePct).length - unsupported,
    edgeContradiction: false,
    globalTrustworthy,
    windows
  }
  let histSteps = 0
  let pairSteps = 0
  let bestR2: number | null = null
  let residualMad = 0
  for (const [kind, points] of [
    ['histogram', hist],
    ['pairs', thirds]
  ] as const) {
    if (points.length < 3) continue
    const r = residualSteps(points, stepMin)
    if (kind === 'histogram') histSteps = r.steps
    else pairSteps = r.steps
    if (r.line && (bestR2 === null || r.line.r2 > bestR2)) bestR2 = r.line.r2
    residualMad = Math.max(residualMad, mad(r.residuals))
  }
  if (hist.length < 3 && thirds.length < 3) return base

  const driftPoints = hist.length >= 3 ? hist : thirds
  const driftLine = residualSteps(driftPoints, stepMin).line
  const span = Math.max(driftPoints[driftPoints.length - 1][0] - driftPoints[0][0], 1)
  const slopeSpan = Math.abs(driftLine?.slope ?? 0) * span
  const thirdSeries = series.filter((s) => s.kind === 'third').map((s): [number, number] => [s.timeMs, s.offsetMs])
  const thirdJumps = residualSteps(thirdSeries, stepMin).steps
  const allSteps = histSteps + pairSteps
  const linearDrift =
    driftLine !== null &&
    driftLine.r2 >= L.linearDriftR2Min &&
    slopeSpan >= L.driftWarnMs * 0.25 &&
    allSteps === 0 &&
    thirdJumps === 0 &&
    residualMad < stepMin * 0.5

  const pairSpan = thirds.length >= 2 ? Math.max(...thirds.map((p) => p[1])) - Math.min(...thirds.map((p) => p[1])) : 0
  let large = pairSteps
  let histogramOnly = false
  if (large === 0 && pairSpan < stepMin) {
    large = histSteps
    histogramOnly = large > 0
  }
  if (large === 0 && thirdJumps > 0) {
    large = thirdJumps
    histogramOnly = true
  }
  let eventSupported = large >= L.stepMinWindows || (large >= 1 && (thirdJumps > 0 || large / Math.max(thirds.length - 1, 1) >= L.stepMinFraction))
  if (histogramOnly && unsupported === 0) eventSupported = false
  const sustained =
    (supported > 0 && unsupported > 0) ||
    (eventSupported && strongest >= Math.max(L.strongWindowVoteMin, INDEPENDENT_PROFILE.voteMin) && !globalTrustworthy)

  const edge = entry === 'global' && edgeContradiction(windows)
  const piecewiseSteps = (sustained || edge) && !linearDrift
  return {
    ...base,
    pattern: piecewiseSteps ? 'likely_different_cut' : linearDrift ? 'likely_fps_or_scale_drift' : allSteps > 0 ? 'mixed_local_anomaly' : 'stable_local_offset',
    piecewiseSteps,
    edgeContradiction: edge,
    linearDrift,
    driftR2: bestR2,
    stepEvents: allSteps + thirdJumps,
    thirdJumpEvents: thirdJumps
  }
}

/** `_third_metrics`: the median residual of the first and last third of the pairs, and their difference. */
export function thirdDrift(pairs: readonly { x: number; y: number }[], scale: number, offset: number): IndependentDrift {
  if (pairs.length === 0) return { firstThirdOffsetMs: null, lastThirdOffsetMs: null, driftMs: null, warning: false }
  const chunk = Math.max(1, Math.floor(pairs.length / 3))
  const res = (ps: readonly Pair[]): number => median(ps.map((p) => p.y - (scale * p.x + offset)))
  const first = rounded(res(pairs.slice(0, chunk)), 3)
  const last = rounded(res(pairs.slice(-chunk)), 3)
  const driftMs = rounded(last - first, 3)
  return { firstThirdOffsetMs: first, lastThirdOffsetMs: last, driftMs, warning: Math.abs(driftMs) > INDEPENDENT_LOCAL_PROFILE.driftWarnMs }
}

/** `_identity_comparison`: pair the file as it is; already aligned at ≥85% coverage and |median| ≤400 ms. */
function identityOf(src: readonly Timed[], refStarts: readonly number[]): Omit<IndependentIdentity, 'keptIdentity'> {
  const p = INDEPENDENT_PROFILE
  const pairs = monotonicPairs(src, refStarts, 1, 0, p.pairToleranceMs)
  const coveragePct = src.length ? (100 * pairs.length) / src.length : 0
  const medianDeltaMs = pairs.length ? rounded(median(pairs.map((q) => q.y - q.x)), 3) : null
  return {
    coveragePct: rounded(coveragePct, 3),
    medianDeltaMs,
    residualAbsMedianMs: pairs.length ? rounded(median(pairs.map((q) => Math.abs(q.y - q.x))), 3) : null,
    pairs: pairs.length,
    alreadyAligned: coveragePct >= p.acceptCoveragePct && medianDeltaMs !== null && Math.abs(medianDeltaMs) <= p.residualOkMs
  }
}

function overlapCount(cues: readonly Cue[]): number {
  let n = 0
  let maxEnd = -Infinity
  for (const c of cues) {
    if (c.startMs < maxEnd) n += 1
    maxEnd = Math.max(maxEnd, c.endMs)
  }
  return n
}

/**
 * §4.1b G, the part that needs no preview: same count, indices, text and order; every time writable;
 * no inversion, no zero-length bunching, no overlap the source did not already have; and the result
 * written as SubRip reads back as itself. Nothing is clamped.
 */
function invariantIssues(source: readonly Cue[], out: readonly Cue[]): string[] {
  if (out.length !== source.length) return ['count']
  const issues: string[] = []
  let prevStart = -1
  for (let i = 0; i < out.length; i += 1) {
    const o = out[i]
    const n = i + 1
    if (o.index !== source[i].index || o.text !== source[i].text) issues.push(`identity:${n}`)
    if (!writableMs(o.startMs) || !writableMs(o.endMs)) issues.push(`time:${n}`)
    else if (o.endMs <= o.startMs) issues.push(`duration:${n}`)
    if (o.startMs < prevStart) issues.push(`order:${n}`)
    prevStart = o.startMs
  }
  if (overlapCount(out) > overlapCount(source)) issues.push('overlap')
  if (issues.length > 0) return issues
  // §9.4b item 8: the transformed file itself is written and read back, not just its numbers.
  let written: string
  try {
    written = serializeCues(out, '\n')
  } catch {
    return ['round_trip']
  }
  const back = parseCues(written)
  const same =
    back.ok &&
    back.cues.length === out.length &&
    back.cues.every((b, i) => b.index === out[i].index && b.startMs === out[i].startMs && b.endMs === out[i].endMs && b.text === writtenCueText(out[i].text))
  return same ? [] : ['round_trip']
}

/**
 * §9.4b item 8 for a timeline another engine wrote (ALASS; Bundle C item 7). The reparsed output must
 * be the source's own cues — same count, numbers and text as SubRip writes them — at times the
 * invariants above accept against the source itself, so an overlap the source did not have is new.
 * `null` is output that did not parse as SubRip.
 */
function candidateTimeline(source: readonly Cue[], output: readonly Cue[] | null): { ok: true; cues: Cue[] } | { ok: false; issues: string[] } {
  if (output === null) return { ok: false, issues: ['unreadable'] }
  if (output.length !== source.length) return { ok: false, issues: ['count'] }
  const issues: string[] = []
  for (let i = 0; i < output.length; i += 1) {
    if (output[i].index !== source[i].index || output[i].text !== writtenCueText(source[i].text)) issues.push(`identity:${i + 1}`)
  }
  if (issues.length > 0) return { ok: false, issues }
  const cues = source.map((c, i) => ({ index: c.index, startMs: output[i].startMs, endMs: output[i].endMs, text: c.text }))
  const broken = invariantIssues(source, cues)
  return broken.length > 0 ? { ok: false, issues: broken } : { ok: true, cues }
}

/**
 * Bundle C item 7: the verdict over a candidate timeline (ALASS's output, reparsed) — the source's own
 * cues at the candidate's times, judged by the complete `independent-align` A–I against the selected
 * reference. Not a second fit of the original source: that would refuse the different-cut shape the
 * candidate exists to handle. A candidate that is not the source's own cues refuses `invariant_failure`.
 */
export function judgeCandidate(
  profile: 'independent-align',
  source: readonly Cue[],
  output: readonly Cue[] | null,
  reference: readonly Cue[],
  referenceKind: IndependentReferenceKind
): IndependentAlignment {
  if (profile !== 'independent-align') throw new TypeError(`judgeCandidate needs the 'independent-align' profile; got ${JSON.stringify(profile)}`)
  const kind = referenceKindOf('judgeCandidate', referenceKind)
  const timeline = candidateTimeline(source, output)
  if (!timeline.ok) {
    return {
      profile: 'independent-align',
      verdict: 'refuse',
      reason: 'invariant_failure',
      evidence: {
        sourceCues: source.length,
        referenceCues: Array.isArray(reference) ? reference.length : 0,
        sourceDialogue: 0,
        referenceDialogue: 0,
        issues: timeline.issues,
        coarse: null,
        fit: null,
        local: null,
        drift: null,
        identity: null
      }
    }
  }
  return alignIndependent(timeline.cues, reference, kind, 'candidate')
}

function alignIndependent(source: readonly Cue[], reference: readonly Cue[], referenceKind: IndependentReferenceKind, entry: IndependentEntry): IndependentAlignment {
  const p = INDEPENDENT_PROFILE
  const evidence: IndependentEvidence = {
    sourceCues: Array.isArray(source) ? source.length : 0,
    referenceCues: Array.isArray(reference) ? reference.length : 0,
    sourceDialogue: 0,
    referenceDialogue: 0,
    issues: [...preflightIssues('source', source), ...preflightIssues('reference', reference)],
    coarse: null,
    fit: null,
    local: null,
    drift: null,
    identity: null
  }
  if (evidence.issues.length > 0) return { profile: 'independent-align', verdict: 'refuse', reason: 'malformed', evidence }

  const src = dialogueOf(source, NOT_ANY_LETTER)
  const ref = dialogueOf(reference, NOT_ANY_LETTER)
  evidence.sourceDialogue = src.length
  evidence.referenceDialogue = ref.length
  if (src.length < p.minDialogueCues || ref.length < p.minDialogueCues) {
    if (src.length < p.minDialogueCues) evidence.issues.push(`source:dialogue:${src.length}`)
    if (ref.length < p.minDialogueCues) evidence.issues.push(`reference:dialogue:${ref.length}`)
    return { profile: 'independent-align', verdict: 'refuse', reason: 'insufficient', evidence }
  }

  const map = coarseIndependent(src, ref)
  evidence.coarse = map
  const fitted = fitIndependent(src, ref, map)
  const fit = fitted ? fitted.fit : null
  evidence.fit = fit
  const refStarts = ref.map((c) => c.start)
  const identity = identityOf(src, refStarts)
  evidence.identity = { ...identity, keptIdentity: false }
  if (fitted && fit) {
    const drift = thirdDrift(fitted.pairs, fit.scale, fit.offsetMs)
    evidence.drift = drift
    const trustworthy =
      fit.coveragePct >= p.acceptCoveragePct && Math.abs(fit.residualMedianMs) <= p.residualOkMs && Math.abs(drift.driftMs ?? 0) <= INDEPENDENT_LOCAL_PROFILE.driftWarnMs
    evidence.local = localPattern(
      localSeries(
        src.map((c) => c.start),
        refStarts,
        fit.scale
      ),
      pairThirds(fitted.pairs, fit.scale),
      supportWindows(src, refStarts, fit.scale, fit.offsetMs),
      trustworthy,
      referenceKind,
      entry
    )
    // E66 orders a sustained local step ahead of every global gate (`align_detector.py:1073`).
    if (evidence.local.piecewiseSteps) return { profile: 'independent-align', verdict: 'refuse', reason: 'likely_different_cut', evidence }
  }
  const decided = independentVerdict({
    coveragePct: fit ? fit.coveragePct : 0,
    vote: evidence.coarse.vote,
    overlap: evidence.coarse.overlap,
    scale: fit ? fit.scale : NaN,
    retainedPct: fit ? fit.retainedPct : 0,
    residualMedianMs: fit ? fit.residualMedianMs : NaN
  })
  if (decided.verdict === 'refuse' || !fit) {
    return { profile: 'independent-align', verdict: 'refuse', reason: decided.reason as Exclude<IndependentReason, 'ok' | 'partial_coverage'>, evidence }
  }

  // §4.1b item 7, never worsen: an already-aligned file keeps its own times when the map, measured the
  // way identity is measured, would pair fewer cues, or as many with a larger median miss.
  const mapped = monotonicPairs(src, refStarts, fit.scale, fit.offsetMs, p.pairToleranceMs)
  const mappedCoverage = rounded((100 * mapped.length) / src.length, 3)
  const mappedMiss = mapped.length ? Math.abs(median(mapped.map((q) => q.y - (fit.scale * q.x + fit.offsetMs)))) : Infinity
  const worse =
    mappedCoverage < identity.coveragePct || (mappedCoverage === identity.coveragePct && mappedMiss > Math.abs(identity.medianDeltaMs ?? 0))
  if (identity.alreadyAligned && worse) {
    evidence.identity.keptIdentity = true
    return {
      profile: 'independent-align',
      verdict: 'accept',
      reason: 'ok',
      transform: { scale: 1, offsetMs: 0 },
      cues: source.map((c) => ({ index: c.index, startMs: c.startMs, endMs: c.endMs, text: c.text })),
      evidence
    }
  }
  const cues = source.map((c) => ({
    index: c.index,
    startMs: Math.round(fit.scale * c.startMs + fit.offsetMs),
    endMs: Math.round(fit.scale * c.endMs + fit.offsetMs),
    text: c.text
  }))
  const broken = invariantIssues(source, cues)
  if (broken.length > 0) {
    evidence.issues.push(...broken)
    return { profile: 'independent-align', verdict: 'refuse', reason: 'invariant_failure', evidence }
  }
  return {
    profile: 'independent-align',
    verdict: decided.verdict,
    reason: decided.reason as 'ok' | 'partial_coverage',
    transform: { scale: fit.scale, offsetMs: fit.offsetMs },
    cues,
    evidence
  }
}

// ── entry ──────────────────────────────────────────────────────────────────────────────────────

export function alignSubtitles(profile: 'oracle', source: readonly Cue[], reference: readonly Cue[]): OracleAlignment
export function alignSubtitles(profile: 'independent-align', source: readonly Cue[], reference: readonly Cue[], referenceKind: IndependentReferenceKind): IndependentAlignment
export function alignSubtitles(
  profile: AlignProfile,
  source: readonly Cue[],
  reference: readonly Cue[],
  referenceKind?: IndependentReferenceKind
): OracleAlignment | IndependentAlignment {
  if (profile === 'oracle') return alignOracle(source, reference)
  if (profile === 'independent-align') return alignIndependent(source, reference, referenceKindOf('alignSubtitles', referenceKind), 'global')
  throw new TypeError(`alignSubtitles needs a caller profile ('oracle' | 'independent-align'); got ${JSON.stringify(profile)}`)
}

// ── several embedded tracks (Bundle M, implementation_plan.md §16.0.3) ─────────────────────────────
//
// Every text track of a media file is aligned on its own by the A–I call above; nothing here changes a
// track's verdict. What this decides is which of the usable maps is the answer when there are several.
// Two maps agree when they move every cue of the SOURCE to within T of each other: the tracks' own line
// boundaries never enter it. Tracks that are near-copies of one another (the 50 ms raw-timing families)
// are one witness, so a release shipped as three copies cannot outvote one independent track.

/** T: the tolerance within which two usable maps are one answer. Measured, not derived (ledger E159a/E159c). */
export const TRACK_AGREEMENT_MS = 250
/** The sealed D16-3 family rule: equal cue count and every raw start and end within this of the representative. */
export const TRACK_FAMILY_MS = 50

/** The largest start or end difference between two maps of the same source cues; Infinity when they differ in length. */
export function mapDistance(a: readonly Cue[], b: readonly Cue[]): number {
  if (a.length !== b.length) return Infinity
  let worst = 0
  for (let i = 0; i < a.length; i += 1) {
    worst = Math.max(worst, Math.abs(a[i].startMs - b[i].startMs), Math.abs(a[i].endMs - b[i].endMs))
  }
  return worst
}

/**
 * D16-3: tracks in ordinal order; the first unassigned track starts a family as its representative and a
 * later unassigned track joins when it has as many cues and every raw start and end is within 50 ms of
 * the representative's. Not transitive: membership is judged against the representative only. Family
 * ids are 1-based, in the order families start.
 */
export function trackFamilies(tracks: readonly (readonly Cue[])[]): number[] {
  const family = new Array<number>(tracks.length).fill(0)
  let next = 0
  for (let i = 0; i < tracks.length; i += 1) {
    if (family[i] !== 0) continue
    next += 1
    family[i] = next
    for (let j = i + 1; j < tracks.length; j += 1) {
      if (family[j] === 0 && mapDistance(tracks[i], tracks[j]) <= TRACK_FAMILY_MS) family[j] = next
    }
  }
  return family
}

/** One usable track: its media ordinal, its family, its own A–I verdict and the source cues as it moved them. */
export interface ArbitrationTrack {
  ordinal: number
  family: number
  verdict: 'accept' | 'check'
  cues: readonly Cue[]
}

export interface ArbitrationSide {
  /** 1-based, in the order sides start. */
  id: number
  /** The ordinal of the track that started the side; its result is the side's result. */
  representative: number
  /** Every usable track on the side, in ordinal order. */
  members: number[]
  /** The families whose one witness this side holds. */
  witnesses: number[]
  /** Least permissive member verdict: `check` outranks `accept`. */
  verdict: 'accept' | 'check'
}

export interface TrackArbitration {
  tolerance: number
  sides: ArbitrationSide[]
  /** The sides sharing the largest witness count: one is a winner, more is a tie for the audio to settle. */
  leaders: number[]
  /** Usable tracks whose family's witness sits on another side; they add nothing where they are. */
  splitFamily: number[]
}

/**
 * §16.0.3 steps 5–6. Usable tracks in ordinal order: the first unassigned starts a side and each later
 * one joins when its map is within `tolerance` of the representative's. A family's one witness belongs
 * to the side holding its lowest-ordinal usable track.
 */
export function arbitrateTracks(usable: readonly ArbitrationTrack[], tolerance: number = TRACK_AGREEMENT_MS): TrackArbitration {
  const tracks = [...usable].sort((a, b) => a.ordinal - b.ordinal)
  const sideOf = new Map<number, ArbitrationSide>()
  const sides: ArbitrationSide[] = []
  for (const t of tracks) {
    if (sideOf.has(t.ordinal)) continue
    const side: ArbitrationSide = { id: sides.length + 1, representative: t.ordinal, members: [], witnesses: [], verdict: 'accept' }
    sides.push(side)
    for (const u of tracks) {
      if (sideOf.has(u.ordinal) || mapDistance(t.cues, u.cues) > tolerance) continue
      sideOf.set(u.ordinal, side)
      side.members.push(u.ordinal)
      if (u.verdict === 'check') side.verdict = 'check'
    }
  }
  const witnessSide = new Map<number, ArbitrationSide>()
  for (const t of tracks) if (!witnessSide.has(t.family)) witnessSide.set(t.family, sideOf.get(t.ordinal)!)
  for (const [family, side] of witnessSide) side.witnesses.push(family)
  const splitFamily = tracks.filter((t) => witnessSide.get(t.family) !== sideOf.get(t.ordinal)).map((t) => t.ordinal)
  const most = Math.max(0, ...sides.map((s) => s.witnesses.length))
  return { tolerance, sides, leaders: sides.filter((s) => s.witnesses.length === most && most > 0).map((s) => s.id), splitFamily }
}

/** §16.0.3 step 7: the one tied side whose representative the audio's map is within T of, or null. */
export function audioSettles(
  arbitration: TrackArbitration,
  representativeCues: (ordinal: number) => readonly Cue[],
  audio: readonly Cue[]
): number | null {
  const near = arbitration.sides.filter(
    (s) => arbitration.leaders.includes(s.id) && mapDistance(representativeCues(s.representative), audio) <= arbitration.tolerance
  )
  return near.length === 1 ? near[0].id : null
}
