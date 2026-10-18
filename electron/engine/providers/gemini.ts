/**
 * Gemini through `@google/genai` — the only module that imports a provider SDK.
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * Response classification adopts the behaviour of addon 0.2.542 `resources/lib/gemini.py`
 * `_generated_text` (sha256 b3e2ad6c…fcca09c; kodi_0.2.542_adoptions.md A): a block or a truncation
 * outranks text that looks usable, thinking parts are never subtitle text, and a part whose text is
 * not a string is skipped before the finish reason is read. HTTP 400/403 bodies are classified from
 * their structured fields first; the English-body patterns are the last resort.
 */
import { GoogleGenAI, HarmBlockThreshold, HarmCategory, type GenerateContentConfig, type ThinkingConfig } from '@google/genai'
import type { QuotaEvidenceDetail, Usage } from '../../shared/engineEvents'
import type { NetworkSources } from './proxy'
import { createBoundedTransport, isBoundedFetch, METADATA_RESPONSE_LIMIT_BYTES, TransportRequestError, type BoundedTransport } from './responseLimit'
import type {
  BatchFailure,
  BatchResult,
  CountTokensRequest,
  CountTokensResult,
  GenerationProvider,
  ListedModel,
  ModelListContext,
  ModelListResult,
  ProviderCallContext,
  ProviderCapabilities,
  ProviderReply,
  ProviderRequest,
  ProviderWordTimings,
  StructuralEnvelope
} from './types'

/**
 * What Gemini can do. Plain data on the shared, renderer-compiled interface, so it crosses IPC
 * unchanged. Per-model facts stay in `modelCaps.ts` (D5-4); `serviceTier: 'both'` is Step 0.2's
 * decision that both native paths send the tier.
 */
export const GEMINI_CAPABILITIES: ProviderCapabilities = Object.freeze({
  acceptsSystemPrompt: true,
  acceptsContext: true,
  acceptsReferenceTrack: true,
  acceptsAudio: true,
  transcribes: true,
  structuredOutputVariesByModel: true,
  timestampGranularityVariesByModel: true,
  serviceTier: 'both'
})

export const GEMINI_PROVIDER_ID = 'gemini'

/** A candidate finish that is a filter, not an ending. Its partial text is never staged. */
export const FILTERED_FINISH_REASONS: ReadonlySet<string> = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'])
/** The model ran out of output budget: the text is real but cut off. */
export const TRUNCATED_FINISH_REASONS: ReadonlySet<string> = new Set(['MAX_TOKENS', 'LENGTH'])

/** Run-local text kept on a failure for recovery is bounded; it never reaches persistence. */
const RAW_KEEP_CHARS = 64 * 1024
const DETAIL_KEYS_CAP = 128
const ENVELOPE_DEPTH_CAP = 32

type JsonObject = { [key: string]: unknown }
type Success = Extract<BatchResult, { ok: true }>
type Blocked = Extract<BatchResult, { kind: 'blocked' }>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── the redacted structural envelope ────────────────────────────────────────

/**
 * Keys whose string value is a control word, not content. A value under one of these survives only
 * if it is also word-shaped, so a sentence that lands under an allowed key is still omitted.
 */
const CONTROL_STRING_KEYS: ReadonlySet<string> = new Set([
  '@type',
  'blockReason',
  'category',
  'domain',
  'field',
  'finishReason',
  'location',
  'mimeType',
  'modality',
  'model',
  'modelVersion',
  'probability',
  'quotaId',
  'quotaMetric',
  'quotaValue',
  'reason',
  'retryDelay',
  'role',
  'severity',
  'status'
])
const CONTROL_WORD = /^[A-Za-z0-9_.:/@\-[\]]{1,160}$/

function omitted(text: string): string {
  return `[omitted ${text.length} chars]`
}

/**
 * The whole body with every piece of free text replaced by an omission marker. Keys, array
 * positions, numbers, booleans and allow-listed control words survive, so a capture shows the
 * response's shape — including a field nobody thought to extract (§4b check 10) — without the
 * prompt, the response text or the thoughts.
 */
export function structuralEnvelope(value: unknown, key = '', depth = 0): StructuralEnvelope {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') {
    return CONTROL_STRING_KEYS.has(key) && CONTROL_WORD.test(value) ? value : omitted(value)
  }
  if (depth >= ENVELOPE_DEPTH_CAP) return '[omitted: nested too deep]'
  if (Array.isArray(value)) return value.map((item) => structuralEnvelope(item, key, depth + 1))
  if (isObject(value)) {
    const out: { [k: string]: StructuralEnvelope } = {}
    for (const [k, v] of Object.entries(value)) out[k] = structuralEnvelope(v, k, depth + 1)
    return out
  }
  return `[omitted ${typeof value}]`
}

/** Every key path in the body (`candidates[].content.parts[].text`), sorted and bounded. */
export function keyPaths(value: unknown): string[] {
  const paths = new Set<string>()
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth >= ENVELOPE_DEPTH_CAP) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, `${prefix}[]`, depth + 1)
      return
    }
    if (!isObject(node)) return
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k
      paths.add(path)
      walk(v, path, depth + 1)
    }
  }
  walk(value, '', 0)
  const sorted = [...paths].sort()
  if (sorted.length <= DETAIL_KEYS_CAP) return sorted
  return [...sorted.slice(0, DETAIL_KEYS_CAP), `(+${sorted.length - DETAIL_KEYS_CAP} more)`]
}

function usageFrom(body: unknown): Usage | null {
  if (!isObject(body) || !isObject(body.usageMetadata)) return null
  const meta = body.usageMetadata
  const count = (field: string): number => {
    const v = meta[field]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
  }
  const promptTokens = count('promptTokenCount')
  const outputTokens = count('candidatesTokenCount')
  const thoughtTokens = count('thoughtsTokenCount')
  const total = meta.totalTokenCount
  const totalTokens =
    typeof total === 'number' && Number.isFinite(total) && total >= 0
      ? total
      : promptTokens + outputTokens + thoughtTokens
  return { promptTokens, thoughtTokens, outputTokens, totalTokens }
}

