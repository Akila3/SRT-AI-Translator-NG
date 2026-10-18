/**
 * What the loudness envelope can say about a transcription answer (implementation_plan.md Step 1.8a).
 * AUTHORED-BY: opus-5.5-high
 *
 * Three checks, every one of them against Step 1.4's envelope of the PREPARED audio — the audio the
 * model heard, with no band-pass (§10.3):
 *
 *  - the coverage gate (`feature_decisions.md` D5-7): no loud stretch is wordless, the words reach the
 *    last loud stretch, and the offsets are in order and inside the audio that was sent;
 *  - gross disproportion (D5-12): a little text against a lot of sound, which is what the measured
 *    invention looked like — 14 characters against 112 s of signal (`probe…:1437`, N8);
 *  - text on quiet audio, for the warning D5-12 pairs with that refusal.
 *
 * ⚠ Loud is not speech (F-A14): music, effects and room tone are all loud, and a quiet whisper is
 * not. So a wordless loud stretch is a reason to ask again, never proof that anything was lost, and
 * a passing answer is not proof that nothing was. A long invention passes all three checks; the
 * warning and the user are what cover it.
 *
 * "Loud" is relative to the run's own audio, because the levels that separate speech from silence
 * differ by 20 dB between files. Calibrated on the 1.1.0 transcripts the tester accepted
 * (gate_ledger.md §5.23): with these values Boeing never triggers, the Hebrew lecture's speechless
 * first three minutes are not loud, and Japanese 4819241 — loud throughout, dialogue thin after
 * 24 min — leaves 2 of its 80 stretches to be asked again instead of 23.
 */
import type { AudioEnvelope } from '../main/ffmpeg'
import type { TranscriptCue } from './progress'

/** The unit the probes measured coverage in (`probe…:698-733`). */
export const COVERAGE_BUCKET_SECONDS = 30
/** A window is loud within this much of the run's loud end (its 95th percentile)… */
export const LOUD_BELOW_REFERENCE_DB = 12
/** …and at least this far above its quiet end (10th percentile)… */
export const LOUD_ABOVE_FLOOR_DB = 10
/** …but the floor term never lifts the threshold closer than this to the loud end… */
export const LOUD_MIN_RANGE_DB = 3
/** …and never below this, whatever the file. */
export const LOUD_MIN_DB = -60
/** A stretch is loud when this share of it is. */
export const LOUD_BUCKET_SHARE = 0.2
/** Whole-second grids round; a cue may end this far past the audio it came from. */
export const OFFSET_TOLERANCE_SECONDS = 1
/** Disproportion needs this much loud signal before it means anything… */
export const DISPROPORTION_MIN_LOUD_SECONDS = 60
/** …and is fewer letters per loud second than this. N8 was 0.125; the thinnest accepted chunk 0.70. */
export const DISPROPORTION_MAX_LETTERS_PER_LOUD_SECOND = 0.15
/** A stretch with text and less loud signal than this is "text on quiet audio". */
export const QUIET_TEXT_MAX_LOUD_SECONDS = 1
/** An envelope that stops short of the audio by more than this cannot vouch for the rest. */
export const ENVELOPE_COMPLETE_TOLERANCE_SECONDS = 1

export interface Span {
  start: number
  end: number
}

/** The envelope with the run's loud threshold attached. */
export interface Loudness {
  windowSeconds: number
  levelsDb: readonly number[]
  durationSeconds: number
  thresholdDb: number
}

function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

/**
 * The run's loudness, or null when the envelope cannot vouch for the audio: missing, empty, or
 * stopping short of it. Null is a refusal, never an approval (D5-12: "no silent pass").
 */
export function loudnessOf(env: AudioEnvelope | null, durationSeconds: number): Loudness | null {
  if (!env || !(env.windowSeconds > 0) || env.levelsDb.length === 0 || !(durationSeconds > 0)) return null
  if (!env.levelsDb.every((v) => Number.isFinite(v))) return null
  const measured = env.levelsDb.length * env.windowSeconds
  if (measured + ENVELOPE_COMPLETE_TOLERANCE_SECONDS < durationSeconds) return null
  const sorted = [...env.levelsDb].sort((a, b) => a - b)
  const reference = percentile(sorted, 0.95)
  // On audio with little dynamic range the floor sits near the loud end; the floor term must not lift
  // the threshold past the file's own loud level, or nothing in it would ever count as loud.
  const thresholdDb = Math.max(
    reference - LOUD_BELOW_REFERENCE_DB,
    Math.min(percentile(sorted, 0.1) + LOUD_ABOVE_FLOOR_DB, reference - LOUD_MIN_RANGE_DB),
    LOUD_MIN_DB
  )
  return { windowSeconds: env.windowSeconds, levelsDb: env.levelsDb, durationSeconds, thresholdDb }
}

/** Seconds of loud signal in [from, to). */
export function loudSeconds(l: Loudness, from: number, to: number): number {
  const first = Math.max(0, Math.floor(from / l.windowSeconds + 1e-9))
  const last = Math.min(l.levelsDb.length, Math.ceil(to / l.windowSeconds - 1e-9))
  let n = 0
  for (let w = first; w < last; w++) if (l.levelsDb[w] >= l.thresholdDb) n++
  return n * l.windowSeconds
}

export interface Bucket extends Span {
  loudSeconds: number
  loud: boolean
}

