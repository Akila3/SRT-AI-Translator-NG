/**
 * What a translation run has accepted (implementation_plan.md Step 2.2). AUTHORED-BY: opus-5.5-high
 *
 * `acceptedTranslations` maps a cue's index to its accepted translation. Nothing is put in it except
 * a whole batch that `validateExactPermutation` passed, so a duplicate in a reply is caught on the
 * raw sequence before a map could erase it. A batch is staged all at once or not at all, and a cue
 * is never overwritten. Timing is never read from a reply: every cue out of here carries its
 * source's start and end.
 *
 * Bundle G (D6-9, §17.8R): a cue may instead be PRESERVED — kept in its source language with a typed
 * reason. A recovery tree stages privately and reaches this state only through `commitTree`, which
 * takes the whole tree or nothing: every cue of its span exactly once, accepted or preserved.
 */
import type { PreservationReason } from '../shared/engineEvents'
import type { Cue } from './srt'
import { cueNumberOfWire, isValidatedBatch, type RequestedLine, type ValidatedBatch } from './validateTranslationBatch'

export type { PreservationReason }

export const PRESERVATION_REASONS: readonly PreservationReason[] = Object.freeze(['CONTENT_BLOCKED', 'REASON_ABSENT', 'UNPARSEABLE_REPLY', 'BUDGET_FLOOR'])

const CONTEXT_ELIGIBLE: Readonly<Record<PreservationReason, boolean>> = Object.freeze({
  CONTENT_BLOCKED: false,
  REASON_ABSENT: false,
  UNPARSEABLE_REPLY: false,
  BUDGET_FLOOR: false
})

/**
 * D6-9(c): whether a preserved cue's source may be carried as context. Total, and false for every
 * reason: a content block's source is the very text the filter refused (N13), and the other three
 * do not say why. `null` (a cue restored by Continue, reason not recorded) and anything not
 * enumerated are false too.
 */
export function contextEligible(reason: PreservationReason | null | undefined): boolean {
  return reason != null && Object.prototype.hasOwnProperty.call(CONTEXT_ELIGIBLE, reason) && CONTEXT_ELIGIBLE[reason]
}

/**
 * Bundle G's recovery output: a source cue kept in its own language after a terminal block, with
 * its source timing (implementation_plan.md "How later Bundle G lives with that rule", rule 2).
 * `reason` is `null` only for a cue restored by Continue.
 */
export interface PreservedCue {
  readonly index: number
  readonly startMs: number
  readonly endMs: number
  readonly sourceText: string
  readonly reason: PreservationReason | null
  readonly contextEligible: boolean
}

/** One verified checkpoint row as Continue restores it (PR-3). A preserved row's text is its source. */
export interface RestoredRow {
  readonly text: string
  readonly provenance: 'accepted' | 'preserved'
}

/** The lines a batch of cues is sent as: wire index = position from 0 (gst `str(i)`), source text. */
export function requestedLines(cues: readonly Cue[]): RequestedLine[] {
  return cues.map((cue) => ({ index: cue.index - 1, text: cue.text }))
}

/**
 * One batch's recovery tree, private to the run until it commits. Its staged translations are
 * readable by nobody: a request inside the tree may learn only WHICH cues are staged (their status,
 * for the context window), never their text.
 */
export interface RecoveryTree {
  readonly fromCue: number
  readonly toCue: number
  /** Cue numbers staged as accepted in this tree. Status only. */
  stagedAccepted(): ReadonlySet<number>
  /** Cue numbers preserved in this tree. */
  preservedCues(): ReadonlySet<number>
  /** Cues of the span neither staged nor preserved yet. */
  readonly unresolved: number
}

interface TreeInternals {
  readonly owner: TranslationState
  readonly staged: Map<number, string>
  readonly kept: Map<number, PreservationReason>
  closed: boolean
}

const trees = new WeakMap<RecoveryTree, TreeInternals>()

export class TranslationState {
  private readonly accepted = new Map<number, string>()
  private readonly preserved = new Map<number, PreservationReason | null>()

