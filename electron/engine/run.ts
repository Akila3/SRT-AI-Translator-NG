/**
 * Native translation: one run, from the source file to the saved subtitle (implementation_plan.md
 * Steps 2.5–2.8). AUTHORED-BY: opus-5.5-high
 *
 * The sole owner of the run snapshot and of every request built from it (codebase_map.md §21.4).
 * The snapshot is taken once, from the run's arguments, before anything is sent; nothing here reads
 * Settings. Each batch is built by `prompt.ts`, sent through the `translateBatch` seam
 * (`nativeTranslateBatch`: `retry.ts` and `keys.ts` in front of the provider), checked and committed
 * by `batching.ts`, and the whole subtitle so far is then written to the partial through `output.ts`
 * (§4.1a).
 *
 * The partial is gst's interrupted file (`main.py:680,807`): every source cue, translated where a
 * batch has committed and in the source language where none has yet. The destination is not written
 * until every cue is translated and the count invariant holds (ARCHITECTURE_TARGET.md §6.1).
 *
 * A reply that fails the check is sent again unchanged, as gst 3.7.0 does (`main.py:915-980`, disclosure
 * D1): the same batch, after five seconds, counted on the run's one consecutive-error budget, so the
 * third bad reply in a row ends the run with the partial kept. A block is never sent again (checklist
 * row 32). There is no smaller batch, no streaming and no recovery split: those wait for Bundle G and
 * Bundle F. A reply that arrives after Stop, or after this run's epoch has ended, is never committed.
 *
 * A resumable run (Phase 3) is given a `TranslationJournal`: every snapshot then goes through the
 * checkpoint, output before pointer, a failed batch is recorded for a later retry, and Continue starts
 * from the verified accepted prefix with the frozen `resumeContextSize` pair on its first request. A retry
 * the user asked for (AR3-7) sends exactly the failed section, in the fixed pieces they chose, and then
 * pauses. A first-Continue parent's pieces each carry its pair; with Context ON every other piece builds
 * its own previous-source block, so a piece sees the lines an earlier piece committed (tester TD15-1).
 *
 * With Context ON every other request carries the D15-3R block: up to `batchContextLines` earlier source
 * lines whose translations are committed when the request is built. When a request with a block gets
 * a reply the run cannot use, that batch's resends go without it (tester TD15-4). No request carries a
 * model turn except the first Continue's pair.
 */
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  BudgetMetric,
  BudgetSnapshot,
  PreservationReason,
  PreservedLine,
  RunError,
  RunErrorKind,
  RunOutcome,
  TranslationPartitionUsage,
  Usage,
  UsageBucket,
  UsageRequestKind
} from '../shared/engineEvents'
import { withCostEstimate } from '../shared/pricing'
import { DEFAULT_QUOTA_GROUP_ID, quotaGroupRuntimeView } from '../shared/quotaGroups'
import { RESUMABLE_TRANSLATE_NOTE, type AppSettings, type LearnedQuotaEvidence, type RunId, type TranslateArgs } from '../shared/types'
import type { AudioSlice } from '../main/ffmpeg'
import { pacificPeriod, type JournalWrite } from '../main/quotaBudgetStore'
import type { Emit, SettingsRevisionSource } from './adapter'
import {
  CommittedTranslations,
  TRANSLATE_AUDIO_CHUNK_SECONDS,
  acceptPartition,
  batchMediaSpan,
  createPartitionState,
  markPartitionInFlight,
  planBatches,
  repartitionTail,
  reservePartition,
  resizedQueue,
  retryPieces,
  type PartitionChange,
  type TranslationBatch,
  type TranslationPartitionState
} from './batching'
import { announcedBlock, classifyBlock, type AnnouncedBlock } from './blocks'
import { chooseRoute, createKeyRotation, type GroupReadiness, type RouteSlot } from './keys'
import { PartialOutput, type OutputIo, type PartialOutputOptions, type PromoteResult } from './output'
import {
  genderRepairRequest,
  methodBClassifyRequest,
  strayAlphabetRequest,
  providerRequestReceipt,
  selectSourceBatchContext,
  translationRequest,
  translationSnapshot,
  treeSourceContext,
  type OracleInput,
  type PreparedTranslationRequest,
  type TranslationContext,
  type TranslationSnapshot
} from './prompt'
import { GEMINI_SAFETY_SETTINGS } from './providers/gemini'
import { responseLimitBytes } from './providers/responseLimit'
import type { BatchFailure, GenerationProvider, ProviderReply, ProviderRequestReceipt } from './providers/types'
import { recoverCues, type CueAnswer } from './recover'
import { countBound, type RequestAdvisor } from './requestAdvisor'
import type { RestoredRow } from './translationState'
import { keptLinesText as keptLines } from '../shared/runCopy'
import { systemBudgetClock, type BudgetClock, type RequestBudget } from './requestBudget'
import {
  DEFAULT_RETRY_POLICY,
  projectFailure,
  systemClock,
  withRetry,
  type AttemptGate,
  type GateDecision,
  type GateStorageFault,
  type GateTicket,
  type RetryBudget,
  type RetryClock,
  type RetryPolicy
} from './retry'
import { recordThoughtSummary } from './runner'
import { effectiveStrength, referenceUiShown } from '../shared/genderReference'
import {
  designatedFlags,
  helperReading,
  hintEligible,
  NO_GENDER_LAYERS,
  referenceLanguage,
  speakerEligible,
  type Gender,
  type GenderAxis,
  type GenderLayers,
  type HelperProvenance
} from './genderReaders'
import {
  emptyLayerOutcome,
  FEATURE17_LAYERS,
  GENDER_LAYERS,
  layerLogLine,
  methodBFlags,
  methodBPrompt,
  methodBUnread,
  parseMethodBLabels,
  repairGender,
  repairGenderByAxis,
  type Feature17Layer,
  type LayerOutcome,
  type LayerSkip,
  type ModelReply
} from './genderRepair'
import { repairStrayAlphabet } from './strayAlphabet'
import { inspectSubtitleBytes } from './subtitleInput'
import { parseCues, serializeCues, stripLeakedSpeakerTags, type Cue } from './srt'
import type { ValidatedBatch } from './validateTranslationBatch'

/** What every batch answer carries, whatever its outcome. */
interface AnswerFacts {
  /** Every attempt's tokens, each counted once; failed attempts' also as `billedButUnusableTokens`. */
  usage?: Usage
  /** Requests sent for this batch. */
  attempts?: number
  /** One content-free receipt per request sent (§14.3). */
  receipts?: ProviderRequestReceipt[]
}

/** One batch's answer from the provider side: the reply text to check, or why there is none. */
export type BatchAnswer =
  | ({ ok: true; text: string; thoughts?: string[] } & AnswerFacts)
  /** `block`: the announced block, when the reply was one (`blocks.ts`); Bundle G's ladder reads it. */
  | ({ ok: false; error: RunError; beforeSend?: true; storage?: true; block?: AnnouncedBlock } & AnswerFacts)

export type TranslateBatch = (
  prepared: PreparedTranslationRequest,
  unit: {
    batch: TranslationBatch
    /** Said before a wait or a resend: the attempt about to be made, and why, in slot numbers only. */
    retrying: (attempt: number, message: string) => void
    /** The request's exact counted input when the advisor counted it; the budget's input-TPM estimate. */
    inputTokens?: number | null
    /** A Bundle G recovery request: accounted as `recovery`, through the same gate. */
    recovery?: true
  },
  signal: AbortSignal
) => Promise<BatchAnswer>

/** The audio side of a run with an audio file. Production cuts the user's file with ffmpeg. */
export interface TranslationAudio {
  slice(startSeconds: number, endSeconds: number, signal: AbortSignal): Promise<AudioSlice>
}

/**
 * The context a request carried, as its failure record needs it (AR3-7): the first Continue's pair, or
 * the cues of its previous-source block (D15-3R; possibly none, for a first batch with Context ON).
 */
export interface SentContext {
  kind: 'none' | 'previousSource' | 'firstContinue'
  context: TranslationContext | null
}

/** A user-requested retry of one failed section (AR3-7). */
export interface TranslationRetry {
  fromCue: number
  toCue: number
  /** The piece size the user chose. */
  size: number
  /**
   * A first-Continue parent's own pair, cues `fromCue..toCue`, sent with every piece; `previousSource`
   * gives each piece its own block over what is committed when it is built (tester TD15-1); null sends none.
   */
  context: { kind: 'previousSource' } | { kind: 'firstContinue'; fromCue: number; toCue: number } | null
}

/**
 * Where a resumable run keeps its work (Phase 3; `resumeStore.ts` behind the native adapter). Every
 * snapshot goes through `commit`, so the checkpoint never names output that is not on disk.
 */
export interface TranslationJournal {
  /** Continue: the verified prefix, cues `1..n`, each accepted or preserved (PR-3). Empty for a fresh run. */
  readonly restored: readonly RestoredRow[]
  /** Continue: the frozen `resumeContextSize` for the first request. Null for a fresh run. */
  readonly firstContextSize: number | null
  /** A retry: exactly the failed section, then a pause. Null for any other run. */
  readonly retry: TranslationRetry | null
  /** True once every cue is committed in the record. */
  readonly complete: boolean
  /** True while the record holds work a later Start can offer to Continue. */
  readonly resumable: boolean
  /** The run's partial: Continue adopts the verified one; a fresh run claims the generation's own name. */
  partial(opts: Pick<PartialOutputOptions, 'io' | 'registerScratch' | 'releaseScratch'>): PartialOutput
  /**
   * One whole snapshot whose cues `1..through` are resolved: output first, then the record. The cues in
   * `preserved` are kept in their source language and recorded so; every other one is accepted.
   */
  commit(partial: PartialOutput, text: string, through: number, preserved?: readonly number[]): Promise<{ ok: true } | { ok: false; stage: string; message: string }>
  /** Complete work's text rewritten by finishing (Bundle H): the same cues, recorded as a revision. */
  revise(partial: PartialOutput, text: string, preserved?: readonly number[]): Promise<{ ok: true } | { ok: false; stage: string; message: string }>
  /** The batch that failed and the pair it carried, so exactly that section can be retried. */
  failed(span: { fromCue: number; toCue: number; cause: RunErrorKind; sent: SentContext }): Promise<{ ok: true } | { ok: false; message: string }>
  promote(partial: PartialOutput, isCurrent: () => boolean): Promise<PromoteResult>
}

export { RESUMABLE_TRANSLATE_NOTE }

export interface TranslationRunOptions {
  runId: RunId
  /** The run's arguments as the start path accepted them. The snapshot is taken from these once. */
  args: TranslateArgs
  outputPath: string
  signal: AbortSignal
  /** False once this run's epoch has ended; checked before every commit and before promotion. */
  isCurrent: () => boolean
  emit: Emit
  translateBatch: TranslateBatch
  /** Required exactly when `args.audioFile` is set. */
  audio?: TranslationAudio | null
  registerScratch: (file: string) => void
  releaseScratch: (file: string) => void
  outputIo?: Partial<OutputIo>
  /** Gates: the decoded source. Production reads `args.inputFile`, already UTF-8 (the start path). */
  readSource?: (file: string) => string
  mediaChunkSeconds?: number
  /**
   * The run's consecutive-error count, reset when a batch commits (gst `main.py:899`). With it, a reply
   * that fails the check is resent on the same count (D1); without it, that reply ends the run.
   */
  retryBudget?: RetryBudget
  /** The ceiling and the wait between resends (`maxConsecutiveErrors`, `networkWaitMs`), and their clock. */
  resend?: { policy?: Partial<RetryPolicy>; clock?: RetryClock }
  /** Phase 3: the run's checkpoint. Without one the run keeps Phase 2's partial beside `outputPath`. */
  journal?: TranslationJournal
  /**
   * Bundle F (§12.7): the request-size advisor. Without one, or for a user's retry of a failed section,
   * every batch is sent at the size it was planned at. Settings are never changed by it.
   */
  advisor?: RequestAdvisor
  /** The Quota Group a count would go through now, for the advisor's cache. */
  adviceGroupId?: () => string
  /**
   * Bundle H: the run's gender reference — the chosen file read, or the automatic walk run — aligned to the
   * source. Called once per run, only when `args.genderReference` is set and the target is Hebrew.
   */
  reference?: (source: readonly Cue[], signal: AbortSignal) => Promise<RunReference>
}

