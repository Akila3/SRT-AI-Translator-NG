/**
 * The ALASS sidecar's process owner (implementation_plan.md §9.4b, `alassSidecar.ts`).
 * AUTHORED-BY: opus-5.5-high
 *
 * Main-process only. One call runs `alass.exe` once, in a scratch folder of its own, and returns the
 * transformed SubRip bytes and the decoded report — or one failure. It never decides whether the
 * result is usable: the caller reparses the output and runs `independent-align` over it against the
 * reference (Bundle C item 7). It never writes outside its scratch folder and never touches a user file.
 *
 * What the child gets, and nothing else:
 *   - the executable at an absolute path whose SHA-256 and version line were just checked;
 *   - fixed arguments: ALASS's own defaults stated explicitly, `--` before every file argument, and
 *     fixed file names inside the scratch folder (a media reference is the one absolute user path);
 *   - an environment of `SystemRoot`, a `PATH` of the Windows folders, `TEMP`/`TMP` in the scratch
 *     folder and, for media, the app's own FFmpeg/FFprobe as absolute paths — never the user's `PATH`.
 *
 * Every ending is bounded: a timeout, a cancel, a stream past its limit or an oversized artifact kills
 * the whole process tree and waits for it to be gone. A tree that will not die is reported as
 * `orphaned` with the child and its folder kept, so the caller can hold its slot and lease.
 *
 * Advanced with a media reference (`alignAlassToSpeech`) is two runs in one folder: ALASS's own speech
 * export (`<media> _ speech.srt` — its FFmpeg decode to 8 kHz and WebRTC VAD), then the alignment against
 * those exported spans. Aligning against the media directly gives byte-identical output (gate_ledger.md
 * §5g.7), so the spans returned are exactly the timeline ALASS aligned to and the caller judges against.
 * This is the only WebRTC detector in the app; the Global path's 1–4 kHz detector lives in `ffmpeg.ts`.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { forceKillTree, waitForChildExit } from '../main/processExit'
import { ALASS_REPORT_LIMITS, decodeAlassReport, type AlassAlignmentReport, type AlassReport, type AlassReportError, type AlassVadReport } from './alassReport'
import { parseCues, serializeCues, type Cue } from './srt'

/** `vendor/alass/2.0.0/build-receipt.json`; a gate keeps these equal to it. */
export const ALASS_SIDECAR = Object.freeze({
  version: '2.0.0',
  sha256: 'ea314c5c83ca4d30af5259cc658e696352492438015dd55dae47290699efe5aa',
  versionLine: 'alass-cli 2.0.0'
})

/** Bundle C item 3: ALASS's defaults, fixed for the first release. No sweep, no user control. */
export const ALASS_FIXED = Object.freeze({ intervalMs: 1, splitPenalty: 7, speedOptimization: 1, fpsGuessing: true })

export interface AlassLimits {
  timeoutMs: number
  versionTimeoutMs: number
  /** Per stream. ALASS prints progress bars; ~13 KB for 150 cues. */
  streamBytes: number
  outputBytes: number
  reportBytes: number
  /** How long a killed tree has, per attempt, to be gone. */
  killGraceMs: number
}

export const ALASS_LIMITS: Readonly<AlassLimits> = Object.freeze({
  timeoutMs: 15 * 60_000,
  versionTimeoutMs: 15_000,
  streamBytes: 8 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  reportBytes: ALASS_REPORT_LIMITS.maxBytes,
  killGraceMs: 3_000
})

/** Where the component lives under the app's `resources/bin`. */
export function alassExecutablePath(binDir: string): string {
  return path.join(binDir, 'alass', ALASS_SIDECAR.version, 'alass.exe')
}

export interface AlassTrust {
  exePath: string
  sha256: string
  versionLine: string
}

export interface AlassSidecarDeps {
  spawn(exe: string, args: readonly string[], opts: SpawnOptions): ChildProcess
  /** Substituted by the gates so a tree kill can be observed or withheld. */
  kill?: (child: ChildProcess) => void
  /** Remove the run's scratch folder; throws when it cannot (a locked file on Windows). */
  removeDir(dir: string): void
  systemRoot: string
  limits: AlassLimits
}

export function defaultAlassDeps(): AlassSidecarDeps {
  return {
    spawn: (exe, args, opts) => spawn(exe, [...args], opts),
    removeDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    systemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
    limits: { ...ALASS_LIMITS }
  }
}

