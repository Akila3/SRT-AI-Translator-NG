/**
 * The typed run-event contract between an engine adapter and everything that consumes a run.
 *
 * Frozen at Phase 0 (implementation_plan.md §2.1, §2.1a, §2.3). Changing a shape here touches the
 * adapters, the IPC layer, the preload, `useRunner`, both run pages and gate section NG1 together.
 * Types only: this module has no runtime behaviour, so the renderer and main can both import it.
 */
import type { RunId, TerminalReason } from './types'

/** Both kinds share one channel, exactly as they share one today. */
export type RunKind = 'translate' | 'transcribe'

/**
 * Coarse lifecycle, and the reason it exists.
 *
 * Today `progress === 0 && status === 'running'` is the ONLY way the UI can say "started, but
 * nothing measurable yet", and both pages render an indeterminate bar from it. Under unit-based
 * progress, "unit 0 of N" is ambiguous with "not started", so the ambiguity must be carried by an
 * explicit value or the progress bar regresses. See BR-6.
 */
export type RunPhase =
  | 'starting'    // slot taken, nothing spawned or called yet
  | 'preparing'   // ffmpeg convert/extract, encoding normalise, key preflight
  | 'working'     // units in flight
  | 'finishing'   // writing output, reading it back

/** One unit of work: a translation batch, or a transcription chunk. */
export type UnitState = 'sending' | 'validating' | 'received' | 'retrying' | 'failed'

export interface LineRange {
  from: number
  to: number
}

export type UsageRequestKind = 'generation' | 'countTokens' | 'recovery'

export interface UsageBucket {
  /** Redacted display identity at dispatch time; never an API key or internal group id. */
  model: string
  quotaGroupLabel?: string
  requestKind: UsageRequestKind
  attempts: number
  estimatedInputTokens?: number
  actualInputTokens?: number
  outputTokens?: number
  thoughtTokens?: number
  billedButUnusableTokens?: number
  retryReasons?: Partial<Record<RunErrorKind, number>>
}

export interface TranslationPartitionUsage {
  firstCueIndex: number
  lastCueIndex: number
  requestedLineCount: number
  effectiveLineCount: number
  reason: 'saved' | 'countedInputLimit' | 'providerInputLimit'
}

export interface Usage {
  promptTokens: number
  thoughtTokens: number
  outputTokens: number
  totalTokens: number
  /** Native path only when known; CLI adapter may omit rather than infer from stdout. */
  requestCount?: number
  retryCount?: number
  /** Tokens billed on output the app could not use or deliberately discarded. */
  billedButUnusableTokens?: number
  /** Transcription accounting for Feature 5 / Bundle F cost per usable minute. */
  audioSecondsSubmitted?: number
  audioSecondsUsable?: number
  reRequestedAudioSeconds?: number
  /** Native cumulative safe aggregates; bounded by bucket shape, not one retained row per attempt. */
  buckets?: UsageBucket[]
  /** Final run-owned partition snapshot; carries indices/counts only, never cue text. */
  translationPartitions?: TranslationPartitionUsage[]
  /** Only when a price table for the model in use is available. Never guessed. */
  costEstimate?: number
}

/**
 * Why a run failed, as a fact rather than a matched string.
 *
 * `blocked` is the fork's central prize: 1.1.0 spends a whole parked design document
 * (`reference_1.1.0/parked_FP-9_prohibited_content.md`) failing to obtain it, because GST 3.8.3
 * never reads `block_reason` anywhere. Under NG it is a field on an object we hold.
 */