/**
 * Bundle H: the reference a run translates with, after alignment. Holds no path or title; `accepted` is never
 * logged or recorded.
 */
export interface RunReference {
  readonly helper: HelperProvenance
  /** The reference's language code; null when unknown. */
  readonly language: string | null
  /** Source `Cue.index` → the aligned reference line. Empty when nothing aligned. */
  readonly lines: ReadonlyMap<number, string>
  /** Metadata-only lines for the run log (H-log-1). */
  readonly log: readonly string[]
  /** The automatic walk's accepted file, which the adapter stages for the page's reference field (§3.3). */
  readonly accepted?: { readonly bytes: Buffer; readonly name: string }
}

export interface TranslationResult {
  outcome: RunOutcome
  /** Set only for a partial that holds a complete, fsync'd snapshot (§4.1a rule 4). */
  partialPath?: string
  /** Present exactly when `outcome` is `failed`; already emitted as an `error` event. */
  error?: RunError
  /** Source cues; 0 when the source could not be read. */
  cueCount: number
  translatedCount: number
  batchCount: number
  usage: Usage
  snapshot: TranslationSnapshot | null
  /** Every request sent, in order, content-free. */
  receipts: ProviderRequestReceipt[]
  /** A stopped or failed run whose work its checkpoint holds for Continue. */
  resumable?: boolean
  /** A retry that covered its whole section and paused (outcome `stopped`), as AR3-7 requires. */
  paused?: true
  /** Bundle G: the lines kept in the source language, by number, with why. Absent when there are none. */
  preserved?: PreservedLine[]
}

function emptyUsage(): Usage {
  return { promptTokens: 0, thoughtTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0 }
}

function addUsage(total: Usage, part: Usage | undefined): void {
  if (!part) return
  total.promptTokens += part.promptTokens
  total.thoughtTokens += part.thoughtTokens
  total.outputTokens += part.outputTokens
  total.totalTokens += part.totalTokens
  if (part.billedButUnusableTokens) {
    total.billedButUnusableTokens = (total.billedButUnusableTokens ?? 0) + part.billedButUnusableTokens
  }
}

function linesLabel(batch: TranslationBatch): string {
  const from = batch.cues[0].index
  const to = batch.cues[batch.cues.length - 1].index
  return from === to ? `line ${from}` : `lines ${from}\u2013${to}`
}

/** The partitions as usage: indices and counts only, contiguous runs of one reason and requested size merged. */
function partitionUsageOf(state: TranslationPartitionState): TranslationPartitionUsage[] {
  const out: TranslationPartitionUsage[] = []
  for (const p of state.partitions) {
    const last = out[out.length - 1]
    if (last && last.reason === p.reason && last.requestedLineCount === p.requestedLineCount && last.lastCueIndex + 1 === p.fromCue) {
      last.lastCueIndex = p.toCue
      last.effectiveLineCount = Math.max(last.effectiveLineCount, p.effectiveLineCount)
    } else {
      out.push({ firstCueIndex: p.fromCue, lastCueIndex: p.toCue, requestedLineCount: p.requestedLineCount, effectiveLineCount: p.effectiveLineCount, reason: p.reason })
    }
  }
  return out
}

/** The count invariant at file scope: what was written reads back as the source's cues, number for number and time for time. */
function sameShape(written: string, source: readonly Cue[]): boolean {
  const back = parseCues(written)
  if (!back.ok || back.cues.length !== source.length) return false
  return back.cues.every((c, i) => c.index === source[i].index && c.startMs === source[i].startMs && c.endMs === source[i].endMs)
}

