/**
 * The provider contract: what a provider receives and what it returns.
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * Provider-internal. `RunError` in `shared/engineEvents.ts` is the public projection; the renderer
 * never sees these shapes (implementation_plan.md §2.3, ARCHITECTURE_TARGET.md §3). A module here
 * may not import `batching.ts`, `prompt.ts` or any UI type, and only `gemini.ts` may import a
 * provider SDK — the import-rule gate reads these files as text.
 */
import type { ProviderCapabilities, QuotaEvidenceDetail, Usage } from '../../shared/engineEvents'

export type { ProviderCapabilities }

/**
 * A JSON value with every piece of prompt/response/part text replaced by an omission marker.
 * Keys, array positions, numbers, booleans and allow-listed control words survive.
 */
export type StructuralEnvelope =
  | null
  | boolean
  | number
  | string
  | StructuralEnvelope[]
  | { [key: string]: StructuralEnvelope }

/**
 * The typed outcome of one provider call. Refusal is a first-class result, not an exception.
 *
 * A successful reply carries the model's visible text; turning it into cues or segments is the
 * caller's schema, so a provider never imports the batching types.
 */
export type BatchResult =
  | {
      ok: true
      text: string
      /** The API's finish word as sent, `''` when absent. Never invented. */
      finishReason: string
      /** `thought: true` parts, kept apart from the text. Only a native Translate caller records them. */
      thoughtSummaries?: string[]
    }
  | {
      ok: false
      kind: 'blocked'
      /** The API's own refusal word; `''` when it announced none. Never invented. */
      reason: string
      scope: 'prompt' | 'response'
      /** Text that arrived beside a filtered finish. Run-local recovery/diagnostic only; never staged. */
      partialText?: string
    }
  | {
      ok: false
      kind: 'quota'
      retryAfterMs?: number
      metric?: 'rpm' | 'tpm' | 'rpd'
      explicitLimit?: number
      resetAt?: string
      /** Complete REDACTED response key set, captured before extraction. */
      detailKeys: string[]
      /**
       * Bundle F: every allow-listed violation in the response, in response order. `metric`/
       * `explicitLimit`/`resetAt` above are their summary, and a conflict leaves `explicitLimit` absent.
       */
      quotaDetails?: QuotaEvidenceDetail[]
      /** The provider's status word (`RESOURCE_EXHAUSTED`), `''` when absent. Feeds the evidence fingerprint. */
      statusCode?: string
    }
  | {
      ok: false
      kind: 'auth'
      reason: 'invalid' | 'permission' | 'unsupported-location'
      keyIndex: number
    }
  | { ok: false; kind: 'rate-limit'; retryAfterMs?: number; detailKeys: string[] }
  | { ok: false; kind: 'overload' }
  | { ok: false; kind: 'network'; cause: unknown }
  | { ok: false; kind: 'timeout'; stage: 'pre-dispatch' | 'in-flight' }
  | { ok: false; kind: 'cancelled' }
  | {
      ok: false
      kind: 'request-invalid'
      detailKeys: string[]
      /**
       * Bundle G (R18-PR PR-4): Google rejected this request's safety thresholds, and the provider has
       * already moved the model to `OFF` for the session. Only a request sent at `BLOCK_NONE` is marked;
       * the same rejection of an `OFF` request is the ordinary stop. `retry.ts` sends it once more.
       */
      safetyThreshold?: true
    }
  | { ok: false; kind: 'response-too-large'; limitBytes: number }
  | {
      ok: false
      kind: 'malformed'
      /** Run-local recovery only; never persisted raw. */
      raw: string
      /**
       * `truncated`: the model hit its output cap (`MAX_TOKENS`/`LENGTH`). The text is real but cut
       * off, and truncation outranks text presence — it must never stage as complete.
       * `shape`: the body is JSON but not a `generateContent` response.
       * `json`: the body is not JSON at all.
       */
      cause: 'truncated' | 'shape' | 'json'
      finishReason?: string
    }
  | { ok: false; kind: 'unknown'; detailKeys: string[] }

export type BatchFailure = Extract<BatchResult, { ok: false }>
export type BatchFailureKind = BatchFailure['kind']

/**
 * What a reply says about content blocking, from `blocks.ts` (the only classifier; Bundle G and
 * Phase 3 consume it). `NONE`: not a content block. `UNKNOWN`: a content block whose reason is
 * neither of the two named ones, or is not named at all.
 */
export type ContentBlockClass = 'PROHIBITED_CONTENT' | 'OTHER' | 'UNKNOWN' | 'NONE'

/** One provider reply, whatever its outcome. */
export interface ProviderReply {
  result: BatchResult
  /**
   * `usageMetadata` when the provider reported it. Kept beside the result rather than inside the
   * success branch because a blocked or truncated reply still bills its tokens.
   */
  usage: Usage | null
  /** The complete redacted envelope, for diagnosis. Null when there was no parseable body. */
  envelope: StructuralEnvelope | null
  /** Every key path in the body, captured before extraction (`a.b[].c`). Bounded. */
  detailKeys: string[]
  /**
   * `usageMetadata.cachedContentTokenCount`, present only when the body reported one. Bundle I: a
   * dedicated transcription answered from the implicit cache is unusable whatever it says (AR-FINAL-3).
   */
  cachedContentTokens?: number
  /** A dedicated transcription model's timed words, present only on a successful reply that carried them. */
  wordTimings?: ProviderWordTimings
}

