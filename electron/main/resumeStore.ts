/**
 * The resume checkpoint's owner (implementation_plan.md Step 3.3; feature_decisions.md AR3-5, AR3-8).
 * AUTHORED-BY: opus-5.5-high
 *
 * `engine/progress.ts` says what a checkpoint is; this module says where it lives and does every read
 * and write of one. The root is `<userData>/resume-v1/`, one directory per generation:
 *
 *   resume-v1/<generation UUID>/job.json          the job it belongs to; written once, never again
 *   resume-v1/<generation UUID>/checkpoint.json   the record, replaced old-or-new on every change
 *   resume-v1/<generation UUID>/translate.partial.srt, .tmp scratch, translate.complete.srt
 *                                                 Translate's working output (Transcribe's stays
 *                                                 beside the destination the user chose)
 *   resume-v1/quarantine/                         damaged generations, moved aside with their bytes
 *
 * None of it is under `userData/temp`, so the legacy `sweepTempDir()` cannot reach it.
 *
 * ⚠ The rules this keeps:
 *  1. Output before pointer. A commit stages and reads back the new snapshot, records the intent
 *     (`pendingOutput`), lands the snapshot, and only then records it as `committed`. A crash at any
 *     instant leaves the old complete pair or the new one; recovery tells them apart by digest.
 *  2. Inspection writes nothing. It reads, hashes and decides; finishing an interrupted commit or
 *     rolling one back happens only when the user chooses Continue.
 *  3. The renderer names inputs, never paths in here. Every path this module opens comes from its own
 *     root or from a checkpoint that passed `decodeCheckpoint` and the path rules below; a path named
 *     by a damaged record is never followed.
 *  4. Nothing is deleted without its owner's proof: Start over removes a working file only while its
 *     digest is still the one this generation recorded, and preserves and reports any other.
 */
import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { RunKind } from '../shared/engineEvents'
import { modelCapabilities } from '../shared/modelCaps'
import type { ResumeInspectRequest, ResumeInvalidReason, ResumeOffer } from '../shared/types'
import { NODE_OUTPUT_IO, PartialOutput, writeTextAtomic, type FlushStage, type OutputIo, type PartialOutputOptions, type PromoteResult } from '../engine/output'
import type { SentContext, TranslationJournal, TranslationRetry } from '../engine/run'
import {
  CHECKPOINT_MAX_BYTES,
  JOB_ENTRY_MAX_BYTES,
  NATIVE_REQUEST_CONTRACT,
  RESUME_JOB_SCHEMA,
  TRANSCRIPTION_PROMPT_CONTRACT,
  TRANSLATION_PROMPT_CONTRACT,
  TRANSLATION_PROMPT_CONTRACT_V2,
  canonicalDigest,
  canonicalJson,
  checkTranscribeOutput,
  checkTranslateOutput,
  coveredUnits,
  decodeCheckpoint,
  decodeJobEntry,
  encodeCheckpoint,
  isCompleteCoverage,
  normalizedDestination,
  outputTextDigest,
  sameJobHint,
  transcribeJobKey,
  translateJobKey,
  transcribeSpanDigest,
  translateRowsFor,
  type Checkpoint,
  type CompletionBaseline,
  type Coverage,
  type FailedSpanRecord,
  type FfmpegFingerprint,
  type FileReceipt,
  type JobEntry,
  type JobHint,
  type OutputVerdict,
  type ResumeConfig,
  type SourceFingerprint,
  type SourceRole,
  type TranscribeCoverage,
  type TranscribeResumeConfig,
  type TranscribeSpan,
  type TranscriptCue,
  type TranslateCoverage,
  type TranslateResumeConfig,
  type WorkingOutput
} from '../engine/progress'
import { formatSrt, parseCues, writtenCueText, type Cue } from '../engine/srt'
import type { RestoredRow } from '../engine/translationState'
import type { TranscribedPart, TranscriptionJournal } from '../engine/transcribe'
import { decodeSubtitleBuffer, sha256Hex } from '../engine/subtitleInput'
import { extractTrack, ffmpegPathDirs } from './ffmpeg'

export const RESUME_ROOT_NAME = 'resume-v1'
export const QUARANTINE_DIR = 'quarantine'
export const JOB_FILE = 'job.json'
export const CHECKPOINT_FILE = 'checkpoint.json'
export const TRANSLATE_PARTIAL = 'translate.partial.srt'
export const TRANSLATE_COMPLETE = 'translate.complete.srt'
/** Finished generations and unreferenced files older than this go at startup; paused work never does. */
export const RESUME_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000

const EXE = process.platform === 'win32' ? '.exe' : ''

export function defaultResumeRoot(): string {
  return path.join(app.getPath('userData'), RESUME_ROOT_NAME)
}

function samePath(a: string, b: string): boolean {
  return normalizedDestination(a) === normalizedDestination(b)
}

/** SHA-256 and length of a whole file, streamed: a film is never read into memory. Stop ends the read. */
export function hashFile(file: string, signal?: AbortSignal): Promise<FileReceipt> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('The read was stopped.'))
    const hash = crypto.createHash('sha256')
    let byteLength = 0
    const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 })
    const onAbort = () => stream.destroy(new Error('The read was stopped.'))
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => {
      const buf = chunk as Buffer
      hash.update(buf)
      byteLength += buf.length
    })
    stream.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ byteLength, sha256: hash.digest('hex') })
    })
  })
}

// ── FFmpeg: the binary that cuts later work, as `ffmpeg.ts` resolves it ──────────────────────────

export type FfmpegProbe = (ffmpegPath?: string) => Promise<FfmpegFingerprint | null>

/** The ffmpeg `ffmpeg.ts` runs: the Settings override's directory, the bundled copy, then PATH. */
function ffmpegBinary(ffmpegPath?: string): string | null {
  const dir = ffmpegPathDirs(ffmpegPath)[0]
  if (dir) return path.join(dir, `ffmpeg${EXE}`)
  for (const d of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!d) continue
    const candidate = path.join(d, `ffmpeg${EXE}`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** Its bytes and its own first `-version` line; null when there is none to run. */
export const probeFfmpeg: FfmpegProbe = async (ffmpegPath) => {
  const bin = ffmpegBinary(ffmpegPath)
  if (!bin) return null
  let receipt: FileReceipt
  try {
    receipt = await hashFile(bin)
  } catch {
    return null
  }
  const version = await new Promise<string | null>((resolve) => {
    // FFmpeg's one stdio contract (`ffmpeg.ts` `execCapture`): no shell, stdin ignored. `execFile`
    // cannot take a `stdio` option, so the bound it gave — 15 s, 1 MiB, hidden window — is kept here.
    let out = ''
    let child
    try {
      child = spawn(bin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 1 << 20) out += d.toString()
    })
    child.stderr.resume()
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? (out.split(/\r?\n/)[0] ?? '').trim() : null))
  })
  if (version === null) return null
  return { path: bin, sha256: receipt.sha256, version }
}

export type TrackExtractor = (container: string, streamIndex: number, outPath: string, ffmpegPath?: string) => Promise<{ ok: boolean; error?: string }>

const extractTextTrack: TrackExtractor = (container, streamIndex, outPath, ffmpegPath) => extractTrack(container, streamIndex, outPath, false, ffmpegPath)

// ── The inspect request crosses IPC, so its shape is checked rather than trusted ────────────────

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function optionalPath(v: unknown): boolean {
  return v === undefined || nonEmpty(v)
}

export function parseInspectRequest(v: unknown): ResumeInspectRequest | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  const only = (allowed: string[]) => keys.every((k) => allowed.includes(k))
  if (o.kind === 'transcribe') {
    if (!only(['kind', 'mediaFile', 'outputFile']) || !nonEmpty(o.mediaFile) || !nonEmpty(o.outputFile)) return null
    return { kind: 'transcribe', mediaFile: o.mediaFile, outputFile: o.outputFile }
  }
  if (o.kind !== 'translate' || !nonEmpty(o.inputFile) || !nonEmpty(o.targetLang) || !optionalPath(o.audioFile)) return null
  const audio = o.audioFile === undefined ? {} : { audioFile: o.audioFile as string }
  if (o.inputKind === 'subtitleFile') {
    if (!only(['kind', 'inputKind', 'inputFile', 'targetLang', 'videoFile', 'audioFile']) || !optionalPath(o.videoFile)) return null
    return {
      kind: 'translate',
      inputKind: 'subtitleFile',
      inputFile: o.inputFile,
      targetLang: o.targetLang,
      ...(o.videoFile === undefined ? {} : { videoFile: o.videoFile as string }),
      ...audio
    }
  }
  if (o.inputKind === 'extractedTrack') {
    if (!only(['kind', 'inputKind', 'inputFile', 'containerFile', 'streamIndex', 'targetLang', 'audioFile'])) return null
    if (!nonEmpty(o.containerFile) || !Number.isSafeInteger(o.streamIndex) || (o.streamIndex as number) < 0) return null
    return {
      kind: 'translate',
      inputKind: 'extractedTrack',
      inputFile: o.inputFile,
      containerFile: o.containerFile,
      streamIndex: o.streamIndex as number,
      targetLang: o.targetLang,
      ...audio
    }
  }
  return null
}