export async function runTranslation(run: TranslationRunOptions): Promise<TranslationResult> {
  const { runId, emit, signal, args } = run
  const usage = emptyUsage()
  const journal = run.journal ?? null
  const partialOptions = { io: run.outputIo, registerScratch: run.registerScratch, releaseScratch: run.releaseScratch }
  const output = journal ? journal.partial(partialOptions) : new PartialOutput(run.outputPath, partialOptions)
  const name = path.basename(args.inputFile)
  let snapshot: TranslationSnapshot | null = null
  let committed: CommittedTranslations | null = null
  let batchCount = 0
  const receipts: ProviderRequestReceipt[] = []

  const log = (text: string, stream: 'stdout' | 'stderr' = 'stdout') => emit({ type: 'log', runId, stream, text })
  /** The run's requested and effective partitions, once the advisor has re-cut any (§12.10). */
  let resizedPartitions: TranslationPartitionUsage[] | null = null
  /** The cumulative usage as reported: priced at the run's exact model and tier, or unpriced. */
  const priced = (): Usage =>
    withCostEstimate(resizedPartitions ? { ...usage, translationPartitions: resizedPartitions.map((p) => ({ ...p })) } : usage, args.model, args.serviceTier)
  const result = (outcome: RunOutcome, extra: Partial<TranslationResult> = {}): TranslationResult => {
    const preserved = committed?.preservedLines() ?? []
    return {
      outcome,
      cueCount: committed?.source.length ?? 0,
      translatedCount: committed?.acceptedCount ?? 0,
      batchCount,
      usage: priced(),
      snapshot,
      receipts,
      ...(preserved.length ? { preserved } : {}),
      ...extra
    }
  }

  const end = async (outcome: Exclude<RunOutcome, 'completed'>, error?: RunError): Promise<TranslationResult> => {
    if (error) emit({ type: 'error', runId, error })
    const kept = committed?.preservedLines() ?? []
    if (kept.length) log(`${kept.length} line${kept.length === 1 ? ' is' : 's are'} kept in the source language in the work so far: ${keptLines(kept)}.`, 'stderr')
    if (journal) {
      // The checkpoint owns this partial: nothing lands outside it, so a waiting scratch is left as it is.
      const partialPath = output.partialPath
      if (journal.resumable) log(RESUMABLE_TRANSLATE_NOTE)
      return result(outcome, { ...(partialPath ? { partialPath } : {}), ...(error ? { error } : {}), ...(journal.resumable ? { resumable: true } : {}) })
    }
    const partialPath = await output.retain()
    const stranded = output.strandedSnapshot
    if (partialPath && partialPath !== stranded) log(`Kept the subtitle written so far as "${path.basename(partialPath)}".`)
    if (stranded) {
      log(
        partialPath === stranded
          ? `Kept the subtitle written so far as "${path.basename(stranded)}": the partial file could not be written to, so the copy keeps this temporary name. Rename it to end in .srt to open it.`
          : `The last batch could not be added to "${path.basename(partialPath ?? '')}" because the file was in use. The fuller copy is kept as "${path.basename(stranded)}".`
      )
    }
    return result(outcome, { ...(partialPath ? { partialPath } : {}), ...(error ? { error } : {}) })
  }
  const stopped = () => end('stopped')
  const preservedIndices = (): number[] => committed?.preservedLines().map((p) => p.index) ?? []
  const ended = () => signal.aborted || !run.isCurrent()
  const resendPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...run.resend?.policy }
  const resendClock = run.resend?.clock ?? systemClock

  emit({ type: 'phase', runId, phase: 'preparing' })
  try {
    snapshot = translationSnapshot(args)
  } catch (err) {
    return end('failed', { kind: 'refusedByApp', message: `${err instanceof Error ? err.message : String(err)} Nothing was sent.` })
  }
  if (snapshot.media && !run.audio) throw new TypeError('A run with an audio file needs its audio side.')

  let text: string
  try {
    text = (run.readSource ?? ((file) => fs.readFileSync(file, 'utf-8')))(args.inputFile)
  } catch (err) {
    return end('failed', { kind: 'unknown', message: `Could not read "${name}": ${err instanceof Error ? err.message : String(err)}` })
  }
  const parsed = parseCues(text, { path: args.inputFile })
  if (!parsed.ok) return end('failed', { kind: 'unknown', message: `"${name}" was not translated. ${parsed.message}` })
  committed = new CommittedTranslations(parsed.cues)
  const source = committed.source
  const total = source.length
  if (journal?.restored.length) {
    try {
      committed.restore(journal.restored)
    } catch (err) {
      return end('failed', { kind: 'unknown', message: `The saved work for "${name}" does not fit its subtitle (${err instanceof Error ? err.message : String(err)}). Nothing was sent.` })
    }
  }
  // Bundle H: the reference is resolved once; every request then takes its own lines of the one map (H-G).
  let reference: RunReference | null = null
  let oracle: OracleInput | null = null
  const wanted = args.genderReference
  if (wanted && referenceUiShown(args.targetLang) && run.reference) {
    try {
      reference = await run.reference(source, signal)
    } catch {
      reference = null
      log('Gender reference: it could not be prepared, so this run translates without one.', 'stderr')
    }
    if (ended()) return stopped()
    for (const line of reference?.log ?? []) log(line)
    if (reference && reference.lines.size > 0 && hintEligible(reference.helper)) {
      oracle = Object.freeze({
        language: reference.language ?? '',
        strength: effectiveStrength(wanted.strength, reference.language, wanted.hardGermanConfirmed),
        lines: reference.lines
      })
      log(`Gender reference: ${reference.lines.size} of ${total} lines have an aligned reference line.`)
    } else if (reference) {
      log(
        reference.lines.size === 0
          ? 'Gender reference: no reference lined up with this subtitle, so this run translates without one.'
          : 'Gender reference: this reference is not used for gender (machine-translated, Wizdom, or a language without gender rules).',
        'stderr'
      )
    }
  }
  const done = committed.resolvedCount
  const retry = journal?.retry ?? null
  const mediaSeconds = snapshot.media ? (run.mediaChunkSeconds ?? TRANSLATE_AUDIO_CHUNK_SECONDS) : null
  let todo: readonly TranslationBatch[]
  // A first-Continue parent's pieces all carry its pair, rebuilt from committed cues only.
  let retryPair: TranslationContext | null = null
  if (retry) {
    try {
      if (retry.fromCue !== done + 1) throw new Error(`the section starts at line ${retry.fromCue}, but the saved work ends at line ${done}`)
      todo = retryPieces(source, retry.fromCue, retry.toCue, retry.size)
      if (retry.context?.kind === 'firstContinue') retryPair = committed.acceptedPair(retry.context.fromCue, retry.context.toCue)
    } catch (err) {
      return end('failed', { kind: 'unknown', message: `The failed section of "${name}" does not fit its saved work (${err instanceof Error ? err.message : String(err)}). Nothing was sent.` })
    }
    batchCount = todo.length
  } else {
    const plan = planBatches(source, args.batchSize, { mediaSeconds })
    batchCount = plan.length
    // Continue: the same plan, less what the record already holds.
    todo = plan
      .filter((b) => b.cues[b.cues.length - 1].index > done)
      .map((b) => (b.cues[0].index > done ? b : Object.freeze({ ...b, cues: Object.freeze(b.cues.filter((c) => c.index > done)) })))
  }
  if (ended()) return stopped()

  emit({ type: 'phase', runId, phase: 'working' })
  emit({ type: 'lines', runId, done, total })
  if (retry) log(`Retrying lines ${retry.fromCue}\u2013${retry.toCue}, ${retry.size} at a time.`)
  else if (done > 0) log(`Continuing after line ${done} of ${total}.`)
  // Only the first continued request carries the frozen `resumeContextSize` pair (F15-P4), and no block.
  let firstContinue = journal && done > 0 && !retry ? journal.firstContextSize : null
  const retryCarries = retry?.context?.kind === 'previousSource'

  // A user's retry of a failed section keeps the pieces they chose; every other run may be advised (§12.7).
  const advisor = retry ? null : (run.advisor ?? null)
  const queue: TranslationBatch[] = [...todo]
  let partitions: TranslationPartitionState = createPartitionState(queue, args.batchSize)
  const step = (change: PartitionChange): void => {
    if (change.ok) partitions = change.state
  }
  let adviceUnavailableSaid = false
  /** The counted-safe head of `queue[q]` is `lines`; the tail from it is re-cut at that ceiling (§12.10). */
  const resize = (q: number, original: TranslationBatch, lines: number): boolean => {
    const next = resizedQueue(queue, q, lines, { mediaSeconds })
    const change = repartitionTail(partitions, partitions.version, {
      fromCue: original.cues[0].index,
      ranges: next.map((b) => ({ fromCue: b.cues[0].index, toCue: b.cues[b.cues.length - 1].index })),
      ceiling: lines,
      reason: 'countedInputLimit'
    })
    if (!change.ok) return false
    partitions = change.state
    resizedPartitions = partitionUsageOf(partitions)
    queue.splice(q, queue.length - q, ...next)
    batchCount = queue[q].total
    const message =
      `${linesLabel(original).replace(/^l/, 'L')} would be more than ${args.model} accepts in one request, so this run now sends at most ` +
      `${lines} line${lines === 1 ? '' : 's'} per request. Your saved Batch Size (${args.batchSize}) is unchanged.`
    emit({ type: 'advice', runId, state: 'resized', requestedBatchSize: args.batchSize, effectiveBatchSize: partitions.effectiveLineCeiling, message })
    log(message, 'stderr')
    return true
  }
  const sayUnavailable = (): void => {
    if (adviceUnavailableSaid) return
    adviceUnavailableSaid = true
    emit({
      type: 'advice',
      runId,
      state: 'unavailable',
      requestedBatchSize: args.batchSize,
      message: 'The request size could not be checked against the model\u2019s input limit, so batches are sent at their planned size.'
    })
  }

  // Bundle G PR-6 (G.9a): the whole-file forecast at Start, behind the scenes. Each group of the plan is
  // checked once, in order, with the request it will send if every earlier line is accepted; a resize
  // re-cuts the tail and the pass goes on over it, never back. Each original group keeps its own
  // `countBound` allowance for the whole run: a send-time resize resumes the pass over the new tail with
  // what is left of it, never replenished. Runs with audio and retries are not forecast.
  const forecasting = advisor !== null && !snapshot.media
  const allowance = new Map<number, number>()
  const ownerOf = new Map<number, number>()
  const positionOf = new Map(source.map((c, p) => [c.index, p]))
  /** False once the model states no input limit: nothing can be checked, now or later. */
  let forecastable = forecasting
  if (forecasting) {
    for (const b of queue) {
      allowance.set(b.cues[0].index, countBound(b.cues.length))
      for (const c of b.cues) ownerOf.set(c.index, b.cues[0].index)
    }
  }
  /**
   * The pass over `queue[start…]`. `ahead` is the positions assumed accepted before `queue[start]`; a resize
   * restates the totals of the unsent groups from `restateFrom`. True when the run was stopped.
   */
  const forecast = async (start: number, ahead: Set<number>, pinnedFirst: number | null, restateFrom: number): Promise<boolean> => {
    if (!advisor || !forecastable) return false
    let pinned = pinnedFirst
    for (let q = start; q < queue.length; q++) {
      if (ended()) return true
      const group = queue[q]
      const from = group.cues[0].index
      const resumeContext = pinned !== null ? committed.resumePair(from, pinned) : null
      const carries = snapshot!.batchContext && pinned === null
      pinned = null
      const sourceContext = carries ? selectSourceBatchContext(source, from - 1, snapshot!.batchContextLines, ahead) : []
      const owner = ownerOf.get(from) ?? from
      const left = allowance.get(owner) ?? 0
      const advice = await advisor.advise({
        lines: group.cues.length,
        build: async (n) => translationRequest(snapshot!, { cues: group.cues.slice(0, n), resumeContext, audio: null, injections: { sourceContext, oracle } }).request,
        groupId: run.adviceGroupId?.() ?? DEFAULT_QUOTA_GROUP_ID,
        maxCounts: left,
        signal
      })
      if (ended()) return true
      allowance.set(owner, left - advice.counts)
      if (advice.state === 'resized') {
        // The groups before it are not sent yet, so "Batch k of N" is the new N from the next one sent.
        if (resize(q, group, advice.lines)) for (let k = restateFrom; k < q; k++) queue[k] = Object.freeze({ ...queue[k], total: queue[q].total })
      } else if (advice.state === 'unavailable' && advice.reason === 'noLimit') {
        forecastable = false
        break
      } else if (advice.state === 'unavailable' && advice.reason === 'countFailed') {
        sayUnavailable()
        break
      } else if (advice.state === 'unavailable' && advice.reason === 'cancelled') return true
      for (const c of queue[q].cues) {
        const p = positionOf.get(c.index)
        if (p !== undefined) ahead.add(p)
      }
    }
    return false
  }
  if (advisor && !snapshot.media) {
    const ahead = new Set(committed.acceptedPositions())
    if (await forecast(0, ahead, firstContinue, 0)) return stopped()
  }

  for (let q = 0; q < queue.length; q++) {
    if (ended()) return stopped()
    let batch = queue[q]
    const from = batch.cues[0].index
    const continuing = firstContinue !== null
    const resumeContext = retry ? retryPair : firstContinue !== null ? committed.resumePair(from, firstContinue) : null
    firstContinue = null
    const carries = snapshot.batchContext && !resumeContext && !continuing && (!retry || retryCarries)
    const sourceContext = carries
      ? selectSourceBatchContext(source, from - 1, snapshot.batchContextLines, committed.acceptedPositions())
      : []

    // The exact request for the first `n` cues of this batch, built once per `n`: what is counted is
    // what is sent. Only the advisor builds ahead of `sending`; its audio cut is reused, never repeated.
    const built = new Map<number, { audio: { mimeType: string; data: string } | null; prepared: PreparedTranslationRequest }>()
    const original = batch
    const buildFor = async (n: number) => {
      const hit = built.get(n)
      if (hit) return hit
      const cues = original.cues.slice(0, n)
      let cut: { mimeType: string; data: string } | null = null
      if (snapshot.media && run.audio) {
        const span = batchMediaSpan({ ...original, cues })
        const slice = await run.audio.slice(span.startSeconds, span.endSeconds, signal)
        if (!slice.ok) throw new Error(slice.error)
        cut = { mimeType: slice.mimeType, data: slice.data.toString('base64') }
      }
      const value = { audio: cut, prepared: translationRequest(snapshot, { cues, resumeContext, audio: cut, injections: { sourceContext, oracle } }) }
      built.set(n, value)
      return value
    }
    let inputTokens: number | null = null
    if (advisor) {
      const advice = await advisor.advise({
        lines: batch.cues.length,
        build: async (n) => (await buildFor(n)).prepared.request,
        groupId: run.adviceGroupId?.() ?? DEFAULT_QUOTA_GROUP_ID,
        signal
      })
      if (ended()) return stopped()
      if (advice.state === 'fit') {
        inputTokens = advice.inputTokens
      } else if (advice.state === 'resized') {
        if (resize(q, original, advice.lines)) {
          inputTokens = advice.inputTokens
          // PR-6 rebuild: the new tail after this batch is forecast before it is sent, assuming this batch accepted.
          const ahead = new Set(committed.acceptedPositions())
          for (const c of queue[q].cues) {
            const p = positionOf.get(c.index)
            if (p !== undefined) ahead.add(p)
          }
          if (await forecast(q + 1, ahead, null, q)) return stopped()
          batch = queue[q]
        }
      } else if (advice.reason !== 'noLimit' && advice.reason !== 'cancelled' && advice.reason !== 'notCounted') {
        sayUnavailable()
      }
    }
    const lineRange = { from, to: batch.cues[batch.cues.length - 1].index }
    const sent: SentContext = resumeContext
      ? { kind: 'firstContinue', context: resumeContext }
      : carries
        ? { kind: 'previousSource', context: Object.freeze({ cues: Object.freeze(sourceContext.map((l) => source[Number(l.index)])), accepted: committed.accepted }) }
        : { kind: 'none', context: null }
    let attempt = 1
    const unit = (state: 'sending' | 'retrying' | 'validating' | 'received' | 'failed') =>
      emit({ type: 'unit', runId, index: batch.index, total: batch.total, state, lineRange, attempt })
    const retrying = (next: number, message: string) => {
      if (ended()) return
      attempt = next
      log(`${linesLabel(batch).replace(/^l/, 'L')}: ${message}`, 'stderr')
      unit('retrying')
    }
    /** `recordSpan` false: nothing about the batch failed (the gate stopped it, or the request record could not be written), so Continue resumes from the accepted lines. */
    const fail = async (error: RunError, recordSpan = true) => {
      unit('failed')
      emit({ type: 'usage', runId, usage: priced(), cumulative: true })
      if (journal && recordSpan) {
        const recorded = await journal.failed({ fromCue: lineRange.from, toCue: lineRange.to, cause: error.kind, sent })
        if (!recorded.ok) {
          log(`Could not save ${linesLabel(batch)} as the section to retry (${recorded.message}). The saved work is as it was before this batch.`, 'stderr')
        }
      }
      return end('failed', error)
    }
    unit('sending')

    const ready = built.get(batch.cues.length)
    let audio: { mimeType: string; data: string } | null = ready?.audio ?? null
    if (!ready && snapshot.media && run.audio) {
      const span = batchMediaSpan(batch)
      const slice = await run.audio.slice(span.startSeconds, span.endSeconds, signal)
      if (!slice.ok) {
        if (slice.aborted || ended()) return stopped()
        return fail({ kind: 'unknown', message: `Could not cut the audio for ${linesLabel(batch)} of "${name}": ${slice.error}` })
      }
      audio = { mimeType: slice.mimeType, data: slice.data.toString('base64') }
    }

    let prepared = ready?.prepared ?? translationRequest(snapshot, { cues: batch.cues, resumeContext, audio, injections: { sourceContext, oracle } })
    let withBlock = sourceContext.length > 0
    // TD15-4: once a request of this batch was resent without its block, every later request of the
    // batch, its recovery tree's included, goes without one.
    let blockDropped = false
    step(reservePartition(partitions, partitions.version, from))
    step(markPartitionInFlight(partitions, partitions.version, from))
    // Requests already sent for this batch, so a resend's attempts continue the batch's numbering.
    let base = 0
    const noteAnswer = (answer: BatchAnswer): void => {
      const sentNow = answer.attempts ?? 1
      base += sentNow
      // The model's labelled summaries go to `.thoughts.log` alone, whether or not the reply then
      // passes the check: gst saves them, parts joined as sent, before it parses the reply
      // (`main.py:1229-1240`).
      if (answer.ok && answer.thoughts?.length) recordThoughtSummary(runId, { unit: batch.index, attempt: base, text: answer.thoughts.join('') })
      usage.requestCount = (usage.requestCount ?? 0) + sentNow
      usage.retryCount = (usage.retryCount ?? 0) + Math.max(0, sentNow - 1)
      addUsage(usage, answer.usage)
      if (answer.receipts) receipts.push(...answer.receipts)
    }
    /** A reply that failed the check: failed attempts are already in billedButUnusable; the rest of its tokens join them. */
    const billUnusable = (answer: BatchAnswer): void => {
      if (!answer.usage) return
      const already = answer.usage.billedButUnusableTokens ?? 0
      usage.billedButUnusableTokens = (usage.billedButUnusableTokens ?? 0) + answer.usage.totalTokens - already
    }
    /**
     * D1, gst `main.py:915-975`: the same request again after a pause, on the run's one count. Null to
     * send again; otherwise how the run ends.
     */
    const resendAfter = async (refused: { error: RunError; said: string }, about: TranslationBatch, hadBlock: boolean): Promise<(() => ReturnType<typeof stopped>) | null> => {
      const count = run.retryBudget!.fail()
      if (count >= resendPolicy.maxConsecutiveErrors) {
        return () =>
          fail({
            ...refused.error,
            message: `Stopped after ${resendPolicy.maxConsecutiveErrors} errors in a row, so as not to waste quota. Last error: ${refused.error.message}`
          })
      }
      log(`${linesLabel(about).replace(/^l/, 'L')}: ${refused.said} Error ${count}/${resendPolicy.maxConsecutiveErrors}.`, 'stderr')
      log(`Retrying batch for lines ${about.cues[0].index}-${about.cues[about.cues.length - 1].index}...`, 'stderr')
      // An identical resend repeated the same refused reply live (gate_ledger.md §5o.7), so this batch
      // is sent as the OFF request from here on (tester TD15-4).
      if (hadBlock) {
        blockDropped = true
        log(`${linesLabel(about).replace(/^l/, 'L')}: sending again without the earlier lines as context.`, 'stderr')
      }
      attempt = base + 1
      unit('retrying')
      usage.retryCount = (usage.retryCount ?? 0) + 1
      if (!(await resendClock.sleep(resendPolicy.networkWaitMs, signal)) || ended()) return stopped
      return null
    }

    // §17.8R PR-2, the batch's own request. A first shortfall and every unparseable reply are resent
    // (D1); a second shortfall, a PROHIBITED_CONTENT block, or an OTHER/UNKNOWN block after its one
    // unchanged resend (D6-8) start the recovery tree. The ladder needs the run's D1 count.
    let shortfallResent = false
    let blockResent = false
    let treeStart: { reason: PreservationReason; why: string; inHand: ValidatedBatch | null } | null = null
    for (;;) {
      const offset = base
      const answer = await run.translateBatch(
        prepared,
        { batch, retrying: (next, message) => retrying(offset + next, message), ...(inputTokens !== null ? { inputTokens } : {}) },
        signal
      )
      noteAnswer(answer)
      // A late answer — after Stop, or once this run's epoch is over — is never committed.
      if (ended()) return stopped()

      let refused: { error: RunError; said: string }
      if (!answer.ok) {
        // What `retry.ts` already decided, other than a block or an unusable reply, ends the run.
        if (answer.beforeSend || answer.storage) return fail(answer.error, false)
        if (answer.block && run.retryBudget) {
          if (answer.block.block !== 'PROHIBITED_CONTENT' && !blockResent) {
            blockResent = true
            log(`${linesLabel(batch).replace(/^l/, 'L')}: the model refused this request (${answer.block.block}); sending it once more, unchanged.`, 'stderr')
            attempt = base + 1
            unit('retrying')
            usage.retryCount = (usage.retryCount ?? 0) + 1
            if (!(await resendClock.sleep(resendPolicy.networkWaitMs, signal)) || ended()) return stopped()
            continue
          }
          treeStart = { reason: answer.block.named ? 'CONTENT_BLOCKED' : 'REASON_ABSENT', why: `the model refused it (${answer.block.block})`, inHand: null }
          break
        }
        if (answer.error.kind !== 'malformed' || !run.retryBudget) return fail(answer.error)
        refused = { error: answer.error, said: answer.error.message }
      } else {
        unit('validating')
        const published = committed.publish(batch, answer.text)
        if (published.ok) break
        billUnusable(answer)
        const error: RunError = { kind: published.failure.publicKind, message: `${published.failure.message} (${linesLabel(batch)})` }
        if (!run.retryBudget) return fail(error)
        if (published.failure.shape === 'MissingIndices') {
          if (shortfallResent) {
            treeStart = { reason: 'REASON_ABSENT', why: 'its reply left lines out again', inHand: published.failure.inHand }
            break
          }
          shortfallResent = true
        }
        refused = { error, said: published.failure.message }
      }

      const ending = await resendAfter(refused, batch, withBlock)
      if (ending) return ending()
      if (withBlock) {
        withBlock = false
        // The count described the request with the block; this one is smaller and uncounted.
        inputTokens = null
        prepared = translationRequest(snapshot, { cues: batch.cues, resumeContext, audio, injections: { oracle } })
      }
    }

    if (treeStart) {
      // §17.8R PR-1/PR-2: the batch's cues, asked for in halves, left first, until each is translated
      // or kept in its source language. Nothing of the tree is visible until all of it commits.
      const tree = committed.openTree(batch)
      if (treeStart.inHand) committed.stageInHand(tree, treeStart.inHand)
      const size = batch.cues.length
      log(`${linesLabel(batch).replace(/^l/, 'L')}: ${treeStart.why}, so ${size === 1 ? 'it is kept in the source language' : 'it is asked for in smaller pieces'}.`, 'stderr')
      let ending: (() => ReturnType<typeof stopped>) | null = null
      const maxRequests = 2 * size
      const ask = async (cueNumbers: readonly number[], more: () => boolean): Promise<CueAnswer> => {
        const child: TranslationBatch = Object.freeze({ index: batch.index, total: batch.total, cues: Object.freeze(cueNumbers.map((c) => source[c - 1])) })
        let childAudio: { mimeType: string; data: string } | null = null
        if (snapshot!.media && run.audio) {
          const span = batchMediaSpan(child)
          const slice = await run.audio.slice(span.startSeconds, span.endSeconds, signal)
          if (!slice.ok) {
            ending = slice.aborted || ended() ? stopped : () => fail({ kind: 'unknown', message: `Could not cut the audio for ${linesLabel(child)} of "${name}": ${slice.error}` })
            return { kind: 'stop' }
          }
          childAudio = { mimeType: slice.mimeType, data: slice.data.toString('base64') }
        }
        for (;;) {
          const childContext =
            carries && !blockDropped
              ? treeSourceContext({
                  source,
                  startPosition: child.cues[0].index - 1,
                  lines: snapshot!.batchContextLines,
                  committedAccepted: committed!.acceptedPositions(),
                  stagedAccepted: tree.stagedAccepted(),
                  isolated: false
                })
              : []
          const childRequest = translationRequest(snapshot!, { cues: child.cues, resumeContext, audio: childAudio, injections: { sourceContext: childContext, oracle } })
          const offset = base
          const answer = await run.translateBatch(childRequest, { batch: child, retrying: (next, message) => retrying(offset + next, message), recovery: true }, signal)
          noteAnswer(answer)
          if (ended()) {
            ending = stopped
            return { kind: 'stop' }
          }
          let refused: { error: RunError; said: string }
          if (!answer.ok) {
            if (answer.beforeSend || answer.storage) {
              const error = answer.error
              ending = () => fail(error, false)
              return { kind: 'stop' }
            }
            if (answer.block) return { kind: 'split', reason: answer.block.named ? 'CONTENT_BLOCKED' : 'REASON_ABSENT' }
            if (answer.error.kind !== 'malformed') {
              const error = answer.error
              ending = () => fail(error)
              return { kind: 'stop' }
            }
            refused = { error: answer.error, said: answer.error.message }
          } else {
            unit('validating')
            const published = committed!.publishInTree(tree, child.cues, answer.text)
            if (published.ok) {
              run.retryBudget!.accept()
              return { kind: 'resolved' }
            }
            billUnusable(answer)
            if (published.failure.shape === 'MissingIndices') return { kind: 'split', reason: 'REASON_ABSENT' }
            refused = { error: { kind: published.failure.publicKind, message: `${published.failure.message} (${linesLabel(child)})` }, said: published.failure.message }
          }
          // An unparseable reply inside the tree is D1's, on the same count; it never splits. Its resend is one
          // of the tree's 2·B requests, and with none left the reply still ends the run, never a kept line.
          if (!more()) {
            const error: RunError = {
              ...refused.error,
              message: `Stopped: the reply for ${linesLabel(child)} still could not be read after the ${maxRequests} requests ${linesLabel(batch)} may use to recover. Last error: ${refused.error.message}`
            }
            ending = () => fail(error)
            return { kind: 'stop' }
          }
          const stop = await resendAfter(refused, child, childContext.length > 0)
          if (stop) {
            ending = stop
            return { kind: 'stop' }
          }
        }
      }
      const recovered = await recoverCues(
        { cues: batch.cues.map((c) => c.index), reason: treeStart.reason },
        { ask, resolved: (cue) => committed!.resolvedInTree(tree, cue), preserve: (cue, reason) => committed!.preserveInTree(tree, cue, reason) },
        { maxDepth: Math.ceil(Math.log2(size)), maxRequests }
      )
      if (recovered.outcome === 'stopped') {
        committed.discardTree(tree)
        return (ending ?? stopped)()
      }
      const inTree = tree.preservedCues()
      committed.commitTree(tree)
      const kept = committed.preservedLines().filter((p) => inTree.has(p.index))
      log(
        kept.length
          ? `${linesLabel(batch).replace(/^l/, 'L')}: ${kept.length} of ${size} kept in the source language: ${keptLines(kept)}.`
          : `${linesLabel(batch).replace(/^l/, 'L')}: every line is translated.`,
        'stderr'
      )
    } else {
      run.retryBudget?.accept()
    }

    const snapshotText = serializeCues(committed.snapshotCues())
    const flushed = journal ? await journal.commit(output, snapshotText, committed.resolvedCount, preservedIndices()) : await output.flush(snapshotText)
    if (!flushed.ok) {
      // A retry piece's provenance is built on the record, so the next piece waits for this one to be kept.
      if (retry && journal) {
        const kept = output.keepStaged() ?? output.strandedSnapshot
        if (kept) log(`The translation with ${linesLabel(batch)} is kept as "${path.basename(kept)}". The saved work for Continue is unchanged.`, 'stderr')
        unit('failed')
        emit({ type: 'usage', runId, usage: priced(), cumulative: true })
        return end('failed', {
          kind: 'unknown',
          message: `The retry stopped: the translation of ${linesLabel(batch)} could not be saved for Continue (${flushed.stage}: ${flushed.message}).`
        })
      }
      log(`Could not update the partial subtitle after ${linesLabel(batch)} (${flushed.stage}: ${flushed.message}). Carrying on.`, 'stderr')
    }
    step(acceptPartition(partitions, partitions.version, from))
    unit('received')
    emit({ type: 'lines', runId, done: committed.resolvedCount, total })
    emit({ type: 'usage', runId, usage: priced(), cumulative: true })
  }

  if (ended()) return stopped()
  if (retry) {
    // AR3-7: the section is covered and the run pauses; the rest of the file waits for Continue.
    log(`Lines ${retry.fromCue}\u2013${retry.toCue} are translated. Start again and choose Continue to translate the rest.`)
    return { ...(await end('stopped')), paused: true }
  }
  emit({ type: 'phase', runId, phase: 'finishing' })
  const assembled = serializeCues(committed.outputCues())
  let translation = assembled
  // Feature 17: each switch gates only its own layer, and only for a Hebrew target.
  const requestedLayers = requestedGenderLayers(args)
  const hebrewTarget = referenceUiShown(args.targetLang)
  const layers = hebrewTarget ? requestedLayers : NO_GENDER_LAYERS
  const sourceLanguage = genderSourceLanguage(args, layers, text)
  const sourceCaller = (sourceLanguage === 'es' && layers.c1Spanish) || (sourceLanguage === 'pt' && layers.c1Portuguese)
  const preserved = new Set(preservedIndices())
  // What `retry.ts` decided before sending, or a quota-journal failure, ends the run here as it does for a
  // batch (R19-02): the finishing steps only see a failure, nothing further is sent, and the run stops before
  // promotion.
  let terminal: RunError | null = null
  const via = async (prepared: PreparedTranslationRequest, numbers: readonly number[], label: string): Promise<ModelReply> => {
    if (terminal) return { kind: 'failed' }
    const about: TranslationBatch = Object.freeze({ index: batchCount, total: batchCount, cues: Object.freeze(numbers.map((i) => source[i - 1])) })
    const answer = await run.translateBatch(prepared, { batch: about, retrying: (_next, message) => log(`${label}: ${message}`, 'stderr') }, signal)
    usage.requestCount = (usage.requestCount ?? 0) + (answer.attempts ?? 1)
    addUsage(usage, answer.usage)
    if (answer.receipts) receipts.push(...answer.receipts)
    emit({ type: 'usage', runId, usage: priced(), cumulative: true })
    if (answer.ok) return { kind: 'text', text: answer.text }
    if (answer.beforeSend || answer.storage) {
      terminal = answer.error
      return { kind: 'failed' }
    }
    return answer.block || answer.error.kind === 'blocked' ? { kind: 'refused' } : { kind: 'failed' }
  }
  let finishing = committed.outputCues()
  // Round 19A A.7: other-alphabet letters are repaired first, on every Hebrew run, so the gender readers see the result.
  if (hebrewTarget) {
    const stray = await repairStrayAlphabet({ source, output: finishing, preserved }, (prompt, numbers) =>
      via(strayAlphabetRequest(snapshot!, prompt, numbers), numbers, 'Other-alphabet repair')
    )
    if (ended()) return stopped()
    const stopping = terminal as RunError | null
    if (stopping) return end('failed', stopping)
    for (const line of stray.log) log(line)
    if (stray.accepted) {
      finishing = stray.cues
      translation = serializeCues(finishing)
    }
  }
  if ((oracle && reference) || sourceCaller) {
    const finished = await genderFinish({
      source,
      output: finishing,
      preserved,
      reference: oracle ? reference : null,
      sourceLanguage,
      layers,
      send: (prompt, flagged) => via(genderRepairRequest(snapshot!, prompt, flagged), flagged, 'Gender repair'),
      classify: (prompt, unread) => via(methodBClassifyRequest(snapshot!, prompt, unread), unread, 'Gender classification')
    })
    if (ended()) return stopped()
    // Set inside `via` during `genderFinish`, which control-flow narrowing does not see.
    const stopping = terminal as RunError | null
    if (stopping) return end('failed', stopping)
    for (const line of finished.log) log(line)
    translation = serializeCues(finished.cues)
  } else {
    for (const line of feature17Skipped(requestedLayers, hebrewTarget ? 'no_eligible_helper' : 'non_hebrew_target')) log(line)
  }
  if (!sameShape(translation, source)) {
    return end('failed', {
      kind: 'countMismatch',
      message: `The translation of "${name}" does not have the source's ${total} subtitles at the source's times, so it was not saved.`
    })
  }
  // Checked before every attempt to replace the destination, retries included: a Stop leaves the job
  // open and its epoch current while the run unwinds, so the epoch alone cannot fence it (§2.2a).
  const committable = () => !signal.aborted && run.isCurrent()
  let promoted: PromoteResult
  if (journal) {
    // The last commit already landed the assembled text; a record that missed it commits it first. A
    // finishing change is then recorded as a revision of that complete work (an append-only commit of the
    // same cues is refused by the record, R19-01).
    let recorded: { ok: true } | { ok: false; stage: string; message: string } = journal.complete ? { ok: true } : await journal.commit(output, assembled, total, preservedIndices())
    if (recorded.ok && translation !== assembled) recorded = await journal.revise(output, translation, preservedIndices())
    promoted = recorded.ok ? await journal.promote(output, committable) : { ok: false, stage: 'replace', message: recorded.message }
  } else {
    promoted = await output.promote(translation, committable)
  }
  if (!promoted.ok) {
    if (promoted.stage === 'superseded' || signal.aborted) return stopped()
    return end('failed', {
      kind: 'unknown',
      message:
        `Could not save "${path.basename(run.outputPath)}" (${promoted.message}).` +
        (!journal && (output.partialPath || output.strandedSnapshot) ? ' The translation is kept beside it as a partial file.' : '')
    })
  }
  const kept = committed.preservedLines()
  if (kept.length) log(`${kept.length} of ${total} line${total === 1 ? ' is' : 's are'} kept in the source language: ${keptLines(kept)}.`, 'stderr')
  return result('completed')
}

