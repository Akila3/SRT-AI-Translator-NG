/**
 * Native transcription: the chunk loop (implementation_plan.md Step 1.4). AUTHORED-BY: opus-5.5-high
 *
 * Read from gst 3.7.0's `transcribe` (`main.py:1519-1977`), which is what 1.1.0 ships:
 *
 *  - the audio is cut into fixed chunks of `audio_chunk_size`, 300 s by default (`main.py:94`), and
 *    1.1.0 never passes another size (`pythonBridge.ts:609-629`);
 *  - each chunk is sent once, its cues are offset by the chunk's start (`main.py:1878-1879`) and the
 *    chunk is recorded as done before the next one is cut;
 *  - the subtitle is written once, at the end.
 *
 * Three things differ, each an enhancement:
 *
 *  - gst's loop stops at `int(audio_length)` (`main.py:1634-1635`), so the fractional last second of
 *    a file was never sent. The last chunk here ends at the real duration. The chunk count is gst's.
 *  - Cues reach disk as each chunk commits, through `output.ts`'s partial lifecycle (§4.1a), so a
 *    failure at chunk 9 of 10 leaves eight chunks of subtitle instead of nothing.
 *  - A response that arrives after Stop, or after this run's epoch has ended, is not committed.
 *
 * Every answer is checked against the envelope before it is committed (Step 1.8a): grossly too little
 * text for the sound is refused (D5-12); a refusal, or loud audio left wordless, is asked for again in
 * smaller pieces (D5-7, D5-11, `recover.ts`). What still cannot be vouched for is reported by its
 * times. Without a complete envelope none of that can be checked, so nothing is sent.
 *
 * Not here, by plan: the request itself (the `transcribeChunk` seam — 1.5 prompt, 1.6 schema),
 * retry (1.8), and the RTL embedding gst applied to Hebrew/Arabic cues (`main.py:1881-1882`), which
 * is Bundle D's. The SRT itself is rendered by `srt.ts`. A completed transcript is checked for cues in
 * a foreign script (Step 1.7) and for text on almost silent audio after it is saved; nothing is changed.
 */
import path from 'path'
import type { ChildProcess } from 'child_process'
import { EMPTY_TRANSCRIPT_MESSAGE, EMPTY_TRANSCRIPT_SIGNAL, type RunError, type RunOutcome, type Usage, type UsageBucket } from '../shared/engineEvents'
import { blockAdvice } from '../shared/runCopy'
import type { RunId } from '../shared/types'
import type { Emit } from './adapter'
import {
  audioForTranscription,
  envelope as measureEnvelope,
  sliceAudio,
  type AudioEnvelope,
  type AudioSlice,
  type EnvelopeResult,
  type MediaExec,
  type PreparedAudio,
  type ProgressReporter
} from '../main/ffmpeg'
import { PartialOutput, type OutputIo, type PartialOutputOptions, type PromoteResult } from './output'
import { TranscriptionProgress, type TranscriptCue } from './progress'
import { formatSrt } from './srt'
import { rtlCopy, type RtlChoice } from './rtl'
import { buildCues } from './cues'
import { mergeByOffset } from './offsets'
import type { PolishOutcome } from './polish'
import {
  checkCoverage,
  grossDisproportion,
  loudnessOf,
  mergeSpans,
  quietestMoment,
  quietTextSpans,
  usableTimings,
  type CoverageReason,
  type Span
} from './coverage'
import {
  recoverUnit,
  type Judgement,
  type RecoveryBudget,
  type RecoveryPolicy,
  type RefusedSpan,
  type RecoveryTrigger,
  type SpanAnswer
} from './recover'
import {
  describeTimeSpans,
  disproportionMessage,
  mistimedLinesMessage,
  quietTextMessage,
  refusedSpanMessage,
  scanTranscribedOutput,
  uncoveredSpansMessage
} from '../shared/outputSanity'

/** gst 3.7.0's default chunk (`main.py:94`); 1.1.0 never changes it. */
export const TRANSCRIBE_CHUNK_SECONDS = 300

/**
 * D5-11's numbers, which are transcription's alone (recover.ts carries none): a 30-second floor,
 * four levels, and one unchanged re-send of a refused part first — five identical requests for a
 * refused span returned one complete answer (§9h.4).
 */
export const TRANSCRIBE_RECOVERY_POLICY: RecoveryPolicy = { retriesBeforeSplit: 1, floor: 30, maxDepth: 4 }

/**
 * AS-49 / D6-8: the unchanged re-sends a refusal is worth, by its reason. A `PROHIBITED_CONTENT` refusal
 * is never sent again unchanged — the same audio meets the same filter — so it is halved at once; any
 * other refusal gets the policy's. The floor, depth and audio budget (D5-11) are the same either way.
 */
export function refusalRetries(policy: RecoveryPolicy, blockReason: string | undefined): number {
  return blockReason === 'PROHIBITED_CONTENT' ? 0 : policy.retriesBeforeSplit
}