  constructor(readonly source: readonly Cue[]) {
    source.forEach((cue, i) => {
      if (cue.index !== i + 1) throw new TypeError(`source cue ${i + 1} carries number ${cue.index}`)
    })
  }

  /** A copy: the run's accepted state is changed only by `stage`, `commitTree` and `restore`. */
  get acceptedTranslations(): ReadonlyMap<number, string> {
    return new Map(this.accepted)
  }

  get acceptedCount(): number {
    return this.accepted.size
  }

  get preservedCount(): number {
    return this.preserved.size
  }

  /** Every cue is accepted or preserved. */
  get complete(): boolean {
    return this.accepted.size + this.preserved.size === this.source.length
  }

  /** Whether a cue is accepted or preserved: it may never be staged again. */
  resolved(cue: number): boolean {
    return this.accepted.has(cue) || this.preserved.has(cue)
  }

  private assertOpen(cue: number): void {
    if (!Number.isSafeInteger(cue) || cue < 1 || cue > this.source.length) throw new RangeError(`cue ${cue} is not in the source`)
    if (this.accepted.has(cue)) throw new Error(`cue ${cue} was already accepted`)
    if (this.preserved.has(cue)) throw new Error(`cue ${cue} was already preserved`)
  }

  /**
   * Accept a validated batch. Throws, staging nothing, for anything else: a batch this run did not
   * validate, a cue outside the source, or a cue already accepted or preserved.
   */
  stage(batch: ValidatedBatch): void {
    if (!isValidatedBatch(batch)) throw new TypeError('only a batch validateExactPermutation passed can be staged')
    const incoming = batch.entries.map((e) => ({ cue: cueNumberOfWire(e.index), text: e.text }))
    for (const { cue } of incoming) this.assertOpen(cue)
    for (const { cue, text } of incoming) this.accepted.set(cue, text)
  }

  /** Open a private recovery tree over cues `fromCue..toCue`, none of them resolved yet. */
  openTree(fromCue: number, toCue: number): RecoveryTree {
    if (!Number.isSafeInteger(fromCue) || !Number.isSafeInteger(toCue) || toCue < fromCue) throw new RangeError(`Cues ${fromCue}\u2013${toCue} are not a stretch of the source.`)
    for (let c = fromCue; c <= toCue; c++) this.assertOpen(c)
    const internals: TreeInternals = { owner: this, staged: new Map(), kept: new Map(), closed: false }
    const tree: RecoveryTree = Object.freeze({
      fromCue,
      toCue,
      stagedAccepted: () => new Set(internals.staged.keys()),
      preservedCues: () => new Set(internals.kept.keys()),
      get unresolved() {
        return toCue - fromCue + 1 - internals.staged.size - internals.kept.size
      }
    })
    trees.set(tree, internals)
    return tree
  }

  private internalsOf(tree: RecoveryTree): TreeInternals {
    const t = trees.get(tree)
    if (!t || t.owner !== this) throw new TypeError('This recovery tree was not opened on this run.')
    if (t.closed) throw new Error('This recovery tree is already closed.')
    return t
  }

  private assertInTree(tree: RecoveryTree, t: TreeInternals, cue: number): void {
    if (!Number.isSafeInteger(cue) || cue < tree.fromCue || cue > tree.toCue) throw new RangeError(`cue ${cue} is not in this tree's cues ${tree.fromCue}\u2013${tree.toCue}`)
    if (t.staged.has(cue)) throw new Error(`cue ${cue} is already staged in this tree`)
    if (t.kept.has(cue)) throw new Error(`cue ${cue} is already preserved in this tree`)
    this.assertOpen(cue)
  }