// ── What a job is, from the user's current inputs ──────────────────────────────────────────────

/** The current inputs' complete identity. Built from the pickers; never from a checkpoint. */
export interface JobIdentity {
  kind: RunKind
  jobKey: string
  hint: JobHint
  /** Receipts of the inputs as they are now. A role is absent when its input could not be read. */
  receipts: Partial<Record<SourceRole, FileReceipt>>
  /** Roles the request selected, read or not. */
  selected: SourceRole[]
  /** Translate: the subtitle bytes this identity was taken from (the disk file, or a fresh extraction). */
  subtitle: Buffer | null
  /** The extracted track, re-materialised on demand (AR3-6): never the page's old temp file. */
  extracted?: { container: string; streamIndex: number }
  /** Transcribe: the selected destination. */
  destination?: string
}

export type ResumeCheckpointRead =
  | { state: 'missing' }
  | { state: 'read'; sha256: string; decoded: ReturnType<typeof decodeCheckpoint> }

/** One full, bounded read: `stat` first, then the whole file as strict UTF-8 (AR3-5). */
export function readCheckpointFile(file: string): ResumeCheckpointRead {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'read', sha256: '', decoded: { ok: false, reason: 'checkpointCorrupt', detail: 'the record cannot be read.' } }
  }
  const corrupt = (detail: string, sha256 = ''): ResumeCheckpointRead => ({ state: 'read', sha256, decoded: { ok: false, reason: 'checkpointCorrupt', detail } })
  if (!stat.isFile()) return corrupt('the record is not a file.')
  if (stat.size > CHECKPOINT_MAX_BYTES) return corrupt('the record is larger than 32 MiB.')
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(file)
  } catch {
    return corrupt('the record cannot be read.')
  }
  const sha256 = sha256Hex(bytes)
  if (bytes.length > CHECKPOINT_MAX_BYTES) return corrupt('the record is larger than 32 MiB.', sha256)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return corrupt('the record is not UTF-8.', sha256)
  }
  return { state: 'read', sha256, decoded: decodeCheckpoint(text) }
}

function readJobEntry(dir: string): JobEntry | null | 'missing' {
  const file = path.join(dir, JOB_FILE)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null
  }
  if (!stat.isFile() || stat.size > JOB_ENTRY_MAX_BYTES) return null
  try {
    const entry = decodeJobEntry(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)))
    return entry && entry.generationId === path.basename(dir) ? entry : null
  } catch {
    return null
  }
}

type FileNow = { state: 'absent' } | { state: 'present'; bytes: Buffer } | { state: 'unreadable' }

function readNow(file: string): FileNow {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return { state: 'unreadable' }
    return { state: 'present', bytes: fs.readFileSync(file) }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable' }
  }
}

function receiptOf(bytes: Buffer): FileReceipt {
  return { byteLength: bytes.length, sha256: sha256Hex(bytes) }
}

/** The file is exactly `receipt`; for no receipt, nothing has landed (absent, or the empty claim). */
function holds(now: FileNow, receipt: FileReceipt | null): boolean {
  if (receipt === null) return now.state === 'absent' || (now.state === 'present' && now.bytes.length === 0)
  return now.state === 'present' && now.bytes.length === receipt.byteLength && sha256Hex(now.bytes) === receipt.sha256
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Where a decoded record may point (rule 3). Translate's files are this generation's own fixed names;
 * Transcribe's partial and scratch sit beside its destination under the names `output.ts` claims.
 */
function pathsAreOwned(cp: Checkpoint, dir: string): boolean {
  const scratch = cp.pending?.kind === 'output' ? cp.pending.scratch : null
  if (cp.kind === 'translate') {
    const partial = path.join(dir, TRANSLATE_PARTIAL)
    if (!samePath(cp.working.path, partial) || !samePath(cp.completion.path, path.join(dir, TRANSLATE_COMPLETE))) return false
    if (cp.completion.baseline.state !== 'absent') return false
    return scratch === null || (samePath(path.dirname(scratch), dir) && /^translate\.partial\.srt\.[0-9a-f]{8}\.tmp$/i.test(path.basename(scratch)))
  }
  const destDir = path.dirname(cp.completion.path)
  if (!path.isAbsolute(cp.completion.path) || !samePath(path.dirname(cp.working.path), destDir)) return false
  const name = path.parse(cp.completion.path).name
  const partialName = new RegExp(`^${escapeRegExp(name)}\\.partial(?:\\.[0-9a-z]+)?\\.srt$`, 'i')
  if (!partialName.test(path.basename(cp.working.path))) return false
  if (scratch === null) return true
  return samePath(path.dirname(scratch), destDir) && new RegExp(`^${escapeRegExp(path.basename(cp.working.path))}\\.[0-9a-f]{8}\\.tmp$`, 'i').test(path.basename(scratch))
}

/** The record still describes behaviour this build can reproduce exactly. */
function configIsCurrent(config: ResumeConfig, ffmpegNow: FfmpegFingerprint | null): boolean {
  if (config.requestContract !== NATIVE_REQUEST_CONTRACT || config.provider !== 'gemini') return false
  const caps = modelCapabilities(config.model)
  if (config.kind === 'translate') {
    // Only the current contract, with its recorded context count (tester TD15-2); v1 is refused (PR-5).
    // v2 differs only where an override replaced built-in rules, so it continues only without one.
    const contract =
      config.promptContract === TRANSLATION_PROMPT_CONTRACT ||
      (config.promptContract === TRANSLATION_PROMPT_CONTRACT_V2 && config.systemPrompt.trim() === '')
    const current = contract && config.batchContextLines !== undefined
    if (!current || !caps.structuredOutput) return false
  } else if (config.promptContract !== TRANSCRIPTION_PROMPT_CONTRACT || !caps.supportsTranscription) {
    return false
  }
  if (config.ffmpeg) return !!ffmpegNow && ffmpegNow.sha256 === config.ffmpeg.sha256 && ffmpegNow.version === config.ffmpeg.version
  return true
}

/** How a pending record resolves against the files as they are (AR3-5 recovery). */
export type WorkingResolution =
  | { kind: 'working'; working: WorkingOutput; repair: 'none' | 'rollback' | 'finalize' }
  | { kind: 'completed' }
  | { kind: 'invalid'; reason: ResumeInvalidReason }

export function resolveWorking(cp: Checkpoint, partialNow: FileNow, completionNow: FileNow): WorkingResolution {
  if (cp.state === 'pendingOutput' && cp.pending?.kind === 'output') {
    if (holds(partialNow, cp.working.output)) return { kind: 'working', working: cp.working, repair: 'rollback' }
    if (holds(partialNow, cp.pending.output)) {
      return { kind: 'working', working: { path: cp.working.path, output: cp.pending.output, coverage: cp.pending.coverage }, repair: 'finalize' }
    }
    return { kind: 'invalid', reason: partialNow.state === 'absent' ? 'outputMissing' : 'outputChanged' }
  }
  if (cp.state === 'pendingPromotion' && cp.pending?.kind === 'promotion') {
    // A rename is one step: while the partial is there, the completion target was not replaced.
    if (partialNow.state !== 'absent') return { kind: 'working', working: cp.working, repair: 'rollback' }
    if (holds(completionNow, cp.pending.completion)) return { kind: 'completed' }
    return { kind: 'invalid', reason: 'outputMissing' }
  }
  return { kind: 'working', working: cp.working, repair: 'none' }
}

/** The effective working output read back: bytes, parse, cue count, then every covered unit. */
function verifyWorking(working: WorkingOutput, partialNow: FileNow, sourceCues: readonly Cue[] | null): OutputVerdict | 'outputMissing' | 'outputChanged' {
  if (working.output === null) return holds(partialNow, null) ? 'ok' : 'outputChanged'
  if (partialNow.state === 'absent') return 'outputMissing'
  if (!holds(partialNow, working.output) || partialNow.state !== 'present') return 'outputChanged'
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(partialNow.bytes)
  } catch {
    return 'outputInvalid'
  }
  const back = parseCues(text)
  // An empty snapshot is a Transcribe run whose first chunk was quiet: no timing, no cue.
  const written = back.ok ? back.cues : text.trim() === '' ? [] : null
  if (!written || written.length !== working.output.cueCount) return 'outputInvalid'
  if (working.coverage.kind === 'translate') return sourceCues ? checkTranslateOutput(working.coverage, sourceCues, written) : 'coverageInvalid'
  return checkTranscribeOutput(working.coverage, written)
}

/** Nothing to continue: no committed unit and no failed span to retry. */
function holdsNoWork(coverage: Coverage): boolean {
  return coverage.kind === 'translate' ? coverage.rows.length === 0 && coverage.failedSpan === null : coverage.spans.length === 0
}

