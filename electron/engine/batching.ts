/**
 * Native translation: the batches, and the accepted map that lives between them
 * (implementation_plan.md Step 2.5). AUTHORED-BY: opus-5.5-high
 *
 * Read from gst 3.7.0's translate loop (`main.py:697-910`), which is what 1.1.0 ships:
 *
 *  - cues are taken in order, `batch_size` at a time (`:825-849`); 1.1.0 passes the Settings value as
 *    `-b` (`pythonBridge.ts:481`);
 *  - with an audio file, a batch also ends before the cue that would take its audio past
 *    `audio_chunk_size`, 300 s, which 1.1.0 never changes (`main.py:94,827-849`). Whole seconds, as
 *    gst measures them (`timedelta.seconds`);
 *  - the batch before the current one is the context (`:1394-1407`).
 *
 * Two differences, each an enhancement. gst kept a cue that overran the audio cap when it filled the
 * batch or ended the file, and a single cue longer than the cap emptied its batch; here the cap holds
 * for every batch, and a cue that alone overruns it is sent alone. And the audio cut covers the whole
 * of the batch's last cue rather than stopping at its whole-second floor.
 *
 * Nothing is accepted except a whole batch that passed `validateExactPermutation`. A batch that fails
 * leaves the map exactly as it was. This file formats no prompt and opens no file.
 */
import type { Cue } from './srt'
import type { TranslationContext } from './prompt'
import { TranslationState, requestedLines, type PreservationReason, type RecoveryTree, type RestoredRow } from './translationState'
import { validateReply, type ReplyFailure, type ValidatedBatch } from './validateTranslationBatch'

/** gst 3.7.0's `audio_chunk_size` (`main.py:94`); 1.1.0 never passes another. */
export const TRANSLATE_AUDIO_CHUNK_SECONDS = 300

export interface TranslationBatch {
  /** One-based. */
  readonly index: number
  readonly total: number
  /** Contiguous source cues, in order. */
  readonly cues: readonly Cue[]
}

const wholeSeconds = (ms: number): number => Math.floor(ms / 1000)

/**
 * The run's batches. `mediaSeconds` is the audio cap, given exactly when the run attaches audio: a
 * cue joins a batch only while the batch's audio, from its first cue's start to the latest end of any
 * of its cues in whole seconds, stays under it. That is the span `batchMediaSpan` cuts, so a cue that
 * ends inside an earlier, longer cue cannot join a batch that is already over the cap.
 */
export function planBatches(cues: readonly Cue[], batchSize: number, opts: { mediaSeconds?: number | null } = {}): TranslationBatch[] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError(`A batch size is a whole number of lines; got ${batchSize}.`)
  const cap = opts.mediaSeconds ?? null
  if (cap !== null && !(cap > 0)) throw new TypeError(`An audio cap is a positive number of seconds; got ${cap}.`)
  const runs: Cue[][] = []
  let current: Cue[] = []
  let latestEndMs = 0
  for (const cue of cues) {
    const fits =
      current.length === 0 ||
      (current.length < batchSize &&
        (cap === null || wholeSeconds(Math.max(latestEndMs, cue.endMs)) - wholeSeconds(current[0].startMs) < cap))
    if (!fits) {
      runs.push(current)
      current = []
    }
    latestEndMs = current.length === 0 ? cue.endMs : Math.max(latestEndMs, cue.endMs)
    current.push(cue)
  }
  if (current.length) runs.push(current)
  return runs.map((run, i) => Object.freeze({ index: i + 1, total: runs.length, cues: Object.freeze(run) }))
}

/**
 * A user-requested retry of one failed section (AR3-7): cues `fromCue..toCue`, in order, `size` at a
 * time — fixed pieces, never re-planned. The section was one batch, so every piece fits its audio.
 */
export function retryPieces(cues: readonly Cue[], fromCue: number, toCue: number, size: number): TranslationBatch[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new TypeError(`A retry size is a whole number of lines; got ${size}.`)
  const span = cues.filter((c) => c.index >= fromCue && c.index <= toCue)
  if (span.length === 0 || span.length !== toCue - fromCue + 1) throw new RangeError(`Cues ${fromCue}\u2013${toCue} are not a stretch of the source.`)
  const runs: Cue[][] = []
  for (let i = 0; i < span.length; i += size) runs.push(span.slice(i, i + size))
  return runs.map((run, i) => Object.freeze({ index: i + 1, total: runs.length, cues: Object.freeze(run) }))
}

/**
 * The audio a batch is sent with. It starts at the whole second its times are measured from (the
 * `offset` of gst's relative `time_start`/`time_end`, `main.py:833-841`), so a cue's time in the
 * request is its time in the clip, and it ends after the batch's last sound.
 */
