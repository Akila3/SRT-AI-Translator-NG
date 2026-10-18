/**
 * The translation reply check (implementation_plan.md Step 2.2, "Pre-commit validation").
 * AUTHORED-BY: opus-5.5-high
 *
 * gst 3.7.0 checks membership only (`main.py:1459`, `line["index"] not in indexes`), so a reply of
 * `[1,2,2,4]` for `[1,2,3,4]` passes, writes cue 2 twice and leaves cue 3 in the source language
 * inside a file that reads as translated. Here the returned index set must be an exact permutation
 * of the requested one, and the raw reply is checked as a sequence before anything is staged, so a
 * duplicate cannot be erased by map insertion before the check sees it.
 *
 * Indices are in the wire space gst uses: a cue's zero-based position (`main.py:420-423` numbers
 * cues from 1; the batch sends `str(i)` for i from 0). Messages name cues as gst does, wire + 1.
 */
import type { AnnouncedBlock } from './blocks'
import { cueTextProblem } from './srt'

/** One line as it was sent: the wire index and the source text the reply is checked against. */
export interface RequestedLine {
  readonly index: number
  readonly text: string
}

/** Internal reasons, closed. Each projects to one public `RunErrorKind`. */
export type ReplyFailureKind = 'malformed' | 'duplicate' | 'extra' | 'missing' | 'emptyText' | 'countMismatch'

/**
 * AR-FINAL-2 (Bundle G): which of the two reply shapes a failure is. `UnparseableReply`: the body is
 * not JSON, or not a list. `MissingIndices`: a list, but at least one requested line has no single
 * usable entry (left out, repeated, emptied or malformed), or an entry names a line not asked for.
 * The third shape, a content block, is `blocks.ts`'s.
 */
export type ReplyShape = 'MissingIndices' | 'UnparseableReply'

export interface ReplyFailure {
  readonly kind: ReplyFailureKind
  /** The `RunErrorKind` this is reported as: a wrong set of lines is a count failure, a bad line is malformed. */
  readonly publicKind: 'malformed' | 'countMismatch'
  readonly shape: ReplyShape
  readonly requested: number
  readonly returned: number
  /** 1-based positions in the reply of items that are not `{ index, text }` with usable values. */
  readonly malformedItems: readonly number[]
  readonly duplicated: readonly number[]
  readonly extra: readonly number[]
  readonly missing: readonly number[]
  readonly empty: readonly number[]
  /**
   * `MissingIndices` only: the requested lines that came back exactly once, well formed and not
   * emptied, as a batch a recovery tree may stage. Null when there is none, and whenever the reply
   * names a line that was not asked for or an item whose index cannot be read: such a reply may be
   * renumbered, so no entry of it can be trusted to belong to its cue.
   */
  readonly inHand: ValidatedBatch | null
  readonly message: string
}

/** A reply that passed, or a failed reply's trusted entries. Only `validateExactPermutation` makes one. */
export interface ValidatedBatch {
  readonly entries: ReadonlyArray<{ readonly index: number; readonly text: string }>
}

export type BatchValidation = { ok: true; batch: ValidatedBatch } | { ok: false; failure: ReplyFailure }

/** AR-FINAL-2: what refused a translation request, as the recovery ladder (§17.8R PR-2) reads it. */
export type RecoveryTrigger =
  | { readonly shape: 'MissingIndices'; readonly inHand: ValidatedBatch | null }
  | { readonly shape: 'UnparseableReply' }
  | AnnouncedBlock

export function replyTrigger(failure: ReplyFailure): RecoveryTrigger {
  return failure.shape === 'UnparseableReply' ? { shape: 'UnparseableReply' } : { shape: 'MissingIndices', inHand: failure.inHand }
}

const minted = new WeakSet<ValidatedBatch>()

/** True only for a batch this module produced from a reply that passed. */
export function isValidatedBatch(batch: unknown): batch is ValidatedBatch {
  return typeof batch === 'object' && batch !== null && minted.has(batch as ValidatedBatch)
}

