/**
 * The Align tab's main-process owner (implementation_plan.md §17.5 C.2; feature_decisions.md §4–§5).
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * Main decides everything that matters: which profile runs (always `independent-align`), what the
 * verdict is, which bytes would be written and where. The renderer names a source, a reference and
 * a generation, and later asks for preview rows or an Apply of the result it was shown.
 *
 *  - **Preflight first.** The source is read once, its digest kept, and its structure judged before
 *    any reference work. A malformed source never reaches a reference, an extraction or a fallback.
 *  - **Generation fence.** A newer analysis supersedes and cancels the older one; a result can be
 *    previewed or applied only while its generation is the latest and its `resultId` matches.
 *  - **Nothing is written until Apply.** The candidate bytes are held in memory. Apply opens the
 *    Save dialog (the one explicit confirmation), re-checks the source digest, stages the bytes beside
 *    the destination and promotes them with `replaceFile` — old-or-new, never half-written. The source
 *    and the other inputs can never be the destination.
 *  - **Only the times change.** The candidate is the source's decoded text with each timing line's two
 *    timestamps replaced (`retimeSubRipText`) — numbers, text, blank lines, position coordinates and line
 *    endings untouched — encoded back into the source's own encoding and BOM. An encoding-uncertain
 *    source is refused rather than shown or written from a provisional reading.
 *  - **Text-free evidence.** Results carry counts, measures and issue codes. Preview rows carry the
 *    user's own lines to the renderer only; nothing here logs subtitle text.
 *
 * A media reference runs a fixed chain (§5.4; tester 2026-10-07): every embedded text track, each through
 * A–I on its own and decided between by Bundle M's arbitration (§16.0.3) → only when none is usable, the
 * speech in the audio through C.1's 1–4 kHz detector (local, nothing uploaded) → only after a structurally
 * valid audio refusal, an OFFER of a transcription. The
 * offer is never run from here: the user decides, the page starts the normal Transcribe run into the
 * offer's own folder, and a later analysis carrying the offer's token uses the transcript's times as
 * anchors for one global fit. Output times always come from that fit applied to the source's own cues.
 *
 * Only the 17 text codecs FFmpeg decodes are extracted, all in one run; image tracks (PGS, VobSub, XSUB)
 * and every other stream are listed as skipped and never extracted. Cancel answers at once and fences the
 * result. The extraction holds an engine lease on the session from before it starts until nothing of it
 * can still write — its own return, or an orphaned child's `close` — so neither this run nor a later start
 * removes a folder FFmpeg may be writing into. `probeTracks` takes no AbortSignal; the audio decode does.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  alignSubtitles,
  arbitrateTracks,
  audioSettles,
  INDEPENDENT_PROFILE,
  judgeCandidate,
  trackFamilies,
  type ArbitrationTrack,
  type IndependentAlignment,
  type IndependentEvidence
} from '../engine/align'
import { AlignmentResultStore, makeCandidate, type SnapshotStage, type StoredCandidate } from '../engine/alignmentResultStore'
import {
  decodeDiagnostic,
  DIAGNOSTIC_LIMITS,
  DiagnosticRecorder,
  encodeDiagnostic,
  replayDiagnostic,
  vectorSha256,
  type DiagnosticArbitration,
  type DiagnosticOutcome,
  type DiagnosticTrack,
  type DiagnosticV1
} from '../engine/alignmentDiagnostic'
import {
  ALASS_SIDECAR,
  alassExecutablePath,
  alignAlassToSpeech,
  checkAlass,
  defaultAlassDeps,
  runAlass,
  type AlassRunResult,
  type AlassSidecarDeps,
  type AlassSpeechResult,
  type AlassTrust,
  type AlassUnavailable
} from '../engine/alassSidecar'
import { checkWritten, planRepair, writeBack, type CueRepair, type RepairNote, type RepairSide } from '../engine/cueRepair'
import { parseCues, retimeSubRipText, type Cue } from '../engine/srt'
import {
  ALIGNMENT_CONTRACT_VERSION,
  type AlignmentCandidateSource,
  type AlignmentMode,
  type AlignmentMovement,
  type AlignmentReferenceKind,
  type AlignmentResult
} from '../shared/alignment'
import { inspectSubtitleFile, readVerifiedSubtitle, sha256Hex, type SubtitleEncoding } from '../engine/subtitleInput'
import { replaceFile } from '../engine/output'
import { isRunning } from '../engine/runner'
import { planChunks } from '../engine/transcribe'
import { modelCapabilities } from '../shared/modelCaps'
import { resolveTranscribeSettings } from '../shared/transcribeSettings'
import {
  ALIGN_TEXT_CODECS,
  ALIGN_TRACK_MAX_BYTES,
  alignTrackPlan,
  audioForAlignment,
  bundledBinDir,
  extractTextTracks,
  probeTracks,
  textTrackFile,
  type AlignmentAudio,
  type AlignmentCandidate,
  type ProgressReporter
} from './ffmpeg'
import { getSettings } from './store'
import type {
  AlignAdvancedDiagnostics,
  AlignAdvancedStatus,
  AlignAnalysis,
  AlignApplyResult,
  AlignArbitration,
  AlignAttempt,
  AlignDiagnosticExportResult,
  AlignDiagnosticOpenResult,
  AlignEvidence,
  AlignPreview,
  AlignProgress,
  AlignReference,
  AlignStopReason,
  AlignTrackEvidence,
  SubtitleTrack
} from '../shared/types'

/** Rows in the first preview page; later pages are asked for. */
export const ALIGN_PREVIEW_PAGE = 100
const PREVIEW_MAX = 500

/** Bytes that open a PGS (`.sup`) stream. */
const PGS_MAGIC = 'PG'
const IMAGE_SUBTITLE_EXTS = new Set(['.sup', '.sub', '.idx'])

/** The filesystem calls Apply makes. Injectable so the fault gates can fail each one. */
export interface AlignIo {
  open(file: string, flags: 'wx'): number
  write(fd: number, data: Buffer): void
  fsync(fd: number): void
  close(fd: number): void
  rename(from: string, to: string): void
  unlink(file: string): void
  sleep(ms: number): Promise<void>
  /** Remove a scratch folder this service made; throws when it cannot (a locked file on Windows). */
  removeDir(dir: string): void
}

export const NODE_ALIGN_IO: AlignIo = {
  open: (file, flags) => fs.openSync(file, flags),
  write: (fd, data) => fs.writeFileSync(fd, data),
  fsync: (fd) => fs.fsyncSync(fd),
  close: (fd) => fs.closeSync(fd),
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (file) => fs.unlinkSync(file),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  removeDir: (dir) => fs.rmSync(dir, { recursive: true, force: true })
}

export interface AlignServiceDeps {
  ffmpegPath(): string | undefined
  probeTracks(file: string, ffmpegPath?: string): Promise<SubtitleTrack[]>
  /**
   * Bundle M: one FFmpeg run writing each listed subtitle stream to `textTrackFile(outDir, N)`. `closed`
   * settles once nothing of that run can still write into `outDir` (an orphaned child's own `close`).
   */
  extractTextTracks(
    media: string,
    indices: readonly number[],
    outDir: string,
    opts: { ffmpegPath?: string; signal: AbortSignal; onProgress?: ProgressReporter }
  ): Promise<{ ok: boolean; error?: string; aborted?: boolean; closed?: Promise<void> }>
  /** C.1's one decode through the 1–4 kHz band, swept. Local only: nothing is uploaded. */
  audioForAlignment(input: string, opts: { ffmpegPath?: string; signal: AbortSignal; onProgress?: ProgressReporter }): Promise<AlignmentAudio>
  /** The model the Transcribe tab would run now, and whether it can transcribe at all. */
  transcriptionModel(): { model: string; supported: boolean }
  /** The one AI job slot is taken (a Translate or Transcribe run is live). */
  jobRunning(): boolean
  /** The destination the user chose in the Save dialog, or `null` when they cancelled. */
  saveDialog(defaultPath: string): Promise<string | null>
  /** Bundle M: where to save a timing diagnostic (JSON), or `null` when cancelled. */
  diagnosticSaveDialog(defaultPath: string): Promise<string | null>
  /** Bundle M: the timing diagnostic the user chose to open, or `null` when cancelled. */
  diagnosticOpenDialog(): Promise<string | null>
  progress(p: AlignProgress): void
  tempRoot(): string
  /** This process's id; it names the session folder, so one AlignService per process. */
  pid(): number
  /** Whether a process with this id is running (a session folder's owner may still be writing). */
  processAlive(pid: number): boolean
  io: AlignIo
  /** The one ALASS build Advanced may run: an absolute path, its SHA-256 and version line. Never from the renderer. */
  alassTrust(): AlassTrust
  alassDeps(): AlassSidecarDeps
  /**
   * The app's own FFmpeg and FFprobe for ALASS's media decode, as absolute paths, or `null` when either is
   * missing. Never the Settings override and never the user's `PATH` (alass_sidecar_compliance.md §4).
   */
  alassMediaTools(): { ffmpegPath: string; ffprobePath: string } | null
}

export function defaultAlignDeps(): AlignServiceDeps {
  return {
    ffmpegPath: () => getSettings().ffmpegPath || undefined,
    probeTracks,
    extractTextTracks: (media, indices, outDir, opts) => extractTextTracks(media, indices, outDir, opts),
    audioForAlignment: (input, opts) => audioForAlignment(input, opts),
    transcriptionModel: () => {
      const model = resolveTranscribeSettings(getSettings()).model
      return { model, supported: modelCapabilities(model).supportsTranscription }
    },
    jobRunning: isRunning,
    saveDialog: async () => null,
    diagnosticSaveDialog: async () => null,
    diagnosticOpenDialog: async () => null,
    progress: () => {},
    tempRoot: () => os.tmpdir(),
    pid: () => process.pid,
    processAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        // EPERM: it exists and belongs to someone else. Anything but "no such process" counts as alive.
        return (e as NodeJS.ErrnoException).code !== 'ESRCH'
      }
    },
    io: NODE_ALIGN_IO,
    alassTrust: () => ({ exePath: alassExecutablePath(bundledBinDir()), sha256: ALASS_SIDECAR.sha256, versionLine: ALASS_SIDECAR.versionLine }),
    alassDeps: defaultAlassDeps,
    alassMediaTools: () => bundledMediaTools(bundledBinDir())
  }
}

/** `ffmpeg.exe` and `ffprobe.exe` in the app's own `resources/bin`, or `null` when either is not a file. */
export function bundledMediaTools(binDir: string): { ffmpegPath: string; ffprobePath: string } | null {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const ffmpegPath = path.join(binDir, `ffmpeg${exe}`)
  const ffprobePath = path.join(binDir, `ffprobe${exe}`)
  const isFile = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
  return path.isAbsolute(binDir) && isFile(ffmpegPath) && isFile(ffprobePath) ? { ffmpegPath, ffprobePath } : null
}

/**
 * The transcription offer's time range, minutes per 5-minute part, low and high. The low end is one
 * measured normal Transcribe run (0.37 min/part, gate_ledger.md §5f.4); the high end is headroom, not a
 * bound — an overloaded model can take much longer or fail. A rough guide, never a promise.
 */
export const TRANSCRIPTION_MINUTES_PER_PART: readonly [number, number] = Object.freeze([0.35, 1.5]) as readonly [number, number]

export function transcriptionEstimate(audioSeconds: number): { requests: number; estimateMinutes: [number, number] } {
  const requests = planChunks(audioSeconds).length
  const [lo, hi] = TRANSCRIPTION_MINUTES_PER_PART
  return { requests, estimateMinutes: [Math.max(1, Math.round(requests * lo)), Math.max(1, Math.ceil(requests * hi))] }
}

export const AUDIO_REFERENCE_LABEL = 'Audio (speech detector)'
/** Advanced's media reference: ALASS's own detector, not the Global path's. */
export const ALASS_AUDIO_REFERENCE_LABEL = 'Audio (ALASS speech detector)'
export const TRANSCRIPT_REFERENCE_LABEL = 'Transcript (timings as anchors only)'

/** Detector spans as a reference timeline: the times are the evidence; the neutral text only marks them as speech. */
export function spanCues(candidate: AlignmentCandidate): Cue[] {
  return candidate.spans.map((s, i) => ({ index: i + 1, startMs: s.startMs, endMs: s.endMs, text: 'speech' }))
}

/** The digest of the speech spans an audio map was measured against: the audio reference's identity in a result id. */
const audioSha = (candidate: AlignmentCandidate): string => vectorSha256(spanCues(candidate))

