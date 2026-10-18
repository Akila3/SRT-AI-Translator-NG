/**
 * Translate's request-size advisor (implementation_plan.md §12.7, Feature 8 D8-8). AUTHORED-BY: opus-5.5-high
 *
 * Before a batch is sent it asks whether the exact provider-ready request fits the selected model's
 * official `inputTokenLimit`. The request is the one `prompt.ts` builds and the one that is sent; this
 * module never reconstructs a prompt. When it does not fit, the line count halves —
 * `max(1, floor(lines / 2))` — until a counted prefix fits, at most `1 + ceil(log2(lines))` counts for
 * the batch. Only the counted-safe prefix is returned; nothing is dropped and nothing is assumed about
 * larger prefixes.
 *
 * Fail-open by construction: no limit, a count that errors, times out or is cancelled, a malformed
 * count, or one cue that alone overflows all answer `unavailable`, and the run sends the saved size.
 * Rate or quota pressure never reaches this module, so it can never shrink work for them (D8-8/D8-15).
 *
 * A text-only request at the saved size whose canonical UTF-8 form is no larger than the limit is not
 * counted, and answers `unavailable` (`notCounted`): the run sends the saved size, as it would with no
 * advisor, and no count call is spent on it. Nothing is claimed to fit without a count, and a reduced
 * prefix is always counted. A request with audio is always counted.
 *
 * In memory only: the count cache keeps the current and the previous batch's requests, keyed by
 * model, Quota Group, safety posture and the request's canonical form, and is cleared at the end of the
 * run. Nothing here is persisted, logged or hashed into a report.
 */
import { canonicalRequest } from './batching'
import type { ProviderRequest } from './providers/types'

/** The count calls one batch may make: `1 + ceil(log2(lines))`. */
export function countBound(lines: number): number {
  return 1 + Math.ceil(Math.log2(Math.max(1, lines)))
}

export type CountAnswer = { ok: true; totalTokens: number } | { ok: false }

export type AdviceUnavailable = 'noLimit' | 'countFailed' | 'oneCueOverflow' | 'bound' | 'cancelled' | 'notCounted'

export type AdviceResult =
  /** The requested lines fit. `inputTokens` is the exact count when one was made or cached. */
  | { state: 'fit'; lines: number; inputTokens: number | null; counts: number }
  /** Only the first `lines` were counted safe; the rest stay queued. */
  | { state: 'resized'; lines: number; inputTokens: number | null; counts: number }
  | { state: 'unavailable'; reason: AdviceUnavailable; counts: number }

export interface RequestAdvisorDeps {
  model: string
  /** The selected model's official input limit, or null when no metadata states it. */
  inputTokenLimit: number | null
  /** One exact count of `request` through the Quota Group `groupId`; never retried here. */
  count(request: ProviderRequest, signal: AbortSignal): Promise<CountAnswer>
  /**
   * The safety posture the provider attaches to the model's requests now (Bundle G, PR-4). The request
   * itself carries no safety field, so without it a count made at `BLOCK_NONE` would answer for `OFF`.
   */
  posture?(): string
}

export interface AdviseInput {
  lines: number
  /** The exact provider-ready request for the first `lines` cues of the batch. */
  build(lines: number): Promise<ProviderRequest>
  /** The Quota Group the count goes through, for the cache key. */
  groupId: string
  /**
   * At most this many counts, below `countBound(lines)` (Bundle G PR-6): what is left of the allowance of
   * the original group whose first cue this request starts at. Absent, the batch's own bound alone applies.
   */
  maxCounts?: number
  signal: AbortSignal
}

export interface RequestAdvisor {
  advise(input: AdviseInput): Promise<AdviceResult>
  /** At the run's end: forget every counted request. */
  clear(): void
}

function textOnly(request: ProviderRequest): boolean {
  return [request.parts, ...(request.history ?? []).map((t) => t.parts)].every((parts) => parts.every((p) => !('inlineData' in p)))
}

export function createRequestAdvisor(deps: RequestAdvisorDeps): RequestAdvisor {
  const limit = deps.inputTokenLimit !== null && Number.isSafeInteger(deps.inputTokenLimit) && deps.inputTokenLimit > 0 ? deps.inputTokenLimit : null
  let previous = new Map<string, number>()
  let current = new Map<string, number>()
  return {
    async advise(input) {
      previous = current
      current = new Map()
      if (limit === null) return { state: 'unavailable', reason: 'noLimit', counts: 0 }
      const requested = Math.max(1, Math.floor(input.lines))
      const cap = input.maxCounts
      const bound = cap === undefined ? countBound(requested) : Math.min(countBound(requested), Number.isSafeInteger(cap) && cap > 0 ? cap : 0)
      let candidate = requested
      let counts = 0
      for (;;) {
        if (input.signal.aborted) return { state: 'unavailable', reason: 'cancelled', counts }
        let request: ProviderRequest
        let canonical: string
        try {
          request = await input.build(candidate)
          canonical = canonicalRequest(request)
        } catch {
          return { state: 'unavailable', reason: 'countFailed', counts }
        }
        if (input.signal.aborted) return { state: 'unavailable', reason: 'cancelled', counts }
        const posture = deps.posture?.() ?? ''
        const key = `${deps.model}\u0000${input.groupId}\u0000${posture}\u0000${canonical}`
        let tokens: number | null = current.get(key) ?? previous.get(key) ?? null
        if (tokens === null && candidate === requested && textOnly(request) && Buffer.byteLength(canonical, 'utf8') <= limit) {
          return { state: 'unavailable', reason: 'notCounted', counts }
        }
        if (tokens === null) {
          if (counts >= bound) return { state: 'unavailable', reason: 'bound', counts }
          counts++
          const answer = await deps.count(request, input.signal).catch((): CountAnswer => ({ ok: false }))
          if (input.signal.aborted) return { state: 'unavailable', reason: 'cancelled', counts }
          if (!answer.ok || !Number.isSafeInteger(answer.totalTokens) || answer.totalTokens < 0) return { state: 'unavailable', reason: 'countFailed', counts }
          tokens = answer.totalTokens
        }
        current.set(key, tokens)
        if (tokens <= limit) {
          return { state: candidate === requested ? 'fit' : 'resized', lines: candidate, inputTokens: tokens, counts }
        }
        if (candidate === 1) return { state: 'unavailable', reason: 'oneCueOverflow', counts }
        candidate = Math.max(1, Math.floor(candidate / 2))
      }
    },
    clear() {
      previous = new Map()
      current = new Map()
    }
  }
}