function cachedContentTokensFrom(body: unknown): number | null {
  if (!isObject(body) || !isObject(body.usageMetadata)) return null
  const v = body.usageMetadata.cachedContentTokenCount
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function reply(result: BatchResult, body: unknown, parsed: boolean): ProviderReply {
  const out: ProviderReply = {
    result,
    usage: parsed ? usageFrom(body) : null,
    envelope: parsed ? structuralEnvelope(body) : null,
    detailKeys: parsed ? keyPaths(body) : []
  }
  const cached = parsed ? cachedContentTokensFrom(body) : null
  if (cached !== null) out.cachedContentTokens = cached
  if (parsed && result.ok && hasAudioTranscription(body)) out.wordTimings = readAudioTranscriptionWords(body)
  return out
}

function keepRaw(text: string): string {
  return text.length > RAW_KEEP_CHARS ? text.slice(0, RAW_KEEP_CHARS) : text
}

// ── generateContent bodies ──────────────────────────────────────────────────

/**
 * Classify a parsed `generateContent` body. Order is the 0.2.542 order, and it is load-bearing:
 *
 * 1. `promptFeedback.blockReason` is a block even if candidates exist.
 * 2. No candidates is a block the API did not name (`reason: ''`).
 * 3. Thinking parts and non-string text are set aside BEFORE the finish reason is read, so a
 *    filtered candidate with `text: null` is still a block rather than a crash.
 * 4. A filtered finish wins over partial text; the text survives only as `partialText`.
 * 5. A truncated finish wins over text presence: `malformed`/`truncated`, never complete.
 * 6. No text with `OTHER` or no finish word is a block (0.2.542: "empty/blocked content"); with
 *    any other non-STOP word it is a refusal carrying that word. With `STOP` it is an empty
 *    success — the caller's count or coverage check is what rejects it.
 */
export function parseGenerateContentBody(body: unknown): ProviderReply {
  if (!isObject(body)) {
    return reply({ ok: false, kind: 'malformed', cause: 'shape', raw: keepRaw(safeStringify(body)) }, body, true)
  }
  const feedback = body.promptFeedback
  if (isObject(feedback) && feedback.blockReason) {
    return reply({ ok: false, kind: 'blocked', reason: String(feedback.blockReason), scope: 'prompt' }, body, true)
  }
  const candidates = body.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return reply({ ok: false, kind: 'blocked', reason: '', scope: 'response' }, body, true)
  }
  const candidate = isObject(candidates[0]) ? candidates[0] : {}
  const content = isObject(candidate.content) ? candidate.content : {}
  const parts = Array.isArray(content.parts) ? content.parts : []
  const chunks: string[] = []
  const thoughts: string[] = []
  for (const part of parts) {
    if (!isObject(part)) continue
    const text = part.text
    if (typeof text !== 'string') continue
    if (part.thought) thoughts.push(text)
    else chunks.push(text)
  }
  const text = chunks.join('').trim()
  const finish = String(candidate.finishReason ?? '').toUpperCase()

  if (FILTERED_FINISH_REASONS.has(finish)) {
    const blocked: Blocked = { ok: false, kind: 'blocked', reason: finish, scope: 'response' }
    if (text) blocked.partialText = keepRaw(text)
    return reply(blocked, body, true)
  }
  if (TRUNCATED_FINISH_REASONS.has(finish)) {
    return reply({ ok: false, kind: 'malformed', cause: 'truncated', raw: keepRaw(text), finishReason: finish }, body, true)
  }
  if (!text && finish !== 'STOP') {
    return reply({ ok: false, kind: 'blocked', reason: finish, scope: 'response' }, body, true)
  }
  const ok: Success = { ok: true, text, finishReason: finish }
  if (thoughts.length) ok.thoughtSummaries = thoughts
  return reply(ok, body, true)
}

/** The same classification from the body's text, which is all a bounded transport hands over. */
export function parseGenerateContentText(text: string): ProviderReply {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return reply({ ok: false, kind: 'malformed', cause: 'json', raw: keepRaw(text) }, undefined, false)
  }
  return parseGenerateContentBody(body)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ── rejected requests ───────────────────────────────────────────────────────

/** `ErrorInfo.reason` values that say the credential itself is bad. */
const INVALID_KEY_REASONS: ReadonlySet<string> = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED'])
/** `ErrorInfo.reason` values that say the credential is real but not allowed this call. */
const PERMISSION_REASONS: ReadonlySet<string> = new Set([
  'API_KEY_SERVICE_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_ANDROID_APP_BLOCKED',
  'API_KEY_IOS_APP_BLOCKED',
  'SERVICE_DISABLED',
  'CONSUMER_SUSPENDED',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'IAM_PERMISSION_DENIED'
])
const REQUEST_INVALID_STATUSES: ReadonlySet<string> = new Set([
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'FAILED_PRECONDITION',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED'
])
const OVERLOAD_HTTP: ReadonlySet<number> = new Set([500, 502, 503, 504])
const OVERLOAD_STATUSES: ReadonlySet<string> = new Set(['UNAVAILABLE', 'INTERNAL'])

/** 1.1.0's credential wording (`cli/engineErrors.ts:66` at `b6b75ae`, `modelsList.ts:248`) — same verdicts, last resort. */
const INVALID_KEY_TEXT = /API_KEY_INVALID|api key not valid|api key expired|invalid authentication|UNAUTHENTICATED/i
/** A qualifier on a structured precondition/permission status, never a classifier on its own. */
const LOCATION_TEXT = /\b(?:user location|location|region|country|territory)\b/i
/** 0.2.542 `_CONTENT_REJECTION_RE` / `_CONFIG_OR_ACCESS_REJECTION_RE`, verbatim in effect. */
const CONTENT_REJECTION_TEXT =
  /PROHIBITED_CONTENT|(?:PROMPT|CONTENT)\s+(?:WAS\s+)?(?:BLOCKED|PROHIBITED)(?:\s+FOR\s+SAFETY)?|REQUEST\s+(?:WAS\s+)?BLOCKED\s*:\s*(?:SAFETY|BLOCKLIST)/i
const CONFIG_OR_ACCESS_TEXT = /SAFETY_?SETTINGS?|INVALID\s+(?:ENUM|VALUE)|UNSUPPORTED|NOT\s+A\s+VALID|VPC\s+SERVICE\s+CONTROLS?/i
const FILTERED_WORD = /PROHIBITED_CONTENT|BLOCKLIST|SAFETY/i
/** Bundle G (PR-4): a rejection that names the safety setting or its threshold. */
const SAFETY_THRESHOLD_TEXT = /SAFETY[_\s]?SETTINGS?|HARM_?BLOCK_?THRESHOLD|\bTHRESHOLD\b|BLOCK_NONE/i

