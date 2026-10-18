/**
 * What a native run has done: the in-memory transcription record (implementation_plan.md Step 1.4)
 * and the durable resume checkpoint's schema (Step 3.3, AR3-5). AUTHORED-BY: opus-5.5-high
 *
 * ⚠ Nothing here is ever written as `.progress` or `.progress.log` (BR-13): those names belong to the
 * shipping engine's resume file and to the user-requested progress log, and a third thing under either
 * name is how two owners end up writing one file. The checkpoint is `checkpoint.json` in the app's own
 * `resume-v1/<generation>/` directory, written only by `main/resumeStore.ts`. A partial on disk is never
 * resume state by itself (§4.1a rule 7): only a checkpoint whose receipts and coverage it matches is.
 *
 * The transcription record admits chunks strictly in order. A chunk that arrives out of order, or
 * overlaps what is already committed, is a programming error and throws — silently accepting it is how
 * cues end up shifted by a chunk's length.
 */
import crypto from 'crypto'
import path from 'path'
import type { RunErrorKind, RunKind } from '../shared/engineEvents'
import { DEFAULT_BATCH_CONTEXT_LINES, MAX_BATCH_CONTEXT_LINES, MIN_BATCH_CONTEXT_LINES, type TranscribeArgs, type TranslateArgs } from '../shared/types'
import { isDedicatedTranscribeModel } from '../shared/transcribeSettings'
import { writtenCueText, type Cue } from './srt'
import { LEGACY_ENCODINGS, type SubtitleEncoding } from './subtitleInput'

const SUBTITLE_ENCODINGS: readonly SubtitleEncoding[] = ['utf-8', 'utf-8-bom', 'utf-16le-bom', 'utf-16be-bom', ...LEGACY_ENCODINGS]

/** One cue in seconds. Relative to its chunk when it comes from the model; absolute once committed. */
export interface TranscriptCue {
  start: number
  end: number
  text: string
}

export interface CommittedChunk {
  index: number
  startSeconds: number
  endSeconds: number
  cueCount: number
}

export const PROGRESS_RECORD_VERSION = 1

export class TranscriptionProgress {
  readonly version = PROGRESS_RECORD_VERSION
  private readonly chunks: CommittedChunk[] = []
  private readonly committedCues: TranscriptCue[] = []

  constructor(readonly durationSeconds: number) {}

  get committedChunks(): readonly CommittedChunk[] {
    return this.chunks
  }

  get cues(): readonly TranscriptCue[] {
    return this.committedCues
  }

  /** Audio time covered by committed chunks; the next chunk must start exactly here. */
  get committedThroughSeconds(): number {
    return this.chunks.length ? this.chunks[this.chunks.length - 1].endSeconds : 0
  }

  get complete(): boolean {
    return this.committedThroughSeconds >= this.durationSeconds
  }

  /**
   * Continue (Phase 3): the parts a verified checkpoint holds and the cues written for them, before any
   * new part commits. Each part must start where the one before it ended, from zero.
   */
  restore(chunks: readonly CommittedChunk[], cues: readonly TranscriptCue[]): void {
    if (this.chunks.length || this.committedCues.length) throw new Error('Only an empty transcript can be restored.')
    let through = 0
    chunks.forEach((c, i) => {
      if (c.index !== i + 1 || c.startSeconds !== through || !(c.endSeconds > c.startSeconds)) {
        throw new Error(`Saved part ${c.index} spans ${c.startSeconds}–${c.endSeconds}s; expected part ${i + 1} to start at ${through}s.`)
      }
      through = c.endSeconds
    })
    this.chunks.push(...chunks)
    this.committedCues.push(...cues)
  }

  /**
   * Commit one chunk's cues, offset by the chunk's start as gst did (`main.py:1878-1879`).
   * Returns how many cues it added.
   */
  commit(chunk: { index: number; startSeconds: number; endSeconds: number }, relative: readonly TranscriptCue[]): number {
    const expectedIndex = this.chunks.length + 1
    if (chunk.index !== expectedIndex) {
      throw new Error(`Chunk ${chunk.index} committed out of order; expected ${expectedIndex}.`)
    }
    if (chunk.startSeconds !== this.committedThroughSeconds || !(chunk.endSeconds > chunk.startSeconds)) {
      throw new Error(
        `Chunk ${chunk.index} spans ${chunk.startSeconds}–${chunk.endSeconds}s; expected it to start at ${this.committedThroughSeconds}s.`
      )
    }
    for (const cue of relative) {
      this.committedCues.push({ start: cue.start + chunk.startSeconds, end: cue.end + chunk.startSeconds, text: cue.text })
    }
    this.chunks.push({ index: chunk.index, startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds, cueCount: relative.length })
    return relative.length
  }
}

// ── The resume checkpoint, `srt-ai-resume/v1` (AR3-5, AR3-8) ────────────────────────────────────

export const RESUME_SCHEMA = 'srt-ai-resume/v1'
export const RESUME_CONFIG_SCHEMA = 'resume-config/v1'
/** The request shape native builds today; a run recorded under another cannot continue here. */
export const NATIVE_REQUEST_CONTRACT = 'native-request/v1'
/**
 * `prompt.ts`'s translation instruction and request turns. v2 (Round 15): Context ON sends the D15-3R
 * previous-source block. v3 (2026-10-18): a System Prompt Override is added after the built-in rules
 * instead of replacing two of them. A record under any other contract, v1 included, cannot continue
 * here (PR-5: only pre-Round-15 test builds wrote v1).
 */
export const TRANSLATION_PROMPT_CONTRACT = 'translate-prompt/v3'
/** A v2 record continues only with a blank override: its instruction is then byte-identical under v3. */
export const TRANSLATION_PROMPT_CONTRACT_V2 = 'translate-prompt/v2'
/** `prompt.ts`'s transcription instruction as built since Step 1.5. */
export const TRANSCRIPTION_PROMPT_CONTRACT = 'transcribe-prompt/v1'

/** Decoder bounds (AR3-5). Crossing one is `checkpointCorrupt`: nothing is truncated or half-read. */
export const CHECKPOINT_MAX_BYTES = 32 * 1024 * 1024
export const CHECKPOINT_MAX_SOURCES = 16
export const CHECKPOINT_MAX_ROWS = 1_000_000

const HEX64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isSha256(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v)
}

export function isCanonicalUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v)
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex')
}

/**
 * Canonical JSON: object keys sorted lexicographically at every depth, arrays in their order, and
 * `undefined` or a non-finite number refused rather than dropped or turned into `null`.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown, at: string): unknown => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new TypeError(`${at} is not a finite number.`)
      return v
    }
    if (v === undefined) throw new TypeError(`${at} is undefined.`)
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`))
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as object).sort()) out[k] = walk((v as Record<string, unknown>)[k], `${at}.${k}`)
      return out
    }
    throw new TypeError(`${at} cannot be written as JSON.`)
  }
  return JSON.stringify(walk(value, '$'))
}

/** SHA-256 of the canonical JSON's UTF-8 bytes. */
export function canonicalDigest(value: unknown): string {
  return sha256Text(canonicalJson(value))
}