export type RunErrorKind =
  | 'blocked'        // the model refused. `blockReason` carries the API's own word
  | 'auth'           // invalid/revoked credential only. `keyIndex` names which one
  | 'forbidden'      // authenticated but not permitted
  | 'unsupportedLocation' // authenticated, but this service cannot run from the server/account location
  | 'invalidRequest' // model/capability/schema/settings defect; do not rotate a key
  | 'quota'          // structured capacity/daily quota. `retryAfterMs` when the API says
  | 'rateLimit'      // temporary provider rate pressure, distinct from exhausted quota
  | 'overload'       // transient server-side
  | 'network'        // DNS, TLS, reset, refused, unreachable
  | 'timeout'        // owned request deadline, distinct from DNS/refused
  | 'responseTooLarge' // local provider-body safety ceiling
  | 'inputLimit'     // allow-listed structured provider evidence; dormant: Google sends no such field (AS-F8-9, E160c)
  | 'malformed'      // a response we could not use
  | 'countMismatch'  // the count invariant tripped. ARCHITECTURE_TARGET.md §6.1
  | 'refusedByApp'   // model guard, no usable key, busy slot, stall budget
  | 'unknown'

export interface QuotaEvidenceDetail {
  metric: 'rpm' | 'tpm' | 'rpd' | 'other'
  limit?: number
  resetAt?: string
}

/** The two content-block causes `blocks.ts` can name (Step 3.2); anything else is the API's own word. */
export type BlockClass = 'PROHIBITED_CONTENT' | 'OTHER'

/**
 * Bundle G (D6-9 protection 1): why a cue was kept in its source language. Total and closed; every
 * reason is ineligible as context (`translationState.ts` `contextEligible`).
 */
export type PreservationReason = 'CONTENT_BLOCKED' | 'REASON_ABSENT' | 'UNPARSEABLE_REPLY' | 'BUDGET_FLOOR'

/** A kept-untranslated cue as a run discloses it. `reason` is `null` for a cue a Continue restored. */
export interface PreservedLine {
  index: number
  reason: PreservationReason | null
}

export interface RunError {
  kind: RunErrorKind
  /** One actionable sentence, already user-facing. Inherits the wording of classifyEngineFailure. */
  message: string
  /**
   * The refusal's cause. A `BlockClass` only when `blocks.ts` read it from the whole envelope (native
   * engine); otherwise the API's own word, e.g. 'SAFETY'. Never invented.
   */
  blockReason?: BlockClass | (string & {})
  /** Whether the block was on the prompt or the response. */
  blockScope?: 'prompt' | 'response'
  /** Which API key slot was rejected. */
  keyIndex?: number
  /** D14 provider distinction. Required on auth/forbidden/location projections. */
  authReason?: 'invalid' | 'permission' | 'unsupported-location'
  retryAfterMs?: number
  /** Present only for `responseTooLarge`; the applied local safety ceiling. */
  limitBytes?: number
  /** Bundle F: every allow-listed structured quota violation, never message-text inference. */
  quotaDetails?: QuotaEvidenceDetail[]
  /** Full REDACTED response key set captured before extraction; no prompt/key/body text. */
  detailKeys?: string[]
  /** Bounded redacted diagnostic detail; never a raw request/response or the primary message. */
  detail?: string
}

export type BudgetMetric = 'rpm' | 'tpm' | 'rpd' | 'retry' | 'other'
/** `groupSwitch` is emitted only for a budget wait/exhaustion route change, never ordinary auth fallback. */
export type BudgetState = 'ready' | 'waiting' | 'groupSwitch' | 'paidFallback' | 'dailyExhausted'
export type AdviceState = 'fit' | 'resized' | 'unavailable'

interface BudgetSnapshotBase {
  model: string
  quotaGroupLabel?: string
  /** Action copy only. Never embeds a captured remaining-duration number. */
  message: string
}

export type BudgetSnapshot =
  | (BudgetSnapshotBase & { state: 'ready'; metric?: never; untilEpochMs?: never })
  | (BudgetSnapshotBase & { state: 'waiting'; metric: BudgetMetric; untilEpochMs: number })
  | (BudgetSnapshotBase & { state: 'groupSwitch'; metric?: never; untilEpochMs?: never })
  | (BudgetSnapshotBase & { state: 'paidFallback'; metric?: never; untilEpochMs?: never })
  | (BudgetSnapshotBase & { state: 'dailyExhausted'; metric: 'rpd'; untilEpochMs?: number })

