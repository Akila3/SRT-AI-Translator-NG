import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { normalizeTrackLang } from '../shared/languages'
import { waitForChildExit } from './processExit'
import { durationFromProbe, percentOf, readProgressChunk } from '../shared/ffmpegProgress'
import type { FfmpegPathValidation, SubtitleTrack } from '../shared/types'

const EXE = process.platform === 'win32' ? '.exe' : ''

/**
 * Resolve ffmpeg/ffprobe in priority order so the app stays portable:
 *   1. Explicit path set in Settings → Advanced (user override)
 *   2. A copy bundled next to the app (resources/bin) — fully portable
 *   3. The system PATH (developer machines / users who have FFmpeg installed)
 */
export function bundledBinDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'resources', 'bin')
}

function resolveTool(tool: 'ffmpeg' | 'ffprobe', ffmpegPath?: string): string {
  if (ffmpegPath && ffmpegPath.trim()) {
    const dir = path.dirname(ffmpegPath)
    return path.join(dir, tool + EXE)
  }
  const bundled = path.join(bundledBinDir(), tool + EXE)
  if (fs.existsSync(bundled)) return bundled
  return tool
}

/**
 * Directories that contain ffmpeg/ffprobe, in priority order, to prepend to a
 * child process's PATH. The bundled `gst` CLI shells out to plain `ffmpeg`, so
 * it must be discoverable on PATH (it even hard-exits on list-models if not).
 */
export function ffmpegPathDirs(ffmpegPath?: string): string[] {
  const dirs: string[] = []
  if (ffmpegPath && ffmpegPath.trim()) dirs.push(path.dirname(ffmpegPath))
  const dir = bundledBinDir()
  if (fs.existsSync(path.join(dir, 'ffmpeg' + EXE))) dirs.push(dir)
  return dirs
}

/**
 * Build a child-process env with the resolved ffmpeg dir(s) PREPENDED to PATH.
 *
 * Prepending is the whole point, and getting here took two rounds. `gst` shells out to a bare
 * `ffmpeg`, so PATH order is what decides which one the engine uses — and this used to APPEND,
 * which meant any system install earlier on PATH beat both the bundled copy and the user's explicit
 * Settings override. The documented priority was therefore true only of the app's own calls, which
 * go through `resolveTool()` and are absolute (validator finding SOL-06).
 *
 * The reason it once appended was real: the bundled directory held `gst.exe` as well as
 * `ffmpeg.exe`, so prepending it in development would have shadowed a developer's pip-installed
 * engine. The engine went with the CLI at Step 4.5, so there is no second question for this
 * ordering to get wrong.
 */
export function envWithFfmpeg(ffmpegPath?: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dirs = ffmpegPathDirs(ffmpegPath)
  const sep = process.platform === 'win32' ? ';' : ':'
  const base = process.env.PATH ?? process.env.Path ?? ''
  const PATH = [...dirs, base].filter(Boolean).join(sep)
  return { ...process.env, ...extra, PATH }
}

/** The fixed reasons a picked FFmpeg override is refused, for one platform's executable names. */
export function ffmpegPathReasons(platform: NodeJS.Platform = process.platform): Record<'empty' | 'missing' | 'notFile' | 'name' | 'noProbe' | 'unreadable', string> {
  const exe = platform === 'win32' ? '.exe' : ''
  return {
    empty: 'No FFmpeg file was chosen. Nothing was changed.',
    missing: 'That file does not exist. Nothing was changed.',
    notFile: `That is a folder, not FFmpeg. Choose the ffmpeg${exe} file itself. Nothing was changed.`,
    name: `Choose the file named ffmpeg${exe} itself, not another file in its folder. Nothing was changed.`,
    noProbe: `ffprobe${exe} must be in the same folder as ffmpeg${exe}, and it is not. Nothing was changed.`,
    unreadable: 'That file could not be checked. Nothing was changed.'
  }
}

/**
 * Whether a picked FFmpeg override may be stored: the exact `ffmpeg[.exe]` file with a regular
 * `ffprobe[.exe]` beside it. Filesystem facts only — the picked program is never run, and the resolver
 * above, which uses only the folder, is not changed by what this accepts.
 */
export async function validateFfmpegPath(
  picked: unknown,
  opts: { platform?: NodeJS.Platform; stat?: (p: string) => Promise<fs.Stats> } = {}
): Promise<FfmpegPathValidation> {
  const platform = opts.platform ?? process.platform
  const stat = opts.stat ?? ((p: string) => fs.promises.stat(p))
  const reasons = ffmpegPathReasons(platform)
  const exe = platform === 'win32' ? '.exe' : ''
  const missing = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException)?.code ?? '')
  const file = typeof picked === 'string' ? picked.trim() : ''
  if (!file) return { ok: false, reason: reasons.empty }
  try {
    const own = await stat(file).catch((e: unknown) => {
      if (missing(e)) return null
      throw e
    })
    if (!own) return { ok: false, reason: reasons.missing }
    if (!own.isFile()) return { ok: false, reason: reasons.notFile }
    const base = path.basename(file)
    if (platform === 'win32' ? base.toLowerCase() !== `ffmpeg${exe}` : base !== 'ffmpeg') return { ok: false, reason: reasons.name }
    const probe = await stat(path.join(path.dirname(file), `ffprobe${exe}`)).catch((e: unknown) => {
      if (missing(e)) return null
      throw e
    })
    if (!probe || !probe.isFile()) return { ok: false, reason: reasons.noProbe }
    return { ok: true }
  } catch {
    return { ok: false, reason: reasons.unreadable }
  }
}

/** Containers whose audio is extracted for Transcribe; anything else is read as an audio file. */
const VIDEO_MEDIA_RE = /\.(mp4|mkv|mov|avi|webm|m4v|ts|wmv|flv)$/i

export function isVideoMedia(mediaFile: string): boolean {
  return VIDEO_MEDIA_RE.test(mediaFile)
}

export interface MediaExecResult {
  code: number | null
  stdout: string
  stderr: string
  /** Set when the child was cancelled and outlived an escalated kill. */
  orphaned?: boolean
  orphanPid?: number
  /** The surviving child itself — a pid is reusable, this is not (SOL-16). */
  orphan?: ChildProcess
}

