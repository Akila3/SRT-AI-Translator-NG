/**
 * Native transcription and translation behind the typed engine boundary (implementation_plan.md
 * Steps 1.9 and 2.7). AUTHORED-BY: opus-5.5-high
 *
 * The same lifecycle as the CLI adapter (`cli/cliAdapter.ts` at `b6b75ae`) and the same preparation order as
 * 1.1.0's `startTranscribe` (`pythonBridge.ts:846-1048`): the runner's reservation mints the one
 * `started` through this run's binding; the key snapshot, the injected key preflight and every
 * ending follow, each with exactly one `finished`. What runs where gst ran is `transcribe.ts`.
 *
 * The request is the shipping engine's, measured rather than assumed (gate_ledger.md §5.24): gst
 * 3.7.0 sent one user turn holding only the inline `audio/mp3` part, its instruction as the system
 * instruction, the four adjustable safety categories at `BLOCK_NONE`, JSON mode with a three-field
 * schema, and its thinking config. The instruction differs only by the fidelity rule (Step 1.5).
 * Two differences, both planned: the reply is read whole rather than streamed (DECISIONS.md D4), and
 * the stored service tier is sent (N5).
 *
 * The run is a preparation step to the runner from first to last: it holds `j.prep` throughout, so
 * Stop aborts it and this path, not `killJob`, produces the ending. Every ffmpeg child is the
 * runner's (`j.prepChild`, SOL-02), and one that outlives its kill holds the run open.
 *
 * Everything the user is told is a `log` line, because Transcribe's always-visible panel is fed by
 * `log` events alone (`src/lib/useRunner.ts:208-209`) and Transcribe renders no warnings card
 * (PARITY_INVENTORY.md ES-P4). The console is a projection of those same events
 * (`runArtifacts.ts`), so the file and the panel say the same thing.
 *
 * Not here, by plan: the RTL embedding gst applied to Hebrew/Arabic cues (Bundle D, F8), and a token
 * report (Bundle F). Transcribe creates no `.progress.log` or `.thoughts.log` — those are Translate's.
 *
 * Translate follows `startTranslate` (`pythonBridge.ts`): the same staged output name, the busy
 * refusal, the key snapshot, the UTF-8 intake and the fragment note, in that order, then
 * `run.ts` in the reserved job. The model guard ran in `ipc` before either engine was chosen.
 *
 * SECURITY: keys are read from the run's arguments by slot at the moment of each call and nowhere
 * else. Every line and error this adapter says passes the run's redactor first.
 */
import fs from 'fs'
import path from 'path'
import type { ChildProcess } from 'child_process'
import type {
  BudgetSnapshot,
  RunConfigurationSummary,
  RunError,
  RunEvent,
  RunKind,
  RunOutcome,
  RunWarning,
  Usage
} from '../../shared/engineEvents'
import { gstLanguageName, langLabel, normalizeRtlLanguage } from '../../shared/languages'
import { isDedicatedTranscribeModel } from '../../shared/transcribeSettings'
import { bareLanguageCode, dedicatedTranscribeChunk, liveModelRefusal } from '../transcribeDedicated'
import { polishCueTexts } from '../polish'
import { modelCapabilities, modelRequestConfig, type ModelRequestConfig } from '../../shared/modelCaps'
import { withCostEstimate } from '../../shared/pricing'
import { sourceFragmentNote } from '../../shared/outputSanity'
import {
  DEFAULT_RESUME_CONTEXT_SIZE,
  RESUME_INVALID_REASON_COPY,
  type FailedSpanRetryDecision,
  type FfmpegProgress,
  type ResumeDecision,
  type TerminalReason,
  type TranscribeArgs,
  type TranslateArgs
} from '../../shared/types'
import type { ResumeGeneration, ResumeStore, TranscribeJournalInit, TranslateJournalInit } from '../../main/resumeStore'
import { sliceAudio } from '../../main/ffmpeg'
import { getSettings, recordQuotaEvidence } from '../../main/store'
import type { QuotaBudgetStore } from '../../main/quotaBudgetStore'
import { DEFAULT_QUOTA_GROUP_ID, quotaGroupRuntimeView } from '../../shared/quotaGroups'
import { createRequestAdvisor, type RequestAdvisor } from '../requestAdvisor'
import { createRequestBudget } from '../requestBudget'
import { alignSessionOf } from '../../main/alignService'
import { keepAcceptedReference, resolveReference, type WalkClient } from '../../main/referenceWalk'
import { sanitizeRtlMethod } from '../../main/migrations'
import type { RtlChoice } from '../rtl'
import { isVideoMedia } from '../../main/ffmpeg'
import { tempOutputPath, translateOutputPath } from '../../main/tempFiles'
import { readTranslateSource } from '../../main/translateSource'
import { keySlotsFor, noUsableApiKeyMessage, type KeyPreflight } from '../../main/keyPreflight'
import type { EngineAdapter, Emit, RunContext, StartedRun } from '../adapter'
import { createKeyRotation, rankedNativeSlots, runKeySlots } from '../keys'
import { transcribeInstruction, translationSnapshot } from '../prompt'
import { createGeminiProvider, parseTranscriptionResponse, transcriptionResponseFormat } from '../providers/gemini'
import { responseLimitBytes } from '../providers/responseLimit'
import type { BatchFailure, GenerationProvider, ProviderReply, ProviderRequest } from '../providers/types'
import { classifyBlock } from '../blocks'
import { createRedactor, redact, type RedactShape } from '../redact'
import { RetryBudget, withRetry, type AttemptGate, type RetryClock, type RetryPolicy } from '../retry'
import type { RunArtifactPreferences } from '../runArtifacts'
import {
  bindRun,
  currentEpoch,
  finishJob,
  frozenPreferencesFor,
  ownOrphan,
  releaseReservation,
  reserveJob,
  stillHasPrepChild,
  type Job,
  type RunBinding,
  type RunHandlers
} from '../runner'
import {
  ffmpegTranscriptionAudio,
  runTranscription,
  TRANSCRIBE_CHUNK_SECONDS,
  type ChunkOutcome,
  type TranscribeChunk,
  type TranscriptionAudio,
  type TranscriptionJournal,
  type TranscriptionResult
} from '../transcribe'
import type { OutputIo } from '../output'
import {
  canonicalJson,
  transcribeArgsFromConfig,
  transcribeResumeConfig,
  translateArgsFromConfig,
  translateResumeConfig,
  type TranscribeResumeConfig,
  type TranscriptCue
} from '../progress'
import {
  activeQuotaGroups,
  createRequestGate,
  createUsageAccount,
  nativeTranslateBatch,
  runTranslation,
  type RequestGateSettings,
  type TranslationAudio,
  type TranslationJournal,
  type TranslationResult,
  type UsageAccount,
  withUsageBuckets
} from '../run'
import { parseCues, type Cue } from '../srt'
import { decodeSubtitleBuffer } from '../subtitleInput'

export type NativePreflight = (apiKey: string, signal: AbortSignal) => Promise<KeyPreflight>

export interface NativeEngineDeps {
  /** The key check `ipc` supplies (`ipc.ts` `keyPreflight`), run inside the reserved job as the CLI's is. */
  preflight?: NativePreflight
  /** The page's conversion box (`ffmpeg:progress`, kind `convert`). */
  onProgress?: (p: FfmpegProgress) => void
  /** Gates: a loopback provider. Production is Gemini through the counted transport. */
  provider?: GenerationProvider
  /** Gates: scripted audio. Production cuts the user's file with ffmpeg. */
  audio?: (opts: { mediaFile: string; isVideo: boolean; job: Job }) => TranscriptionAudio
  /** Gates: scripted Translate audio. Production cuts `args.audioFile` with ffmpeg per batch. */
  translationAudio?: (opts: { audioFile: string; job: Job }) => TranslationAudio
  /**
   * Translate's output check on a completed run, as the CLI's (`ipc.ts` `scanOutputWarnings`):
   * the decoded source the engine read against the staged output (SOL-21). `text` is the verified
   * intake text, so the check never re-reads the user's file; `sourcePath` only names it.
   */
  scanOutput?: (sourcePath: string, outputPath: string, text: string) => readonly RunWarning[]
  /** The stored values main fills in (F6). */
  settings?: () => { serviceTier?: string; ffmpegPath?: string; rtlEnabled?: boolean; rtlMethod?: unknown }
  retry?: { policy?: Partial<RetryPolicy>; clock?: RetryClock }
  outputIo?: Partial<OutputIo>
  chunkSeconds?: number
  /**
   * Phase 3: the checkpoint owner (`ipc` passes `resumeStore()`). Without it a Translate run keeps
   * Phase 2's temporary output, a Transcribe run keeps Phase 1's partial, neither has a checkpoint,
   * and `args.resume` is not read.
   */
  resume?: ResumeStore
  /**
   * Bundle F: the Free-tier request record (`ipc` passes `quotaBudgetStoreAt(userData)`). With it a
   * Translate run routes through every ranked key behind the request gate (§12.4–§12.6); without it
   * (the gates' earlier runs) it keeps the two-slot rotation and sends unpaced.
   */
  quotaBudget?: () => QuotaBudgetStore
  /** Gates: the Settings the gate reads before each attempt. Production reads the store. */
  gateSettings?: () => RequestGateSettings
  /** Bundle H: the OpenSubtitles client captured at Start; null or absent when OpenSubtitles is off. */
  referenceClient?: WalkClient | null
  /** Gates: reads a chosen gender-reference file. Production reads the disk. */
  readReference?: (path: string) => Buffer
  /**
   * Gates: stages the automatic walk's accepted file and returns its path, or null when it cannot be written.
   * Production writes it to the app's scratch folder, where it outlives the run like a picker download.
   */
  stageReference?: (bytes: Buffer, name: string) => string | null
}

