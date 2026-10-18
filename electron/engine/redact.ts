/**
 * The one redaction pass every persisted run artifact goes through (implementation_plan.md §10.4).
 *
 * Two layers, in this order, and neither replaces the other:
 *
 *  1. **Allow-list the projection's schema.** A field the schema does not name is not written, so a
 *     key that turns up somewhere unexpected — a nested provider field, a label nobody planned for —
 *     is dropped before any sweep runs. A deny-list of key *shapes* would fail the moment a provider
 *     changes its key format (BR-12).
 *  2. **Sweep the admitted values** for every configured secret, by exact match, longest first. This
 *     is 1.1.0's masked-command `extraSecrets` rule — same floor, same marker, same ordering — which
 *     outlived the command line it was written for (deleted at Step 4.5).
 *
 * The marker is fixed. It never encodes how long the secret was.
 */
import type { RunErrorKind, RunEvent } from '../shared/engineEvents'

/** What a redacted value is shown as. Distinctive enough to be obviously deliberate. */
export const REDACTION_MARK = '***'

/**
 * Shortest value swept for. A Gemini key is 39 characters, so nothing real is below this — while
 * blanket-replacing a two-character value would corrupt unrelated text (a language code, part of a
 * path) and protect nothing, turning a diagnostic into a puzzle.
 */
const MIN_SWEEP_LENGTH = 8

/**
 * The values worth sweeping for: trimmed, deduplicated, at least `MIN_SWEEP_LENGTH` long, longest
 * first. Longest first because the sweep rewrites the text it searches — a shorter secret that is a
 * prefix of a longer one would otherwise consume its opening characters and leave the rest standing
 * (SOL-09).
 */
export function sweepableSecrets(secrets: readonly (string | null | undefined)[]): string[] {
  return [...new Set(secrets.map((s) => (s ?? '').trim()).filter((s) => s.length >= MIN_SWEEP_LENGTH))].sort(
    (a, b) => b.length - a.length
  )
}

export interface Redactor {
  /** Sweep one string. */
  text(value: string): string
  /** How many distinct values this redactor hunts for. */
  readonly size: number
}

export function createRedactor(secrets: readonly (string | null | undefined)[]): Redactor {
  const sweepable = sweepableSecrets(secrets)
  return {
    size: sweepable.length,
    text(value: string): string {
      let out = value
      for (const secret of sweepable) out = out.split(secret).join(REDACTION_MARK)
      return out
    }
  }
}

/**
 * The schema of one persisted projection.
 *
 * `'string'` admits a string and sweeps it; `'number'` / `'boolean'` admit only that primitive; a
 * one-element array admits an array of that shape; an object admits exactly the named keys. Anything
 * else — a value of the wrong type, a key the schema does not name — is omitted rather than coerced.
 */
export type RedactShape =
  | 'string'
  | 'number'
  /** A number, or an explicit `null` where the contract uses null for "not known". */
  | 'number|null'
  | 'boolean'
  | readonly [RedactShape]
  | { readonly [key: string]: RedactShape }

/**
 * Project `value` through `shape`, then sweep every admitted string. Returns `undefined` when the
 * value itself does not fit the shape; a caller writing an artifact writes nothing in that case.
 */