export interface MediaExecOptions {
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  /**
   * Binary stdout. When set, stdout is delivered as bytes and NOT accumulated as text: decoded PCM
   * of a feature film is hundreds of megabytes, and a string copy of it is the one thing that must
   * not be held.
   */
  onStdoutBytes?: (chunk: Buffer) => void
  /** Called the moment the child exists, so a job can own it before this promise settles. */
  onChild?: (child: ChildProcess) => void
}

/** How a media helper runs a tool. Injectable so the gates can see every invocation it makes. */
export type MediaExec = (cmd: string, args: string[], opts?: MediaExecOptions) => Promise<MediaExecResult>

function execCapture(cmd: string, args: string[], opts?: MediaExecOptions): Promise<MediaExecResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let proc
    try {
      // No shell, and stdin is never the app's: a tool that waits on input gets end-of-file, not a hang.
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(opts?.signal ? { signal: opts.signal } : {}) })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message })
      return
    }
    const child = proc
    opts?.onChild?.(child)
    child.stdout.on('data', (d: Buffer) => {
      if (opts?.onStdoutBytes) {
        opts.onStdoutBytes(d)
        return
      }
      const text = d.toString()
      stdout += text
      opts?.onStdout?.(text)
    })
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => {
      // An ABORT arrives here, and it arrives when Node asks the child to die — not when it does.
      // Resolving now hands the caller a finished-looking result while ffmpeg or ffprobe is still
      // running, and for the audio conversion that caller then releases the job slot, so the next
      // start runs alongside a process the app has stopped tracking (validator finding SOL-02).
      // `close` is the witness, so the abort path waits for it and only gives up if the child
      // survives an escalated kill.
      if (opts?.signal?.aborted) {
        // The boolean is the answer, not a diagnostic. Discarding it — which the first version of
        // this did — released the caller as though the kill had worked even when the child survived
        // escalation, and for the audio conversion that caller then releases the job slot (SOL-02).
        void waitForChildExit(child).then((gone) =>
          resolve({
            code: -1,
            stdout,
            stderr: err.message,
            orphaned: !gone,
            orphanPid: gone ? undefined : child.pid,
            orphan: gone ? undefined : child
          })
        )
        return
      }
      resolve({ code: -1, stdout, stderr: err.message })
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** The one FFmpeg/FFprobe launcher every helper here defaults to; exported so its stdio can be pinned. */
export const mediaExec: MediaExec = execCapture

/**
 * How far along a long ffmpeg call is, reported as it runs.
 *
 * `pct` is null when the input will not say how long it is; the caller shows the elapsed
 * time instead rather than an invented bar.
 */
export type ProgressReporter = (pct: number | null, elapsedMs: number) => void

/**
 * The media's length in seconds, or null if it will not say.
 *
 * Only ever used to turn ffmpeg's reported position into a percentage, so every failure here
 * is answered with null — an unreadable file is about to fail in the actual call, where the
 * error belongs, and a stream with no duration is a legitimate input that simply cannot have
 * a percentage.
 *
 * `signal` is not optional in spirit, only in signature. This runs *before* the work it
 * measures, so a caller whose work can be cancelled must pass its signal or the cancellation
 * cannot reach the first child process it starts — reading a header is normally instant, but
 * on an unreachable network path it is not bounded by anything (validator finding FP6-01).
 */
export async function probeDuration(
  filePath: string,
  ffmpegPath?: string,
  signal?: AbortSignal,
  onChild?: (child: ChildProcess) => void,
  exec: MediaExec = execCapture
): Promise<number | null> {
  const ffprobe = resolveTool('ffprobe', ffmpegPath)
  const { stdout } = await exec(
    ffprobe,
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ],
    { signal, onChild }
  )
  return durationFromProbe(stdout)
}

/**
 * Run ffmpeg so that it says how far it has got.
 *
 * The whole of the change is `-progress pipe:1`: it costs one extra ffprobe (only when
 * somebody is listening) and turns a call that was silent for minutes into one that reports
 * every half second. `-nostats` removes the human-readable stderr counter that would
 * otherwise be interleaved with the errors we read back on failure.
 *
 * The flags lead the command line rather than trailing it: they are global options, and
 * ffmpeg binds anything placed after an input or an output to that file instead.
 */
async function execFfmpeg(
  ffmpeg: string,
  args: string[],
  opts: {
    /** The file whose duration turns a position into a percentage. */
    source: string
    ffmpegPath?: string
    signal?: AbortSignal
    onProgress?: ProgressReporter
    onChild?: (child: ChildProcess) => void
    exec?: MediaExec
    /** Already measured by the caller; spares the extra ffprobe. */
    durationSeconds?: number | null
  }
): Promise<MediaExecResult> {
  const { onProgress } = opts
  const exec = opts.exec ?? execCapture
  if (!onProgress) return exec(ffmpeg, args, { signal: opts.signal, onChild: opts.onChild })

  const startedAt = Date.now()
  // The signal goes to the probe as well as to the work. Without it a Stop pressed during
  // this measurement cannot end anything: the check below is only reached once ffprobe has
  // finished of its own accord, which on a stalled network path may be never, and the job
  // slot stays held for all of it (validator finding FP6-01). The check stays as well — an
  // abort makes the probe resolve, and resolving must not then start the conversion.
  const duration =
    opts.durationSeconds !== undefined
      ? opts.durationSeconds
      : await probeDuration(opts.source, opts.ffmpegPath, opts.signal, opts.onChild, exec)
  if (opts.signal?.aborted) return { code: -1, stdout: '', stderr: 'Aborted.' }

  // Only whole lines are ever parsed. A pipe read can end mid-number, and `out_time_us=1000`
  // is a perfectly valid parse of the first half of `out_time_us=10000000` — a report that is
  // not merely missing but WRONG, and wrong in the one direction the bar must never move.
  // The remainder is carried to the next chunk, exactly as the engine's stdout is read.
  let carry = ''
  const withProgress = ['-progress', 'pipe:1', '-nostats', ...args]
  return exec(ffmpeg, withProgress, {
    signal: opts.signal,
    onChild: opts.onChild,
    onStdout: (chunk) => {
      carry += chunk
      const lastBreak = carry.lastIndexOf('\n')
      if (lastBreak < 0) return
      const complete = carry.slice(0, lastBreak + 1)
      carry = carry.slice(lastBreak + 1)
      const { outTimeSec } = readProgressChunk(complete)
      if (outTimeSec === null) return
      onProgress(percentOf(outTimeSec, duration), Date.now() - startedAt)
    }
  })
}