/** The file-system calls reference staging makes. Gates inject failures. */
export interface StageIo {
  readonly path: () => string
  readonly open: (file: string) => number
  readonly write: (fd: number, bytes: Buffer) => void
  readonly close: (fd: number) => void
  readonly remove: (file: string) => void
}

const STAGE_FS: StageIo = {
  path: () => tempOutputPath(`-reference-${Math.random().toString(36).slice(2, 8)}.srt`),
  open: (file) => fs.openSync(file, 'wx'),
  write: (fd, bytes) => fs.writeFileSync(fd, bytes),
  close: (fd) => fs.closeSync(fd),
  remove: (file) => fs.rmSync(file, { force: true })
}

/**
 * Stages the walk's accepted file in the scratch folder and returns its path, or null when it cannot. The file
 * is opened `wx`, so only a file this attempt created is ever removed: a failed write or close takes it away.
 */
export function stageReferenceFile(bytes: Buffer, io: StageIo = STAGE_FS): string | null {
  let file: string
  let fd: number
  try {
    file = io.path()
    fd = io.open(file)
  } catch {
    return null
  }
  try {
    io.write(fd, bytes)
    io.close(fd)
    return file
  } catch {
    try {
      io.close(fd)
    } catch {
      // Already closed, or the handle is gone; the removal below still runs.
    }
    try {
      io.remove(file)
    } catch {
      // A file that cannot be removed is left to the scratch folder's age-out.
    }
    return null
  }
}

/** How long one exact-count call may take before the advisor gives up and the batch goes at its planned size. */
const COUNT_TIMEOUT_MS = 30_000

/**
 * Translate's request-size advisor for one run (§12.7), or null when the provider cannot count. The
 * count goes through the first ranked key that holds one and is not reserved in the request record:
 * Google does not charge `countTokens` against the generation RPM or input TPM (E60e, measured
 * 2026-10-15, `probe_feature8_e60e_asf89.md` §2), so booking it would only take a real request's slot.
 * Every count that was sent is still noted in the run's account as a `countTokens` attempt, with no
 * tokens: its `totalTokens` is a measurement, not billed usage.
 */
function translateAdvisor(opts: {
  provider: GenerationProvider
  model: string
  slots: readonly number[]
  keys: readonly string[]
  settings: () => RequestGateSettings
  account: UsageAccount
}): { advisor: RequestAdvisor; groupId: () => string } | null {
  const countTokens = opts.provider.countTokens
  if (!countTokens) return null
  const safetyPosture = opts.provider.safetyPosture
  const listed = (Array.isArray(opts.settings().cachedModels) ? opts.settings().cachedModels : []).find((m) => m?.id === opts.model && m.source === 'live')
  const route = () => {
    const slot = opts.slots.find((sl) => (opts.keys[sl] ?? '') !== '')
    if (slot === undefined) return null
    return { slot, groupId: quotaGroupRuntimeView(opts.settings()).resolvedKeyGroupIds[slot] ?? DEFAULT_QUOTA_GROUP_ID }
  }
  return {
    groupId: () => route()?.groupId ?? DEFAULT_QUOTA_GROUP_ID,
    advisor: createRequestAdvisor({
      model: opts.model,
      inputTokenLimit: typeof listed?.inputTokenLimit === 'number' ? listed.inputTokenLimit : null,
      count: async (request, signal) => {
        const r = route()
        if (!r || signal.aborted) return { ok: false }
        const answer = await countTokens(
          { request },
          { apiKey: opts.keys[r.slot] ?? '', keyIndex: r.slot, signal, responseLimitBytes: responseLimitBytes({ outputTokenLimit: null }), timeoutMs: COUNT_TIMEOUT_MS }
        )
        const unsent = 'unavailable' in answer || (!answer.ok && answer.failure.kind === 'timeout' && answer.failure.stage === 'pre-dispatch')
        if (!unsent) {
          const s = opts.settings()
          const free = s.apiKeyTiers?.[r.slot] !== 'paid'
          const label = (Array.isArray(s.quotaGroups) ? s.quotaGroups : []).find((g) => g?.id === r.groupId)?.label
          opts.account.note({
            model: opts.model,
            ...(free ? { quotaGroupId: r.groupId, ...(typeof label === 'string' && label ? { quotaGroupLabel: label } : {}) } : {}),
            requestKind: 'countTokens',
            estimate: null,
            usage: null,
            failure: answer.ok ? null : answer.failure
          })
        }
        return answer.ok ? { ok: true, totalTokens: answer.totalTokens } : { ok: false }
      },
      ...(safetyPosture ? { posture: () => safetyPosture(opts.model) } : {})
    })
  }
}

/** 1.1.0's busy refusal, word for word (`pythonBridge.ts:780-783`). */
const BUSY_MESSAGE = 'A process is already running.'

const NOTHING_SENT = 'Nothing was sent.'
const CHOOSE_AGAIN = 'Start again to choose Continue or Start over.'

/** A retry as it crossed IPC. The size is judged against the recorded section, so it stays unchecked here. */
type RetryRequest = Omit<FailedSpanRetryDecision, 'batchSize'> & { batchSize: unknown }

/** The start decision as it crossed IPC, checked rather than trusted. Absent is `fresh`. */
function resumeDecisionOf(v: unknown): ResumeDecision | RetryRequest | null {
  if (v === undefined) return { action: 'fresh' }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (o.action === 'fresh') return keys.length === 1 ? { action: 'fresh' } : null
  if ((o.action === 'continue' || o.action === 'startOver') && typeof o.resumeId === 'string' && o.resumeId && keys.length === 2) {
    return { action: o.action, resumeId: o.resumeId }
  }
  if (
    o.action === 'retryFailedSpan' &&
    keys.length === 5 &&
    typeof o.resumeId === 'string' &&
    o.resumeId &&
    typeof o.model === 'string' &&
    o.model.trim() &&
    'batchSize' in o &&
    typeof o.useContext === 'boolean'
  ) {
    return { action: 'retryFailedSpan', resumeId: o.resumeId, model: o.model.trim(), batchSize: o.batchSize, useContext: o.useContext }
  }
  return null
}

/** The frozen run with the retry's run-local choices; the record's configuration is not changed. */
function retryArgsOf(base: TranslateArgs, retry: RetryRequest): TranslateArgs {
  return { ...base, model: retry.model, ...(Number.isSafeInteger(retry.batchSize) ? { batchSize: retry.batchSize as number } : {}) }
}

/** The description the prompt will carry, as the frozen configuration records it. */
function effectiveDescriptionOf(args: TranslateArgs): string {
  try {
    return translationSnapshot(args).description
  } catch {
    return ''
  }
}