export type CheckpointState = 'committed' | 'pendingOutput' | 'pendingPromotion' | 'completed' | 'tombstoned'

export type SourceRole = 'subtitleFile' | 'extractedSubtitle' | 'container' | 'audio' | 'media'

/** One input that can change the output: streamed SHA-256 and length; the path is a hint only. */
export interface SourceFingerprint {
  role: SourceRole
  path: string
  byteLength: number
  sha256: string
  /** The selected stream, for the container an extracted track came from. */
  streamIndex?: number
}

export interface FileReceipt {
  byteLength: number
  sha256: string
}

/** The working output as written: its bytes and how many cues parse out of them. */
export interface OutputReceipt extends FileReceipt {
  cueCount: number
}

/** One translated cue through the pointer: its source and its accepted text, by digest. */
export interface TranslateRow {
  index: number
  source: string
  output: string
  /** Phase 3 produces only `accepted`; `preserved` is Bundle G's (AR3-5). */
  provenance: 'accepted' | 'preserved'
}

/** What a user-requested retry piece ran with (AR3-7). */
export interface RetryChildRecord {
  fromCue: number
  toCue: number
  model: string
  batchSize: number
  useContext: boolean
}

/**
 * The context the failed request carried, text-free: which cues, by digest. Rebuilt into prompt text
 * only from the verified source and partial (AR3-5). `previousSource` is a Context-ON request's block
 * (D15-3R): ascending accepted cues, possibly none. `firstContinue` is a pinned pair: ascending
 * accepted cues whose only gaps are preserved ones (PR-3).
 */
export type ContextDescriptor =
  | { kind: 'none'; rows: [] }
  | { kind: 'previousSource' | 'firstContinue'; rows: Array<Omit<TranslateRow, 'provenance'>> }

export interface FailedSpanRecord {
  fromCue: number
  toCue: number
  cause: RunErrorKind
  parentModel: string
  parentBatchSize: number
  context: ContextDescriptor
}

export interface TranslateCoverage {
  kind: 'translate'
  sourceCueCount: number
  rows: TranslateRow[]
  children: RetryChildRecord[]
  failedSpan: FailedSpanRecord | null
}

/** One committed stretch of media time; `cueCount` 0 is an explicit no-cue gap. */
export interface TranscribeSpan {
  startMs: number
  endMs: number
  /** One-based number of the span's first cue in the output; the next cue's number when it has none. */
  firstCue: number
  cueCount: number
  sha256: string
}

export interface TranscribeCoverage {
  kind: 'transcribe'
  durationMs: number
  spans: TranscribeSpan[]
}

export type Coverage = TranslateCoverage | TranscribeCoverage

export type CompletionBaseline = { state: 'absent' } | ({ state: 'existing' } & FileReceipt)

export interface CompletionTarget {
  path: string
  baseline: CompletionBaseline
}

export interface WorkingOutput {
  path: string
  /** Null until the first commit writes the partial. */
  output: OutputReceipt | null
  coverage: Coverage
}

export type PendingRecord =
  /** `revision`: finished Transcribe work rewritten in place — the same parts, cue count and times, new text. */
  | { kind: 'output'; scratch: string; output: OutputReceipt; coverage: Coverage; revision?: true }
  | { kind: 'promotion'; completion: FileReceipt }

/** A translation run's frozen behaviour (`resume-config/v1`). No key, quota or display setting. */
export interface TranslateResumeConfig {
  schema: typeof RESUME_CONFIG_SCHEMA
  kind: 'translate'
  requestContract: string
  promptContract: string
  provider: string
  model: string
  sourceLang: string
  /** How the verified subtitle bytes were decoded (Bundle A's receipt); the same bytes read another way are other cues. */
  sourceEncoding: SubtitleEncoding
  targetLang: string
  inputKind: 'subtitleFile' | 'extractedTrack'
  streamIndex: number | null
  audio: boolean
  thinkingLevel: string
  thinkingBudget: number
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
  serviceTier: string
  paidQuota: boolean
  disableStreaming: boolean
  batchSize: number
  effectiveBatchSize: number
  batchContext: boolean
  /** Previous Context Cues as the run sent it. Absent only in a record written before Round 15. */
  batchContextLines?: number
  resumeContextSize: number
  description: string
  systemPrompt: string
  effectiveDescription: string
  ffmpeg: FfmpegFingerprint | null
}

export interface TranscribeResumeConfig {
  schema: typeof RESUME_CONFIG_SCHEMA
  kind: 'transcribe'
  requestContract: string
  promptContract: string
  provider: string
  model: string
  targetLang: string
  thinkingLevel: string
  thinkingBudget: number
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
  serviceTier: string
  chunkSeconds: number
  description: string
  ffmpeg: FfmpegFingerprint | null
  /** The dedicated model only: the one language confirmed at Start. Absent from a general model's record. */
  sourceLanguage?: string
  /** The dedicated model only: the wording polish as it ran — its model and thinking — or null when it was off. */
  polish?: { model: string; thinkingLevel: string; thinkingBudget: number } | null
}

export type ResumeConfig = TranslateResumeConfig | TranscribeResumeConfig

/** The FFmpeg that cuts later work: where it is, its bytes and what it says it is. */
export interface FfmpegFingerprint {
  path: string
  sha256: string
  version: string
}

export interface Checkpoint {
  schema: typeof RESUME_SCHEMA
  generationId: string
  /** Minted with the generation; the working file is this generation's only while it matches. */
  ownerToken: string
  kind: RunKind
  state: CheckpointState
  createdAtEpochMs: number
  updatedAtEpochMs: number
  jobKey: string
  sources: SourceFingerprint[]
  config: ResumeConfig
  configDigest: string
  working: WorkingOutput
  completion: CompletionTarget
  pending: PendingRecord | null
}

export type DecodedCheckpoint =
  | { ok: true; checkpoint: Checkpoint }
  | { ok: false; reason: 'checkpointCorrupt' | 'checkpointVersion'; detail: string }

/** Thrown inside the decoder; never escapes it. */
class Refusal extends Error {}

const RUN_ERROR_KINDS: readonly RunErrorKind[] = [
  'blocked',
  'auth',
  'forbidden',
  'unsupportedLocation',
  'invalidRequest',
  'quota',
  'rateLimit',
  'overload',
  'network',
  'timeout',
  'responseTooLarge',
  'inputLimit',
  'malformed',
  'countMismatch',
  'refusedByApp',
  'unknown'
]

function refuse(detail: string): never {
  throw new Refusal(detail)
}

/** An object with exactly these keys: every required one, any of the optional ones, nothing else. */
function exact(v: unknown, at: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) refuse(`${at} is not an object.`)
  const o = v as Record<string, unknown>
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) refuse(`${at} has an unknown field "${k}".`)
  }
  for (const k of required) if (!(k in o)) refuse(`${at} lacks "${k}".`)
  return o
}

function contextLines(v: unknown, at: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < MIN_BATCH_CONTEXT_LINES || (v as number) > MAX_BATCH_CONTEXT_LINES) {
    refuse(`${at} is not a whole number from ${MIN_BATCH_CONTEXT_LINES} to ${MAX_BATCH_CONTEXT_LINES}.`)
  }
  return v as number
}