/** The span in 30 s stretches from its start; a remainder under half a stretch joins the one before. */
export function bucketsOf(l: Loudness, span: Span): Bucket[] {
  const edges: number[] = []
  for (let t = span.start; t < span.end - 1e-9; t += COVERAGE_BUCKET_SECONDS) edges.push(t)
  if (edges.length > 1 && span.end - edges[edges.length - 1] < COVERAGE_BUCKET_SECONDS / 2) edges.pop()
  return edges.map((start, i) => {
    const end = i + 1 < edges.length ? edges[i + 1] : span.end
    const ls = loudSeconds(l, start, end)
    return { start, end, loudSeconds: ls, loud: ls >= LOUD_BUCKET_SHARE * (end - start) }
  })
}

function hasText(cue: TranscriptCue): boolean {
  return cue.text.trim().length > 0
}

function touches(cue: TranscriptCue, span: Span): boolean {
  return cue.start < span.end && Math.max(cue.end, cue.start + 1e-6) > span.start
}

/** Adjacent or overlapping spans as one. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end + 1e-9) last.end = Math.max(last.end, s.end)
    else out.push({ start: s.start, end: s.end })
  }
  return out
}

export type CoverageReason = 'wordless' | 'tail' | 'order' | 'beyond'

export type CoverageVerdict =
  | { ok: true }
  | { ok: false; reasons: CoverageReason[]; wordless: Span[] }

/** D5-7 over one unit of audio; `cues` are absolute. */
export function checkCoverage(l: Loudness, span: Span, cues: readonly TranscriptCue[]): CoverageVerdict {
  const reasons: CoverageReason[] = []
  const spoken = cues.filter(hasText)
  const buckets = bucketsOf(l, span)
  const wordless = mergeSpans(buckets.filter((b) => b.loud && !spoken.some((c) => touches(c, b))))
  if (wordless.length) reasons.push('wordless')
  const lastLoud = [...buckets].reverse().find((b) => b.loud)
  const lastWord = spoken.reduce((m, c) => Math.max(m, c.end), -Infinity)
  if (lastLoud && lastWord <= lastLoud.start) reasons.push('tail')
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].end < cues[i].start || (i > 0 && cues[i].start < cues[i - 1].start)) {
      reasons.push('order')
      break
    }
  }
  if (cues.some((c) => !insideSpan(span, c))) {
    reasons.push('beyond')
  }
  return reasons.length ? { ok: false, reasons, wordless } : { ok: true }
}

function insideSpan(span: Span, c: TranscriptCue): boolean {
  return c.start >= span.start - OFFSET_TOLERANCE_SECONDS && c.end <= span.end + OFFSET_TOLERANCE_SECONDS
}

/**
 * The cues of an answer whose times can be written, and how many could not: a cue must not end
 * before it starts, must lie inside the span it answers (within the rounding tolerance), and must not
 * start before the cue kept ahead of it. Nothing is re-timed — a cue that fails is left out and
 * counted, so the caller can say where (implementation_plan.md Step 1.8a: offsets monotonic and
 * inside the unit).
 *
 * ⚠ A cue whose start equals its end is kept. On a whole-second grid a short line rounds to one
 * instant, and 1.1.0 wrote such lines: the tester-checked Boeing transcript has 23 of 547
 * (verification_ledger.md E68c). Dropping them would lose real lines 1.1.0 kept.
 */
export function usableTimings(span: Span, cues: readonly TranscriptCue[]): { cues: TranscriptCue[]; dropped: number } {
  const kept: TranscriptCue[] = []
  for (const c of cues) {
    const last = kept[kept.length - 1]
    if (c.end >= c.start && insideSpan(span, c) && (!last || c.start >= last.start)) kept.push(c)
  }
  return { cues: kept, dropped: cues.length - kept.length }
}

/** Letters and digits, in any script; spaces and punctuation say nothing about what was heard. */
export function letterCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length
}

export interface Disproportion {
  letters: number
  loudSeconds: number
}

/**
 * D5-12: some text, and far too little of it for the sound in the unit. An empty answer is not this
 * — that is dropped audio, which the coverage gate asks again for.
 */
export function grossDisproportion(l: Loudness, span: Span, cues: readonly TranscriptCue[]): Disproportion | null {
  const letters = cues.reduce((n, c) => n + letterCount(c.text), 0)
  if (letters === 0) return null
  const loud = loudSeconds(l, span.start, span.end)
  if (loud < DISPROPORTION_MIN_LOUD_SECONDS) return null
  return letters < DISPROPORTION_MAX_LETTERS_PER_LOUD_SECOND * loud ? { letters, loudSeconds: loud } : null
}

/** Stretches that carry text over audio with almost no loud signal: where invented lines would sit. */
export function quietTextSpans(l: Loudness, cues: readonly TranscriptCue[]): Span[] {
  const spoken = cues.filter((c) => letterCount(c.text) > 0)
  if (!spoken.length) return []
  const all = bucketsOf(l, { start: 0, end: l.durationSeconds })
  return mergeSpans(all.filter((b) => b.loudSeconds < QUIET_TEXT_MAX_LOUD_SECONDS && spoken.some((c) => touches(c, b))))
}

/** The quietest window in [from, to], as a time — of equals, the one nearest the middle. */
export function quietestMoment(l: Loudness, from: number, to: number): number {
  const middle = (from + to) / 2
  const first = Math.max(0, Math.ceil(from / l.windowSeconds - 1e-9))
  const last = Math.min(l.levelsDb.length - 1, Math.floor(to / l.windowSeconds - 0.5))
  let best = -1
  const at = (w: number) => (w + 0.5) * l.windowSeconds
  for (let w = first; w <= last; w++) {
    if (best < 0 || l.levelsDb[w] < l.levelsDb[best] || (l.levelsDb[w] === l.levelsDb[best] && Math.abs(at(w) - middle) < Math.abs(at(best) - middle))) best = w
  }
  return best < 0 ? middle : Math.min(to, Math.max(from, at(best)))
}