/** 0.2.542 `_structured_block_reason`: a filtered `blockReason` anywhere in the body. */
export function structuredBlockReason(value: unknown, depth = 0): string {
  if (depth >= ENVELOPE_DEPTH_CAP) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = structuredBlockReason(item, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (!isObject(value)) return ''
  for (const [k, item] of Object.entries(value)) {
    if (k.replace(/_/g, '').toLowerCase() === 'blockreason') {
      const word = String(item ?? '').toUpperCase()
      if (FILTERED_FINISH_REASONS.has(word)) return word
    }
    const found = structuredBlockReason(item, depth + 1)
    if (found) return found
  }
  return ''
}

function typeEndsWith(detail: JsonObject, suffix: string): boolean {
  return typeof detail['@type'] === 'string' && detail['@type'].endsWith(suffix)
}

/** `RetryInfo.retryDelay` ("17s", "1.5s") in milliseconds. */
function retryInfoMs(details: JsonObject[], now: number): number | undefined {
  for (const d of details) {
    if (!typeEndsWith(d, 'RetryInfo')) continue
    const m = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(String(d.retryDelay ?? ''))
    if (m) return wholeMs(Number(m[1]) * 1000, now)
  }
  return undefined
}

/** The last instant a `Date` can hold. */
const MAX_DATE_MS = 8_640_000_000_000_000

/** A delay in whole milliseconds, or none when it is too large to be one or to end at a date. */
function wholeMs(ms: number, now: number): number | undefined {
  const n = Math.round(ms)
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_DATE_MS - now ? n : undefined
}

/** HTTP `Retry-After`: delta-seconds or an HTTP-date. */
export function retryAfterHeaderMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return wholeMs(Number(trimmed) * 1000, now)
  const at = Date.parse(trimmed)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

interface QuotaViolation {
  /** The budget dimension this violation names; absent for any other quota. */
  metric?: 'rpm' | 'tpm' | 'rpd'
  /** A per-day quota of any unit: the group is spent for today, whatever it counted. */
  daily: boolean
  explicitLimit?: number
}

/** A quota value as Google sends it, a decimal string or a number, when it is a positive whole count. */
function quotaCount(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/**
 * Every `QuotaFailure` violation, in response order. Only the three budget dimensions are recognised —
 * requests per minute, input tokens per minute, requests per day — from the quota id and metric names
 * Google sends (`GenerateRequestsPerMinutePerProjectPerModel-FreeTier`,
 * `GenerateContentInputTokensPerModelPerMinute-FreeTier`, `probe_feature8_e60e_asf89.md` §2). Any other
 * dimension, such as output tokens, carries no metric (`other`) and so never becomes a ceiling, though
 * its stated value is kept for the report. A limit is kept only as a positive whole number; anything
 * else is no limit rather than a coerced one.
 */
function quotaViolations(details: JsonObject[]): QuotaViolation[] {
  const out: QuotaViolation[] = []
  for (const d of details) {
    if (!typeEndsWith(d, 'QuotaFailure') || !Array.isArray(d.violations)) continue
    for (const v of d.violations) {
      if (!isObject(v)) continue
      const id = `${typeof v.quotaId === 'string' ? v.quotaId : ''}|${typeof v.quotaMetric === 'string' ? v.quotaMetric : ''}`.toLowerCase()
      const daily = id.includes('perday') || id.includes('per_day')
      const minute = id.includes('perminute') || id.includes('per_minute')
      const requests = /request/.test(id)
      const inputTokens = /input_?tokens?/.test(id) && !/output/.test(id)
      const metric: QuotaViolation['metric'] = daily ? (requests ? 'rpd' : undefined) : minute ? (inputTokens ? 'tpm' : requests ? 'rpm' : undefined) : undefined
      out.push({ metric, daily, explicitLimit: quotaCount(v.quotaValue) })
    }
  }
  return out
}

const METRIC_SEVERITY = { rpd: 3, tpm: 2, rpm: 1 } as const

/**
 * Classify a non-2xx `generateContent` response.
 *
 * Structured evidence decides first — `ErrorInfo.reason`, the error `status`, a `blockReason`
 * anywhere in the body, `QuotaFailure`/`RetryInfo`. Only when no structured field settles a 400/403
 * do the English-body patterns run, and then in 0.2.542's order: a content rejection that is not a
 * configuration/access error is a recoverable block, never a request defect.
 */
export function classifyHttpFailure(
  httpStatus: number,
  bodyText: string,
  retryAfterHeader: string | null | undefined,
  keyIndex: number
): ProviderReply {
  let parsed: unknown
  let isJson = false
  try {
    parsed = JSON.parse(bodyText)
    isJson = true
  } catch {
    parsed = undefined
  }
  const root = Array.isArray(parsed) && parsed.length && isObject(parsed[0]) ? parsed[0] : parsed
  const err = isObject(root) && isObject(root.error) ? root.error : null
  const statusWord = err && typeof err.status === 'string' ? err.status.toUpperCase() : ''
  const details = err && Array.isArray(err.details) ? err.details.filter(isObject) : []
  const reasons = details
    .filter((d) => typeEndsWith(d, 'ErrorInfo'))
    .map((d) => String(d.reason ?? '').toUpperCase())
  const message = err && typeof err.message === 'string' ? err.message : isJson ? '' : bodyText
  const detailKeys = isJson ? keyPaths(parsed) : []
  const done = (result: BatchResult): ProviderReply => ({
    result,
    usage: null,
    envelope: isJson ? structuralEnvelope(parsed) : null,
    detailKeys
  })
  const auth = (reason: 'invalid' | 'permission' | 'unsupported-location'): ProviderReply =>
    done({ ok: false, kind: 'auth', reason, keyIndex })

  if (httpStatus === 401 || httpStatus === 407 || statusWord === 'UNAUTHENTICATED' || reasons.some((r) => INVALID_KEY_REASONS.has(r))) {
    return auth('invalid')
  }
  if ((statusWord === 'FAILED_PRECONDITION' || statusWord === 'PERMISSION_DENIED') && LOCATION_TEXT.test(message)) {
    return auth('unsupported-location')
  }
  if (statusWord === 'PERMISSION_DENIED' || reasons.some((r) => PERMISSION_REASONS.has(r))) {
    return auth('permission')
  }
  if (httpStatus === 400 || httpStatus === 403) {
    const block = structuredBlockReason(parsed)
    if (block) return done({ ok: false, kind: 'blocked', reason: block, scope: 'prompt' })
  }
  if (httpStatus === 429 || statusWord === 'RESOURCE_EXHAUSTED') {
    const now = Date.now()
    const retryAfterMs = retryInfoMs(details, now) ?? retryAfterHeaderMs(retryAfterHeader, now)
    const violations = quotaViolations(details)
    if (violations.length) {
      const worst = violations.reduce((a, b) =>
        (b.metric ? METRIC_SEVERITY[b.metric] : 0) > (a.metric ? METRIC_SEVERITY[a.metric] : 0) ? b : a
      )
      const quota: Extract<BatchResult, { kind: 'quota' }> = { ok: false, kind: 'quota', detailKeys }
      if (retryAfterMs !== undefined) quota.retryAfterMs = retryAfterMs
      // A per-day quota of another unit still spends the group for today; it states no request ceiling.
      const dailyOther = worst.metric !== 'rpd' && violations.some((v) => v.daily)
      if (dailyOther) quota.metric = 'rpd'
      else if (worst.metric) quota.metric = worst.metric
      // Two valid limits for the summary metric that disagree: the response is no ceiling, and array
      // order never picks a winner.
      const summaryLimits = new Set(violations.filter((v) => v.metric === worst.metric && v.explicitLimit !== undefined).map((v) => v.explicitLimit))
      if (!dailyOther && worst.metric && worst.explicitLimit !== undefined && summaryLimits.size === 1) quota.explicitLimit = worst.explicitLimit
      quota.quotaDetails = violations.map((v): QuotaEvidenceDetail => (v.explicitLimit !== undefined ? { metric: v.metric ?? 'other', limit: v.explicitLimit } : { metric: v.metric ?? 'other' }))
      quota.statusCode = statusWord
      return done(quota)
    }
    const rate: Extract<BatchResult, { kind: 'rate-limit' }> = { ok: false, kind: 'rate-limit', detailKeys }
    if (retryAfterMs !== undefined) rate.retryAfterMs = retryAfterMs
    return done(rate)
  }
  if (OVERLOAD_HTTP.has(httpStatus) || OVERLOAD_STATUSES.has(statusWord)) {
    return done({ ok: false, kind: 'overload' })
  }
  if (httpStatus === 400 || httpStatus === 403 || httpStatus === 404 || REQUEST_INVALID_STATUSES.has(statusWord)) {
    if (INVALID_KEY_TEXT.test(message)) return auth('invalid')
    if (CONTENT_REJECTION_TEXT.test(message) && !CONFIG_OR_ACCESS_TEXT.test(message)) {
      const word = FILTERED_WORD.exec(message)?.[0]?.toUpperCase() ?? ''
      return done({ ok: false, kind: 'blocked', reason: word, scope: 'prompt' })
    }
    if (httpStatus === 403) return auth('permission')
    if ((httpStatus === 400 || statusWord === 'INVALID_ARGUMENT') && SAFETY_THRESHOLD_TEXT.test(message)) {
      return done({ ok: false, kind: 'request-invalid', detailKeys, safetyThreshold: true })
    }
    return done({ ok: false, kind: 'request-invalid', detailKeys })
  }
  return done({ ok: false, kind: 'unknown', detailKeys })
}

// ── transcription responses (implementation_plan.md Step 1.6) ──────────────

/**
 * The two per-model facts a transcription response format is decided from (`modelCaps.ts`). Passed
 * in rather than looked up, so the caller's capability record is the only source.
 */
export interface TranscriptionFormatCaps {
  structuredOutput: boolean
  timestampGranularityMs: number | null
}

/** One cue as the model timed it, relative to the start of the audio it was sent, in seconds. */
export interface ModelCue {
  start: number
  end: number
  text: string
}

export type TranscriptionParse =
  | { ok: true; cues: ModelCue[] }
  | {
      ok: false
      /**
       * `json`: the text is not JSON. `shape`: not an array of cue objects, or an object without a
       * string `text`, `time_start` or `time_end`. `timestamp`: a time the grammar cannot read.
       */
      cause: 'json' | 'shape' | 'timestamp'
      /** Zero-based position of the offending cue, when there is one. */
      index?: number
    }

/** Fraction digits a grid needs: 1000 ms → none, 100 → 1, 10 → 2, 1 → 3. */
function gridDigits(granularityMs: number): number {
  return granularityMs >= 1000 ? 0 : granularityMs >= 100 ? 1 : granularityMs >= 10 ? 2 : 3
}

/**
 * The `responseMimeType` and JSON Schema for a transcription request, or `null` when this model must
 * not be sent one: it refuses JSON mode (a dedicated transcription id answers 400, gate_ledger.md
 * §5.17), or it has no timestamp grid anyone has measured.
 *
 * At the whole-second grid every generic model has (A47) the schema is gst's
 * `get_transcribe_response_schema` (`helpers.py:270-285`) and nothing more: an array of objects with
 * required string `text`, `time_start`, `time_end`. The `MM:SS` shape is stated by the instruction's
 * example, as gst states it. A finer grid adds the exact format to each time field, so a request
 * never asks for digits the model's grid does not have (ARCHITECTURE_TARGET.md §6.2).
 */
export function transcriptionResponseFormat(
  caps: TranscriptionFormatCaps
): { responseMimeType: 'application/json'; responseJsonSchema: JsonObject } | null {
  const grid = caps.timestampGranularityMs
  if (!caps.structuredOutput || grid === null || !(grid > 0)) return null
  const digits = gridDigits(grid)
  const time = (): JsonObject =>
    digits === 0
      ? { type: 'string' }
      : {
          type: 'string',
          description: `Time from the start of the audio as MM:SS.${'s'.repeat(digits)} — minutes, seconds and ${digits} fraction digit${digits === 1 ? '' : 's'}.`
        }
  return {
    responseMimeType: 'application/json',
    responseJsonSchema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, time_start: time(), time_end: time() },
        required: ['text', 'time_start', 'time_end']
      }
    }
  }
}