function count(v: unknown, at: string, min = 0): number {
  if (!Number.isSafeInteger(v) || (v as number) < min) refuse(`${at} is not a whole number from ${min}.`)
  return v as number
}

function str(v: unknown, at: string, nonEmpty = false): string {
  if (typeof v !== 'string' || (nonEmpty && v === '')) refuse(`${at} is not ${nonEmpty ? 'a non-empty' : 'a'} string.`)
  return v
}

function bool(v: unknown, at: string): boolean {
  if (typeof v !== 'boolean') refuse(`${at} is not true or false.`)
  return v
}

function finite(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) refuse(`${at} is not a finite number.`)
  return v
}

function digest(v: unknown, at: string): string {
  if (!isSha256(v)) refuse(`${at} is not a SHA-256.`)
  return v
}

function list(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) refuse(`${at} is not a list.`)
  return v
}

function oneOf<T extends string>(v: unknown, at: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T)) refuse(`${at} is not one of ${values.join(', ')}.`)
  return v as T
}

function decodeReceipt(v: unknown, at: string): FileReceipt {
  const o = exact(v, at, ['byteLength', 'sha256'])
  return { byteLength: count(o.byteLength, `${at}.byteLength`), sha256: digest(o.sha256, `${at}.sha256`) }
}

function decodeOutput(v: unknown, at: string): OutputReceipt {
  const o = exact(v, at, ['byteLength', 'sha256', 'cueCount'])
  return { byteLength: count(o.byteLength, `${at}.byteLength`), sha256: digest(o.sha256, `${at}.sha256`), cueCount: count(o.cueCount, `${at}.cueCount`) }
}

function decodeFfmpeg(v: unknown, at: string): FfmpegFingerprint | null {
  if (v === null) return null
  const o = exact(v, at, ['path', 'sha256', 'version'])
  return { path: str(o.path, `${at}.path`, true), sha256: digest(o.sha256, `${at}.sha256`), version: str(o.version, `${at}.version`) }
}

const TRANSLATE_CONFIG_KEYS = [
  'schema',
  'kind',
  'requestContract',
  'promptContract',
  'provider',
  'model',
  'sourceLang',
  'sourceEncoding',
  'targetLang',
  'inputKind',
  'streamIndex',
  'audio',
  'thinkingLevel',
  'thinkingBudget',
  'customGenerationParams',
  'temperature',
  'topP',
  'topK',
  'serviceTier',
  'paidQuota',
  'disableStreaming',
  'batchSize',
  'effectiveBatchSize',
  'batchContext',
  'resumeContextSize',
  'description',
  'systemPrompt',
  'effectiveDescription',
  'ffmpeg'
] as const
/** Written by every Round-15 record; absent from records written before it. */
const TRANSLATE_CONFIG_OPTIONAL_KEYS = ['batchContextLines'] as const

const TRANSCRIBE_CONFIG_KEYS = [
  'schema',
  'kind',
  'requestContract',
  'promptContract',
  'provider',
  'model',
  'targetLang',
  'thinkingLevel',
  'thinkingBudget',
  'customGenerationParams',
  'temperature',
  'topP',
  'topK',
  'serviceTier',
  'chunkSeconds',
  'description',
  'ffmpeg'
] as const
/** Written by a dedicated model's record only; a general model's record is unchanged. */
const TRANSCRIBE_CONFIG_OPTIONAL_KEYS = ['sourceLanguage', 'polish'] as const

function decodePolish(v: unknown, at: string): { model: string; thinkingLevel: string; thinkingBudget: number } | null {
  if (v === null) return null
  const o = exact(v, at, ['model', 'thinkingLevel', 'thinkingBudget'])
  return { model: str(o.model, `${at}.model`, true), thinkingLevel: str(o.thinkingLevel, `${at}.thinkingLevel`), thinkingBudget: finite(o.thinkingBudget, `${at}.thinkingBudget`) }
}

function decodeConfig(v: unknown, kind: RunKind): ResumeConfig {
  const at = 'config'
  if (kind === 'translate') {
    const o = exact(v, at, TRANSLATE_CONFIG_KEYS, TRANSLATE_CONFIG_OPTIONAL_KEYS)
    if (o.schema !== RESUME_CONFIG_SCHEMA) refuse(`${at}.schema is not ${RESUME_CONFIG_SCHEMA}.`)
    if (o.kind !== 'translate') refuse(`${at}.kind is not this run's kind.`)
    const inputKind = oneOf(o.inputKind, `${at}.inputKind`, ['subtitleFile', 'extractedTrack'] as const)
    const streamIndex = o.streamIndex === null ? null : count(o.streamIndex, `${at}.streamIndex`)
    if ((inputKind === 'extractedTrack') !== (streamIndex !== null)) refuse(`${at}.streamIndex does not match its input kind.`)
    const batchSize = count(o.batchSize, `${at}.batchSize`, 1)
    const effectiveBatchSize = count(o.effectiveBatchSize, `${at}.effectiveBatchSize`, 1)
    if (effectiveBatchSize > batchSize) refuse(`${at}.effectiveBatchSize is larger than the requested size.`)
    return {
      schema: RESUME_CONFIG_SCHEMA,
      kind: 'translate',
      requestContract: str(o.requestContract, `${at}.requestContract`, true),
      promptContract: str(o.promptContract, `${at}.promptContract`, true),
      provider: str(o.provider, `${at}.provider`, true),
      model: str(o.model, `${at}.model`, true),
      sourceLang: str(o.sourceLang, `${at}.sourceLang`),
      sourceEncoding: oneOf(o.sourceEncoding, `${at}.sourceEncoding`, SUBTITLE_ENCODINGS),
      targetLang: str(o.targetLang, `${at}.targetLang`, true),
      inputKind,
      streamIndex,
      audio: bool(o.audio, `${at}.audio`),
      thinkingLevel: str(o.thinkingLevel, `${at}.thinkingLevel`),
      thinkingBudget: finite(o.thinkingBudget, `${at}.thinkingBudget`),
      customGenerationParams: bool(o.customGenerationParams, `${at}.customGenerationParams`),
      temperature: finite(o.temperature, `${at}.temperature`),
      topP: finite(o.topP, `${at}.topP`),
      topK: o.topK === null ? null : finite(o.topK, `${at}.topK`),
      serviceTier: str(o.serviceTier, `${at}.serviceTier`),
      paidQuota: bool(o.paidQuota, `${at}.paidQuota`),
      disableStreaming: bool(o.disableStreaming, `${at}.disableStreaming`),
      batchSize,
      effectiveBatchSize,
      batchContext: bool(o.batchContext, `${at}.batchContext`),
      ...('batchContextLines' in o ? { batchContextLines: contextLines(o.batchContextLines, `${at}.batchContextLines`) } : {}),
      resumeContextSize: count(o.resumeContextSize, `${at}.resumeContextSize`),
      description: str(o.description, `${at}.description`),
      systemPrompt: str(o.systemPrompt, `${at}.systemPrompt`),
      effectiveDescription: str(o.effectiveDescription, `${at}.effectiveDescription`),
      ffmpeg: decodeFfmpeg(o.ffmpeg, `${at}.ffmpeg`)
    }
  }
  const o = exact(v, at, TRANSCRIBE_CONFIG_KEYS, TRANSCRIBE_CONFIG_OPTIONAL_KEYS)
  if (o.schema !== RESUME_CONFIG_SCHEMA) refuse(`${at}.schema is not ${RESUME_CONFIG_SCHEMA}.`)
  if (o.kind !== 'transcribe') refuse(`${at}.kind is not this run's kind.`)
  const chunkSeconds = finite(o.chunkSeconds, `${at}.chunkSeconds`)
  if (!(chunkSeconds > 0)) refuse(`${at}.chunkSeconds is not positive.`)
  const sourceLanguage = 'sourceLanguage' in o ? str(o.sourceLanguage, `${at}.sourceLanguage`, true) : undefined
  if (sourceLanguage !== undefined && !/^[a-z]{2,3}$/.test(sourceLanguage)) refuse(`${at}.sourceLanguage is not one bare language code.`)
  return {
    schema: RESUME_CONFIG_SCHEMA,
    kind: 'transcribe',
    requestContract: str(o.requestContract, `${at}.requestContract`, true),
    promptContract: str(o.promptContract, `${at}.promptContract`, true),
    provider: str(o.provider, `${at}.provider`, true),
    model: str(o.model, `${at}.model`, true),
    targetLang: str(o.targetLang, `${at}.targetLang`),
    thinkingLevel: str(o.thinkingLevel, `${at}.thinkingLevel`),
    thinkingBudget: finite(o.thinkingBudget, `${at}.thinkingBudget`),
    customGenerationParams: bool(o.customGenerationParams, `${at}.customGenerationParams`),
    temperature: finite(o.temperature, `${at}.temperature`),
    topP: finite(o.topP, `${at}.topP`),
    topK: o.topK === null ? null : finite(o.topK, `${at}.topK`),
    serviceTier: str(o.serviceTier, `${at}.serviceTier`),
    chunkSeconds,
    description: str(o.description, `${at}.description`),
    ffmpeg: decodeFfmpeg(o.ffmpeg, `${at}.ffmpeg`),
    ...(sourceLanguage !== undefined ? { sourceLanguage } : {}),
    ...('polish' in o ? { polish: decodePolish(o.polish, `${at}.polish`) } : {})
  }
}

