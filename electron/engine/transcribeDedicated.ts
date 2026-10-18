/**
 * Stage A for the dedicated transcription models (implementation_plan.md Bundle I §17.7, I.2).
 * AUTHORED-BY: opus-5.5-high
 *
 * `gemini-3.5-transcribe` is not asked for a timed JSON reply: it measures every word itself when the
 * request carries `audioTranscriptionConfig.wordTimestamp`, and returns the words under
 * `audioTranscription.words[]` on a 100 ms grid (`probe_gemini_3_5_transcribe.md` §7.1). Google lists
 * system instructions and structured output as unsupported on these models, so the request carries
 * neither — and no thinking, no sampling and no description, which is prompt text. What it does carry:
 *
 *  - the audio, inline;
 *  - `wordTimestamp: true`, without which the API answers 200 with text and no words (§6 row 1);
 *  - exactly one `languageCodes` entry, the bare subtag the user confirmed. Without it the model
 *    keeps whichever single language it picks and silently drops the rest (N6, §9b.4).
 *
 * The words come back on the clock of the audio that was sent; `offsets.ts` puts them on the file's.
 */
import { randomBytes } from 'crypto'
import type { RunError, Usage } from '../shared/engineEvents'
import type { BatchFailure, GenerationProvider, ProviderPart, ProviderReply, ProviderRequest } from './providers/types'
import { responseLimitBytes } from './providers/responseLimit'
import { classifyBlock } from './blocks'
import { createKeyRotation } from './keys'
import { withRetry, type AttemptGate, type RetryBudget, type RetryClock, type RetryPolicy } from './retry'
import type { LocalWord } from './offsets'
import type { TranscribeChunk } from './transcribe'

/** A bare ISO 639 primary subtag: `he`, `ja`, `en`, `yue`. Never a region, never a list. */
const BARE_SUBTAG = /^[a-z]{2,3}$/

/** The one language code a dedicated request may carry, or null when `code` is not a bare subtag. */
export function bareLanguageCode(code: unknown): string | null {
  if (typeof code !== 'string') return null
  const c = code.trim().toLowerCase()
  return BARE_SUBTAG.test(c) ? c : null
}

export interface DedicatedRequestInput {
  model: string
  audio: { data: Buffer; mimeType: string }
  /** Already confirmed by the user and checked by `bareLanguageCode`. */
  languageCode: string
  /** Only `flex` or `priority` is ever sent, as for every transcription (`modelRequestConfig`). */
  serviceTier?: string
}

/** One dedicated request. `leading` parts go before the audio, in order. */
export function dedicatedTranscribeRequest(input: DedicatedRequestInput, leading: readonly ProviderPart[] = []): ProviderRequest {
  const code = bareLanguageCode(input.languageCode)
  if (!code) throw new TypeError('A dedicated transcription request carries exactly one bare language code.')
  return {
    model: input.model,
    parts: [...leading, { inlineData: { mimeType: input.audio.mimeType, data: input.audio.data.toString('base64') } }],
    audioTranscription: { wordTimestamp: true, languageCodes: [code] },
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {})
  }
}

/**
 * A `-live` id passes the dedicated-model check (it contains `transcribe`) and can be picked from the
 * fetched list, but it answers only a live stream: the file request cannot reach it, and without this
 * the user would see the service's raw method error (feature_decisions.md, "The live variant").
 */
export function liveModelRefusal(model: string): string | null {
  if (!/-live(?:$|[-@])/i.test(model.trim())) return null
  return (
    `"${model.trim()}" is a live-streaming model: it listens to a live audio stream and cannot be sent a file, ` +
    'so it cannot transcribe this one. Nothing was sent. Choose gemini-3.5-transcribe or another model on the Transcribe tab.'
  )
}

export type DedicatedWords = { ok: true; words: LocalWord[] } | { ok: false; failure: BatchFailure }

/**
 * The words of one reply, or why there are none. A refusal or transport failure passes through as it
 * came. A STOP with no words and no text is a quiet answer: the coverage gate decides whether the audio
 * was quiet or dropped. Text without its words is not an answer this path can time, and is refused
 * as malformed rather than guessed at.
 */
export function dedicatedWords(reply: ProviderReply): DedicatedWords {
  if (!reply.result.ok) return { ok: false, failure: reply.result }
  const timed = reply.wordTimings
  if (!timed) {
    if (reply.result.text === '' && reply.result.finishReason === 'STOP') return { ok: true, words: [] }
    return { ok: false, failure: { ok: false, kind: 'malformed', raw: '', cause: 'shape', finishReason: reply.result.finishReason } }
  }
  if (!timed.ok) return { ok: false, failure: { ok: false, kind: 'malformed', raw: '', cause: 'shape', finishReason: reply.result.finishReason } }
  return { ok: true, words: timed.words.map((w) => ({ word: w.word, start: w.start, end: w.end })) }
}

// ── the implicit cache (AR-FINAL-3, implementation_plan.md §9.8b) ─────────────────────────────────

/**
 * A fresh 128-bit token, base64url. It makes every request distinct so the implicit cache has nothing
 * to match; it is never persisted and never logged.
 */
export function requestNonce(): string {
  return randomBytes(16).toString('base64url')
}

/** The leading text part every dedicated request starts with, exactly in this shape. */
export function noncePart(nonce: string): ProviderPart {
  return { text: `Request uniqueness token: ${nonce}` }
}

/**
 * A cached answer degraded a complete transcript from 3 235 words to 515 on a 93 % hit (ledger N7),
 * and looked like an ordinary answer. Any positive count makes the reply unusable, whatever it covers.
 */