export function batchMediaSpan(batch: TranslationBatch): { startSeconds: number; endSeconds: number } {
  const first = batch.cues[0]
  if (!first) throw new TypeError('An empty batch has no audio.')
  const lastEndMs = Math.max(...batch.cues.map((c) => c.endMs))
  return { startSeconds: wholeSeconds(first.startMs), endSeconds: Math.max(wholeSeconds(first.startMs), Math.ceil(lastEndMs / 1000)) }
}

export type PublishResult = { ok: true } | { ok: false; failure: ReplyFailure }

/**
 * The run's committed translations. Batches are published one at a time, each whole or not at all,
 * and the context for a batch is read only from what is already committed.
 */
export class CommittedTranslations {
  private readonly state: TranslationState

  constructor(readonly source: readonly Cue[]) {
    this.state = new TranslationState(source)
  }

  get acceptedCount(): number {
    return this.state.acceptedCount
  }

  get complete(): boolean {
    return this.state.complete
  }

  /** A copy of the committed map, by cue number. */
  get accepted(): ReadonlyMap<number, string> {
    return this.state.acceptedTranslations
  }

  /** The 0-based source positions committed so far: `selectSourceBatchContext`'s committed-accepted set. */
  acceptedPositions(): ReadonlySet<number> {
    const accepted = this.state.acceptedTranslations
    const positions = new Set<number>()
    this.source.forEach((cue, p) => {
      if (accepted.has(cue.index)) positions.add(p)
    })
    return positions
  }

  /** Continue: the verified prefix, cues `1..rows.length`, each with its provenance (`TranslationState.restore`). */
  restore(rows: readonly RestoredRow[]): void {
    this.state.restore(rows)
  }

  /**
   * The first Continue's pair (F15-P4): the accepted cues among the `size` cues immediately before cue
   * `before`, as a D6-9 accepted pair. Null for size 0, nothing before it, or none of them accepted.
   * Throws if one is not committed.
   */
  resumePair(before: number, size: number): TranslationContext | null {
    const from = Math.max(1, before - size)
    if (size <= 0 || from >= before) return null
    return this.acceptedPair(from, before - 1)
  }

  /**
   * The accepted cues of `from..to` and the committed map, as a D6-9 accepted pair: a failed request's
   * checkpointed pair, rebuilt for its retry pieces (AR3-7). A preserved cue is skipped and not
   * backfilled (PR-3), so the pair is strictly ascending; all preserved is no pair. Throws if a cue is
   * neither accepted nor preserved.
   */
  acceptedPair(from: number, to: number): TranslationContext | null {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > this.source.length) {
      throw new RangeError(`Cues ${from}\u2013${to} are not a stretch of the source.`)
    }
    const accepted = this.state.acceptedTranslations
    const cues: Cue[] = []
    for (const cue of this.source.slice(from - 1, to)) {
      if (accepted.has(cue.index)) cues.push(cue)
      else if (!this.state.resolved(cue.index)) throw new Error(`Cue ${cue.index} of the context is not committed.`)
    }
    return cues.length ? Object.freeze({ cues: Object.freeze(cues), accepted }) : null
  }

  /** Validate the reply text against exactly this batch and, only if it passes, commit all of it. */
  publish(batch: TranslationBatch, replyText: string): PublishResult {
    const checked = validateReply(requestedLines(batch.cues), replyText)
    if (!checked.ok) return { ok: false, failure: checked.failure }
    this.state.stage(checked.batch)
    return { ok: true }
  }

  /** Cues accepted or preserved: the resolved prefix a record and the progress count. */
  get resolvedCount(): number {
    return this.state.acceptedCount + this.state.preservedCount
  }

  /** The cues kept in their source language, in order, each with its reason (`null`: restored by Continue). */
  preservedLines(): Array<{ index: number; reason: PreservationReason | null }> {
    return this.state.preservedCues().map((p) => ({ index: p.index, reason: p.reason }))
  }

  /** Bundle G: a private recovery tree over one batch's cues (`TranslationState.openTree`). */
  openTree(batch: TranslationBatch): RecoveryTree {
    const first = batch.cues[0]
    if (!first) throw new TypeError('An empty batch has no recovery tree.')
    return this.state.openTree(first.index, batch.cues[batch.cues.length - 1].index)
  }

  /** A refused reply's trusted entries (`ReplyFailure.inHand`), staged in the tree. */
  stageInHand(tree: RecoveryTree, inHand: ValidatedBatch): void {
    this.state.stageInTree(tree, inHand)
  }

  /**
   * Validate a tree request's reply against exactly its cues. A usable reply is staged in the tree
   * whole; a reply with lines missing stages the entries in hand it can trust and still fails.
   */
  publishInTree(tree: RecoveryTree, cues: readonly Cue[], replyText: string): PublishResult {
    const checked = validateReply(requestedLines(cues), replyText)
    if (checked.ok) {
      this.state.stageInTree(tree, checked.batch)
      return { ok: true }
    }
    if (checked.failure.shape === 'MissingIndices' && checked.failure.inHand) this.state.stageInTree(tree, checked.failure.inHand)
    return { ok: false, failure: checked.failure }
  }

  preserveInTree(tree: RecoveryTree, cue: number, reason: PreservationReason): void {
    this.state.preserveInTree(tree, cue, reason)
  }

  /** Whether a cue of the tree is staged or preserved in it. */
  resolvedInTree(tree: RecoveryTree, cue: number): boolean {
    return tree.stagedAccepted().has(cue) || tree.preservedCues().has(cue)
  }

  /** The whole tree at once, every cue of the batch staged or preserved (`TranslationState.commitTree`). */
  commitTree(tree: RecoveryTree): void {
    this.state.commitTree(tree)
  }

  discardTree(tree: RecoveryTree): void {
    this.state.discardTree(tree)
  }

  /** Every source cue: its committed translation, or its source text while it has none (gst `main.py:680`). */
  snapshotCues(): Cue[] {
    const accepted = this.state.acceptedTranslations
    return this.source.map((cue) => (accepted.has(cue.index) ? { ...cue, text: accepted.get(cue.index)! } : { ...cue }))
  }

  /** The finished translation. Throws unless every cue is committed. */
  outputCues(): Cue[] {
    if (!this.state.complete) {
      throw new Error(`${this.source.length - this.state.acceptedCount - this.state.preservedCount} of ${this.source.length} cues are not translated.`)
    }
    return this.state.allCues()
  }
}