/** The cue number gst prints for a wire index (`main.py:1455-1462`, `int(index) + 1`). */
export function cueNumberOfWire(index: number): number {
  return index + 1
}

/** A wire index from the reply: an integer, or a string of digits as gst sends them. Anything else is not one. */
export function normaliseIndex(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) {
    const n = Number(value.trim())
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}

function lines(indices: readonly number[]): string {
  const cues = indices.map(cueNumberOfWire)
  const shown = cues.length > 8 ? `${cues.slice(0, 8).join(', ')} and ${cues.length - 8} more` : cues.join(', ')
  return `${cues.length === 1 ? 'line' : 'lines'} ${shown}`
}

function isBlank(text: string): boolean {
  return text.trim() === ''
}

function fail(
  kind: ReplyFailureKind,
  requested: number,
  returned: number,
  detail: Partial<Pick<ReplyFailure, 'malformedItems' | 'duplicated' | 'extra' | 'missing' | 'empty' | 'inHand'>> & { shape?: ReplyShape },
  message: string
): BatchValidation {
  return {
    ok: false,
    failure: {
      kind,
      publicKind: kind === 'malformed' || kind === 'emptyText' ? 'malformed' : 'countMismatch',
      shape: detail.shape ?? 'MissingIndices',
      requested,
      returned,
      malformedItems: detail.malformedItems ?? [],
      duplicated: detail.duplicated ?? [],
      extra: detail.extra ?? [],
      missing: detail.missing ?? [],
      empty: detail.empty ?? [],
      inHand: detail.inHand ?? null,
      message
    }
  }
}

function mint(entries: ReadonlyArray<{ index: number; text: string }>): ValidatedBatch {
  const batch: ValidatedBatch = Object.freeze({ entries: Object.freeze(entries.map((e) => Object.freeze({ index: e.index, text: e.text }))) })
  minted.add(batch)
  return batch
}

/**
 * A failed list's trusted entries (`ReplyFailure.inHand`): each requested line, in request order,
 * that exactly one well-formed item answers with a usable text. Read on the raw sequence, so a
 * duplicate is two items and neither is kept.
 */
function trustedEntries(sent: ReadonlyMap<number, string>, returnedItems: readonly unknown[]): ValidatedBatch | null {
  const answers = new Map<number, (string | null)[]>()
  for (const item of returnedItems) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const rec = item as Record<string, unknown>
    const index = normaliseIndex(rec.index)
    if (index === null || !sent.has(index)) return null
    const list = answers.get(index) ?? []
    list.push(typeof rec.text === 'string' && cueTextProblem(rec.text) === null ? rec.text : null)
    answers.set(index, list)
  }
  const entries: { index: number; text: string }[] = []
  for (const [index, source] of sent) {
    const got = answers.get(index)
    const text = got?.length === 1 ? got[0] : null
    if (text === null || (isBlank(text) && !isBlank(source))) continue
    entries.push({ index, text })
  }
  return entries.length ? mint(entries) : null
}

/**
 * Check a parsed reply against the lines that were sent, in this order, all on the raw sequence:
 * every item is `{ index, text }` with an index that normalises and a string text that would read
 * back as one cue (`malformed`); no index twice (`duplicate` — both copies are unresolvable, so
 * neither is kept, and `missing` still lists what never came back); none that was not asked for
 * (`extra`); none left out (`missing`, which also
 * covers an empty reply and a short last batch — there is no last-item exception); and no blank
 * text against a non-blank source (`emptyText`, including the last item). Then the arity guard: the
 * staged entries must number exactly the raw items and the requested lines, or `countMismatch`.
 *
 * Order in the reply is not meaning; the index is. Text is returned exactly as received.
 */