/**
 * Advisory notes about the output. Never blocks a save, never alters a file.
 *
 * `code` exists because TranslatePage currently splits the `warnings: string[]` array with
 * `/wrong timings/i` — a regex over our own copy, which breaks the moment someone rewords it.
 */
export type WarningCode =
  | 'filler'         // outputSanity S1/S2/S3 agreed: this text is not a translation
  | 'timing'         // alignment (REP-32): the text may be fine but sits on the wrong timings
  | 'fragment'       // the source's cues break mid-sentence
  | 'scriptMix'      // transcription produced a script the rest of the file does not use (H1, approach 2)
  | 'artifact'       // a requested report/log could not be created/finalised; subtitle output survives
  | 'notice'         // an engine advisory worth surfacing but not attributable to the output

/** The `notice` a completed transcription raises when it saved no cue; the Transcribe page ends amber on it. */
export const EMPTY_TRANSCRIPT_SIGNAL = 'empty transcript'
export const EMPTY_TRANSCRIPT_MESSAGE = 'No words were found in this audio, so the saved subtitle file is empty.'

export interface RunWarning {
  code: WarningCode
  /** User-facing text, as `warnings[]` already is today. */
  message: string
  range?: LineRange
  /** Which sanity signals tripped — preserves SanityWarning.signals for the log and the gates. */
  signals?: string[]
}

/** How a run ended. Deliberately excludes 'idle'/'running': the contract describes endings only. */
export type RunOutcome = 'completed' | 'failed' | 'stopped'

/**
 * IPC/JSONL-safe actual-run summary. It complements rather than replaces the richer readable-console
 * contract: the CLI console keeps its masked argv, while native console production separately receives
 * the redacted effective description text that current argv already stores.
 *
 * Values only, no credential, description/system-prompt text, subtitle/audio content, Quota Group
 * label or raw provider body. A new field is absent until the run-record allow-list admits it.
 */
export interface RunConfigurationSummary {
  provider: string
  model: string
  inputPaths: string[]
  outputPath: string
  sourceLanguage?: string
  targetLanguage?: string
  requestedBatchSize?: number
  requestedChunkSeconds?: number
  thinkingLevel?: string
  thinkingBudget?: number
  serviceTier?: string
  generation?: { temperature?: number; topP?: number; topK?: number }
  resumeFrom?: number
  resumeContextSize?: number
  /** Eligible slots supplied to the CLI/native engine, never their values; bounded by the five-slot UI. */
  credentialSlotCount: number
  hasDescription: boolean
  hasSystemPrompt: boolean
  hasVideo: boolean
  hasAudio: boolean
  showTokenStats: boolean
  writeTokenReport: boolean
  progressLog: boolean
  thoughtsLog: boolean
  /** Feature 17's four switches as the run froze them (false for Transcribe). Requested, not executed. */
  hebrewSpeakerRepair: boolean
  hebrewMethodB: boolean
  hebrewC1Spanish: boolean
  hebrewC1Portuguese: boolean
}

