/**
 * Getting back audio the model refused or dropped, by asking for less of it at a time
 * (implementation_plan.md Step 1.8a, `feature_decisions.md` D5-11). AUTHORED-BY: opus-5.5-high
 *
 * The loop does not know why it was called. A trigger — an announced refusal, a failed coverage
 * check — arrives with the number of unchanged retries it is worth, and nothing below branches on
 * which it was. Bundle G changes that number for `PROHIBITED_CONTENT` (D6-8) and nothing else; the
 * dedicated model's only trigger is coverage, and it enters the same way.
 *
 *  - Up to `retriesBeforeSplit` unchanged re-sends of the whole unit. A coverage failure is worth
 *    none — an identical re-send of a lossy answer came back byte-identical (F-A16).
 *  - Then halves, cut where the caller says (for audio, the quietest moment near the middle so a word
 *    is not split). A half whose words from the answer already in hand pass the gate is kept and not
 *    asked for again.
 *  - Never below the policy's floor, never deeper than `L = min(maxDepth, ceil(log2(D / floor)))`, and
 *    never past the budget. At most `retries + 2^(L+1) − 2` requests for a unit — the bound D14
 *    counts as C.
 *
 * ⚠ The policy and the budget are the CALLER's and have no default here (`codebase_map.md` "recover.ts
 * — the ownership boundary", E33c). Transcription and translation differ in every term and in the
 * unit they count — seconds of audio against requests — and a default is how one caller's numbers
 * reached the other's exit gate. A span here is whatever the caller halves: seconds or cue indices.
 *  - What cannot be recovered is reported by its times, never bridged and never dropped: the best
 *    words are kept, the wordless loud stretches are named, and a refusal is named as one.
 *  - Text grossly disproportionate to the sound (D5-12) is refused, not asked for again: re-slicing
 *    produces more invention, not less.
 *
 * Any other failure of a request ends the run, exactly as it would for the first request of a chunk;
 * retry.ts has already decided it is not worth sending again.
 *
 * Translate's recursion is `recoverCues` at the end of this file: it halves cues, not seconds, and
 * likewise takes its whole policy from the caller.
 */
import type { PreservationReason, RunError } from '../shared/engineEvents'
import type { TranscriptCue } from './progress'
import { mergeSpans, type Span } from './coverage'

export interface RecoveryPolicy {
  /** Unchanged re-sends of the whole unit before it is halved, for a refusal. */
  retriesBeforeSplit: number
  /** The shortest span ever asked for, in the span's own unit. */
  floor: number
  maxDepth: number
}

/** The caller's allowance. Asked before every request; false means the request is not sent. */
export interface RecoveryBudget {
  take(span: Span): boolean
}

/** How far from the middle a cut may move, as a share of the unit. */
export const SPLIT_SEARCH_SHARE = 0.1

export interface RecoveryTrigger {
  /** For the report only; the loop never reads it. */
  cause: 'refused' | 'coverage'
  retriesBeforeSplit: number
  /** The refusal that started it, when there was one. */
  error?: RunError
}

/** One request for one span. Cue times are absolute. */
export type SpanAnswer =
  | { ok: true; cues: TranscriptCue[] }
  | { ok: false; refused: true; error: RunError }
  | { ok: false; refused: false; error?: RunError; stopped?: boolean }

export type Judgement =
  | { ok: true }
  | { ok: false; disproportion: true; letters: number; loudSeconds: number }
  | { ok: false; disproportion: false; wordless: Span[] }

export interface RecoveryHooks {
  ask(span: Span): Promise<SpanAnswer>
  judge(span: Span, cues: readonly TranscriptCue[]): Judgement
  /** Where to cut, somewhere in [from, to]. */
  cutPoint(from: number, to: number): number
  /** Called before every request, with the span and why it is being asked for. */
  onAsk?(span: Span, why: 'retry' | 'half'): void
  /**
   * The cues the caller can actually write, and how many it cannot — for transcription, a cue with
   * no length, out of order or outside the span. Applied wherever recovery stops and keeps what it
   * has, so a floor or an exhausted budget never turns a rejected answer into a kept one.
   */
  usable(span: Span, cues: readonly TranscriptCue[]): { cues: TranscriptCue[]; dropped: number }
  /**
   * The two halves of a split as one, left first. `joinHalves` when absent: whole lines, where a line
   * the right half repeats is the cut heard twice. A caller whose entries are single words passes its
   * own, since the same word twice near a cut is usually the speaker's.
   */
  join?(left: readonly TranscriptCue[], right: readonly TranscriptCue[]): TranscriptCue[]
}

