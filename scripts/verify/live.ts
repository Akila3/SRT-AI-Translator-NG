/**
 * Live verification probes — the automatable half of the Phase A/B/C matrix.
 *
 * These are the checks `npm run test:gates` cannot make, because they need a real API key, real
 * FFmpeg and the real provider: that the native engine reaches Google, that a translation
 * round-trips, that Hebrew survives, that an `.ass` source is refused and left untouched, that an
 * embedded subtitle track can be probed, extracted and translated, and that transcription works.
 * The gst arms (L1–L5, L6's translation, L7–L9) went with the CLI at Step 4.5; their successors are
 * N1–N9 (gate_ledger.md §5m.0 Receipt 2).
 *
 * N1–N9 run on a key alone. L6 needs media fixtures in `.secrets/fixtures/`; without them it
 * reports SKIP rather than failing. `SRT_LIVE_ONLY=native` skips L6.
 *
 * WHAT THIS DOES NOT COVER. The packaged build only reproduces in a packaged app, so a dev pass
 * cannot substitute. Anything driven through the Electron UI — the regression sweep, the startup
 * log, key-tier promotion in Settings — also stays manual.
 *
 * COST. Every run makes real API calls. The fixtures are five cues each and the models are
 * Flash-Lite 3.5 and Flash 3.7 at LOW, so a full pass is a handful of requests, but it is not free
 * and it consumes free-tier quota.
 *
 * SECRECY. The key is read from a git-ignored file and never printed: everything the probe reports
 * is passed through `mask()` before it can reach the console.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isRunning } from '../../electron/engine/runner'
import { tempOutputPath } from '../../electron/main/tempFiles'
import { extractTrack, probeTracks } from '../../electron/main/ffmpeg'
import { refreshModels } from '../../electron/main/modelsList'
import { getSettings, setSettings } from '../../electron/main/store'
import { registerIpc, setMainWindow } from '../../electron/main/ipc'
import { __invokeIpc } from '../gates/stubs/electron'
import { modelCapabilities } from '../../electron/shared/modelCaps'
import type { TranscribeArgs, TranslateArgs } from '../../electron/shared/types'
import type { RunEvent } from '../../electron/shared/engineEvents'
import { findConsoleLog } from '../../electron/shared/consoleLog'

// The bundle executes from a temp directory, so paths are resolved from the working
// directory instead — `npm run` always sets that to the package root.
const ROOT = process.cwd()
const KEY_FILE = path.join(ROOT, '.secrets', 'gemini-key.txt')
const FIXTURE_DIR = path.join(ROOT, '.secrets', 'fixtures')
const TIMEOUT_MS = 300_000

/**
 * Which ffmpeg the probes use.
 *
 * Production reads `getSettings().ffmpegPath`, which these probes cannot: they run outside
 * Electron against stubbed settings. Undefined therefore means the bundled binaries, and
 * these probes verify the DEFAULT environment only. Set `SRT_VERIFY_FFMPEG_PATH` to the
 * value you configured in Settings to verify an override instead — it is then applied
 * consistently to the persisted setting, `probeTracks` and `extractTrack`, because
 * checking one of the three with an override and the others without would be worse than
 * not checking at all.
 */
const FFMPEG_PATH = process.env.SRT_VERIFY_FFMPEG_PATH?.trim() || undefined

let passes = 0
let failures = 0
let skipped = 0
const failed: string[] = []

function section(name: string): void {
  console.log(`\n=== ${name} ===`)
}

function skip(label: string, why: string): void {
  skipped++
  console.log(`  SKIP  ${label} — ${why}`)
}