/** The run's allowance of re-sent audio: never more than the run's own length (§9.5). */
export class AudioRecoveryBudget implements RecoveryBudget {
  private spent = 0
  constructor(readonly totalSeconds: number) {}
  get spentSeconds(): number {
    return this.spent
  }
  get remainingSeconds(): number {
    return Math.max(0, this.totalSeconds - this.spent)
  }
  take(span: Span): boolean {
    const seconds = span.end - span.start
    if (seconds > this.remainingSeconds + 1e-9) return false
    this.spent += seconds
    return true
  }
}

export interface AudioChunk {
  /** One-based. */
  index: number
  total: number
  startSeconds: number
  endSeconds: number
}

/**
 * gst's chunk boundaries: `ceil(floor(duration) / size)` chunks of `size` seconds, the last one
 * ending at the true duration rather than at its whole-second floor. A file shorter than one second
 * is one chunk. An unknown or non-positive duration has no plan.
 */
export function planChunks(durationSeconds: number, chunkSeconds = TRANSCRIBE_CHUNK_SECONDS): AudioChunk[] {
  if (!(durationSeconds > 0) || !(chunkSeconds > 0)) return []
  const whole = Math.floor(durationSeconds)
  const total = Math.max(1, Math.ceil(whole / chunkSeconds))
  const chunks: AudioChunk[] = []
  for (let i = 0; i < total; i++) {
    const startSeconds = i * chunkSeconds
    const endSeconds = i === total - 1 ? durationSeconds : Math.min(startSeconds + chunkSeconds, whole)
    chunks.push({ index: i + 1, total, startSeconds, endSeconds })
  }
  return chunks
}

/**
 * One chunk's answer. Cue times are relative to the chunk's start. `attempts`: the requests actually
 * sent for it, retries included (0 when the request gate stopped it first); absent counts as one.
 */
export type ChunkOutcome =
  | { ok: true; cues: TranscriptCue[]; usage?: Usage; attempts?: number }
  /** `cacheRefused`: the dedicated model's answer came from the implicit cache twice; the span is refused, not re-asked. */
  | { ok: false; error: RunError; usage?: Usage; cacheRefused?: true; attempts?: number }

export type TranscribeChunk = (
  input: { chunk: AudioChunk; audio: { data: Buffer; mimeType: string } },
  signal: AbortSignal
) => Promise<ChunkOutcome>

/** The audio side of a run. Production is `ffmpegTranscriptionAudio`; the gates script it. */
export interface TranscriptionAudio {
  prepare(signal: AbortSignal): Promise<PreparedAudio>
  envelope(preparedPath: string, signal: AbortSignal): Promise<EnvelopeResult>
  slice(preparedPath: string, chunk: AudioChunk, signal: AbortSignal): Promise<AudioSlice>
}

export interface FfmpegTranscriptionAudioOptions {
  mediaFile: string
  isVideo: boolean
  ffmpegPath?: string
  /** A run-owned scratch path for the extracted audio; registered before ffmpeg writes it. */
  scratchPath: (suffix: string) => string
  registerScratch: (file: string) => void
  onChild?: (child: ChildProcess) => void
  onProgress?: ProgressReporter
  exec?: MediaExec
}

/**
 * The production audio side. The envelope is measured on the PREPARED audio — the same file the
 * chunks are cut from — so the coverage gate (Step 1.8a) compares the model's cues against what the
 * model actually heard, with nothing added to the chain for the measurement (§10.3).
 */
export function ffmpegTranscriptionAudio(opts: FfmpegTranscriptionAudioOptions): TranscriptionAudio {
  const tool = (signal: AbortSignal) => ({
    ffmpegPath: opts.ffmpegPath,
    signal,
    onChild: opts.onChild,
    exec: opts.exec
  })
  return {
    prepare: (signal) => {
      const out = opts.scratchPath('.transcribe.mp3')
      opts.registerScratch(out)
      return audioForTranscription(opts.mediaFile, out, { ...tool(signal), isVideo: opts.isVideo, onProgress: opts.onProgress })
    },
    envelope: (preparedPath, signal) => measureEnvelope(preparedPath, tool(signal)),
    slice: (preparedPath, chunk, signal) => sliceAudio(preparedPath, chunk.startSeconds, chunk.endSeconds, tool(signal))
  }
}

/** One committed part as the checkpoint records it: media milliseconds and the cues written for it. */
export interface TranscribedPart {
  startMs: number
  endMs: number
  /** Cues in the written subtitle; a part whose cues all had no text writes none (an explicit no-cue gap). */
  cueCount: number
}

/**
 * Where a resumable transcription keeps its work (Phase 3, Step 3.6; `resumeStore.ts` behind the native
 * adapter). Every snapshot goes through `commit`, so the checkpoint never names output that is not on
 * disk, and the destination is replaced only through `promote`.
 */