export interface GenderFinishInput {
  readonly source: readonly Cue[]
  /** The assembled translation: every cue, translated or kept in its source language. */
  readonly output: readonly Cue[]
  /** Cues kept in the source language (Bundle G). Never flagged, repaired or cleaned. */
  readonly preserved: ReadonlySet<number>
  /** The reference whose lines the requests carried; null when there was none (only a C1 source caller reads). */
  readonly reference: RunReference | null
  /** The run's source language code; null for Auto Detect. */
  readonly sourceLanguage: string | null
  readonly layers: GenderLayers
  /** One repair request through the run's seam; never throws past `repairGender`. */
  readonly send: (prompt: string, flagged: readonly number[]) => Promise<ModelReply>
  /** Method B's one blind classification request. Called only when that layer is on and an axis is unread. */
  readonly classify?: (prompt: string, unread: readonly number[]) => Promise<ModelReply>
}

export interface GenderFinish {
  readonly cues: Cue[]
  readonly flagged: number
  readonly accepted: number
  readonly cleaned: number
  readonly layers: ReadonlyMap<string, LayerOutcome>
  /** One outcome per Feature-17 layer the run asked for. */
  readonly outcomes: ReadonlyMap<Feature17Layer, LayerOutcome>
  /** Counts and closed values only. */
  readonly log: string[]
}

