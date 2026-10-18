/**
 * Stage B for the dedicated transcription model (implementation_plan.md Bundle I, "Stage B — build
 * cues"). AUTHORED-BY: opus-5.5-high
 *
 * Deterministic, no model and no request: the word stream from `offsets.ts` is split at timing gaps,
 * then packed under the shipped subtitle rules — 1–5 s per cue, at most 42 characters a line and two
 * lines (gst `helpers.py:157-158`). Two rules the shipped prompt never needed:
 *
 *  - a minimum-duration floor, because the model returns zero-length words (6 of 82 probed words had
 *    `startOffset == endOffset`, `probe_gemini_3_5_transcribe.md` §7.3) and a cue built from one of
 *    them would last no time at all;
 *  - invariant 6: a span refused after bisection stays an explicit gap. No cue crosses it and no floor
 *    extends into it, so the hole the run reports is the hole in the file.
 */

import type { SrtCue } from './srt'
import { clampToDuration, ms, type GlobalWord } from './offsets'

/** A refused span on the file's clock, in seconds. */
export interface CueGap {
  start: number
  end: number
}

export interface CueRules {
  /** A silence at least this long between two words starts a new cue. */
  gapSeconds: number
  minSeconds: number
  maxSeconds: number
  lineChars: number
  maxLines: number
  /** The least a cue may last when the minimum cannot fit, one step of the 100 ms word grid. */
  floorSeconds: number
}

/** 400 ms: 12 boundaries in the probed 60 s, about 13 cues (`probe_gemini_3_5_transcribe.md` §7.3). */
export const STAGE_B_RULES: CueRules = {
  gapSeconds: 0.4,
  minSeconds: 1,
  maxSeconds: 5,
  lineChars: 42,
  maxLines: 2,
  floorSeconds: 0.1
}