export interface TranscriptionJournal {
  /** Continue: the committed parts and the cues written for them, verified against the record. Null for a fresh run. */
  readonly restored: { durationMs: number; parts: readonly TranscribedPart[]; cues: readonly TranscriptCue[] } | null
  /** True once the record covers the media to its end. */
  readonly complete: boolean
  /** True while the record holds work a later Start can offer to Continue. */
  readonly resumable: boolean
  /** The run's partial: Continue adopts the verified one; a fresh run claims one beside the destination. */
  partial(opts: Pick<PartialOutputOptions, 'io' | 'registerScratch' | 'releaseScratch'>): PartialOutput
  /** One whole snapshot covering `parts` from zero: output first, then the record. */
  commit(partial: PartialOutput, text: string, coverage: { durationMs: number; parts: readonly TranscribedPart[] }): Promise<{ ok: true } | { ok: false; stage: string; message: string }>
  /**
   * Finished work's text rewritten in place: the same parts, cue count and times, each cue's new text.
   * Atomic as `commit` is; until it lands, the record and the partial are the finished work as it was.
   */
  revise(partial: PartialOutput, text: string): Promise<{ ok: true } | { ok: false; stage: string; message: string }>
  promote(partial: PartialOutput, isCurrent: () => boolean): Promise<PromoteResult>
  /**
   * The finished transcript cannot be recorded (it does not read back as the parts it covers): the
   * record is discarded first, so the run can save it as Phase 1 does without leaving an offer behind.
   * Refused, with the record kept, when the destination is no longer its baseline or the discard fails;
   * otherwise `verify` re-checks the destination before every replacement attempt.
   */
  release(): Promise<{ ok: true; verify: () => string | null } | { ok: false; message: string }>
}

/** Seconds as the checkpoint and the SRT both hold them: whole milliseconds. */
function msOf(seconds: number): number {
  return Math.round(seconds * 1000)
}

/** How many cues `formatSrt` writes for these: a cue with no text is not written. */
function writtenCount(cues: readonly TranscriptCue[]): number {
  return cues.filter((cue) => formatSrt([cue]) !== '').length
}

/**
 * What a finished transcript's destination receives: null keeps the partial's own bytes (no recipe, or
 * a destination that is not `.srt`, or a quiet transcript with no cue to format); otherwise the RTL copy
 * of the canonical text, or why there is none.
 */
export function destinationCopy(transcript: string, outputPath: string, rtl: RtlChoice | undefined): { ok: true; text: string | null } | { ok: false; message: string } {
  if (!rtl || path.extname(outputPath).toLowerCase() !== '.srt' || transcript.trim() === '') return { ok: true, text: null }
  const copy = rtlCopy(transcript, rtl)
  return copy.ok ? { ok: true, text: copy.text } : copy
}

export interface TranscriptionRunOptions {
  runId: RunId
  mediaFile: string
  outputPath: string
  signal: AbortSignal
  /** False once this run's epoch has ended; checked before every commit and before promotion. */
  isCurrent: () => boolean
  emit: Emit
  audio: TranscriptionAudio
  transcribeChunk: TranscribeChunk
  registerScratch: (file: string) => void
  /** Undoes `registerScratch` for a file that now holds a transcript the run must leave behind. */
  releaseScratch: (file: string) => void
  outputIo?: Partial<OutputIo>
  chunkSeconds?: number
  /** Bundle G's seam: `retriesBeforeSplit` per refusal reason (D6-8). Phase 1 uses the default. */
  recovery?: Partial<RecoveryPolicy>
  /** Phase 3: the run's checkpoint. Without one the run keeps Phase 1's partial beside `outputPath`. */
  journal?: TranscriptionJournal
  /**
   * Bundle D: the saved copy's RTL recipe, snapshotted when the run was accepted. A `.srt` destination
   * receives its derivative; the partial, the checkpoint and every scan keep the canonical transcript.
   */
  rtl?: RtlChoice
  /**
   * Bundle I, dedicated model: each answer is one cue per word. Coverage and recovery judge those words
   * as they are; then Stage B (`cues.ts`) builds the part's subtitles from them, every span the run
   * refused kept as a gap no cue crosses. Absent: the cues are the model's own.
   */
  wordCues?: true
  /** Bundle I Stage C: rewrites the finished cue texts, never their times. Any failure keeps them. */
  polish?: (texts: readonly string[], signal: AbortSignal) => Promise<PolishOutcome>
  /**
   * The model each stage calls. With a Stage C that sent anything, the final usage carries one bucket
   * per model, so its cost is priced at each model's own rate rather than all at the transcription model's.
   */
  models?: { transcribe: string; polish?: string }
}

export interface TranscriptionResult {
  outcome: RunOutcome
  /** Set only for a partial that holds a complete, fsync'd snapshot (§4.1a rule 4). */
  partialPath?: string
  /** Present exactly when `outcome` is `failed`; already emitted as an `error` event. */
  error?: RunError
  cueCount: number
  durationSeconds: number | null
  /** Level over time of the prepared audio, for Step 1.8a. Null when it could not be measured. */
  envelope: AudioEnvelope | null
  usage: Usage
  /** An ffmpeg child that outlived its kill (SOL-02); the runner owns it from here. */
  orphan?: ChildProcess
  /** A stopped or failed run whose work its checkpoint holds for Continue. */
  resumable?: boolean
}