export function redact(value: unknown, shape: RedactShape, redactor: Redactor): unknown {
  if (shape === 'string') return typeof value === 'string' ? redactor.text(value) : undefined
  if (shape === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  if (shape === 'number|null') return value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : undefined
  if (shape === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return undefined
    const inner = shape[0] as RedactShape
    return value.map((v) => redact(v, inner, redactor)).filter((v) => v !== undefined)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const fields = shape as { readonly [key: string]: RedactShape }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const projected = redact((value as Record<string, unknown>)[key], fields[key], redactor)
    if (projected !== undefined) out[key] = projected
  }
  return out
}

/** The console projection admits one thing per record: the line, as text. */
export const CONSOLE_LINE_SHAPE: RedactShape = 'string'

// ── The run record (`.run.jsonl`, Step 4.6) ─────────────────────────────────────────────────────
//
// Every field a row may carry, per event type. Absent here means never persisted: Quota Group labels
// (`quotaGroupLabel` on budgets and usage buckets), thought summaries and the effective description
// have no event field to arrive in or are left out, and no event carries request, response, prompt,
// subtitle or audio text.

const ERROR_KINDS: Record<RunErrorKind, true> = {
  blocked: true,
  auth: true,
  forbidden: true,
  unsupportedLocation: true,
  invalidRequest: true,
  quota: true,
  rateLimit: true,
  overload: true,
  network: true,
  timeout: true,
  responseTooLarge: true,
  inputLimit: true,
  malformed: true,
  countMismatch: true,
  refusedByApp: true,
  unknown: true
}

const RANGE_SHAPE: RedactShape = { from: 'number', to: 'number' }

const CONFIG_SHAPE: RedactShape = {
  provider: 'string',
  model: 'string',
  inputPaths: ['string'],
  outputPath: 'string',
  sourceLanguage: 'string',
  targetLanguage: 'string',
  requestedBatchSize: 'number',
  requestedChunkSeconds: 'number',
  thinkingLevel: 'string',
  thinkingBudget: 'number',
  serviceTier: 'string',
  generation: { temperature: 'number', topP: 'number', topK: 'number' },
  resumeFrom: 'number',
  resumeContextSize: 'number',
  credentialSlotCount: 'number',
  hasDescription: 'boolean',
  hasSystemPrompt: 'boolean',
  hasVideo: 'boolean',
  hasAudio: 'boolean',
  showTokenStats: 'boolean',
  writeTokenReport: 'boolean',
  progressLog: 'boolean',
  thoughtsLog: 'boolean',
  hebrewSpeakerRepair: 'boolean',
  hebrewMethodB: 'boolean',
  hebrewC1Spanish: 'boolean',
  hebrewC1Portuguese: 'boolean'
}

const USAGE_SHAPE: RedactShape = {
  promptTokens: 'number',
  thoughtTokens: 'number',
  outputTokens: 'number',
  totalTokens: 'number',
  requestCount: 'number',
  retryCount: 'number',
  billedButUnusableTokens: 'number',
  audioSecondsSubmitted: 'number',
  audioSecondsUsable: 'number',
  reRequestedAudioSeconds: 'number',
  buckets: [
    {
      model: 'string',
      requestKind: 'string',
      attempts: 'number',
      estimatedInputTokens: 'number',
      actualInputTokens: 'number',
      outputTokens: 'number',
      thoughtTokens: 'number',
      billedButUnusableTokens: 'number',
      retryReasons: Object.fromEntries(Object.keys(ERROR_KINDS).map((k) => [k, 'number'])) as Record<string, RedactShape>
    }
  ],
  translationPartitions: [
    { firstCueIndex: 'number', lastCueIndex: 'number', requestedLineCount: 'number', effectiveLineCount: 'number', reason: 'string' }
  ],
  costEstimate: 'number'
}

const WARNING_SHAPE: RedactShape = { code: 'string', message: 'string', range: RANGE_SHAPE, signals: ['string'] }

const ERROR_SHAPE: RedactShape = {
  kind: 'string',
  message: 'string',
  blockReason: 'string',
  blockScope: 'string',
  keyIndex: 'number',
  authReason: 'string',
  retryAfterMs: 'number',
  limitBytes: 'number',
  quotaDetails: [{ metric: 'string', limit: 'number', resetAt: 'string' }],
  detailKeys: ['string'],
  detail: 'string'
}

const BUDGET_SHAPE: RedactShape = { state: 'string', model: 'string', message: 'string', metric: 'string', untilEpochMs: 'number' }

export const RUN_RECORD_EVENT_SHAPES: Record<RunEvent['type'], RedactShape> = {
  started: { type: 'string', runId: 'string', kind: 'string', config: CONFIG_SHAPE, totalLines: 'number|null', totalUnits: 'number|null' },
  phase: { type: 'string', runId: 'string', phase: 'string', detail: 'string' },
  unit: {
    type: 'string',
    runId: 'string',
    index: 'number',
    total: 'number|null',
    state: 'string',
    lineRange: RANGE_SHAPE,
    attempt: 'number',
    audioSeconds: { done: 'number', total: 'number' }
  },
  lines: { type: 'string', runId: 'string', done: 'number', total: 'number|null' },
  usage: { type: 'string', runId: 'string', usage: USAGE_SHAPE, cumulative: 'boolean' },
  budget: { type: 'string', runId: 'string', budget: BUDGET_SHAPE },
  advice: { type: 'string', runId: 'string', state: 'string', requestedBatchSize: 'number', effectiveBatchSize: 'number', message: 'string' },
  log: { type: 'string', runId: 'string', stream: 'string', text: 'string' },
  warning: { type: 'string', runId: 'string', warning: WARNING_SHAPE },
  error: { type: 'string', runId: 'string', error: ERROR_SHAPE },
  finished: {
    type: 'string',
    runId: 'string',
    outcome: 'string',
    exitCode: 'number|null',
    reason: 'string',
    outputPath: 'string',
    partialPath: 'string',
    resumable: 'boolean',
    logPaths: ['string'],
    warnings: [WARNING_SHAPE],
    error: ERROR_SHAPE,
    usage: USAGE_SHAPE,
    budget: BUDGET_SHAPE
  }
}

/** One event as the run record may persist it; `undefined` for anything that is not a known event. */
export function runRecordEvent(event: unknown, redactor: Redactor): Record<string, unknown> | undefined {
  const type = (event as { type?: unknown } | null)?.type
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(RUN_RECORD_EVENT_SHAPES, type)) return undefined
  return redact(event, RUN_RECORD_EVENT_SHAPES[type as RunEvent['type']], redactor) as Record<string, unknown> | undefined
}