/** `MM:SS` or `HH:MM:SS`, as gst reads them, with an optional `.` or `,` fraction. */
const MODEL_TIME = /^\s*(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?\s*$/

/**
 * One model timestamp in seconds, placed on the declared grid; `null` when the grammar cannot read it.
 *
 * gst accepts `MM:SS` and `HH:MM:SS` (`main.py:1667-1677`, `utils.py:171-186`) with any number of
 * digits in each field, and anything else throws into its retry path; so does this. A fraction gst
 * would have refused is read, then rounded to the grid: digits finer than the model's grid are not
 * precision, and keeping them would make a whole-second answer look exact.
 */
export function parseModelTimestamp(value: string, granularityMs: number): number | null {
  const m = MODEL_TIME.exec(value)
  if (!m) return null
  const [, h, mm, ss, frac] = m
  const whole = (h ? Number(h) * 3600 : 0) + Number(mm) * 60 + Number(ss)
  const fraction = frac ? Number(frac) / 10 ** frac.length : 0
  const grid = granularityMs > 0 ? granularityMs : 1000
  return (Math.round(((whole + fraction) * 1000) / grid) * grid) / 1000
}

/**
 * The model's cues out of a JSON-mode transcription reply.
 *
 * gst's reading (`main.py:1866-1885`), except where it lost data silently. A nested array one level
 * deep is flattened and non-object items are skipped, as gst's `_flatten_repaired_json` does. A
 * missing field or an unreadable time fails the whole reply, as gst's `KeyError`/`ValueError` did,
 * so the chunk is asked again rather than half-kept. **One difference:** a reply that is not an array
 * at all made gst's flatten return nothing, and the chunk was recorded as done with no cues. Here it
 * is `shape` — a failure, never an empty success.
 */
export function parseTranscriptionResponse(text: string, granularityMs: number): TranscriptionParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, cause: 'json' }
  }
  if (!Array.isArray(parsed)) return { ok: false, cause: 'shape' }
  const items: JsonObject[] = []
  for (const item of parsed) {
    if (isObject(item)) items.push(item)
    else if (Array.isArray(item)) for (const sub of item) if (isObject(sub)) items.push(sub)
  }
  const cues: ModelCue[] = []
  for (let index = 0; index < items.length; index++) {
    const { text: cueText, time_start: from, time_end: to } = items[index]
    if (typeof cueText !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
      return { ok: false, cause: 'shape', index }
    }
    const start = parseModelTimestamp(from, granularityMs)
    const end = parseModelTimestamp(to, granularityMs)
    if (start === null || end === null) return { ok: false, cause: 'timestamp', index }
    cues.push({ start, end, text: cueText })
  }
  return { ok: true, cues }
}