const SUMMARY_SHAPE: RedactShape = {
  provider: 'string',
  model: 'string',
  inputPaths: ['string'],
  outputPath: 'string',
  requestedChunkSeconds: 'number',
  thinkingLevel: 'string',
  thinkingBudget: 'number',
  serviceTier: 'string',
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

/** What a native transcription sends, as safe values: no key, no description text, no content. */
export function nativeTranscribeConfig(
  args: TranscribeArgs,
  outputPath: string,
  request: ModelRequestConfig,
  slots: number,
  chunkSeconds: number,
  reports: Pick<RunArtifactPreferences, 'writeTokenReport'> | null = null
): RunConfigurationSummary {
  const video = isVideoMedia(args.mediaFile)
  const summary: RunConfigurationSummary = {
    provider: 'gemini',
    model: args.model,
    inputPaths: [args.mediaFile],
    outputPath,
    requestedChunkSeconds: chunkSeconds,
    ...(request.thinking?.level ? { thinkingLevel: request.thinking.level.toLowerCase() } : {}),
    ...(request.thinking?.budget !== undefined ? { thinkingBudget: request.thinking.budget } : {}),
    serviceTier: request.serviceTier ?? 'standard',
    credentialSlotCount: slots,
    hasDescription: !!args.description?.trim(),
    hasSystemPrompt: false,
    hasVideo: video,
    hasAudio: !video,
    showTokenStats: true,
    writeTokenReport: !!reports?.writeTokenReport,
    progressLog: false,
    thoughtsLog: false,
    hebrewSpeakerRepair: false,
    hebrewMethodB: false,
    hebrewC1Spanish: false,
    hebrewC1Portuguese: false
  }
  return redact(summary, SUMMARY_SHAPE, createRedactor(args.apiKeys)) as RunConfigurationSummary
}

const TRANSLATE_SUMMARY_SHAPE: RedactShape = {
  provider: 'string',
  model: 'string',
  inputPaths: ['string'],
  outputPath: 'string',
  sourceLanguage: 'string',
  targetLanguage: 'string',
  requestedBatchSize: 'number',
  thinkingLevel: 'string',
  thinkingBudget: 'number',
  serviceTier: 'string',
  generation: { temperature: 'number', topP: 'number', topK: 'number' },
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

/**
 * What a native translation sends, as safe values, in the CLI summary's terms (`cliAdapter.ts`
 * `translateConfig` at `b6b75ae`): languages by the names the prompt uses, the description and override as flags
 * only. Unlike the CLI the override is sent (N14).
 *
 * The three report flags are the run's frozen preferences — the values its artifact session obeys
 * (`runArtifacts.ts`), so the summary cannot claim a report the run will not write or deny one it
 * will. Without a runner record there is no session and no report. `showTokenStats` is always true:
 * the engine always reports usage, as the CLI always passes `--token-stats` (`pythonBridge.ts:519`);
 * the Setting only decides whether the page shows it.
 */
export function nativeTranslateConfig(
  args: TranslateArgs,
  outputPath: string,
  slots: number,
  reports: Pick<RunArtifactPreferences, 'writeTokenReport' | 'progressLog' | 'thoughtsLog'> | null
): RunConfigurationSummary {
  let snapshot: ReturnType<typeof translationSnapshot> | null = null
  try {
    snapshot = translationSnapshot(args)
  } catch {
    // The run refuses the same arguments before sending; the summary still describes the start.
  }
  const source = args.sourceLang && args.sourceLang !== 'auto' ? gstLanguageName(args.sourceLang) : ''
  const target = gstLanguageName(args.targetLang)
  const g = snapshot?.generation
  const generation =
    g && (g.temperature !== undefined || g.topP !== undefined || g.topK !== undefined)
      ? {
          ...(g.temperature !== undefined ? { temperature: g.temperature } : {}),
          ...(g.topP !== undefined ? { topP: g.topP } : {}),
          ...(g.topK !== undefined ? { topK: g.topK } : {})
        }
      : undefined
  const summary: RunConfigurationSummary = {
    provider: 'gemini',
    model: args.model,
    inputPaths: [args.inputFile, ...(args.audioFile ? [args.audioFile] : [])],
    outputPath,
    ...(source ? { sourceLanguage: source } : {}),
    ...(target ? { targetLanguage: target } : {}),
    requestedBatchSize: args.batchSize,
    ...(g?.thinking?.level ? { thinkingLevel: g.thinking.level.toLowerCase() } : {}),
    ...(g?.thinking?.budget !== undefined ? { thinkingBudget: g.thinking.budget } : {}),
    ...(generation ? { generation } : {}),
    serviceTier: g?.serviceTier ?? 'standard',
    credentialSlotCount: slots,
    hasDescription: !!snapshot?.description,
    hasSystemPrompt: !!args.systemPrompt?.trim(),
    hasVideo: !!args.videoFile,
    hasAudio: !!args.audioFile,
    showTokenStats: true,
    writeTokenReport: !!reports?.writeTokenReport,
    progressLog: !!reports?.progressLog,
    thoughtsLog: !!reports?.thoughtsLog,
    hebrewSpeakerRepair: args.hebrewSpeakerRepair === true,
    hebrewMethodB: args.hebrewMethodB === true,
    hebrewC1Spanish: args.hebrewC1Spanish === true,
    hebrewC1Portuguese: args.hebrewC1Portuguese === true
  }
  return redact(summary, TRANSLATE_SUMMARY_SHAPE, createRedactor(args.apiKeys)) as RunConfigurationSummary
}

/** Translate's audio side: each batch's span cut from the user's file, as gst cut it per batch. */
export function ffmpegTranslationAudio(opts: {
  audioFile: string
  ffmpegPath?: string
  onChild?: (child: ChildProcess) => void
}): TranslationAudio {
  return {
    slice: (startSeconds, endSeconds, signal) =>
      sliceAudio(opts.audioFile, startSeconds, endSeconds, {
        signal,
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.onChild ? { onChild: opts.onChild } : {})
      })
  }
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
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

/**
 * One chunk's request, sent until it succeeds or `retry.ts` says stop. A refusal comes back as a
 * `blocked` error for `transcribe.ts`'s recovery; an unusable reply fails the chunk without a resend
 * (the D14 §14.4 matrix; F16 records the difference from 3.7.0).
 */
export function nativeTranscribeChunk(opts: {
  provider: GenerationProvider
  model: string
  instruction: string
  config: ModelRequestConfig
  format: { responseMimeType: string; responseJsonSchema: unknown }
  granularityMs: number
  keys: readonly string[]
  slots: readonly number[]
  budget: RetryBudget
  retry?: { policy?: Partial<RetryPolicy>; clock?: RetryClock }
  say: (text: string) => void
  /** The run's request gate (`createRequestGate`): routing, pacing and the reservation against this model. */
  gate?: AttemptGate
}): TranscribeChunk {
  const rotation = createKeyRotation(opts.slots)
  const limitBytes = responseLimitBytes({ outputTokenLimit: null })
  return async ({ chunk, audio }, signal) => {
    const request: ProviderRequest = {
      model: opts.model,
      systemInstruction: opts.instruction,
      parts: [{ inlineData: { mimeType: audio.mimeType, data: audio.data.toString('base64') } }],
      responseMimeType: opts.format.responseMimeType,
      responseJsonSchema: opts.format.responseJsonSchema,
      ...(opts.config.thinking ? { thinking: { ...opts.config.thinking } } : {}),
      ...(opts.config.serviceTier ? { serviceTier: opts.config.serviceTier } : {})
    }
    const unusable: Usage[] = []
    const last: { reply: ProviderReply | null } = { reply: null }
    const outcome = await withRetry<TranscriptCue[]>({
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
        last.reply = reply
        const fail = (failure: BatchFailure) => {
          if (reply.usage) unusable.push(reply.usage)
          return { ok: false as const, failure, usage: reply.usage }
        }
        if (!reply.result.ok) return fail(reply.result)
        // An empty STOP is a successful answer with no lines (gate_ledger A32): the coverage gate
        // decides whether the audio was quiet or dropped, and recovery asks again if it was dropped.
        if (reply.result.text === '' && reply.result.finishReason === 'STOP') return { ok: true as const, value: [], usage: reply.usage }
        const parsed = parseTranscriptionResponse(reply.result.text, opts.granularityMs)
        if (!parsed.ok) {
          const cause = parsed.cause === 'json' ? 'json' : 'shape'
          return fail({ ok: false, kind: 'malformed', raw: '', cause, finishReason: reply.result.finishReason })
        }
        return { ok: true as const, value: parsed.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })), usage: reply.usage }
      }
    })
    const usage = sumUsage(outcome.usage)
    const wasted = sumUsage(!outcome.ok && outcome.discarded ? [...unusable, outcome.discarded] : unusable)
    const withWaste = usage && wasted ? { ...usage, billedButUnusableTokens: wasted.totalTokens } : usage
    if (outcome.ok) return { ok: true, cues: outcome.value, ...(withWaste ? { usage: withWaste } : {}), attempts: outcome.attempts } satisfies ChunkOutcome
    let error: RunError = outcome.error ?? { kind: 'unknown', message: 'The request was stopped.' }
    if (error.kind === 'blocked' && last.reply) {
      // The same one classifier Translate uses; the API's own word stays when it names neither.
      const cls = classifyBlock(last.reply)
      if (cls === 'PROHIBITED_CONTENT' || cls === 'OTHER') error = { ...error, blockReason: cls }
    }
    return { ok: false, error, ...(withWaste ? { usage: withWaste } : {}), attempts: outcome.attempts } satisfies ChunkOutcome
  }
}