/** A generation the store found for a job, judged against the current inputs. */
export type Judgement =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: ResumeInvalidReason }
  | {
      kind: 'valid'
      checkpoint: Checkpoint
      working: WorkingOutput
      repair: 'none' | 'rollback' | 'finalize'
      /** Translate: the source cues the coverage was verified against. */
      sourceCues: Cue[] | null
    }

export interface Found {
  dir: string
  entry: JobEntry
  /** The job key matched; otherwise only the pickers' paths and target did. */
  exact: boolean
}

interface OfferRecord {
  dir: string
  generationId: string
  jobKey: string
  /** The record's bytes when the offer was made: any later change makes the offer stale. */
  checkpointSha256: string | null
}

export interface ResumeStoreOptions {
  root: string
  now?: () => number
  io?: Partial<OutputIo>
  ffmpeg?: FfmpegProbe
  extract?: TrackExtractor
}

export type StartOverResult =
  | { ok: true; preserved: string[] }
  | { ok: false; reason: 'generationStale' | 'writeFailed'; message: string }

export interface CleanupReport {
  removed: number
  quarantined: number
}

export class ResumeStore {
  readonly root: string
  readonly io: OutputIo
  private readonly offers = new Map<string, OfferRecord>()

  constructor(private readonly opts: ResumeStoreOptions) {
    this.root = opts.root
    this.io = { ...NODE_OUTPUT_IO, ...opts.io }
  }

  now(): number {
    return (this.opts.now ?? Date.now)()
  }

  probeFfmpeg(ffmpegPath?: string): Promise<FfmpegFingerprint | null> {
    return (this.opts.ffmpeg ?? probeFfmpeg)(ffmpegPath)
  }

  // ── Read side ──

  /** The current inputs' identity, or null when the primary input cannot be read at all. */
  async identify(req: ResumeInspectRequest): Promise<JobIdentity | null> {
    try {
      if (req.kind === 'transcribe') {
        const media = fs.realpathSync(req.mediaFile)
        const receipt = await hashFile(media)
        return {
          kind: 'transcribe',
          jobKey: transcribeJobKey({ media: receipt, destination: req.outputFile }),
          hint: { inputKind: 'media', primary: normalizedDestination(media), streamIndex: null, target: normalizedDestination(req.outputFile) },
          receipts: { media: receipt },
          selected: ['media'],
          subtitle: null,
          destination: req.outputFile
        }
      }
      const receipts: Partial<Record<SourceRole, FileReceipt>> = {}
      const selected: SourceRole[] = []
      let jobKey: string
      let hint: JobHint
      let subtitle: Buffer | null = null
      let extracted: JobIdentity['extracted']
      if (req.inputKind === 'subtitleFile') {
        const canonical = fs.realpathSync(req.inputFile)
        subtitle = fs.readFileSync(canonical)
        receipts.subtitleFile = receiptOf(subtitle)
        selected.push('subtitleFile')
        jobKey = translateJobKey({ inputKind: 'subtitleFile', subtitle: receipts.subtitleFile, targetLang: req.targetLang })
        hint = { inputKind: 'subtitleFile', primary: normalizedDestination(canonical), streamIndex: null, target: req.targetLang }
      } else {
        const container = fs.realpathSync(req.containerFile)
        receipts.container = await hashFile(container)
        selected.push('container', 'extractedSubtitle')
        jobKey = translateJobKey({ inputKind: 'extractedTrack', container: receipts.container, streamIndex: req.streamIndex, targetLang: req.targetLang })
        hint = { inputKind: 'extractedTrack', primary: normalizedDestination(container), streamIndex: req.streamIndex, target: req.targetLang }
        extracted = { container, streamIndex: req.streamIndex }
      }
      if (req.audioFile !== undefined) {
        selected.push('audio')
        try {
          receipts.audio = await hashFile(fs.realpathSync(req.audioFile))
        } catch {
          /* selected and unreadable: no generation recorded with audio can match it */
        }
      }
      return { kind: 'translate', jobKey, hint, receipts, selected, subtitle, ...(extracted ? { extracted } : {}) }
    } catch {
      return null
    }
  }

  /** Re-materialise the selected track through the existing extractor, into this store's own scratch. */
  private async materialise(identity: JobIdentity, ffmpegPath?: string): Promise<void> {
    if (!identity.extracted || identity.subtitle) return
    fs.mkdirSync(this.root, { recursive: true })
    const out = path.join(this.root, `.inspect-${crypto.randomUUID()}.srt`)
    try {
      const r = await (this.opts.extract ?? extractTextTrack)(identity.extracted.container, identity.extracted.streamIndex, out, ffmpegPath)
      if (!r.ok) return
      identity.subtitle = fs.readFileSync(out)
      identity.receipts.extractedSubtitle = receiptOf(identity.subtitle)
    } catch {
      /* a track that cannot be re-extracted matches no recorded receipt */
    } finally {
      try {
        fs.unlinkSync(out)
      } catch {
        /* never created, or already gone */
      }
    }
  }