export type AlassUnavailable = 'absent' | 'untrusted' | 'wrong_version' | 'not_runnable'
export type AlassAvailability = { available: true } | { available: false; reason: AlassUnavailable }

export type AlassFailure =
  | 'unavailable'
  | 'bad_request'
  | 'spawn_failed'
  | 'timeout'
  | 'cancelled'
  | 'exit_nonzero'
  | 'stream_limit'
  | 'output_missing'
  | 'output_limit'
  | 'report_invalid'
  | 'report_mismatch'
  | 'orphaned'
  /** The speech export found no speech in the media; nothing was aligned. */
  | 'no_speech'

/** What happened to the scratch folder. `kept` means it is still on disk and the caller owns it. */
export type AlassCleanup = { removed: true } | { removed: false; dir: string; why: 'orphan' | 'remove_failed' }

export type AlassRunResult =
  | { ok: true; output: Buffer; report: AlassAlignmentReport; cleanup: AlassCleanup }
  | {
      ok: false
      failure: AlassFailure
      /** Set for `unavailable`. */
      unavailable?: AlassUnavailable
      /** Set for `report_invalid`. */
      reportError?: AlassReportError
      exitCode?: number | null
      /** Set for `orphaned`: the child that outlived every kill. */
      orphan?: ChildProcess
      /**
       * Set for `orphaned`: settles when the child's `close` is seen — every holder of its pipes, not only
       * the child, is gone. Subscribed when the child was started, so it cannot be missed. Parent exit is
       * not this: a descendant may still hold the pipes and write to the folder.
       */
      orphanClosed?: Promise<void>
      cleanup: AlassCleanup
    }

/** A media file and the app's own FFmpeg/FFprobe, all absolute. */
export interface AlassMedia {
  path: string
  ffmpegPath: string
  ffprobePath: string
}

export interface AlassRequest {
  mode: 'piecewise' | 'no_split'
  /** The source cues NG parsed; written to the scratch folder as UTF-8 SubRip. */
  input: readonly Cue[]
  reference: { kind: 'srt'; cues: readonly Cue[] } | ({ kind: 'media' } & AlassMedia)
  /** An existing absolute folder the caller owns; the run makes its own folder inside it. */
  workParent: string
  signal?: AbortSignal
}

export interface AlassSpeechRequest {
  mode: 'piecewise' | 'no_split'
  input: readonly Cue[]
  media: AlassMedia
  workParent: string
  signal?: AbortSignal
}

type AlassFailed = Extract<AlassRunResult, { ok: false }>

export type AlassSpeechResult =
  | {
      ok: true
      output: Buffer
      report: AlassAlignmentReport
      /** ALASS's exported speech spans, in order, as cues with neutral text: the reference it aligned to. */
      speech: Cue[]
      speechReport: AlassVadReport
      cleanup: AlassCleanup
    }
  | AlassFailed

const sha256File = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function childEnv(deps: AlassSidecarDeps, dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const root = deps.systemRoot
  return { SystemRoot: root, PATH: `${root}\\System32;${root}`, TEMP: dir, TMP: dir, ...extra }
}

interface Finished {
  code: number | null
  ended: 'exit' | 'timeout' | 'cancelled' | 'stream_limit' | 'spawn_failed'
  stdout: Buffer
  /** False when the tree outlived every kill. */
  gone: boolean
  child: ChildProcess | null
  /** Settles on the child's `close`. */
  closed: Promise<void>
}