/** Adjacent refusals for one reason, handled alike, are one stretch to report. */
function joinRefusals(refused: readonly RefusedSpan[]): RefusedSpan[] {
  const out: RefusedSpan[] = []
  for (const r of [...refused].sort((a, b) => a.span.start - b.span.start)) {
    const last = out[out.length - 1]
    if (
      last &&
      last.why === 'refused' &&
      r.why === 'refused' &&
      !!last.unsent === !!r.unsent &&
      last.error?.blockReason === r.error?.blockReason &&
      r.span.start <= last.span.end
    ) {
      out[out.length - 1] = { ...last, span: { start: last.span.start, end: Math.max(last.span.end, r.span.end) } }
    } else out.push(r)
  }
  return out
}

/** `spans` with every part inside `cuts` removed; what is left under a second goes too, as `recover.ts` drops it. */
function outside(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  let out = [...spans]
  for (const c of cuts) {
    out = out.flatMap((s) => {
      if (c.end <= s.start || c.start >= s.end) return [s]
      return [
        ...(c.start > s.start ? [{ start: s.start, end: c.start }] : []),
        ...(c.end < s.end ? [{ start: c.end, end: s.end }] : [])
      ]
    })
  }
  return out.filter((s) => s.end - s.start >= 1)
}

/** Seconds of `within` that `spans` cover, each moment counted once. */
function coveredSeconds(spans: readonly Span[], within: Span): number {
  const clipped = spans.map((s) => ({ start: Math.max(s.start, within.start), end: Math.min(s.end, within.end) })).filter((s) => s.end > s.start)
  return mergeSpans(clipped).reduce((sum, s) => sum + (s.end - s.start), 0)
}