function check(label: string, ok: boolean, detail = ''): boolean {
  if (ok) {
    passes++
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    failed.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
  return ok
}

/** Redact the key from anything on its way to the console. */
let secret = ''
function mask(text: string): string {
  if (!secret) return text
  return text.split(secret).join('***KEY***')
}

function loadKey(): string {
  const fromEnv = process.env.GEMINI_API_KEY?.trim()
  if (fromEnv) return fromEnv
  if (!fs.existsSync(KEY_FILE)) {
    console.error(
      `\nNo API key found.\n` +
        `  Put one line containing the key in: ${KEY_FILE}\n` +
        `  (or set GEMINI_API_KEY in the environment)\n` +
        `  .secrets/ is git-ignored. Use a disposable key and revoke it afterwards.\n`
    )
    process.exit(1)
  }
  const lines = fs
    .readFileSync(KEY_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (lines.length === 0) {
    console.error(`\n${KEY_FILE} contains no key line.\n`)
    process.exit(1)
  }
  // A file a human maintains gets labels — this one holds a free key and a paid one, written
  // as "Free: …" and "Paid: …". Taking the line whole sent the label to Google as part of the
  // credential and the run died at L1 on "API key not valid", which is an expensive-looking way
  // to report a parsing problem, and one that reads as a revoked key rather than a bad parse.
  //
  // Three attempts, narrowing: a Google-shaped token anywhere in the line; failing that, the
  // line with a short leading label stripped; failing that, the line verbatim, which is what
  // every previous run relied on. Nothing here prints the file.
  for (const line of lines) {
    const shaped = /AIza[A-Za-z0-9_-]{20,}/.exec(line)?.[0]
    if (shaped) return shaped
  }
  const first = lines[0]
  const unlabelled = /^[A-Za-z][A-Za-z ]{0,20}[:=]\s*(\S+)/.exec(first)?.[1]
  return unlabelled ?? first
}

const SRT_FIXTURE = [
  '1\n00:00:01,000 --> 00:00:03,000\nGood morning.\n',
  '2\n00:00:04,000 --> 00:00:06,000\nHow are you today?\n',
  '3\n00:00:07,000 --> 00:00:09,000\nI am fine, thank you.\n',
  '4\n00:00:10,000 --> 00:00:12,000\nWhere is the train station?\n',
  '5\n00:00:13,000 --> 00:00:15,000\nIt is on the left.\n'
].join('\n')

// The full ten-field event format, because that is what real files use — and because a
// shortened `Format:` line is parsed positionally by pysubs2, which silently lands the
// dialogue in the Name field and leaves Text empty. `Émphase` is deliberately non-ASCII:
// gate G2 requires style names to survive the round trip intact.
const ASS_FIXTURE = `[Script Info]
Title: Verification fixture
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: Émphase,Arial,24,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Good morning.
Dialogue: 0,0:00:04.00,0:00:06.00,Émphase,,0,0,0,,How are you today?
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,I am fine, thank you.
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Where is the train station?
Dialogue: 0,0:00:13.00,0:00:15.00,Émphase,,0,0,0,,It is on the left.
`

function translateFixtureArgs(over: Partial<TranslateArgs> = {}): TranslateArgs {
  const base: TranslateArgs = {
    inputFile: '',
    sourceLang: 'en',
    targetLang: 'es',
    model: '',
    apiKeys: [secret],
    batchSize: 100,
    batchContext: true,
    customGenerationParams: false,
    temperature: 1,
    topP: 0.95,
    topK: null,
    thinkingLevel: 'low',
    thinkingBudget: 512,
    serviceTier: 'standard',
    paidQuota: false,
    disableStreaming: false,
    writeTokenReport: false,
    progressLog: false,
    thoughtsLog: false,
    ...over
  }
  return base
}

function transcribeArgs(mediaFile: string, model: string, outputFile: string): TranscribeArgs {
  return {
    mediaFile,
    outputFile,
    targetLang: 'en',
    model,
    apiKeys: [secret],
    thinkingLevel: 'low',
    thinkingBudget: 512,
    customGenerationParams: false,
    temperature: 1,
    topP: 0.95,
    topK: null
  }
}

/**
 * Newest flash-lite in the fetched list, so the probes cost as little as possible.
 *
 * `eligible` exists because not every cheap model can do every job: transcription needs a
 * 2.5 or 3.x model, and spawning a 2.0 model would produce an engine error the UI would
 * never allow — a probe failure that says nothing about the app.
 *
 * `fallbackToAnyEligible` decides what "none of the cheap tiers qualify" means. For the
 * translation probes it means stop: they are cost-driven and a `pro` model is not a
 * silent substitute for one. For transcription it means widen, because a key exposing a
 * capable `pro` model but no capable flash really does support the feature, and skipping
 * it would report missing coverage that is not missing.
 */
function cheapestModel(
  ids: string[],
  eligible: (id: string) => boolean = () => true,
  { fallbackToAnyEligible = false } = {}
): string | null {
  const usable = ids.filter(eligible)
  const stable = (id: string): boolean => !id.includes('preview')
  const versionOf = (id: string): number[] => {
    const m = id.match(/(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2])] : [0, 0]
  }
  const newest = (pool: string[]): string | null =>
    pool.length
      ? [...pool].sort((a, b) => {
          const [am, an] = versionOf(a)
          const [bm, bn] = versionOf(b)
          return bm - am || bn - an
        })[0]
      : null

  return (
    newest(usable.filter((id) => id.includes('flash-lite') && stable(id))) ??
    newest(usable.filter((id) => id.includes('flash') && stable(id))) ??
    (fallbackToAnyEligible ? (newest(usable.filter(stable)) ?? newest(usable)) : null)
  )
}

/**
 * Independent expectations for L6's classification check, written from what the formats ARE
 * rather than from `ffmpeg.ts`'s own list — an oracle copied from the code under test cannot
 * disagree with it. `dvb_subtitle` is deliberately included: it is a bitmap format, so if a
 * fixture carries one and this check fails, that is a real gap in the app's `IMAGE_CODECS`,
 * not a bad expectation.
 */
const IMAGE_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'pgssub',
  'dvd_subtitle',
  'dvdsub',
  'dvb_subtitle',
  'dvbsub',
  'xsub'
])
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
  'subviewer',
  'microdvd'
])