  /** Every generation directory with a readable job entry. A damaged entry is cleanup's to quarantine. */
  private generations(): Array<{ dir: string; entry: JobEntry }> {
    let names: string[]
    try {
      names = fs.readdirSync(this.root)
    } catch {
      return []
    }
    const out: Array<{ dir: string; entry: JobEntry }> = []
    for (const name of names) {
      if (name === QUARANTINE_DIR) continue
      const dir = path.join(this.root, name)
      try {
        if (!fs.lstatSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const entry = readJobEntry(dir)
      if (entry && entry !== 'missing') out.push({ dir, entry })
    }
    return out
  }

  /** A generation not yet completed or discarded: a record that is missing or finished is no work. */
  private isOpen(dir: string): boolean {
    const read = readCheckpointFile(path.join(dir, CHECKPOINT_FILE))
    if (read.state === 'missing') return false
    if (!read.decoded.ok) return true
    return read.decoded.checkpoint.state !== 'completed' && read.decoded.checkpoint.state !== 'tombstoned'
  }

  /** The job's generation: its key first; failing that, a generation for the same pickers and target. */
  private find(identity: JobIdentity): Found | null {
    const all = this.generations().filter((g) => g.entry.kind === identity.kind)
    const mtime = (dir: string) => {
      try {
        return newestMtime(dir)
      } catch {
        return 0
      }
    }
    const newest = (list: Array<{ dir: string; entry: JobEntry }>) =>
      list
        .map((g) => ({ ...g, mtime: mtime(g.dir) }))
        .sort((a, b) => b.mtime - a.mtime)[0]
    const exact = all.filter((g) => g.entry.jobKey === identity.jobKey && this.isOpen(g.dir))
    if (exact.length) return { ...newest(exact), exact: true }
    const hinted = all.filter((g) => sameJobHint(g.entry.hint, identity.hint) && this.isOpen(g.dir))
    if (hinted.length) return { ...newest(hinted), exact: false }
    return null
  }

  /** Judge a found generation against the current inputs, in AR3-6's reason order. Reads only. */
  async judge(found: Found, identity: JobIdentity, ffmpegPath?: string): Promise<{ judgement: Judgement; checkpointSha256: string | null }> {
    const read = readCheckpointFile(path.join(found.dir, CHECKPOINT_FILE))
    if (read.state === 'missing') return { judgement: { kind: 'none' }, checkpointSha256: null }
    const sha = read.sha256 || null
    const out = (judgement: Judgement) => ({ judgement, checkpointSha256: sha })
    if (!read.decoded.ok) return out({ kind: 'invalid', reason: read.decoded.reason })
    const cp = read.decoded.checkpoint
    if (cp.generationId !== found.entry.generationId || cp.jobKey !== found.entry.jobKey || cp.kind !== found.entry.kind || !pathsAreOwned(cp, found.dir)) {
      return out({ kind: 'invalid', reason: 'checkpointCorrupt' })
    }
    if (cp.state === 'completed' || cp.state === 'tombstoned') return out({ kind: 'none' })
    if (!found.exact) return out({ kind: 'invalid', reason: 'sourceChanged' })

    // Sources: every recorded input as it is now, and no selected input the run did not have.
    if (cp.sources.some((s) => s.role === 'extractedSubtitle')) await this.materialise(identity, ffmpegPath)
    const recorded = new Set(cp.sources.map((s) => s.role))
    if (identity.selected.some((r) => !recorded.has(r))) return out({ kind: 'invalid', reason: 'sourceChanged' })
    for (const s of cp.sources) {
      const now = identity.receipts[s.role]
      if (!now || now.byteLength !== s.byteLength || now.sha256 !== s.sha256) return out({ kind: 'invalid', reason: 'sourceChanged' })
    }

    if (!configIsCurrent(cp.config, cp.config.ffmpeg ? await this.probeFfmpeg(ffmpegPath) : null)) {
      return out({ kind: 'invalid', reason: 'configurationUnavailable' })
    }

    let sourceCues: Cue[] | null = null
    if (cp.config.kind === 'translate') {
      if (!identity.subtitle) return out({ kind: 'invalid', reason: 'sourceChanged' })
      let text: string
      try {
        text = decodeSubtitleBuffer(identity.subtitle, cp.config.sourceEncoding)
      } catch {
        return out({ kind: 'invalid', reason: 'sourceChanged' })
      }
      const parsed = parseCues(text, { path: cp.config.inputKind === 'subtitleFile' ? (cp.sources.find((s) => s.role === 'subtitleFile')?.path ?? '') : 'track.srt' })
      if (!parsed.ok) return out({ kind: 'invalid', reason: 'sourceChanged' })
      sourceCues = parsed.cues
    }

    const partialNow = readNow(cp.working.path)
    const completionNow = readNow(cp.completion.path)
    const resolved = resolveWorking(cp, partialNow, completionNow)
    if (resolved.kind === 'completed') return out({ kind: 'none' })
    if (resolved.kind === 'invalid') return out(resolved)
    const verdict = verifyWorking(resolved.working, partialNow, sourceCues)
    if (verdict !== 'ok') return out({ kind: 'invalid', reason: verdict })
    if (holdsNoWork(resolved.working.coverage)) return out({ kind: 'none' })

    if (!destinationUnchanged(cp, completionNow)) return out({ kind: 'invalid', reason: 'destinationChanged' })
    return out({ kind: 'valid', checkpoint: cp, working: resolved.working, repair: resolved.repair, sourceCues })
  }

  /** `resume:inspect` (read-only): the offer for the job these inputs name, or null for none. */
  async inspect(req: ResumeInspectRequest, opts: { ffmpegPath?: string } = {}): Promise<ResumeOffer | null> {
    const identity = await this.identify(req)
    if (!identity) return null
    const found = this.find(identity)
    if (!found) return null
    const { judgement, checkpointSha256 } = await this.judge(found, identity, opts.ffmpegPath)
    if (judgement.kind === 'none') return null
    const resumeId = crypto.randomUUID()
    this.offers.set(resumeId, { dir: found.dir, generationId: found.entry.generationId, jobKey: found.entry.jobKey, checkpointSha256 })
    if (judgement.kind === 'invalid') return { state: 'invalid', resumeId, kind: identity.kind, reason: judgement.reason }
    const { checkpoint: cp, working } = judgement
    if (working.coverage.kind === 'translate') {
      const span = working.coverage.failedSpan
      const base = { state: 'valid' as const, resumeId, kind: 'translate' as const, updatedAtEpochMs: cp.updatedAtEpochMs, completedUnits: working.coverage.rows.length, totalUnits: working.coverage.sourceCueCount, unit: 'cues' as const }
      if (span) {
        return {
          ...base,
          nextAction: 'retryFailedSpan',
          failedSpan: {
            fromCue: span.fromCue,
            toCue: span.toCue,
            originalModel: span.parentModel,
            maxBatchSize: Math.min(span.parentBatchSize, span.toCue - span.fromCue + 1),
            contextEnabled: span.context.kind !== 'none'
          }
        }
      }
      return { ...base, nextAction: 'continue' }
    }
    return {
      state: 'valid',
      resumeId,
      kind: 'transcribe',
      updatedAtEpochMs: cp.updatedAtEpochMs,
      completedUnits: coveredUnits(working.coverage),
      totalUnits: working.coverage.durationMs,
      unit: 'milliseconds',
      nextAction: 'continue'
    }
  }

  /**
   * The offer behind a `resumeId`, if it is still the current one: the record's bytes are unchanged
   * since inspection. Anything else is `generationStale` (AR3-6).
   */
  currentOffer(resumeId: string): OfferRecord | null {
    const rec = this.offers.get(resumeId)
    if (!rec) return null
    const read = readCheckpointFile(path.join(rec.dir, CHECKPOINT_FILE))
    const sha = read.state === 'read' ? read.sha256 || null : null
    return sha === rec.checkpointSha256 ? rec : null
  }

  /** Whether the job these inputs name has a generation that needs Continue or Start over first. */
  async hasOpenGeneration(identity: JobIdentity): Promise<boolean> {
    const all = this.generations().filter((g) => g.entry.kind === identity.kind && g.entry.jobKey === identity.jobKey)
    return all.some((g) => this.isOpen(g.dir))
  }

  /**
   * A Translate run's identity at Start, from Bundle A's one verified read of the subtitle — never a
   * second reader — plus the streamed container and audio. Null when a selected input cannot be read.
   */
  async identifyRun(run: {
    inputKind: 'subtitleFile' | 'extractedTrack'
    /** The verified bytes: the disk subtitle, or this Start's own extraction of the selected track. */
    subtitle: { path: string; bytes: Buffer }
    containerFile?: string
    streamIndex?: number
    audioFile?: string
    targetLang: string
    signal?: AbortSignal
  }): Promise<{ identity: JobIdentity; sources: SourceFingerprint[] } | null> {
    try {
      const subtitle = receiptOf(run.subtitle.bytes)
      const receipts: Partial<Record<SourceRole, FileReceipt>> = {}
      const sources: SourceFingerprint[] = []
      const selected: SourceRole[] = []
      let jobKey: string
      let hint: JobHint
      let extracted: JobIdentity['extracted']
      if (run.inputKind === 'subtitleFile') {
        const canonical = fs.realpathSync(run.subtitle.path)
        receipts.subtitleFile = subtitle
        selected.push('subtitleFile')
        sources.push({ role: 'subtitleFile', path: canonical, ...subtitle })
        jobKey = translateJobKey({ inputKind: 'subtitleFile', subtitle, targetLang: run.targetLang })
        hint = { inputKind: 'subtitleFile', primary: normalizedDestination(canonical), streamIndex: null, target: run.targetLang }
      } else {
        if (!run.containerFile || run.streamIndex === undefined) return null
        const container = fs.realpathSync(run.containerFile)
        receipts.container = await hashFile(container, run.signal)
        receipts.extractedSubtitle = subtitle
        selected.push('container', 'extractedSubtitle')
        sources.push({ role: 'container', path: container, ...receipts.container, streamIndex: run.streamIndex })
        sources.push({ role: 'extractedSubtitle', path: run.subtitle.path, ...subtitle })
        jobKey = translateJobKey({ inputKind: 'extractedTrack', container: receipts.container, streamIndex: run.streamIndex, targetLang: run.targetLang })
        hint = { inputKind: 'extractedTrack', primary: normalizedDestination(container), streamIndex: run.streamIndex, target: run.targetLang }
        extracted = { container, streamIndex: run.streamIndex }
      }
      if (run.audioFile) {
        const audio = fs.realpathSync(run.audioFile)
        receipts.audio = await hashFile(audio, run.signal)
        selected.push('audio')
        sources.push({ role: 'audio', path: audio, ...receipts.audio })
      }
      return {
        identity: { kind: 'translate', jobKey, hint, receipts, selected, subtitle: run.subtitle.bytes, ...(extracted ? { extracted } : {}) },
        sources
      }
    } catch {
      return null
    }
  }

  /** The frozen configuration behind an offer, for the start path's model guard. Null when there is none. */
  offerConfig(resumeId: string): ResumeConfig | null {
    const rec = this.offers.get(resumeId)
    if (!rec) return null
    const read = readCheckpointFile(path.join(rec.dir, CHECKPOINT_FILE))
    return read.state === 'read' && read.decoded.ok ? read.decoded.checkpoint.config : null
  }

  /**
   * Continue (AR3-6): the offer is consumed, then its generation is judged again against the inputs as
   * they are at this Start — source, configuration, output, coverage and completion target.
   */
  async revalidate(
    resumeId: string,
    identity: JobIdentity,
    ffmpegPath?: string
  ): Promise<{ kind: 'valid'; dir: string; judged: Extract<Judgement, { kind: 'valid' }> } | { kind: 'invalid'; reason: ResumeInvalidReason }> {
    const rec = this.currentOffer(resumeId)
    this.offers.delete(resumeId)
    if (!rec) return { kind: 'invalid', reason: 'generationStale' }
    const entry = readJobEntry(rec.dir)
    if (!entry || entry === 'missing' || entry.generationId !== rec.generationId) return { kind: 'invalid', reason: 'checkpointCorrupt' }
    const { judgement } = await this.judge({ dir: rec.dir, entry, exact: entry.jobKey === identity.jobKey }, identity, ffmpegPath)
    if (judgement.kind === 'valid') return { kind: 'valid', dir: rec.dir, judged: judgement }
    return { kind: 'invalid', reason: judgement.kind === 'invalid' ? judgement.reason : 'generationStale' }
  }

  /**
   * A directory for a new generation, made before the run reserves its slot so the run's console and
   * reports can sit beside its output. It holds no job entry or record until the run has work.
   */
  allocate(): { generationId: string; dir: string } {
    const generationId = crypto.randomUUID()
    const dir = path.join(this.root, generationId)
    fs.mkdirSync(dir, { recursive: true })
    return { generationId, dir }
  }

  /** An allocated directory a refused start never used: removed only while it is still empty. */
  release(dir: string): void {
    try {
      fs.rmdirSync(dir)
    } catch {
      /* not empty, or already gone: cleanup's to judge by age */
    }
  }

  /** A Translate generation's private completion target, where its run writes (AR3-5). */
  translateCompletionPath(dir: string): string {
    return path.join(dir, TRANSLATE_COMPLETE)
  }

  /** A Translate run's journal (`run.ts` `TranslationJournal`): a new generation, or an adopted one. */
  translateJournal(init: TranslateJournalInit): TranslationJournal {
    return new TranslateJournal(this, init)
  }

  /**
   * A Transcribe run's identity at Start: the complete media streamed and hashed (never a sample) and
   * the destination. Null when the media cannot be read.
   */
  async identifyTranscribeRun(run: { mediaFile: string; outputFile: string; signal?: AbortSignal }): Promise<{ identity: JobIdentity; sources: SourceFingerprint[] } | null> {
    try {
      const media = fs.realpathSync(run.mediaFile)
      const receipt = await hashFile(media, run.signal)
      return {
        identity: {
          kind: 'transcribe',
          jobKey: transcribeJobKey({ media: receipt, destination: run.outputFile }),
          hint: { inputKind: 'media', primary: normalizedDestination(media), streamIndex: null, target: normalizedDestination(run.outputFile) },
          receipts: { media: receipt },
          selected: ['media'],
          subtitle: null,
          destination: run.outputFile
        },
        sources: [{ role: 'media', path: media, ...receipt }]
      }
    } catch {
      return null
    }
  }

  /** What the destination holds before a fresh Transcribe run (AR3-5); null when it cannot be read. */
  destinationBaseline(dest: string): CompletionBaseline | null {
    const now = readNow(dest)
    if (now.state === 'absent') return { state: 'absent' }
    return now.state === 'present' ? { state: 'existing', ...receiptOf(now.bytes) } : null
  }

  /** A Transcribe run's journal (`transcribe.ts` `TranscriptionJournal`): a new generation, or an adopted one. */
  transcribeJournal(init: TranscribeJournalInit): TranscriptionJournal {
    return new TranscribeJournal(this, init)
  }

  // ── Write side ──

  /** Write a record old-or-new through `output.ts`'s one replacement primitive. */
  async writeCheckpoint(dir: string, cp: Checkpoint): Promise<{ ok: true } | { ok: false; message: string }> {
    const r = await writeTextAtomic(path.join(dir, CHECKPOINT_FILE), encodeCheckpoint(cp), { io: this.io })
    return r.ok ? r : { ok: false, message: r.message }
  }

  /**
   * A new generation for a job: its directory and job entry. No checkpoint exists until the first
   * commit or recorded failure, so a run that ends with nothing done leaves nothing to offer.
   */
  async createGeneration(init: {
    kind: RunKind
    jobKey: string
    hint: JobHint
    sources: SourceFingerprint[]
    config: ResumeConfig
    coverage: Coverage
    /** Transcribe: the destination and what was there before. Translate's target is its own. */
    completion?: { path: string; baseline: CompletionBaseline }
    /** A directory `allocate` made for this run; a fresh one otherwise. */
    generationId?: string
  }): Promise<ResumeGeneration | null> {
    const generationId = init.generationId ?? crypto.randomUUID()
    const dir = path.join(this.root, generationId)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      return null
    }
    const entry: JobEntry = { schema: RESUME_JOB_SCHEMA, generationId, kind: init.kind, jobKey: init.jobKey, hint: init.hint }
    const wrote = await writeTextAtomic(path.join(dir, JOB_FILE), canonicalJson(entry), { io: this.io })
    if (!wrote.ok) return null
    const at = this.now()
    const translate = init.kind === 'translate'
    const completion = translate ? { path: path.join(dir, TRANSLATE_COMPLETE), baseline: { state: 'absent' as const } } : init.completion
    if (!completion) throw new TypeError('A Transcribe generation needs its destination.')
    const cp: Checkpoint = {
      schema: 'srt-ai-resume/v1',
      generationId,
      ownerToken: crypto.randomUUID(),
      kind: init.kind,
      state: 'committed',
      createdAtEpochMs: at,
      updatedAtEpochMs: at,
      jobKey: init.jobKey,
      sources: init.sources,
      config: init.config,
      configDigest: canonicalDigest(init.config),
      working: { path: translate ? path.join(dir, TRANSLATE_PARTIAL) : partialPlaceholder(completion.path), output: null, coverage: init.coverage },
      completion,
      pending: null
    }
    return new ResumeGeneration(this, dir, cp)
  }

  /** Reopen a judged generation for Continue, settling an interrupted commit first (AR3-5 recovery). */
  async adopt(dir: string, judged: Extract<Judgement, { kind: 'valid' }>): Promise<ResumeGeneration | null> {
    const cp: Checkpoint = { ...judged.checkpoint, state: 'committed', pending: null, working: judged.working, updatedAtEpochMs: this.now() }
    if (judged.repair !== 'none') {
      const wrote = await this.writeCheckpoint(dir, cp)
      if (!wrote.ok) return null
    }
    return new ResumeGeneration(this, dir, judged.repair === 'none' ? judged.checkpoint : cp)
  }

  /** Move a generation aside with every byte it holds; nothing it names is touched. */
  quarantine(dir: string): boolean {
    try {
      const into = path.join(this.root, QUARANTINE_DIR)
      fs.mkdirSync(into, { recursive: true })
      fs.renameSync(dir, path.join(into, `${path.basename(dir)}-${this.now()}`))
      return true
    } catch {
      return false
    }
  }

  /**
   * Explicit Start over (AR3-8): invalidate first, then remove each working file only while it still
   * holds a digest this generation recorded. A damaged record is quarantined, never followed.
   */
  async startOver(resumeId: string): Promise<StartOverResult> {
    const rec = this.currentOffer(resumeId)
    this.offers.delete(resumeId)
    if (!rec) return { ok: false, reason: 'generationStale', message: 'This resume offer is no longer current.' }
    const read = readCheckpointFile(path.join(rec.dir, CHECKPOINT_FILE))
    if (read.state === 'missing') return { ok: true, preserved: [] }
    if (!read.decoded.ok) {
      return this.quarantine(rec.dir) ? { ok: true, preserved: [] } : { ok: false, reason: 'writeFailed', message: 'The damaged saved work could not be moved aside.' }
    }
    const cp = read.decoded.checkpoint
    if (!pathsAreOwned(cp, rec.dir) || cp.generationId !== rec.generationId) {
      return this.quarantine(rec.dir) ? { ok: true, preserved: [] } : { ok: false, reason: 'writeFailed', message: 'The damaged saved work could not be moved aside.' }
    }
    const tomb: Checkpoint = { ...cp, state: 'tombstoned', pending: null, updatedAtEpochMs: Math.max(this.now(), cp.updatedAtEpochMs) }
    const wrote = await this.writeCheckpoint(rec.dir, tomb)
    if (!wrote.ok) return { ok: false, reason: 'writeFailed', message: `The saved work could not be discarded: ${wrote.message}` }
    const preserved: string[] = []
    /** `null` among the receipts allows the empty claim, which holds nothing. */
    const remove = (file: string, receipts: Array<FileReceipt | null>) => {
      const now = readNow(file)
      if (now.state === 'absent') return
      if (now.state === 'present' && receipts.some((r) => holds(now, r))) {
        try {
          fs.unlinkSync(file)
          return
        } catch {
          /* kept, and reported */
        }
      }
      preserved.push(file)
    }
    const proposed = cp.pending?.kind === 'output' ? cp.pending.output : null
    remove(cp.working.path, [cp.working.output, proposed, null])
    if (cp.pending?.kind === 'output') remove(cp.pending.scratch, [cp.pending.output])
    if (cp.kind === 'translate') remove(cp.completion.path, cp.pending?.kind === 'promotion' ? [cp.pending.completion] : [])
    return { ok: true, preserved }
  }

  /**
   * Startup (AR3-8): remove completed or discarded generations and unreferenced generated files once
   * they are older than seven days; quarantine a generation whose job entry or record is damaged.
   * A paused generation is never removed for its age, and nothing outside the root is touched.
   */
  cleanup(now = this.now()): CleanupReport {
    const report: CleanupReport = { removed: 0, quarantined: 0 }
    let names: string[]
    try {
      names = fs.readdirSync(this.root)
    } catch {
      return report
    }
    const old = (mtimeMs: number) => now - mtimeMs >= RESUME_CLEANUP_AGE_MS
    for (const name of names) {
      if (name === QUARANTINE_DIR) continue
      const at = path.join(this.root, name)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(at)
      } catch {
        continue
      }
      try {
        if (!stat.isDirectory()) {
          // A stray inspection extract or anything else this store left: unreferenced by definition.
          if (stat.isFile() && old(stat.mtimeMs)) {
            fs.unlinkSync(at)
            report.removed++
          }
          continue
        }
        const entry = readJobEntry(at)
        const read = readCheckpointFile(path.join(at, CHECKPOINT_FILE))
        if (read.state === 'missing') {
          // Created and never committed: holds nothing a record names.
          if (entry !== null && old(newestMtime(at))) {
            fs.rmSync(at, { recursive: true, force: true })
            report.removed++
          } else if (entry === null && this.quarantine(at)) {
            report.quarantined++
          }
          continue
        }
        // A record from a newer build is not damage: it is left for that build.
        if (entry !== null && entry !== 'missing' && !read.decoded.ok && read.decoded.reason === 'checkpointVersion') continue
        const cp = read.decoded.ok ? read.decoded.checkpoint : null
        if (
          entry === null ||
          entry === 'missing' ||
          !cp ||
          cp.generationId !== entry.generationId ||
          cp.jobKey !== entry.jobKey ||
          cp.kind !== entry.kind ||
          !pathsAreOwned(cp, at)
        ) {
          if (this.quarantine(at)) report.quarantined++
          continue
        }
        if (cp.state === 'completed' || cp.state === 'tombstoned') {
          if (old(Math.max(cp.updatedAtEpochMs, newestMtime(at)))) {
            fs.rmSync(at, { recursive: true, force: true })
            report.removed++
          }
          continue
        }
        // Paused: never by age. Only its own unreferenced scratch goes.
        const referenced = new Set([cp.working.path, cp.completion.path, ...(cp.pending?.kind === 'output' ? [cp.pending.scratch] : [])].map(normalizedDestination))
        for (const f of fs.readdirSync(at)) {
          const file = path.join(at, f)
          if (f === JOB_FILE || f === CHECKPOINT_FILE || referenced.has(normalizedDestination(file))) continue
          const s = fs.lstatSync(file)
          if (s.isFile() && f.endsWith('.tmp') && old(s.mtimeMs)) {
            fs.unlinkSync(file)
            report.removed++
          }
        }
      } catch {
        /* best effort: a generation that cannot be inspected is left exactly as it is */
      }
    }
    return report
  }
}