/** Lines left out of a span because their times could not be written. */
export interface MistimedSpan {
  span: Span
  lines: number
}

export interface RefusedSpan {
  span: Span
  why: 'refused' | 'disproportion'
  error?: RunError
  letters?: number
  loudSeconds?: number
  /** Refused, then not sent again because the budget ran out. */
  unsent?: boolean
}

export interface RecoveryResult {
  cues: TranscriptCue[]
  /** Loud stretches still without words. Suspect, not proven lost (F-A14). */
  uncovered: Span[]
  refused: RefusedSpan[]
  /** Where lines were left out because the model's times for them could not be written. */
  mistimed: MistimedSpan[]
  requests: number
  /** The summed length of every span asked for, in the span's unit. */
  reRequested: number
  /** True when the budget ran out before this unit was finished. */
  budgetExhausted: boolean
  /** A request failed in a way that ends the run. */
  failure?: Extract<SpanAnswer, { ok: false; refused: false }>
}

const length = (s: Span) => s.end - s.start

/** What is left of a wordless stretch once a refused one is cut out of it, below which it is not reported. */
const SLIVER = 1

/** The unit's depth bound: `min(maxDepth, ceil(log2(D / floor)))`. */
export function depthBound(length: number, policy: RecoveryPolicy): number {
  if (!(length > policy.floor)) return 0
  return Math.min(policy.maxDepth, Math.ceil(Math.log2(length / policy.floor)))
}