const IMAGE_CODECS = ['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'xsub']

export async function probeTracks(filePath: string, ffmpegPath?: string): Promise<SubtitleTrack[]> {
  const ffprobe = resolveTool('ffprobe', ffmpegPath)
  const args = [
    '-v', 'error',
    '-select_streams', 's',
    '-show_entries', 'stream=index,codec_name:stream_tags=language,title',
    '-of', 'json',
    filePath
  ]
  const { stdout } = await execCapture(ffprobe, args)
  let parsed: { streams?: Array<{ codec_name?: string; tags?: { language?: string; title?: string } }> }
  try {
    parsed = JSON.parse(stdout || '{}')
  } catch {
    return []
  }
  const streams = parsed.streams ?? []
  return streams.map((s, i) => {
    const codec = s.codec_name ?? 'unknown'
    const isImage = IMAGE_CODECS.includes(codec)
    const langRaw = s.tags?.language ?? ''
    const code = normalizeTrackLang(langRaw)
    const baseName = s.tags?.title || langRaw || `Track ${i}`
    return {
      // subtitle-relative index → used for ffmpeg -map 0:s:N
      index: i,
      codec,
      lang: code || langRaw.toLowerCase(),
      name: isImage ? `${baseName} (PGS)` : baseName,
      isImage
    }
  })
}

/**
 * Transcode an audio file to mono MP3 for the engine.
 *
 * The engine loads audio with pydub, which hands ffmpeg a forced input format; an
 * AAC/M4A/FLAC file is then decoded as `mp3float`, produces no packets, and dies with
 * "Conversion failed!" — reported by the frozen build as `name 'exit' is not defined`,
 * because PyInstaller omits the `site` builtin that `exit()` comes from. Verified against
 * gst 3.7.0 on 2026-08-19: of the formats the picker offers, only `.mp3` and `.wav` survive.
 *
 * MP3 is not an arbitrary choice — it is what the engine's own `extract_audio_from_video`
 * produces for video input, so this hands it a shape it already reads. Mono at 64 kbps
 * matches its own downmix-and-compress step and keeps the upload small; speech does not
 * benefit from more.
 */
export async function convertAudioToMp3(
  inputPath: string,
  outPath: string,
  ffmpegPath?: string,
  signal?: AbortSignal,
  onProgress?: ProgressReporter,
  onChild?: (child: ChildProcess) => void
): Promise<{
  ok: boolean
  error?: string
  orphaned?: boolean
  orphanPid?: number
  orphan?: ChildProcess
}> {
  const ffmpeg = resolveTool('ffmpeg', ffmpegPath)
  const { code, stderr, orphaned, orphanPid, orphan } = await execFfmpeg(
    ffmpeg,
    [
      '-y', '-i', inputPath,
      '-vn', '-sn', '-dn', '-map', '0:a:0', '-map_metadata', '-1',
      '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '64k',
      outPath
    ],
    { source: inputPath, ffmpegPath, signal, onProgress, onChild }
  )
  if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return { ok: true }

  // A failed or cancelled conversion still leaves a partial file behind, and nothing
  // downstream knows about a path that was never returned to it.
  try {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
  } catch {
    /* best effort */
  }
  const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').trim()
  // `orphaned` travels with the failure because it is a statement about a PROCESS, not about the
  // conversion: a cancelled conversion whose ffmpeg outlived its kill must not let the caller
  // release the job slot (SOL-02).
  return { ok: false, error: detail || `ffmpeg exited with code ${code}`, orphaned, orphanPid, orphan }
}

/**
 * Write one subtitle track out of a container.
 *
 * `onProgress` is optional and absent by default because two callers of this are silent by
 * design (the verification probes), and asking for progress costs an extra ffprobe. When it
 * IS supplied the percentage is measured against the *video's* duration, which is the right
 * denominator: ffmpeg walks the whole container to find the track's packets, so the work is
 * proportional to the film's length rather than to the subtitle's size.
 */
export async function extractTrack(
  filePath: string,
  subtitleIndex: number,
  outPath: string,
  isImage: boolean,
  ffmpegPath?: string,
  onProgress?: ProgressReporter
): Promise<{ ok: boolean; error?: string }> {
  const ffmpeg = resolveTool('ffmpeg', ffmpegPath)
  const args = isImage
    ? ['-y', '-i', filePath, '-map', `0:s:${subtitleIndex}`, '-c:s', 'copy', outPath]
    : ['-y', '-i', filePath, '-map', `0:s:${subtitleIndex}`, '-c:s', 'srt', outPath]
  const { code, stderr } = await execFfmpeg(ffmpeg, args, {
    source: filePath,
    ffmpegPath,
    onProgress
  })
  if (code === 0) return { ok: true }
  return { ok: false, error: stderr.split(/\r?\n/).slice(-5).join('\n') }
}

// ── Align: every embedded text track in one pass (Bundle M, implementation_plan.md §16.0.2) ─────
//
// AUTHORED-BY: opus-5.5-high
//
// Align reads every text track of a media reference, so it walks the container once and writes each
// track to its own SubRip file, instead of once per track. Translate's one-track `extractTrack` above
// is a different caller with its own rules (`.sup` copy-out) and is not used here.

/**
 * The subtitle codecs the bundled FFmpeg decodes as text (measured, ledger E159 item 7). Any other stream
 * — PGS, VobSub, `dvb_subtitle`, `arib_caption`, teletext, TTML, unknown — is listed and never mapped.
 */
export const ALIGN_TEXT_CODECS: readonly string[] = Object.freeze([
  'ass', 'ssa', 'subrip', 'mov_text', 'webvtt', 'text', 'microdvd', 'mpl2', 'pjs',
  'realtext', 'sami', 'stl', 'subviewer', 'subviewer1', 'vplayer', 'jacosub', 'eia_608'
])
/** Each output is cut by FFmpeg's `-fs` at this size; a file this large or larger is never parsed. */
export const ALIGN_TRACK_MAX_BYTES = 8 * 1024 * 1024
/** Text tracks mapped in one run, in stream order; later ones are listed and never mapped. */
export const ALIGN_TRACKS_MAX = 128

export interface TextTrackExtraction {
  /** FFmpeg exited 0. Otherwise no track counts as read, whatever files it left. */
  ok: boolean
  error?: string
  /** The run was stopped by its signal. */
  aborted?: boolean
  /** Settles once no process of this run can still write into the output folder. */
  closed: Promise<void>
}

/**
 * Which probed streams Align maps: allow-listed text codecs, in stream order, up to `ALIGN_TRACKS_MAX`.
 * Every other stream is listed with why it was not: `image` (FFprobe's own image flag), `not_text`, or
 * `too_many_tracks`. Nothing listed is ever extracted, a vote or a stop.
 */
export function alignTrackPlan(tracks: readonly SubtitleTrack[]): {
  map: SubtitleTrack[]
  listed: Map<number, 'image' | 'not_text' | 'too_many_tracks'>
} {
  const map: SubtitleTrack[] = []
  const listed = new Map<number, 'image' | 'not_text' | 'too_many_tracks'>()
  for (const t of tracks) {
    if (t.isImage) listed.set(t.index, 'image')
    else if (!ALIGN_TEXT_CODECS.includes(t.codec)) listed.set(t.index, 'not_text')
    else if (map.length >= ALIGN_TRACKS_MAX) listed.set(t.index, 'too_many_tracks')
    else map.push(t)
  }
  return { map, listed }
}

/** Where `extractTextTracks` writes subtitle-relative stream `index`. */
export function textTrackFile(outDir: string, index: number): string {
  return path.join(outDir, `track-${index}.srt`)
}

/**
 * One FFmpeg run that writes each listed subtitle stream to `textTrackFile(outDir, N)` as SubRip, each
 * output capped at `ALIGN_TRACK_MAX_BYTES`. `indices` are FFprobe's own subtitle-relative positions and
 * nothing else; anything that is not a distinct non-negative integer is refused before a process starts.
 *
 * When the signal stops a child that then outlives the escalated kill, the result still comes back at
 * once, and `closed` waits for that child's own `close`: until then it may still be writing. That holds
 * for every child of the run, the progress probe included, whose own result `probeDuration` drops.
 */
export async function extractTextTracks(
  media: string,
  indices: readonly number[],
  outDir: string,
  opts: { ffmpegPath?: string; signal: AbortSignal; onProgress?: ProgressReporter; exec?: MediaExec }
): Promise<TextTrackExtraction> {
  const valid =
    indices.length > 0 &&
    indices.length <= ALIGN_TRACKS_MAX &&
    new Set(indices).size === indices.length &&
    indices.every((n) => Number.isSafeInteger(n) && n >= 0)
  if (!valid || !path.isAbsolute(media) || !path.isAbsolute(outDir)) {
    throw new TypeError('extractTextTracks needs an absolute media path and output folder, and 1–128 distinct subtitle stream positions')
  }
  const args = ['-y', '-i', media]
  for (const n of indices) args.push('-map', `0:s:${n}`, '-c:s', 'srt', '-fs', String(ALIGN_TRACK_MAX_BYTES), textTrackFile(outDir, n))
  const run = opts.exec ?? execCapture
  const orphans: ChildProcess[] = []
  const exec: MediaExec = async (cmd, a, o) => {
    const res = await run(cmd, a, o)
    if (res.orphaned && res.orphan) orphans.push(res.orphan)
    return res
  }
  const out = await execFfmpeg(resolveTool('ffmpeg', opts.ffmpegPath), args, {
    source: media,
    ffmpegPath: opts.ffmpegPath,
    signal: opts.signal,
    onProgress: opts.onProgress,
    exec
  })
  const closed = Promise.all(orphans.map((c) => new Promise<void>((resolve) => c.once('close', () => resolve())))).then(() => undefined)
  if (opts.signal.aborted) return { ok: false, aborted: true, error: 'Stopped.', closed }
  if (out.code === 0) return { ok: true, closed }
  return { ok: false, error: out.stderr.split(/\r?\n/).slice(-5).join('\n') || `ffmpeg exited with code ${out.code}`, closed }
}

// ── native transcription audio (implementation_plan.md Step 1.4, §10.3) ─────────
//
// AUTHORED-BY: opus-5.5-high
//
// Two consumers read audio for different reasons, and §10.3 keeps them apart by separating the
// MEASUREMENT from its PRE-FILTER:
//
//  - `audioForTranscription()` prepares what the model hears: the shipping engine's own extraction,
//    with its voice isolation and nothing else. ⚠ No analysis filtering, and specifically no
//    1–4 kHz band-pass — that band-pass is the alignment caller's requirement (Bundle C), and on
//    transcription it degraded the text and flipped Hebrew gender (§4b check 7).
//  - `envelope()` measures level over time on audio it is GIVEN and filters nothing itself. The
//    coverage gate (Step 1.8a) gives it `audioForTranscription()` output. `audioForAlignment()`
//    (Bundle C, below) band-passes its own single decode and measures that stream with the same
//    `EnvelopeAccumulator`. One measurement, two pre-filters, and neither caller calls the other.
//
// `spreadSample()` is D5-13's cutter. Its consumer is Bundle I's language detection, not Phase 1;
// it lives here because this is the owner of the shared sampling floor.
//
// Every helper here requires an AbortSignal: each is one or more ffmpeg invocations, and Stop must
// end the sequence, not only the process it happens to be in.

export interface MediaToolOptions {
  ffmpegPath?: string
  /** Required. A Stop must reach every invocation and the gaps between them. */
  signal: AbortSignal
  onChild?: (child: ChildProcess) => void
  /** Gate seam; production uses the real spawn. */
  exec?: MediaExec
}

export interface MediaFailure {
  ok: false
  error: string
  aborted?: boolean
  orphaned?: boolean
  orphanPid?: number
  orphan?: ChildProcess
}

function requireSignal(signal: unknown, helper: string): AbortSignal {
  if (!(signal instanceof AbortSignal)) throw new TypeError(`${helper} requires an AbortSignal`)
  return signal
}

function failure(res: MediaExecResult, fallback: string, aborted: boolean): MediaFailure {
  const detail = res.stderr.trim().split(/\r?\n/).slice(-3).join(' ').trim()
  return {
    ok: false,
    error: aborted ? 'Stopped.' : detail || fallback,
    ...(aborted ? { aborted: true } : {}),
    ...(res.orphaned ? { orphaned: true, orphanPid: res.orphanPid, orphan: res.orphan } : {})
  }
}

function seconds3(s: number): string {
  return (Math.round(s * 1000) / 1000).toFixed(3)
}

function removeQuietly(file: string): void {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    /* best effort: a file we made and cannot delete must not fail the run */
  }
}