/** One word as a dedicated transcription model measured it, in seconds from the start of its audio. */
export interface TimedWord {
  word: string
  start: number
  end: number
}

export type WordTimingParse =
  | {
      ok: true
      text: string
      words: TimedWord[]
      /** Offsets that are not on the declared grid. A model that complies returns 0. */
      offGrid: number
    }
  | { ok: false; cause: 'shape' | 'offset'; index?: number }

/** A protobuf JSON `Duration` in seconds: `"1.600s"`, `"3s"`. */
const DURATION = /^(\d+(?:\.\d{1,9})?)s$/

function onGrid(seconds: number, granularityMs: number): boolean {
  if (!(granularityMs > 0)) return false
  const steps = (seconds * 1000) / granularityMs
  return Math.abs(steps - Math.round(steps)) < 1e-6
}

/**
 * The words of a dedicated model's reply (`audioTranscriptionConfig.wordTimestamp`), with their
 * offsets exactly as measured — never rounded, so `offGrid` can show whether the model kept to
 * `granularityMs`. They live at `candidates[0].content.parts[].audioTranscription.words[]`
 * (`word`, `startOffset`, `endOffset`), beside a `text` the block/finish classification in
 * `parseGenerateContentBody` already reads; run that first. A reply with no `audioTranscription`, or
 * one without a `words` array, is `shape`; an offset that is not a `Duration` is `offset`.
 *
 * Captured, not documented: `scripts/gates/fixtures/transcribe-1.6/` (gate_ledger.md §5.20). The
 * request shape that asks for these words is Bundle I's.
 */
export function parseAudioTranscriptionWords(body: unknown, granularityMs: number): WordTimingParse {
  const read = readAudioTranscriptionWords(body)
  if (!read.ok) return read
  let offGrid = 0
  for (const w of read.words) {
    if (!onGrid(w.start, granularityMs)) offGrid += 1
    if (!onGrid(w.end, granularityMs)) offGrid += 1
  }
  return { ...read, offGrid }
}

function audioTranscriptionsOf(body: unknown): JsonObject[] {
  const candidates = isObject(body) && Array.isArray(body.candidates) ? body.candidates : []
  const candidate = isObject(candidates[0]) ? candidates[0] : {}
  const content = isObject(candidate.content) ? candidate.content : {}
  const parts = Array.isArray(content.parts) ? content.parts : []
  return parts.filter(isObject).map((p) => p.audioTranscription).filter(isObject)
}

function hasAudioTranscription(body: unknown): boolean {
  return audioTranscriptionsOf(body).length > 0
}

/** The words alone, on no grid: what the provider hands a dedicated caller (`ProviderReply.wordTimings`). */
export function readAudioTranscriptionWords(body: unknown): ProviderWordTimings {
  const transcriptions = audioTranscriptionsOf(body)
  if (transcriptions.length === 0) return { ok: false, cause: 'shape' }
  const texts: string[] = []
  const words: TimedWord[] = []
  for (const t of transcriptions) {
    if (!Array.isArray(t.words)) return { ok: false, cause: 'shape' }
    if (typeof t.text === 'string') texts.push(t.text)
    for (const w of t.words) {
      const index = words.length
      if (!isObject(w) || typeof w.word !== 'string') return { ok: false, cause: 'shape', index }
      const from = DURATION.exec(String(w.startOffset ?? ''))
      const to = DURATION.exec(String(w.endOffset ?? ''))
      if (!from || !to) return { ok: false, cause: 'offset', index }
      words.push({ word: w.word, start: Number(from[1]), end: Number(to[1]) })
    }
  }
  return { ok: true, text: texts.join(' ').trim(), words }
}

// ── the client ──────────────────────────────────────────────────────────────

/**
 * A client that makes exactly one HTTP attempt per call, through the counted transport and nothing
 * else. `retryOptions` is never set, so the SDK's own retry loop (`apiCall`, five attempts on
 * 408/429/5xx when configured) stays off and every retry is NG's to count (D14-4, `R = 2`).
 * `timeout` is never set either: it would only arm undici, which this transport does not use.
 */
export function createGeminiClient(apiKey: string, transport: BoundedTransport, baseUrl?: string): GoogleGenAI {
  if (!isBoundedFetch(transport.fetch)) {
    throw new TransportRequestError('Gemini may only be called through the counted response transport.')
  }
  const httpOptions: { fetch: typeof fetch; baseUrl?: string } = { fetch: transport.fetch }
  if (baseUrl) httpOptions.baseUrl = baseUrl
  return new GoogleGenAI({ apiKey, httpOptions })
}

