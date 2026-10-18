/**
 * Read with repair (Round 8A, `implementation_plan.md` §9.4c R5). A side whose only structural problems
 * are subtitles out of time order and subtitles that end when or before they start, on at most 1 cue in
 * 10, is analysed on a tidied view: a stable sort by start (ties keep file order), renumbered 1…n, and a
 * cue that ends at or before its start given `start + 2 ms` in the view only. The written result is the
 * file's own cues, in file order, with only their times changed, and check W proves it carries no defect
 * the source did not already have.
 *
 * The counted set is exactly what `align.ts` `preflightIssues` flags, taken from its issue list and never
 * re-derived: `duration` when `end <= start`, `order` when a start is below the immediately previous
 * cue's start. `align.ts`'s own preflight is not relaxed; this module is used by `alignService.ts` only.
 * Pure: no clock, no I/O.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import { cueTimestamp, type Cue } from './srt'

export type RepairSide = 'source' | 'reference'

/** At most this fraction of a side's cues (floored) may be repaired. */
export const REPAIR_MAX_FRACTION = 0.1

/** What the disclosure says: counts of the two flagged kinds, from the same issue list. */
export interface RepairNote {
  side: RepairSide
  outOfOrder: number
  endAtOrBeforeStart: number
}

export interface CueRepair {
  note: RepairNote
  /** The analysis copy: stably sorted by start, renumbered 1…n, a repaired-duration cue 2 ms long. */
  view: Cue[]
  /** View position → file position (both 0-based). */
  toFile: number[]
  /** File cue numbers (1-based) `preflightIssues` flagged `order`. */
  order: ReadonlySet<number>
  /** File cue numbers (1-based) `preflightIssues` flagged `duration`. */
  duration: ReadonlySet<number>
}

export type RepairPlan =
  | { kind: 'clean' }
  /** `overBudget`: every issue was `order`/`duration`, only too many of them. */
  | { kind: 'refused'; overBudget: boolean }
  | { kind: 'repaired'; repair: CueRepair }

const ISSUE = /^(source|reference):([a-z_]+):(\d+)$/

/** The most cues a side of `cues` may have repaired. */
export function repairBudget(cues: number): number {
  return Math.floor(cues * REPAIR_MAX_FRACTION)
}

/**
 * `issues` is `preflightIssues`'s list (the other side's codes are ignored). Any issue kind other than
 * `order` or `duration` for this side, or more distinct flagged cues than the budget, refuses. The view
 * still has to pass `preflightIssues` itself; that check belongs to the caller, which owns `align.ts`.
 */
export function planRepair(side: RepairSide, cues: readonly Cue[], issues: readonly string[]): RepairPlan {
  const mine = issues.filter((i) => i.startsWith(`${side}:`))
  if (mine.length === 0) return { kind: 'clean' }
  const order = new Set<number>()
  const duration = new Set<number>()
  for (const issue of mine) {
    const m = ISSUE.exec(issue)
    const n = m ? Number(m[3]) : NaN
    if (!m || !(n >= 1 && n <= cues.length)) return { kind: 'refused', overBudget: false }
    if (m[2] === 'order') order.add(n)
    else if (m[2] === 'duration') duration.add(n)
    else return { kind: 'refused', overBudget: false }
  }
  const flagged = new Set([...order, ...duration]).size
  if (flagged > repairBudget(cues.length)) return { kind: 'refused', overBudget: true }

  const toFile = cues.map((_, i) => i).sort((a, b) => cues[a].startMs - cues[b].startMs || a - b)
  // 2 ms, not 1: under a slow-down a 1 ms cue can round to zero length and fail item 8; 2 ms stays ≥ 1.8 ms at scale 0.9.
  const view = toFile.map((f, v) => {
    const c = cues[f]
    return { index: v + 1, startMs: c.startMs, endMs: c.endMs > c.startMs ? c.endMs : c.startMs + 2, text: c.text }
  })
  return {
    kind: 'repaired',
    repair: { note: { side, outOfOrder: order.size, endAtOrBeforeStart: duration.size }, view, toFile, order, duration }
  }
}

/**
 * The file's own cues in file order with the analysis result's times: each cue's start is the result at
 * its view position. A cue in the `duration` set keeps exactly its own difference (zero stays zero, a
 * reversed cue stays reversed, whatever the speed); every other cue takes the analysis end.
 */
export function writeBack(file: readonly Cue[], repair: CueRepair, viewResult: readonly { startMs: number; endMs: number }[]): Cue[] {
  const out: Cue[] = file.map((c) => ({ ...c }))
  repair.toFile.forEach((f, v) => {
    const c = file[f]
    const startMs = viewResult[v].startMs
    const endMs = repair.duration.has(f + 1) ? startMs + (c.endMs - c.startMs) : viewResult[v].endMs
    out[f] = { index: c.index, startMs, endMs, text: c.text }
  })
  return out
}

function writable(ms: number): boolean {
  if (!Number.isSafeInteger(ms) || ms < 0) return false
  try {
    cueTimestamp(ms)
    return true
  } catch {
    return false
  }
}

/** Per cue: true where it starts before an earlier cue has ended (`align.ts` `overlapCount`'s test). */
function overlaps(cues: readonly Cue[]): boolean[] {
  let maxEnd = -Infinity
  return cues.map((c) => {
    const hit = c.startMs < maxEnd
    maxEnd = Math.max(maxEnd, c.endMs)
    return hit
  })
}

/**
 * Check W, on the file-order times before they are written and again on the read-back. The only defects
 * the written file may carry are the source's own `order` and `duration` defects, on the same cues, with
 * the same durations. Each failure is a `written:<rule>:<cue number>` code:
 * - `identity` (W1) count, numbering or text differ from the source file;
 * - `time` (W2) a start or end SubRip cannot write;
 * - `duration` (W3) a cue outside the original `duration` set that ends at or before its start, or one
 *   inside it whose difference changed;
 * - `order` (W4) a start below the previous start on a cue not flagged `order` in the source;
 * - `overlap` (W5) more overlaps than the source; the number is the first cue that overlaps in the written
 *   file and not in the source.
 */
export function checkWritten(file: readonly Cue[], repair: Pick<CueRepair, 'order' | 'duration'>, written: readonly Cue[]): string[] {
  if (written.length !== file.length) return [`written:identity:${Math.min(written.length, file.length) + 1}`]
  const issues: string[] = []
  written.forEach((c, i) => {
    const n = i + 1
    if (c.index !== file[i].index || c.text !== file[i].text) issues.push(`written:identity:${n}`)
    if (!writable(c.startMs) || !writable(c.endMs)) issues.push(`written:time:${n}`)
    const kept = repair.duration.has(n) ? c.endMs - c.startMs === file[i].endMs - file[i].startMs : c.endMs > c.startMs
    if (!kept) issues.push(`written:duration:${n}`)
    if (i > 0 && c.startMs < written[i - 1].startMs && !repair.order.has(n)) issues.push(`written:order:${n}`)
  })
  const before = overlaps(file)
  const after = overlaps(written)
  if (after.filter(Boolean).length > before.filter(Boolean).length) {
    const first = after.findIndex((hit, i) => hit && !before[i])
    issues.push(`written:overlap:${(first < 0 ? after.lastIndexOf(true) : first) + 1}`)
  }
  return issues
}