/** One word as a dedicated transcription model measured it, in seconds from the start of its audio. */
export interface ProviderTimedWord {
  word: string
  start: number
  end: number
}

export type ProviderWordTimings =
  | { ok: true; text: string; words: ProviderTimedWord[] }
  | { ok: false; cause: 'shape' | 'offset'; index?: number }

/** One part of the assembled request, in send order. */
export type ProviderPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }

/** An earlier turn sent before the current one: a context pair is a `user` turn and its `model` turn. */
export interface ProviderTurn {
  role: 'user' | 'model'
  parts: ProviderPart[]
}

/**
 * The last application-owned object before the provider transport (D14-3). Everything a request
 * depends on is decided before it is built; the provider adds credentials and nothing else.
 */
export interface ProviderRequest {
  model: string
  systemInstruction?: string
  /** Turns sent before `parts`, oldest first. Absent or empty: the current turn is the whole request. */
  history?: ProviderTurn[]
  /** The current user turn. */
  parts: ProviderPart[]
  responseMimeType?: string
  /** A JSON Schema object, passed through unchanged. */
  responseJsonSchema?: unknown
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  thinking?: { level?: string; budget?: number; includeThoughts?: boolean }
  /** Absent means the provider default; never sent where the model does not accept it. */
  serviceTier?: string
  /**
   * A dedicated transcription model's own configuration (Bundle I): timed words, in the one confirmed
   * language. Its requests carry no system instruction, schema, thinking or sampling.
   */
  audioTranscription?: { wordTimestamp: true; languageCodes: string[] }
}

/**
 * What one request is, without its content (implementation_plan.md §14.3, D14-3): the structural
 * projection a gate compares with the outgoing body and a diagnostic may keep. It carries no prompt,
 * subtitle, description, override or key text — flags, counts, names and numbers only.
 */
export interface ProviderRequestReceipt {
  model: string
  effectiveSlot: number
  quotaGroupId: string | null
  /** The registry value (`pt-BR`), not the prompt name. */
  targetLanguage: string
  sourceLanguage: string | null
  /** Wire indices, in request order. */
  requestedIndices: number[]
  hasDescription: boolean
  hasSystemPromptOverride: boolean
  hasContextPair: boolean
  hasOracleBlock: boolean
  /** `''` when the request carries none. */
  responseMimeType: string
  /** `'none'` when the request carries no schema. */
  responseSchemaId: string
  safetySettingCount: number
  /** The generation fields present, as dotted names in a fixed order. */
  generationFields: string[]
  outputTokenLimit: number | null
  timeoutMs: number
  responseLimitBytes: number
}

/** What one call needs that is not part of the request. */
export interface ProviderCallContext {
  /** Never logged, never echoed into a result. */
  apiKey: string
  /** Which configured slot `apiKey` came from; reported on an auth result. */
  keyIndex: number
  /** The run's signal. An aborted signal yields `cancelled`, never a retry. */
  signal: AbortSignal
  /**
   * The D14-5 ceiling for this response (`responseLimit.ts` `responseLimitBytes`). A body over it is
   * refused before it is buffered: `response-too-large`, non-retryable, nothing parsed.
   */
  responseLimitBytes: number
  /**
   * This request's own deadline. Firing before the request leaves the process is
   * `timeout`/`pre-dispatch`; after, `timeout`/`in-flight` — terminal, because the service may
   * already have accepted and billed it (AS-D14-5).
   */
  timeoutMs?: number
}

export interface GenerationProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  generate(request: ProviderRequest, ctx: ProviderCallContext): Promise<ProviderReply>
  /**
   * Bundle F: count the exact request `generate` would send. Absent means the provider cannot count,
   * which the advisor treats as `unavailable` — never a projection of the visible text.
   */
  countTokens?(request: CountTokensRequest, ctx: ProviderCallContext): Promise<CountTokensResult>
  /**
   * Bundle G (PR-4): the safety posture the next request for `model` would carry, as the one function
   * both the send and the count read. Absent means the provider attaches none. The advisor keys its
   * count cache by it, so a count made under one posture is never reused for a send under another.
   */
  safetyPosture?(model: string): string
}

/** The official Models API maxima for one exact model id. Independent: output is never subtracted from input. */
export interface ModelTokenLimits {
  inputTokenLimit?: number
  outputTokenLimit?: number
}

/** The already-built provider request, frozen, so the count and the send describe one object. */
export interface CountTokensRequest {
  request: Readonly<ProviderRequest>
}

export type CountTokensResult =
  | { ok: true; totalTokens: number }
  | { ok: false; failure: BatchFailure }
  /** No exact route exists for this request; nothing was sent. */
  | { ok: false; unavailable: true }

/** One model a key can call `generateContent` on, as the provider listed it: `models/` stripped, nothing else changed. */
export interface ListedModel {
  id: string
  displayName?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
}

/**
 * A key's model list. Success means every page arrived; a failure on any page is a failure, never a
 * shorter list. Product policy (families, aliases, the picker) is the caller's.
 */
export type ModelListResult =
  | { ok: true; models: ListedModel[]; pages: number }
  | { ok: false; failure: BatchFailure; pages: number }

export interface ModelListContext {
  /** Never logged, never echoed into a result. */
  apiKey: string
  /** The caller's cancellation. An aborted signal yields `cancelled`. */
  signal?: AbortSignal
  /** The whole list's deadline, every page included. */
  timeoutMs: number
}