  /** Stage a validated batch (or a reply's valid entries) inside the tree. All or nothing. */
  stageInTree(tree: RecoveryTree, batch: ValidatedBatch): void {
    const t = this.internalsOf(tree)
    if (!isValidatedBatch(batch)) throw new TypeError('only a batch validateExactPermutation passed can be staged')
    const incoming = batch.entries.map((e) => ({ cue: cueNumberOfWire(e.index), text: e.text }))
    const seen = new Set<number>()
    for (const { cue } of incoming) {
      if (seen.has(cue)) throw new Error(`cue ${cue} is twice in one staged batch`)
      seen.add(cue)
      this.assertInTree(tree, t, cue)
    }
    for (const { cue, text } of incoming) t.staged.set(cue, text)
  }

  /** Preserve one cue of the tree in its source language, with its reason. */
  preserveInTree(tree: RecoveryTree, cue: number, reason: PreservationReason): void {
    const t = this.internalsOf(tree)
    if (!PRESERVATION_REASONS.includes(reason)) throw new TypeError(`${String(reason)} is not a preservation reason`)
    this.assertInTree(tree, t, cue)
    t.kept.set(cue, reason)
  }

  /**
   * Commit the whole tree at once: every cue of its span exactly once, staged or preserved, and none
   * resolved in this state meanwhile. Throws, committing nothing and leaving the tree open, otherwise.
   */
  commitTree(tree: RecoveryTree): void {
    const t = this.internalsOf(tree)
    for (let c = tree.fromCue; c <= tree.toCue; c++) {
      const inStaged = t.staged.has(c)
      const inKept = t.kept.has(c)
      if (inStaged === inKept) throw new Error(inStaged ? `cue ${c} is both staged and preserved` : `cue ${c} of the tree is unresolved`)
      this.assertOpen(c)
    }
    for (const [c, text] of t.staged) this.accepted.set(c, text)
    for (const [c, reason] of t.kept) this.preserved.set(c, reason)
    t.closed = true
  }

  /** Abandon a tree: nothing of it reaches this state. */
  discardTree(tree: RecoveryTree): void {
    this.internalsOf(tree).closed = true
  }

  /**
   * Continue (Phase 3): cues `1..rows.length` as a verified checkpoint and its partial hold them —
   * `resumeStore.ts` has matched every one to its recorded source and output digests. Only an empty
   * state is restored, and nothing on disk outside that record is ever accepted. A preserved row is
   * restored as preserved with reason `null` (PR-3): its text is its source, never a translation.
   */
  restore(rows: readonly RestoredRow[]): void {
    if (this.accepted.size || this.preserved.size) throw new Error('only an empty state can be restored')
    if (rows.length > this.source.length) throw new RangeError(`${rows.length} restored cues are more than the source's ${this.source.length}`)
    rows.forEach((row, i) => {
      if (row.provenance === 'preserved' && row.text !== this.source[i].text) throw new Error(`restored preserved cue ${i + 1} is not its source text`)
      if (row.provenance !== 'accepted' && row.provenance !== 'preserved') throw new TypeError(`restored cue ${i + 1} has no provenance`)
    })
    rows.forEach((row, i) => {
      if (row.provenance === 'accepted') this.accepted.set(i + 1, row.text)
      else this.preserved.set(i + 1, null)
    })
  }

  /** The accepted cues in source order: source number and timing, accepted text. */
  acceptedCues(): Cue[] {
    return this.source.filter((cue) => this.accepted.has(cue.index)).map((cue) => ({ ...cue, text: this.accepted.get(cue.index)! }))
  }

  /** The preserved cues in source order, each with its reason and the derived `contextEligible`. */
  preservedCues(): PreservedCue[] {
    return this.source
      .filter((cue) => this.preserved.has(cue.index))
      .map((cue) => {
        const reason = this.preserved.get(cue.index) ?? null
        return Object.freeze({ index: cue.index, startMs: cue.startMs, endMs: cue.endMs, sourceText: cue.text, reason, contextEligible: contextEligible(reason) })
      })
  }

  /** Every cue in source order: accepted text, a preserved cue's source text, or the source while unresolved. */
  allCues(): Cue[] {
    return this.source.map((cue) => (this.accepted.has(cue.index) ? { ...cue, text: this.accepted.get(cue.index)! } : { ...cue }))
  }
}