/** The audio stream gst 3.7.0 extracts from, and how long the file is (`ffmpeg_utils.py:37-69`). */
export interface AudioProps {
  durationSeconds: number
  channels: number
  /** Absolute stream index, as `-map 0:<index>` takes it. */
  streamIndex: number
}

/**
 * gst's choice of stream, read from its ffprobe JSON: the stream marked default, otherwise the first
 * audio stream. Null when there is no audio stream or no positive duration — gst raises on both.
 */
export function parseAudioProps(ffprobeJson: string): AudioProps | null {
  let data: {
    streams?: Array<{ index?: number; channels?: number; disposition?: { default?: number } }>
    format?: { duration?: string }
  }
  try {
    data = JSON.parse(ffprobeJson || '{}')
  } catch {
    return null
  }
  const streams = data.streams ?? []
  if (streams.length === 0) return null
  const primary = streams.find((s) => s.disposition?.default) ?? streams[0]
  const duration = Number(data.format?.duration ?? 0)
  if (!Number.isFinite(duration) || duration <= 0 || typeof primary.index !== 'number') return null
  return { durationSeconds: duration, channels: primary.channels ?? 1, streamIndex: primary.index }
}

/**
 * gst 3.7.0's extraction filter chain, branch for branch (`ffmpeg_utils.py:102-126`), with voice
 * isolation on — 1.1.0 never passes `--no-voice-isolation` (`pythonBridge.ts:609-629`):
 *
 *  - mono: nothing but the drift resample;
 *  - 6+ channels: the centre channel alone (dialogue), no high/low-pass;
 *  - 2–5 channels: an equal-weight downmix, then 80 Hz high-pass and 3400 Hz low-pass.
 *
 * That 80–3400 Hz band is the engine's voice isolation, the full telephone speech band. It is not
 * the 1–4 kHz analysis band-pass, which must never appear here (§10.3).
 */