/** The four Feature-17 switches as the run froze them at Start; an absent one is off. */
export function requestedGenderLayers(args: Pick<TranslateArgs, 'hebrewSpeakerRepair' | 'hebrewMethodB' | 'hebrewC1Spanish' | 'hebrewC1Portuguese'>): GenderLayers {
  return Object.freeze({
    speaker: args.hebrewSpeakerRepair === true,
    methodB: args.hebrewMethodB === true,
    c1Spanish: args.hebrewC1Spanish === true,
    c1Portuguese: args.hebrewC1Portuguese === true
  })
}

/**
 * The source language C1's source caller reads: the user's choice, or for Auto Detect the language the subtitle
 * detector is certain of. Read only when a C1 switch is on, so an off switch costs nothing.
 */
export function genderSourceLanguage(args: Pick<TranslateArgs, 'sourceLang' | 'inputFile'>, layers: GenderLayers, text: string): string | null {
  if (!layers.c1Spanish && !layers.c1Portuguese) return null
  if (args.sourceLang && args.sourceLang !== 'auto') return referenceLanguage(args.sourceLang)
  try {
    const seen = inspectSubtitleBytes(Buffer.from(text, 'utf-8'), { path: path.basename(args.inputFile) || 'source.srt' })
    return seen.ok && seen.inspection.languageCertain ? referenceLanguage(seen.inspection.language) : null
  } catch {
    return null
  }
}

function outcomeOf(skip: LayerSkip | null, from?: LayerOutcome): LayerOutcome {
  return { ...(from ?? emptyLayerOutcome()), ...(skip ? { skip } : {}) }
}

/** The metadata lines for layers that were asked for but never reached a reader. */
export function feature17Skipped(layers: GenderLayers, skip: LayerSkip): string[] {
  return FEATURE17_LAYERS.filter((l) => layers[l]).map((l) => layerLogLine(l, outcomeOf(skip)))
}

/**
 * Bundle H at the end of a run (`implementation_plan.md` H.11, F17.3): compare each translated cue with its aligned
 * reference line (and, with a C1 switch on, a Spanish or Portuguese source line) on the designated readers, flag
 * the opposite readings, send one repair request for the flagged cues (two when any cue has a speaker correction:
 * the addressee-only cues first, then the speaker cues, Round 19A A.5), then — Method B on — one blind
 * classification of the axes no reader could read and one repair of its contradictions. A speaker tag the
 * reference leaked is stripped. A cue kept in the source language is never touched; a failed, refused or
 * unreadable request leaves every cue as the previous step left it.
 */
export async function genderFinish(input: GenderFinishInput): Promise<GenderFinish> {
  const reference = input.reference && input.reference.lines.size > 0 && hintEligible(input.reference.helper) ? input.reference : null
  const helper = reference?.helper ?? null
  const helperLines: ReadonlyMap<number, string> = reference?.lines ?? new Map()
  const helperLanguage = reference?.language ?? ''
  const srcLang = referenceLanguage(input.sourceLanguage)
  const sourceText = new Map(input.source.map((c) => [c.index, c.text]))
  const translated = input.output.filter((c) => !input.preserved.has(c.index))
  const flagged = designatedFlags({
    source: input.source,
    output: new Map(translated.map((c) => [c.index, c.text])),
    oracle: helperLines,
    helper,
    sourceLanguage: input.sourceLanguage,
    layers: input.layers
  })
  const numbers = [...flagged.flags.keys()].sort((a, b) => a - b)
  // A C1 source-caller cue with no aligned reference line: its own source line is the evidence.
  const repairOracle = new Map(helperLines)
  const sourceOnly = new Map<number, string>()
  for (const n of numbers) {
    if (repairOracle.has(n)) continue
    repairOracle.set(n, sourceText.get(n) ?? '')
    if (srcLang) sourceOnly.set(n, srcLang)
  }
  const repaired = numbers.length
    ? await repairGenderByAxis(
        {
          source: input.source,
          output: input.output,
          flags: flagged.flags,
          oracle: repairOracle,
          referenceLanguage: helperLanguage,
          ...(sourceOnly.size ? { referenceLanguages: sourceOnly } : {})
        },
        (prompt, flaggedNumbers) => input.send(prompt, flaggedNumbers)
      )
    : null
  let cues = repaired?.cues ?? [...input.output]
  const methodB = input.layers.methodB ? await methodBStep(input, cues, helper, helperLines, helperLanguage) : null
  if (methodB) cues = methodB.cues
  let cleaned = 0
  if (reference) {
    cues = cues.map((c) => {
      if (input.preserved.has(c.index)) return c
      const text = stripLeakedSpeakerTags(c.text, sourceText.get(c.index) ?? '')
      if (text === c.text) return c
      cleaned += 1
      return { ...c, text }
    })
  }
  const accepted = (repaired?.accepted ?? 0) + (methodB?.accepted ?? 0)
  const from = reference ? 'the reference' : 'the source'
  const log = [
    numbers.length
      ? `Gender check: ${numbers.length} line${numbers.length === 1 ? '' : 's'} read the other gender from ${from}; ${repaired?.accepted ?? 0} corrected.`
      : `Gender check: no line read the other gender from ${from}.`
  ]
  if (cleaned) log.push(`Gender reference: removed a leaked speaker name from ${cleaned} line${cleaned === 1 ? '' : 's'}.`)
  const layers = new Map<string, LayerOutcome>()
  for (const l of GENDER_LAYERS) {
    const o = l === 'methodB' ? methodB?.outcome : repaired?.layers.get(l)
    if (o) layers.set(l, o)
  }
  const helperLang = helper ? referenceLanguage(helper.kind === 'wizdom' ? null : helper.language) : null
  const direct = (l: 'speaker' | 'c1Spanish' | 'c1Portuguese', eligible: boolean): LayerOutcome => {
    if (!eligible) return outcomeOf('no_eligible_helper')
    const r = repaired?.layers.get(l)
    if (r) return outcomeOf(null, r)
    return outcomeOf(flagged.conflicts.get(l) ? 'conflict' : 'no_evidence')
  }
  const outcomes = new Map<Feature17Layer, LayerOutcome>()
  if (input.layers.speaker) outcomes.set('speaker', direct('speaker', helper !== null && speakerEligible(helper)))
  if (input.layers.methodB && methodB) outcomes.set('methodB', methodB.outcome)
  if (input.layers.c1Spanish) outcomes.set('c1Spanish', direct('c1Spanish', helperLang === 'es' || srcLang === 'es'))
  if (input.layers.c1Portuguese) outcomes.set('c1Portuguese', direct('c1Portuguese', helperLang === 'pt' || srcLang === 'pt'))
  for (const l of FEATURE17_LAYERS) {
    const o = outcomes.get(l)
    if (o) log.push(layerLogLine(l, o))
  }
  if (methodB?.accepted) log.push(`Gender check: the unread-gender classification corrected ${methodB.accepted} more line${methodB.accepted === 1 ? '' : 's'}.`)
  const twoSpeaker = (repaired?.twoSpeakerSkipped ?? 0) + (methodB?.twoSpeakerSkipped ?? 0)
  if (twoSpeaker) log.push(`Gender check: ${twoSpeaker} line${twoSpeaker === 1 ? '' : 's'} where two people speak kept the speaker gender as translated.`)
  return { cues, flagged: numbers.length, accepted, cleaned, layers, outcomes, log }
}

/**
 * Feature 17 Method B after B1: on each translated cue, an axis the output reader cannot read is classified only
 * where the reference asserts a gender on that axis (the speaker axis only with the speaker switch on too). The
 * classifier sees the Hebrew lines and nothing about the reference. Its contradictions of the reference go
 * through the same guarded repair. Any refusal, failure or malformed or short label set keeps B1's cues; there
 * is no split or second classification.
 */