/**
 * The sweep arm to judge: the one whose spans the subtitle's onsets vote for most strongly (then overlap,
 * then sweep order). Chosen from the coarse estimate alone — never from the verdict, and never from
 * ground truth (E67) — and then the complete A–I gate over that one arm decides.
 */
export function pickAudioCandidate(
  source: readonly Cue[],
  candidates: readonly AlignmentCandidate[]
): { candidate: AlignmentCandidate; result: IndependentAlignment } | null {
  let best: { candidate: AlignmentCandidate; result: IndependentAlignment; vote: number; overlap: number } | null = null
  for (const candidate of candidates) {
    if (candidate.spans.length === 0) continue
    const result = alignSubtitles('independent-align', source, spanCues(candidate), 'audio')
    const vote = result.evidence.coarse?.vote ?? -1
    const overlap = result.evidence.coarse?.overlap ?? -1
    if (!best || vote > best.vote || (vote === best.vote && overlap > best.overlap)) best = { candidate, result, vote, overlap }
  }
  return best && { candidate: best.candidate, result: best.result }
}

export interface AlignService {
  analyze(req: unknown): Promise<AlignAnalysis>
  cancel(generation: unknown): void
  preview(req: unknown): AlignPreview | null
  apply(req: unknown): Promise<AlignApplyResult>
  /** Whether Advanced can run now. Anything short of the exact ALASS build disables Advanced only. */
  advancedStatus(): Promise<AlignAdvancedStatus>
  /** Bundle M: save the live outcome's timing diagnostic, through main's own Save dialog. */
  exportDiagnostic(req: unknown): Promise<AlignDiagnosticExportResult>
  /** Bundle M: open a timing diagnostic, through main's own Open dialog, and replay it. Never applicable. */
  openDiagnostic(): Promise<AlignDiagnosticOpenResult>
  /** Resolves once every scratch folder an analysis made has been removed. */
  settled(): Promise<void>
  /** App quit: stop the analysis, retire the offer and remove every offer folder no live job can still write. */
  dispose(): void
  /** App start: remove session folders whose owning process is gone and that no engine lease still holds. */
  resumeCleanup(): void
}

/** How often retired offer folders are re-checked while a job still holds the slot. */
export const RETIRED_SWEEP_MS = 500
/** A folder whose removal failed is retried at doubling intervals up to this; never given up while the app runs. */
export const RETIRED_RETRY_MAX_MS = 30_000
/**
 * Every Align folder lives in `tempRoot/ng-align/<pid>-<random>/`, one session folder per running
 * instance, made by one `mkdtemp`. Its name is the ownership receipt: there is no record to write, so
 * none can be lost, and a later start removes a session only once that process is gone.
 */
export const ALIGN_TEMP_DIR = 'ng-align'
const SESSION_NAME = /^(\d+)-[A-Za-z0-9]{6}$/

/**
 * An engine writing into a session can outlive the app that started it (a crash, a bounded shutdown),
 * and its launcher can end while the interpreter it started keeps working; no process id on record
 * proves the writer has ended. So before the engine is spawned a lease file is made in the session,
 * and it is removed only when the app itself sees the engine's `close` — which waits for every holder
 * of the engine's output pipe, the interpreter included, since that is where its progress lines come
 * from. A session that still has a lease is never deleted by Align, by this run or a later one; the
 * user is told where it is.
 */
const ENGINE_LEASE = /^engine-.*\.lease$/

export interface EngineLease {
  /** The app saw the engine close, or the spawn never started a process: nothing can still be writing. */
  release(): void
}

/** The Align session an engine output path is in — `ng-align/<session>/ng-align-tx-…/file` — or null. */
export function alignSessionOf(outputPath: string): string | null {
  const offerDir = path.dirname(path.resolve(outputPath))
  const session = path.dirname(offerDir)
  if (!path.basename(offerDir).startsWith('ng-align-tx-')) return null
  if (!SESSION_NAME.test(path.basename(session)) || path.basename(path.dirname(session)) !== ALIGN_TEMP_DIR) return null
  return session
}

/**
 * Take the lease for an engine about to write `outputPath`; null when the output is not in an Align
 * session. Throws when the lease cannot be made — the caller must then not spawn, because an engine
 * nothing protects could have its folder deleted beneath it by a later start.
 */
export function takeEngineLease(outputPath: string): EngineLease | null {
  const session = alignSessionOf(outputPath)
  return session ? leaseSession(session) : null
}

/** The same lease for an engine Align runs itself (ALASS), in Align's own session folder. */
function leaseSession(session: string): EngineLease {
  const file = path.join(session, `engine-${crypto.randomBytes(6).toString('hex')}.lease`)
  fs.writeFileSync(file, '', { flag: 'wx' })
  let released = false
  return {
    release() {
      if (released) return
      released = true
      // A lease that cannot be removed stays, and keeps the session: that fails closed.
      try {
        fs.unlinkSync(file)
      } catch {
        return
      }
      for (const dir of [session, path.dirname(session)]) {
        try {
          fs.rmdirSync(dir)
        } catch {
          /* still holds folders */
        }
      }
    }
  }
}