export function transcriptionFilterChain(channels: number, isolateVoice = true): string[] {
  const filters: string[] = []
  const pan = monoPan(channels, isolateVoice)
  if (pan) {
    filters.push(pan)
    if (pan !== CENTRE_PAN && isolateVoice) filters.push('highpass=f=80', 'lowpass=f=3400')
  }
  filters.push('aresample=async=1')
  return filters
}

const CENTRE_PAN = 'pan=mono|c0=FC'

/**
 * gst's channel rule (`ffmpeg_utils.py:104-115`), shared by both audio callers (§10.3 "shared logic,
 * separate invocation"): 6+ channels with voice isolation take the centre channel, where a film mix
 * keeps its dialogue; anything else with more than one channel is an equal-weight downmix. Mono
 * needs no pan.
 */
function monoPan(channels: number, isolateVoice: boolean): string | null {
  if (channels <= 1) return null
  if (channels >= 6 && isolateVoice) return CENTRE_PAN
  const share = (1 / channels).toFixed(3)
  return `pan=mono|c0=${Array.from({ length: channels }, (_, i) => `${share}*c${i}`).join(' + ')}`
}

/** gst's MP3 bitrate for a 20 MB target, clamped to 16–192 kbps (`ffmpeg_utils.py:148-152`). */
export function transcriptionBitrateKbps(durationSeconds: number): number {
  const target = Math.trunc((20 * 8192 * 0.95) / durationSeconds)
  return Math.max(16, Math.min(target, 192))
}

/**
 * The extraction command. gst writes a PCM WAV and then compresses it; a lossless intermediate
 * changes nothing the encoder sees, so this is the same chain and bitrate in one pass.
 */
export function audioForTranscriptionArgs(input: string, outPath: string, props: AudioProps): string[] {
  return [
    '-y', '-i', input,
    '-map', `0:${props.streamIndex}`, '-vn', '-sn', '-dn', '-map_metadata', '-1',
    '-af', transcriptionFilterChain(props.channels).join(','),
    '-c:a', 'libmp3lame', '-b:a', `${transcriptionBitrateKbps(props.durationSeconds)}k`,
    outPath
  ]
}

export type PreparedAudio =
  | { ok: true; path: string; converted: boolean; durationSeconds: number }
  | MediaFailure

async function probeAudioProps(input: string, opts: MediaToolOptions): Promise<AudioProps | null> {
  const exec = opts.exec ?? execCapture
  const ffprobe = resolveTool('ffprobe', opts.ffmpegPath)
  const res = await exec(
    ffprobe,
    ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', '-select_streams', 'a', input],
    { signal: opts.signal, onChild: opts.onChild }
  )
  return res.code === 0 ? parseAudioProps(res.stdout) : null
}

/**
 * What the model hears, prepared the way the shipping engine prepared it.
 *
 * Video goes through gst's extraction (`ffmpeg_utils.py:75-182`) into `outPath`, which the caller
 * owns as scratch. Audio is used as it is: gst applied no filtering to an audio input, and the chunk
 * cutter decodes any format ffmpeg reads, so the 1.1.0 conversion of `.m4a`/`.aac`/`.flac` (a pydub
 * limitation, `pythonBridge.ts:539-549`) is not needed — the model hears the source rather than a
 * 64 kbps copy of it. The source is never modified. A failed or cancelled extraction removes its
 * own output, and a child that outlived its kill travels back as `orphan` (SOL-02).
 */