export function answeredFromCache(reply: ProviderReply): boolean {
  return (reply.cachedContentTokens ?? 0) > 0
}

function sumUsage(parts: readonly (Usage | null | undefined)[]): Usage | undefined {
  const present = parts.filter((u): u is Usage => !!u)
  if (present.length === 0) return undefined
  return present.reduce<Usage>(
    (t, u) => ({
      promptTokens: t.promptTokens + u.promptTokens,
      thoughtTokens: t.thoughtTokens + u.thoughtTokens,
      outputTokens: t.outputTokens + u.outputTokens,
      totalTokens: t.totalTokens + u.totalTokens
    }),
    { promptTokens: 0, thoughtTokens: 0, outputTokens: 0, totalTokens: 0 }
  )
}

export interface DedicatedChunkOptions {
  provider: GenerationProvider
  model: string
  languageCode: string
  serviceTier?: string
  keys: readonly string[]
  slots: readonly number[]
  budget: RetryBudget
  retry?: { policy?: Partial<RetryPolicy>; clock?: RetryClock }
  say: (text: string) => void
  /** Gates only: a scripted token. Production draws a fresh random one for every request. */
  nonce?: () => string
  /** The run's request gate (`createRequestGate`): routing, pacing and the reservation against this model. */
  gate?: AttemptGate
}

/**
 * One chunk (or one recovered piece of it), sent through `retry.ts` as every transcription request is.
 * The words come back as zero-or-more-length cues, one per word, on the piece's own clock: the run's
 * coverage and recovery read them as they read any cue, and Stage B builds the subtitle from them.
 *
 * A reply answered from the implicit cache is sent once more with a fresh token; a second cached
 * reply refuses the span. Neither cached reply is used.
 */
export function dedicatedTranscribeChunk(opts: DedicatedChunkOptions): TranscribeChunk {
  const rotation = createKeyRotation(opts.slots)
  const limitBytes = responseLimitBytes({ outputTokenLimit: null })
  const nonce = opts.nonce ?? requestNonce
  const live = liveModelRefusal(opts.model)
  return async ({ chunk, audio }, signal) => {
    if (live) return { ok: false, error: { kind: 'refusedByApp', message: live } }
    const billed: Usage[] = []
    const unusable: Usage[] = []
    const last: { blocked: ProviderReply | null } = { blocked: null }
    let attempts = 0
    const total = (): Usage | undefined => {
      const usage = sumUsage(billed)
      const wasted = sumUsage(unusable)
      return usage && wasted ? { ...usage, billedButUnusableTokens: wasted.totalTokens } : usage
    }
    for (let send = 1; send <= 2; send++) {
      const request = dedicatedTranscribeRequest(
        { model: opts.model, audio, languageCode: opts.languageCode, ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}) },
        [noncePart(nonce())]
      )
      const outcome = await withRetry<{ words: LocalWord[]; cached: boolean; usage?: Usage }>({
        keys: rotation,
        budget: opts.budget,
        signal,
        ...(opts.retry?.policy ? { policy: opts.retry.policy } : {}),
        ...(opts.retry?.clock ? { clock: opts.retry.clock } : {}),
        ...(opts.gate ? { gate: opts.gate } : {}),
        resendUnreadable: true,
        onRetry: (notice) => opts.say(`Part ${chunk.index} of ${chunk.total}: ${notice.message}`),
        attempt: async ({ keySlot, signal: attemptSignal, timeoutMs }) => {
          const reply = await opts.provider.generate(request, {
            apiKey: opts.keys[keySlot] ?? '',
            keyIndex: keySlot,
            signal: attemptSignal,
            responseLimitBytes: limitBytes,
            timeoutMs
          })
          // Counted as unusable once the request settles: a record failure may discard this same reply.
          if (answeredFromCache(reply)) return { ok: true as const, value: { words: [], cached: true, ...(reply.usage ? { usage: reply.usage } : {}) }, usage: reply.usage }
          const read = dedicatedWords(reply)
          if (!read.ok) {
            if (reply.usage) unusable.push(reply.usage)
            if (read.failure.kind === 'blocked') last.blocked = reply
            return { ok: false as const, failure: read.failure, usage: reply.usage }
          }
          return { ok: true as const, value: { words: read.words, cached: false }, usage: reply.usage }
        }
      })
      billed.push(...outcome.usage)
      attempts += outcome.attempts
      if (!outcome.ok) {
        if (outcome.discarded) unusable.push(outcome.discarded)
        let error: RunError = outcome.error ?? { kind: 'unknown', message: 'The request was stopped.' }
        if (error.kind === 'blocked' && last.blocked) {
          // The same one classifier Translate uses; the API's own word stays when it names neither.
          const cls = classifyBlock(last.blocked)
          if (cls === 'PROHIBITED_CONTENT' || cls === 'OTHER') error = { ...error, blockReason: cls }
        }
        const usage = total()
        return { ok: false, error, ...(usage ? { usage } : {}), attempts }
      }
      if (outcome.value.usage) unusable.push(outcome.value.usage)
      if (!outcome.value.cached) {
        const usage = total()
        const cues = outcome.value.words.map((w) => ({ start: w.start, end: w.end, text: w.word }))
        return { ok: true, cues, ...(usage ? { usage } : {}), attempts }
      }
      if (send === 1) opts.say(`Part ${chunk.index} of ${chunk.total} was answered from the service's cache, which is not used; asking once more.`)
    }
    const usage = total()
    return {
      ok: false,
      cacheRefused: true,
      error: {
        kind: 'malformed',
        message: `Part ${chunk.index} of ${chunk.total} was answered from the service's cache twice. Neither answer was used.`
      },
      ...(usage ? { usage } : {}),
      attempts
    }
  }
}

