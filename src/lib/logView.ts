/**
 * What the run panel SHOWS, kept apart from how it is rendered and from React.
 *
 * Everything here is a pure function over a run's output, for two reasons. The obvious one is
 * that `npm run test:gates` can then exercise it directly, including the adversarial fixtures
 * that decide whether collapsing is safe. The important one is that collapsing a log is a
 * transform where the failure mode is *hiding a line the user needed* — an error swallowed into
 * a repeat counter is worse than any amount of repetition — so it deserves to be readable and
 * testable in isolation rather than buried in a hook that also owns subscriptions and timers.
 *
 * The invariant every rule below preserves: **no line is ever dropped from view.** Collapsing
 * only ever removes lines that are character-for-character identical to lines still on screen.
 * The one exception is the head+tail cap, which is explicit about it and says how many it hid.
 */

export type RunStatus = 'idle' | 'running' | 'done' | 'error' | 'stopped'

/**
 * A run of lines the engine emitted `count` times in a row.
 *
 * `count === 1` is the ordinary case: one line, shown once. Anything higher is a block the
 * engine redrew, and every one of its lines is still rendered — only the repetition is folded
 * into the counter.
 */
export interface LogBlock {
  kind: 'block'
  /**
   * Stable row identity. Assigned once and never reused, so React keys survive the head+tail
   * cap: after a trim, position *n* means a different row, and index keys would make every
   * surviving row re-render and lose its selection.
   */
  seq: number
  lines: string[]
  count: number
}

/** Stands in for the lines the cap removed from the middle, so their absence is visible. */
export interface LogGap {
  kind: 'gap'
  seq: number
  hiddenLines: number
}

export type LogRow = LogBlock | LogGap

/**
 * Longest repeat the doubling search will look for.
 *
 * The measured flood repeats an 11-line frame (REP-12), so 40 covers it several times over
 * while keeping the search cheap: it is bounded work per line regardless of how long the log
 * gets, since only the trailing lines are ever examined.
 */
export const MAX_DETECT_FRAME = 40

/**
 * Ceiling on a frame that grows.
 *
 * The engine reprints its whole message history on every streamed chunk, and that history gets
 * longer as the run goes on, so a frame is not a fixed thing — see `growFrame` below. Without a
 * ceiling a pathological run could fold its entire output into one block; with it, growth stops
 * and the log goes back to behaving like an ordinary list.
 */
export const MAX_FRAME = 200

/**
 * Retained rows, as head plus rolling tail.
 *
 * The start-up block — model, file, settings, the engine's own banner — is the most diagnostic
 * part of a log and is exactly what a plain "drop the oldest" cap destroys, so the head is kept
 * permanently and the middle is what goes. For scale: the tester's five-batch, 487-line
 * translation produced ~1,125 lines, so a real run never reaches this at all. Only a runaway
 * loop does, and with block collapsing in front of it even that mostly does not.
 */
export const HEAD_LINES = 200
export const TAIL_LINES = 1800

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function nextSeq(rows: readonly LogRow[]): number {
  return rows.length === 0 ? 0 : rows[rows.length - 1].seq + 1
}

function lineCount(row: LogRow): number {
  return row.kind === 'block' ? row.lines.length : 0
}

/**
 * The trailing run of not-yet-collapsed single lines, and the repeated block in front of it.
 *
 * Rows after the last repeated block are always single-line, count-1 blocks: collapsing is the
 * only thing that makes a block wider or its count higher, and it deletes the singles it
 * consumes. The scan is bounded so this stays O(1) per line on a log of any length.
 */
function tailView(rows: readonly LogRow[]): { start: number; tail: string[]; anchor: LogBlock | null } {
  let start = rows.length
  const limit = Math.max(0, rows.length - 2 * MAX_FRAME)
  while (start > limit) {
    const r = rows[start - 1]
    if (r.kind !== 'block' || r.count !== 1 || r.lines.length !== 1) break
    start--
  }
  const tail: string[] = []
  for (let i = start; i < rows.length; i++) tail.push((rows[i] as LogBlock).lines[0])
  const before = start > 0 ? rows[start - 1] : null
  const anchor = before && before.kind === 'block' && before.count >= 2 ? before : null
  return { start, tail, anchor }
}

/**
 * Fold one arrived line into the rows the panel will show.
 *
 * Three rules, in order, plus `coalesceAt` behind them. Each one only ever replaces lines with
 * identical lines already on screen, which is what keeps the "nothing is hidden" invariant true:
 *
 * 1. **Another repeat.** The trailing singles are exactly the block in front of them, so the
 *    engine has redrawn it: bump the counter and drop the duplicates.
 * 2. **The frame grew.** The trailing singles END with a fresh copy of that block, which means
 *    the lines in front of that copy were appended to the engine's message history and belong
 *    to the frame. Widen the frame by exactly those lines and leave the fresh copy alone, so
 *    the next repeat still lines up — absorbing it here instead would put the block half a
 *    cycle out of phase and stop it matching ever again.
 * 3. **A new repeat.** The smallest L in 1..40 whose last L lines equal the L before them.
 *    Smallest, so `A B A B` is read as `A B` twice rather than as one four-line block, and
 *    exact equality throughout, so a progress line whose number changes never collapses.
 *
 * A frame that recurs after something else intervened is a new occurrence with its own row, and
 * the counter is deliberately not "how many times this text appeared in the run" — it is how
 * many times this block was drawn consecutively.
 */