/** What either run loop reports at its end. */
type RunResult = Partial<Pick<TranscriptionResult | TranslationResult, 'partialPath' | 'error' | 'usage'>> & {
  outcome: RunOutcome
  /** Translate (Phase 3): the ending left work its checkpoint holds for Continue. */
  resumable?: boolean
  /** Translate (Bundle G): the cues kept in their source language. */
  preserved?: TranslationResult['preserved']
}

type Say = (text: string, stream?: 'stdout' | 'stderr') => void

interface Session {
  handlers: RunHandlers
  binding: RunBinding
  /** Say one line to the panel and the console. */
  say: Say
  /** The run's own events, with a panel line for each thing the user must see. */
  emit: Emit
  /** A warning the panel has already been told in words; the page lists it, the ending repeats it. */
  warn(warning: RunWarning): void
  /**
   * What the ending reports once the job is finished. `scanned` are warnings found after the run
   * (Translate's output check); like the CLI's they reach the ending only, not the panel.
   */
  conclude(result: RunResult | null, failure: RunError | null, scanned?: readonly RunWarning[]): void
  abandon(err: unknown): void
  readonly closed: boolean
}

/** Transcribe's panel words for its own events. */
function transcribeWords(args: TranscribeArgs, chunkSeconds: number) {
  return (event: RunEvent, say: Say): void => {
    if (event.type === 'phase') {
      if (event.phase === 'preparing') say(isVideoMedia(args.mediaFile) ? `Extracting the audio from "${path.basename(args.mediaFile)}"…` : `Reading "${path.basename(args.mediaFile)}"…`)
      else if (event.phase === 'working') say(`Transcribing in parts of up to ${mmss(chunkSeconds)}.`)
      else if (event.phase === 'finishing') say('Saving the subtitle…')
    } else if (event.type === 'unit' && event.state === 'sending' && event.audioSeconds) {
      const start = event.audioSeconds.done
      const end = event.index === event.total ? event.audioSeconds.total : Math.min(start + chunkSeconds, event.audioSeconds.total)
      say(`Transcribing audio segment ${mmss(start)} to ${mmss(end)} (part ${event.index} of ${event.total}).`)
    }
  }
}

/** Translate's panel words for its own events. */
function translateWords(args: TranslateArgs) {
  return (event: RunEvent, say: Say): void => {
    if (event.type === 'phase') {
      if (event.phase === 'preparing') say(`Reading "${path.basename(args.inputFile)}"…`)
      else if (event.phase === 'finishing') say('Saving the translation…')
    } else if (event.type === 'lines' && event.done === 0) {
      say(`Translating ${event.total} lines in batches of up to ${args.batchSize}.`)
    } else if (event.type === 'unit' && event.state === 'sending' && event.lineRange) {
      const { from, to } = event.lineRange
      say(`Translating ${from === to ? `line ${from}` : `lines ${from}\u2013${to}`} (batch ${event.index} of ${event.total}).`)
    } else if (event.type === 'budget' && event.budget.message) {
      say(event.budget.message)
    }
  }
}

function openSession(
  kind: RunKind,
  ctx: RunContext,
  emit: Emit,
  apiKeys: readonly string[],
  configFor: (outputPath: string) => RunConfigurationSummary,
  words: (event: RunEvent, say: Say) => void
): Session {
  const redactor = createRedactor(apiKeys)
  let reserved = false
  let closed = false
  let reservedOutput = ''
  let refusal: string | null = null
  let lastErrorKind: RunError['kind'] | null = null
  let result: RunResult | null = null
  let failure: RunError | null = null
  let lastUsage: Usage | undefined
  let lastBudget: BudgetSnapshot | undefined
  // The ending repeats every warning the run raised, as the CLI's did (`cliAdapter.ts:311` at `b6b75ae`): the
  // page's list is replaced by `finished.warnings`, not added to.
  const warnings: RunWarning[] = []
  let scannedWarnings: RunWarning[] = []

  // A Quota Group label is the user's own text: swept for every configured key before it leaves (§12.10).
  const safeUsage = (u: Usage): Usage =>
    u.buckets ? { ...u, buckets: u.buckets.map((b) => (b.quotaGroupLabel ? { ...b, quotaGroupLabel: redactor.text(b.quotaGroupLabel) } : b)) } : u
  const clean = <T extends RunEvent>(event: T): T => {
    if (event.type === 'log') return { ...event, text: redactor.text(event.text) }
    if (event.type === 'error') return { ...event, error: { ...event.error, message: redactor.text(event.error.message) } }
    if (event.type === 'warning') return { ...event, warning: { ...event.warning, message: redactor.text(event.warning.message) } }
    if (event.type === 'budget' && event.budget.quotaGroupLabel) return { ...event, budget: { ...event.budget, quotaGroupLabel: redactor.text(event.budget.quotaGroupLabel) } }
    if (event.type === 'usage') return { ...event, usage: safeUsage(event.usage) }
    if (event.type === 'finished' && event.usage) return { ...event, usage: safeUsage(event.usage) }
    return event
  }
  const send = (event: RunEvent): void => {
    if (closed) return
    const safe = clean(event)
    if (safe.type === 'error') lastErrorKind = safe.error.kind
    if (safe.type === 'usage') lastUsage = safe.usage
    if (safe.type === 'budget') lastBudget = safe.budget
    if (safe.type === 'warning') warnings.push(safe.warning)
    try {
      emit(safe)
    } catch (err) {
      console.error('[engine] event consumer threw:', err)
    }
  }
  const say = (text: string, stream: 'stdout' | 'stderr' = 'stdout'): void => {
    if (reserved) send({ type: 'log', runId: ctx.runId, stream, text })
  }

  /** The run loop's events, plus the panel's words for each. */
  const runEmit: Emit = (event) => {
    send(event)
    if (event.type === 'warning') say(event.warning.message, 'stderr')
    else if (event.type === 'error') say(event.error.message, 'stderr')
    else words(event, say)
  }

  const close = (event: Extract<RunEvent, { type: 'finished' }>): void => {
    if (event.error && event.error.kind !== lastErrorKind) send({ type: 'error', runId: ctx.runId, error: event.error })
    send(event)
    closed = true
  }

  const binding: RunBinding = {
    ctx,
    started: (outputPath) => {
      if (reserved || closed) return
      reserved = true
      reservedOutput = outputPath
      send({ type: 'started', runId: ctx.runId, kind, config: configFor(outputPath), totalLines: null, totalUnits: null })
    }
  }

  const handlers: RunHandlers = bindRun(
    {
      // Lines the runner itself says (a process that would not stop, an orphan that exited).
      onOutput: (stream: 'stdout' | 'stderr', line: string) => {
        if (closed) return
        if (!reserved) {
          if (line.trim()) refusal = line.trim()
          return
        }
        say(line, stream)
      },
      onDone: (_code: number | null, outputPath: string, reason?: TerminalReason) => {
        if (closed) return
        if (!reserved) {
          close({
            type: 'finished',
            runId: ctx.runId,
            outcome: 'failed',
            exitCode: null,
            ...(reason ? { reason } : {}),
            outputPath,
            logPaths: [],
            warnings: [],
            error: { kind: 'refusedByApp', message: refusal ?? 'The run could not start.' }
          })
          return
        }
        // 1.1.0's `terminalState`: only the user's Stop is `stopped`; any other app reason failed.
        // A Stop that lands after the destination was replaced is too late to stop anything: the
        // subtitle is saved, and calling it stopped would tell the user nothing was written.
        const savedBeforeStop = reason === 'user' && result?.outcome === 'completed'
        const outcome = savedBeforeStop ? 'completed' : reason === 'user' ? 'stopped' : reason ? 'failed' : result?.outcome ?? 'failed'
        const error =
          outcome === 'failed'
            ? result?.error ??
              failure ?? { kind: 'unknown' as const, message: `The ${kind === 'translate' ? 'translation' : 'transcription'} ended without a result.` }
            : undefined
        const usage = result?.usage ?? lastUsage
        close({
          type: 'finished',
          runId: ctx.runId,
          outcome,
          exitCode: null,
          ...(reason ? { reason } : {}),
          outputPath,
          ...(result?.partialPath ? { partialPath: result.partialPath } : {}),
          ...(outcome !== 'completed' && result?.resumable ? { resumable: true as const } : {}),
          ...(result?.preserved?.length ? { preserved: result.preserved.map((p) => ({ ...p })) } : {}),
          logPaths: [],
          warnings: [...warnings, ...(outcome === 'completed' ? scannedWarnings : [])],
          ...(error ? { error: { ...error, message: redactor.text(error.message) } } : {}),
          ...(usage ? { usage: { ...usage } } : {}),
          // The last pacing state, so a page that missed the events still shows a daily stop.
          ...(lastBudget ? { budget: { ...lastBudget } } : {})
        })
      }
    },
    binding
  )

  return {
    handlers,
    binding,
    say,
    emit: runEmit,
    warn(warning) {
      if (reserved) send({ type: 'warning', runId: ctx.runId, warning })
    },
    conclude(r, f, scanned = []) {
      result = r
      failure = f
      scannedWarnings = scanned.map((w) => ({ ...w, message: redactor.text(w.message) }))
    },
    abandon(err) {
      releaseReservation(binding)
      if (closed) return
      close({
        type: 'finished',
        runId: ctx.runId,
        outcome: 'failed',
        exitCode: null,
        outputPath: reservedOutput,
        logPaths: [],
        warnings: [...warnings],
        error: { kind: 'unknown', message: redactor.text(err instanceof Error ? err.message : String(err)) }
      })
    },
    get closed() {
      return closed
    }
  }
}