function noBody(result: BatchResult): ProviderReply {
  return { result, usage: null, envelope: null, detailKeys: [] }
}

/** What a transport failure may say about itself: never its message, which can echo a request. */
function networkCause(error: unknown): { name: string; code?: string } {
  const e = error as { name?: unknown; code?: unknown } | null
  const out: { name: string; code?: string } = { name: typeof e?.name === 'string' ? e.name : 'Error' }
  if (typeof e?.code === 'string') out.code = e.code
  return out
}

/**
 * The shipping engine's safety posture, sent on every request of both kinds (`helpers.py:227-250`,
 * attached at `main.py:248` and `:312`): the four adjustable categories at `BLOCK_NONE`, because a
 * film's dialogue is content to be transcribed or translated faithfully, not moderated. Sending fewer
 * would let Google's defaults block lines 1.1.0 delivers. Fixed per provider, so it is not a request
 * field; frozen so no caller can loosen or tighten it in place. Bundle G: a model that refuses
 * `BLOCK_NONE` gets the same four categories at `OFF` (`geminiSafetySettings`).
 */
export const GEMINI_SAFETY_SETTINGS: ReadonlyArray<Readonly<{ category: HarmCategory; threshold: HarmBlockThreshold }>> =
  Object.freeze(
    [
      HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      HarmCategory.HARM_CATEGORY_HARASSMENT,
      HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT
    ].map((category) => Object.freeze({ category, threshold: HarmBlockThreshold.BLOCK_NONE }))
  )

/** `BLOCK_NONE`, or `OFF` once Google has refused `BLOCK_NONE` for the model. */
export type GeminiSafetyPosture = 'BLOCK_NONE' | 'OFF'

/**
 * Models whose `BLOCK_NONE` Google rejected in this app session (Bundle G, R18-PR PR-4). In memory only:
 * a restart sends `BLOCK_NONE` again, and one rejection costs one resend.
 */
const offModels = new Set<string>()

function postureKey(model: string): string {
  return model.replace(/^models\//, '')
}

export function geminiSafetyPosture(model: string): GeminiSafetyPosture {
  return offModels.has(postureKey(model)) ? 'OFF' : 'BLOCK_NONE'
}

/**
 * The four categories at the model's posture: the one owner of what a request carries, read by both the
 * send (`sdkConfig`) and the count (`geminiRequestBody`), so a count and its send never differ. Only the
 * threshold ever changes; the categories are the shipping engine's.
 */
export function geminiSafetySettings(model: string): Array<{ category: HarmCategory; threshold: HarmBlockThreshold }> {
  const threshold = geminiSafetyPosture(model) === 'OFF' ? HarmBlockThreshold.OFF : HarmBlockThreshold.BLOCK_NONE
  return GEMINI_SAFETY_SETTINGS.map((s) => ({ category: s.category, threshold }))
}

/** Gates only: forget every model moved to `OFF`, so one gate's fallback never reaches another's request. */
export function resetGeminiSafetyPosture(): void {
  offModels.clear()
}

/** A marked rejection keeps its mark only for a `BLOCK_NONE` send; anything else is the ordinary stop. */
function unmarked(failure: BatchFailure): BatchFailure {
  if (failure.kind !== 'request-invalid' || !failure.safetyThreshold) return failure
  return { ok: false, kind: 'request-invalid', detailKeys: failure.detailKeys }
}

/**
 * PR-4: Google refused the safety thresholds of a `BLOCK_NONE` request, so the model sends `OFF` from now
 * on and the mark goes back to `retry.ts`, which sends once more. The same refusal of an `OFF` request has
 * nothing left to change and is unmarked.
 */
function settleSafetyRejection(model: string, sent: GeminiSafetyPosture, reply: ProviderReply): ProviderReply {
  const r = reply.result
  if (r.ok || r.kind !== 'request-invalid' || !r.safetyThreshold) return reply
  if (sent === 'OFF') return { ...reply, result: unmarked(r) }
  offModels.add(postureKey(model))
  return reply
}

function sdkConfig(request: ProviderRequest, signal: AbortSignal): GenerateContentConfig {
  const config: GenerateContentConfig = {
    abortSignal: signal,
    safetySettings: geminiSafetySettings(request.model)
  }
  if (request.systemInstruction !== undefined) config.systemInstruction = request.systemInstruction
  if (request.responseMimeType !== undefined) config.responseMimeType = request.responseMimeType
  if (request.responseJsonSchema !== undefined) config.responseJsonSchema = request.responseJsonSchema
  if (request.maxOutputTokens !== undefined) config.maxOutputTokens = request.maxOutputTokens
  if (request.temperature !== undefined) config.temperature = request.temperature
  if (request.topP !== undefined) config.topP = request.topP
  if (request.topK !== undefined) config.topK = request.topK
  if (request.thinking) {
    const thinking: ThinkingConfig = {}
    if (request.thinking.level !== undefined) thinking.thinkingLevel = request.thinking.level as ThinkingConfig['thinkingLevel']
    if (request.thinking.budget !== undefined) thinking.thinkingBudget = request.thinking.budget
    if (request.thinking.includeThoughts !== undefined) thinking.includeThoughts = request.thinking.includeThoughts
    config.thinkingConfig = thinking
  }
  if (request.serviceTier !== undefined) config.serviceTier = request.serviceTier as GenerateContentConfig['serviceTier']
  if (request.audioTranscription) {
    config.audioTranscriptionConfig = {
      wordTimestamp: request.audioTranscription.wordTimestamp,
      languageCodes: [...request.audioTranscription.languageCodes]
    }
  }
  return config
}

export interface GeminiProviderOptions {
  /** Gates only: a loopback server instead of Google. Enables plain http to loopback, nothing else. */
  baseUrl?: string
  /** Gates only: proxy settings and certificate files to route by, instead of this computer's. */
  network?: NetworkSources
}

/**
 * One `generateContent` call. The classification is made from the body the transport captured, not
 * from the SDK's typed projection, which drops unknown keys (§4b check 10). Precedence: an oversize
 * body, then the run's cancellation, then this request's deadline, then the captured response.
 */
export async function generateWithGemini(
  request: ProviderRequest,
  ctx: ProviderCallContext,
  options: GeminiProviderOptions = {}
): Promise<ProviderReply> {
  if (ctx.signal.aborted) return noBody({ ok: false, kind: 'cancelled' })
  const transport = createBoundedTransport({ limitBytes: ctx.responseLimitBytes, allowLoopbackHttp: Boolean(options.baseUrl), network: options.network })
  const deadline = new AbortController()
  let timedOut = false
  const timer =
    ctx.timeoutMs !== undefined && ctx.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          deadline.abort()
        }, ctx.timeoutMs)
      : null
  const signal = AbortSignal.any([ctx.signal, deadline.signal])
  const config = sdkConfig(request, signal)
  const sent: GeminiSafetyPosture = config.safetySettings?.[0]?.threshold === HarmBlockThreshold.OFF ? 'OFF' : 'BLOCK_NONE'
  let thrown: unknown = null
  try {
    await createGeminiClient(ctx.apiKey, transport, options.baseUrl).models.generateContent({
      model: request.model,
      contents: [...(request.history ?? []), { role: 'user', parts: request.parts }],
      config
    })
  } catch (e) {
    thrown = e
  } finally {
    if (timer) clearTimeout(timer)
  }
  const state = transport.state()
  if (state.failure?.kind === 'too-large') {
    return noBody({ ok: false, kind: 'response-too-large', limitBytes: state.failure.error.limitBytes })
  }
  if (ctx.signal.aborted) return noBody({ ok: false, kind: 'cancelled' })
  if (timedOut) return noBody({ ok: false, kind: 'timeout', stage: state.dispatched > 0 ? 'in-flight' : 'pre-dispatch' })
  const captured = state.captured
  if (captured) {
    const text = captured.body.toString('utf8')
    if (captured.status >= 200 && captured.status < 300) return parseGenerateContentText(text)
    return settleSafetyRejection(request.model, sent, classifyHttpFailure(captured.status, text, captured.headers['retry-after'] ?? null, ctx.keyIndex))
  }
  // A proxy or certificate setting that cannot be used fails before dispatch, and is still network.
  if (state.dispatched === 0 && state.failure?.kind !== 'error') return noBody({ ok: false, kind: 'request-invalid', detailKeys: [] })
  return noBody({ ok: false, kind: 'network', cause: networkCause(state.failure?.kind === 'error' ? state.failure.error : thrown) })
}