const SOURCE_ROLES: readonly SourceRole[] = ['subtitleFile', 'extractedSubtitle', 'container', 'audio', 'media']

/** The roles a job kind's sources may take, and which of them it must have. */
function checkSourceRoles(kind: RunKind, config: ResumeConfig, sources: readonly SourceFingerprint[]): void {
  const roles = sources.map((s) => s.role)
  const need: SourceRole[] =
    kind === 'transcribe'
      ? ['media']
      : (config as TranslateResumeConfig).inputKind === 'extractedTrack'
        ? ['container', 'extractedSubtitle']
        : ['subtitleFile']
  if (kind === 'translate' && (config as TranslateResumeConfig).audio) need.push('audio')
  if (roles.length !== need.length || need.some((r) => !roles.includes(r))) refuse('sources do not match the run kind and inputs.')
  for (const s of sources) {
    if ((s.role === 'container') !== (s.streamIndex !== undefined)) refuse(`sources: only the container names a stream.`)
    if (s.role === 'container' && s.streamIndex !== (config as TranslateResumeConfig).streamIndex) refuse('sources: the container stream differs from the run configuration.')
  }
}

function decodeSources(v: unknown, max: number): SourceFingerprint[] {
  const items = list(v, 'sources')
  if (items.length === 0 || items.length > max) refuse(`sources holds ${items.length} entries; 1 to ${max} are allowed.`)
  const seen = new Set<string>()
  return items.map((item, i) => {
    const at = `sources[${i}]`
    const o = exact(item, at, ['role', 'path', 'byteLength', 'sha256'], ['streamIndex'])
    const role = oneOf(o.role, `${at}.role`, SOURCE_ROLES)
    if (seen.has(role)) refuse(`${at} repeats the role "${role}".`)
    seen.add(role)
    return {
      role,
      path: str(o.path, `${at}.path`, true),
      byteLength: count(o.byteLength, `${at}.byteLength`),
      sha256: digest(o.sha256, `${at}.sha256`),
      ...(o.streamIndex !== undefined ? { streamIndex: count(o.streamIndex, `${at}.streamIndex`) } : {})
    }
  })
}

interface RowBudget {
  used: number
  max: number
}

function spend(budget: RowBudget, n: number): void {
  budget.used += n
  if (budget.used > budget.max) refuse(`the record holds more than ${budget.max} rows.`)
}