function newestMtime(dir: string): number {
  let newest = fs.statSync(dir).mtimeMs
  for (const f of fs.readdirSync(dir)) {
    try {
      newest = Math.max(newest, fs.lstatSync(path.join(dir, f)).mtimeMs)
    } catch {
      /* gone meanwhile */
    }
  }
  return newest
}

function partialPlaceholder(dest: string): string {
  const parsed = path.parse(dest)
  return path.join(parsed.dir, `${parsed.name}.partial.srt`)
}

/** The completion target as the record expects it before completion (AR3-5 baselines). */
function destinationUnchanged(cp: Pick<Checkpoint, 'kind' | 'completion'>, completionNow: FileNow): boolean {
  if (cp.kind === 'translate') return completionNow.state === 'absent'
  const b = cp.completion.baseline
  if (b.state === 'absent') return completionNow.state === 'absent'
  return holds(completionNow, b)
}

/** Read immediately before a completion target is replaced: null while it is still its baseline. */
function completionRefusal(cp: Pick<Checkpoint, 'kind' | 'completion'>): string | null {
  if (destinationUnchanged(cp, readNow(cp.completion.path))) return null
  return cp.kind === 'translate'
    ? 'a finished copy already exists in this translation\u2019s saved work, so it was not replaced'
    : `"${path.basename(cp.completion.path)}" changed while the run was working, so it was not replaced`
}