/** Run once, bounded; keep stdout only when asked (the version check). */
function runBounded(
  deps: AlassSidecarDeps,
  exe: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; keepStdout: boolean; signal?: AbortSignal }
): Promise<Finished> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = deps.spawn(exe, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ code: null, ended: 'spawn_failed', stdout: Buffer.alloc(0), gone: true, child: null, closed: Promise.resolve() })
      return
    }
    const closed = new Promise<void>((r) => child.once('close', () => r()))
    const kept: Buffer[] = []
    const seen = { stdout: 0, stderr: 0 }
    let ended: Finished['ended'] = 'exit'
    let settled = false
    let killing: Promise<boolean> | null = null

    const stop = (why: Finished['ended']): void => {
      if (killing) return
      ended = why
      forceKillTree(child, deps.kill)
      killing = waitForChildExit(child, { graceMs: deps.limits.killGraceMs, attempts: 3, kill: deps.kill })
      void killing.then((gone) => {
        if (!gone) finish(null, false)
        // The child is reaped, but `close` also waits for every holder of its pipes. A descendant that
        // still holds one after the grace has outlived the kill.
        else setTimeout(() => finish(null, false), deps.limits.killGraceMs)
      })
    }
    const finish = (code: number | null, gone: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, ended, stdout: Buffer.concat(kept), gone, child, closed })
    }
    const onAbort = (): void => stop('cancelled')
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs)

    const count = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      seen[stream] += chunk.length
      if (seen[stream] > deps.limits.streamBytes) {
        stop('stream_limit')
        return
      }
      if (stream === 'stdout' && opts.keepStdout && !killing) kept.push(chunk)
    }
    child.stdout?.on('data', count('stdout'))
    child.stderr?.on('data', count('stderr'))
    child.on('error', () => {
      // A spawn that never started has no tree to kill; one that did reports through `close`.
      if (child.pid === undefined) {
        ended = 'spawn_failed'
        finish(null, true)
      }
    })
    child.on('close', (code) => finish(code, true))

    if (opts.signal?.aborted) stop('cancelled')
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Is the component present, the exact build and runnable? Called before every run, and by the page to
 * decide whether Advanced is offered. Anything short of all three disables Advanced only.
 */
export async function checkAlass(trust: AlassTrust, deps: AlassSidecarDeps = defaultAlassDeps()): Promise<AlassAvailability> {
  if (!path.isAbsolute(trust.exePath) || !isFile(trust.exePath)) return { available: false, reason: 'absent' }
  let hash: string
  try {
    hash = sha256File(trust.exePath)
  } catch {
    return { available: false, reason: 'absent' }
  }
  if (hash !== trust.sha256) return { available: false, reason: 'untrusted' }
  const cwd = path.dirname(trust.exePath)
  const run = await runBounded(deps, trust.exePath, ['--version'], { cwd, env: childEnv(deps, cwd), timeoutMs: deps.limits.versionTimeoutMs, keepStdout: true })
  if (run.ended !== 'exit' || run.code !== 0) return { available: false, reason: 'not_runnable' }
  if (run.stdout.toString('utf8').trim() !== trust.versionLine) return { available: false, reason: 'wrong_version' }
  return { available: true }
}

const validMedia = (m: AlassMedia | undefined): boolean =>
  !!m && [m.path, m.ffmpegPath, m.ffprobePath].every((p) => typeof p === 'string' && path.isAbsolute(p) && isFile(p))

function validBase(req: { mode: unknown; input: unknown; workParent: unknown }): boolean {
  if (req.mode !== 'piecewise' && req.mode !== 'no_split') return false
  if (!Array.isArray(req.input) || req.input.length === 0) return false
  return typeof req.workParent === 'string' && path.isAbsolute(req.workParent) && isDir(req.workParent)
}

function validRequest(req: AlassRequest): boolean {
  if (!validBase(req)) return false
  const r = req.reference
  if (r?.kind === 'srt') return Array.isArray(r.cues) && r.cues.length > 0
  if (r?.kind === 'media') return validMedia(r)
  return false
}

function sizeAtMost(file: string, max: number): 'ok' | 'missing' | 'over' {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile()) return 'missing'
    return st.size <= max ? 'ok' : 'over'
  } catch {
    return 'missing'
  }
}

type Failure = Omit<AlassFailed, 'ok' | 'cleanup'>

/** The run's own folder inside the caller's; kept, never removed, while an orphan may still write to it. */
interface Scratch {
  dir: string
  fail(f: Failure): AlassFailed
  cleanup(): AlassCleanup
}

function makeScratch(workParent: string, deps: AlassSidecarDeps): Scratch | null {
  let dir: string
  try {
    dir = fs.mkdtempSync(path.join(workParent, 'alass-'))
  } catch {
    return null
  }
  let keepDir: 'orphan' | null = null
  const cleanup = (): AlassCleanup => {
    if (keepDir) return { removed: false, dir, why: keepDir }
    try {
      deps.removeDir(dir)
      return fs.existsSync(dir) ? { removed: false, dir, why: 'remove_failed' } : { removed: true }
    } catch {
      return { removed: false, dir, why: 'remove_failed' }
    }
  }
  return {
    dir,
    fail: (f) => {
      if (f.failure === 'orphaned') keepDir = 'orphan'
      return { ok: false, ...f, cleanup: cleanup() }
    },
    cleanup
  }
}