export async function audioForTranscription(
  input: string,
  outPath: string,
  opts: MediaToolOptions & { isVideo: boolean; onProgress?: ProgressReporter }
): Promise<PreparedAudio> {
  const signal = requireSignal(opts.signal, 'audioForTranscription')
  const props = await probeAudioProps(input, opts)
  if (signal.aborted) return { ok: false, error: 'Stopped.', aborted: true }
  if (!props) {
    return { ok: false, error: `"${path.basename(input)}" has no audio stream with a readable duration.` }
  }
  if (!opts.isVideo) return { ok: true, path: input, converted: false, durationSeconds: props.durationSeconds }

  const ffmpeg = resolveTool('ffmpeg', opts.ffmpegPath)
  const res = await execFfmpeg(ffmpeg, audioForTranscriptionArgs(input, outPath, props), {
    source: input,
    ffmpegPath: opts.ffmpegPath,
    signal,
    onProgress: opts.onProgress,
    onChild: opts.onChild,
    exec: opts.exec,
    durationSeconds: props.durationSeconds
  })
  let produced = false
  try {
    produced = res.code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0
  } catch {
    produced = false
  }
  if (produced && !signal.aborted) {
    const measured = await probeDuration(outPath, opts.ffmpegPath, signal, opts.onChild, opts.exec ?? execCapture)
    if (signal.aborted) {
      removeQuietly(outPath)
      return { ok: false, error: 'Stopped.', aborted: true }
    }
    return { ok: true, path: outPath, converted: true, durationSeconds: measured ?? props.durationSeconds }
  }
  removeQuietly(outPath)
  return failure(res, `ffmpeg exited with code ${res.code}`, signal.aborted)
}

/**
 * One chunk of the prepared audio, as MP3 bytes.
 *
 * gst cut chunks with pydub and exported each with pydub's defaults (`main.py:1636`): MP3 through
 * libmp3lame at its 128 kbps default, the segment's own channels and rate. `-b:a 128k` pins that
 * default rather than inheriting it. Input-side `-ss` is sample-accurate when transcoding.
 */
export function sliceArgs(input: string, startSeconds: number, endSeconds: number): string[] {
  return [
    '-ss', seconds3(startSeconds), '-t', seconds3(Math.max(0, endSeconds - startSeconds)), '-i', input,
    '-vn', '-sn', '-dn', '-map_metadata', '-1',
    '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'
  ]
}

export type AudioSlice = { ok: true; data: Buffer; mimeType: 'audio/mp3' } | MediaFailure

export async function sliceAudio(
  input: string,
  startSeconds: number,
  endSeconds: number,
  opts: MediaToolOptions
): Promise<AudioSlice> {
  const signal = requireSignal(opts.signal, 'sliceAudio')
  if (signal.aborted) return { ok: false, error: 'Stopped.', aborted: true }
  const exec = opts.exec ?? execCapture
  const parts: Buffer[] = []
  const res = await exec(resolveTool('ffmpeg', opts.ffmpegPath), sliceArgs(input, startSeconds, endSeconds), {
    signal,
    onChild: opts.onChild,
    onStdoutBytes: (b) => parts.push(b)
  })
  const data = Buffer.concat(parts)
  if (res.code === 0 && data.length > 0 && !signal.aborted) return { ok: true, data, mimeType: 'audio/mp3' }
  return failure(res, `ffmpeg exited with code ${res.code}`, signal.aborted)
}

/** Level over time: one RMS reading per window, in dBFS. */
export interface AudioEnvelope {
  windowSeconds: number
  /** One value per window; the last window may be shorter. */
  levelsDb: number[]
  durationSeconds: number
}

export const ENVELOPE_SAMPLE_RATE = 16_000
export const ENVELOPE_WINDOW_SECONDS = 0.1
/** Digital silence has no logarithm; it reads as this. */
export const ENVELOPE_FLOOR_DB = -100

/**
 * The decode the envelope reads. ⚠ No `-af` and no filter of any kind: mono at 16 kHz is a format
 * (it keeps the whole speech band up to 8 kHz), not an analysis filter. Whatever pre-filter a
 * consumer wants is applied to the file it passes in, never here.
 */