export function createNativeEngineAdapter(deps: NativeEngineDeps = {}): EngineAdapter {
  const settingsOf = deps.settings ?? (() => {
    const s = getSettings()
    return { serviceTier: s.serviceTier, ffmpegPath: s.ffmpegPath, rtlEnabled: s.rtlEnabled, rtlMethod: s.rtlMethod }
  })
  const chunkSeconds = deps.chunkSeconds ?? TRANSCRIBE_CHUNK_SECONDS

  return {
    async translate(args, ctx, emit): Promise<StartedRun> {
      const stored = settingsOf()
      // Ranked once, when the slot is taken (SOL-31), as `startTranslate` does.
      const keySnapshot = keySlotsFor(args.apiKeys)
      const slots = deps.quotaBudget ? rankedNativeSlots(keySnapshot) : runKeySlots('translate', keySnapshot)
      // Phase 3 (Step 3.4): with a resume store the run writes inside its generation — the offer's for
      // Continue, a new one otherwise — so the console and reports sit beside its private completion
      // target from the reservation on. Without one (the gates' Phase-2 runs) it keeps the temp name.
      const store = deps.resume ?? null
      const decision = store ? resumeDecisionOf(args.resume) : null
      let allocated: string | null = null
      let workDir: string | null = null
      let runArgs = args
      if (store && decision) {
        if (decision.action === 'continue' || decision.action === 'retryFailedSpan') {
          workDir = store.currentOffer(decision.resumeId)?.dir ?? null
          // Described as it will run; the record is judged again inside the slot before anything is sent.
          const frozen = store.offerConfig(decision.resumeId)
          if (frozen?.kind === 'translate') runArgs = translateArgsFromConfig(frozen, args)
          if (decision.action === 'retryFailedSpan') runArgs = retryArgsOf(runArgs, decision)
        } else {
          try {
            allocated = store.allocate().dir
            workDir = allocated
          } catch {
            /* refused inside the slot */
          }
        }
      }
      const outputPath = store && workDir ? store.translateCompletionPath(workDir) : translateOutputPath(args.inputFile)
      const session = openSession('translate', ctx, emit, args.apiKeys, (op) => nativeTranslateConfig(runArgs, op, slots.length, frozenPreferencesFor(ctx)), translateWords(runArgs))
      try {
        const j = reserveJob(session.handlers, outputPath)
        if (!j) {
          if (store && allocated) store.release(allocated)
          session.handlers.onOutput('stderr', BUSY_MESSAGE)
          session.handlers.onDone(-1, outputPath)
          return { outputPath, logPaths: [] }
        }
        /** `guard` marks the app's own refusal; 1.1.0's unreadable-subtitle ending carried no reason. */
        const refuse = (message: string, guard = true): StartedRun => {
          j.prep = null
          j.handlers.onOutput('stderr', message)
          session.conclude(null, { kind: 'refusedByApp', message })
          if (guard) j.endReason = 'guard'
          finishJob(j, null)
          return { outputPath, logPaths: [] }
        }
        session.say(`Translating "${path.basename(args.inputFile)}" with ${runArgs.model} (native engine).`)

        if (slots.length === 0) return refuse(noUsableApiKeyMessage(keySnapshot))
        if (args.resumeFrom && args.resumeFrom > 0) {
          return refuse('The native engine cannot resume a translation yet. Nothing was sent. Start from the first line.')
        }
        if (store && !decision) return refuse(`The start request was not understood. ${NOTHING_SENT}`)
        if (store && decision && !workDir) {
          return refuse(
            decision.action === 'continue' || decision.action === 'retryFailedSpan'
              ? `${RESUME_INVALID_REASON_COPY.generationStale} ${CHOOSE_AGAIN} ${NOTHING_SENT}`
              : `The app could not prepare a folder for this translation's resumable work. ${NOTHING_SENT}`
          )
        }
        // Bundle A's one verified read (`readTranslateSource`): the bytes the page inspected, or a typed
        // refusal. Everything below uses `source.text`; nothing re-opens the user's file.
        const source = readTranslateSource(args)
        if (!source.ok) return refuse(source.error, false)
        // A diagnostic, never a gate: a parse that fails must not skip the run (REP-32).
        // Said on stdout as 1.1.0's `startTranslate` said it, and raised as a warning so the
        // page shows it while the raw log is hidden.
        try {
          const note = sourceFragmentNote(source.text)
          if (note) {
            j.handlers.onOutput('stdout', note)
            session.warn({ code: 'fragment', message: note })
          }
        } catch {
          // ignore
        }

        // From here to the ending the whole run is the preparation step Stop interrupts — including the
        // whole-input hashing that identifies the job, which can take minutes for a film.
        const prep = new AbortController()
        j.prep = prep
        const signal = AbortSignal.any([ctx.signal, prep.signal])
        const ffmpegPath = (args.ffmpegPath || stored.ffmpegPath || '').trim() || undefined
        let sourceText = source.text
        let journal: TranslationJournal | undefined
        if (store && decision && workDir) {
          // A Stop before the run leaves the offered work as it was, unless Start over has discarded it.
          let kept = decision.action !== 'fresh'
          const stoppedBefore = (): StartedRun => {
            j.prep = null
            session.conclude(kept ? { outcome: 'stopped', resumable: true } : null, null)
            if (j.finished) return { outputPath, logPaths: [] }
            j.handlers.onOutput('stderr', 'Stopped.')
            finishJob(j, null)
            return { outputPath, logPaths: [] }
          }
          const halted = () => signal.aborted || !!j.endReason || j.finished
          const inputKind = args.streamIndex !== undefined && args.videoFile ? 'extractedTrack' : 'subtitleFile'
          const run = await store.identifyRun({
            inputKind,
            subtitle: { path: source.receipt.path, bytes: source.buffer },
            ...(inputKind === 'extractedTrack' ? { containerFile: args.videoFile, streamIndex: args.streamIndex } : {}),
            ...(args.audioFile ? { audioFile: args.audioFile } : {}),
            targetLang: args.targetLang,
            signal
          })
          if (halted()) return stoppedBefore()
          if (!run) return refuse(`A selected input could not be read to check for saved work. ${NOTHING_SENT}`)
          const parsedSource = parseCues(source.text, { path: args.inputFile })
          let create = {
            jobKey: run.identity.jobKey,
            hint: run.identity.hint,
            sources: run.sources,
            config: translateResumeConfig(args, {
              inputKind,
              streamIndex: inputKind === 'extractedTrack' ? (args.streamIndex ?? null) : null,
              sourceEncoding: source.receipt.encoding,
              resumeContextSize: args.resumeContextSize ?? DEFAULT_RESUME_CONTEXT_SIZE,
              effectiveDescription: effectiveDescriptionOf(args),
              ffmpeg: args.audioFile ? await store.probeFfmpeg(ffmpegPath) : null
            })
          }
          if (halted()) return stoppedBefore()
          let generation: ResumeGeneration | null = null
          let sourceCues: readonly Cue[] = parsedSource.ok ? parsedSource.cues : []
          let restored: TranslateJournalInit['restored'] = []
          if (decision.action === 'startOver') {
            const over = await store.startOver(decision.resumeId)
            if (!over.ok) return refuse(`${over.message} ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
            kept = false
            for (const file of over.preserved) session.say(`Kept "${file}": it changed outside the app, so Start over left it in place.`, 'stderr')
          }
          let retry: TranslateJournalInit['retry']
          if (decision.action === 'continue' || decision.action === 'retryFailedSpan') {
            const judged = await store.revalidate(decision.resumeId, run.identity, ffmpegPath)
            if (halted()) return stoppedBefore()
            if (judged.kind === 'invalid') return refuse(`${RESUME_INVALID_REASON_COPY[judged.reason]} ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
            const cp = judged.judged.checkpoint
            const coverage = judged.judged.working.coverage
            if (cp.config.kind !== 'translate' || coverage.kind !== 'translate') {
              return refuse(`${RESUME_INVALID_REASON_COPY.checkpointCorrupt} ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
            }
            const span = coverage.failedSpan
            if (decision.action === 'continue' && span) {
              return refuse(`The failed subtitle section must be retried before the rest continues. Start again and choose Continue to review retry settings. ${NOTHING_SENT}`)
            }
            if (decision.action === 'retryFailedSpan') {
              // AR3-7: only the recorded section, at most its parent's size, and context only if it had one.
              if (!span) return refuse(`This saved work has no failed section to retry. ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
              const most = Math.min(span.parentBatchSize, span.toCue - span.fromCue + 1)
              const size = decision.batchSize
              if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > most) {
                return refuse(`The retry batch size must be a whole number from 1 to ${most}. ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
              }
              if (decision.useContext && span.context.kind === 'none') {
                return refuse(`The failed section was sent without previous context, so its retry cannot include any. ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
              }
              if (!modelCapabilities(decision.model).structuredOutput) {
                return refuse(`"${decision.model}" cannot translate subtitles here. Choose another model. ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
              }
              retry = { model: decision.model, batchSize: size, useContext: decision.useContext }
            }
            generation = await store.adopt(judged.dir, judged.judged)
            const rows = generation?.restoredRows(judged.judged.sourceCues ?? []) ?? null
            if (!generation || !rows) return refuse(`${RESUME_INVALID_REASON_COPY.outputChanged} ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
            const config = cp.config
            runArgs = translateArgsFromConfig(config, args)
            if (decision.action === 'retryFailedSpan') runArgs = retryArgsOf(runArgs, decision)
            sourceText = decodeSubtitleBuffer(source.buffer, config.sourceEncoding)
            sourceCues = judged.judged.sourceCues ?? []
            restored = rows
            create = { jobKey: cp.jobKey, hint: run.identity.hint, sources: cp.sources, config }
          } else if (await store.hasOpenGeneration(run.identity)) {
            return refuse(`Unfinished work exists for this subtitle and target language. ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
          }
          if (halted()) return stoppedBefore()
          journal = store.translateJournal({
            dir: workDir,
            generation,
            create,
            sourceCues,
            restored,
            firstContextSize: decision.action === 'continue' ? create.config.resumeContextSize : null,
            ...(retry ? { retry } : {})
          })
        }
        const onChild = (child: ChildProcess): void => {
          if (!j.finished) j.prepChild = child
        }
        const audio = runArgs.audioFile
          ? deps.translationAudio?.({ audioFile: runArgs.audioFile, job: j }) ??
            ffmpegTranslationAudio({ audioFile: runArgs.audioFile, ffmpegPath, onChild })
          : undefined
        const budget = new RetryBudget()
        const keyValues = args.apiKeys.map((k) => (typeof k === 'string' ? k.trim() : ''))
        const provider = deps.provider ?? createGeminiProvider()
        const gateSettings = deps.gateSettings ?? getSettings
        const requestBudget = deps.quotaBudget ? createRequestBudget({ journal: deps.quotaBudget(), settings: gateSettings }) : null
        const counted = { tokens: null as number | null }
        const account = createUsageAccount()
        const gate = requestBudget
          ? createRequestGate({
              runId: ctx.runId,
              model: runArgs.model,
              requestKind: 'generation',
              keys: keyValues,
              settings: gateSettings,
              budget: requestBudget,
              revisions: ctx.settingsRevisions,
              registry: activeQuotaGroups,
              onBudget: (snapshot) => session.emit({ type: 'budget', runId: ctx.runId, budget: snapshot }),
              learn: recordQuotaEvidence,
              estimate: () => counted.tokens,
              account
            })
          : undefined
        const advice = requestBudget
          ? translateAdvisor({ provider, model: runArgs.model, slots, keys: keyValues, settings: gateSettings, account })
          : null
        let result: TranslationResult
        try {
          result = await runTranslation({
            runId: ctx.runId,
            args: runArgs,
            outputPath,
            ...(journal ? { journal } : {}),
            signal,
            isCurrent: () => !j.finished && currentEpoch() === ctx.epoch,
            emit: session.emit,
            translateBatch: nativeTranslateBatch({
              provider,
              keys: keyValues,
              slots,
              budget,
              ...(deps.retry ? { retry: deps.retry } : {}),
              ...(gate ? { gate, counted } : {})
            }),
            ...(advice ? { advisor: advice.advisor, adviceGroupId: advice.groupId } : {}),
            retryBudget: budget,
            ...(deps.retry ? { resend: deps.retry } : {}),
            ...(audio ? { audio } : {}),
            registerScratch: (file) => j.scratch.push(file),
            releaseScratch: (file) => {
              j.scratch = j.scratch.filter((f) => f !== file)
            },
            ...(deps.outputIo ? { outputIo: deps.outputIo } : {}),
            ...(runArgs.genderReference
              ? {
                  reference: (cues: readonly Cue[], sig: AbortSignal) =>
                    resolveReference(runArgs.genderReference!, cues, { client: deps.referenceClient ?? null, ...(deps.readReference ? { readFile: deps.readReference } : {}) }, sig).then(
                      // §3.3: the walk's file fills the page's reference field, as a picker download does.
                      (ref) => keepAcceptedReference(ctx.runId, ref, deps.stageReference ?? ((bytes) => stageReferenceFile(bytes)))
                    )
                }
              : {}),
            readSource: () => sourceText
          })
        } finally {
          j.prep = null
          advice?.advisor.clear()
          activeQuotaGroups.release(ctx.runId)
        }
        // The text the engine read against what it wrote (SOL-21).
        const scanned = result.outcome === 'completed' && deps.scanOutput ? deps.scanOutput(source.receipt.path, outputPath, sourceText) : []
        const bucketed = withUsageBuckets(result.usage, account.buckets())
        session.conclude(bucketed === result.usage ? result : { ...result, usage: withCostEstimate(bucketed, runArgs.model, runArgs.serviceTier) }, null, scanned)
        if (j.finished) return { outputPath, logPaths: [] }
        if (j.endReason && stillHasPrepChild(j)) {
          j.handlers.onOutput(
            'stderr',
            'An ffmpeg process from this run did not stop. This run stays open until it exits, because ' +
              'starting another one now would run two over the same files.'
          )
          ownOrphan(j, j.prepChild ?? undefined)
          return { outputPath, logPaths: [] }
        }
        j.prepChild = null
        if (result.outcome === 'completed') {
          j.handlers.onOutput('stdout', `Translated ${result.translatedCount} lines.`)
        } else if ((result.outcome === 'stopped' && !result.paused) || j.endReason) {
          j.handlers.onOutput('stderr', 'Stopped.')
        }
        finishJob(j, null)
        return { outputPath, logPaths: [] }
      } catch (err) {
        session.abandon(err)
        throw err
      }
    },

    async transcribe(args, ctx, emit): Promise<StartedRun> {
      const stored = settingsOf()
      // Phase 3 (Step 3.6): with a resume store, Continue runs the offer's frozen behaviour — described
      // as it will run from the reservation on, and judged again inside the slot before anything is sent.
      const store = deps.resume ?? null
      const decision = store ? resumeDecisionOf(args.resume) : null
      let runArgs = args
      let runChunkSeconds = chunkSeconds
      let frozen: TranscribeResumeConfig | null = null
      let workDir: string | null = null
      let allocated: string | null = null
      if (store && decision) {
        if (decision.action === 'continue') {
          workDir = store.currentOffer(decision.resumeId)?.dir ?? null
          const config = store.offerConfig(decision.resumeId)
          if (config?.kind === 'transcribe') {
            frozen = config
            runArgs = transcribeArgsFromConfig(config, args)
            runChunkSeconds = config.chunkSeconds
          }
        } else if (decision.action !== 'retryFailedSpan') {
          try {
            allocated = store.allocate().dir
            workDir = allocated
          } catch {
            /* refused inside the slot */
          }
        }
      }
      // The exact tier the request carries the word for, priced as such; Continue's is the recorded one.
      const tier = runArgs.serviceTier ?? stored.serviceTier
      const request = modelRequestConfig({
        kind: 'transcribe',
        model: runArgs.model,
        thinkingLevel: runArgs.thinkingLevel,
        thinkingBudget: runArgs.thinkingBudget,
        customGenerationParams: runArgs.customGenerationParams,
        temperature: runArgs.temperature,
        topP: runArgs.topP,
        topK: runArgs.topK,
        serviceTier: tier
      })
      // Ranked once, against the store as it stood when the slot was taken (SOL-31): a later reread
      // could promote a key that was neither preflighted nor covered by the model guard.
      const keySnapshot = keySlotsFor(args.apiKeys)
      const slots = deps.quotaBudget ? rankedNativeSlots(keySnapshot) : runKeySlots('transcribe', keySnapshot)
      const session = openSession(
        'transcribe',
        ctx,
        emit,
        args.apiKeys,
        (op) => nativeTranscribeConfig(runArgs, op, request, slots.length, runChunkSeconds, frozenPreferencesFor(ctx)),
        transcribeWords(runArgs, runChunkSeconds)
      )
      const outputPath = args.outputFile
      // Bundle I: a dedicated model runs Stage A → B → optional C, in the one language the user confirmed
      // at Start. On Continue that language, and the polish, are the record's own.
      const dedicated = isDedicatedTranscribeModel(runArgs.model)
      const spoken = dedicated ? bareLanguageCode(runArgs.sourceLanguage) : null
      // Bundle D's recipe as Settings stood at Start (D12-15). The language is unknown (D12-16) except
      // where the user confirmed it for a dedicated run. None for a transcript Align asked for: analysis
      // input, and display formatting never reaches analysis (§2.9a).
      const rtl: RtlChoice | undefined =
        alignSessionOf(outputPath) === null
          ? { enabled: stored.rtlEnabled !== false, method: sanitizeRtlMethod(stored.rtlMethod), language: spoken ? normalizeRtlLanguage(spoken) : null }
          : undefined
      const releaseUnused = () => {
        if (store && allocated) store.release(allocated)
      }
      try {
        const j = reserveJob(session.handlers, outputPath)
        if (!j) {
          releaseUnused()
          session.handlers.onOutput('stderr', BUSY_MESSAGE)
          session.handlers.onDone(-1, outputPath)
          return { outputPath, logPaths: [] }
        }
        const refuse = (message: string, error: RunError): StartedRun => {
          j.prep = null
          releaseUnused()
          j.handlers.onOutput('stderr', message)
          session.conclude(null, error)
          j.endReason = 'guard'
          finishJob(j, null)
          return { outputPath, logPaths: [] }
        }
        const refuseWith = (message: string) => refuse(message, { kind: 'refusedByApp', message })
        session.say(`Transcribing "${path.basename(args.mediaFile)}" with ${runArgs.model} (native engine).`)

        if (slots.length === 0) {
          const message = noUsableApiKeyMessage(keySnapshot)
          return refuse(message, { kind: 'refusedByApp', message })
        }
        if (store && (!decision || decision.action === 'retryFailedSpan')) return refuseWith(`The start request was not understood. ${NOTHING_SENT}`)
        if (store && decision && !workDir) {
          return refuseWith(
            decision.action === 'continue'
              ? `${RESUME_INVALID_REASON_COPY.generationStale} ${CHOOSE_AGAIN} ${NOTHING_SENT}`
              : `The app could not prepare a folder for this transcription's resumable work. ${NOTHING_SENT}`
          )
        }
        const caps = modelCapabilities(runArgs.model)
        let generic: { format: NonNullable<ReturnType<typeof transcriptionResponseFormat>>; granularityMs: number } | null = null
        if (dedicated) {
          const live = liveModelRefusal(runArgs.model)
          if (live) return refuseWith(live)
          if (!spoken) {
            return refuseWith(
              frozen
                ? `${runArgs.model} writes down one language per file, and this saved work does not record which one it was transcribed in. ` +
                    `Choose Start over to transcribe it again. ${NOTHING_SENT}`
                : `${runArgs.model} writes down one language per file, and none was confirmed for this run. ` +
                    `Press Start and confirm the spoken language. ${NOTHING_SENT}`
            )
          }
        } else {
          const format = transcriptionResponseFormat({ structuredOutput: caps.structuredOutput, timestampGranularityMs: caps.timestampGranularityMs })
          if (!format || caps.timestampGranularityMs === null) {
            const message =
              `The native engine cannot transcribe with ${runArgs.model} yet: this model does not take the timed JSON reply it reads. ` +
              'Nothing was sent. Choose another model.'
            return refuse(message, { kind: 'refusedByApp', message })
          }
          generic = { format, granularityMs: caps.timestampGranularityMs }
        }
        const primary = args.apiKeys[slots[0]]?.trim() ?? ''

        if (deps.preflight) {
          j.handlers.onOutput('stdout', 'Checking the API key…')
          j.prep = new AbortController()
          let verdict: KeyPreflight
          try {
            verdict = await deps.preflight(primary, j.prep.signal)
          } catch (err) {
            verdict = { verdict: 'unchecked', message: `Could not check the API key: ${err instanceof Error ? err.message : String(err)}` }
          } finally {
            j.prep = null
          }
          if (j.finished) return { outputPath, logPaths: [] }
          if (j.endReason) {
            releaseUnused()
            j.handlers.onOutput('stderr', 'Stopped while checking the API key.')
            finishJob(j, null)
            return { outputPath, logPaths: [] }
          }
          if (verdict.verdict === 'rejected') return refuse(verdict.message, { kind: 'auth', authReason: 'invalid', keyIndex: slots[0], message: verdict.message })
          if (verdict.verdict === 'unchecked' && verdict.message) j.handlers.onOutput('stderr', verdict.message)
        }

        // From here to the ending the whole run is the preparation step Stop interrupts — including the
        // whole-media hashing that identifies the job, which can take minutes for a film.
        const prep = new AbortController()
        j.prep = prep
        const signal = AbortSignal.any([ctx.signal, prep.signal])
        const ffmpegPath = (args.ffmpegPath || stored.ffmpegPath || '').trim() || undefined
        let journal: TranscriptionJournal | undefined
        if (store && decision && workDir && decision.action !== 'retryFailedSpan') {
          // A Stop before the run leaves the offered work as it was, unless Start over has discarded it.
          let kept = decision.action !== 'fresh'
          const stoppedBefore = (): StartedRun => {
            j.prep = null
            releaseUnused()
            session.conclude(kept ? { outcome: 'stopped', resumable: true } : null, null)
            if (j.finished) return { outputPath, logPaths: [] }
            j.handlers.onOutput('stderr', 'Stopped.')
            finishJob(j, null)
            return { outputPath, logPaths: [] }
          }
          const halted = () => signal.aborted || !!j.endReason || j.finished
          const run = await store.identifyTranscribeRun({ mediaFile: args.mediaFile, outputFile: args.outputFile, signal })
          if (halted()) return stoppedBefore()
          if (!run) return refuseWith(`The media file could not be read to check for saved work. ${NOTHING_SENT}`)
          let generation: ResumeGeneration | null = null
          let restored: TranscribeJournalInit['restored'] = null
          let create: TranscribeJournalInit['create']
          if (decision.action === 'startOver') {
            const over = await store.startOver(decision.resumeId)
            if (!over.ok) return refuseWith(`${over.message} ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
            kept = false
            for (const file of over.preserved) session.say(`Kept "${file}": it changed outside the app, so Start over left it in place.`, 'stderr')
          }
          if (decision.action === 'continue') {
            const judged = await store.revalidate(decision.resumeId, run.identity, ffmpegPath)
            if (halted()) return stoppedBefore()
            if (judged.kind === 'invalid') return refuseWith(`${RESUME_INVALID_REASON_COPY[judged.reason]} ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
            const cp = judged.judged.checkpoint
            // The offer's bytes were unchanged, so this is the configuration the run was described with.
            if (cp.config.kind !== 'transcribe' || judged.judged.working.coverage.kind !== 'transcribe' || !frozen || canonicalJson(cp.config) !== canonicalJson(frozen)) {
              return refuseWith(`${RESUME_INVALID_REASON_COPY.checkpointCorrupt} ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
            }
            generation = await store.adopt(judged.dir, judged.judged)
            restored = generation?.transcribedCues() ?? null
            if (!generation || !restored) return refuseWith(`${RESUME_INVALID_REASON_COPY.outputChanged} ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
            create = { jobKey: cp.jobKey, hint: run.identity.hint, sources: cp.sources, config: cp.config, completion: cp.completion }
          } else {
            if (await store.hasOpenGeneration(run.identity)) {
              return refuseWith(`Unfinished work exists for this media and output file. ${CHOOSE_AGAIN} ${NOTHING_SENT}`)
            }
            const destination = path.resolve(args.outputFile)
            const baseline = store.destinationBaseline(destination)
            if (!baseline) return refuseWith(`The output file could not be read to record what it holds before this run. ${NOTHING_SENT}`)
            let config: TranscribeResumeConfig
            try {
              config = transcribeResumeConfig({ ...args, serviceTier: tier ?? '' }, { chunkSeconds, ffmpeg: await store.probeFfmpeg(ffmpegPath) })
              canonicalJson(config)
            } catch (err) {
              return refuseWith(`The transcription settings could not be recorded for Continue (${err instanceof Error ? err.message : String(err)}). ${NOTHING_SENT}`)
            }
            create = { jobKey: run.identity.jobKey, hint: run.identity.hint, sources: run.sources, config, completion: { path: destination, baseline } }
          }
          if (halted()) return stoppedBefore()
          journal = store.transcribeJournal({ dir: workDir, generation, create, restored })
        }
        const video = isVideoMedia(args.mediaFile)
        let reported = false
        const audio =
          deps.audio?.({ mediaFile: args.mediaFile, isVideo: video, job: j }) ??
          ffmpegTranscriptionAudio({
            mediaFile: args.mediaFile,
            isVideo: video,
            ffmpegPath,
            scratchPath: (suffix) => tempOutputPath(suffix),
            registerScratch: (file) => j.scratch.push(file),
            onChild: (child) => {
              if (!j.finished) j.prepChild = child
            },
            onProgress: (pct, elapsedMs) => {
              reported = true
              deps.onProgress?.({ kind: 'convert', pct, elapsedMs })
            }
          })
        const budget = new RetryBudget()
        const startedAt = Date.now()
        const runEmit: Emit = (event) => {
          // gst `main.py:782`'s reset, at the one place a reply is known to be usable: its commit.
          if (event.type === 'unit' && event.state === 'received') budget.accept()
          if (reported && event.type === 'phase' && event.phase === 'working') {
            reported = false
            deps.onProgress?.({ kind: 'convert', pct: null, elapsedMs: Date.now() - startedAt, done: true })
          }
          session.emit(event.type === 'usage' ? { ...event, usage: withCostEstimate(event.usage, runArgs.model, tier) } : event)
        }
        const provider = deps.provider ?? createGeminiProvider()
        const keys = args.apiKeys.map((k) => (typeof k === 'string' ? k.trim() : ''))
        const say = (text: string) => session.say(text, 'stderr')
        const gateSettings = deps.gateSettings ?? getSettings
        const requestBudget = deps.quotaBudget ? createRequestBudget({ journal: deps.quotaBudget(), settings: gateSettings }) : null
        const account = createUsageAccount()
        // One gate per model the run calls: each reserves against its own model's limits, under its own attempt ids.
        const gateFor = (model: string, stage?: string) =>
          requestBudget
            ? createRequestGate({
                runId: ctx.runId,
                ...(stage ? { stage } : {}),
                model,
                requestKind: 'generation',
                keys,
                settings: gateSettings,
                budget: requestBudget,
                revisions: ctx.settingsRevisions,
                registry: activeQuotaGroups,
                onBudget: (snapshot) => session.emit({ type: 'budget', runId: ctx.runId, budget: snapshot }),
                learn: recordQuotaEvidence,
                account
              })
            : undefined
        const stageGate = gateFor(runArgs.model)
        const polishWith = spoken ? runArgs.polish : undefined
        const polishGate = polishWith ? gateFor(polishWith.model, 'polish') : undefined
        const polish = polishWith
          ? (texts: readonly string[], polishSignal: AbortSignal) =>
              polishCueTexts({
                provider,
                model: polishWith.model,
                config: modelRequestConfig({
                  kind: 'translate',
                  model: polishWith.model,
                  thinkingLevel: polishWith.thinkingLevel,
                  thinkingBudget: polishWith.thinkingBudget,
                  customGenerationParams: false,
                  temperature: 0,
                  topP: 0,
                  topK: null,
                  serviceTier: tier
                }),
                texts,
                language: langLabel(spoken!),
                keys,
                slots,
                budget,
                ...(deps.retry ? { retry: deps.retry } : {}),
                say,
                signal: polishSignal,
                ...(polishGate ? { gate: polishGate } : {})
              })
          : undefined
        if (spoken) session.say(`Spoken language: ${langLabel(spoken)} (${spoken}), as confirmed at Start.${polish ? ` The wording is polished afterwards with ${polishWith!.model}.` : ''}`)
        let result: TranscriptionResult
        try {
          result = await runTranscription({
            runId: ctx.runId,
            mediaFile: args.mediaFile,
            outputPath,
            ...(journal ? { journal } : {}),
            signal,
            isCurrent: () => !j.finished && currentEpoch() === ctx.epoch,
            emit: runEmit,
            audio,
            transcribeChunk: generic
              ? nativeTranscribeChunk({
                  provider,
                  model: runArgs.model,
                  instruction: transcribeInstruction({ model: runArgs.model, description: runArgs.description }),
                  config: request,
                  format: generic.format,
                  granularityMs: generic.granularityMs,
                  keys,
                  slots,
                  budget,
                  ...(deps.retry ? { retry: deps.retry } : {}),
                  say,
                  ...(stageGate ? { gate: stageGate } : {})
                })
              : dedicatedTranscribeChunk({
                  provider,
                  model: runArgs.model,
                  languageCode: spoken!,
                  ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
                  keys,
                  slots,
                  budget,
                  ...(deps.retry ? { retry: deps.retry } : {}),
                  say,
                  ...(stageGate ? { gate: stageGate } : {})
                }),
            ...(spoken ? { wordCues: true as const } : {}),
            ...(polish ? { polish, models: { transcribe: runArgs.model, polish: polishWith!.model } } : {}),
            registerScratch: (file) => j.scratch.push(file),
            releaseScratch: (file) => {
              j.scratch = j.scratch.filter((f) => f !== file)
            },
            ...(deps.outputIo ? { outputIo: deps.outputIo } : {}),
            ...(rtl ? { rtl } : {}),
            chunkSeconds: runChunkSeconds
          })
        } finally {
          j.prep = null
          releaseUnused()
          activeQuotaGroups.release(ctx.runId)
          // On every ending, so a stopped or failed extraction never leaves the page's box behind.
          if (reported) deps.onProgress?.({ kind: 'convert', pct: null, elapsedMs: Date.now() - startedAt, done: true })
        }
        session.conclude({ ...result, usage: withCostEstimate(withUsageBuckets(result.usage, account.buckets()), runArgs.model, tier) }, null)
        if (j.finished) return { outputPath, logPaths: [] }
        if (result.orphan || (j.endReason && stillHasPrepChild(j))) {
          j.handlers.onOutput(
            'stderr',
            'An ffmpeg process from this run did not stop. This run stays open until it exits, because ' +
              'starting another one now would run two over the same files.'
          )
          ownOrphan(j, result.orphan ?? j.prepChild ?? undefined)
          return { outputPath, logPaths: [] }
        }
        j.prepChild = null
        if (result.outcome === 'completed') {
          j.handlers.onOutput('stdout', `Transcription saved to ${outputPath}`)
        } else if (result.outcome === 'stopped' || j.endReason) {
          j.handlers.onOutput('stderr', 'Stopped.')
        }
        finishJob(j, null)
        return { outputPath, logPaths: [] }
      } catch (err) {
        session.abandon(err)
        throw err
      }
    }
  }
}