function hasHebrew(text: string): boolean {
  return /[\u0590-\u05FF]/.test(text)
}

function cueCount(srt: string): number {
  return (srt.match(/-->/g) ?? []).length
}

/** First N cues of an SRT, so a stage-2 translation stays cheap. */
function firstCues(srt: string, n: number): string {
  const blocks = srt.split(/\r?\n\r?\n/).filter((b) => b.includes('-->'))
  return blocks.slice(0, n).join('\n\n') + '\n'
}

const CLIP_SECONDS = 30
/**
 * A copied video clip can be large without being expensive: for video input the engine
 * extracts and compresses the audio itself and uploads only that. This ceiling exists to
 * catch a clip that failed to trim, not to control upload size.
 */
const CLIP_MAX_BYTES = 200_000_000

function ffmpegBinary(): string {
  const exe = process.platform === 'win32' ? '.exe' : ''
  if (FFMPEG_PATH) return path.join(path.dirname(FFMPEG_PATH), `ffmpeg${exe}`)
  const bundled = path.join(ROOT, 'resources', 'bin', `ffmpeg${exe}`)
  return fs.existsSync(bundled) ? bundled : 'ffmpeg'
}

function ffmpegRun(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(ffmpegBinary(), args, { windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })
}

/**
 * A short stream-copied clip of a fixture, or null if ffmpeg cannot produce one.
 *
 * Video is preferred, and stream-copied rather than re-encoded, because that is the path a
 * user actually takes: the engine extracts and compresses the audio itself, so what it
 * receives is the fixture's own bytes and a failure implicates the app rather than a
 * transcoding step the app never performs.
 *
 * The audio fallback is deliberately **MP3, mono**, not m4a. The engine loads audio through
 * pydub, which hands the file to ffmpeg with a forced format; an AAC/MP4 clip is decoded as
 * mp3float, yields no packets, and fails with "Conversion failed!". MP3 is also exactly what
 * the engine's own `extract_audio_from_video` produces, so the fallback stays inside the
 * range of inputs the engine is built to read.
 */
async function makeClip(source: string, work: string): Promise<string | null> {
  const clip = path.join(work, `clip${path.extname(source).toLowerCase()}`)
  // `-t` goes AFTER `-i`: as an input option it limits how much is *read*, which a
  // stream copy of an mkv can ignore — the first attempt at this produced a "clip" the
  // size of the whole film.
  const copied = await ffmpegRun([
    '-y', '-i', source, '-t', String(CLIP_SECONDS),
    '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', clip
  ])
  if (copied && fs.existsSync(clip) && fs.statSync(clip).size <= CLIP_MAX_BYTES) return clip

  const audio = path.join(work, 'clip.mp3')
  const extracted = await ffmpegRun([
    '-y', '-i', source, '-t', String(CLIP_SECONDS),
    '-vn', '-sn', '-dn', '-map', '0:a:0', '-map_metadata', '-1',
    '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '48k', audio
  ])
  if (extracted && fs.existsSync(audio)) {
    console.log('        note: no usable video clip, so this runs the audio (-a) path')
    return audio
  }
  console.log('        note: could not clip the fixture; transcribing it whole (this will be slow)')
  return null
}

/** Stage-2 fixtures the user drops in; absent means the probe skips, never fails. */
function fixtures(exts: string[]): string[] {
  if (!fs.existsSync(FIXTURE_DIR)) return []
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => exts.includes(path.extname(f).toLowerCase()))
    .map((f) => path.join(FIXTURE_DIR, f))
    .sort()
}

// ── Native successors (Step 4.2, P4-G2) ──────────────────────────────────────────
//
// The questions L1–L9 asked of gst, asked of the engine that replaced it, through the production
// owners: the real IPC handlers (model guard, key preflight, Settings, output scan, resume store), the
// real runner and native adapter, the real Gemini provider and real FFmpeg. Only the window is a
// stand-in, so the events the renderer would receive can be read here.