async function methodBStep(
  input: GenderFinishInput,
  b1: Cue[],
  helper: HelperProvenance | null,
  helperLines: ReadonlyMap<number, string>,
  helperLanguage: string
): Promise<{ cues: Cue[]; accepted: number; twoSpeakerSkipped: number; outcome: LayerOutcome }> {
  const keep = (skip: LayerSkip) => ({ cues: b1, accepted: 0, twoSpeakerSkipped: 0, outcome: outcomeOf(skip) })
  if (!helper) return keep('no_eligible_helper')
  const sourceText = new Map(input.source.map((c) => [c.index, c.text]))
  const asserts = (index: number, axis: GenderAxis): Gender | null => {
    if (input.preserved.has(index) || (axis === 'speaker' && !input.layers.speaker)) return null
    const ref = helperLines.get(index)
    return ref ? helperReading(axis, ref, helper, input.layers, { text: sourceText.get(index) ?? '', language: input.sourceLanguage }) : null
  }
  const asserted = b1.some((c) => asserts(c.index, 'addressee') !== null || asserts(c.index, 'speaker') !== null)
  if (!asserted) return keep('no_evidence')
  const unread = methodBUnread(b1, (i, axis) => asserts(i, axis) !== null)
  const prompt = methodBPrompt(b1, unread)
  if (!prompt) return keep('reader_resolved')
  if (!input.classify) return keep('failed')
  let reply: ModelReply
  try {
    reply = await input.classify(prompt, [...unread.keys()])
  } catch {
    reply = { kind: 'failed' }
  }
  if (reply.kind !== 'text') return keep(reply.kind === 'refused' ? 'refused' : 'failed')
  const labels = parseMethodBLabels(reply.text, unread)
  if (!labels) return keep('invalid_response')
  const flags = methodBFlags(labels, unread, asserts)
  if (!flags.size) return keep('no_evidence')
  const numbers = [...flags.keys()].sort((a, b) => a - b)
  const r = await repairGender(
    { source: input.source, output: b1, flags, oracle: helperLines, referenceLanguage: helperLanguage },
    (p) => input.send(p, numbers)
  )
  return { cues: r.cues, accepted: r.accepted, twoSpeakerSkipped: r.twoSpeakerSkipped, outcome: outcomeOf(null, r.layers.get('methodB')) }
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

export interface NativeTranslateBatchOptions {
  provider: GenerationProvider
  /** Key values by slot, read at the moment of each call and nowhere else. */
  keys: readonly string[]
  /** This run's slots, best first (`runKeySlots('translate', …)`). */
  slots: readonly number[]
  /** The run's one consecutive-error count; `runTranslation` resets it when a batch commits. */
  budget: RetryBudget
  retry?: { policy?: Partial<RetryPolicy>; clock?: RetryClock }
  /** The run's request gate (`createRequestGate`): routing, pacing and the write-ahead reservation. */
  gate?: AttemptGate
  /** Where each batch's counted input is left for the gate's `estimate` to read. */
  counted?: { tokens: number | null }
}

/**
 * One batch's request, sent until it answers or `retry.ts` says stop (the D14 §14.4 matrix). The
 * key rotation is the run's, so a key rejected as invalid stays out for every later batch. A block
 * or an unusable reply comes back to `runTranslation`, whose Bundle G ladder decides between a resend
 * and a split.
 */
export function nativeTranslateBatch(opts: NativeTranslateBatchOptions): TranslateBatch {
  const rotation = createKeyRotation(opts.slots)
  const limitBytes = responseLimitBytes({ outputTokenLimit: null })
  return async (prepared, unit, signal) => {
    if (opts.counted) opts.counted.tokens = unit.inputTokens ?? null
    const receipts: ProviderRequestReceipt[] = []
    const unusable: Usage[] = []
    const last: { reply: ProviderReply | null } = { reply: null }
    const outcome = await withRetry<{ text: string; thoughts?: string[] }>({
      keys: rotation,
      budget: opts.budget,
      signal,
      ...(opts.retry?.policy ? { policy: opts.retry.policy } : {}),
      ...(opts.retry?.clock ? { clock: opts.retry.clock } : {}),
      ...(opts.gate ? { gate: opts.gate } : {}),
      ...(unit.recovery ? { requestKind: 'recovery' as const } : {}),
      onRetry: (notice) => {
        // The count described the refused BLOCK_NONE request; the OFF resend goes uncounted (PR-4).
        if (notice.safetyResend && opts.counted) opts.counted.tokens = null
        unit.retrying(notice.attempt + 1, notice.message)
      },
      attempt: async ({ keySlot, quotaGroupId, signal: attemptSignal, timeoutMs }) => {
        receipts.push(
          providerRequestReceipt(prepared, {
            effectiveSlot: keySlot,
            quotaGroupId: quotaGroupId ?? null,
            timeoutMs,
            responseLimitBytes: limitBytes,
            outputTokenLimit: null,
            safetySettingCount: GEMINI_SAFETY_SETTINGS.length
          })
        )
        const reply = await opts.provider.generate(prepared.request, {
          apiKey: opts.keys[keySlot] ?? '',
          keyIndex: keySlot,
          signal: attemptSignal,
          responseLimitBytes: limitBytes,
          timeoutMs
        })
        last.reply = reply
        if (!reply.result.ok) {
          if (reply.usage) unusable.push(reply.usage)
          return { ok: false as const, failure: reply.result, usage: reply.usage }
        }
        const thoughts = reply.result.thoughtSummaries
        return { ok: true as const, value: { text: reply.result.text, ...(thoughts?.length ? { thoughts: [...thoughts] } : {}) }, usage: reply.usage }
      }
    })
    const usage = sumUsage(outcome.usage)
    const wasted = sumUsage(!outcome.ok && outcome.discarded ? [...unusable, outcome.discarded] : unusable)
    const facts: AnswerFacts = {
      ...(usage ? { usage: wasted ? { ...usage, billedButUnusableTokens: wasted.totalTokens } : usage } : {}),
      attempts: outcome.attempts,
      receipts
    }
    if (outcome.ok) return { ok: true, ...outcome.value, ...facts }
    let error: RunError = outcome.error ?? { kind: 'unknown', message: 'The request was stopped.' }
    let block: AnnouncedBlock | null = null
    if (error.kind === 'blocked' && last.reply) {
      // The typed class reads the whole envelope; the API's own word stays when it names neither.
      const cls = classifyBlock(last.reply)
      if (cls === 'PROHIBITED_CONTENT' || cls === 'OTHER') error = { ...error, blockReason: cls }
      block = announcedBlock(last.reply)
    }
    return {
      ok: false,
      error,
      ...(outcome.beforeSend ? { beforeSend: true as const } : {}),
      ...(outcome.storage ? { storage: true as const } : {}),
      ...(block ? { block } : {}),
      ...facts
    }
  }
}

/**
 * Which Quota Groups an accepted run may still wait, reserve or send through (§12.3). A group a run
 * holds cannot be deleted; the budget journal is never read to decide that. In memory only: a restart
 * has no run in progress.
 */
export interface ActiveQuotaGroupRegistry {
  /** At accepted-run start, with every group attached to a then-eligible Free key. Idempotent. */
  acquire(runId: string, initialIds: Iterable<string>): void
  /** Before a run first waits, reserves or sends through a group it did not start with. Idempotent. */
  add(runId: string, groupId: string): void
  /** Only from the run's single terminal `finally`. */
  release(runId: string): void
  activeIds(): ReadonlySet<string>
}

export function createActiveQuotaGroupRegistry(): ActiveQuotaGroupRegistry {
  const byRun = new Map<string, Set<string>>()
  return Object.freeze({
    acquire: (runId: string, initialIds: Iterable<string>) => {
      const held = byRun.get(runId) ?? new Set<string>()
      for (const id of initialIds) held.add(id)
      byRun.set(runId, held)
    },
    add: (runId: string, groupId: string) => {
      const held = byRun.get(runId) ?? new Set<string>()
      held.add(groupId)
      byRun.set(runId, held)
    },
    release: (runId: string) => {
      byRun.delete(runId)
    },
    activeIds: () => {
      const all = new Set<string>()
      for (const held of byRun.values()) for (const id of held) all.add(id)
      return all
    }
  })
}

/** The process's one registry: runs write it, `settings:mutateQuotaGroup` reads it. */
export const activeQuotaGroups: ActiveQuotaGroupRegistry = createActiveQuotaGroupRegistry()

// ── Bundle F: the request gate (implementation_plan.md §12.4–§12.6, D8-11) ───────────────────

/** The Settings a native route and its budget read before every attempt. */
export type RequestGateSettings = Pick<
  AppSettings,
  | 'apiKeys'
  | 'apiKeyTiers'
  | 'apiKeyQuotaGroups'
  | 'cachedModels'
  | 'allowPaidFallback'
  | 'automaticFreeTierProtection'
  | 'manualQuotaLimitsEnabled'
  | 'manualQuotaReservePercent'
  | 'quotaGroups'
  | 'learnedQuotaEvidence'
> &
  Partial<Pick<AppSettings, 'apiKeyValid'>>

export interface RequestGateOptions {
  runId: string
  /** A second gate in the same run (Transcribe's Stage C): its own attempt ids, so none collides with the first gate's. */
  stage?: string
  model: string
  requestKind: UsageRequestKind
  /** The key values this run started with, by slot. Read only to tell whether a slot still holds the same key. */
  keys: readonly string[]
  settings: () => RequestGateSettings
  budget: RequestBudget
  revisions: SettingsRevisionSource
  registry: ActiveQuotaGroupRegistry
  /** One typed pacing state; the renderer's FreeTierNotice draws it. */
  onBudget: (snapshot: BudgetSnapshot) => void
  /** Explicit structured quota evidence, for Settings' learned history. */
  learn?: (row: LearnedQuotaEvidence) => void
  /** The exact counted input of the request about to be sent, when the advisor has one. */
  estimate?: () => number | null
  /** The run's safe request totals; every gate of one run notes into the same account. */
  account?: UsageAccount
  clock?: BudgetClock
  /** A wait; resolves `false` when `signal` ended it early. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>
}

const MIN_GATE_WAIT_MS = 50
/** `setTimeout` fires at once for a delay above this, so a longer wait is slept in pieces. */
const MAX_TIMER_MS = 2_147_483_647
/** The last instant a `Date` can hold. A shown wait is drawn at it; a stored hold past it is refused. */
const MAX_DATE_MS = 8_640_000_000_000_000

function wallAt(ms: number): number {
  return Math.min(ms, MAX_DATE_MS)
}

/** The request gate's default wait: true when it ran out, false when Stop ended it. */
export function gateSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false)
    let left = Math.max(0, ms)
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = (): void => done(false)
    const arm = (): void => {
      const piece = Math.min(left, MAX_TIMER_MS)
      left -= piece
      timer = setTimeout(() => (left > 0 ? arm() : done(true)), piece)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    arm()
  })
}

type RankedSlot = RouteSlot & { valid: boolean | null }

/**
 * Which slot holds which group, tier and model evidence now, for the slots that still hold this run's
 * keys, re-ranked as `orderKeySlots` ranks at Start: a key Fetch Models has since proven invalid leaves,
 * a known-valid key goes before an unchecked one, and equal keys keep their configured (slot) order.
 * The first slot is the route's effective primary.
 */
function routeSlotsOf(live: readonly number[], keys: readonly string[], s: RequestGateSettings, start: ReadonlyMap<number, RankedSlot>, model: string): RankedSlot[] {
  const stored = Array.isArray(s.apiKeys) ? s.apiKeys : []
  const cachedList = Array.isArray(s.cachedModels) ? s.cachedModels : []
  const cached = cachedList.find((m) => m?.id === model)
  // A slot that answered the refresh the cache came from lists at least one model. One that lists none
  // did not answer, so its availability is unknown, and unknown stays eligible.
  const answered = new Set<number>()
  for (const m of cachedList) if (m?.source === 'live') for (const n of m.availableOn ?? []) answered.add(n)
  // A missing, orphaned, malformed or ambiguous assignment budgets as Group A, the conservative reading.
  const groups = quotaGroupRuntimeView(s).resolvedKeyGroupIds
  const rank = (v: boolean | null): number => (v === true ? 0 : 1)
  return live
    .map((slot): RankedSlot => {
      const sameKey = typeof stored[slot] === 'string' && stored[slot].trim() === (keys[slot] ?? '').trim()
      if (!sameKey) return start.get(slot) ?? { slot, tier: 'free', groupId: DEFAULT_QUOTA_GROUP_ID, modelAbsent: false, valid: null }
      const tier = s.apiKeyTiers?.[slot] === 'paid' ? 'paid' : 'free'
      const groupId = groups[slot] ?? DEFAULT_QUOTA_GROUP_ID
      const modelAbsent = cached?.source === 'live' && answered.has(slot) ? !(cached.availableOn ?? []).includes(slot) : false
      const v = s.apiKeyValid?.[slot]
      return { slot, tier, groupId, modelAbsent, valid: v === true ? true : v === false ? false : null }
    })
    .filter((r) => r.valid !== false)
    // Ties keep the configured order, as `orderKeySlots` does at Start — never the order Start ranked them in.
    .sort((a, b) => rank(a.valid) - rank(b.valid) || a.slot - b.slot)
}