export function appendLogLine(rows: readonly LogRow[], line: string): LogRow[] {
  const grown: LogRow[] = [...rows, { kind: 'block', seq: nextSeq(rows), lines: [line], count: 1 }]
  return capRows(collapseTail(grown))
}

/**
 * Merge the block at `at` into the one before it when they hold the same lines.
 *
 * Needed because a frame can be found out of phase. The engine's history often contains an
 * internal repeat of its own — three messages per retry, accumulated — so the smallest-frame
 * search legitimately locks onto the inner repeat while a full draw is a different length; the
 * frames it then finds are right but rotated, and each lands as its own row. A measured
 * five-retry storm produced sixty adjacent, identical eight-line blocks that way. Two identical
 * blocks with nothing between them are one block drawn more times, so this says so.
 *
 * Blocks separated by anything else are left alone: a frame that recurs after something
 * intervened is a new occurrence and keeps its own row.
 */
function coalesceAt(rows: LogRow[], at: number): LogRow[] {
  let out = rows
  let i = at
  while (i > 0 && i < out.length) {
    const before = out[i - 1]
    const here = out[i]
    if (before.kind !== 'block' || here.kind !== 'block' || !sameLines(before.lines, here.lines)) break
    out = [...out.slice(0, i - 1), { ...before, count: before.count + here.count }, ...out.slice(i + 1)]
    i--
  }
  return out
}

function collapseTail(rows: LogRow[]): LogRow[] {
  const { start, tail, anchor } = tailView(rows)
  if (!anchor && tail.length < 2) return rows

  if (anchor) {
    const frame = anchor.lines
    // 1. the block, drawn once more
    if (tail.length === frame.length && sameLines(tail, frame)) {
      const next = [...rows.slice(0, start - 1), { ...anchor, count: anchor.count + 1 }]
      return coalesceAt(next, next.length - 1)
    }
    // 2. the same block with newer messages appended in front of a fresh copy of it
    if (tail.length > frame.length && sameLines(tail.slice(tail.length - frame.length), frame)) {
      const extra = tail.slice(0, tail.length - frame.length)
      if (frame.length + extra.length <= MAX_FRAME) {
        const next = [
          ...rows.slice(0, start - 1),
          { ...anchor, lines: [...frame, ...extra] },
          ...rows.slice(start + extra.length)
        ]
        // A widened frame can land next to an identical one, which is exactly how the sixty
        // duplicate blocks were produced, so the merge is checked at the block's own position
        // rather than at the end of the array.
        return coalesceAt(next, start - 1)
      }
    }
  }

  // 3. a frame that has just doubled
  for (let l = 1; l <= MAX_DETECT_FRAME && 2 * l <= tail.length; l++) {
    const last = tail.slice(tail.length - l)
    const prev = tail.slice(tail.length - 2 * l, tail.length - l)
    if (sameLines(last, prev)) {
      const from = rows.length - 2 * l
      const next: LogRow[] = [
        ...rows.slice(0, from),
        { kind: 'block', seq: rows[from].seq, lines: last, count: 2 }
      ]
      return coalesceAt(next, next.length - 1)
    }
  }
  return rows
}

/**
 * Keep the head and a rolling tail, and say how much of the middle went.
 *
 * Blocks are dropped whole rather than split, because half a repeated block with a counter that
 * still claims the full count would be a lie about what was on screen.
 */
export function capRows(rows: readonly LogRow[]): LogRow[] {
  let total = 0
  for (const r of rows) total += lineCount(r)
  if (total <= HEAD_LINES + TAIL_LINES) return rows as LogRow[]

  let head = 0
  let headLines = 0
  // Stops at an existing gap, which is not part of the head: a gap costs no lines, so walking
  // past it would leave it stranded above the new one and mint a fresh marker on every line
  // once the cap engages. Ending here means the old gap falls inside the dropped middle and is
  // absorbed, which is why there is only ever one.
  while (head < rows.length && rows[head].kind === 'block' && headLines + lineCount(rows[head]) <= HEAD_LINES) {
    headLines += lineCount(rows[head])
    head++
  }
  let tail = rows.length
  let tailLines = 0
  // Same reason as the head, from the other end: the tail stops at the old gap rather than
  // swallowing it, so the gap is always in the middle and always absorbed into its replacement.
  while (tail > head && rows[tail - 1].kind === 'block' && tailLines + lineCount(rows[tail - 1]) <= TAIL_LINES) {
    tailLines += lineCount(rows[tail - 1])
    tail--
  }
  if (tail <= head) return rows as LogRow[]

  let hidden = 0
  // An earlier gap keeps its identity, so the row the user is looking at does not jump.
  let seq = rows[head].seq
  for (let i = head; i < tail; i++) {
    const r = rows[i]
    if (r.kind === 'gap') {
      hidden += r.hiddenLines
      seq = r.seq
    } else {
      hidden += r.lines.length
    }
  }
  return [...rows.slice(0, head), { kind: 'gap', seq, hiddenLines: hidden }, ...rows.slice(tail)]
}

export interface RetryState {
  from: number
  to: number
}

/**
 * True while that retry is still the run's present, and false once it has moved past it.
 *
 * Strictly less-than, so a batch whose end the progress counter has reached is finished: a
 * notice that outlived the retry it describes would turn a recovered run back into an alarming
 * one, which is the whole complaint MAN-8 and REP-12 came from.
 */
export function retryIsCurrent(retry: RetryState | null, currentLine: number): boolean {
  return retry !== null && currentLine < retry.to
}