function normalised(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Two halves as one. A cue the second half repeats from the end of the first — the same words,
 * starting before the first half's last cue ends — is the cut heard twice, and is kept once.
 *
 * Any other cue that starts before the first half's last cue ends is a real line, and the two must not
 * overlap on screen. The first half's times sit on the model's whole-second grid while the cut is on
 * the audio's own sub-second quiet moment, so that last cue can run up to a second past the cut: it
 * now ends where the next line begins. (If the next line somehow starts no later than that cue, it is
 * moved to follow it instead, keeping its length; no text is dropped either way.)
 */
export function joinHalves(left: readonly TranscriptCue[], right: readonly TranscriptCue[]): TranscriptCue[] {
  const out = [...left]
  const tail = left[left.length - 1]
  let joined = false
  for (const c of right) {
    if (tail && c.start < tail.end) {
      const a = normalised(c.text)
      const b = normalised(tail.text)
      if (a && (b === a || b.endsWith(a))) continue
    }
    if (tail && !joined && c.start < tail.end) {
      if (c.start > tail.start) {
        out[out.length - 1] = { ...tail, end: c.start }
      } else {
        out.push({ ...c, start: tail.end, end: tail.end + (c.end - c.start) })
        joined = true
        continue
      }
    }
    joined = true
    out.push(c)
  }
  return out
}

export async function recoverUnit(
  unit: Span,
  trigger: RecoveryTrigger,
  inHand: readonly TranscriptCue[] | null,
  hooks: RecoveryHooks,
  budget: RecoveryBudget,
  policy: RecoveryPolicy
): Promise<RecoveryResult> {
  const result: RecoveryResult = { cues: [], uncovered: [], refused: [], mistimed: [], requests: 0, reRequested: 0, budgetExhausted: false }
  const limit = depthBound(length(unit), policy)
  let failed: RecoveryResult['failure']

  const ask = async (span: Span, why: 'retry' | 'half'): Promise<SpanAnswer | null> => {
    if (!budget.take(span)) {
      result.budgetExhausted = true
      return null
    }
    hooks.onAsk?.(span, why)
    result.requests++
    result.reRequested += length(span)
    return hooks.ask(span)
  }

  const wordlessOf = (span: Span, cues: readonly TranscriptCue[]): Span[] => {
    const j = hooks.judge(span, cues)
    return j.ok ? [] : j.disproportion ? [span] : j.wordless
  }

  /** Fewer wordless loud stretches wins; then more text. */
  const better = (span: Span, a: readonly TranscriptCue[] | null, b: readonly TranscriptCue[]): readonly TranscriptCue[] => {
    if (!a) return b
    const wa = wordlessOf(span, a).length
    const wb = wordlessOf(span, b).length
    if (wa !== wb) return wa < wb ? a : b
    const letters = (cs: readonly TranscriptCue[]) => cs.reduce((n, c) => n + c.text.length, 0)
    return letters(b) > letters(a) ? b : a
  }

  /** Keep only what can be written, and say where something could not be. */
  const keepUsable = (span: Span, cues: readonly TranscriptCue[]): TranscriptCue[] => {
    const u = hooks.usable(span, cues)
    if (u.dropped) result.mistimed.push({ span, lines: u.dropped })
    return u.cues
  }

  /** Where recovery stops: keep what is in hand that can be written, name what is still missing. */
  const settle = (span: Span, cues: readonly TranscriptCue[] | null, error?: RunError, unsent = false): TranscriptCue[] => {
    if (!cues) {
      result.refused.push({ span, why: 'refused', ...(error ? { error } : {}), ...(unsent ? { unsent } : {}) })
      return []
    }
    const kept = keepUsable(span, cues)
    result.uncovered.push(...wordlessOf(span, kept))
    return kept
  }

  const within = (span: Span, cues: readonly TranscriptCue[] | null, last: boolean): TranscriptCue[] | null =>
    cues ? cues.filter((c) => c.start >= span.start && (last ? true : c.start < span.end)) : null

  /** One answer for a span, then whatever recovery its judgement calls for. */
  const take = async (span: Span, answer: SpanAnswer, own: readonly TranscriptCue[] | null, depth: number, error?: RunError): Promise<TranscriptCue[]> => {
    if (!answer.ok) {
      if (!answer.refused) {
        failed = answer
        return []
      }
      return split(span, own, depth, answer.error)
    }
    const j = hooks.judge(span, answer.cues)
    if (j.ok) return answer.cues
    if (j.disproportion) {
      result.refused.push({ span, why: 'disproportion', letters: j.letters, loudSeconds: j.loudSeconds })
      return own ? settle(span, own) : []
    }
    return split(span, better(span, own, answer.cues), depth, error)
  }

  const split = async (span: Span, best: readonly TranscriptCue[] | null, depth: number, error?: RunError): Promise<TranscriptCue[]> => {
    if (failed) return []
    if (depth >= limit || length(span) < 2 * policy.floor) return settle(span, best, error)
    const mid = length(span) / 2 + span.start
    const radius = Math.min(SPLIT_SEARCH_SHARE * length(span), mid - span.start - policy.floor)
    const cut = radius > 0 ? hooks.cutPoint(mid - radius, mid + radius) : mid
    const halves: Span[] = [{ start: span.start, end: cut }, { start: cut, end: span.end }]
    const pieces: TranscriptCue[][] = []
    for (let i = 0; i < halves.length; i++) {
      const half = halves[i]
      const own = within(half, best, i === halves.length - 1)
      if (failed) return []
      if (own && hooks.judge(half, own).ok) {
        pieces.push(own)
        continue
      }
      const answer = await ask(half, 'half')
      if (!answer) {
        pieces.push(settle(half, own, error, true))
        continue
      }
      pieces.push(await take(half, answer, own, depth + 1, error))
    }
    const join = hooks.join ?? joinHalves
    return pieces.reduce<TranscriptCue[]>((acc, p) => join(acc, p), [])
  }

  let best = inHand
  let error = trigger.error
  for (let r = 0; r < trigger.retriesBeforeSplit; r++) {
    const answer = await ask(unit, 'retry')
    if (!answer) break
    if (!answer.ok) {
      if (!answer.refused) {
        result.failure = answer
        return result
      }
      error = answer.error
      continue
    }
    const j = hooks.judge(unit, answer.cues)
    if (j.ok) {
      result.cues = answer.cues
      return result
    }
    if (j.disproportion) {
      result.refused.push({ span: unit, why: 'disproportion', letters: j.letters, loudSeconds: j.loudSeconds })
      result.cues = best ? settle(unit, best) : []
      return result
    }
    best = better(unit, best, answer.cues)
    break
  }

  result.cues = await split(unit, best, 0, error)
  if (failed) {
    result.failure = failed
    result.cues = []
    return result
  }
  // Each piece was judged on its own grid; a gap that straddles two pieces can pass both. The joined
  // answer is judged again over the whole unit, which is the grid that found the problem — and only
  // what can be written is returned, whatever the pieces passed.
  result.cues = keepUsable(unit, result.cues)
  const whole = hooks.judge(unit, result.cues)
  if (!whole.ok && !whole.disproportion) result.uncovered.push(...whole.wordless)
  result.uncovered = minus(mergeSpans(result.uncovered), result.refused.map((r) => r.span)).filter((s) => length(s) >= SLIVER)
  return result
}

// ── Translate: halving a refused batch down to one cue (Bundle G, D6-3) ─────────────────────────

/**
 * The Translate policy, always the caller's: depth at most `⌈log₂B⌉` and at most `2·B` extra requests for
 * a batch of B (D6-3, §9.4a gate 7). The terminal unit is one cue and is not a setting.
 */
export interface CueRecoveryPolicy {
  maxDepth: number
  maxRequests: number
}

/**
 * One request inside the tree, as the caller judged it. `resolved`: every cue asked for is now staged.
 * `split`: not all of them; the caller has already staged any it could trust, and `reason` is what a cue
 * left alone at the end of it is preserved for. `stop`: the run ends here.
 */
export type CueAnswer = { kind: 'resolved' } | { kind: 'split'; reason: PreservationReason } | { kind: 'stop' }

export interface CueRecoveryHooks {
  /**
   * Ask for exactly these cues: consecutive, ascending, none of them resolved. The first request is already
   * paid for; `more()` pays for each further one the caller sends for them, from the same allowance, and is
   * false when none is left — that request is then not sent.
   */
  ask(cues: readonly number[], more: () => boolean): Promise<CueAnswer>
  /** Staged or preserved in this tree already. */
  resolved(cue: number): boolean
  preserve(cue: number, reason: PreservationReason): void
}

export interface CueRecoveryResult {
  outcome: 'complete' | 'stopped'
  /** Every request sent inside the tree, the caller's resends included. */
  requests: number
  /** The deepest level a request was made at; the root's children are level 1. */
  depth: number
  /** The request allowance ran out and the cues left were preserved `BUDGET_FLOOR`. */
  budgetExhausted: boolean
}

/**
 * Resolve every cue of a refused batch by asking for halves of it, left first, until each cue is
 * staged or, alone in a request that still fails, preserved for the reason that request gave. The
 * batch itself has already failed and is not asked for again. Nothing here reads why a request failed:
 * the reason is the caller's, carried to the cue unchanged.
 */
export async function recoverCues(
  failed: { cues: readonly number[]; reason: PreservationReason },
  hooks: CueRecoveryHooks,
  policy: CueRecoveryPolicy
): Promise<CueRecoveryResult> {
  if (![policy.maxDepth, policy.maxRequests].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('A recovery policy is whole numbers, and the caller must give one.')
  }
  const result: CueRecoveryResult = { outcome: 'complete', requests: 0, depth: 0, budgetExhausted: false }
  const open = (cues: readonly number[]) => cues.filter((c) => !hooks.resolved(c))
  const floor = (cues: readonly number[]) => {
    result.budgetExhausted = true
    for (const c of open(cues)) hooks.preserve(c, 'BUDGET_FLOOR')
  }
  const take = (): boolean => {
    if (result.requests >= policy.maxRequests) {
      result.budgetExhausted = true
      return false
    }
    result.requests++
    return true
  }

  const settle = async (cues: readonly number[], reason: PreservationReason, depth: number): Promise<void> => {
    const left = open(cues)
    if (left.length === 0) return
    // Only a request of one cue condemns it. A cue left alone by entries in hand is asked once by itself.
    if (cues.length === 1) return hooks.preserve(left[0]!, reason)
    if (depth >= policy.maxDepth) return floor(left)
    const half = Math.floor(left.length / 2)
    // A request is a consecutive run of cues (`prompt.ts` refuses any other), and entries already in
    // hand can leave holes, so each half is asked as its runs. No piece is larger than its half, so the
    // depth bound holds, and every failed piece still has at least two children, so 2·B does too.
    for (const part of [left.slice(0, half), left.slice(half)].flatMap(consecutiveRuns)) {
      if (result.outcome === 'stopped') return
      const ask = open(part)
      if (ask.length === 0) continue
      if (!take()) {
        floor(ask)
        continue
      }
      result.depth = Math.max(result.depth, depth + 1)
      const answer = await hooks.ask(ask, take)
      if (answer.kind === 'stop') {
        result.outcome = 'stopped'
        return
      }
      if (answer.kind === 'resolved') {
        const missed = open(ask)
        if (missed.length) throw new Error(`A resolved request left cue ${missed[0]} unresolved.`)
        continue
      }
      await settle(ask, answer.reason, depth + 1)
    }
  }

  await settle(failed.cues, failed.reason, 0)
  return result
}

function consecutiveRuns(cues: readonly number[]): number[][] {
  const runs: number[][] = []
  for (const c of cues) {
    const last = runs[runs.length - 1]
    if (last && last[last.length - 1] + 1 === c) last.push(c)
    else runs.push([c])
  }
  return runs
}

/** `spans` with every part that lies inside `cuts` removed. */
function minus(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  let out = [...spans]
  for (const c of cuts) {
    out = out.flatMap((s) => {
      if (c.end <= s.start || c.start >= s.end) return [s]
      const kept: Span[] = []
      if (c.start > s.start) kept.push({ start: s.start, end: c.start })
      if (c.end < s.end) kept.push({ start: c.end, end: s.end })
      return kept
    })
  }
  return out
}