const OUTPUT_CHANGED = 'the partial file changed after it was saved, so it was not used'

export type GenerationWriteStage = FlushStage | 'readBack' | 'intent' | 'finalize'

export type GenerationCommitResult = { ok: true } | { ok: false; stage: GenerationWriteStage; message: string }

/**
 * One open generation, held by the run that writes it. Every change goes intent → file → record, so
 * that `resolveWorking` can always tell the old pair from the new one.
 */
export class ResumeGeneration {
  private cp: Checkpoint

  constructor(
    private readonly store: ResumeStore,
    readonly dir: string,
    checkpoint: Checkpoint
  ) {
    this.cp = checkpoint
  }

  get checkpoint(): Checkpoint {
    return this.cp
  }

  get partialPath(): string {
    return path.join(this.dir, TRANSLATE_PARTIAL)
  }

  get completePath(): string {
    return path.join(this.dir, TRANSLATE_COMPLETE)
  }

  private stamp(cp: Checkpoint): Checkpoint {
    return { ...cp, updatedAtEpochMs: Math.max(this.store.now(), this.cp.updatedAtEpochMs) }
  }

  /**
   * Commit one snapshot (AR3-5 steps 1–4): stage it, read it back and hash it, record the intent, land
   * it, then record it as committed. `coverageFor` turns the cues read back into the new coverage, or
   * returns null when they are not what the run committed — then nothing is recorded or landed.
   * `revision` marks the intent as a rewrite of finished work's text, which decoding checks as such.
   */
  async commit(
    partial: PartialOutput,
    text: string,
    coverageFor: (written: readonly Cue[]) => Coverage | null,
    opts: { revision?: true } = {}
  ): Promise<GenerationCommitResult> {
    const staged = await partial.stage(text)
    if (!staged.ok) return staged
    const workingPath = partial.claimedPath
    if (!workingPath) return { ok: false, stage: 'claim', message: 'The partial file was not claimed.' }
    let bytes: Buffer
    try {
      bytes = fs.readFileSync(staged.scratch)
    } catch (e) {
      return { ok: false, stage: 'readBack', message: (e as Error).message }
    }
    const text8 = bytes.toString('utf-8')
    const back = parseCues(text8)
    const written = back.ok ? back.cues : text8.trim() === '' ? [] : null
    if (!written) return { ok: false, stage: 'readBack', message: back.ok ? '' : back.message }
    const output = { ...receiptOf(bytes), cueCount: written.length }
    const coverage = coverageFor(written)
    if (!coverage) return { ok: false, stage: 'readBack', message: 'the written subtitle does not read back as the parts it covers' }
    const base: Checkpoint = { ...this.cp, state: 'committed', pending: null, working: { ...this.cp.working, path: workingPath } }
    const intent = this.stamp({ ...base, state: 'pendingOutput', pending: { kind: 'output', scratch: staged.scratch, output, coverage, ...(opts.revision ? { revision: true as const } : {}) } })
    const recorded = await this.store.writeCheckpoint(this.dir, intent)
    // No intent on disk: landing now would leave a partial no record names, so the old pair stands.
    if (!recorded.ok) return { ok: false, stage: 'intent', message: recorded.message }
    const landed = await partial.land()
    if (!landed.ok) {
      await this.store.writeCheckpoint(this.dir, this.stamp(base))
      return { ok: false, stage: landed.stage, message: landed.message }
    }
    const done = this.stamp({ ...base, working: { path: workingPath, output, coverage } })
    // If this write fails the record still says pendingOutput, and its exact proposed receipt is what
    // landed: recovery finalizes to `done`, which is therefore what the next change builds on.
    this.cp = done
    const finalized = await this.store.writeCheckpoint(this.dir, done)
    return finalized.ok ? { ok: true } : { ok: false, stage: 'finalize', message: finalized.message }
  }

  /** Translate: the failed span to offer for retry, on unchanged committed coverage (AR3-7). */
  async recordFailedSpan(failedSpan: FailedSpanRecord | null): Promise<{ ok: true } | { ok: false; message: string }> {
    if (this.cp.working.coverage.kind !== 'translate') throw new TypeError('Only a translation records a failed span.')
    const next = this.stamp({ ...this.cp, state: 'committed', pending: null, working: { ...this.cp.working, coverage: { ...this.cp.working.coverage, failedSpan } } })
    const wrote = await this.store.writeCheckpoint(this.dir, next)
    if (wrote.ok) this.cp = next
    return wrote
  }

  /**
   * Completion (AR3-5): record the promotion intent with the landed snapshot's digest, replace the
   * completion target, then record `completed`. On failure the partial and the record stay paused.
   * Before the intent and before every replacement attempt, the target must still be its baseline and
   * the partial still exactly the committed snapshot; otherwise neither file is touched.
   */
  async promote(
    partial: PartialOutput,
    isCurrent: () => boolean
  ): Promise<PromoteResult & { finalized?: boolean; refused?: 'destinationChanged' | 'outputChanged' }> {
    const output = this.cp.working.output
    if (!output || !isCompleteCoverage(this.cp.working.coverage)) return { ok: false, stage: 'replace', message: 'The work is not complete.' }
    const committed = this.cp
    let refused: 'destinationChanged' | 'outputChanged' | undefined
    const verify = (): string | null => {
      const changed = completionRefusal(committed)
      if (changed !== null) {
        refused = 'destinationChanged'
        return changed
      }
      if (partial.claimedPath !== committed.working.path || !holds(readNow(committed.working.path), output)) {
        refused = 'outputChanged'
        return OUTPUT_CHANGED
      }
      return null
    }
    const early = verify()
    if (early !== null) return { ok: false, stage: 'replace', message: early, ...(refused ? { refused } : {}) }
    const intent = this.stamp({ ...committed, state: 'pendingPromotion', pending: { kind: 'promotion', completion: { byteLength: output.byteLength, sha256: output.sha256 } } })
    const recorded = await this.store.writeCheckpoint(this.dir, intent)
    if (!recorded.ok) return { ok: false, stage: 'replace', message: recorded.message }
    const promoted = await partial.promoteLanded(isCurrent, verify)
    if (!promoted.ok) {
      await this.store.writeCheckpoint(this.dir, this.stamp(committed))
      return refused ? { ...promoted, refused } : promoted
    }
    const done = this.stamp({ ...committed, state: 'completed', pending: null })
    this.cp = done
    const finalized = await this.store.writeCheckpoint(this.dir, done)
    return { ...promoted, finalized: finalized.ok }
  }