/** One bounded child in the run folder, ended by `deadline` at the latest. */
async function step(
  deps: AlassSidecarDeps,
  trust: AlassTrust,
  dir: string,
  args: readonly string[],
  extraEnv: Record<string, string>,
  deadline: number,
  signal: AbortSignal | undefined
): Promise<Failure | null> {
  const timeoutMs = Math.max(1, deadline - Date.now())
  const run = await runBounded(deps, trust.exePath, args, { cwd: dir, env: childEnv(deps, dir, extraEnv), timeoutMs, keepStdout: false, signal })
  if (!run.gone) return { failure: 'orphaned', orphan: run.child ?? undefined, orphanClosed: run.child ? run.closed : undefined }
  if (run.ended !== 'exit') return { failure: run.ended }
  if (run.code !== 0) return { failure: 'exit_nonzero', exitCode: run.code }
  return null
}

/** Both artifacts present and within their limits, the report decoded. */
function readArtifacts(dir: string, outName: string, reportName: string, deps: AlassSidecarDeps): { output: Buffer; report: AlassReport } | Failure {
  const outputFile = path.join(dir, outName)
  const reportFile = path.join(dir, reportName)
  const outSize = sizeAtMost(outputFile, deps.limits.outputBytes)
  const repSize = sizeAtMost(reportFile, deps.limits.reportBytes)
  if (outSize === 'missing' || repSize === 'missing') return { failure: 'output_missing' }
  if (outSize === 'over' || repSize === 'over') return { failure: 'output_limit' }
  const output = fs.readFileSync(outputFile)
  const decoded = decodeAlassReport(fs.readFileSync(reportFile))
  if (!decoded.ok) return { failure: 'report_invalid', reportError: decoded.error }
  return { output, report: decoded.report }
}

const alignmentArgs = (mode: 'piecewise' | 'no_split', ref: string): string[] => [
  '--split-penalty', String(ALASS_FIXED.splitPenalty),
  '--speed-optimization', String(ALASS_FIXED.speedOptimization),
  '--interval', String(ALASS_FIXED.intervalMs),
  ...(mode === 'no_split' ? ['--no-split'] : []),
  '--json-report', 'report.json',
  '--',
  ref, 'input.srt', 'output.srt'
]

/** The alignment's output and report, the report exactly the run that was asked for. */
function readAlignment(
  dir: string,
  deps: AlassSidecarDeps,
  mode: 'piecewise' | 'no_split',
  inputCount: number,
  referenceCount: number | null
): { output: Buffer; report: AlassAlignmentReport } | Failure {
  const got = readArtifacts(dir, 'output.srt', 'report.json', deps)
  if ('failure' in got) return got
  const report = got.report
  if (report.mode === 'vad_export') return { failure: 'report_mismatch' }
  const p = report.parameters
  const matches =
    report.mode === mode &&
    p.intervalMs === ALASS_FIXED.intervalMs &&
    p.splitPenalty === ALASS_FIXED.splitPenalty &&
    p.speedOptimization === ALASS_FIXED.speedOptimization &&
    p.fpsGuessing === ALASS_FIXED.fpsGuessing &&
    report.inputCueCount === inputCount &&
    (referenceCount === null || report.referenceCueCount === referenceCount)
  if (!matches) return { failure: 'report_mismatch' }
  return { output: got.output, report }
}

const writeInput = (dir: string, name: string, cues: readonly Cue[]): void =>
  fs.writeFileSync(path.join(dir, name), serializeCues(cues, '\n'), { encoding: 'utf8', flag: 'wx' })