export type RunEvent =
  | {
      type: 'started'
      runId: RunId
      kind: RunKind
      /** Idea item 10 / DLOG-8: the persisted-safe facts the current masked command exposes. */
      config: RunConfigurationSummary
      /** null until known. The CLI adapter learns it from a log line; the native one knows it up front. */
      totalLines: number | null
      totalUnits: number | null
    }
  | { type: 'phase'; runId: RunId; phase: RunPhase; detail?: string }
  | {
      type: 'unit'
      runId: RunId
      /** One-based index of the currently reported unit. */
      index: number
      /**
       * Latest run-owned unit count. It may change when an unreserved queued tail is repartitioned,
       * but must remain >= index. StatusCard uses this pair instead of deriving native batches from
       * saved Settings.
       */
      total: number | null
      state: UnitState
      lineRange?: LineRange
      /** 1 on the first send. Replaces readRetryState's regex over the folded panel. */
      attempt?: number
      /**
       * Transcribe only: seconds of audio finished out of the file's total, as the engine reports
       * them. The Transcribe bar is time-based, not unit-based (a 5-minute chunk would otherwise sit
       * still for minutes), so without this the bar would regress from 1.1.0.
       * Tester-sanctioned amendment 2026-10-04 (gate_ledger.md §5.4); planner ratification owed.
       */
      audioSeconds?: { done: number; total: number }
    }
  | {
      /**
       * Line-granular progress, kept SEPARATE from `unit` deliberately.
       *
       * StatusCard shows "Lines translated" independently from the typed unit pair. Parity requires
       * the line view to survive even though the honest unit of work is a batch, so both are carried.
       * Dropping either would be a UI regression.
       */
      type: 'lines'
      runId: RunId
      done: number
      total: number | null
    }
  | { type: 'usage'; runId: RunId; usage: Usage; cumulative: boolean }
  | {
      /** Bundle F structured pacing state; never identified by parsing the message. */
      type: 'budget'
      runId: RunId
      budget: BudgetSnapshot
    }
  | {
      /** Translate-only optional request-size advice. `unavailable` is explicitly fail-open. */
      type: 'advice'
      runId: RunId
      state: AdviceState
      requestedBatchSize: number
      effectiveBatchSize?: number
      message: string
    }
  | { type: 'log'; runId: RunId; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'warning'; runId: RunId; warning: RunWarning }
  | { type: 'error'; runId: RunId; error: RunError }
  | {
      type: 'finished'
      runId: RunId
      outcome: RunOutcome
      /** Null under the native engine. Retained so the CLI adapter loses nothing. */
      exitCode: number | null
      /** Set only when the app, not the engine, ended the run. Unchanged from today. */
      reason?: TerminalReason
      outputPath: string
      /**
       * CARRY_FORWARD.md §4: a partial is named `<name>.partial.srt` and disclosed. Never presented
       * as complete. Lifecycle and promotion rules are §4.1a — set this ONLY for a file that has been
       * fsync'd and renamed into place.
       */
      partialPath?: string
      /**
       * Native only (Phase 3, AR3-6): true when this ending left a checkpoint-verified resumable
       * generation, so starting the same job again offers Continue. Absent means no such work.
       */
      resumable?: true
      /**
       * Bundle G: the cues the output keeps in their source language, by number, with why. Absent when
       * there are none. A save of a file holding any says how many before it completes.
       */
      preserved?: PreservedLine[]
      logPaths: string[]
      /** The final advisory set, so a consumer that missed the stream still has them. */
      warnings: RunWarning[]
      /**
       * The terminal error, repeated here. REQUIRED when outcome is 'failed', absent otherwise.
       *
       * Added 2026-09-10 (plan validation F3). Property 2 below argued the warning set must be
       * durable because a late consumer must still be correct — and then left the failure REASON
       * stream-only, which is the one thing a late consumer most needs. `finished` is the durable
       * snapshot; it has to be complete.
       */
      error?: RunError
      /** Final cumulative values for consumers that attached after the stream. */
      usage?: Usage
      /** Last safe budget state; contains no key, prompt, content or raw response. */
      budget?: BudgetSnapshot
    }

/**
 * What a provider can do, read by the UI to disable what a provider cannot do. It must never send
 * an option a provider will silently ignore.
 *
 * Per-model facts (structured output, timestamp granularity) live in `modelCaps.ts`; this
 * interface only says that they vary by model (D5-4). A bare per-provider boolean or enum for either
 * is wrong whichever value it takes, and the old `'second' | 'millisecond'` enum overstates the
 * measured 100 ms grid.
 */
export interface ProviderCapabilities {
  acceptsSystemPrompt: boolean
  acceptsContext: boolean
  acceptsReferenceTrack: boolean      // the gender oracle, FEATURES.md F1
  acceptsAudio: boolean
  transcribes: boolean

  // Per-model facts live in modelCaps.ts; provider capabilities expose only that they vary.
  structuredOutputVariesByModel: boolean
  timestampGranularityVariesByModel: boolean
  serviceTier: 'both' | 'translateOnly' | 'unsupported'
}