function decodeTranslateCoverage(v: unknown, at: string, budget: RowBudget): TranslateCoverage {
  const o = exact(v, at, ['kind', 'sourceCueCount', 'rows', 'children', 'failedSpan'])
  if (o.kind !== 'translate') refuse(`${at}.kind is not translate.`)
  const sourceCueCount = count(o.sourceCueCount, `${at}.sourceCueCount`, 1)
  const rawRows = list(o.rows, `${at}.rows`)
  spend(budget, rawRows.length)
  if (rawRows.length > sourceCueCount) refuse(`${at} covers more cues than the source has.`)
  const rows = rawRows.map((r, i): TranslateRow => {
    const ra = `${at}.rows[${i}]`
    const ro = exact(r, ra, ['index', 'source', 'output', 'provenance'])
    // One record per cue, in order from the first, with no gap, duplicate or overlap.
    if (ro.index !== i + 1) refuse(`${ra} is cue ${String(ro.index)}; expected ${i + 1}.`)
    return { index: i + 1, source: digest(ro.source, `${ra}.source`), output: digest(ro.output, `${ra}.output`), provenance: oneOf(ro.provenance, `${ra}.provenance`, ['accepted', 'preserved'] as const) }
  })
  const rawChildren = list(o.children, `${at}.children`)
  spend(budget, rawChildren.length)
  let after = 0
  const children = rawChildren.map((c, i): RetryChildRecord => {
    const ca = `${at}.children[${i}]`
    const co = exact(c, ca, ['fromCue', 'toCue', 'model', 'batchSize', 'useContext'])
    const fromCue = count(co.fromCue, `${ca}.fromCue`, 1)
    const toCue = count(co.toCue, `${ca}.toCue`, 1)
    if (fromCue <= after || toCue < fromCue || toCue > rows.length) refuse(`${ca} is not an ordered retry piece inside the covered cues.`)
    after = toCue
    return { fromCue, toCue, model: str(co.model, `${ca}.model`, true), batchSize: count(co.batchSize, `${ca}.batchSize`, 1), useContext: bool(co.useContext, `${ca}.useContext`) }
  })
  let failedSpan: FailedSpanRecord | null = null
  if (o.failedSpan !== null) {
    const fa = `${at}.failedSpan`
    const fo = exact(o.failedSpan, fa, ['fromCue', 'toCue', 'cause', 'parentModel', 'parentBatchSize', 'context'])
    const fromCue = count(fo.fromCue, `${fa}.fromCue`, 1)
    const toCue = count(fo.toCue, `${fa}.toCue`, 1)
    // The failed span starts exactly where coverage ends, so it can never overlap accepted work.
    if (fromCue !== rows.length + 1 || toCue < fromCue || toCue > sourceCueCount) refuse(`${fa} is not the cues right after the covered ones.`)
    const ctx = exact(fo.context, `${fa}.context`, ['kind', 'rows'])
    const kind = oneOf(ctx.kind, `${fa}.context.kind`, ['none', 'previousSource', 'firstContinue'] as const)
    const rawCtx = list(ctx.rows, `${fa}.context.rows`)
    spend(budget, rawCtx.length)
    if (kind !== 'previousSource' && (kind === 'none') !== (rawCtx.length === 0)) refuse(`${fa}.context rows do not match its kind.`)
    const ctxRows = rawCtx.map((r, i) => {
      const ra = `${fa}.context.rows[${i}]`
      const ro = exact(r, ra, ['index', 'source', 'output'])
      const index = count(ro.index, `${ra}.index`, 1)
      const row = { index, source: digest(ro.source, `${ra}.source`), output: digest(ro.output, `${ra}.output`) }
      // It must reconcile with committed provenance: an accepted cue, by the same digests.
      const committed = rows[index - 1]
      if (!committed || committed.provenance !== 'accepted' || committed.source !== row.source || committed.output !== row.output) refuse(`${ra} does not match an accepted cue.`)
      return row
    })
    for (let i = 1; i < ctxRows.length; i++) {
      const prev = ctxRows[i - 1].index
      const at = ctxRows[i].index
      if (at <= prev) refuse(`${fa}.context is not in ascending order.`)
      // A pinned pair skips only cues kept in their source language (PR-3); a gap over an accepted cue is refused.
      if (kind === 'firstContinue' && rows.slice(prev, at - 1).some((r) => r.provenance !== 'preserved')) refuse(`${fa}.context is not contiguous.`)
    }
    failedSpan = {
      fromCue,
      toCue,
      cause: oneOf(fo.cause, `${fa}.cause`, RUN_ERROR_KINDS),
      parentModel: str(fo.parentModel, `${fa}.parentModel`, true),
      parentBatchSize: count(fo.parentBatchSize, `${fa}.parentBatchSize`, 1),
      context: kind === 'none' ? { kind: 'none', rows: [] } : { kind, rows: ctxRows }
    }
  }
  return { kind: 'translate', sourceCueCount, rows, children, failedSpan }
}

function decodeTranscribeCoverage(v: unknown, at: string, budget: RowBudget): TranscribeCoverage {
  const o = exact(v, at, ['kind', 'durationMs', 'spans'])
  if (o.kind !== 'transcribe') refuse(`${at}.kind is not transcribe.`)
  const durationMs = count(o.durationMs, `${at}.durationMs`, 1)
  const raw = list(o.spans, `${at}.spans`)
  spend(budget, raw.length)
  let through = 0
  let nextCue = 1
  const spans = raw.map((s, i): TranscribeSpan => {
    const sa = `${at}.spans[${i}]`
    const so = exact(s, sa, ['startMs', 'endMs', 'firstCue', 'cueCount', 'sha256'])
    const startMs = count(so.startMs, `${sa}.startMs`)
    const endMs = count(so.endMs, `${sa}.endMs`)
    const firstCue = count(so.firstCue, `${sa}.firstCue`, 1)
    const cueCount = count(so.cueCount, `${sa}.cueCount`)
    // Contiguous from zero: no gap, no overlap, no duplicate; a quiet stretch is an explicit span.
    if (startMs !== through || endMs <= startMs || endMs > durationMs) refuse(`${sa} is not the media time right after the covered span.`)
    if (firstCue !== nextCue) refuse(`${sa} does not start at the next cue.`)
    through = endMs
    nextCue += cueCount
    return { startMs, endMs, firstCue, cueCount, sha256: digest(so.sha256, `${sa}.sha256`) }
  })
  return { kind: 'transcribe', durationMs, spans }
}

function decodeCoverage(v: unknown, at: string, kind: RunKind, budget: RowBudget): Coverage {
  return kind === 'translate' ? decodeTranslateCoverage(v, at, budget) : decodeTranscribeCoverage(v, at, budget)
}

/** Cues a coverage record says the working output holds. */
export function coveredCueCount(coverage: Coverage): number {
  return coverage.kind === 'translate' ? coverage.sourceCueCount : coverage.spans.reduce((n, s) => n + s.cueCount, 0)
}

function decodeWorkingOutput(v: unknown, kind: RunKind, budget: RowBudget): WorkingOutput {
  const o = exact(v, 'working', ['path', 'output', 'coverage'])
  const coverage = decodeCoverage(o.coverage, 'working.coverage', kind, budget)
  const output = o.output === null ? null : decodeOutput(o.output, 'working.output')
  if (output && output.cueCount !== coveredCueCount(coverage)) refuse('working.output does not hold the cues its coverage names.')
  if (!output && (coverage.kind === 'translate' ? coverage.rows.length > 0 : coverage.spans.length > 0)) refuse('working coverage names work with no output.')
  return { path: str(o.path, 'working.path', true), output, coverage }
}

function decodePending(v: unknown, kind: RunKind, state: CheckpointState, budget: RowBudget): PendingRecord | null {
  if (state !== 'pendingOutput' && state !== 'pendingPromotion') {
    if (v !== null) refuse(`a ${state} record has pending work.`)
    return null
  }
  const head = exact(v, 'pending', ['kind'], ['scratch', 'output', 'coverage', 'completion', 'revision'])
  if (state === 'pendingOutput') {
    if (head.kind !== 'output') refuse('pendingOutput does not hold an output intent.')
    const o = exact(v, 'pending', ['kind', 'scratch', 'output', 'coverage'], ['revision'])
    if ('revision' in o && o.revision !== true) refuse('pending.revision is not true.')
    const coverage = decodeCoverage(o.coverage, 'pending.coverage', kind, budget)
    const output = decodeOutput(o.output, 'pending.output')
    if (output.cueCount !== coveredCueCount(coverage)) refuse('pending.output does not hold the cues its coverage names.')
    return { kind: 'output', scratch: str(o.scratch, 'pending.scratch', true), output, coverage, ...('revision' in o ? { revision: true as const } : {}) }
  }
  if (head.kind !== 'promotion') refuse('pendingPromotion does not hold a promotion intent.')
  const o = exact(v, 'pending', ['kind', 'completion'])
  return { kind: 'promotion', completion: decodeReceipt(o.completion, 'pending.completion') }
}

function decodeCompletion(v: unknown): CompletionTarget {
  const o = exact(v, 'completion', ['path', 'baseline'])
  const b = exact(o.baseline, 'completion.baseline', ['state'], ['byteLength', 'sha256'])
  let baseline: CompletionBaseline
  if (b.state === 'absent') {
    exact(o.baseline, 'completion.baseline', ['state'])
    baseline = { state: 'absent' }
  } else if (b.state === 'existing') {
    const e = exact(o.baseline, 'completion.baseline', ['state', 'byteLength', 'sha256'])
    baseline = { state: 'existing', byteLength: count(e.byteLength, 'completion.baseline.byteLength'), sha256: digest(e.sha256, 'completion.baseline.sha256') }
  } else {
    refuse('completion.baseline.state is neither absent nor existing.')
  }
  return { path: str(o.path, 'completion.path', true), baseline }
}