  /** Discard: the record says so before anything else changes. */
  async tombstone(): Promise<{ ok: true } | { ok: false; message: string }> {
    const next = this.stamp({ ...this.cp, state: 'tombstoned', pending: null })
    const wrote = await this.store.writeCheckpoint(this.dir, next)
    if (wrote.ok) this.cp = next
    return wrote
  }

  /**
   * Translate Continue: cues `1..n` with their provenance, read back from the working partial and
   * matched row by row to their recorded digests. A preserved row is restored as its source text, and
   * only if that is what was written (PR-3). Null when the partial is no longer exactly that.
   */
  restoredRows(sourceCues: readonly Cue[]): RestoredRow[] | null {
    const working = this.cp.working
    if (working.coverage.kind !== 'translate') return null
    const rows = working.coverage.rows
    if (!working.output) return rows.length === 0 ? [] : null
    const now = readNow(working.path)
    if (!holds(now, working.output) || now.state !== 'present') return null
    let written: Cue[]
    try {
      const back = parseCues(new TextDecoder('utf-8', { fatal: true }).decode(now.bytes))
      if (!back.ok) return null
      written = back.cues
    } catch {
      return null
    }
    if (written.length < rows.length || sourceCues.length < rows.length) return null
    const out: RestoredRow[] = []
    for (let i = 0; i < rows.length; i++) {
      const text = written[i].text
      if (outputTextDigest(text) !== rows[i].output) return null
      if (rows[i].provenance === 'accepted') out.push({ text, provenance: 'accepted' })
      else if (text === writtenCueText(sourceCues[i].text)) out.push({ text: sourceCues[i].text, provenance: 'preserved' })
      else return null
    }
    return out
  }

  /**
   * Transcribe Continue: the committed parts and the cues written for them, read back from the working
   * partial and matched span by span. The cues must write back to exactly these bytes, so the next
   * snapshot leaves every committed span as it is. Null when the partial is no longer exactly that.
   */
  transcribedCues(): { durationMs: number; parts: TranscribedPart[]; cues: TranscriptCue[] } | null {
    const working = this.cp.working
    if (working.coverage.kind !== 'transcribe' || !working.output) return null
    const now = readNow(working.path)
    if (now.state !== 'present' || !holds(now, working.output)) return null
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(now.bytes)
    } catch {
      return null
    }
    const back = parseCues(text)
    const written = back.ok ? back.cues : text.trim() === '' ? [] : null
    if (!written || checkTranscribeOutput(working.coverage, written) !== 'ok') return null
    const cues = written.map((c) => ({ start: c.startMs / 1000, end: c.endMs / 1000, text: c.text }))
    if (formatSrt(cues) !== text) return null
    return {
      durationMs: working.coverage.durationMs,
      parts: working.coverage.spans.map((s) => ({ startMs: s.startMs, endMs: s.endMs, cueCount: s.cueCount })),
      cues
    }
  }
}

export interface TranslateJournalInit {
  /** The generation's directory: `allocate`'s for a fresh run, the adopted one for Continue. */
  dir: string
  /** Continue: the adopted generation. A fresh run's is created at its first commit or failure. */
  generation: ResumeGeneration | null
  /** What a fresh generation is created with. */
  create: { jobKey: string; hint: JobHint; sources: SourceFingerprint[]; config: TranslateResumeConfig }
  /** The source cues as the frozen encoding reads them. */
  sourceCues: readonly Cue[]
  restored: RestoredRow[]
  firstContextSize: number | null
  /** A retry of the adopted generation's failed section, with the user's run-local choices (AR3-7). */
  retry?: { model: string; batchSize: number; useContext: boolean }
}

/**
 * `run.ts`'s journal over one Translate generation. A fresh run creates its generation only when it
 * first has something to keep — a committed batch, or a failed one to retry — so a run that ends with
 * nothing done leaves nothing to offer.
 */
class TranslateJournal implements TranslationJournal {
  private gen: ResumeGeneration | null
  readonly restored: readonly RestoredRow[]
  readonly firstContextSize: number | null
  readonly retry: TranslationRetry | null

  constructor(
    private readonly store: ResumeStore,
    private readonly init: TranslateJournalInit
  ) {
    this.gen = init.generation
    this.restored = init.restored
    this.firstContextSize = init.firstContextSize
    const span = this.coverage?.failedSpan ?? null
    if (init.retry && !span) throw new TypeError('A retry needs a recorded failed section.')
    this.retry =
      init.retry && span
        ? {
            fromCue: span.fromCue,
            toCue: span.toCue,
            size: init.retry.batchSize,
            context: !init.retry.useContext || span.context.kind === 'none'
              ? null
              : span.context.kind === 'firstContinue'
                ? { kind: 'firstContinue', fromCue: span.context.rows[0].index, toCue: span.context.rows[span.context.rows.length - 1].index }
                : { kind: 'previousSource' }
          }
        : null
  }

  private get dir(): string {
    return this.init.dir
  }

  private get coverage(): TranslateCoverage | null {
    const c = this.gen?.checkpoint.working.coverage
    return c && c.kind === 'translate' ? c : null
  }

  get complete(): boolean {
    const c = this.coverage
    return !!c && !!this.gen?.checkpoint.working.output && isCompleteCoverage(c)
  }

  get resumable(): boolean {
    const c = this.coverage
    const state = this.gen?.checkpoint.state
    return !!c && (state === 'committed' || state === 'pendingOutput') && (c.rows.length > 0 || c.failedSpan !== null)
  }

  partial(opts: Pick<PartialOutputOptions, 'io' | 'registerScratch' | 'releaseScratch'>): PartialOutput {
    const partialPath = path.join(this.dir, TRANSLATE_PARTIAL)
    const landed = !!this.gen?.checkpoint.working.output
    return new PartialOutput(path.join(this.dir, TRANSLATE_COMPLETE), { ...opts, fixedPath: partialPath, ...(landed ? { adopt: partialPath } : {}) })
  }

  private async ensure(): Promise<ResumeGeneration | null> {
    if (this.gen) return this.gen
    const { jobKey, hint, sources, config } = this.init.create
    this.gen = await this.store.createGeneration({
      kind: 'translate',
      jobKey,
      hint,
      sources,
      config,
      coverage: { kind: 'translate', sourceCueCount: this.init.sourceCues.length, rows: [], children: [], failedSpan: null },
      generationId: path.basename(this.dir)
    })
    return this.gen
  }

  async commit(partial: PartialOutput, text: string, through: number, preserved: readonly number[] = []): Promise<{ ok: true } | { ok: false; stage: string; message: string }> {
    const gen = await this.ensure()
    if (!gen) return { ok: false, stage: 'intent', message: 'the work could not be recorded for Continue' }
    const coverage = this.coverage
    let children = coverage?.children ?? []
    let failedSpan: FailedSpanRecord | null = null
    const retry = this.init.retry
    const span = coverage?.failedSpan ?? null
    if (retry && span && coverage) {
      // A retry piece: recorded with what it ran with, and the section's uncovered rest stays pending
      // with the failed parent's own defaults and pair, so a Stop here still offers exactly that rest.
      children = [...children, { fromCue: coverage.rows.length + 1, toCue: through, model: retry.model, batchSize: retry.batchSize, useContext: retry.useContext }]
      failedSpan = through < span.toCue ? { ...span, fromCue: through + 1 } : null
    }
    const sourceCues = this.init.sourceCues
    return gen.commit(partial, text, (written) => ({
      kind: 'translate',
      sourceCueCount: sourceCues.length,
      rows: translateRowsFor(sourceCues, written, through, new Set(preserved)),
      children,
      failedSpan
    }))
  }