/** Translation: Flash-Lite 3.5 at LOW. Transcription: Flash 3.7 at LOW. Each falls back only if the key lacks it. */
const NATIVE_TRANSLATE_MODEL = 'gemini-3.5-flash-lite'
const NATIVE_TRANSCRIBE_MODEL = 'gemini-3.7-flash'

type FinishedEvent = Extract<RunEvent, { type: 'finished' }>

interface NativeOutcome {
  returned: unknown
  threw: string | null
  events: RunEvent[]
  finished: FinishedEvent | undefined
  endings: number
}

const windowEvents: RunEvent[] = []
let windowReady = false
let nativeSeq = 0

function nativeWindow(): void {
  if (windowReady) return
  windowReady = true
  const contents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      if (channel === 'engine:event') windowEvents.push(payload as RunEvent)
    }
  }
  setMainWindow({ isDestroyed: () => false, on: () => undefined, webContents: contents } as unknown as Parameters<typeof setMainWindow>[0])
  registerIpc()
}

const eventsOf = (runId: string): RunEvent[] => windowEvents.filter((e) => e.runId === runId)

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}

/** Start through the real handler and wait for its one terminal event; `during` runs while it is live. */
async function nativeIpc(
  channel: 'translate:start' | 'transcribe:start',
  args: TranslateArgs | TranscribeArgs,
  during?: (runId: string) => Promise<void>
): Promise<NativeOutcome> {
  const runId = `live-native-${++nativeSeq}`
  let threw: string | null = null
  let returned: unknown
  const call = Promise.resolve()
    .then(() => __invokeIpc(channel, { ...args, runId }))
    .then(
      (r) => (returned = r),
      (e: unknown) => (threw = e instanceof Error ? e.message : String(e))
    )
  if (during) await during(runId)
  await call
  await waitFor(() => eventsOf(runId).some((e) => e.type === 'finished'), TIMEOUT_MS)
  await new Promise((r) => setTimeout(r, 250))
  const events = eventsOf(runId)
  const finals = events.filter((e): e is FinishedEvent => e.type === 'finished')
  return { returned, threw, events, finished: finals[0], endings: finals.length }
}

const nativeLog = (o: NativeOutcome): string[] =>
  o.events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log').map((e) => e.text)

const describeEnd = (o: NativeOutcome): string =>
  mask(JSON.stringify({ outcome: o.finished?.outcome, reason: o.finished?.reason, error: o.finished?.error, threw: o.threw }))

const AUDIO_SCRATCH = /\.(mp3|wav|m4a|aac|flac|ogg|opus|concat\.txt)$/i
function scratchAudio(): string[] {
  const dir = path.dirname(tempOutputPath('.mp3'))
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => AUDIO_SCRATCH.test(f)).sort() : []
}