export function validateExactPermutation(requested: readonly RequestedLine[], returnedItems: unknown): BatchValidation {
  const sent = new Map<number, string>()
  for (const line of requested) {
    if (!Number.isSafeInteger(line.index) || line.index < 0 || sent.has(line.index)) {
      throw new TypeError(`requested lines must have distinct wire indices; got ${line.index}`)
    }
    sent.set(line.index, line.text)
  }
  if (sent.size === 0) throw new TypeError('a batch must request at least one line')
  const want = sent.size

  if (!Array.isArray(returnedItems)) {
    return fail('malformed', want, 0, { shape: 'UnparseableReply' }, 'Gemini has returned a reply that is not a list of lines.')
  }
  const got = returnedItems.length
  const list: readonly unknown[] = returnedItems
  const inHand = () => trustedEntries(sent, list)

  const items: { index: number; text: string }[] = []
  const malformedItems: number[] = []
  returnedItems.forEach((item: unknown, at) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      malformedItems.push(at + 1)
      return
    }
    const rec = item as Record<string, unknown>
    const index = normaliseIndex(rec.index)
    if (index === null || typeof rec.text !== 'string' || cueTextProblem(rec.text) !== null) {
      malformedItems.push(at + 1)
      return
    }
    items.push({ index, text: rec.text })
  })
  if (malformedItems.length > 0) {
    return fail(
      'malformed',
      want,
      got,
      { malformedItems, inHand: inHand() },
      `Gemini has returned a malformed object (item ${malformedItems[0]} of ${got}).`
    )
  }

  const seen = new Map<number, number>()
  for (const { index } of items) seen.set(index, (seen.get(index) ?? 0) + 1)
  const duplicated = [...seen].filter(([, n]) => n > 1).map(([i]) => i).sort((a, b) => a - b)
  const extra = [...seen.keys()].filter((i) => !sent.has(i)).sort((a, b) => a - b)
  const missing = [...sent.keys()].filter((i) => !seen.has(i)).sort((a, b) => a - b)
  const sets = { duplicated, extra, missing, inHand: duplicated.length || extra.length || missing.length ? inHand() : null }

  if (duplicated.length > 0) {
    const gap = missing.length > 0 ? ` and has not returned ${lines(missing)}` : ''
    return fail('duplicate', want, got, sets, `Gemini has returned ${lines(duplicated)} more than once${gap}.`)
  }
  if (extra.length > 0) {
    return fail('extra', want, got, sets, `Gemini has returned an unexpected ${lines(extra)}.`)
  }
  if (missing.length > 0) {
    return fail(
      'missing',
      want,
      got,
      sets,
      got === 0 ? 'Gemini has returned an empty translation.' : `Gemini has not returned ${lines(missing)}.`
    )
  }

  const empty = items.filter(({ index, text }) => isBlank(text) && !isBlank(sent.get(index)!)).map(({ index }) => index).sort((a, b) => a - b)
  if (empty.length > 0) {
    return fail('emptyText', want, got, { empty, inHand: inHand() }, `Gemini has returned an empty translation for ${lines(empty)}.`)
  }

  const staged = new Map<number, string>()
  for (const { index, text } of items) staged.set(index, text)
  if (staged.size !== got || staged.size !== want) {
    return fail('countMismatch', want, got, { ...sets, inHand: inHand() }, `Gemini has returned ${got} ${got === 1 ? 'line' : 'lines'} for ${want}.`)
  }

  return { ok: true, batch: mint(requested.map((line) => ({ index: line.index, text: staged.get(line.index)! }))) }
}

/**
 * The reply text, parsed and checked. Strict JSON: gst repairs with `json_repair` (`main.py:1240`),
 * but a repaired reply is one the model did not send, and the response schema makes valid JSON the
 * normal case.
 */
export function validateReply(requested: readonly RequestedLine[], text: string): BatchValidation {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('malformed', requested.length, 0, { shape: 'UnparseableReply' }, 'Gemini has returned a reply that is not valid JSON.')
  }
  return validateExactPermutation(requested, parsed)
}