  /**
   * Bundle H finishing on complete work: the same cues with new text, recorded as a revision (AR3-5
   * intent → file → record), never as another append-only commit, which the record refuses.
   */
  async revise(partial: PartialOutput, text: string, preserved: readonly number[] = []): Promise<{ ok: true } | { ok: false; stage: string; message: string }> {
    const gen = this.gen
    const before = this.coverage
    if (!gen || !before || !this.complete) return { ok: false, stage: 'readBack', message: 'only finished work can be revised' }
    const sourceCues = this.init.sourceCues
    const kept = new Set(preserved)
    return gen.commit(
      partial,
      text,
      (written) => {
        if (written.length !== sourceCues.length) return null
        const rows = translateRowsFor(sourceCues, written, sourceCues.length, kept)
        if (before.rows.some((r, i) => r.provenance !== rows[i].provenance || r.source !== rows[i].source || (r.provenance === 'preserved' && r.output !== rows[i].output))) return null
        return { kind: 'translate', sourceCueCount: sourceCues.length, rows, children: before.children, failedSpan: null }
      },
      { revision: true }
    )
  }

  async failed(span: { fromCue: number; toCue: number; cause: FailedSpanRecord['cause']; sent: SentContext }): Promise<{ ok: true } | { ok: false; message: string }> {
    const gen = await this.ensure()
    if (!gen) return { ok: false, message: 'the work could not be recorded for Continue' }
    const rows = this.coverage?.rows
    // A record behind the failed batch (an earlier commit did not land) is left as it is: ordinary
    // Continue redoes the work from where the record ends.
    if (!rows || span.fromCue !== rows.length + 1) return { ok: true }
    const pending = this.coverage?.failedSpan ?? null
    if (this.init.retry && pending) {
      // A retry piece failed: the rest of the original section from here, never the accepted pieces,
      // keeping the parent's model, size and pair as its defaults (AR3-7).
      return gen.recordFailedSpan({ ...pending, fromCue: span.fromCue, cause: span.cause })
    }
    // The context by digest, from the committed rows themselves, so it reconciles by construction. A
    // block's rows may be none (a first batch with Context ON): the retry still offers context.
    const ctxRows = span.sent.context ? span.sent.context.cues.map((c) => rows[c.index - 1]) : []
    const digests = () => ctxRows.map((r) => ({ index: r.index, source: r.source, output: r.output }))
    const context: FailedSpanRecord['context'] =
      span.sent.kind === 'previousSource'
        ? { kind: 'previousSource', rows: ctxRows.some((r) => !r || r.provenance !== 'accepted') ? [] : digests() }
        : span.sent.kind === 'none' || ctxRows.length === 0 || ctxRows.some((r) => !r)
          ? { kind: 'none', rows: [] }
          : { kind: span.sent.kind, rows: digests() }
    const config = this.init.create.config
    return gen.recordFailedSpan({
      fromCue: span.fromCue,
      toCue: span.toCue,
      cause: span.cause,
      parentModel: config.model,
      parentBatchSize: config.effectiveBatchSize,
      context
    })
  }

  async promote(partial: PartialOutput, isCurrent: () => boolean): Promise<PromoteResult> {
    if (!this.gen) return { ok: false, stage: 'replace', message: 'nothing was recorded' }
    return this.gen.promote(partial, isCurrent)
  }
}

export interface TranscribeJournalInit {
  /** The generation's directory: `allocate`'s for a fresh run, the adopted one for Continue. */
  dir: string
  /** Continue: the adopted generation. A fresh run's is created at its first commit. */
  generation: ResumeGeneration | null
  /** What a fresh generation is created with: the destination and what was there before it ran. */
  create: { jobKey: string; hint: JobHint; sources: SourceFingerprint[]; config: TranscribeResumeConfig; completion: { path: string; baseline: CompletionBaseline } }
  /** Continue: the adopted generation's `transcribedCues()`. */
  restored: { durationMs: number; parts: TranscribedPart[]; cues: TranscriptCue[] } | null
}

/** The span a committed part becomes, from the cues written for it. */
function spanOf(part: TranscribedPart, firstCue: number, written: readonly Cue[]): TranscribeSpan {
  const cues = written.slice(firstCue - 1, firstCue - 1 + part.cueCount)
  return { startMs: part.startMs, endMs: part.endMs, firstCue, cueCount: part.cueCount, sha256: transcribeSpanDigest(cues) }
}

/**
 * `transcribe.ts`'s journal over one Transcribe generation. The partial stays beside the destination
 * under the name `output.ts` claims; the record ties each committed part to the cues written for it,
 * and a part whose cues all had no text is recorded as an explicit no-cue gap.
 */
class TranscribeJournal implements TranscriptionJournal {
  private gen: ResumeGeneration | null
  readonly restored: TranscribeJournalInit['restored']

  constructor(
    private readonly store: ResumeStore,
    private readonly init: TranscribeJournalInit
  ) {
    this.gen = init.generation
    this.restored = init.restored
  }

  private get coverage(): TranscribeCoverage | null {
    const c = this.gen?.checkpoint.working.coverage
    return c && c.kind === 'transcribe' ? c : null
  }

  get complete(): boolean {
    const c = this.coverage
    return !!c && !!this.gen?.checkpoint.working.output && isCompleteCoverage(c)
  }

  get resumable(): boolean {
    const c = this.coverage
    const state = this.gen?.checkpoint.state
    return !!c && (state === 'committed' || state === 'pendingOutput') && c.spans.length > 0
  }

  partial(opts: Pick<PartialOutputOptions, 'io' | 'registerScratch' | 'releaseScratch'>): PartialOutput {
    const working = this.gen?.checkpoint.working
    const dest = this.init.create.completion.path
    return new PartialOutput(dest, { ...opts, ...(working?.output ? { adopt: working.path } : {}) })
  }

  private async ensure(durationMs: number): Promise<ResumeGeneration | null> {
    if (this.gen) return this.gen
    const { jobKey, hint, sources, config, completion } = this.init.create
    this.gen = await this.store.createGeneration({
      kind: 'transcribe',
      jobKey,
      hint,
      sources,
      config,
      coverage: { kind: 'transcribe', durationMs, spans: [] },
      completion,
      generationId: path.basename(this.init.dir)
    })
    return this.gen
  }

  async commit(
    partial: PartialOutput,
    text: string,
    coverage: { durationMs: number; parts: readonly TranscribedPart[] }
  ): Promise<{ ok: true } | { ok: false; stage: string; message: string }> {
    const gen = await this.ensure(coverage.durationMs)
    if (!gen) return { ok: false, stage: 'intent', message: 'the work could not be recorded for Continue' }
    const before = this.coverage
    return gen.commit(partial, text, (written) => {
      if (!before || before.durationMs !== coverage.durationMs || coverage.parts.length <= before.spans.length) return null
      if (coverage.parts.reduce((n, p) => n + p.cueCount, 0) !== written.length) return null
      const spans: TranscribeSpan[] = []
      let firstCue = 1
      for (const part of coverage.parts) {
        spans.push(spanOf(part, firstCue, written))
        firstCue += part.cueCount
      }
      // Committed spans never change: the new snapshot only adds after them.
      if (before.spans.some((s, i) => canonicalJson(s) !== canonicalJson(spans[i]))) return null
      return { kind: 'transcribe', durationMs: coverage.durationMs, spans }
    })
  }

  async revise(partial: PartialOutput, text: string): Promise<{ ok: true } | { ok: false; stage: string; message: string }> {
    const gen = this.gen
    const before = this.coverage
    if (!gen || !before || !this.complete) return { ok: false, stage: 'readBack', message: 'only finished work can be revised' }
    const committed = gen.transcribedCues()
    if (!committed) return { ok: false, stage: 'readBack', message: 'the saved subtitle no longer reads back as its parts' }
    return gen.commit(
      partial,
      text,
      (written) => {
        if (written.length !== committed.cues.length) return null
        if (written.some((c, i) => c.startMs !== Math.round(committed.cues[i].start * 1000) || c.endMs !== Math.round(committed.cues[i].end * 1000))) return null
        const spans = before.spans.map((s) => ({ ...s, sha256: transcribeSpanDigest(written.slice(s.firstCue - 1, s.firstCue - 1 + s.cueCount)) }))
        return { kind: 'transcribe', durationMs: before.durationMs, spans }
      },
      { revision: true }
    )
  }

  async promote(partial: PartialOutput, isCurrent: () => boolean): Promise<PromoteResult> {
    if (!this.gen) return { ok: false, stage: 'replace', message: 'nothing was recorded' }
    return this.gen.promote(partial, isCurrent)
  }

  async release(): Promise<{ ok: true; verify: () => string | null } | { ok: false; message: string }> {
    const target = this.gen?.checkpoint ?? { kind: 'transcribe' as const, completion: this.init.create.completion }
    const verify = () => completionRefusal(target)
    const changed = verify()
    if (changed !== null) return { ok: false, message: changed }
    if (this.gen) {
      const ended = await this.gen.tombstone()
      if (!ended.ok) return { ok: false, message: `the saved work could not be closed: ${ended.message}` }
    }
    return { ok: true, verify }
  }
}

let shared: ResumeStore | null = null

/** The app's one store, rooted in its own profile. */
export function resumeStore(): ResumeStore {
  return (shared ??= new ResumeStore({ root: defaultResumeRoot() }))
}