async function nativeArms(work: string): Promise<void> {
  nativeWindow()
  const previous = process.env.SRT_ENGINE
  process.env.SRT_ENGINE = 'native'
  try {
    // N1 — the model list, through the real Settings refresh.
    section('N1 — the native model list through models:checkKeys')
    setSettings({ apiKeys: [secret] })
    const refreshed = (await __invokeIpc('models:checkKeys', [secret])) as {
      anyValid: boolean
      refreshOutcome: string
      models: Array<{ id: string }>
    }
    check(
      'N1 the native model list is valid for the key',
      refreshed.anyValid && (refreshed.refreshOutcome === 'allComplete' || refreshed.refreshOutcome === 'activeComplete'),
      refreshed.refreshOutcome
    )
    const listed = refreshed.models.map((m) => m.id)
    check('N1 it returns at least one model', listed.length > 0, `${listed.length} models`)
    const trModel = listed.includes(NATIVE_TRANSLATE_MODEL) ? NATIVE_TRANSLATE_MODEL : (cheapestModel(listed) ?? NATIVE_TRANSLATE_MODEL)
    const txModel = listed.includes(NATIVE_TRANSCRIBE_MODEL)
      ? NATIVE_TRANSCRIBE_MODEL
      : (cheapestModel(listed, (id) => modelCapabilities(id).supportsTranscription, { fallbackToAnyEligible: true }) ?? NATIVE_TRANSCRIBE_MODEL)
    console.log(`        translation: ${trModel} at low; transcription: ${txModel} at low (${listed.length} ids on the key)`)

    const srt = path.join(work, 'native-sample.srt')
    fs.writeFileSync(srt, SRT_FIXTURE, 'utf8')

    // N2 — five cues into Spanish.
    section('N2 — native five-cue SRT translation')
    const es = await nativeIpc('translate:start', translateFixtureArgs({ inputFile: srt, targetLang: 'es', model: trModel }))
    check('N2 the translation completes', es.finished?.outcome === 'completed' && es.endings === 1, describeEnd(es))
    const esOut = es.finished?.outputPath ?? ''
    if (check('N2 an output file is written', !!esOut && fs.existsSync(esOut))) {
      const body = fs.readFileSync(esOut, 'utf8')
      check('N2 all five cues survive', cueCount(body) === 5, `${cueCount(body)} cues`)
      check('N2 timings are unchanged', body.includes('00:00:01,000 --> 00:00:03,000'))
      check('N2 the text is not still English', !body.includes('Where is the train station?'))
    }

    // N3 — Hebrew; there is no Python stdio, so the console is the place an encoding fault would show.
    section('N3 — native Hebrew output')
    const he = await nativeIpc('translate:start', translateFixtureArgs({ inputFile: srt, targetLang: 'he', model: trModel }))
    check('N3 the translation completes', he.finished?.outcome === 'completed' && he.endings === 1, describeEnd(he))
    const heOut = he.finished?.outputPath ?? ''
    if (check('N3 an output file is written', !!heOut && fs.existsSync(heOut))) {
      const body = fs.readFileSync(heOut, 'utf8')
      check('N3 the output contains Hebrew characters', hasHebrew(body))
      check('N3 the file decodes as UTF-8 without replacement characters', !body.includes('\uFFFD'))
      check('N3 all five cues survive', cueCount(body) === 5, `${cueCount(body)} cues`)
    }
    const heConsole = findConsoleLog(he.finished?.logPaths)
    const heConsoleText = heConsole && fs.existsSync(heConsole) ? fs.readFileSync(heConsole, 'utf8') : ''
    check(
      'N3 the console has no encoding error',
      heConsoleText.startsWith('[native engine] translate ') && !/charmap|UnicodeEncodeError|UnicodeDecodeError|\uFFFD/i.test(heConsoleText),
      heConsole || 'no console offered'
    )

    // N4 — the sanctioned D3/D4 reduction: an .ass source is refused by name, and left alone.
    section('N4 — an .ass source is refused, untouched (D3/D4)')
    const ass = path.join(work, 'native-styled.ass')
    fs.writeFileSync(ass, ASS_FIXTURE, 'utf8')
    const assBytes = fs.readFileSync(ass)
    const refusedAss = await nativeIpc('translate:start', translateFixtureArgs({ inputFile: ass, targetLang: 'he', model: trModel }))
    check(
      'N4 an .ass source is refused by name before any request',
      refusedAss.finished?.outcome === 'failed' &&
        /ASS\/SSA/.test(refusedAss.finished.error?.message ?? '') &&
        !refusedAss.events.some((e) => e.type === 'unit'),
      describeEnd(refusedAss)
    )
    check("N4 the user's original .ass is byte-identical afterwards", Buffer.compare(assBytes, fs.readFileSync(ass)) === 0)

    // N5 — nothing about the model list needs FFmpeg.
    section('N5 — the native model list with no FFmpeg on PATH')
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-nopath-native-'))
    const savedPath = { PATH: process.env.PATH, Path: process.env.Path }
    process.env.PATH = emptyDir
    process.env.Path = emptyDir
    let bare: Awaited<ReturnType<typeof refreshModels>>
    try {
      bare = await refreshModels(secret)
    } finally {
      process.env.PATH = savedPath.PATH
      process.env.Path = savedPath.Path
    }
    check('N5 with no FFmpeg on PATH the native model list completes', bare.verdict === 'valid' && bare.ids.length > 0, mask(bare.error))
    check('N5 and does not mention FFmpeg', !/ffmpeg/i.test(bare.error), mask(bare.error))

    // N6 — an extracted embedded track translates natively.
    section('N6 — an embedded subtitle track translates natively')
    const videos = fixtures(['.mkv', '.mp4', '.mov', '.webm', '.m4v'])
    let n6Done = false
    for (const video of videos) {
      const text = (await probeTracks(video, FFMPEG_PATH)).filter((t) => !t.isImage)
      if (!text.length) continue
      const extracted = path.join(work, `native-${path.parse(video).name}_t${text[0].index}.srt`)
      const res = await extractTrack(video, text[0].index, extracted, false, FFMPEG_PATH)
      if (!res.ok || !fs.existsSync(extracted)) continue
      const trimmed = path.join(work, `native-${path.parse(video).name}_trimmed.srt`)
      fs.writeFileSync(trimmed, firstCues(fs.readFileSync(extracted, 'utf8'), 5), 'utf8')
      const tr = await nativeIpc('translate:start', translateFixtureArgs({ inputFile: trimmed, targetLang: 'he', model: trModel }))
      check(`N6 ${path.basename(video)}: the extracted track translates natively`, tr.finished?.outcome === 'completed', describeEnd(tr))
      const out = tr.finished?.outputPath ?? ''
      check(`N6 ${path.basename(video)}: the translation contains Hebrew`, !!out && fs.existsSync(out) && hasHebrew(fs.readFileSync(out, 'utf8')))
      n6Done = true
      break
    }
    if (!n6Done) skip('N6 embedded-track native translation', `no video with a text track in ${FIXTURE_DIR}`)

    const media = fixtures(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.mkv', '.mp4', '.mov', '.webm'])
    const smallest = media.length ? [...media].sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0] : ''
    const nativeTranscribeArgs = (mediaFile: string, outputFile: string): TranscribeArgs => ({
      ...transcribeArgs(mediaFile, txModel, outputFile),
      thinkingLevel: 'low'
    })

    // N7 — a real transcription.
    section('N7 — native transcription')
    if (!smallest) {
      skip('N7 native transcription end to end', `no audio or video in ${FIXTURE_DIR}`)
    } else {
      const nativeWork = fs.mkdtempSync(path.join(work, 'n7-'))
      const source = (await makeClip(smallest, nativeWork)) ?? smallest
      const label = path.basename(source)
      const outTx = path.join(nativeWork, 'native-transcribed.srt')
      const tx = await nativeIpc('transcribe:start', nativeTranscribeArgs(source, outTx))
      check(`N7 ${label}: the transcription completes`, tx.finished?.outcome === 'completed' && tx.endings === 1, describeEnd(tx))
      if (check(`N7 ${label}: an .srt is written`, fs.existsSync(outTx))) {
        const body = fs.readFileSync(outTx, 'utf8')
        check(`N7 ${label}: the transcript contains cues`, cueCount(body) > 0, `${cueCount(body)} cues`)
        check(`N7 ${label}: cues carry text, not just timestamps`, /-->.*\r?\n\s*\S+/.test(body))
        check(`N7 ${label}: no replacement characters`, !body.includes('\uFFFD'))
      } else {
        console.log(mask(nativeLog(tx).slice(-10).join('\n')))
      }
    }

    // N8 — audio gst could not read: native prepares it itself, and leaves the user's file alone.
    section('N8 — native transcription of an .m4a')
    const m4a = path.join(work, 'native-unreadable.m4a')
    const builtM4a =
      !!smallest &&
      (await ffmpegRun(['-y', '-i', smallest, '-t', String(CLIP_SECONDS), '-vn', '-sn', '-dn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '96k', m4a])) &&
      fs.existsSync(m4a)
    if (!builtM4a) {
      skip('N8 the .m4a round trip', 'ffmpeg could not build an .m4a fixture')
    } else {
      const before = fs.readFileSync(m4a)
      const scratchBefore = scratchAudio()
      const outM4a = path.join(work, 'native-converted.srt')
      const m = await nativeIpc('transcribe:start', nativeTranscribeArgs(m4a, outM4a))
      check('N8 the app transcribes the .m4a natively', m.finished?.outcome === 'completed', describeEnd(m))
      const preparing = m.events.findIndex((e) => e.type === 'phase' && e.phase === 'preparing')
      const firstUnit = m.events.findIndex((e) => e.type === 'unit')
      check(
        'N8 it says it is preparing the audio before the request',
        preparing >= 0 && firstUnit > preparing && nativeLog(m).some((l) => l.startsWith('Reading "native-unreadable.m4a"')),
        `preparing ${preparing}, first unit ${firstUnit}`
      )
      if (check('N8 an .srt is written for the prepared audio', fs.existsSync(outM4a))) {
        const body = fs.readFileSync(outM4a, 'utf8')
        check('N8 it contains cues with text', cueCount(body) > 0 && /-->.*\r?\n\s*\S+/.test(body))
      }
      check("N8 the user's original .m4a is byte-identical afterwards", Buffer.compare(before, fs.readFileSync(m4a)) === 0)
      check('N8 the temporary audio is deleted once the job ends', JSON.stringify(scratchAudio()) === JSON.stringify(scratchBefore), JSON.stringify(scratchAudio()))

      const configuredFfmpeg = getSettings().ffmpegPath
      setSettings({ ffmpegPath: path.join(work, 'no-such-ffmpeg.exe') })
      const bogusOut = path.join(work, 'native-bogus-ffmpeg.srt')
      let bogus: NativeOutcome
      try {
        bogus = await nativeIpc('transcribe:start', nativeTranscribeArgs(m4a, bogusOut))
      } finally {
        setSettings({ ffmpegPath: configuredFfmpeg })
      }
      check(
        'N8 the conversion uses the FFmpeg configured in Settings',
        bogus.finished?.outcome === 'failed' && !fs.existsSync(bogusOut) && !bogus.events.some((e) => e.type === 'unit'),
        describeEnd(bogus)
      )
      check(
        'N8 a broken FFmpeg is reported as a preparation failure',
        /ffmpeg|audio/i.test(bogus.finished?.error?.message ?? ''),
        mask(bogus.finished?.error?.message ?? '')
      )
    }

    // N9 — the slot, the refusals and Stop, all while the audio is still being prepared.
    section('N9 — Stop and the single-job lock during native preparation')
    const long = path.join(work, 'native-lifecycle.m4a')
    const builtLong =
      (await ffmpegRun(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1800', '-c:a', 'aac', '-b:a', '96k', long])) && fs.existsSync(long)
    if (!builtLong) {
      skip('N9 the preparation lifecycle', 'ffmpeg could not build a long .m4a fixture')
    } else {
      const scratchBefore = scratchAudio()
      const outLong = path.join(work, 'native-lifecycle.srt')
      let held = false
      let second: NativeOutcome | null = null
      let other: NativeOutcome | null = null
      const run = await nativeIpc('transcribe:start', nativeTranscribeArgs(long, outLong), async (runId) => {
        await waitFor(() => eventsOf(runId).some((e) => e.type === 'phase' && e.phase === 'preparing'), 60_000)
        held = isRunning() && !eventsOf(runId).some((e) => e.type === 'unit')
        second = await nativeIpc('transcribe:start', nativeTranscribeArgs(long, path.join(work, 'native-second.srt')))
        other = await nativeIpc('translate:start', translateFixtureArgs({ inputFile: srt, targetLang: 'he', model: trModel }))
        await __invokeIpc('translate:stop')
      })
      const busy = (o: NativeOutcome | null): boolean =>
        o?.finished?.outcome === 'failed' && o.finished.error?.kind === 'refusedByApp' && o.finished.error.message === 'A process is already running.'
      check('N9 the job slot is held while the audio is being prepared', held)
      check('N9 a second job started during preparation is refused', busy(second), second ? describeEnd(second) : 'never started')
      check('N9 translate:start is refused without taking the slot', busy(other), other ? describeEnd(other) : 'never started')
      check(
        'N9 the refusal is the busy one, not the guard',
        (second as NativeOutcome | null)?.finished?.reason !== 'guard' && (other as NativeOutcome | null)?.finished?.reason !== 'guard'
      )
      check('N9 Stop during preparation ends the job', run.endings === 1, `${run.endings} endings`)
      check('N9 it does not report success', run.finished?.outcome === 'stopped' && run.finished.reason === 'user', describeEnd(run))
      check('N9 no request was sent', !run.events.some((e) => e.type === 'unit'))
      check('N9 no transcript is produced after a Stop', !fs.existsSync(outLong))
      check('N9 the slot is released', !isRunning())
      check('N9 the temporary audio is not left behind', JSON.stringify(scratchAudio()) === JSON.stringify(scratchBefore), JSON.stringify(scratchAudio()))
      check('N9 the user is told why it stopped', nativeLog(run).some((l) => /stopped/i.test(l)), mask(nativeLog(run).slice(-3).join(' | ')))
    }
  } finally {
    if (previous === undefined) delete process.env.SRT_ENGINE
    else process.env.SRT_ENGINE = previous
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
    console.error(`\nRun this from the project root (via npm run verify:live). Saw: ${ROOT}\n`)
    process.exit(1)
  }
  secret = loadKey()

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-verify-'))
  console.log(`Workspace: ${work}`)
  // Length and shape only — never the key. Enough to tell a parsing failure apart from a
  // revoked credential without anyone having to open the file.
  console.log(
    `Key:       loaded, never printed (${secret.length} chars, ` +
      `${/^AIza[A-Za-z0-9_-]{20,}$/.test(secret) ? 'AIza-shaped' : 'not AIza-shaped'})`
  )
  console.log(
    `ffmpeg:    ${FFMPEG_PATH ?? 'bundled/default (set SRT_VERIFY_FFMPEG_PATH to verify an override)'}`
  )

  // An override has to reach the app the way a user's does — through the persisted setting —
  // or the native runs read the stub's empty default and quietly use a different binary than
  // the direct calls, which is worse than not offering the mode.
  if (FFMPEG_PATH) setSettings({ ffmpegPath: FFMPEG_PATH })

  // Selection self-checks. These settle the cases a normal account never exercises — a key
  // with a capable pro model but no capable flash — without waiting for such a key to exist.
  section('L1 — the probes choose their models the way the app would')
  const capable = (id: string): boolean => modelCapabilities(id).supportsTranscription
  check(
    'transcription falls back to a capable pro model when no capable flash exists',
    cheapestModel(['gemini-2.0-flash', 'gemini-2.5-pro'], capable, { fallbackToAnyEligible: true }) ===
      'gemini-2.5-pro'
  )
  check(
    'the cost-driven translation probes still refuse to substitute a pro model',
    cheapestModel(['gemini-2.5-pro']) === null
  )
  check(
    'flash-lite still wins on cost whenever it qualifies',
    cheapestModel(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'], capable, {
      fallbackToAnyEligible: true
    }) === 'gemini-2.5-flash-lite'
  )

  if (process.env.SRT_LIVE_ONLY !== 'native') {
    // ── C21 — embedded subtitle track: probe and extract (stage 2; the translation is N6) ──
    section('L6 — embedded subtitle track (C21, stage 2)')
    const videos = fixtures(['.mkv', '.mp4', '.mov', '.webm', '.m4v'])
    if (!videos.length) {
      skip('embedded-track probe and extraction', `no video in ${FIXTURE_DIR}`)
    } else {
      for (const video of videos) {
        const label = path.basename(video)
        const tracks = await probeTracks(video, FFMPEG_PATH)
        check(`${label}: ffprobe reports its subtitle tracks`, tracks.length > 0, `${tracks.length} tracks`)
        if (!tracks.length) continue

        console.log(
          `        tracks: ${tracks.map((t) => `${t.index}:${t.codec}${t.lang ? `/${t.lang}` : ''}`).join(', ')}`
        )
        const text = tracks.filter((t) => !t.isImage)

        // Judge the classification against the codec name, which is ground truth from ffprobe
        // and NOT derived from the app's own list — a check written from the code under test
        // can only ever agree with it. Getting this wrong is not cosmetic: `extractTrack`
        // remuxes an image track and transcodes a text one, so a bitmap stream misread as text
        // is handed to `-c:s srt` and fails.
        const knownImage = tracks.filter((t) => IMAGE_SUBTITLE_CODECS.has(t.codec.toLowerCase()))
        const knownText = tracks.filter((t) => TEXT_SUBTITLE_CODECS.has(t.codec.toLowerCase()))
        if (knownImage.length) {
          check(
            `${label}: bitmap tracks (${knownImage.map((t) => t.codec).join(', ')}) are marked as image`,
            knownImage.every((t) => t.isImage)
          )
        } else {
          skip(`${label}: image-track classification`, 'this file has no bitmap subtitle track')
        }
        if (knownText.length) {
          check(
            `${label}: text tracks (${knownText.map((t) => t.codec).join(', ')}) are NOT marked as image`,
            knownText.every((t) => !t.isImage)
          )
        }
        const unclassified = tracks.filter(
          (t) =>
            !IMAGE_SUBTITLE_CODECS.has(t.codec.toLowerCase()) &&
            !TEXT_SUBTITLE_CODECS.has(t.codec.toLowerCase())
        )
        if (unclassified.length) {
          console.log(
            `        note: ${unclassified.map((t) => t.codec).join(', ')} — codec not in the probe's ` +
              `reference sets, so its classification is unverified here`
          )
        }

        if (!text.length) {
          skip(`${label}: text-track extraction`, 'this file has only image/PGS tracks')
        } else {
          const track = text[0]
          const extracted = path.join(work, `${path.parse(video).name}_t${track.index}.srt`)
          const res = await extractTrack(video, track.index, extracted, false, FFMPEG_PATH)
          check(`${label}: the text track extracts to .srt`, res.ok, res.error ?? '')
          if (res.ok && check(`${label}: the extracted file exists`, fs.existsSync(extracted))) {
            const body = fs.readFileSync(extracted, 'utf8')
            check(`${label}: the extraction contains cues`, cueCount(body) > 0, `${cueCount(body)} cues`)
          }
        }
      }
    }
  }

  await nativeArms(work)
  report(work)
}

function report(work: string): void {
  console.log(`\n${passes} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ''}`)
  if (failures) {
    console.log('\nFailed checks:')
    for (const f of failed) console.log(`  - ${f}`)
    console.log(`\nArtifacts kept for inspection: ${work}`)
    process.exit(1)
  }
  console.log(
    skipped
      ? `\nALL RUNNABLE PROBES PASSED (${skipped} skipped — see the SKIP lines above for why)`
      : '\nALL LIVE PROBES PASSED'
  )
  console.log(`Artifacts: ${work}`)
  console.log('Remember to revoke the verification key when you are done.')
}

void main()