// ── counting the exact request (implementation_plan.md §12.6, Bundle F F3) ─────

/** The `ProviderRequest` fields `geminiRequestBody` represents. A request with any other field is not counted. */
const COUNTABLE_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'systemInstruction',
  'history',
  'parts',
  'responseMimeType',
  'responseJsonSchema',
  'maxOutputTokens',
  'temperature',
  'topP',
  'topK',
  'thinking',
  'serviceTier',
  'audioTranscription'
])

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com'
const GEMINI_API_VERSION = 'v1beta'

/**
 * The Developer API body `generateWithGemini` sends for `request`, field for field and in the SDK's own
 * key order (2.27.0 `generateContentParametersToMldev` / `generateContentConfigToMldev`): contents,
 * service tier, system instruction, safety settings, then the generation config. A gate compares it
 * byte for byte with what the SDK put on the wire, so the count and the send describe one request.
 */
export function geminiRequestBody(request: Readonly<ProviderRequest>): JsonObject {
  const body: JsonObject = {
    contents: [...(request.history ?? []), { role: 'user', parts: request.parts }].map((turn) => ({ parts: turn.parts, role: turn.role }))
  }
  if (request.serviceTier !== undefined) body.serviceTier = request.serviceTier
  if (request.systemInstruction !== undefined) body.systemInstruction = { parts: [{ text: request.systemInstruction }], role: 'user' }
  body.safetySettings = geminiSafetySettings(request.model).map((s) => ({ category: s.category, threshold: s.threshold }))
  const generationConfig: JsonObject = {}
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature
  if (request.topP !== undefined) generationConfig.topP = request.topP
  if (request.topK !== undefined) generationConfig.topK = request.topK
  if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens
  if (request.responseMimeType !== undefined) generationConfig.responseMimeType = request.responseMimeType
  if (request.responseJsonSchema !== undefined) generationConfig.responseJsonSchema = request.responseJsonSchema
  if (request.thinking) {
    const thinking: JsonObject = {}
    if (request.thinking.level !== undefined) thinking.thinkingLevel = request.thinking.level
    if (request.thinking.budget !== undefined) thinking.thinkingBudget = request.thinking.budget
    if (request.thinking.includeThoughts !== undefined) thinking.includeThoughts = request.thinking.includeThoughts
    generationConfig.thinkingConfig = thinking
  }
  if (request.audioTranscription) {
    generationConfig.audioTranscriptionConfig = {
      wordTimestamp: request.audioTranscription.wordTimestamp,
      languageCodes: [...request.audioTranscription.languageCodes]
    }
  }
  body.generationConfig = generationConfig
  return body
}

/**
 * Count the exact request `generate` would send: one no-retry REST `countTokens` call carrying it as
 * `generateContentRequest`. The locked SDK's `models.countTokens` cannot carry a system instruction or
 * generation config on the Developer API (2.27.0 `countTokensConfigToMldev` throws on both), so it
 * would count a different request. A request this module cannot represent is `unavailable` and nothing
 * is sent. Precedence as `generateWithGemini`: oversize, cancellation, deadline, then the answer.
 */