/** Scripts written without spaces between words; the model returns their words separately. */
const UNSPACED = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\u0e00-\u0e7f\u0e80-\u0eff\u1000-\u109f\u1780-\u17ff]/u
const SENTENCE_END = /[.!?…。！？]["'”’»)\]]*$/u

function joinWords(words: readonly GlobalWord[]): string {
  let out = ''
  for (const w of words) {
    if (out === '') out = w.text
    else if (UNSPACED.test(out.slice(-1)) && UNSPACED.test(w.text.charAt(0))) out += w.text
    else out += ` ${w.text}`
  }
  return out
}

function length(text: string): number {
  return Array.from(text).length
}

/**
 * The words laid out as at most `maxLines` lines of `lineChars`, or `null` when they cannot be. Two
 * lines are balanced: the break that makes the longer line shortest. A single word longer than a line
 * is its own line; it cannot be broken.
 */
export function layoutLines(words: readonly GlobalWord[], rules: CueRules = STAGE_B_RULES): string[] | null {
  const whole = joinWords(words)
  if (length(whole) <= rules.lineChars || words.length === 1) return [whole]
  if (rules.maxLines < 2) return null
  let best: string[] | null = null
  let bestLongest = Infinity
  for (let cut = 1; cut < words.length; cut++) {
    const top = joinWords(words.slice(0, cut))
    const bottom = joinWords(words.slice(cut))
    const longest = Math.max(length(top), length(bottom))
    if (longest <= rules.lineChars && longest < bestLongest) {
      best = [top, bottom]
      bestLongest = longest
    }
  }
  return best
}

function gapBetween(gaps: readonly CueGap[], afterMs: number, beforeMs: number): boolean {
  return gaps.some((g) => ms(g.start) < beforeMs && ms(g.end) > afterMs)
}

/** Words in runs that no timing gap or refused span divides. */
function groupWords(words: readonly GlobalWord[], gaps: readonly CueGap[], rules: CueRules): GlobalWord[][] {
  const groups: GlobalWord[][] = []
  let current: GlobalWord[] = []
  for (const w of words) {
    const prev = current[current.length - 1]
    if (prev && (ms(w.start) - ms(prev.end) >= ms(rules.gapSeconds) || gapBetween(gaps, ms(prev.start), ms(w.start)))) {
      groups.push(current)
      current = []
    }
    current.push(w)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** One group packed greedily: a cue closes before a word that would break 5 s or the two-line layout. */
function packGroup(group: readonly GlobalWord[], rules: CueRules): GlobalWord[][] {
  const cues: GlobalWord[][] = []
  let current: GlobalWord[] = []
  for (const w of group) {
    if (current.length > 0) {
      const first = current[0]
      const last = current[current.length - 1]
      const tooLong = ms(w.end) - ms(first.start) > ms(rules.maxSeconds)
      const noRoom = layoutLines([...current, w], rules) === null
      const sentenceDone = SENTENCE_END.test(last.text) && ms(last.end) - ms(first.start) >= ms(rules.minSeconds)
      if (tooLong || noRoom || sentenceDone) {
        cues.push(current)
        current = []
      }
    }
    current.push(w)
  }
  if (current.length > 0) cues.push(current)
  return cues
}

interface Draft {
  words: GlobalWord[]
  start: number
  end: number
}

/** The first refused span that begins at or after `fromMs`, as a time limit. */
function nextGapStart(gaps: readonly CueGap[], fromMs: number): number {
  let limit = Infinity
  for (const g of gaps) {
    const s = ms(g.start)
    if (s >= fromMs && s < limit) limit = s
  }
  return limit
}

/** The last refused span that ends at or before `beforeMs`, as a time limit. */
function previousGapEnd(gaps: readonly CueGap[], beforeMs: number): number {
  let limit = 0
  for (const g of gaps) {
    const e = ms(g.end)
    if (e <= beforeMs && e > limit) limit = e
  }
  return limit
}

/**
 * The cues of a merged word stream (`offsets.mergeByOffset`), on the file's clock. `durationSeconds` is
 * the container's; `startSeconds` is where these words' part begins, so no cue reaches back into the
 * part before it; `gaps` are the spans the run refused. Every word lands in exactly one cue, in order.
 * A cue that cannot be given one grid step on screen without breaking a rule is kept as it is and
 * passed to `onConflict`.
 */
export function buildCues(
  words: readonly GlobalWord[],
  options: { durationSeconds: number; startSeconds?: number; gaps?: readonly CueGap[]; rules?: CueRules; onConflict?: (cue: SrtCue) => void }
): SrtCue[] {
  const rules = options.rules ?? STAGE_B_RULES
  const gaps = options.gaps ?? []
  const limit = ms(Math.max(0, options.durationSeconds))
  const from = Math.min(limit, ms(Math.max(0, options.startSeconds ?? 0)))
  const clamped = clampToDuration(words, options.durationSeconds)
  const drafts: Draft[] = []
  for (const group of groupWords(clamped, gaps, rules)) {
    for (const cue of packGroup(group, rules)) {
      drafts.push({ words: cue, start: ms(cue[0].start), end: Math.max(...cue.map((w) => ms(w.end))) })
    }
  }
  // A word heard at the very edge of a refused span keeps its text but not the span: the cue stops at
  // the span's start, or begins at its end.
  for (const d of drafts) {
    for (const g of gaps) {
      if (!(ms(g.start) < d.end && ms(g.end) > d.start)) continue
      if (d.start < ms(g.start)) d.end = ms(g.start)
      else {
        d.start = Math.min(limit, ms(g.end))
        d.end = Math.max(d.end, d.start)
      }
    }
  }
  // The model's word times may overlap ("thanks" ending after "many" begins); a cue then stops where
  // the next one starts, so no two subtitles are on screen at once.
  for (let i = 0; i + 1 < drafts.length; i++) {
    if (drafts[i].end > drafts[i + 1].start) drafts[i].end = Math.max(drafts[i].start, drafts[i + 1].start)
  }

  // The floor. Forward first, toward the minimum, never past the next cue, the next refused span or
  // the end of the file; then backward toward the previous cue, the previous refused span or the start
  // of this part if that still leaves less than one grid step. If neither fits, the words join the
  // previous cue (or the next) where the joined cue still fits the line and duration rules; otherwise
  // they keep their own cue and take one grid step from the end of the previous cue or the start of
  // the next, where that one keeps a grid step of its own.
  const floor = ms(rules.floorSeconds)
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]
    const cap = Math.min(drafts[i + 1]?.start ?? Infinity, nextGapStart(gaps, d.start), limit)
    const want = d.start + ms(rules.minSeconds)
    if (d.end < want) d.end = Math.max(d.end, Math.min(want, cap))
    if (d.end - d.start >= floor) continue
    const back = Math.max(drafts[i - 1]?.end ?? from, previousGapEnd(gaps, d.start), from)
    d.start = Math.max(back, Math.min(d.start, d.end - floor))
  }
  const fits = (words: readonly GlobalWord[], start: number, end: number) => end - start <= ms(rules.maxSeconds) && layoutLines(words, rules) !== null
  const fused: Draft[] = []
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]
    if (d.end - d.start >= floor) {
      fused.push(d)
      continue
    }
    const prev = fused[fused.length - 1]
    const next = drafts[i + 1]
    const prevJoinable = prev && !gapBetween(gaps, prev.start, d.start)
    const nextJoinable = next && !gapBetween(gaps, d.start, next.start)
    if (prevJoinable && fits([...prev.words, ...d.words], prev.start, Math.max(prev.end, d.end))) {
      prev.words.push(...d.words)
      prev.end = Math.max(prev.end, d.end)
    } else if (nextJoinable && fits([...d.words, ...next.words], d.start, next.end)) {
      next.words.unshift(...d.words)
      next.start = d.start
    } else if (prevJoinable && d.end - floor >= prev.start + floor) {
      prev.end = Math.min(prev.end, d.end - floor)
      d.start = d.end - floor
      fused.push(d)
    } else if (nextJoinable && d.start + floor <= Math.min(next.end - floor, limit)) {
      d.end = d.start + floor
      next.start = Math.max(next.start, d.end)
      fused.push(d)
    } else {
      options.onConflict?.({ start: d.start / 1000, end: d.end / 1000, text: joinWords(d.words) })
      fused.push(d)
    }
  }

  return fused.map((d) => ({
    start: d.start / 1000,
    end: d.end / 1000,
    text: (layoutLines(d.words, rules) ?? [joinWords(d.words)]).join('\n')
  }))
}

/** True when no cue overlaps a refused span: invariant 6 as a check. */
export function bridgesNoGap(cues: readonly { start: number; end: number }[], gaps: readonly CueGap[]): boolean {
  return cues.every((c) => !gaps.some((g) => ms(g.start) < ms(c.end) && ms(g.end) > ms(c.start)))
}