/** Where the implicit cache answered twice and nothing was used (AR-FINAL-3). */
function cacheRefusedMessage(part: string, spans: readonly Span[]): string {
  return (
    `The service answered ${describeTimeSpans(spans)} of ${part} from its cache twice. Neither answer was used, ` +
    'so that stretch has no subtitles. Transcribing the file again a few minutes later may fill it.'
  )
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What a failed coverage check found, for the log line that says recovery has started. */
function coverageProblem(reasons: readonly CoverageReason[], wordless: readonly Span[]): string {
  const found: string[] = []
  if (wordless.length) found.push(`came back with no words for ${describeTimeSpans(wordless)}, although the audio there is not quiet`)
  else if (reasons.includes('tail')) found.push('came back with words that stop before the sound does')
  if (reasons.includes('order') || reasons.includes('beyond')) {
    found.push(`${found.length ? 'and ' : 'came back '}with timings out of order or outside the part`)
  }
  return found.join(' ')
}

function emptyUsage(): Usage {
  return { promptTokens: 0, thoughtTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, audioSecondsSubmitted: 0 }
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

export async function runTranscription(run: TranscriptionRunOptions): Promise<TranscriptionResult> {
  const { runId, emit, signal } = run
  const usage = emptyUsage()
  const journal = run.journal ?? null
  const partialOptions = { io: run.outputIo, registerScratch: run.registerScratch, releaseScratch: run.releaseScratch }
  const output = journal ? journal.partial(partialOptions) : new PartialOutput(run.outputPath, partialOptions)
  const name = path.basename(run.mediaFile)
  let progress: TranscriptionProgress | null = null
  let env: AudioEnvelope | null = null
  let durationSeconds: number | null = null
  let orphan: ChildProcess | undefined

  const log = (text: string, stream: 'stdout' | 'stderr' = 'stdout') => emit({ type: 'log', runId, stream, text })

  const end = async (outcome: Exclude<RunOutcome, 'completed'>, error?: RunError): Promise<TranscriptionResult> => {
    if (error) emit({ type: 'error', runId, error })
    // A checkpointed partial stays the snapshot its record names (`retainRecorded`).
    const partialPath = journal ? await output.retainRecorded() : await output.retain()
    const stranded = output.strandedSnapshot
    if (partialPath && partialPath !== stranded) log(`Kept the subtitle written so far as "${path.basename(partialPath)}".`)
    if (stranded) {
      log(
        partialPath === stranded
          ? `Kept the subtitle written so far as "${path.basename(stranded)}": the partial file could not be written to, so the copy keeps this temporary name. Rename it to end in .srt to open it.`
          : `The last part could not be added to "${path.basename(partialPath ?? '')}" because the file was in use. The fuller copy is kept as "${path.basename(stranded)}".`
      )
    }
    return {
      outcome,
      ...(partialPath ? { partialPath } : {}),
      ...(error ? { error } : {}),
      cueCount: progress?.cues.length ?? 0,
      durationSeconds,
      envelope: env,
      usage,
      ...(orphan ? { orphan } : {}),
      ...(journal?.resumable ? { resumable: true } : {})
    }
  }
  const stopped = () => end('stopped')
  const ended = () => signal.aborted || !run.isCurrent()

  emit({ type: 'phase', runId, phase: 'preparing' })
  const prepared = await run.audio.prepare(signal)
  if (!prepared.ok) {
    if (prepared.orphan) orphan = prepared.orphan
    if (prepared.aborted || ended()) return stopped()
    return end('failed', {
      kind: 'unknown',
      message: `Could not prepare "${name}" for transcription: ${prepared.error} Your original file was not modified.`
    })
  }
  if (ended()) return stopped()
  durationSeconds = prepared.durationSeconds

  const measured = await run.audio.envelope(prepared.path, signal)
  if (measured.ok) {
    env = measured.envelope
  } else {
    if (measured.orphan) orphan = measured.orphan
    if (measured.aborted || ended()) return stopped()
  }
  if (ended()) return stopped()
  // D5-12, "no silent pass": checks that cannot be evaluated are a refusal, and refusing before the
  // first request costs nothing.
  const loud = loudnessOf(env, prepared.durationSeconds)
  if (!loud) {
    const why = measured.ok ? 'the measurement stopped short of the end' : measured.error
    return end('failed', {
      kind: 'refusedByApp',
      message:
        `Could not measure how loud "${name}" is over time (${why}). The checks that catch dropped or invented ` +
        `lines depend on that measurement, so nothing was sent to the model. Your original file was not modified.`
    })
  }

  const chunks = planChunks(prepared.durationSeconds, run.chunkSeconds)
  if (chunks.length === 0) {
    return end('failed', { kind: 'unknown', message: `"${name}" will not say how long it is, so it cannot be divided for transcription.` })
  }
  progress = new TranscriptionProgress(prepared.durationSeconds)
  const durationMs = msOf(prepared.durationSeconds)
  /** Cues written for each committed part, in order: the checkpoint's coverage, in its own terms. */
  const written: number[] = []
  const restored = journal?.restored ?? null
  if (restored) {
    // Continue starts at the first part the record does not hold. The record's parts must be this
    // media's own parts, to the millisecond; anything else is saved work for another cut.
    const k = restored.parts.length
    const fits =
      restored.durationMs === durationMs &&
      k <= chunks.length &&
      restored.parts.every((p, i) => p.startMs === msOf(chunks[i].startSeconds) && p.endMs === msOf(chunks[i].endSeconds))
    if (!fits) {
      return end('failed', {
        kind: 'refusedByApp',
        message: `The saved work for "${name}" does not fit its audio as it is now cut into parts. Nothing was sent. Start again and choose Start over.`
      })
    }
    progress.restore(
      chunks.slice(0, k).map((c, i) => ({ index: c.index, startSeconds: c.startSeconds, endSeconds: c.endSeconds, cueCount: restored.parts[i].cueCount })),
      restored.cues
    )
    written.push(...restored.parts.map((p) => p.cueCount))
  }
  const coverage = () => ({
    durationMs,
    parts: progress!.committedChunks.map((c, i) => ({ startMs: msOf(c.startSeconds), endMs: msOf(c.endSeconds), cueCount: written[i] }))
  })
  const policy: RecoveryPolicy = { ...TRANSCRIBE_RECOVERY_POLICY, ...run.recovery }
  const budget = new AudioRecoveryBudget(prepared.durationSeconds)
  const notice = (message: string, tag: 'disproportion' | 'refused' | 'uncovered' | 'mistimed') =>
    emit({ type: 'warning', runId, warning: { code: 'notice', message, signals: [tag] } })
  const judge = (span: Span, cues: readonly TranscriptCue[]): Judgement => {
    const gross = grossDisproportion(loud, span, cues)
    if (gross) return { ok: false, disproportion: true, ...gross }
    const v = checkCoverage(loud, span, cues)
    return v.ok ? { ok: true } : { ok: false, disproportion: false, wordless: v.wordless }
  }
  emit({ type: 'phase', runId, phase: 'working' })
  const resumedParts = progress.committedChunks.length
  if (resumedParts > 0) {
    log(`Continuing after part ${resumedParts} of ${chunks.length}.`)
    emit({ type: 'lines', runId, done: progress.cues.length, total: null })
  }

  for (const chunk of chunks) {
    if (chunk.index <= resumedParts) continue
    if (ended()) return stopped()
    const part = `part ${chunk.index} of ${chunk.total}`
    const total = prepared.durationSeconds
    const audioSeconds = { done: chunk.startSeconds, total }
    const whole: Span = { start: chunk.startSeconds, end: chunk.endSeconds }
    let attempt = 1
    emit({ type: 'unit', runId, index: chunk.index, total: chunk.total, state: 'sending', attempt, audioSeconds })
    /** Spans whose answer came from the implicit cache twice: refused, never asked for again (AR-FINAL-3). */
    const cacheRefused: Span[] = []
    const inCacheRefused = (span: Span) => cacheRefused.some((r) => r.start <= span.start && span.end <= r.end)
    /** Spans recovery refused; Stage B keeps each as a gap. */
    const refusedSpans: Span[] = []

    /** One request for a span of this chunk; cue times come back absolute. */
    const request = async (span: Span): Promise<SpanAnswer> => {
      const sub: AudioChunk = { ...chunk, startSeconds: span.start, endSeconds: span.end }
      const slice = await run.audio.slice(prepared.path, sub, signal)
      if (!slice.ok) {
        if (slice.orphan) orphan = slice.orphan
        if (slice.aborted || ended()) return { ok: false, refused: false, stopped: true }
        const where = span === whole ? '' : `, at ${describeTimeSpans([span])}`
        return {
          ok: false,
          refused: false,
          error: { kind: 'unknown', message: `Could not cut ${part} of "${name}"${where}: ${slice.error}` }
        }
      }
      const answer = await run.transcribeChunk({ chunk: sub, audio: { data: slice.data, mimeType: slice.mimeType } }, signal)
      const seconds = span.end - span.start
      const sent = answer.attempts ?? 1
      usage.requestCount = (usage.requestCount ?? 0) + sent
      if (sent > 1) usage.retryCount = (usage.retryCount ?? 0) + sent - 1
      if (sent > 0) {
        // Every wire attempt sends the span's audio; all but the part's first send are re-requests.
        usage.audioSecondsSubmitted = (usage.audioSecondsSubmitted ?? 0) + seconds * sent
        const again = attempt > 1 ? sent : sent - 1
        if (again > 0) usage.reRequestedAudioSeconds = (usage.reRequestedAudioSeconds ?? 0) + seconds * again
      }
      addUsage(usage, answer.usage)
      // A late answer — after Stop, or once this run's epoch is over — is never committed.
      if (ended()) return { ok: false, refused: false, stopped: true }
      if (!answer.ok && answer.cacheRefused) {
        // Answered with nothing, and the judge accepts the span as it is: asking again would meet the same cache.
        cacheRefused.push(span)
        return { ok: true, cues: [] }
      }
      if (!answer.ok) {
        return answer.error.kind === 'blocked'
          ? { ok: false, refused: true, error: answer.error }
          : { ok: false, refused: false, error: answer.error }
      }
      return { ok: true, cues: answer.cues.map((c) => ({ start: c.start + span.start, end: c.end + span.start, text: c.text })) }
    }
    const fail = (error: RunError | undefined) => {
      emit({ type: 'unit', runId, index: chunk.index, total: chunk.total, state: 'failed', attempt, audioSeconds })
      emit({ type: 'usage', runId, usage: { ...usage }, cumulative: true })
      return end('failed', error ?? { kind: 'unknown', message: `The request for ${part} of "${name}" failed.` })
    }

    const first = await request(whole)
    if (!first.ok && !first.refused) return first.stopped ? stopped() : fail(first.error)

    let cues: TranscriptCue[] = []
    let trigger: RecoveryTrigger | null = null
    let inHand: TranscriptCue[] | null = null
    if (!first.ok) {
      const retries = refusalRetries(policy, first.error.blockReason)
      trigger = { cause: 'refused', retriesBeforeSplit: retries, error: first.error }
      log(`The model refused ${part}${first.error.blockReason ? ` (${first.error.blockReason})` : ''}; ${retries > 0 ? 'asking for it again' : 'asking for it in smaller pieces'}.`)
    } else if (inCacheRefused(whole)) {
      cues = first.cues
    } else {
      const gross = grossDisproportion(loud, whole, first.cues)
      const verdict = gross ? null : checkCoverage(loud, whole, first.cues)
      if (gross) {
        notice(disproportionMessage(whole, gross.letters, gross.loudSeconds), 'disproportion')
      } else if (verdict && !verdict.ok) {
        trigger = { cause: 'coverage', retriesBeforeSplit: 0 }
        inHand = first.cues
        log(`${capital(part)} ${coverageProblem(verdict.reasons, verdict.wordless)}; asking for it again in smaller pieces.`)
      } else {
        cues = first.cues
      }
    }

    if (trigger) {
      const recovered = await recoverUnit(
        whole,
        trigger,
        inHand,
        {
          ask: request,
          judge: (span, got) => (inCacheRefused(span) ? { ok: true } : judge(span, got)),
          usable: usableTimings,
          cutPoint: (from, to) => quietestMoment(loud, from, to),
          // Words, not lines: the same word on both sides of a cut is one word only at one instant.
          ...(run.wordCues ? { join: (left: readonly TranscriptCue[], right: readonly TranscriptCue[]) => mergeByOffset([left, right]) } : {}),
          onAsk: (span) => {
            attempt++
            emit({ type: 'unit', runId, index: chunk.index, total: chunk.total, state: 'retrying', attempt, audioSeconds })
            log(`Asking again for ${describeTimeSpans([span])} of ${part}.`)
          }
        },
        budget,
        policy
      )
      if (recovered.failure) return recovered.failure.stopped ? stopped() : fail(recovered.failure.error)
      cues = recovered.cues
      refusedSpans.push(...recovered.refused.map((r) => r.span))
      for (const r of joinRefusals(recovered.refused)) {
        notice(
          r.why === 'disproportion'
            ? disproportionMessage(r.span, r.letters ?? 0, r.loudSeconds ?? 0)
            : refusedSpanMessage(r.span, r.error?.blockReason, {
                smaller: r.span.end - r.span.start < whole.end - whole.start,
                unsent: !!r.unsent
              }),
          r.why === 'disproportion' ? 'disproportion' : 'refused'
        )
        // AR3-2: a cause `blocks.ts` typed gets its advice, said once per stretch, right after it.
        const advice = r.why === 'refused' ? blockAdvice('transcribe', r.error) : null
        if (advice) log(advice, 'stderr')
      }
      // A cache-refused stretch is reported as refused below, not again as wordless.
      const uncovered = cacheRefused.length ? outside(recovered.uncovered, cacheRefused) : recovered.uncovered
      if (uncovered.length) {
        notice(uncoveredSpansMessage(uncovered, { askedAgain: recovered.requests > 0, allowanceUsed: recovered.budgetExhausted }), 'uncovered')
      }
      if (recovered.mistimed.length) notice(mistimedLinesMessage(recovered.mistimed), 'mistimed')
      if (!recovered.refused.length && !uncovered.length && !recovered.mistimed.length && !cacheRefused.length) {
        log(`${capital(part)} recovered: every loud stretch now has words.`)
      }
    }
    if (cacheRefused.length) notice(cacheRefusedMessage(part, cacheRefused), 'refused')
    if (run.wordCues) {
      const words = mergeByOffset([cues.flatMap((c) => (c.text.trim() ? [{ text: c.text.trim(), start: c.start, end: c.end }] : []))])
      cues = buildCues(words, {
        durationSeconds: chunk.endSeconds,
        startSeconds: chunk.startSeconds,
        gaps: [...refusedSpans, ...cacheRefused],
        onConflict: (c) =>
          notice(
            `The subtitle at ${describeTimeSpans([c])} is on screen for less than a tenth of a second: there was no room for it beside its neighbours within the length and line rules. Its words are kept.`,
            'mistimed'
          )
      })
    }

    // A part answered on the model's whole-second grid can end its last line up to OFFSET_TOLERANCE_SECONDS
    // past the part, over this part's opening lines. Committed parts never change (their checkpoint spans
    // are fixed), so this part's opening lines follow that line instead: one that outlasts it now starts
    // where it ends; one it covers entirely moves to follow it, keeping its length, as in joinHalves.
    let follows = progress.cues.length ? progress.cues[progress.cues.length - 1].end : -Infinity
    const relative = cues.map((c) => {
      let { start, end } = c
      if (start < follows) {
        end = end > follows ? end : follows + (end - start)
        start = follows
        follows = end
      } else {
        follows = -Infinity
      }
      return { start: start - chunk.startSeconds, end: end - chunk.startSeconds, text: c.text }
    })
    progress.commit(chunk, relative)
    // Usable: the committed part's audio, less the stretches it keeps as gaps (refused, or the cache's).
    usage.audioSecondsUsable = (usage.audioSecondsUsable ?? 0) + Math.max(0, whole.end - whole.start - coveredSeconds([...refusedSpans, ...cacheRefused], whole))
    written.push(writtenCount(cues))
    const snapshotText = formatSrt(progress.cues)
    const flushed = journal ? await journal.commit(output, snapshotText, coverage()) : await output.flush(snapshotText)
    if (!flushed.ok) {
      log(`Could not update the partial subtitle after part ${chunk.index} (${flushed.stage}: ${flushed.message}). Carrying on.`, 'stderr')
    }
    emit({
      type: 'unit',
      runId,
      index: chunk.index,
      total: chunk.total,
      state: 'received',
      attempt,
      audioSeconds: { done: chunk.endSeconds, total }
    })
    emit({ type: 'lines', runId, done: progress.cues.length, total: null })
    emit({ type: 'usage', runId, usage: { ...usage }, cumulative: true })
  }

  if (ended()) return stopped()
  emit({ type: 'phase', runId, phase: 'finishing' })
  let finalCues: readonly TranscriptCue[] = progress.cues
  if (run.polish && finalCues.length > 0) {
    log(`Polishing the wording of ${finalCues.length} subtitles; their timing stays as transcribed.`)
    const polished = await run.polish(finalCues.map((c) => c.text), signal)
    const stageA = { ...usage }
    addUsage(usage, polished.usage)
    const sentC = polished.attempts ?? 0
    if (sentC > 0) usage.requestCount = (usage.requestCount ?? 0) + sentC
    if ((polished.retries ?? 0) > 0) usage.retryCount = (usage.retryCount ?? 0) + (polished.retries ?? 0)
    if (sentC > 0 && run.models?.polish) {
      const bucket = (model: string, u: Usage, attempts: number): UsageBucket => ({
        model,
        requestKind: 'generation',
        attempts,
        actualInputTokens: u.promptTokens,
        outputTokens: u.outputTokens,
        thoughtTokens: u.thoughtTokens,
        ...(u.billedButUnusableTokens ? { billedButUnusableTokens: u.billedButUnusableTokens } : {})
      })
      const none: Usage = { promptTokens: 0, thoughtTokens: 0, outputTokens: 0, totalTokens: 0 }
      usage.buckets = [bucket(run.models.transcribe, stageA, stageA.requestCount ?? 0), bucket(run.models.polish, polished.usage ?? none, sentC)]
    }
    emit({ type: 'usage', runId, usage: { ...usage }, cumulative: true })
    if (ended()) return stopped()
    // The request record failed: the transcript is kept as a partial for Continue, never saved as finished.
    if (polished.kind === 'failed') return end('failed', polished.error)
    if (polished.kind === 'polished') {
      const texts = polished.texts
      if (polished.changed > 0) finalCues = finalCues.map((c, i) => ({ ...c, text: texts[i] ?? c.text }))
      log(`Polishing changed the wording of ${polished.changed} of ${texts.length} subtitles.`)
      if (polished.unmatched > 0) {
        log(`${polished.unmatched} kept the transcription\u2019s wording because the polished text did not match its own subtitle.`)
      }
      if (polished.blocked) {
        emit({
          type: 'warning',
          runId,
          warning: { code: 'notice', message: `The model refused to edit ${polished.blocked} subtitles, so they keep the transcription\u2019s own wording.`, signals: ['polish'] }
        })
      }
      if (polished.stopped) {
        emit({
          type: 'warning',
          runId,
          warning: { code: 'notice', message: `Polishing stopped early: ${polished.stopped}. The subtitles not yet polished keep the transcription\u2019s own wording.`, signals: ['polish'] }
        })
      }
    } else {
      emit({ type: 'warning', runId, warning: { code: 'notice', message: polished.reason, signals: ['polish'] } })
    }
  }
  const polishedText = finalCues !== progress.cues
  const transcribed = formatSrt(progress.cues)
  let transcript = formatSrt(finalCues)
  // Checked before every attempt to replace the destination, retries included: a Stop leaves the job
  // open and its epoch current while the run unwinds, so the epoch alone cannot fence it (§2.2a).
  const committable = () => !signal.aborted && run.isCurrent()
  const prepare = (text: string): string | null => {
    const derived = destinationCopy(text, run.outputPath, run.rtl)
    if (derived.ok) output.setDerivative(derived.text)
    return derived.ok ? null : derived.message
  }
  const unprepared = (message: string) =>
    end('failed', {
      kind: 'unknown',
      message:
        `Could not prepare "${path.basename(run.outputPath)}" (${message}).` +
        (output.partialPath || output.strandedSnapshot ? ' The transcript is kept beside it as a partial file.' : '')
    })
  const notPrepared = prepare(transcript)
  if (notPrepared !== null) return unprepared(notPrepared)
  let promoted: PromoteResult
  if (journal) {
    // The last commit already landed the transcription; only a record that missed it is written again.
    // A polished transcript is then recorded as a revision of that finished work, so the record never
    // stops describing a file on disk.
    let recorded = journal.complete ? ({ ok: true } as const) : await journal.commit(output, transcribed, coverage())
    if (recorded.ok && polishedText) {
      const revised = await journal.revise(output, transcript)
      if (!revised.ok && revised.stage === 'readBack') {
        log(`The polished wording cannot be kept for Continue (${revised.message}); the transcription\u2019s own wording is saved instead.`, 'stderr')
        transcript = transcribed
        const again = prepare(transcript)
        if (again !== null) return unprepared(again)
      } else {
        recorded = revised
      }
    }
    if (recorded.ok) {
      promoted = await journal.promote(output, committable)
    } else if (recorded.stage === 'readBack') {
      // A transcript the record cannot hold is still saved, as Phase 1 saves it, with the record discarded.
      log(`The finished transcript cannot be kept for Continue (${recorded.message}); saving it without that.`, 'stderr')
      const released = await journal.release()
      if (released.ok) {
        promoted = await output.promote(transcript, committable, released.verify)
      } else {
        const kept = output.keepStaged()
        if (kept) log(`The finished transcript is kept as "${path.basename(kept)}". Rename it to end in .srt to open it. The saved work for Continue is unchanged.`, 'stderr')
        promoted = { ok: false, stage: 'replace', message: released.message }
      }
    } else {
      promoted = { ok: false, stage: 'replace', message: recorded.message }
    }
  } else {
    promoted = await output.promote(transcript, committable)
  }
  if (!promoted.ok) {
    if (promoted.stage === 'superseded' || signal.aborted) return stopped()
    return end('failed', {
      kind: 'unknown',
      message:
        `Could not save "${path.basename(run.outputPath)}" (${promoted.message}).` +
        (output.partialPath || output.strandedSnapshot ? ' The transcript is kept beside it as a partial file.' : '')
    })
  }
  // Unconditional: the fidelity prompt asked for no translation, and this is the only thing that
  // reports it was not obeyed (CARRY_FORWARD.md §4, "prompt first, detection second").
  for (const w of scanTranscribedOutput(transcript)) {
    emit({ type: 'warning', runId, warning: { code: 'scriptMix', message: w.message, range: { from: w.from, to: w.to }, signals: w.signals } })
  }
  // D5-12(b): the refusal catches only gross disproportion, so the user is told where an invention
  // would sit.
  const quiet = quietTextSpans(loud, progress.cues)
  if (quiet.length) emit({ type: 'warning', runId, warning: { code: 'notice', message: quietTextMessage(quiet), signals: ['quiet text'] } })
  // Judged on the saved text: formatSrt drops cues whose text is blank, so cues can exist and the file be empty.
  if (transcript.trim() === '') emit({ type: 'warning', runId, warning: { code: 'notice', message: EMPTY_TRANSCRIPT_MESSAGE, signals: [EMPTY_TRANSCRIPT_SIGNAL] } })
  return {
    outcome: 'completed',
    cueCount: progress.cues.length,
    durationSeconds,
    envelope: env,
    usage,
    ...(orphan ? { orphan } : {})
  }
}