// ── Bundle F: the exact request and the run's partitions (implementation_plan.md §12.7 points 7–8) ──

/**
 * A request's identity: recursively sorted object keys, array order kept, `undefined` omitted,
 * ordinary JSON escaping. Collision-free for JSON data. A non-finite number cannot be sent, so it is
 * refused. In memory only: never persisted, logged or hashed into a report.
 */
export function canonicalRequest(value: unknown): string {
  const walk = (v: unknown): string => {
    if (v === null) return 'null'
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return JSON.stringify(v)
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError('A request cannot carry a non-finite number.')
        return JSON.stringify(v)
      case 'object': {
        if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : walk(x))).join(',')}]`
        const o = v as Record<string, unknown>
        const keys = Object.keys(o)
          .filter((k) => o[k] !== undefined)
          .sort()
        return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(o[k])}`).join(',')}}`
      }
      default:
        throw new TypeError(`A request cannot carry a ${typeof v}.`)
    }
  }
  return walk(value)
}

export type PartitionStatus = 'queued' | 'reserved' | 'inFlight' | 'accepted'
export type PartitionReason = 'saved' | 'countedInputLimit' | 'providerInputLimit'

export interface TranslationPartition {
  readonly fromCue: number
  readonly toCue: number
  readonly requestedLineCount: number
  readonly effectiveLineCount: number
  readonly status: PartitionStatus
  readonly reason: PartitionReason
}

/**
 * Which cues each request covers, in order, and where each stands. Versioned: every change returns a
 * state one version later, and a change computed against another version is refused as stale. Only a
 * contiguous run of `queued` partitions at the tail may be replaced; `reserved`, `inFlight` and
 * `accepted` ones never change. The line ceiling never rises. In memory only.
 */
export interface TranslationPartitionState {
  readonly version: number
  readonly savedBatchSize: number
  readonly effectiveLineCeiling: number
  readonly partitions: readonly TranslationPartition[]
}

export type PartitionChange = { ok: true; state: TranslationPartitionState } | { ok: false; reason: 'stale' | 'unknown' | 'immutable' | 'invalid' }

function frozenPartitions(s: TranslationPartitionState): TranslationPartitionState {
  return Object.freeze({ ...s, partitions: Object.freeze(s.partitions.map((p) => Object.freeze({ ...p }))) })
}

export function createPartitionState(batches: readonly TranslationBatch[], savedBatchSize: number): TranslationPartitionState {
  return frozenPartitions({
    version: 0,
    savedBatchSize,
    effectiveLineCeiling: savedBatchSize,
    partitions: batches.map((b) => ({
      fromCue: b.cues[0].index,
      toCue: b.cues[b.cues.length - 1].index,
      requestedLineCount: savedBatchSize,
      effectiveLineCount: b.cues.length,
      status: 'queued',
      reason: 'saved'
    }))
  })
}

const PARTITION_STEP: Record<'reserve' | 'inFlight' | 'accept', { from: PartitionStatus; to: PartitionStatus }> = {
  reserve: { from: 'queued', to: 'reserved' },
  inFlight: { from: 'reserved', to: 'inFlight' },
  accept: { from: 'inFlight', to: 'accepted' }
}

function advancePartition(step: keyof typeof PARTITION_STEP, state: TranslationPartitionState, version: number, fromCue: number): PartitionChange {
  if (version !== state.version) return { ok: false, reason: 'stale' }
  const i = state.partitions.findIndex((p) => p.fromCue === fromCue)
  if (i < 0) return { ok: false, reason: 'unknown' }
  if (state.partitions[i].status !== PARTITION_STEP[step].from) return { ok: false, reason: 'immutable' }
  const partitions = [...state.partitions]
  partitions[i] = { ...partitions[i], status: PARTITION_STEP[step].to }
  return { ok: true, state: frozenPartitions({ ...state, version: state.version + 1, partitions }) }
}

export const reservePartition = (s: TranslationPartitionState, version: number, fromCue: number): PartitionChange => advancePartition('reserve', s, version, fromCue)
export const markPartitionInFlight = (s: TranslationPartitionState, version: number, fromCue: number): PartitionChange =>
  advancePartition('inFlight', s, version, fromCue)
export const acceptPartition = (s: TranslationPartitionState, version: number, fromCue: number): PartitionChange => advancePartition('accept', s, version, fromCue)

/**
 * Replace the queued partitions from `fromCue` to the end with `ranges`, which must cover exactly the
 * same cues in order. `ceiling` is the counted-safe line count that caused it; the run's ceiling
 * becomes the smaller of the two and never rises.
 */
export function repartitionTail(
  state: TranslationPartitionState,
  version: number,
  change: { fromCue: number; ranges: ReadonlyArray<{ fromCue: number; toCue: number }>; ceiling: number; reason: Exclude<PartitionReason, 'saved'> }
): PartitionChange {
  if (version !== state.version) return { ok: false, reason: 'stale' }
  const at = state.partitions.findIndex((p) => p.fromCue === change.fromCue)
  if (at < 0) return { ok: false, reason: 'unknown' }
  const replaced = state.partitions.slice(at)
  if (replaced.some((p) => p.status !== 'queued')) return { ok: false, reason: 'immutable' }
  if (!Number.isSafeInteger(change.ceiling) || change.ceiling < 1 || change.ranges.length === 0) return { ok: false, reason: 'invalid' }
  let expect = change.fromCue
  for (const r of change.ranges) {
    if (r.fromCue !== expect || r.toCue < r.fromCue || r.toCue - r.fromCue + 1 > change.ceiling) return { ok: false, reason: 'invalid' }
    expect = r.toCue + 1
  }
  if (expect !== replaced[replaced.length - 1].toCue + 1) return { ok: false, reason: 'invalid' }
  return {
    ok: true,
    state: frozenPartitions({
      ...state,
      version: state.version + 1,
      effectiveLineCeiling: Math.min(state.effectiveLineCeiling, change.ceiling),
      partitions: [
        ...state.partitions.slice(0, at),
        ...change.ranges.map((r) => ({
          fromCue: r.fromCue,
          toCue: r.toCue,
          requestedLineCount: state.savedBatchSize,
          effectiveLineCount: r.toCue - r.fromCue + 1,
          status: 'queued' as const,
          reason: change.reason
        }))
      ]
    })
  }
}

/**
 * The queue from `batches[at]` on, re-cut so the first request is its counted-safe `head` lines and
 * the rest of the cues follow at most `head` lines a request (and under the audio cap). Numbering
 * continues from `batches[at].index`; every batch carries the new total.
 */
export function resizedQueue(batches: readonly TranslationBatch[], at: number, head: number, opts: { mediaSeconds?: number | null } = {}): TranslationBatch[] {
  const first = batches[at]
  if (!first || !Number.isSafeInteger(head) || head < 1 || head >= first.cues.length) throw new RangeError('A resize keeps a non-empty, smaller head.')
  const rest = [...first.cues.slice(head), ...batches.slice(at + 1).flatMap((b) => b.cues)]
  const runs = [first.cues.slice(0, head), ...planBatches(rest, head, opts).map((b) => b.cues)]
  const total = first.index - 1 + runs.length
  return runs.map((cues, i) => Object.freeze({ index: first.index + i, total, cues: Object.freeze([...cues]) }))
}