export function envelopeArgs(input: string): string[] {
  return [
    '-i', input, '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', String(ENVELOPE_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'
  ]
}

/** Streams 16-bit little-endian PCM into per-window RMS levels without holding the audio. */
export class EnvelopeAccumulator {
  private readonly window: number
  private sumSquares = 0
  private inWindow = 0
  private samples = 0
  private carry: number | null = null
  private readonly levels: number[] = []

  constructor(
    private readonly sampleRate = ENVELOPE_SAMPLE_RATE,
    private readonly windowSeconds = ENVELOPE_WINDOW_SECONDS
  ) {
    this.window = Math.max(1, Math.round(sampleRate * windowSeconds))
  }

  push(chunk: Buffer): void {
    let i = 0
    if (this.carry !== null && chunk.length > 0) {
      this.take(((chunk[0] << 8) | this.carry) << 16 >> 16)
      this.carry = null
      i = 1
    }
    for (; i + 1 < chunk.length; i += 2) this.take(chunk.readInt16LE(i))
    if (i < chunk.length) this.carry = chunk[i]
  }

  private take(sample: number): void {
    const v = sample / 32768
    this.sumSquares += v * v
    this.inWindow++
    this.samples++
    if (this.inWindow === this.window) this.close()
  }

  private close(): void {
    const rms = Math.sqrt(this.sumSquares / this.inWindow)
    this.levels.push(rms > 0 ? Math.max(ENVELOPE_FLOOR_DB, 20 * Math.log10(rms)) : ENVELOPE_FLOOR_DB)
    this.sumSquares = 0
    this.inWindow = 0
  }

  finish(): AudioEnvelope {
    if (this.inWindow > 0) this.close()
    return { windowSeconds: this.windowSeconds, levelsDb: [...this.levels], durationSeconds: this.samples / this.sampleRate }
  }
}

export type EnvelopeResult = { ok: true; envelope: AudioEnvelope } | MediaFailure

export async function envelope(input: string, opts: MediaToolOptions): Promise<EnvelopeResult> {
  const signal = requireSignal(opts.signal, 'envelope')
  if (signal.aborted) return { ok: false, error: 'Stopped.', aborted: true }
  const exec = opts.exec ?? execCapture
  const acc = new EnvelopeAccumulator()
  const res = await exec(resolveTool('ffmpeg', opts.ffmpegPath), envelopeArgs(input), {
    signal,
    onChild: opts.onChild,
    onStdoutBytes: (b) => acc.push(b)
  })
  if (res.code === 0 && !signal.aborted) return { ok: true, envelope: acc.finish() }
  return failure(res, `ffmpeg exited with code ${res.code}`, signal.aborted)
}

/**
 * D5-13's sample positions: `n` cuts of `seconds` spread from 10 % to 85 % of the running time
 * (six cuts land on 10/25/40/55/70/85 %). A film's head is very often speechless (E20a, F-A19), so
 * a contiguous head slice is the shape this exists to prevent. Starts are clamped inside the file.
 */
export function spreadOffsets(durationSeconds: number, n: number, seconds: number): number[] {
  if (!(durationSeconds > 0) || n < 1) return []
  const latest = Math.max(0, durationSeconds - seconds)
  const fractions = n === 1 ? [0.5] : Array.from({ length: n }, (_, i) => 0.1 + (0.75 * i) / (n - 1))
  return fractions.map((f) => Math.min(latest, Math.round(durationSeconds * f * 1000) / 1000))
}

export type SpreadSample =
  | { ok: true; path: string; offsets: number[]; durationSeconds: number }
  | MediaFailure

/**
 * One clip made of `n` samples drawn from across the file: `n` `-ss … -t …` cuts and one
 * `-f concat`. The signal is checked before every invocation, so a Stop ends the sequence between
 * cuts rather than letting the remaining ones run. `scratchPath` allocates the intermediate pieces
 * (removed here whatever happens); `outPath` is the caller's.
 */
export async function spreadSample(
  input: string,
  n: number,
  seconds: number,
  outPath: string,
  opts: MediaToolOptions & { scratchPath: (suffix: string) => string }
): Promise<SpreadSample> {
  const signal = requireSignal(opts.signal, 'spreadSample')
  const exec = opts.exec ?? execCapture
  const ffmpeg = resolveTool('ffmpeg', opts.ffmpegPath)
  const stopped: MediaFailure = { ok: false, error: 'Stopped.', aborted: true }
  if (signal.aborted) return stopped
  const duration = await probeDuration(input, opts.ffmpegPath, signal, opts.onChild, exec)
  if (signal.aborted) return stopped
  if (duration === null || duration <= 0) {
    return { ok: false, error: `"${path.basename(input)}" will not say how long it is.` }
  }
  const offsets = spreadOffsets(duration, n, seconds)
  const pieces: string[] = []
  const list = opts.scratchPath('.concat.txt')
  try {
    for (let i = 0; i < offsets.length; i++) {
      if (signal.aborted) return stopped
      const piece = opts.scratchPath(`.spread-${i}.wav`)
      pieces.push(piece)
      const res = await exec(
        ffmpeg,
        ['-y', '-ss', seconds3(offsets[i]), '-t', seconds3(seconds), '-i', input,
          '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(ENVELOPE_SAMPLE_RATE), '-c:a', 'pcm_s16le', piece],
        { signal, onChild: opts.onChild }
      )
      if (res.code !== 0 || signal.aborted) return failure(res, `ffmpeg exited with code ${res.code}`, signal.aborted)
    }
    if (signal.aborted) return stopped
    // Forward slashes inside single quotes: the concat demuxer reads backslashes as escapes.
    fs.writeFileSync(list, pieces.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf-8')
    const res = await exec(
      ffmpeg,
      ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-b:a', '64k', outPath],
      { signal, onChild: opts.onChild }
    )
    if (res.code !== 0 || signal.aborted) {
      removeQuietly(outPath)
      return failure(res, `ffmpeg exited with code ${res.code}`, signal.aborted)
    }
    return { ok: true, path: outPath, offsets, durationSeconds: duration }
  } finally {
    for (const p of pieces) removeQuietly(p)
    removeQuietly(list)
  }
}

// ── Bundle C: the default alignment detector's audio (§10.3, `feature_decisions.md` §5.2) ─────────
//
// The second in-process caller on the shared floor. It uses gst's channel rule and the stream gst
// would pick, then its own filter: a 1–4 kHz band-pass, the band a film mix ducks its score in to make
// room for the voice. That is speech-versus-music contrast for a detector, and the wrong input for a
// model, so it appears here and nowhere else. ⚠ It never calls `audioForTranscription()` or its
// chain, and the transcription chain never carries this band.
//
// One decode: the band-passed mono PCM is streamed once and measured by two accumulators at the
// sweep's two hop sizes. The threshold and minimum-span arms are then pure arithmetic on those two
// envelopes. Which candidate wins is decided by the caller from the histogram vote against the
// subtitle (§5.2 "keep whichever produces the strongest histogram vote"), never from ground truth.

export const ALIGNMENT_SAMPLE_RATE = 16_000
export const ALIGNMENT_HIGHPASS_HZ = 1000
export const ALIGNMENT_LOWPASS_HZ = 4000

/** E67's measured sweep (the research A/B script's `DEFAULT_SWEEP`), arm for arm. */
export const ALIGNMENT_SWEEP: Readonly<{
  hopMs: readonly number[]
  thresholdDb: readonly number[]
  minSpanMs: readonly number[]
}> = Object.freeze({
  hopMs: Object.freeze([50, 100]),
  thresholdDb: Object.freeze([-60, -50, -40, -35, -30, -25]),
  minSpanMs: Object.freeze([300, 500])
})

/** gst's channel rule, then the detector band, then gst's drift-locking resample. */
export function alignmentFilterChain(channels: number, isolateVoice = true): string[] {
  const pan = monoPan(channels, isolateVoice)
  return [
    ...(pan ? [pan] : []),
    `highpass=f=${ALIGNMENT_HIGHPASS_HZ}`,
    `lowpass=f=${ALIGNMENT_LOWPASS_HZ}`,
    'aresample=async=1'
  ]
}

/** The one decode: the chosen stream, band-passed, as 16 kHz mono 16-bit PCM on stdout. */
export function audioForAlignmentArgs(input: string, props: AudioProps, isolateVoice = true): string[] {
  return [
    '-nostats', '-i', input,
    '-map', `0:${props.streamIndex}`, '-vn', '-sn', '-dn',
    '-af', alignmentFilterChain(props.channels, isolateVoice).join(','),
    '-ac', '1', '-ar', String(ALIGNMENT_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'
  ]
}

/** A stretch of the band-passed audio at or above a threshold, in integer milliseconds. */
export interface SpeechSpan {
  startMs: number
  endMs: number
}

/**
 * The research detector's span rule (`alass_detector_ab.py` `spans_from_envelope`): a span opens at
 * the first window at or above the threshold, ends one hop after the last such window, and is kept
 * when it lasts at least `minSpanMs`. Window `i` starts at `i · hopMs`.
 */
export function speechSpans(levelsDb: readonly number[], hopMs: number, thresholdDb: number, minSpanMs: number): SpeechSpan[] {
  const spans: SpeechSpan[] = []
  let start: number | null = null
  let lastEnd = 0
  for (let i = 0; i < levelsDb.length; i++) {
    const t = i * hopMs
    if (levelsDb[i] >= thresholdDb) {
      if (start === null) start = t
      lastEnd = t + hopMs
    } else if (start !== null) {
      if (lastEnd - start >= minSpanMs) spans.push({ startMs: start, endMs: lastEnd })
      start = null
    }
  }
  if (start !== null && lastEnd - start >= minSpanMs) spans.push({ startMs: start, endMs: lastEnd })
  return spans
}

export interface AlignmentEnvelope {
  hopMs: number
  levelsDb: number[]
}

export interface AlignmentCandidate {
  hopMs: number
  thresholdDb: number
  minSpanMs: number
  spans: SpeechSpan[]
}

/** Every sweep arm over the measured envelopes, in the sweep's own order (hop, threshold, span). */
export function alignmentSweep(envelopes: readonly AlignmentEnvelope[]): AlignmentCandidate[] {
  const out: AlignmentCandidate[] = []
  for (const hopMs of ALIGNMENT_SWEEP.hopMs) {
    const env = envelopes.find((e) => e.hopMs === hopMs)
    if (!env) continue
    for (const thresholdDb of ALIGNMENT_SWEEP.thresholdDb) {
      for (const minSpanMs of ALIGNMENT_SWEEP.minSpanMs) {
        out.push({ hopMs, thresholdDb, minSpanMs, spans: speechSpans(env.levelsDb, hopMs, thresholdDb, minSpanMs) })
      }
    }
  }
  return out
}

export type AlignmentAudio =
  | {
      ok: true
      durationSeconds: number
      channels: number
      streamIndex: number
      /** The `-af` value the decode ran with: what the detector heard, for the evidence. */
      filter: string
      /** Seconds of PCM actually decoded — the timeline the spans are measured on. */
      decodedSeconds: number
      envelopes: AlignmentEnvelope[]
      candidates: AlignmentCandidate[]
    }
  | MediaFailure

/**
 * The default alignment detector's input: probe the stream gst would pick, decode it once through
 * `alignmentFilterChain`, and return the sweep's candidates. Nothing is written to disk, and the
 * source is only read. A Stop ends the probe or the decode; a child that outlives its kill comes back
 * as `orphan`, as for every helper here.
 */
export async function audioForAlignment(
  input: string,
  opts: MediaToolOptions & { isolateVoice?: boolean; onProgress?: ProgressReporter }
): Promise<AlignmentAudio> {
  const signal = requireSignal(opts.signal, 'audioForAlignment')
  if (signal.aborted) return { ok: false, error: 'Stopped.', aborted: true }
  const props = await probeAudioProps(input, opts)
  if (signal.aborted) return { ok: false, error: 'Stopped.', aborted: true }
  if (!props) return { ok: false, error: `"${path.basename(input)}" has no audio stream with a readable duration.` }

  const isolateVoice = opts.isolateVoice ?? true
  const accumulators = ALIGNMENT_SWEEP.hopMs.map((hopMs) => ({ hopMs, acc: new EnvelopeAccumulator(ALIGNMENT_SAMPLE_RATE, hopMs / 1000) }))
  const startedAt = Date.now()
  let bytes = 0
  const exec = opts.exec ?? execCapture
  const res = await exec(resolveTool('ffmpeg', opts.ffmpegPath), audioForAlignmentArgs(input, props, isolateVoice), {
    signal,
    onChild: opts.onChild,
    onStdoutBytes: (chunk) => {
      for (const a of accumulators) a.acc.push(chunk)
      bytes += chunk.length
      opts.onProgress?.(percentOf(bytes / (2 * ALIGNMENT_SAMPLE_RATE), props.durationSeconds), Date.now() - startedAt)
    }
  })
  if (res.code !== 0 || signal.aborted) return failure(res, `ffmpeg exited with code ${res.code}`, signal.aborted)
  if (bytes < 2) return { ok: false, error: `No audio could be decoded from "${path.basename(input)}".` }

  const envelopes = accumulators.map(({ hopMs, acc }) => ({ hopMs, levelsDb: acc.finish().levelsDb }))
  return {
    ok: true,
    durationSeconds: props.durationSeconds,
    channels: props.channels,
    streamIndex: props.streamIndex,
    filter: alignmentFilterChain(props.channels, isolateVoice).join(','),
    decodedSeconds: Math.floor(bytes / 2) / ALIGNMENT_SAMPLE_RATE,
    envelopes,
    candidates: alignmentSweep(envelopes)
  }
}