/**
 * Decode checkpoint text exactly (AR3-5): a version this build does not know is `checkpointVersion`;
 * anything else wrong — bad JSON, an unknown or missing field, a bound crossed, a digest that does not
 * reconcile — is `checkpointCorrupt`. Nothing is ever half-accepted.
 */
export interface CheckpointLimits {
  maxBytes: number
  maxSources: number
  maxRows: number
}

export const CHECKPOINT_LIMITS: Readonly<CheckpointLimits> = Object.freeze({
  maxBytes: CHECKPOINT_MAX_BYTES,
  maxSources: CHECKPOINT_MAX_SOURCES,
  maxRows: CHECKPOINT_MAX_ROWS
})

/** `limits` exists for the gates: no record under 32 MiB can hold a million rows, so the row bound is proved smaller. */
export function decodeCheckpoint(text: string, limits: Readonly<CheckpointLimits> = CHECKPOINT_LIMITS): DecodedCheckpoint {
  try {
    if (Buffer.byteLength(text, 'utf-8') > limits.maxBytes) refuse(`the record is larger than ${limits.maxBytes} bytes.`)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      refuse('the record is not JSON.')
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('the record is not an object.')
    const schema = (raw as Record<string, unknown>).schema
    if (typeof schema === 'string' && schema !== RESUME_SCHEMA && schema.startsWith('srt-ai-resume/')) {
      return { ok: false, reason: 'checkpointVersion', detail: `the record is ${schema}.` }
    }
    const o = exact(raw, 'record', [
      'schema',
      'generationId',
      'ownerToken',
      'kind',
      'state',
      'createdAtEpochMs',
      'updatedAtEpochMs',
      'jobKey',
      'sources',
      'config',
      'configDigest',
      'working',
      'completion',
      'pending'
    ])
    if (o.schema !== RESUME_SCHEMA) refuse('the record is not a resume record.')
    if (!isCanonicalUuid(o.generationId)) refuse('generationId is not a canonical UUID.')
    if (!isCanonicalUuid(o.ownerToken)) refuse('ownerToken is not a canonical UUID.')
    const kind = oneOf(o.kind, 'kind', ['translate', 'transcribe'] as const)
    const state = oneOf(o.state, 'state', ['committed', 'pendingOutput', 'pendingPromotion', 'completed', 'tombstoned'] as const)
    const createdAtEpochMs = count(o.createdAtEpochMs, 'createdAtEpochMs')
    const updatedAtEpochMs = count(o.updatedAtEpochMs, 'updatedAtEpochMs')
    if (updatedAtEpochMs < createdAtEpochMs) refuse('updatedAtEpochMs is before createdAtEpochMs.')
    const jobKey = digest(o.jobKey, 'jobKey')
    const sources = decodeSources(o.sources, limits.maxSources)
    const config = decodeConfig(o.config, kind)
    const configDigest = digest(o.configDigest, 'configDigest')
    if (canonicalDigest(config) !== configDigest) refuse('configDigest does not match the configuration.')
    checkSourceRoles(kind, config, sources)
    const budget: RowBudget = { used: 0, max: limits.maxRows }
    const working = decodeWorkingOutput(o.working, kind, budget)
    const completion = decodeCompletion(o.completion)
    const pending = decodePending(o.pending, kind, state, budget)
    if (pending?.kind === 'output' && pending.revision) {
      // A revision rewrites the text of finished work only: every span keeps its time and its cues.
      const was = working.coverage
      const next = pending.coverage
      if (was.kind !== next.kind) refuse('a revision changes the kind of work.')
      if (!working.output || !isCompleteCoverage(was)) refuse('a revision is pending for unfinished work.')
      if (was.kind === 'transcribe' && next.kind === 'transcribe') {
        if (next.durationMs !== was.durationMs || next.spans.length !== was.spans.length) refuse('a revision changes the parts it covers.')
        if (was.spans.some((s, i) => s.startMs !== next.spans[i].startMs || s.endMs !== next.spans[i].endMs || s.firstCue !== next.spans[i].firstCue || s.cueCount !== next.spans[i].cueCount)) {
          refuse('a revision moves a committed span.')
        }
      } else if (was.kind === 'translate' && next.kind === 'translate') {
        // Bundle H finishing: only accepted cues' text may change; every cue keeps its number, its source
        // and how it was resolved, a kept (preserved) cue keeps its text, and the retry history is the same.
        if (!isCompleteCoverage(next) || next.sourceCueCount !== was.sourceCueCount || next.rows.length !== was.rows.length) refuse('a revision changes the cues it covers.')
        if (canonicalJson(next.children) !== canonicalJson(was.children)) refuse('a revision changes the recorded retries.')
        if (was.rows.some((r, i) => {
          const n = next.rows[i]
          return r.index !== n.index || r.source !== n.source || r.provenance !== n.provenance || (r.provenance === 'preserved' && r.output !== n.output)
        })) {
          refuse('a revision moves, re-sources or re-marks a committed cue, or rewrites a kept one.')
        }
      }
    } else if (pending?.kind === 'output') {
      const was = working.coverage
      const next = pending.coverage
      if (was.kind === 'translate' && next.kind === 'translate') {
        if (next.sourceCueCount !== was.sourceCueCount || next.rows.length <= was.rows.length) refuse('pending coverage does not extend the committed coverage.')
        if (was.rows.some((r, i) => r.source !== next.rows[i].source || r.output !== next.rows[i].output || r.provenance !== next.rows[i].provenance)) {
          refuse('pending coverage rewrites committed cues.')
        }
      } else if (was.kind === 'transcribe' && next.kind === 'transcribe') {
        if (next.durationMs !== was.durationMs || next.spans.length <= was.spans.length) refuse('pending coverage does not extend the committed coverage.')
        if (was.spans.some((s, i) => canonicalJson(s) !== canonicalJson(next.spans[i]))) refuse('pending coverage rewrites committed spans.')
      }
    }
    if (pending?.kind === 'promotion' && !(working.output && isCompleteCoverage(working.coverage))) refuse('a promotion is pending for incomplete work.')
    return {
      ok: true,
      checkpoint: { schema: RESUME_SCHEMA, generationId: o.generationId, ownerToken: o.ownerToken, kind, state, createdAtEpochMs, updatedAtEpochMs, jobKey, sources, config, configDigest, working, completion, pending }
    }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: 'checkpointCorrupt', detail: e.message }
    return { ok: false, reason: 'checkpointCorrupt', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** The checkpoint as written: canonical, so its bytes are a function of its content. */
export function encodeCheckpoint(checkpoint: Checkpoint): string {
  return canonicalJson(checkpoint)
}

/** Every unit of the run is covered: all source cues, or media time to the end. */
export function isCompleteCoverage(coverage: Coverage): boolean {
  if (coverage.kind === 'translate') return coverage.rows.length === coverage.sourceCueCount && coverage.failedSpan === null
  const last = coverage.spans[coverage.spans.length - 1]
  return !!last && last.endMs === coverage.durationMs
}

/** The derived pointer: cues done, or media milliseconds done. Never authority by itself. */
export function coveredUnits(coverage: Coverage): number {
  if (coverage.kind === 'translate') return coverage.rows.length
  return coverage.spans.length ? coverage.spans[coverage.spans.length - 1].endMs : 0
}

/** A source cue's identity: its number's timing and text. */
export function sourceCueDigest(cue: Pick<Cue, 'startMs' | 'endMs' | 'text'>): string {
  return canonicalDigest({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text })
}

/** An accepted translation's identity: its text. */
export function outputTextDigest(text: string): string {
  return sha256Text(text)
}

/**
 * The coverage rows for cues `1..through` of a written snapshot, read back from what was written. A cue
 * in `preserved` was kept in its source language (Bundle G) and is recorded so, never as accepted (PR-3).
 */
export function translateRowsFor(source: readonly Cue[], written: readonly Cue[], through: number, preserved: ReadonlySet<number> = new Set()): TranslateRow[] {
  const rows: TranslateRow[] = []
  for (let i = 0; i < through; i++) {
    rows.push({ index: i + 1, source: sourceCueDigest(source[i]), output: outputTextDigest(written[i].text), provenance: preserved.has(i + 1) ? 'preserved' : 'accepted' })
  }
  return rows
}

export type OutputVerdict = 'ok' | 'outputInvalid' | 'coverageInvalid'

/**
 * A Translate working output read back against its source and coverage. It must be a complete
 * snapshot — every source cue at the source's number and times — or it is `outputInvalid`; every
 * covered cue must carry its recorded source and accepted text, and every later cue its source text as
 * `serializeCues` writes it, or it is `coverageInvalid`.
 */
export function checkTranslateOutput(coverage: TranslateCoverage, source: readonly Cue[], written: readonly Cue[]): OutputVerdict {
  if (source.length !== coverage.sourceCueCount || written.length !== source.length) return 'outputInvalid'
  for (let i = 0; i < source.length; i++) {
    const s = source[i]
    const w = written[i]
    if (w.index !== s.index || w.startMs !== s.startMs || w.endMs !== s.endMs) return 'outputInvalid'
  }
  for (let i = 0; i < source.length; i++) {
    const row = coverage.rows[i]
    if (row) {
      if (row.source !== sourceCueDigest(source[i]) || row.output !== outputTextDigest(written[i].text)) return 'coverageInvalid'
    } else if (written[i].text !== writtenCueText(source[i].text)) {
      return 'coverageInvalid'
    }
  }
  return 'ok'
}

/** A transcribed span's identity: its cues' times and text, in order. */
export function transcribeSpanDigest(cues: readonly Pick<Cue, 'startMs' | 'endMs' | 'text'>[]): string {
  return canonicalDigest(cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })))
}