/** Whether a session may still have a writer: it holds a lease, or cannot be read (gone is the only proof). */
function sessionLeased(session: string): boolean {
  try {
    return fs.readdirSync(session).some((name) => ENGINE_LEASE.test(name))
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** The session folder a folder sits directly in, or null. */
function sessionAbove(dir: string): string | null {
  const parent = path.dirname(dir)
  return SESSION_NAME.test(path.basename(parent)) && path.basename(path.dirname(parent)) === ALIGN_TEMP_DIR ? parent : null
}

// ── encoding the candidate back into the source's bytes ─────────────────────────────────────────

const legacyTables = new Map<string, Map<number, number>>()

/** Code unit → byte for a single-byte code page, from the same decoder that read the source. */
function legacyTable(encoding: string): Map<number, number> {
  let table = legacyTables.get(encoding)
  if (table) return table
  table = new Map()
  const decoder = new TextDecoder(encoding)
  for (let b = 0; b < 256; b += 1) {
    const ch = decoder.decode(Uint8Array.of(b))
    if (ch.length === 1 && ch !== '\uFFFD' && !table.has(ch.charCodeAt(0))) table.set(ch.charCodeAt(0), b)
  }
  legacyTables.set(encoding, table)
  return table
}

/**
 * `text` in `encoding`, BOM included, exactly as `decodeSubtitleBuffer` would read it back; `null` when a
 * character has no byte in that code page (the source then held a byte its code page leaves undefined).
 */
export function encodeSubtitleText(text: string, encoding: SubtitleEncoding): Buffer | null {
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(text, 'utf8')
    case 'utf-8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf-16le-bom':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf-16be-bom':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
    default: {
      const table = legacyTable(encoding)
      const out = Buffer.alloc(text.length)
      for (let i = 0; i < text.length; i += 1) {
        const b = table.get(text.charCodeAt(i))
        if (b === undefined) return null
        out[i] = b
      }
      return out
    }
  }
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

function canonical(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

// ── reading a subtitle ──────────────────────────────────────────────────────────────────────────

interface LoadedSubtitle {
  path: string
  sha256: string
  encoding: SubtitleEncoding
  /** The decoded file exactly as read; the aligned copy is this text with only its timestamps replaced. */
  text: string
  cues: Cue[]
  /**
   * Read with repair (§9.4c R5): `cues` is then the tidied analysis view, `file` the file's own cues, and
   * the written copy is `file` in file order with only its times changed.
   */
  repaired?: { repair: CueRepair; file: Cue[] }
}

/** One side's structure: clean, readable on a tidied view, or refused with `align.ts`'s own issues. */
export type SideRead =
  | { kind: 'clean' }
  | { kind: 'repaired'; repair: CueRepair }
  | { kind: 'refused'; issues: string[]; evidence: IndependentEvidence; overBudget: boolean }

/** Appended to a side's `malformed` refusal only when its order/duration problems exceed the budget. */
export const REPAIR_OVER_BUDGET = ' Align can read past these two problems only when at most 1 subtitle in 10 has them.'

/** `align.ts`'s own preflight for one side; the other side is empty, so only this side's issues count. */
function structureOf(side: RepairSide, cues: Cue[]): { issues: string[]; evidence: IndependentEvidence } {
  const pre = side === 'source' ? alignSubtitles('independent-align', cues, [], 'subtitle') : alignSubtitles('independent-align', [], cues, 'subtitle')
  return { issues: pre.evidence.issues.filter((i) => i.startsWith(`${side}:`)), evidence: pre.evidence }
}

/**
 * A side whose only problems are `order`/`duration`, within budget, is read on a tidied view. The view is
 * checked by the same preflight again: a text or round-trip problem hidden behind an order issue
 * refuses with the original issues.
 */
export function readSide(side: RepairSide, cues: Cue[]): SideRead {
  const pre = structureOf(side, cues)
  const plan = planRepair(side, cues, pre.issues)
  if (plan.kind === 'clean') return { kind: 'clean' }
  if (plan.kind === 'repaired' && structureOf(side, plan.repair.view).issues.length === 0) return plan
  return { kind: 'refused', issues: pre.issues, evidence: pre.evidence, overBudget: plan.kind === 'refused' && plan.overBudget }
}

/** The cues a reference is analysed on. */
const readCues = (read: SideRead, cues: Cue[]): Cue[] => (read.kind === 'repaired' ? read.repair.view : cues)

/** The over-budget sentence, for a `malformed` refusal of a side that was refused over budget only. */
const overBudget = (read: SideRead | null, reason: string): string => (read?.kind === 'refused' && read.overBudget && reason === 'malformed' ? REPAIR_OVER_BUDGET : '')

/** The evidence with the source's and this reference's repairs disclosed, source first. */
function disclosed(evidence: AlignEvidence, source: LoadedSubtitle, reference: SideRead | null): AlignEvidence {
  const repairs: RepairNote[] = [
    ...(source.repaired ? [source.repaired.repair.note] : []),
    ...(reference?.kind === 'repaired' ? [reference.repair.note] : [])
  ]
  return repairs.length > 0 ? { ...evidence, repairs: repairs.map((n) => ({ ...n })) } : evidence
}

type Refusal = {
  reason: Extract<AlignAnalysis, { status: 'refused' }>['reason']
  message: string
  evidence: AlignEvidence | null
  /** The A–I verdict that refused, when one did; a stop before any verdict has none. */
  alignment?: AlignmentResult
  advanced?: AlignAdvancedDiagnostics
}

function looksLikeImageSubtitle(file: string): boolean {
  if (IMAGE_SUBTITLE_EXTS.has(path.extname(file).toLowerCase())) return true
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(2)
      return fs.readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === PGS_MAGIC
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

/** Read once, verify the digest, decode, parse strictly. Every refusal names the file's role. */
function loadSubtitle(file: string, role: 'source' | 'reference'): { ok: true; sub: LoadedSubtitle } | { ok: false; refusal: Refusal } {
  const noun = role === 'source' ? 'The subtitle to align' : 'The reference subtitle'
  const unreadable: AlignStopReason = role === 'source' ? 'source_unreadable' : 'reference_unreadable'
  if (looksLikeImageSubtitle(file)) {
    return {
      ok: false,
      refusal: {
        reason: role === 'source' ? 'source_unreadable' : 'reference_not_text',
        message: `${noun} is an image subtitle (PGS or VobSub): pictures of text, with no text timings Align can read. Use a SubRip (.srt) file.`,
        evidence: null
      }
    }
  }
  const inspected = inspectSubtitleFile(file)
  if (!inspected.ok) return { ok: false, refusal: { reason: unreadable, message: `${noun} could not be read: ${inspected.error}`, evidence: null } }
  if (inspected.inspection.format !== 'srt') {
    return { ok: false, refusal: { reason: unreadable, message: `${noun} is not a SubRip file. Align reads SubRip (.srt) files only.`, evidence: null } }
  }
  // The source's text is shown in the preview and written back in its own encoding, so a provisional
  // reading is never used for it (the barrier `readTranslateSource` keeps for Translate). A reference
  // contributes timings only.
  if (role === 'source' && !inspected.inspection.encodingCertain) {
    return {
      ok: false,
      refusal: {
        reason: 'source_unreadable',
        message:
          'The subtitle to align is not UTF-8, and its encoding could not be decided with confidence: more than one code page reads it, with different letters. Save it as UTF-8 and try again. Nothing was changed.',
        evidence: null
      }
    }
  }
  const read = readVerifiedSubtitle(file, inspected.inspection.receipt)
  if (!read.ok) return { ok: false, refusal: { reason: unreadable, message: `${noun} could not be read: ${read.error}`, evidence: null } }
  const parsed = parseCues(read.text, { path: read.receipt.path })
  if (!parsed.ok) {
    const why =
      parsed.reason === 'format'
        ? { reason: unreadable, message: `${noun} is not a SubRip file. Align reads SubRip (.srt) files only.` }
        : parsed.reason === 'empty'
          ? { reason: 'malformed' as const, message: `${noun} has no subtitle timings.` }
          : { reason: 'malformed' as const, message: `${noun} cannot be read safely at line ${parsed.line}: ${PARSE_PROBLEM[parsed.reason]}. Nothing was changed.` }
    return { ok: false, refusal: { ...why, evidence: null } }
  }
  return {
    ok: true,
    sub: { path: read.receipt.path, sha256: read.receipt.sha256, encoding: read.receipt.encoding, text: read.text, cues: parsed.cues }
  }
}

const PARSE_PROBLEM: Record<'timing' | 'preface' | 'index', string> = {
  timing: 'a line looks like a timing but cannot be read',
  preface: 'there is text before the first subtitle',
  index: 'a line above a timing is not a subtitle number'
}

// ── evidence and messages ───────────────────────────────────────────────────────────────────────

function evidenceOf(reference: string, e: IndependentEvidence, attempts: AlignAttempt[]): AlignEvidence {
  const fit = e.fit
  const kept = e.identity?.keptIdentity ? e.identity : null
  if (kept) {
    return {
      reference,
      sourceCues: e.sourceCues,
      referenceCues: e.referenceCues,
      sourceDialogue: e.sourceDialogue,
      referenceDialogue: e.referenceDialogue,
      coveragePct: kept.coveragePct,
      retainedPct: null,
      pairs: kept.pairs,
      retained: kept.pairs,
      vote: e.coarse ? e.coarse.vote : null,
      overlap: e.coarse ? e.coarse.overlap : null,
      scale: 1,
      offsetMs: 0,
      residualAbsMedianMs: kept.residualAbsMedianMs,
      residualAbsP95Ms: null,
      keptIdentity: true,
      issues: [...e.issues],
      attempts: attempts.map((a) => ({ ...a }))
    }
  }
  return {
    reference,
    sourceCues: e.sourceCues,
    referenceCues: e.referenceCues,
    sourceDialogue: e.sourceDialogue,
    referenceDialogue: e.referenceDialogue,
    coveragePct: fit ? fit.coveragePct : null,
    retainedPct: fit ? fit.retainedPct : null,
    pairs: fit ? fit.pairs : null,
    retained: fit ? fit.retained : null,
    vote: e.coarse ? e.coarse.vote : null,
    overlap: e.coarse ? e.coarse.overlap : null,
    scale: fit ? fit.scale : null,
    offsetMs: fit ? fit.offsetMs : null,
    residualAbsMedianMs: fit ? fit.residualAbsMedianMs : null,
    residualAbsP95Ms: fit ? fit.residualAbsP95Ms : null,
    issues: [...e.issues],
    attempts: attempts.map((a) => ({ ...a }))
  }
}

const ISSUE_TEXT: Record<string, (n: string) => string> = {
  empty: () => 'it has no subtitles',
  not_a_cue: (n) => `entry ${n} is not a subtitle`,
  index: (n) => `subtitle ${n} is numbered out of sequence`,
  text: (n) => `subtitle ${n} has a line that reads as a timing`,
  time: (n) => `subtitle ${n} has a time SubRip cannot hold`,
  duration: (n) => `subtitle ${n} ends when or before it starts`,
  order: (n) => `subtitle ${n} starts before the one above it`,
  round_trip: () => 'it does not read back the same after writing'
}

function describeIssues(issues: readonly string[]): string {
  const said = issues.map((code) => {
    const [, rule, n] = code.split(':')
    const say = ISSUE_TEXT[rule]
    return say ? say(n ?? '') : code
  })
  const shown = said.slice(0, 3).join('; ')
  return said.length > 3 ? `${shown}; and ${said.length - 3} more` : shown
}

function pct(n: number | null): string {
  return n === null ? '0' : (Math.round(n * 10) / 10).toString()
}

/** The refusal in plain words, with the measured value and the boundary it missed. */
export function refusalMessage(reason: IndependentAlignment['reason'], e: AlignEvidence): string {
  const p = INDEPENDENT_PROFILE
  switch (reason) {
    case 'malformed': {
      const side = e.issues.filter((i) => i.startsWith('source:'))
      const own = side.length > 0 ? side : e.issues
      const whose = side.length > 0 ? 'The subtitle to align' : 'The reference'
      return `${whose} has a structural problem: ${describeIssues(own)}. Nothing was sorted, stretched or clamped; fix the file and try again.`
    }
    case 'insufficient':
      return `Too few dialogue lines to align safely: ${e.sourceDialogue} in the subtitle and ${e.referenceDialogue} in the reference. Each needs at least ${p.minDialogueCues}.`
    case 'wrong_title':
      return `The reference does not look like the same film or episode: only ${pct(e.coveragePct)}% of dialogue lines line up, and the timing pattern matches no better than chance.`
    case 'invariant_failure':
      return 'The best map would move subtitles outside what SubRip can hold, or out of order. Nothing was clamped, so there is no result.'
    case 'likely_different_cut':
      return 'Different parts of the film line up with different shifts, as when scenes were added or removed. One global map would leave part of the film wrong, so there is no global result.'
    case 'weak_correspondence': {
      if (e.coveragePct === null || e.coveragePct < p.checkCoveragePct) {
        return `Only ${pct(e.coveragePct)}% of dialogue lines fit one global map; at least ${p.checkCoveragePct}% is needed.`
      }
      if (e.vote === null || e.overlap === null || e.vote < p.voteMin || e.overlap < p.overlapMin) {
        return 'The two timelines do not agree strongly enough on one global map.'
      }
      if (e.scale === null || e.scale < p.scaleMin || e.scale > p.scaleMax) {
        return 'The map would need a speed change larger than any frame-rate difference explains.'
      }
      if (e.retainedPct === null || e.retainedPct < p.retainedMinPct) {
        return `Too many matched lines disagree with the map: ${pct(e.retainedPct)}% agree, at least ${p.retainedMinPct}% are needed.`
      }
      return `The best map still leaves its matched lines too far off; at most ${p.residualOkMs} ms is allowed.`
    }
    default:
      return 'The timelines could not be aligned.'
  }
}

/** A piecewise refusal in plain words: ALASS proposed the timing, and NG's own check over it refused. */
function piecewiseRefusal(reason: IndependentAlignment['reason'], e: AlignEvidence): string {
  const lead = 'ALASS proposed a piece-by-piece timing, and Align\u2019s own check of that result against the reference refused it: '
  switch (reason) {
    case 'invariant_failure':
      return `${lead}the result did not keep every subtitle, in order, with its own text and times SubRip can hold. Nothing was changed.`
    case 'wrong_title':
      return `${lead}the reference does not look like the same film or episode (only ${pct(e.coveragePct)}% of dialogue lines line up). Nothing was changed.`
    case 'likely_different_cut':
      return `${lead}parts of the result still line up with different shifts. Nothing was changed.`
    case 'weak_correspondence':
      return `${lead}too few of its lines land on the reference's lines (${pct(e.coveragePct)}% of dialogue lines; at least ${INDEPENDENT_PROFILE.checkCoveragePct}% is needed, closely enough). Nothing was changed.`
    default:
      return refusalMessage(reason, e)
  }
}

const ADVANCED_INTACT = 'Global alignment still works.'

export function advancedUnavailableMessage(reason: AlassUnavailable | 'busy'): string {
  switch (reason) {
    case 'absent':
      return `Advanced (piecewise) alignment needs the ALASS component, and it is not installed with this copy of the app. ${ADVANCED_INTACT}`
    case 'untrusted':
      return `The ALASS component is not the exact build this app ships (the file has changed), so Advanced is off. Reinstalling the app restores it. ${ADVANCED_INTACT}`
    case 'wrong_version':
      return `The ALASS component reports a different version from the one this app ships, so Advanced is off. ${ADVANCED_INTACT}`
    case 'not_runnable':
      return `The ALASS component could not be started, so Advanced is off. ${ADVANCED_INTACT}`
    case 'busy':
      return `An earlier ALASS run did not stop when it was told to, so Advanced waits until it ends. ${ADVANCED_INTACT}`
  }
}

function advancedFailedMessage(out: Extract<AlassRunResult, { ok: false }>, timeoutMs: number, media = false): string {
  const unchanged = 'Nothing was changed.'
  switch (out.failure) {
    case 'timeout':
      return `ALASS took longer than its ${Math.round(timeoutMs / 60_000)}-minute limit and was stopped. ${unchanged}`
    case 'orphaned':
      return `ALASS did not stop when it was told to. Advanced waits until it ends; ${ADVANCED_INTACT.toLowerCase()} ${unchanged}`
    case 'exit_nonzero':
      return media
        ? `ALASS could not read speech from the media file (exit code ${out.exitCode ?? 'unknown'}); it may have no audio track, or not be a media file. ${unchanged}`
        : `ALASS stopped with an error (exit code ${out.exitCode ?? 'unknown'}). ${unchanged}`
    case 'spawn_failed':
      return `ALASS could not be started. ${unchanged}`
    case 'stream_limit':
    case 'output_limit':
      return `ALASS produced far more output than a subtitle needs and was stopped. ${unchanged}`
    case 'output_missing':
      return `ALASS finished without writing a result. ${unchanged}`
    case 'report_invalid':
    case 'report_mismatch':
      return `ALASS's account of its own run was not exactly as expected, so its result was not used. ${unchanged}`
    case 'bad_request':
      return `The subtitle could not be handed to ALASS as SubRip. ${unchanged}`
    default:
      return `ALASS did not produce a usable result. ${unchanged}`
  }
}

/** Up to five cues spread across the file — first, quarters, last — and how far each moved. Text-free. */
function representativeMovements(before: readonly Cue[], after: readonly Cue[]): AlignmentMovement[] {
  const n = Math.min(before.length, after.length)
  if (n === 0) return []
  const picks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1))))]
  return picks.map((i) => ({ index: before[i].index, fromMs: before[i].startMs, toMs: after[i].startMs, deltaMs: after[i].startMs - before[i].startMs }))
}

interface Judged {
  mode: AlignmentMode
  candidateSource: AlignmentCandidateSource
  referenceKind: AlignmentReferenceKind
  advanced?: AlignAdvancedDiagnostics
}

const GLOBAL_SUBTITLE: Judged = { mode: 'global', candidateSource: 'ng-global', referenceKind: 'subtitle' }
const globalAgainst = (referenceKind: AlignmentReferenceKind): Judged => ({ mode: 'global', candidateSource: 'ng-global', referenceKind })

/**
 * One `independent-align` verdict as the shared contract (`../shared/alignment`): its verdict and reason
 * unchanged, numbers and text-free codes only. Movements run from the user's own cues to the output.
 * A piecewise result has no single map, so it carries no transform.
 */
export function alignmentContract(r: IndependentAlignment, judged: Judged, before: readonly Cue[]): AlignmentResult {
  const e = r.evidence
  const fit = e.fit
  const post = e.issues.filter((i) => !i.startsWith('source:') && !i.startsWith('reference:'))
  const base = {
    version: ALIGNMENT_CONTRACT_VERSION,
    mode: judged.mode,
    candidateSource: judged.candidateSource,
    referenceKind: judged.referenceKind,
    evidence: {
      sourceCues: e.sourceCues,
      referenceCues: e.referenceCues,
      sourceDialogue: e.sourceDialogue,
      referenceDialogue: e.referenceDialogue,
      pairs: fit ? fit.pairs : null,
      retained: fit ? fit.retained : null,
      retainedPct: fit ? fit.retainedPct : null,
      coveragePct: fit ? fit.coveragePct : null,
      residualMedianMs: fit ? fit.residualMedianMs : null,
      residualAbsMedianMs: fit ? fit.residualAbsMedianMs : null,
      residualAbsP95Ms: fit ? fit.residualAbsP95Ms : null,
      local: e.local
        ? {
            pattern: e.local.pattern,
            piecewiseSteps: e.local.piecewiseSteps,
            linearDrift: e.local.linearDrift,
            driftR2: e.local.driftR2,
            stepEvents: e.local.stepEvents,
            supportedWindows: e.local.supportedWindows,
            unsupportedWindows: e.local.unsupportedWindows,
            strongestWindowVote: e.local.strongestWindowVote
          }
        : null,
      drift: e.drift ? { ...e.drift } : null,
      identity: e.identity
        ? { coveragePct: e.identity.coveragePct, medianDeltaMs: e.identity.medianDeltaMs, alreadyAligned: e.identity.alreadyAligned, keptIdentity: e.identity.keptIdentity }
        : null,
      invariants: r.verdict !== 'refuse' ? { ok: true, issues: [] } : r.reason === 'invariant_failure' ? { ok: false, issues: post } : null
    }
  }
  if (r.verdict === 'refuse') return { ...base, verdict: 'refuse', reason: r.reason }
  return {
    ...base,
    verdict: r.verdict,
    reason: r.reason,
    transform: judged.mode === 'global' ? { scale: r.transform.scale, offsetMs: r.transform.offsetMs } : null,
    movements: representativeMovements(before, r.cues)
  }
}