export async function countTokensWithGemini(
  input: CountTokensRequest,
  ctx: ProviderCallContext,
  options: GeminiProviderOptions = {}
): Promise<CountTokensResult> {
  const { request } = input
  if (Object.keys(request).some((k) => !COUNTABLE_REQUEST_FIELDS.has(k)) || !request.model) return { ok: false, unavailable: true }
  const failed = (failure: BatchFailure): CountTokensResult => ({ ok: false, failure })
  if (ctx.signal.aborted) return failed({ ok: false, kind: 'cancelled' })
  const transport = createBoundedTransport({ limitBytes: METADATA_RESPONSE_LIMIT_BYTES, allowLoopbackHttp: Boolean(options.baseUrl), network: options.network })
  const deadline = new AbortController()
  let timedOut = false
  const timer =
    ctx.timeoutMs !== undefined && ctx.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          deadline.abort()
        }, ctx.timeoutMs)
      : null
  const base = (options.baseUrl ?? GEMINI_API_BASE).replace(/\/+$/, '')
  const url = `${base}/${GEMINI_API_VERSION}/models/${encodeURIComponent(request.model)}:countTokens`
  const body = JSON.stringify({ generateContentRequest: { model: `models/${request.model}`, ...geminiRequestBody(request) } })
  let thrown: unknown = null
  try {
    await transport.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
      body,
      signal: AbortSignal.any([ctx.signal, deadline.signal])
    })
  } catch (e) {
    thrown = e
  } finally {
    if (timer) clearTimeout(timer)
  }
  const state = transport.state()
  if (state.failure?.kind === 'too-large') return failed({ ok: false, kind: 'response-too-large', limitBytes: state.failure.error.limitBytes })
  if (ctx.signal.aborted) return failed({ ok: false, kind: 'cancelled' })
  if (timedOut) return failed({ ok: false, kind: 'timeout', stage: state.dispatched > 0 ? 'in-flight' : 'pre-dispatch' })
  const captured = state.captured
  if (captured) {
    const text = captured.body.toString('utf8')
    if (captured.status < 200 || captured.status >= 300) {
      // A count moves no posture: only a send's refusal does, and is resent (PR-4).
      return failed(unmarked(classifyHttpFailure(captured.status, text, captured.headers['retry-after'] ?? null, ctx.keyIndex).result as BatchFailure))
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failed({ ok: false, kind: 'malformed', raw: '', cause: 'json' })
    }
    const total = isObject(parsed) ? parsed.totalTokens : undefined
    return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0
      ? { ok: true, totalTokens: total }
      : failed({ ok: false, kind: 'malformed', raw: '', cause: 'shape' })
  }
  if (state.dispatched === 0 && state.failure?.kind !== 'error') return failed({ ok: false, kind: 'request-invalid', detailKeys: [] })
  return failed({ ok: false, kind: 'network', cause: networkCause(state.failure?.kind === 'error' ? state.failure.error : thrown) })
}

// ── the model list (implementation_plan.md Step 4.1) ───────────────────────

/**
 * Every model the key can call `generateContent` on, every page of it, as gst 3.7.0 `getmodels`
 * asks (`main.py:520-532`): exact `generateContent` in `supportedActions`, `models/` stripped.
 *
 * The SDK's abort does not cancel the service request, so the pager is also raced against the
 * caller's signal and the deadline: once either fires, this settles and a later page is ignored.
 */
export async function listGeminiModels(ctx: ModelListContext, options: GeminiProviderOptions = {}): Promise<ModelListResult> {
  let pages = 0
  const failed = (failure: BatchFailure): ModelListResult => ({ ok: false, failure, pages })
  if (ctx.signal?.aborted) return failed({ ok: false, kind: 'cancelled' })
  const transport = createBoundedTransport({
    limitBytes: METADATA_RESPONSE_LIMIT_BYTES,
    allowLoopbackHttp: Boolean(options.baseUrl),
    network: options.network
  })
  const stop = new AbortController()
  let timedOut = false
  let release: () => void = () => {}
  const fenced = new Promise<'stopped'>((resolve) => {
    release = () => resolve('stopped')
  })
  const timer = setTimeout(() => {
    timedOut = true
    stop.abort()
    release()
  }, ctx.timeoutMs)
  const onAbort = (): void => {
    stop.abort()
    release()
  }
  ctx.signal?.addEventListener('abort', onAbort, { once: true })

  const models: ListedModel[] = []
  let thrown: unknown = null
  const consume = (async (): Promise<'done'> => {
    const pager = await createGeminiClient(ctx.apiKey, transport, options.baseUrl).models.list({
      config: { queryBase: true, abortSignal: stop.signal }
    })
    for (;;) {
      pages++
      for (const m of pager.page) {
        const name = typeof m?.name === 'string' ? m.name.trim() : ''
        const actions = Array.isArray(m?.supportedActions) ? m.supportedActions : []
        if (!name || !actions.includes('generateContent')) continue
        const listed: ListedModel = { id: name.replace(/^models\//, '') }
        if (typeof m.displayName === 'string') listed.displayName = m.displayName
        if (typeof m.inputTokenLimit === 'number') listed.inputTokenLimit = m.inputTokenLimit
        if (typeof m.outputTokenLimit === 'number') listed.outputTokenLimit = m.outputTokenLimit
        models.push(listed)
      }
      // An empty token would have the SDK fetch the first page again, forever.
      const token = (pager.params as { config?: { pageToken?: unknown } }).config?.pageToken
      if (stop.signal.aborted || typeof token !== 'string' || token === '') return 'done'
      await pager.nextPage()
    }
  })().catch((e: unknown) => {
    thrown = e
    return 'done' as const
  })

  let outcome: 'done' | 'stopped'
  try {
    outcome = await Promise.race([consume, fenced])
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', onAbort)
  }

  const state = transport.state()
  if (state.failure?.kind === 'too-large') return failed({ ok: false, kind: 'response-too-large', limitBytes: state.failure.error.limitBytes })
  if (ctx.signal?.aborted) return failed({ ok: false, kind: 'cancelled' })
  if (timedOut || outcome === 'stopped') return failed({ ok: false, kind: 'timeout', stage: state.dispatched > 0 ? 'in-flight' : 'pre-dispatch' })
  if (thrown === null) return { ok: true, models, pages }
  if (state.failure?.kind === 'error') return failed({ ok: false, kind: 'network', cause: networkCause(state.failure.error) })
  const captured = state.captured
  if (captured && (captured.status < 200 || captured.status >= 300)) {
    return failed(unmarked(classifyHttpFailure(captured.status, captured.body.toString('utf8'), captured.headers['retry-after'] ?? null, -1).result as BatchFailure))
  }
  if (captured) return failed({ ok: false, kind: 'malformed', raw: '', cause: 'shape' })
  if (state.dispatched === 0) return failed({ ok: false, kind: 'request-invalid', detailKeys: [] })
  return failed({ ok: false, kind: 'network', cause: networkCause(thrown) })
}

export function createGeminiProvider(options: GeminiProviderOptions = {}): GenerationProvider {
  return Object.freeze({
    id: GEMINI_PROVIDER_ID,
    capabilities: GEMINI_CAPABILITIES,
    generate: (request: ProviderRequest, ctx: ProviderCallContext) => generateWithGemini(request, ctx, options),
    countTokens: (input: CountTokensRequest, ctx: ProviderCallContext) => countTokensWithGemini(input, ctx, options),
    safetyPosture: geminiSafetyPosture
  })
}