/** A Transcribe working output read back against its spans. */
export function checkTranscribeOutput(coverage: TranscribeCoverage, written: readonly Cue[]): OutputVerdict {
  if (written.length !== coveredCueCount(coverage)) return 'outputInvalid'
  for (const span of coverage.spans) {
    const cues = written.slice(span.firstCue - 1, span.firstCue - 1 + span.cueCount)
    if (transcribeSpanDigest(cues) !== span.sha256) return 'coverageInvalid'
  }
  return 'ok'
}

/** The destination as the output owner compares paths: resolved, and case-folded on Windows. */
export function normalizedDestination(file: string): string {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * The logical job a Translate generation belongs to (AR3-6): kind, the role-tagged complete source
 * identity and the target. A disk subtitle and an extracted track never share one, even with equal
 * SRT bytes, and the same subtitle to two targets is two jobs.
 */
export function translateJobKey(
  identity:
    | { inputKind: 'subtitleFile'; subtitle: FileReceipt; targetLang: string }
    | { inputKind: 'extractedTrack'; container: FileReceipt; streamIndex: number; targetLang: string }
): string {
  return identity.inputKind === 'subtitleFile'
    ? canonicalDigest({ kind: 'translate', role: 'subtitleFile', subtitle: identity.subtitle, targetLang: identity.targetLang })
    : canonicalDigest({ kind: 'translate', role: 'extractedTrack', container: identity.container, streamIndex: identity.streamIndex, targetLang: identity.targetLang })
}

/**
 * A Translate run's frozen behaviour, from the arguments its start path accepted. Built field by field,
 * never by spreading `args`, so a key, a credential or a display preference cannot ride along.
 */
export function translateResumeConfig(
  args: TranslateArgs,
  run: {
    inputKind: 'subtitleFile' | 'extractedTrack'
    streamIndex: number | null
    sourceEncoding: SubtitleEncoding
    resumeContextSize: number
    effectiveDescription: string
    ffmpeg: FfmpegFingerprint | null
  }
): TranslateResumeConfig {
  return {
    schema: RESUME_CONFIG_SCHEMA,
    kind: 'translate',
    requestContract: NATIVE_REQUEST_CONTRACT,
    promptContract: TRANSLATION_PROMPT_CONTRACT,
    provider: 'gemini',
    model: args.model,
    sourceLang: args.sourceLang,
    sourceEncoding: run.sourceEncoding,
    targetLang: args.targetLang,
    inputKind: run.inputKind,
    streamIndex: run.streamIndex,
    audio: Boolean(args.audioFile),
    thinkingLevel: args.thinkingLevel,
    thinkingBudget: args.thinkingBudget,
    customGenerationParams: args.customGenerationParams,
    temperature: args.temperature,
    topP: args.topP,
    topK: args.topK,
    serviceTier: args.serviceTier,
    paidQuota: args.paidQuota,
    disableStreaming: args.disableStreaming,
    batchSize: args.batchSize,
    effectiveBatchSize: args.batchSize,
    batchContext: args.batchContext,
    batchContextLines: args.batchContextLines ?? DEFAULT_BATCH_CONTEXT_LINES,
    resumeContextSize: run.resumeContextSize,
    description: args.description ?? '',
    systemPrompt: args.systemPrompt ?? '',
    effectiveDescription: run.effectiveDescription,
    ffmpeg: run.ffmpeg
  }
}

/**
 * Continue (AR3-6): the frozen behaviour as run arguments. Every behaviour field comes from the record;
 * only what the record never holds is taken from this Start — the run id, the current credentials, the
 * inputs as just verified, the FFmpeg the record's fingerprint was matched against, and the diagnostic
 * report toggles.
 */
export function translateArgsFromConfig(config: TranslateResumeConfig, current: TranslateArgs): TranslateArgs {
  const { writeTokenReport, progressLog, thoughtsLog } = current
  return {
    ...(current.runId !== undefined ? { runId: current.runId } : {}),
    inputFile: current.inputFile,
    ...(current.videoFile !== undefined ? { videoFile: current.videoFile } : {}),
    ...(config.audio && current.audioFile !== undefined ? { audioFile: current.audioFile } : {}),
    ...(config.streamIndex !== null ? { streamIndex: config.streamIndex } : {}),
    sourceLang: config.sourceLang,
    targetLang: config.targetLang,
    model: config.model,
    apiKeys: current.apiKeys,
    batchSize: config.effectiveBatchSize,
    batchContext: config.batchContext,
    ...(config.batchContextLines !== undefined ? { batchContextLines: config.batchContextLines } : {}),
    customGenerationParams: config.customGenerationParams,
    temperature: config.temperature,
    topP: config.topP,
    topK: config.topK,
    thinkingLevel: config.thinkingLevel,
    thinkingBudget: config.thinkingBudget,
    serviceTier: config.serviceTier,
    paidQuota: config.paidQuota,
    disableStreaming: config.disableStreaming,
    ...(config.description ? { description: config.description } : {}),
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    ...(current.ffmpegPath !== undefined ? { ffmpegPath: current.ffmpegPath } : {}),
    resumeContextSize: config.resumeContextSize,
    writeTokenReport,
    progressLog,
    thoughtsLog,
    ...(current.sourceReceipt !== undefined ? { sourceReceipt: current.sourceReceipt } : {}),
    // Bundle H / Feature 17 are not in the record: like the keys, they are this Start's (and absent reads off).
    ...(current.genderReference !== undefined ? { genderReference: current.genderReference } : {}),
    ...(current.hebrewSpeakerRepair !== undefined ? { hebrewSpeakerRepair: current.hebrewSpeakerRepair } : {}),
    ...(current.hebrewMethodB !== undefined ? { hebrewMethodB: current.hebrewMethodB } : {}),
    ...(current.hebrewC1Spanish !== undefined ? { hebrewC1Spanish: current.hebrewC1Spanish } : {}),
    ...(current.hebrewC1Portuguese !== undefined ? { hebrewC1Portuguese: current.hebrewC1Portuguese } : {})
  }
}

/** A Transcribe run's frozen behaviour, the same way. */
export function transcribeResumeConfig(args: TranscribeArgs, run: { chunkSeconds: number; ffmpeg: FfmpegFingerprint | null }): TranscribeResumeConfig {
  return {
    schema: RESUME_CONFIG_SCHEMA,
    kind: 'transcribe',
    requestContract: NATIVE_REQUEST_CONTRACT,
    promptContract: TRANSCRIPTION_PROMPT_CONTRACT,
    provider: 'gemini',
    model: args.model,
    targetLang: args.targetLang,
    thinkingLevel: args.thinkingLevel,
    thinkingBudget: args.thinkingBudget,
    customGenerationParams: args.customGenerationParams,
    temperature: args.temperature,
    topP: args.topP,
    topK: args.topK,
    serviceTier: args.serviceTier ?? '',
    chunkSeconds: run.chunkSeconds,
    description: args.description ?? '',
    ffmpeg: run.ffmpeg,
    ...(isDedicatedTranscribeModel(args.model)
      ? {
          ...(args.sourceLanguage ? { sourceLanguage: args.sourceLanguage } : {}),
          polish: args.polish ? { model: args.polish.model, thinkingLevel: args.polish.thinkingLevel, thinkingBudget: args.polish.thinkingBudget } : null
        }
      : {})
  }
}

/**
 * Transcribe Continue (AR3-6): the frozen behaviour as run arguments, the same way as Translate's. The
 * media, the destination, the run id, the current credentials and the FFmpeg override come from this
 * Start; the record's FFmpeg fingerprint was matched against that FFmpeg before the run was accepted.
 * A dedicated record's language and polish are its own; this Start's are never used.
 */
export function transcribeArgsFromConfig(config: TranscribeResumeConfig, current: TranscribeArgs): TranscribeArgs {
  return {
    ...(current.runId !== undefined ? { runId: current.runId } : {}),
    mediaFile: current.mediaFile,
    outputFile: current.outputFile,
    targetLang: config.targetLang,
    model: config.model,
    apiKeys: current.apiKeys,
    thinkingLevel: config.thinkingLevel,
    thinkingBudget: config.thinkingBudget,
    customGenerationParams: config.customGenerationParams,
    temperature: config.temperature,
    topP: config.topP,
    topK: config.topK,
    serviceTier: config.serviceTier,
    ...(config.description ? { description: config.description } : {}),
    ...(current.ffmpegPath !== undefined ? { ffmpegPath: current.ffmpegPath } : {}),
    ...(config.sourceLanguage ? { sourceLanguage: config.sourceLanguage } : {}),
    ...(config.polish ? { polish: { ...config.polish } } : {})
  }
}

/** Transcribe's logical job: the complete media and the selected destination. */
export function transcribeJobKey(identity: { media: FileReceipt; destination: string }): string {
  return canonicalDigest({ kind: 'transcribe', media: identity.media, destination: normalizedDestination(identity.destination) })
}

/**
 * The generation's job entry, `job.json`: written once when the generation is created and never
 * again, so a damaged checkpoint can still be matched to its job and reported rather than silently
 * ignored. The hint is the pickers' paths and target; it finds a job whose inputs changed, and is
 * never authority for continuing one.
 */
export const RESUME_JOB_SCHEMA = 'srt-ai-resume-job/v1'
export const JOB_ENTRY_MAX_BYTES = 64 * 1024

export interface JobHint {
  inputKind: 'subtitleFile' | 'extractedTrack' | 'media'
  /** The subtitle, container or media path, compared as the output owner compares paths. */
  primary: string
  streamIndex: number | null
  /** Translate: the target language. Transcribe: the normalised destination. */
  target: string
}

export interface JobEntry {
  schema: typeof RESUME_JOB_SCHEMA
  generationId: string
  kind: RunKind
  jobKey: string
  hint: JobHint
}

export function decodeJobEntry(text: string): JobEntry | null {
  try {
    if (Buffer.byteLength(text, 'utf-8') > JOB_ENTRY_MAX_BYTES) return null
    const o = exact(JSON.parse(text), 'job', ['schema', 'generationId', 'kind', 'jobKey', 'hint'])
    if (o.schema !== RESUME_JOB_SCHEMA || !isCanonicalUuid(o.generationId)) return null
    const h = exact(o.hint, 'job.hint', ['inputKind', 'primary', 'streamIndex', 'target'])
    return {
      schema: RESUME_JOB_SCHEMA,
      generationId: o.generationId,
      kind: oneOf(o.kind, 'job.kind', ['translate', 'transcribe'] as const),
      jobKey: digest(o.jobKey, 'job.jobKey'),
      hint: {
        inputKind: oneOf(h.inputKind, 'job.hint.inputKind', ['subtitleFile', 'extractedTrack', 'media'] as const),
        primary: str(h.primary, 'job.hint.primary', true),
        streamIndex: h.streamIndex === null ? null : count(h.streamIndex, 'job.hint.streamIndex'),
        target: str(h.target, 'job.hint.target', true)
      }
    }
  } catch {
    return null
  }
}

export function sameJobHint(a: JobHint, b: JobHint): boolean {
  return a.inputKind === b.inputKind && a.primary === b.primary && a.streamIndex === b.streamIndex && a.target === b.target
}