// ── the service ─────────────────────────────────────────────────────────────────────────────────

/** What Preview and Apply need beside the candidate's bytes and digests, held by the store. */
interface CandidatePayload {
  sourcePath: string
  inputs: string[]
  before: Cue[]
  after: Cue[]
  defaultPath: string
}

/** The snapshot's diagnostic: the v1 file and where its Save dialog opens. */
interface HeldDiagnostic {
  v1: DiagnosticV1
  defaultPath: string
}

/**
 * One analysis's own record of how its outcome was decided, threaded through the chain so a superseded
 * run still finishing can never write into a newer one's.
 */
interface RunState {
  stage: SnapshotStage
  /** Global only; Advanced has no replayable diagnostic (§16.0.6). */
  recorder: DiagnosticRecorder | null
  outcome: DiagnosticOutcome | null
  tracks: DiagnosticTrack[]
  arbitration: DiagnosticArbitration | null
  candidate: StoredCandidate<CandidatePayload> | null
  sourcePath: string | null
}

/** One embedded text track that was read and went through A–I. */
interface TextRead {
  label: string
  attempt: AlignAttempt
  ev: AlignTrackEvidence
  /** The track's own times, as extracted: the family rule's input. */
  raw: Cue[]
  read: SideRead
  sha: string
  r: IndependentAlignment
  call: number
}
type UsableRead = TextRead & { r: Extract<IndependentAlignment, { verdict: 'accept' | 'check' }> }

const newRunState = (): RunState => ({ stage: 'input', recorder: null, outcome: null, tracks: [], arbitration: null, candidate: null, sourcePath: null })

/** Where the diagnostic's Save dialog opens: beside the subtitle, named after it. */
function diagnosticDefaultPath(sourcePath: string): string {
  const parsed = path.parse(sourcePath)
  return path.join(parsed.dir, `${parsed.name}.timing-diagnostic.json`)
}

/** The deciding A–I call as the diagnostic's outcome. */
function outcomeOf(r: IndependentAlignment, call: number | null): DiagnosticOutcome {
  if (r.verdict === 'refuse') return { verdict: 'refuse', reason: r.reason, transform: null, keptIdentity: false, vectorSha256: null, call }
  return {
    verdict: r.verdict,
    reason: r.reason,
    transform: { scale: r.transform.scale, offsetMs: r.transform.offsetMs },
    keptIdentity: r.evidence.identity?.keptIdentity === true,
    vectorSha256: vectorSha256(r.cues),
    call
  }
}

/** The copy of the conflict refusal (§16.0.8). */
export const EMBEDDED_CONFLICT_MESSAGE = 'The embedded subtitle tracks disagree, and the audio could not settle it. Nothing was changed.'
export const EMBEDDED_TRACKS_REFERENCE = 'Embedded subtitle tracks'
/** A parsed embedded track with more cues than this is `too_large` (the diagnostic's per-track bound). */
export const ALIGN_TRACK_MAX_CUES = DIAGNOSTIC_LIMITS.cuesPerList

/**
 * A transcription the user has been offered and not yet answered. Bound to the exact source bytes and the
 * media file it was measured on; the transcript lands in `dir`, which main owns and removes.
 */
interface OfferEntry {
  token: string
  generation: number
  sourcePath: string
  sourceSha: string
  mediaPath: string
  dir: string
  outputPath: string
  attempts: AlignAttempt[]
}

const ABORTED: unique symbol = Symbol('aborted')

/** One claim on the service's single ALASS slot. */
interface AlassClaim {
  owner: { returned: Promise<void>; orphan: boolean }
  returned(): void
  release(): void
}

/** `work`, or `ABORTED` as soon as `signal` fires — the work itself carries on if it cannot be stopped. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

/** One analysis's scratch folder, made on first use and removed once its last background task settles. */
class Scratch {
  private dir: string | null = null
  private readonly adopted: string[] = []
  private readonly pending: Promise<unknown>[] = []
  constructor(
    private readonly make: (prefix: string) => string,
    private readonly remove: (dir: string) => boolean
  ) {}
  file(name: string): string {
    return path.join(this.folder(), name)
  }
  folder(): string {
    if (!this.dir) this.dir = this.make('ng-align-')
    return this.dir
  }
  /** Another folder this analysis now owns (a consumed transcription offer's): removed with this one. */
  adopt(dir: string): void {
    this.adopted.push(dir)
  }
  track<T>(work: Promise<T>): Promise<T> {
    this.pending.push(work.catch(() => undefined))
    return work
  }
  /** The folders that could not be removed; the caller keeps owning them. */
  async release(): Promise<string[]> {
    await Promise.allSettled(this.pending)
    return [...(this.dir ? [this.dir] : []), ...this.adopted].filter((dir) => !this.remove(dir))
  }
}

function isGeneration(g: unknown): g is number {
  return typeof g === 'number' && Number.isSafeInteger(g) && g > 0
}

function isFilePath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && path.isAbsolute(p)
}

function parseReference(r: unknown): AlignReference | null {
  if (!r || typeof r !== 'object') return null
  const ref = r as { kind?: unknown; path?: unknown }
  if ((ref.kind === 'subtitle' || ref.kind === 'media') && isFilePath(ref.path)) return { kind: ref.kind, path: ref.path }
  return null
}

function trackLabel(t: SubtitleTrack): string {
  return `Embedded track ${t.index + 1} (${t.codec}${t.lang ? `, ${t.lang}` : ''})`
}