/** One ALASS run. Never throws; every failure is a value. */
export async function runAlass(req: AlassRequest, trust: AlassTrust, deps: AlassSidecarDeps = defaultAlassDeps()): Promise<AlassRunResult> {
  const removed: AlassCleanup = { removed: true }
  if (!validRequest(req)) return { ok: false, failure: 'bad_request', cleanup: removed }
  if (req.signal?.aborted) return { ok: false, failure: 'cancelled', cleanup: removed }

  const availability = await checkAlass(trust, deps)
  if (!availability.available) return { ok: false, failure: 'unavailable', unavailable: availability.reason, cleanup: removed }

  const scratch = makeScratch(req.workParent, deps)
  if (!scratch) return { ok: false, failure: 'bad_request', cleanup: removed }
  const { dir } = scratch
  try {
    try {
      writeInput(dir, 'input.srt', req.input)
      if (req.reference.kind === 'srt') writeInput(dir, 'reference.srt', req.reference.cues)
    } catch {
      return scratch.fail({ failure: 'bad_request' })
    }

    const ref = req.reference.kind === 'srt' ? 'reference.srt' : req.reference.path
    const media: Record<string, string> = req.reference.kind === 'media' ? { ALASS_FFMPEG_PATH: req.reference.ffmpegPath, ALASS_FFPROBE_PATH: req.reference.ffprobePath } : {}
    const ended = await step(deps, trust, dir, alignmentArgs(req.mode, ref), media, Date.now() + deps.limits.timeoutMs, req.signal)
    if (ended) return scratch.fail(ended)

    const got = readAlignment(dir, deps, req.mode, req.input.length, req.reference.kind === 'srt' ? req.reference.cues.length : null)
    if ('failure' in got) return scratch.fail(got)
    return { ok: true, output: got.output, report: got.report, cleanup: scratch.cleanup() }
  } catch {
    return scratch.fail({ failure: 'bad_request' })
  }
}

/** ALASS's exported spans: the file must hold exactly the spans its report counts, each a valid cue. */
function readSpeech(dir: string, deps: AlassSidecarDeps): { speech: Cue[]; report: AlassVadReport } | Failure {
  const got = readArtifacts(dir, 'speech.srt', 'speech.json', deps)
  if ('failure' in got) return got
  const report = got.report
  if (report.mode !== 'vad_export') return { failure: 'report_mismatch' }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(got.output)
  } catch {
    return { failure: 'report_mismatch' }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (report.referenceSpanCount === 0) return text.trim() === '' ? { failure: 'no_speech' } : { failure: 'report_mismatch' }
  const parsed = parseCues(text)
  if (!parsed.ok || parsed.cues.length !== report.referenceSpanCount) return { failure: 'report_mismatch' }
  return { speech: parsed.cues.map((c, i) => ({ index: i + 1, startMs: c.startMs, endMs: c.endMs, text: 'speech' })), report }
}

/**
 * Advanced against a media file: ALASS's speech export, then the alignment against exactly those spans,
 * in one folder under one deadline. Never throws; every failure is a value. No speech is `no_speech`,
 * and nothing is aligned.
 */
export async function alignAlassToSpeech(req: AlassSpeechRequest, trust: AlassTrust, deps: AlassSidecarDeps = defaultAlassDeps()): Promise<AlassSpeechResult> {
  const removed: AlassCleanup = { removed: true }
  if (!validBase(req) || !validMedia(req.media)) return { ok: false, failure: 'bad_request', cleanup: removed }
  if (req.signal?.aborted) return { ok: false, failure: 'cancelled', cleanup: removed }

  const availability = await checkAlass(trust, deps)
  if (!availability.available) return { ok: false, failure: 'unavailable', unavailable: availability.reason, cleanup: removed }

  const scratch = makeScratch(req.workParent, deps)
  if (!scratch) return { ok: false, failure: 'bad_request', cleanup: removed }
  const { dir } = scratch
  const deadline = Date.now() + deps.limits.timeoutMs
  try {
    try {
      writeInput(dir, 'input.srt', req.input)
    } catch {
      return scratch.fail({ failure: 'bad_request' })
    }

    const tools = { ALASS_FFMPEG_PATH: req.media.ffmpegPath, ALASS_FFPROBE_PATH: req.media.ffprobePath }
    const exported = await step(deps, trust, dir, ['--json-report', 'speech.json', '--', req.media.path, '_', 'speech.srt'], tools, deadline, req.signal)
    if (exported) return scratch.fail(exported)
    const spans = readSpeech(dir, deps)
    if ('failure' in spans) return scratch.fail(spans)
    if (req.signal?.aborted) return scratch.fail({ failure: 'cancelled' })

    const aligned = await step(deps, trust, dir, alignmentArgs(req.mode, 'speech.srt'), {}, deadline, req.signal)
    if (aligned) return scratch.fail(aligned)
    const got = readAlignment(dir, deps, req.mode, req.input.length, spans.speech.length)
    if ('failure' in got) return scratch.fail(got)
    return { ok: true, output: got.output, report: got.report, speech: spans.speech, speechReport: spans.report, cleanup: scratch.cleanup() }
  } catch {
    return scratch.fail({ failure: 'bad_request' })
  }
}