/** The latest valid future daily reset a quota answer states, or none. */
function statedReset(failure: Extract<BatchFailure, { kind: 'quota' }>, nowWall: number): number | undefined {
  let latest: number | undefined
  const consider = (s: string | undefined): void => {
    const t = Date.parse(s ?? '')
    if (Number.isFinite(t) && t > nowWall && t <= MAX_DATE_MS && (latest === undefined || t > latest)) latest = t
  }
  consider(failure.resetAt)
  for (const d of failure.quotaDetails ?? []) if (d.metric === 'rpd') consider(d.resetAt)
  return latest
}

/**
 * What one Free attempt's quota or rate refusal leaves in the request record: the explicit hold it
 * stated, then a daily stop. The first write that fails is returned; nothing after it is attempted.
 */
function journalRefusal(budget: RequestBudget, groupId: string, model: string, failure: BatchFailure | null, nowWall: number): JournalWrite {
  if (!failure || (failure.kind !== 'quota' && failure.kind !== 'rate-limit')) return { ok: true }
  // A hold that ends past the last date is no hint at all: it is never stored, clamped or not.
  if (failure.retryAfterMs !== undefined && Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs >= 0 && nowWall + failure.retryAfterMs <= MAX_DATE_MS) {
    const held = budget.notBefore(groupId, model, 'retry', nowWall + failure.retryAfterMs)
    if (!held.ok) return held
  }
  if (failure.kind === 'quota' && failure.metric === 'rpd') return budget.exhausted(groupId, model, statedReset(failure, nowWall))
  return { ok: true }
}

const FINGERPRINT_METRICS = new Set(['rpm', 'tpm', 'rpd', 'retry', 'other'])

/** A structural name as Google writes one. Any other name may carry a value, so it is never kept. */
const SAFE_KEY_NAME = /^@?[A-Za-z][A-Za-z0-9_]{0,39}$/
/** `keyPaths`' own count of the paths it left out. */
const MORE_PATHS = /^\(\+\d+ more\)$/

/** §12.10: each unsafe or dynamic key name becomes `[redacted-key]`; `[]` array positions stay. */
function fingerprintKeys(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (MORE_PATHS.test(p)) {
      out.add(p)
      continue
    }
    const segments = p.split('.').map((segment) => {
      const name = segment.replace(/(\[\])+$/, '')
      const safe = SAFE_KEY_NAME.test(name) && !/^AIza/.test(name)
      return (safe ? name : '[redacted-key]') + segment.slice(name.length)
    })
    out.add(segments.join('.'))
  }
  return [...out].sort()
}