export function createAlignService(overrides: Partial<AlignServiceDeps> = {}): AlignService {
  const deps: AlignServiceDeps = { ...defaultAlignDeps(), ...overrides }
  /** The generation high-water mark and the one live outcome (Bundle M §16.0.5). */
  const store = new AlignmentResultStore<HeldDiagnostic, CandidatePayload>()
  let active: { generation: number; controller: AbortController } | null = null
  let applying = false
  let exporting = false
  const cleanups = new Set<Promise<void>>()
  let offer: OfferEntry | null = null
  /**
   * Folders this service made and must still remove: retired offers (a live job may still be writing
   * one) and any folder whose removal failed. A folder leaves this set only once it is gone.
   */
  const owned = new Set<string>()
  /** Folders whose removal has failed at least once; named to the user until they are gone. */
  const failing = new Set<string>()
  /** Problems found looking for an earlier session's folders; said once, with the next analysis. */
  const startupNotes: string[] = []
  /** Earlier sessions kept because they still hold an engine lease; Align never deletes them. */
  const held = new Set<string>()
  /** This session's transcript folders kept because the engine that wrote into them has not been seen to close. */
  const deferred = new Set<string>()
  /**
   * The one ALASS run allowed at a time, claimed before the sidecar is awaited and kept while it runs,
   * while it is being stopped and, when its tree outlived every kill, until its pipes are seen to close.
   * `orphan` is that last case: its folder and session lease stay, and Advanced reports busy. A newer
   * Advanced request waits for `returned` instead of starting a second tree beside it.
   */
  let alassOwner: { returned: Promise<void>; orphan: boolean } | null = null

  const sessionsDir = (): string => path.join(deps.tempRoot(), ALIGN_TEMP_DIR)
  let session: string | null = null
  const sessionDir = (): string => {
    if (session && fs.existsSync(session)) return session
    // Another instance may remove the empty parent between the two calls; that is the one retry.
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.mkdirSync(sessionsDir(), { recursive: true })
        session = fs.mkdtempSync(path.join(sessionsDir(), `${deps.pid()}-`))
        return session
      } catch (e) {
        if (attempt >= 2 || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    }
  }
  const makeDir = (prefix: string): string => fs.mkdtempSync(path.join(sessionDir(), prefix))
  /** An emptied session folder goes, and the parent too when no other instance has one in it. */
  const tidySessions = (): void => {
    if (session) {
      try {
        fs.rmdirSync(session)
        session = null
      } catch {
        /* still holds folders */
      }
    }
    try {
      fs.rmdirSync(sessionsDir())
    } catch {
      /* another session is in it, or it is already gone */
    }
  }
  const removeOwned = (dir: string): boolean => {
    // A transcript folder is the engine's output folder: while its session holds a lease, the engine
    // has not been seen to close, and nothing else proves it has stopped writing.
    const above = path.basename(dir).startsWith('ng-align-tx-') ? sessionAbove(dir) : null
    if (above && fs.existsSync(dir) && sessionLeased(above)) {
      deferred.add(dir)
      return false
    }
    deferred.delete(dir)
    try {
      deps.io.removeDir(dir)
    } catch {
      /* judged by what is left on disk */
    }
    const gone = !fs.existsSync(dir)
    if (gone) {
      failing.delete(dir)
      tidySessions()
    } else failing.add(dir)
    return gone
  }
  const cleanupNotice = (): string | undefined => {
    const notes = startupNotes.splice(0)
    if (failing.size > 0) {
      const n = failing.size
      notes.push(
        `Align could not yet delete ${n === 1 ? 'a temporary folder' : `${n} temporary folders`} that may hold transcript text: ${[...failing].join('; ')}. ` +
          `It keeps trying while the app runs, and again when the app next starts; you can also delete ${n === 1 ? 'it' : 'them'} yourself.`
      )
    }
    for (const dir of [...deferred]) {
      if (!fs.existsSync(dir)) {
        deferred.delete(dir)
        continue
      }
      notes.push(
        `Align is keeping a temporary folder, ${dir}, because the transcription engine that wrote into it has not been seen to end. ` +
          'It is deleted once the engine ends; if no transcription is running, you can delete it yourself.'
      )
    }
    for (const dir of [...held]) {
      if (!fs.existsSync(dir)) {
        held.delete(dir)
        continue
      }
      notes.push(
        `Align is keeping a temporary folder from an earlier session, ${dir}: a transcription or alignment engine started there was never seen to end, so it may still be writing into it. ` +
          'Align will not delete it. Once no transcription or alignment engine (gst, alass) is running, delete the folder yourself.'
      )
    }
    return notes.length > 0 ? notes.join(' ') : undefined
  }
  /** An earlier session is reclaimed only when it holds no engine lease; one that does is kept and named. */
  const judgeSession = (dir: string): void => {
    if (sessionLeased(dir)) held.add(dir)
    else {
      held.delete(dir)
      owned.add(dir)
    }
  }

  let sweepTimer: ReturnType<typeof setTimeout> | null = null
  let failedSweeps = 0
  const sweepOwned = (): void => {
    if (sweepTimer) clearTimeout(sweepTimer)
    sweepTimer = null
    let delay = RETIRED_SWEEP_MS
    if (!deps.jobRunning()) {
      for (const dir of [...owned]) if (removeOwned(dir)) owned.delete(dir)
      if (owned.size > 0) {
        failedSweeps += 1
        delay = Math.min(RETIRED_SWEEP_MS * 2 ** failedSweeps, RETIRED_RETRY_MAX_MS)
      }
    }
    if (owned.size === 0) {
      failedSweeps = 0
      return
    }
    sweepTimer = setTimeout(sweepOwned, delay)
    sweepTimer.unref?.()
  }
  /** The current offer stops being answerable; its folder goes now, or once no job could be writing it. */
  const retireOffer = (): void => {
    if (offer) owned.add(offer.dir)
    offer = null
    sweepOwned()
  }

  const live = (generation: number): boolean => store.live(generation)
  const report = (generation: number, label: string, pctDone: number | null = null): void => {
    if (live(generation)) deps.progress({ generation, label, pct: pctDone })
  }
  const refused = (generation: number, r: Refusal): AlignAnalysis => ({
    status: 'refused',
    generation,
    verdict: 'refuse',
    reason: r.reason,
    message: r.message,
    evidence: r.evidence,
    alignment: r.alignment ?? null,
    ...(r.advanced ? { advanced: r.advanced } : {})
  })
  /**
   * An A–I refusal, carried with its verdict in the shared contract. `call` is the deciding call's
   * diagnostic id; a refusal decided by arbitration has already recorded its own outcome.
   */
  const judgedRefusal = (
    generation: number,
    r: Extract<IndependentAlignment, { verdict: 'refuse' }>,
    judged: Judged,
    source: LoadedSubtitle,
    message: string,
    evidence: AlignEvidence,
    st: RunState,
    call: number | null
  ): AlignAnalysis => {
    st.stage = 'ai'
    st.outcome = outcomeOf(r, call)
    return refused(generation, { reason: r.reason, message, evidence, alignment: alignmentContract(r, judged, source.repaired?.file ?? source.cues), advanced: judged.advanced })
  }

  /**
   * The accept/check candidate: written, encoded and held for preview and Apply. `referenceShas` are the
   * digests of what the map was measured against; with the source's and the candidate's they make the id.
   */
  function keep(
    generation: number,
    source: LoadedSubtitle,
    inputs: string[],
    r: Extract<IndependentAlignment, { verdict: 'accept' | 'check' }>,
    evidence: AlignEvidence,
    judged: Judged,
    st: RunState,
    referenceShas: string[],
    call: number | null
  ): AlignAnalysis {
    if (st.stage !== 'arbitration') st.stage = 'ai'
    st.outcome = outcomeOf(r, call)
    // A repaired source was analysed on its tidied view; the written copy is the file's own cues in file
    // order with the view's times, and check W must pass on it before writing and on the read-back.
    const fix = source.repaired
    const file = fix ? fix.file : source.cues
    const written = fix ? writeBack(fix.file, fix.repair, r.cues) : r.cues
    const notWritten = (issues: string[]): AlignAnalysis => {
      st.stage = 'write'
      return refused(generation, {
        reason: 'invariant_failure',
        message: 'The aligned subtitle could not be written as SubRip, so there is no result.',
        evidence,
        alignment: alignmentContract(
          { profile: 'independent-align', verdict: 'refuse', reason: 'invariant_failure', evidence: { ...r.evidence, issues: [...r.evidence.issues, ...issues] } },
          judged,
          file
        ),
        advanced: judged.advanced
      })
    }
    if (fix) {
      const wrong = checkWritten(fix.file, fix.repair, written)
      if (wrong.length > 0) return notWritten(wrong)
    }
    let text: string | null
    try {
      text = retimeSubRipText(source.text, written)
    } catch {
      text = null
    }
    // Read back, the copy must be the source's own cues with the new times and nothing else changed.
    const back = text === null ? null : parseCues(text, { path: source.path })
    const same =
      back?.ok === true &&
      back.cues.length === written.length &&
      back.cues.every((c, i) => c.startMs === written[i].startMs && c.endMs === written[i].endMs && c.text === file[i].text)
    if (text === null || !same) return notWritten(['round_trip'])
    if (fix && back?.ok) {
      const wrong = checkWritten(fix.file, fix.repair, back.cues)
      if (wrong.length > 0) return notWritten(wrong)
    }
    const bytes = encodeSubtitleText(text, source.encoding)
    if (!bytes) {
      st.stage = 'write'
      return refused(generation, {
        reason: 'source_unreadable',
        message: 'The subtitle holds a character its own encoding cannot write back, so an aligned copy would not keep the same text.',
        evidence,
        advanced: judged.advanced
      })
    }
    const parsed = path.parse(source.path)
    const candidate = makeCandidate(
      bytes,
      {
        sourceSha: source.sha256,
        referenceShas,
        verdict: r.verdict,
        reason: r.reason,
        scale: judged.mode === 'global' ? r.transform.scale : null,
        offsetMs: judged.mode === 'global' ? r.transform.offsetMs : null
      },
      { sourcePath: source.path, inputs, before: file, after: written, defaultPath: path.join(parsed.dir, `${parsed.name}.aligned.srt`) }
    )
    st.candidate = candidate
    return {
      status: 'result',
      generation,
      resultId: candidate.resultId,
      verdict: r.verdict,
      reason: r.reason,
      evidence,
      preview: page(candidate.payload, 0, ALIGN_PREVIEW_PAGE),
      mode: judged.mode,
      alignment: alignmentContract({ ...r, cues: written }, judged, file),
      ...(judged.advanced ? { advanced: judged.advanced } : {})
    }
  }

  function page(entry: CandidatePayload, from: number, count: number): AlignPreview {
    const start = Math.max(0, Math.min(from, entry.before.length))
    const rows = entry.before.slice(start, start + count).map((c, i) => {
      const o = entry.after[start + i]
      return { index: c.index, startMs: c.startMs, endMs: c.endMs, newStartMs: o.startMs, newEndMs: o.endMs, text: c.text }
    })
    return { total: entry.before.length, from: start, rows }
  }

  async function run(
    generation: number,
    sourcePath: string,
    reference: AlignReference,
    signal: AbortSignal,
    scratch: Scratch,
    consent: OfferEntry | null,
    mode: AlignmentMode,
    st: RunState
  ): Promise<AlignAnalysis | typeof ABORTED> {
    report(generation, 'Reading the subtitle…')
    const loaded = loadSubtitle(sourcePath, 'source')
    if (!loaded.ok) return refused(generation, loaded.refusal)
    if (consent && loaded.sub.sha256 !== consent.sourceSha) {
      return refused(generation, { reason: 'offer_expired', message: 'The subtitle changed after the transcription was offered. Nothing was aligned; analyze again.', evidence: null })
    }

    // Structure alone, before any reference work. Order/duration problems within budget are read past on
    // a tidied view, which every chain below analyses; `keep` writes the file's own order (§9.4c R5).
    const read = readSide('source', loaded.sub.cues)
    if (read.kind === 'refused') {
      const evidence = evidenceOf('None (stopped at the subtitle check)', { ...read.evidence, referenceCues: 0, issues: read.issues }, [])
      return refused(generation, { reason: 'malformed', message: refusalMessage('malformed', evidence) + overBudget(read, 'malformed'), evidence })
    }
    const source: LoadedSubtitle =
      read.kind === 'repaired' ? { ...loaded.sub, cues: read.repair.view, repaired: { repair: read.repair, file: loaded.sub.cues } } : loaded.sub
    if (signal.aborted) return ABORTED
    st.sourcePath = source.path

    if (mode === 'piecewise' && !consent) return piecewise(generation, source, reference, signal, st)
    st.recorder = new DiagnosticRecorder(source.cues)
    if (consent) return fromTranscript(generation, source, consent, st)

    if (reference.kind === 'subtitle') {
      report(generation, 'Reading the reference…')
      const ref = loadSubtitle(reference.path, 'reference')
      if (!ref.ok) return refused(generation, ref.refusal)
      report(generation, 'Comparing timelines…')
      const refRead = readSide('reference', ref.sub.cues)
      const refCues = readCues(refRead, ref.sub.cues)
      const r = alignSubtitles('independent-align', source.cues, refCues, 'subtitle')
      const call = st.recorder.call('subtitle', null, refCues, r)
      const attempts: AlignAttempt[] = [{ reference: 'Subtitle file', verdict: r.verdict, reason: r.reason }]
      const evidence = disclosed(evidenceOf('Subtitle file', r.evidence, attempts), source, refRead)
      if (r.verdict === 'refuse') return judgedRefusal(generation, r, GLOBAL_SUBTITLE, source, refusalMessage(r.reason, evidence) + overBudget(refRead, r.reason), evidence, st, call)
      return keep(generation, source, [source.path, ref.sub.path], r, evidence, GLOBAL_SUBTITLE, st, [ref.sub.sha256], call)
    }

    return analyzeMedia(generation, source, reference.path, signal, scratch, st)
  }

  /**
   * Bundle M §16.0.2: every allow-listed text track in one FFmpeg run, under an engine lease on the
   * session from before the run starts until nothing of it can still write. `null` when there is nothing
   * to extract; `ABORTED` at once on Cancel, the run itself finishing (or being waited out) behind it.
   */
  async function extractAll(
    generation: number,
    mediaPath: string,
    indices: number[],
    signal: AbortSignal,
    scratch: Scratch
  ): Promise<{ ok: boolean; dir: string } | typeof ABORTED> {
    const what = 'Checking embedded subtitle tracks…'
    report(generation, what)
    const dir = scratch.folder()
    const lease = leaseSession(sessionDir())
    const run = Promise.resolve().then(() =>
      deps.extractTextTracks(mediaPath, indices, dir, { ffmpegPath: deps.ffmpegPath(), signal, onProgress: (p) => report(generation, what, p) })
    )
    // A run that never started a process, or returned with nothing left running, releases at once; an
    // orphaned child holds the lease (and with it the folder) until its own `close`.
    scratch.track(
      run
        .then((out) => out.closed)
        .catch(() => undefined)
        .finally(() => lease.release())
    )
    let out: Awaited<typeof run> | typeof ABORTED
    try {
      out = await untilAborted(run, signal)
    } catch (e) {
      out = { ok: false, error: (e as Error).message }
    }
    if (out === ABORTED || out.aborted || signal.aborted) return ABORTED
    return { ok: out.ok, dir }
  }

  /**
   * Bundle M §16.0.3: every embedded text track runs A–I on its own; the usable ones are decided between
   * (sides within T on the source's cues, one witness per family, the unique largest side, the audio for
   * a tie). Only when no track is usable does the landed chain go on: the audio, then the offer.
   */
  async function analyzeMedia(generation: number, source: LoadedSubtitle, media: string, signal: AbortSignal, scratch: Scratch, st: RunState): Promise<AlignAnalysis | typeof ABORTED> {
    if (!fs.existsSync(media) || !fs.statSync(media).isFile()) {
      return refused(generation, { reason: 'media_unreadable', message: 'The media file could not be found.', evidence: null })
    }
    const mediaPath = canonical(media)
    const ffmpegPath = deps.ffmpegPath()
    report(generation, 'Listing the subtitle tracks…')
    let tracks: SubtitleTrack[]
    try {
      const listed = await untilAborted(scratch.track(deps.probeTracks(mediaPath, ffmpegPath)), signal)
      if (listed === ABORTED) return ABORTED
      tracks = listed
    } catch (e) {
      return refused(generation, { reason: 'media_unreadable', message: `The media file's tracks could not be read: ${(e as Error).message}`, evidence: null })
    }

    const recorder = st.recorder as DiagnosticRecorder
    const plan = alignTrackPlan(tracks)
    const text = tracks.filter((t) => !t.isImage)
    let extracted: { ok: boolean; dir: string } | null = null
    if (plan.map.length > 0) {
      let out: { ok: boolean; dir: string } | typeof ABORTED
      try {
        out = await extractAll(generation, mediaPath, plan.map.map((t) => t.index), signal, scratch)
      } catch (e) {
        return refused(generation, { reason: 'analysis_failed', message: `Align could not prepare a temporary folder for the subtitle tracks: ${(e as Error).message}. Nothing was changed.`, evidence: null })
      }
      if (out === ABORTED) return ABORTED
      extracted = out
    }

    // Each track, in stream order: listed, unread, set aside, or through A–I on its own.
    const attempts: AlignAttempt[] = []
    const evidenceTracks: AlignTrackEvidence[] = []
    const reads: TextRead[] = []
    for (const t of tracks) {
      const label = trackLabel(t)
      const ordinal = t.index + 1
      const kind: AlignTrackEvidence['kind'] = t.isImage ? 'image' : ALIGN_TEXT_CODECS.includes(t.codec) ? 'text' : 'not_text'
      const ev: AlignTrackEvidence = { ordinal, codec: t.codec, kind, outcome: 'listed', family: null, side: null, verdict: null, reason: null, vectorSha256: null }
      evidenceTracks.push(ev)
      const skip = (reason: string, outcome: AlignTrackEvidence['outcome']): void => {
        attempts.push({ reference: label, verdict: 'skipped', reason })
        ev.outcome = outcome
        ev.reason = reason
      }
      const listed = plan.listed.get(t.index)
      if (listed) {
        skip(listed, 'listed')
        continue
      }
      const file = extracted ? textTrackFile(extracted.dir, t.index) : ''
      if (!extracted?.ok || !fs.existsSync(file)) {
        skip('extract_failed', 'unread')
        continue
      }
      // Bounded before anything is read: `-fs` cuts an output at the cap, so a file that reaches it is incomplete.
      if (fs.statSync(file).size >= ALIGN_TRACK_MAX_BYTES) {
        skip('too_large', 'excluded')
        continue
      }
      const ref = loadSubtitle(file, 'reference')
      if (!ref.ok) {
        skip(ref.refusal.reason, 'excluded')
        continue
      }
      if (ref.sub.cues.length > ALIGN_TRACK_MAX_CUES) {
        skip('too_large', 'excluded')
        continue
      }
      report(generation, `Comparing timelines with embedded track ${ordinal}…`)
      const read = readSide('reference', ref.sub.cues)
      const cues = readCues(read, ref.sub.cues)
      const r = alignSubtitles('independent-align', source.cues, cues, 'embedded')
      const call = recorder.call('embedded', ordinal, cues, r)
      const attempt: AlignAttempt = { reference: label, verdict: r.verdict, reason: r.reason }
      attempts.push(attempt)
      ev.outcome = r.verdict === 'refuse' ? 'refused' : 'usable'
      ev.verdict = r.verdict
      ev.reason = r.reason
      reads.push({ label, attempt, ev, raw: ref.sub.cues, read, sha: ref.sub.sha256, r, call })
      if (signal.aborted) return ABORTED
    }
    const family = trackFamilies(reads.map((x) => x.raw))
    reads.forEach((x, i) => (x.ev.family = family[i]))
    const usable = reads.filter((x): x is UsableRead => x.r.verdict !== 'refuse')
    if (usable.length > 0) return arbitrate(generation, source, mediaPath, signal, st, usable, reads, attempts, evidenceTracks)

    let best: { r: Extract<IndependentAlignment, { verdict: 'refuse' }>; label: string; read: SideRead; call: number } | null = null
    for (const x of reads) {
      if (x.r.verdict !== 'refuse') continue
      if (!best || (x.r.evidence.fit?.coveragePct ?? -1) > (best.r.evidence.fit?.coveragePct ?? -1)) best = { r: x.r, label: x.label, read: x.read, call: x.call }
    }

    // No embedded text track is usable (tester 2026-10-07): only now the audio.
    const tried = attempts.filter((a) => a.verdict === 'refuse').length
    const embedded = best
      ? `${tried === 1 ? 'The one text track' : `None of the ${tried} text tracks`} gives one global map (closest, ${best.label}: ${pct(best.r.evidence.fit?.coveragePct ?? null)}% of dialogue lines fit). `
      : tracks.length === 0
        ? 'The media file has no subtitle tracks. '
        : text.length === 0
          ? 'The media file has only image subtitle tracks (pictures, not text). '
          : 'None of the media file\'s text tracks could be read as SubRip. '
    const listening = 'Listening for speech in the audio (on this computer; nothing is uploaded)…'
    report(generation, listening)
    let audio: AlignmentAudio
    try {
      audio = await deps.audioForAlignment(mediaPath, { ffmpegPath, signal, onProgress: (p) => report(generation, listening, p) })
    } catch (e) {
      audio = { ok: false, error: (e as Error).message }
    }
    if (signal.aborted || (!audio.ok && audio.aborted)) return ABORTED
    if (!audio.ok) {
      // Audio that cannot be decoded was never a reference: the stop stays the first thing missing.
      const unusable = `${embedded}The audio could not be used either: ${audio.error}`
      if (best) return judgedRefusal(generation, best.r, globalAgainst('embedded'), source, unusable, disclosed(evidenceOf(best.label, best.r.evidence, attempts), source, best.read), st, best.call)
      return refused(generation, { reason: 'no_text_reference', message: unusable, evidence: noEvidence(source, attempts) })
    }

    report(generation, 'Comparing the subtitle with the speech in the audio…')
    const picked = pickAudioCandidate(source.cues, audio.candidates)
    if (!picked) {
      attempts.push({ reference: AUDIO_REFERENCE_LABEL, verdict: 'skipped', reason: 'audio_unusable' })
      const noSpeech = `${embedded}No speech was found in the audio at any detector setting.`
      if (best) return judgedRefusal(generation, best.r, globalAgainst('embedded'), source, noSpeech, disclosed(evidenceOf(best.label, best.r.evidence, attempts), source, best.read), st, best.call)
      return refused(generation, { reason: 'audio_unusable', message: noSpeech, evidence: noEvidence(source, attempts) })
    }
    const r = picked.result
    const audioCall = recorder.call('audio', null, spanCues(picked.candidate), r)
    attempts.push({ reference: AUDIO_REFERENCE_LABEL, verdict: r.verdict, reason: r.reason })
    const evidence = disclosed(evidenceOf(AUDIO_REFERENCE_LABEL, r.evidence, attempts), source, null)
    if (r.verdict !== 'refuse') return keep(generation, source, [source.path, mediaPath], r, evidence, globalAgainst('audio'), st, [audioSha(picked.candidate)], audioCall)

    const audioSaid = `The speech in the audio gives no safe global map either: ${refusalMessage(r.reason, evidence)}`
    const tx = deps.transcriptionModel()
    const enoughLines = r.evidence.sourceDialogue >= INDEPENDENT_PROFILE.minDialogueCues
    if (!enoughLines || !tx.supported || !(audio.durationSeconds > 0)) {
      const why = !enoughLines
        ? ''
        : !tx.supported
          ? ` A transcription could give more timing anchors, but the transcription model in Settings (${tx.model || 'none'}) cannot transcribe.`
          : ''
      return judgedRefusal(generation, r, globalAgainst('audio'), source, `${embedded}${audioSaid}${why}`, evidence, st, audioCall)
    }
    retireOffer()
    const dir = makeDir('ng-align-tx-')
    offer = {
      token: crypto.randomBytes(16).toString('hex'),
      generation,
      sourcePath: source.path,
      sourceSha: source.sha256,
      mediaPath,
      dir,
      outputPath: path.join(dir, 'transcript.srt'),
      attempts: attempts.map((a) => ({ ...a }))
    }
    const estimate = transcriptionEstimate(audio.durationSeconds)
    return {
      ...judgedRefusal(generation, r, globalAgainst('audio'), source, `${embedded}${audioSaid}`, evidence, st, audioCall),
      transcriptionOffer: {
        token: offer.token,
        model: tx.model,
        outputPath: offer.outputPath,
        audioSeconds: Math.round(audio.durationSeconds),
        requests: estimate.requests,
        estimateMinutes: estimate.estimateMinutes
      }
    } as AlignAnalysis
  }

  /**
   * §16.0.3 steps 3–8 over the usable tracks. Sides within T on the source's own moved cues, one witness
   * per family, the unique largest side wins; a tie goes to the audio once, and only an `accept`/`check`
   * audio map within T of exactly one tied side settles it. Anything else is the conflict refusal: no
   * candidate, no transcription offer and no Try piecewise.
   */
  async function arbitrate(
    generation: number,
    source: LoadedSubtitle,
    mediaPath: string,
    signal: AbortSignal,
    st: RunState,
    usable: UsableRead[],
    reads: TextRead[],
    attempts: AlignAttempt[],
    evidenceTracks: AlignTrackEvidence[]
  ): Promise<AlignAnalysis | typeof ABORTED> {
    const recorder = st.recorder as DiagnosticRecorder
    const byOrdinal = new Map(usable.map((x) => [x.ev.ordinal, x]))
    const arb = arbitrateTracks(
      usable.map((x): ArbitrationTrack => ({ ordinal: x.ev.ordinal, family: x.ev.family as number, verdict: x.r.verdict, cues: x.r.cues }))
    )
    for (const s of arb.sides) for (const m of s.members) (byOrdinal.get(m) as UsableRead).ev.side = s.id
    for (const m of arb.splitFamily) (byOrdinal.get(m) as UsableRead).attempt.reason = 'split_family'

    let winner: number | null = arb.leaders.length === 1 ? arb.leaders[0] : null
    let audioCall: number | null = null
    if (arb.leaders.length > 1) {
      const listening = 'Listening for speech in the audio (on this computer; nothing is uploaded)…'
      report(generation, listening)
      let audio: AlignmentAudio
      try {
        audio = await deps.audioForAlignment(mediaPath, { ffmpegPath: deps.ffmpegPath(), signal, onProgress: (p) => report(generation, listening, p) })
      } catch (e) {
        audio = { ok: false, error: (e as Error).message }
      }
      if (signal.aborted || (!audio.ok && audio.aborted)) return ABORTED
      const picked = audio.ok ? pickAudioCandidate(source.cues, audio.candidates) : null
      if (!picked) attempts.push({ reference: AUDIO_REFERENCE_LABEL, verdict: 'skipped', reason: 'audio_unusable' })
      else {
        const r = picked.result
        audioCall = recorder.call('audio', null, spanCues(picked.candidate), r)
        attempts.push({ reference: AUDIO_REFERENCE_LABEL, verdict: r.verdict, reason: r.reason })
        if (r.verdict !== 'refuse') winner = audioSettles(arb, (o) => (byOrdinal.get(o) as UsableRead).r.cues, r.cues)
      }
    }
    const tieBroken = arb.leaders.length > 1 && winner !== null ? 'audio' : null
    // Every usable track off the winning side lost, unless it was already named as split.
    for (const s of arb.sides) {
      if (winner === null ? arb.leaders.includes(s.id) : s.id === winner) continue
      for (const m of s.members) {
        const x = byOrdinal.get(m) as UsableRead
        if (x.attempt.reason !== 'split_family') x.attempt.reason = 'outvoted'
      }
    }
    for (const x of usable) x.ev.vectorSha256 = vectorSha256(x.r.cues)

    const side = arb.sides.find((s) => s.id === winner) ?? null
    const lowestCheck = side
      ? side.members.map((m) => (byOrdinal.get(m) as UsableRead).r).filter((r) => r.verdict === 'check').map((r) => r.evidence.fit?.coveragePct ?? null)
      : []
    const arbitration: AlignArbitration = {
      tolerance: arb.tolerance,
      sides: arb.sides.map((s) => ({ id: s.id, representative: s.representative, members: [...s.members], witnesses: s.witnesses.length })),
      winner,
      tieBroken,
      checkCoveragePct:
        side?.verdict === 'check' && lowestCheck.every((c): c is number => c !== null) ? Math.min(...lowestCheck) : null
    }
    st.stage = 'arbitration'
    st.tracks = evidenceTracks.map((e) => ({
      ordinal: e.ordinal,
      codec: e.codec,
      kind: e.kind,
      outcome: e.outcome,
      family: e.family,
      side: e.side,
      call: reads.find((x) => x.ev === e)?.call ?? null
    }))
    st.arbitration = {
      tolerance: arbitration.tolerance,
      sides: arbitration.sides.map((s) => ({ ...s, members: [...s.members] })),
      winner,
      tieBroken,
      audioCall
    }
    const withTracks = (e: AlignEvidence): AlignEvidence => ({ ...e, tracks: evidenceTracks.map((t) => ({ ...t })), arbitration })

    if (!side) {
      st.outcome = { verdict: 'refuse', reason: 'embedded_track_conflict', transform: null, keptIdentity: false, vectorSha256: null, call: null }
      return refused(generation, {
        reason: 'embedded_track_conflict',
        message: EMBEDDED_CONFLICT_MESSAGE,
        evidence: withTracks({ ...noEvidence(source, attempts), reference: EMBEDDED_TRACKS_REFERENCE })
      })
    }
    const rep = byOrdinal.get(side.representative) as UsableRead
    const r: Extract<IndependentAlignment, { verdict: 'accept' | 'check' }> =
      side.verdict === rep.r.verdict ? rep.r : { ...rep.r, verdict: 'check', reason: 'partial_coverage' }
    const evidence = withTracks(disclosed(evidenceOf(rep.label, r.evidence, attempts), source, rep.read))
    const shas = side.members.map((m) => (byOrdinal.get(m) as UsableRead).sha)
    return keep(generation, source, [source.path, mediaPath], r, evidence, globalAgainst('embedded'), st, shas, rep.call)
  }

  /**
   * The consented transcription has run (the normal Transcribe run, started by the page with this offer's
   * `outputPath`). Its cue times are anchors for the one global fit and nothing else: the result is the
   * source's own cues moved by that map, judged by the same complete A–I gate. A transcript that is
   * missing, unreadable or structurally broken is refused; only out-of-order and zero- or negative-length
   * timings within the repair budget are read past on a tidied copy (§9.4c R5).
   */
  function fromTranscript(generation: number, source: LoadedSubtitle, consent: OfferEntry, st: RunState): AlignAnalysis {
    const recorder = st.recorder as DiagnosticRecorder
    const attempts = consent.attempts.map((a) => ({ ...a }))
    report(generation, 'Reading the transcript…')
    if (!fs.existsSync(consent.outputPath)) {
      attempts.push({ reference: TRANSCRIPT_REFERENCE_LABEL, verdict: 'skipped', reason: 'transcription_failed' })
      return refused(generation, {
        reason: 'transcription_failed',
        message: 'The transcription did not produce a transcript, so there was nothing to compare with. Nothing was changed.',
        evidence: noEvidence(source, attempts)
      })
    }
    const t = loadSubtitle(consent.outputPath, 'reference')
    if (!t.ok) {
      const broken = t.refusal.reason === 'malformed' && !/no subtitle timings/.test(t.refusal.message)
      attempts.push({ reference: TRANSCRIPT_REFERENCE_LABEL, verdict: 'skipped', reason: broken ? 'malformed' : 'transcription_failed' })
      return refused(generation, {
        reason: broken ? 'malformed' : 'transcription_failed',
        message: broken
          ? `The transcript's timings cannot be used as anchors: ${t.refusal.message.replace(/^The reference subtitle /, 'it ')}`
          : 'The transcript was empty or unreadable, so there was nothing to compare with. Nothing was changed.',
        evidence: noEvidence(source, attempts)
      })
    }
    report(generation, 'Comparing the subtitle with the transcript\'s timings…')
    const tRead = readSide('reference', t.sub.cues)
    const tCues = readCues(tRead, t.sub.cues)
    const r = alignSubtitles('independent-align', source.cues, tCues, 'transcription')
    const call = recorder.call('transcription', null, tCues, r)
    attempts.push({ reference: TRANSCRIPT_REFERENCE_LABEL, verdict: r.verdict, reason: r.reason })
    const evidence = disclosed(evidenceOf(TRANSCRIPT_REFERENCE_LABEL, r.evidence, attempts), source, tRead)
    if (r.verdict !== 'refuse') return keep(generation, source, [source.path, consent.mediaPath], r, evidence, globalAgainst('transcription'), st, [t.sub.sha256], call)
    return judgedRefusal(
      generation,
      r,
      globalAgainst('transcription'),
      source,
      `Even with the transcript's timings as anchors there is no safe global map: ${refusalMessage(r.reason, evidence)}${overBudget(tRead, r.reason)} Transcript timings can be off by half a second or more, so Align refuses rather than guess.`,
      evidence,
      st,
      call
    )
  }

  /**
   * Claim the ALASS slot. `returned` wakes waiters once the run is back — by then the slot is either free
   * or held for an orphan. `release` frees it for this claim only; a later claim is never freed by it.
   */
  function claimAlass(): AlassClaim {
    let wake!: () => void
    const owner = { returned: new Promise<void>((r) => (wake = r)), orphan: false }
    alassOwner = owner
    return {
      owner,
      returned: () => wake(),
      release: () => {
        if (alassOwner === owner) alassOwner = null
      }
    }
  }

  /** What is left of an ALASS run once it has returned: its folder, its lease, its slot, and an orphan to wait out. */
  function settleAlass(out: AlassRunResult | AlassSpeechResult, lease: EngineLease, claim: AlassClaim): void {
    const cleanup = out.cleanup
    if (cleanup.removed) {
      lease.release()
      claim.release()
    } else if (cleanup.why === 'remove_failed') {
      lease.release()
      claim.release()
      owned.add(cleanup.dir)
      sweepOwned()
    } else {
      claim.owner.orphan = true
      const dir = cleanup.dir
      // Only the pipes closing proves every holder is gone; the child's own exit does not.
      const closed = !out.ok ? out.orphanClosed : undefined
      // Without that witness the slot, folder and lease stay held (fail closed).
      if (closed) {
        void closed.then(() => {
          lease.release()
          owned.add(dir)
          sweepOwned()
          claim.release()
        })
      }
    }
    claim.returned()
  }

  /** Wait for an earlier ALASS run to come back. False when it left an orphan holding the slot. */
  async function alassSlotFree(generation: number, signal: AbortSignal): Promise<boolean | typeof ABORTED> {
    const aborted = new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))
    while (alassOwner) {
      if (alassOwner.orphan) return false
      if (signal.aborted) return ABORTED
      report(generation, 'Waiting for the previous ALASS run to stop…')
      await Promise.race([alassOwner.returned, aborted])
    }
    return signal.aborted ? ABORTED : true
  }

  /**
   * Advanced: ALASS proposes a piece-by-piece timeline, in this session's folder, under a session lease.
   * Against a subtitle it aligns to that subtitle; against a media file it aligns to its own speech export
   * (WebRTC VAD), and those exported spans are the reference. Its exit code, score and shift groups are
   * diagnostics only; the verdict is `independent-align` over the reparsed output against that same
   * reference (Bundle C item 7). A media reference never uses the Global path's tracks, its 1–4 kHz
   * detector or a transcription, and a refusal here never falls back to any of them.
   */
  async function piecewise(generation: number, source: LoadedSubtitle, reference: AlignReference, signal: AbortSignal, st: RunState): Promise<AlignAnalysis | typeof ABORTED> {
    const busy = (): AlignAnalysis => refused(generation, { reason: 'advanced_unavailable', message: advancedUnavailableMessage('busy'), evidence: null })
    if (alassOwner?.orphan) return busy()
    let against: { kind: 'subtitle'; path: string; cues: Cue[] } | { kind: 'media'; path: string; tools: { ffmpegPath: string; ffprobePath: string } }
    let refRead: SideRead | null = null
    if (reference.kind === 'media') {
      if (!fs.existsSync(reference.path) || !fs.statSync(reference.path).isFile()) {
        return refused(generation, { reason: 'media_unreadable', message: 'The media file could not be found.', evidence: null })
      }
      const tools = deps.alassMediaTools()
      if (!tools) {
        return refused(generation, {
          reason: 'advanced_unavailable',
          message: `Advanced with a video file needs the app's own FFmpeg and FFprobe, and they are not installed with this copy of the app. A subtitle reference still works with Advanced. ${ADVANCED_INTACT}`,
          evidence: null
        })
      }
      against = { kind: 'media', path: canonical(reference.path), tools }
    } else {
      report(generation, 'Reading the reference…')
      const ref = loadSubtitle(reference.path, 'reference')
      if (!ref.ok) return refused(generation, ref.refusal)
      // A broken reference is refused before ALASS spends minutes aligning against it.
      refRead = readSide('reference', ref.sub.cues)
      if (refRead.kind === 'refused') {
        const evidence = disclosed(evidenceOf('Subtitle file', { ...refRead.evidence, sourceCues: source.cues.length, issues: refRead.issues }, []), source, refRead)
        return refused(generation, { reason: 'malformed', message: refusalMessage('malformed', evidence) + overBudget(refRead, 'malformed'), evidence })
      }
      against = { kind: 'subtitle', path: ref.sub.path, cues: readCues(refRead, ref.sub.cues) }
    }
    if (signal.aborted) return ABORTED
    const free = await alassSlotFree(generation, signal)
    if (free === ABORTED) return ABORTED
    if (!free) return busy()

    // Nothing is awaited from here to the claim, so no other request can take the slot in between.
    report(
      generation,
      against.kind === 'media'
        ? 'ALASS is listening for speech in the audio and aligning piece by piece (on this computer; nothing is uploaded)…'
        : 'Aligning piece by piece with ALASS (on this computer; nothing is uploaded)…'
    )
    const alassDeps = deps.alassDeps()
    const claim = claimAlass()
    let lease: EngineLease
    let workParent: string
    try {
      workParent = sessionDir()
      lease = leaseSession(workParent)
    } catch (e) {
      claim.release()
      claim.returned()
      return refused(generation, { reason: 'analysis_failed', message: `Align could not prepare a temporary folder for ALASS: ${(e as Error).message}. Nothing was changed.`, evidence: null })
    }
    let out: AlassRunResult | AlassSpeechResult
    try {
      out =
        against.kind === 'media'
          ? await alignAlassToSpeech({ mode: 'piecewise', input: source.cues, media: { path: against.path, ...against.tools }, workParent, signal }, deps.alassTrust(), alassDeps)
          : await runAlass({ mode: 'piecewise', input: source.cues, reference: { kind: 'srt', cues: against.cues }, workParent, signal }, deps.alassTrust(), alassDeps)
    } catch (e) {
      // The sidecar reports every ending it knows; a throw leaves nothing it could have started.
      lease.release()
      claim.release()
      claim.returned()
      throw e
    }
    settleAlass(out, lease, claim)
    if (signal.aborted || (!out.ok && out.failure === 'cancelled')) return ABORTED
    if (!out.ok) {
      if (out.failure === 'unavailable') {
        return refused(generation, { reason: 'advanced_unavailable', message: advancedUnavailableMessage(out.unavailable ?? 'not_runnable'), evidence: null })
      }
      if (out.failure === 'no_speech') {
        return refused(generation, {
          reason: 'audio_unusable',
          message: 'ALASS found no speech in the media file\u2019s audio, so there was nothing to align with. Nothing was changed.',
          evidence: noEvidence(source, [{ reference: ALASS_AUDIO_REFERENCE_LABEL, verdict: 'skipped', reason: 'audio_unusable' }])
        })
      }
      return refused(generation, { reason: 'advanced_failed', message: advancedFailedMessage(out, alassDeps.limits.timeoutMs, against.kind === 'media'), evidence: null })
    }
    const referenceCues: Cue[] = against.kind === 'subtitle' ? against.cues : ((out as { speech?: Cue[] }).speech ?? [])

    const advanced: AlignAdvancedDiagnostics = {
      engine: `${out.report.engine.name} ${out.report.engine.version}`,
      shiftGroups: out.report.shiftGroups.length,
      score: out.report.score,
      fpsRatio: out.report.fps.ratioLabel
    }
    report(generation, against.kind === 'media' ? 'Checking ALASS\u2019s result against the speech it found…' : 'Checking ALASS\u2019s result against the reference…')
    let text = new TextDecoder('utf-8').decode(out.output)
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed = parseCues(text)
    const media = against.kind === 'media'
    const judged: Judged = { mode: 'piecewise', candidateSource: 'alass-candidate', referenceKind: media ? 'audio' : 'subtitle', advanced }
    const r = judgeCandidate('independent-align', source.cues, parsed.ok ? parsed.cues : null, referenceCues, judged.referenceKind)
    const label = media ? ALASS_AUDIO_REFERENCE_LABEL : 'Subtitle file'
    const attempts: AlignAttempt[] = [{ reference: media ? `${ALASS_AUDIO_REFERENCE_LABEL} (piecewise)` : 'Subtitle file (piecewise, ALASS)', verdict: r.verdict, reason: r.reason }]
    const evidence = disclosed(evidenceOf(label, r.evidence, attempts), source, refRead)
    if (r.verdict === 'refuse') return judgedRefusal(generation, r, judged, source, piecewiseRefusal(r.reason, evidence), evidence, st, null)
    return keep(generation, source, [source.path, against.path], r, evidence, judged, st, [vectorSha256(referenceCues)], null)
  }

  function noEvidence(source: LoadedSubtitle, attempts: AlignAttempt[]): AlignEvidence {
    return disclosed(noReference(source, attempts), source, null)
  }

  /**
   * The one staged write: a new file beside the destination, written and flushed, then promoted by
   * `replaceFile` only while `current()` holds — old-or-new, never half-written. A staged file never
   * outlives a failure.
   */
  async function stagedWrite(
    dest: string,
    bytes: Buffer,
    current: () => boolean
  ): Promise<{ ok: true } | { ok: false; superseded: boolean; message: string }> {
    const io = deps.io
    let staged: string | null = null
    try {
      const stagedName = path.join(path.dirname(dest), `.${path.basename(dest)}.${crypto.randomBytes(6).toString('hex')}.align.tmp`)
      const fd = io.open(stagedName, 'wx')
      staged = stagedName
      try {
        io.write(fd, bytes)
        io.fsync(fd)
      } finally {
        io.close(fd)
      }
      const replaced = await replaceFile(staged, dest, { io: { rename: io.rename, sleep: io.sleep }, isCurrent: current })
      if (!replaced.ok) return replaced.reason === 'superseded' ? { ok: false, superseded: true, message: '' } : { ok: false, superseded: false, message: replaced.message }
      staged = null
      return { ok: true }
    } catch (e) {
      return { ok: false, superseded: false, message: (e as Error).message }
    } finally {
      if (staged) {
        try {
          io.unlink(staged)
        } catch {
          /* nothing was created, or it is already gone */
        }
      }
    }
  }

  function noReference(source: LoadedSubtitle, attempts: AlignAttempt[]): AlignEvidence {
    return {
      reference: 'None',
      sourceCues: source.cues.length,
      referenceCues: 0,
      sourceDialogue: 0,
      referenceDialogue: 0,
      coveragePct: null,
      retainedPct: null,
      pairs: null,
      retained: null,
      vote: null,
      overlap: null,
      scale: null,
      offsetMs: null,
      residualAbsMedianMs: null,
      residualAbsP95Ms: null,
      issues: [],
      attempts: attempts.map((a) => ({ ...a }))
    }
  }

  const service: AlignService = {
    async analyze(req: unknown): Promise<AlignAnalysis> {
      const r = (req ?? {}) as { generation?: unknown; sourcePath?: unknown; reference?: unknown; transcriptionToken?: unknown; mode?: unknown }
      const generation = isGeneration(r.generation) ? r.generation : 0
      const reference = parseReference(r.reference)
      const token = r.transcriptionToken
      const tokenOk = token === undefined || (typeof token === 'string' && /^[0-9a-f]{32}$/.test(token))
      // The mode is the renderer's whole say in what runs; a transcription offer belongs to Global.
      const mode: AlignmentMode | null = r.mode === undefined || r.mode === 'global' ? 'global' : r.mode === 'piecewise' && token === undefined ? 'piecewise' : null
      if (!generation || !isFilePath(r.sourcePath) || !reference || !tokenOk || !mode) {
        return refused(generation, { reason: 'invalid_request', message: 'Choose the subtitle to align and a reference first.', evidence: null })
      }
      if (!store.admit(generation)) return { status: 'stale', generation }
      active?.controller.abort()
      const scratch = new Scratch(makeDir, removeOwned)
      let consent: OfferEntry | null = null
      if (token !== undefined) {
        const o = offer
        const matches =
          o !== null &&
          o.token === token &&
          reference.kind === 'media' &&
          samePath(canonical(reference.path), o.mediaPath) &&
          samePath(canonical(r.sourcePath), canonical(o.sourcePath))
        if (!matches) {
          retireOffer()
          return refused(generation, {
            reason: 'offer_expired',
            message: 'That transcription offer is no longer valid: the files changed, or a newer analysis replaced it. Nothing was aligned; analyze again.',
            evidence: null
          })
        }
        if (deps.jobRunning()) {
          return refused(generation, {
            reason: 'busy',
            message: 'A translation or transcription is still running. When it has finished, try again; the offer is kept.',
            evidence: null
          })
        }
        consent = o
        offer = null
        scratch.adopt(o.dir)
      } else {
        retireOffer()
      }
      const controller = new AbortController()
      active = { generation, controller }
      const st = newRunState()
      try {
        let out: AlignAnalysis | typeof ABORTED
        try {
          out = await run(generation, r.sourcePath, reference, controller.signal, scratch, consent, mode, st)
        } catch (e) {
          out = controller.signal.aborted
            ? ABORTED
            : refused(generation, {
                reason: 'analysis_failed',
                message: `The analysis could not finish: ${(e as Error)?.message ?? String(e)}. Nothing was changed; try again.`,
                evidence: null
              })
        }
        if (out === ABORTED || controller.signal.aborted) {
          store.drop(generation)
          return { status: 'cancelled', generation }
        }
        if (!live(generation)) return { status: 'stale', generation }
        if (out.status !== 'result' && out.status !== 'refused') return out
        // The one snapshot of this generation's final outcome (§16.0.5): its candidate, if any, and its diagnostic, if exportable.
        const v1 =
          st.recorder && st.outcome && (st.stage === 'ai' || st.stage === 'arbitration')
            ? st.recorder.build(st.stage, st.outcome, st.tracks, st.arbitration)
            : null
        const diagnostic: HeldDiagnostic | null = v1 && st.sourcePath ? { v1, defaultPath: diagnosticDefaultPath(st.sourcePath) } : null
        store.put({ generation, stage: st.stage, diagnostic, candidate: out.status === 'result' ? st.candidate : null })
        return diagnostic ? { ...out, diagnosticExportable: true } : out
      } finally {
        if (active?.generation === generation) active = null
        const done = scratch.release().then((left) => {
          if (left.length === 0) return
          for (const dir of left) owned.add(dir)
          sweepOwned()
        })
        cleanups.add(done)
        void done.then(() => cleanups.delete(done))
      }
    },

    cancel(generation: unknown): void {
      if (!isGeneration(generation)) return
      if (active?.generation === generation) active.controller.abort()
      store.drop(generation)
      if (offer?.generation === generation) retireOffer()
    },

    preview(req: unknown): AlignPreview | null {
      const r = (req ?? {}) as { generation?: unknown; resultId?: unknown; from?: unknown; count?: unknown }
      const held = store.candidate(r.generation, r.resultId)
      if (!held) return null
      const from = typeof r.from === 'number' && Number.isSafeInteger(r.from) && r.from >= 0 ? r.from : 0
      const count = typeof r.count === 'number' && Number.isSafeInteger(r.count) && r.count > 0 ? Math.min(r.count, PREVIEW_MAX) : ALIGN_PREVIEW_PAGE
      return page(held.payload, from, count)
    },

    async apply(req: unknown): Promise<AlignApplyResult> {
      const r = (req ?? {}) as { generation?: unknown; resultId?: unknown }
      const generation = r.generation
      const entry = store.candidate(generation, r.resultId)
      const current = (): boolean => entry !== null && store.candidate(generation, entry.resultId) === entry
      if (!entry) return { ok: false, code: 'stale', message: 'This result is no longer current. Analyze again.' }
      if (applying) return { ok: false, code: 'stale', message: 'This result is already being saved.' }
      applying = true
      try {
        const held = entry.payload
        const chosen = await deps.saveDialog(held.defaultPath)
        if (!chosen) return { ok: false, code: 'cancelled', message: 'Nothing was written.' }
        if (!current()) return { ok: false, code: 'stale', message: 'A newer analysis replaced this result. Nothing was written.' }
        const dest = path.resolve(chosen)
        const destReal = canonical(dest)
        if (held.inputs.some((input) => samePath(dest, input) || samePath(destReal, input))) {
          return {
            ok: false,
            code: 'same_as_source',
            message: samePath(destReal, held.sourcePath) || samePath(dest, held.sourcePath)
              ? 'That is the subtitle being aligned. It is never overwritten; choose another name.'
              : 'That file is one of this analysis\'s inputs. Choose another name.'
          }
        }
        if (path.extname(dest).toLowerCase() !== '.srt') {
          return { ok: false, code: 'invalid_destination', message: 'Align writes SubRip. Choose a name ending in .srt.' }
        }
        let now: Buffer
        try {
          now = fs.readFileSync(held.sourcePath)
        } catch {
          store.drop(generation as number)
          return { ok: false, code: 'source_changed', message: 'The subtitle being aligned can no longer be read. Analyze again.' }
        }
        const verified = store.verify(entry, now)
        if (verified === 'source_changed') return { ok: false, code: 'source_changed', message: 'The subtitle changed after it was analyzed. Analyze again.' }
        if (verified === 'changed') return { ok: false, code: 'changed', message: 'The aligned copy held for this result no longer matches what was analyzed. Nothing was written; analyze again.' }

        const written = await stagedWrite(dest, entry.bytes, current)
        if (!written.ok) {
          return written.superseded
            ? { ok: false, code: 'stale', message: 'A newer analysis replaced this result. Nothing was written.' }
            : { ok: false, code: 'write_failed', message: `The aligned subtitle could not be saved: ${written.message}` }
        }
        store.consume(entry)
        return { ok: true, path: dest }
      } catch (e) {
        return { ok: false, code: 'write_failed', message: `The aligned subtitle could not be saved: ${(e as Error).message}` }
      } finally {
        applying = false
      }
    },

    async exportDiagnostic(req: unknown): Promise<AlignDiagnosticExportResult> {
      const g = (req ?? {}) as { generation?: unknown }
      const generation = isGeneration(g.generation) ? g.generation : 0
      const snap = generation ? store.snapshot(generation) : null
      if (!snap) return { ok: false, code: 'stale', message: 'This result is no longer current. Analyze again.' }
      const held = snap.diagnostic
      if (!held) return { ok: false, code: 'not_exportable', message: 'There is no timing diagnostic for this result.' }
      if (exporting) return { ok: false, code: 'stale', message: 'This diagnostic is already being saved.' }
      exporting = true
      try {
        const current = (): boolean => store.snapshot(generation)?.diagnostic === held
        const chosen = await deps.diagnosticSaveDialog(held.defaultPath)
        if (!chosen) return { ok: false, code: 'cancelled', message: 'Nothing was written.' }
        if (!current()) return { ok: false, code: 'stale', message: 'A newer analysis replaced this result. Nothing was written.' }
        const dest = path.resolve(chosen)
        if (path.extname(dest).toLowerCase() !== '.json') {
          return { ok: false, code: 'write_failed', message: 'A timing diagnostic is a .json file. Choose a name ending in .json.' }
        }
        const written = await stagedWrite(dest, Buffer.from(encodeDiagnostic(held.v1), 'utf8'), current)
        if (!written.ok) {
          return written.superseded
            ? { ok: false, code: 'stale', message: 'A newer analysis replaced this result. Nothing was written.' }
            : { ok: false, code: 'write_failed', message: `The timing diagnostic could not be saved: ${written.message}` }
        }
        return { ok: true, path: dest }
      } catch (e) {
        return { ok: false, code: 'write_failed', message: `The timing diagnostic could not be saved: ${(e as Error).message}` }
      } finally {
        exporting = false
      }
    },

    async openDiagnostic(): Promise<AlignDiagnosticOpenResult> {
      const chosen = await deps.diagnosticOpenDialog()
      if (!chosen) return { ok: false, code: 'cancelled', message: 'No file was opened.' }
      let size: number
      try {
        size = fs.statSync(chosen).size
      } catch (e) {
        return { ok: false, code: 'unreadable', message: `The file could not be read: ${(e as Error).message}` }
      }
      if (size > DIAGNOSTIC_LIMITS.bytes) return { ok: false, code: 'too_large', message: 'That file is larger than any timing diagnostic can be, so it was not read.' }
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(chosen)
      } catch (e) {
        return { ok: false, code: 'unreadable', message: `The file could not be read: ${(e as Error).message}` }
      }
      const decoded = decodeDiagnostic(bytes)
      if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message }
      return { ok: true, applicable: false, replay: replayDiagnostic(decoded.diagnostic) }
    },

    async advancedStatus(): Promise<AlignAdvancedStatus> {
      if (alassOwner?.orphan) return { available: false, reason: 'busy', message: advancedUnavailableMessage('busy') }
      let reason: AlassUnavailable | null
      try {
        const a = await checkAlass(deps.alassTrust(), deps.alassDeps())
        reason = a.available ? null : a.reason
      } catch {
        reason = 'not_runnable'
      }
      return reason === null ? { available: true } : { available: false, reason, message: advancedUnavailableMessage(reason) }
    },

    async settled(): Promise<void> {
      while (cleanups.size > 0) await Promise.allSettled([...cleanups])
    },

    dispose(): void {
      active?.controller.abort()
      store.drop()
      retireOffer()
    },

    resumeCleanup(): void {
      const parent = sessionsDir()
      let names: string[]
      try {
        names = fs.readdirSync(parent)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
        startupNotes.push(
          `Align could not look in its temporary folder ${parent} for folders an earlier session left behind (${(e as Error).message}). Nothing in it was deleted; you can delete it yourself while the app is closed.`
        )
        return
      }
      for (const name of names) {
        const m = SESSION_NAME.exec(name)
        if (!m) continue
        const dir = path.join(parent, name)
        const pid = Number(m[1])
        if (dir === session) continue
        // With one service per process, our own id on a folder that is not our session is a previous
        // process that had the same id; any other live id may still be writing.
        if (pid !== deps.pid() && deps.processAlive(pid)) continue
        // The owner is gone, but an engine it started may not be.
        judgeSession(dir)
      }
      sweepOwned()
    }
  }
  const analyzeOnce = service.analyze
  service.analyze = async (req) => {
    const out = await analyzeOnce(req)
    if (out.status !== 'result' && out.status !== 'refused') return out
    const notice = cleanupNotice()
    // A request whose mode is not one of the two has no mode to report.
    const asked = (req as { mode?: unknown } | null)?.mode
    const mode: AlignmentMode | undefined = asked === undefined ? 'global' : asked === 'global' || asked === 'piecewise' ? asked : undefined
    return { ...out, ...(mode ? { mode } : {}), ...(notice ? { cleanupNotice: notice } : {}) }
  }
  return service
}
