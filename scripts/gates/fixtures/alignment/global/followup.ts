/**
 * Round 8A follow-up shapes (implementation_plan.md §9.4c.4): generated timelines for the reference-density
 * and edge-cut gates. Synthetic and deterministic, author-written labels only, so no subtitle text enters
 * git. The truth of each shape is the construction that built it, never an aligner's answer.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import { retimed, speech, type PlainCue } from './fixtures'

/** mulberry32, as `fixtures.ts` seeds its own timelines. */
function generator(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The reference with its `[lo, hi)` fraction of lines replaced by as many unrelated lines at random times
 * across the same span: the reference HAS lines there, they just are not this film's.
 */
export function replacedBlock(reference: readonly PlainCue[], lo: number, hi: number, seed: number): PlainCue[] {
  const a = Math.floor(reference.length * lo)
  const b = Math.floor(reference.length * hi)
  const from = reference[a].start
  const to = reference[b - 1].start
  const next = generator(seed)
  const others = Array.from({ length: b - a }, () => from + Math.floor(next() * (to - from)))
    .sort((x, y) => x - y)
    .map((start, i) => ({ start, end: start + 1200 + Math.floor(next() * 1400), text: `Other line ${i + 1} answers.` }))
  return [...reference.slice(0, a), ...others, ...reference.slice(b)]
}

/**
 * The film on another release's clock (`offsetMs`), every line jittered by up to ±`jitterMs` and the first
 * `edgeCount` lines by up to ±`edgeJitterMs` instead: an opening that pairs worse than the rest without any
 * cut, as a release with a sloppier opening would.
 */
export function edgeJittered(film: readonly PlainCue[], offsetMs: number, jitterMs: number, edgeJitterMs: number, edgeCount: number, seed: number): PlainCue[] {
  const body = retimed(film, 1, offsetMs, 'Reference line', jitterMs, seed)
  const edge = retimed(film.slice(0, edgeCount), 1, offsetMs, 'Reference opening line', edgeJitterMs, seed + 1)
  return [...edge, ...body.slice(edgeCount)]
}

/** The reference without its `[lo, hi)` fraction of lines: a release that simply lacks that block. */
export function withoutBlock(reference: readonly PlainCue[], lo: number, hi: number): PlainCue[] {
  const a = Math.floor(reference.length * lo)
  const b = Math.floor(reference.length * hi)
  return reference.filter((_, i) => i < a || i >= b)
}

/** Every line from the `from` fraction up to the `until` fraction (exclusive) moved by `deltaMs`: a step, or a moved block. */
export function shiftedFrom(reference: readonly PlainCue[], from: number, deltaMs: number, until = 1): PlainCue[] {
  const a = Math.floor(reference.length * from)
  const b = Math.floor(reference.length * until)
  return reference.map((c, i) => (i >= a && i < b ? { ...c, start: c.start + deltaMs, end: c.end + deltaMs } : c))
}

/**
 * The film with `fraction` of extra lines (seeded) inserted at the `at` fraction, and everything after
 * them later by the block's length plus 3 s: a longer cut whose extra scenes the reference does not have.
 */
export function extraMiddle(film: readonly PlainCue[], at: number, fraction: number, seed: number): PlainCue[] {
  const k = Math.floor(film.length * at)
  const t0 = film[k].start
  const extra = speech(Math.round(film.length * fraction), seed, 'Extra', t0)
  const lengthMs = extra[extra.length - 1].end - t0 + 3000
  return [...film.slice(0, k), ...extra, ...film.slice(k).map((c) => ({ ...c, start: c.start + lengthMs, end: c.end + lengthMs }))]
}