/** SHA-256 of the stable JSON `{ code, detailKeys, metric }` (§12.10): structure only, never a value. */
function evidenceFingerprint(code: string | undefined, metric: string | undefined, detailKeys: readonly string[]): string {
  const canonical = JSON.stringify({
    code: (code ?? '').trim().toUpperCase() || 'UNKNOWN',
    detailKeys: [...new Set(detailKeys)].sort(),
    metric: metric && FINGERPRINT_METRICS.has(metric) ? metric : 'other'
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * A required request-record write that failed, by the run's budget. Every gate of one run shares its
 * budget, so a fault in one stage stops every other stage's next send too.
 */
const storageFaults = new WeakMap<RequestBudget, string>()

function groupLabel(s: RequestGateSettings, groupId: string): string | undefined {
  const g = (Array.isArray(s.quotaGroups) ? s.quotaGroups : []).find((x) => x?.id === groupId)
  return typeof g?.label === 'string' && g.label ? g.label : undefined
}

/**
 * The run's one request gate, shared by every request it sends (`withRetry`'s `gate`). Before each
 * attempt it reads Settings, routes (`chooseRoute`), waits for the budget against Stop and every
 * Settings revision, then writes the reservation before anything is sent. After each attempt it
 * reconciles actual input once and records only explicit structured quota evidence.
 *
 * With Automatic Free-Tier Protection off, nothing is reserved or read from the journal; routing,
 * consent and model availability still apply, and a quota answer still steers later attempts away
 * from its group for as long as it said, in memory only.
 */
export function createRequestGate(opts: RequestGateOptions): AttemptGate {
  const clock = opts.clock ?? systemBudgetClock
  const sleep = opts.sleep ?? gateSleep
  const stage = (opts.stage ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16)
  const token = (opts.runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'run') + (stage ? `-${stage}` : '')
  let seq = 0
  /** Group → monotonic time before which a quota answer said not to send. In memory only. */
  const pressure = new Map<string, number>()
  /** Protection off: group → epoch ms its structured daily exhaustion lasts until. */
  const spentToday = new Map<string, { untilEpochMs: number; resetSource: 'api' | 'pacific' }>()
  let globalUntilMono = 0
  /**
   * A Free-route overload with Allow paid fallback on: the next attempt goes to the Paid key at once. Holds
   * the time the overload pause would have lasted, which applies after all if no Paid key can take it.
   */
  let overloadToPaidUntil = 0
  let lastRanked: readonly RouteSlot[] = []
  let lastGroup: string | null = null
  let paidAnnounced = false
  let shown: BudgetSnapshot['state'] = 'ready'
  let start: Map<number, RankedSlot> | null = null
  /** The counted input each sent attempt was budgeted at, for its bucket. */
  const estimates = new WeakMap<GateTicket, number>()
  /** Each sent Free attempt's group label as it read at dispatch: display only, never an identity. */
  const labels = new WeakMap<GateTicket, string>()
  /** A sent attempt's request kind, when the request named one other than the gate's own. */
  const kinds = new WeakMap<GateTicket, UsageRequestKind>()
  const latch = (message: string): void => {
    if (!storageFaults.has(opts.budget)) storageFaults.set(opts.budget, message)
  }
  const noteWrite = (written: JournalWrite): void => {
    if (!written.ok) latch(written.message)
  }
  const faultOf = (message: string): GateStorageFault => ({ failure: { ok: false, kind: 'unknown', detailKeys: [] }, error: { kind: 'refusedByApp', message } })
  /** A storage refusal before a send. It ends the run, not merely this stage, so it is latched too. */
  const storageStop = (message: string): GateDecision => {
    latch(message)
    return { kind: 'stop', ...faultOf(storageFaults.get(opts.budget) ?? message), storage: true }
  }

  const say = (s: RequestGateSettings, snapshot: BudgetSnapshot, groupId?: string): void => {
    const label = groupId ? groupLabel(s, groupId) : undefined
    shown = snapshot.state
    opts.onBudget(label ? { ...snapshot, quotaGroupLabel: label } : snapshot)
  }

  const stopWith = (failure: BatchFailure, error: RunError): GateDecision => ({ kind: 'stop', failure, error })

  return {
    async before(input) {
      for (;;) {
        if (input.signal.aborted) return { kind: 'cancelled' }
        const latched = storageFaults.get(opts.budget)
        if (latched !== undefined) return storageStop(latched)
        const revision = opts.revisions.current()
        const s = opts.settings()
        const protection = s.automaticFreeTierProtection !== false
        const ranked = routeSlotsOf(input.live, opts.keys, s, start ?? new Map(), opts.model)
        lastRanked = ranked
        if (!start) {
          start = new Map(ranked.map((r) => [r.slot, r]))
          opts.registry.acquire(opts.runId, ranked.filter((r) => r.tier === 'free' && !r.modelAbsent).map((r) => r.groupId))
          if (protection) {
            const compacted = opts.budget.compact()
            if (!compacted.ok) return storageStop(compacted.message)
          }
        }
        const estimate = opts.estimate?.() ?? null
        const storage: { message: string | null } = { message: null }
        const readinessOf = (groupId: string): GroupReadiness => {
          const nowMono = clock.monoNow()
          let r: GroupReadiness = { state: 'ready' }
          if (protection) {
            const checked = opts.budget.check(groupId, opts.model, estimate)
            if (checked.state === 'storageError') {
              storage.message = checked.message
              return { state: 'dailyExhausted', untilEpochMs: 0, resetSource: 'pacific' }
            }
            if (checked.state === 'waiting') r = { state: 'waiting', metric: checked.metric, readyAtMono: checked.readyAtMono, untilEpochMs: checked.untilEpochMs }
            if (checked.state === 'dailyExhausted') return { state: 'dailyExhausted', untilEpochMs: checked.untilEpochMs, resetSource: checked.resetSource }
          } else {
            const spent = spentToday.get(groupId)
            if (spent && spent.untilEpochMs > clock.wallNow()) return { state: 'dailyExhausted', ...spent }
          }
          const held = pressure.get(groupId) ?? 0
          if (held > nowMono && (r.state !== 'waiting' || held > r.readyAtMono)) {
            r = { state: 'waiting', metric: 'retry', readyAtMono: held, untilEpochMs: wallAt(clock.wallNow() + (held - nowMono)) }
          }
          return r
        }

        // A wait that belongs to no group (overload, transport) comes first, whatever the route.
        const nowMono = clock.monoNow()
        if (globalUntilMono > nowMono) {
          say(s, { model: opts.model, state: 'waiting', metric: 'retry', untilEpochMs: wallAt(clock.wallNow() + (globalUntilMono - nowMono)), message: 'Waiting before sending again.' })
          const outcome = await waitFor(globalUntilMono - nowMono, input.signal, revision)
          if (outcome === 'cancelled') return { kind: 'cancelled' }
          continue
        }

        if (overloadToPaidUntil <= nowMono) overloadToPaidUntil = 0
        const toPaid = overloadToPaidUntil > 0
        // Every Free group reads as paused until the overload pause would end, so the consented Paid fallback
        // takes the request; with consent withdrawn since, the same pause is simply waited out.
        const routeReadiness = toPaid
          ? (groupId: string): GroupReadiness => {
              const r = readinessOf(groupId)
              if (r.state === 'dailyExhausted' || (r.state === 'waiting' && r.readyAtMono >= overloadToPaidUntil)) return r
              return { state: 'waiting', metric: 'retry', readyAtMono: overloadToPaidUntil, untilEpochMs: wallAt(clock.wallNow() + (overloadToPaidUntil - nowMono)) }
            }
          : readinessOf
        const choice = chooseRoute({ ranked, current: input.current, allowPaidFallback: s.allowPaidFallback === true, reactive: toPaid || (input.failure !== null && isPressure(input.failure)), readinessOf: routeReadiness })
        if (storage.message !== null) return storageStop(storage.message)
        switch (choice.kind) {
          case 'noKey': {
            const failure: BatchFailure = { ok: false, kind: 'auth', reason: 'invalid', keyIndex: input.current ?? 0 }
            return stopWith(failure, { ...projectFailure(failure), message: 'Every API key this run may use was rejected as invalid. Check the keys in Settings.' })
          }
          case 'modelUnavailable':
            return stopWith(
              { ok: false, kind: 'request-invalid', detailKeys: [] },
              {
                kind: 'refusedByApp',
                message: `None of the API keys this run may use lists ${opts.model}. Nothing more was sent. Press \u201cFetch Models & Check API Keys\u201d in Settings, or choose another model.`
              }
            )
          case 'dailyExhausted': {
            say(s, { model: opts.model, state: 'dailyExhausted', metric: 'rpd', ...(choice.untilEpochMs > 0 ? { untilEpochMs: choice.untilEpochMs } : {}), message: DAILY_MESSAGE })
            const failure: BatchFailure = { ok: false, kind: 'quota', metric: 'rpd', detailKeys: [] }
            return stopWith(failure, { ...projectFailure(failure), message: DAILY_MESSAGE })
          }
          case 'wait': {
            opts.registry.add(opts.runId, choice.groupId)
            say(s, { model: opts.model, state: 'waiting', metric: choice.metric, untilEpochMs: choice.untilEpochMs, message: waitMessage(choice.metric) }, choice.groupId)
            const outcome = await waitFor(choice.readyAtMono - clock.monoNow(), input.signal, revision)
            if (outcome === 'cancelled') return { kind: 'cancelled' }
            continue
          }
          case 'send': {
            if (choice.tier === 'free') opts.registry.add(opts.runId, choice.groupId)
            // A Settings change since this route was read sends nothing on it: read again.
            if (opts.revisions.current() !== revision) continue
            if (input.signal.aborted) return { kind: 'cancelled' }
            if (choice.paidFallback && !paidAnnounced) {
              paidAnnounced = true
              say(s, {
                model: opts.model,
                state: 'paidFallback',
                message: 'Free keys cannot send now, so this run is switching to your paid key, as Allow paid fallback permits. Paid usage begins with the next request.'
              })
            } else if (choice.tier === 'free' && lastGroup !== null && lastGroup !== choice.groupId) {
              say(s, { model: opts.model, state: 'groupSwitch', message: 'The last Quota Group would have to wait, so this run is continuing with another one.' }, choice.groupId)
            } else if (shown !== 'ready') {
              say(s, { model: opts.model, state: 'ready', message: '' })
            }
            if (choice.tier === 'free') lastGroup = choice.groupId
            let attemptId: string | null = null
            if (choice.tier === 'free' && protection) {
              attemptId = `${token}:${++seq}`
              const written = opts.budget.reserve({ attemptId, groupId: choice.groupId, model: opts.model, requestKind: input.requestKind ?? opts.requestKind, estimate })
              if (!written.ok) return storageStop(written.message)
            }
            if (input.signal.aborted) return { kind: 'cancelled' }
            overloadToPaidUntil = 0
            const ticket: GateTicket = { slot: choice.slot, groupId: choice.groupId, tier: choice.tier, attemptId }
            if (estimate !== null) estimates.set(ticket, estimate)
            if (input.requestKind) kinds.set(ticket, input.requestKind)
            const label = choice.tier === 'free' ? groupLabel(s, choice.groupId) : undefined
            if (label) labels.set(ticket, label)
            return { kind: 'send', slot: choice.slot, ticket }
          }
        }
      }
    },

    retryWait(ticket, failure, waitMs) {
      const until = clock.monoNow() + Math.max(0, waitMs)
      if (ticket.tier === 'free' && failure.kind === 'overload' && paidFallbackOpen(opts.settings(), lastRanked)) {
        if (until > overloadToPaidUntil) overloadToPaidUntil = until
        return true
      }
      if (ticket.tier === 'free' && isPressure(failure)) {
        if (until > (pressure.get(ticket.groupId) ?? 0)) pressure.set(ticket.groupId, until)
      } else if (until > globalUntilMono) {
        globalUntilMono = until
      }
    },

    after(ticket, result) {
      record(ticket, result)
      const latched = storageFaults.get(opts.budget)
      return latched === undefined ? null : faultOf(latched)
    }
  }

  function record(ticket: GateTicket, result: { failure: BatchFailure | null; usage: Usage | null }): void {
    const s = opts.settings()
    const protection = s.automaticFreeTierProtection !== false
    if (ticket.attemptId !== null) noteWrite(opts.budget.reconcile(ticket.attemptId, result.usage?.promptTokens))
    const label = labels.get(ticket)
    opts.account?.note({
      model: opts.model,
      // A paid key budgets against no Quota Group, so its bucket names none.
      ...(ticket.tier === 'free' ? { quotaGroupId: ticket.groupId, ...(label ? { quotaGroupLabel: label } : {}) } : {}),
      requestKind: kinds.get(ticket) ?? opts.requestKind,
      estimate: estimates.get(ticket) ?? null,
      usage: result.usage,
      failure: result.failure
    })
    const failure = result.failure
    if (!failure || ticket.tier !== 'free') return
    const nowWall = clock.wallNow()
    if (protection) noteWrite(journalRefusal(opts.budget, ticket.groupId, opts.model, failure, nowWall))
    if (failure.kind !== 'quota') return
    if (!protection && failure.metric === 'rpd') {
      const apiReset = statedReset(failure, nowWall)
      spentToday.set(ticket.groupId, apiReset !== undefined ? { untilEpochMs: apiReset, resetSource: 'api' } : { untilEpochMs: pacificPeriod(nowWall).resetAt, resetSource: 'pacific' })
    }
    if (opts.learn && failure.quotaDetails?.length) {
      const observedAt = new Date(nowWall).toISOString()
      const conflicted = new Set(
        failure.quotaDetails.filter((d, i, all) => d.limit !== undefined && all.some((o) => o.metric === d.metric && o.limit !== undefined && o.limit !== d.limit)).map((d) => d.metric)
      )
      const detailKeys = fingerprintKeys(failure.detailKeys)
      for (const d of failure.quotaDetails) {
        const limit = d.limit !== undefined && !conflicted.has(d.metric) ? d.limit : undefined
        opts.learn({
          groupId: ticket.groupId,
          model: opts.model,
          metric: d.metric,
          ...(limit !== undefined ? { limit } : {}),
          ...(d.resetAt ? { resetAt: d.resetAt } : {}),
          observedAt,
          source: 'api-429',
          fingerprint: evidenceFingerprint(failure.statusCode, d.metric, detailKeys),
          detailKeys
        })
      }
    }
  }

  async function waitFor(ms: number, signal: AbortSignal, revision: number): Promise<'elapsed' | 'woken' | 'cancelled'> {
    const wake = new AbortController()
    const unsubscribe = opts.revisions.subscribe(() => wake.abort())
    try {
      if (opts.revisions.current() !== revision) return 'woken'
      await sleep(Math.max(MIN_GATE_WAIT_MS, ms), AbortSignal.any([signal, wake.signal]))
      if (signal.aborted) return 'cancelled'
      return wake.signal.aborted ? 'woken' : 'elapsed'
    } finally {
      unsubscribe()
    }
  }
}

/** At most this many model × Quota Group × request-kind buckets; a run that needs more reports none. */
export const USAGE_ACCOUNT_MAX_BUCKETS = 32

/**
 * One run's request totals by model, Quota Group and request kind, noted once per sent attempt. A
 * bucket is keyed by the group's internal id; its label is display only, the latest one noted.
 */
export interface UsageAccount {
  note(entry: {
    model: string
    /** Internal: the bucket's identity. Never leaves the account. */
    quotaGroupId?: string
    quotaGroupLabel?: string
    requestKind: UsageRequestKind
    estimate: number | null
    usage: Usage | null
    failure: BatchFailure | null
  }): void
  /** A copy; empty when nothing was sent or the bucket bound was passed. */
  buckets(): UsageBucket[]
}

export function createUsageAccount(): UsageAccount {
  const rows = new Map<string, UsageBucket>()
  let overflowed = false
  const tokens = (n: unknown): number => (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0)
  return {
    note(e) {
      const key = JSON.stringify([e.model, e.quotaGroupId ?? '', e.requestKind])
      let b = rows.get(key)
      if (!b) {
        if (rows.size >= USAGE_ACCOUNT_MAX_BUCKETS) {
          overflowed = true
          return
        }
        b = {
          model: e.model,
          requestKind: e.requestKind,
          attempts: 0,
          actualInputTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0
        }
        rows.set(key, b)
      }
      if (e.quotaGroupLabel) b.quotaGroupLabel = e.quotaGroupLabel
      b.attempts++
      if (e.estimate !== null && tokens(e.estimate) > 0) b.estimatedInputTokens = (b.estimatedInputTokens ?? 0) + tokens(e.estimate)
      if (e.usage) {
        b.actualInputTokens = (b.actualInputTokens ?? 0) + tokens(e.usage.promptTokens)
        b.outputTokens = (b.outputTokens ?? 0) + tokens(e.usage.outputTokens)
        b.thoughtTokens = (b.thoughtTokens ?? 0) + tokens(e.usage.thoughtTokens)
      }
      if (e.failure && e.failure.kind !== 'cancelled') {
        const kind = projectFailure(e.failure).kind
        b.retryReasons = { ...b.retryReasons, [kind]: (b.retryReasons?.[kind] ?? 0) + 1 }
      }
    },
    buckets: () => (overflowed ? [] : [...rows.values()].map((b) => ({ ...b, ...(b.retryReasons ? { retryReasons: { ...b.retryReasons } } : {}) })))
  }
}

/**
 * `usage` with the account's buckets, only when their input, output and thought sums equal the run's
 * own totals; otherwise `usage` as it was, so a price is never computed from buckets that disagree.
 */
export function withUsageBuckets<U extends Usage | undefined>(usage: U, buckets: readonly UsageBucket[]): U {
  if (!usage || buckets.length === 0) return usage
  const sum = (f: 'actualInputTokens' | 'outputTokens' | 'thoughtTokens') => buckets.reduce((n, b) => n + (b[f] ?? 0), 0)
  if (sum('actualInputTokens') !== usage.promptTokens || sum('outputTokens') !== usage.outputTokens || sum('thoughtTokens') !== usage.thoughtTokens) return usage
  return { ...usage, buckets: buckets.map((b) => ({ ...b })) }
}

/** How a one-shot call ended: its actual input when the reply stated one, and its typed failure. */
export interface OneShotOutcome {
  actualInputTokens?: number
  failure?: BatchFailure | null
}

export type OneShotAdmission = { admitted: true; done: (outcome?: OneShotOutcome) => JournalWrite } | { admitted: false; message: string }

/**
 * One request sent outside any run (the spoken-language detector, D5-13), on a key the caller already
 * chose. It is budgeted like every Free request but never waits: a group that cannot send now refuses,
 * and the caller sends nothing. Paid, or Automatic Free-Tier Protection off, admits with no
 * reservation. `done` reconciles the reservation once, whatever the call's outcome, records an
 * explicit quota hold or daily stop the answer stated, and returns the first write that failed.
 */
export function admitOneShot(o: {
  budget: RequestBudget
  settings: RequestGateSettings
  slot: number
  model: string
  /** Unique per call; the reservation is `${token}:1`. */
  token: string
  requestKind?: UsageRequestKind
  estimate?: number | null
}): OneShotAdmission {
  const free = { admitted: true as const, done: (): JournalWrite => ({ ok: true }) }
  if (o.settings.automaticFreeTierProtection === false || o.settings.apiKeyTiers?.[o.slot] === 'paid') return free
  const groupId = quotaGroupRuntimeView(o.settings).resolvedKeyGroupIds[o.slot] ?? DEFAULT_QUOTA_GROUP_ID
  const estimate = o.estimate ?? null
  const checked = o.budget.check(groupId, o.model, estimate)
  if (checked.state === 'storageError') return { admitted: false, message: checked.message }
  if (checked.state !== 'ready') return { admitted: false, message: checked.state === 'dailyExhausted' ? DAILY_MESSAGE : waitMessage(checked.metric) }
  const attemptId = `${o.token.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'once'}:1`
  const written = o.budget.reserve({ attemptId, groupId, model: o.model, requestKind: o.requestKind ?? 'generation', estimate })
  if (!written.ok) return { admitted: false, message: written.message }
  let settled = false
  return {
    admitted: true,
    done: (outcome: OneShotOutcome = {}): JournalWrite => {
      if (settled) return { ok: true }
      settled = true
      const reconciled = o.budget.reconcile(attemptId, outcome.actualInputTokens)
      if (!reconciled.ok) return reconciled
      return journalRefusal(o.budget, groupId, o.model, outcome.failure ?? null, Date.now())
    }
  }
}

const DAILY_MESSAGE =
  'Today\u2019s free requests for this model are used up on every Quota Group this run may use. Your progress is kept: Continue after the reset, or allow paid fallback in Settings.'

function waitMessage(metric: BudgetMetric): string {
  switch (metric) {
    case 'rpm':
      return 'Waiting for the per-minute request limit to free up.'
    case 'tpm':
      return 'Waiting for the per-minute input-token limit to free up.'
    case 'rpd':
      return 'Waiting for the daily request limit to reset.'
    case 'retry':
      return 'Google asked to wait before sending again.'
    default:
      return 'Google asked to wait before sending again.'
  }
}

/** A Free route whose user allowed paid fallback and that has a Paid key able to call the model. */
function paidFallbackOpen(s: RequestGateSettings, ranked: readonly RouteSlot[]): boolean {
  return s.allowPaidFallback === true && ranked[0]?.tier === 'free' && ranked.some((r) => r.tier === 'paid' && !r.modelAbsent)
}

/** Failures that say this group is out of capacity for now, not that the model or network is. */
function isPressure(failure: BatchFailure): boolean {
  return failure.kind === 'quota' || failure.kind === 'rate-limit'
}
