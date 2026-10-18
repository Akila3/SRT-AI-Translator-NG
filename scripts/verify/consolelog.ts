/**
 * FP-8 — is the run's console actually on disk, complete, capped, and closed?
 *
 * The gates prove the policy: where the file is named, how the cut is made, that the four
 * sidecars land on four different names. None of them can prove the thing the feature IS — that
 * a real job, through the real lifecycle, leaves a real file behind. The seams that could break
 * it are all in the lifecycle rather than in the policy: the tee sits on the handlers the job
 * carries, the close sits in `finish()`, and `finish()` is reached from a spawn that threw, an
 * engine that exited, and a Stop that killed a process tree.
 *
 * FIDELITY. Everything below runs through the shipped `startRun` → native adapter and the shipped
 * `stopCurrent`: since Step 1.1 the console belongs to the runner's artifact session, which only a
 * runner-started run has. Only the audio and the provider are scripted, because a real provider
 * cannot be asked for ten megabytes, or for a failure at a chosen moment, without a key and a lot of
 * quota. The CLI scenarios (S1–S11 through a scripted gst) went with the CLI at Step 4.5
 * (gate_ledger.md §5m.0 Receipt 2, successors S11-shared, S12a–S12f, S14a–S14c, S15a–S15c).
 *
 * COST. No API key, no network, no quota, no ffmpeg. About ten seconds, most of it the flood.
 *
 * Run with `node scripts/verify/run-consolelog.mjs`. Exits non-zero on failure.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureRunnerRuntime, isRunning, startRun, stopCurrent } from '../../electron/engine/runner'
configureRunnerRuntime({ settingsRevisions: { current: () => 0, subscribe: () => () => {} } })
import {
  PROGRESS_LOG_SUFFIX,
  THOUGHTS_LOG_SUFFIX,
  TOKEN_REPORT_SUFFIX,
  type RunArtifactIo,
  type RunArtifactPreferences
} from '../../electron/engine/runArtifacts'
import type { StartedRun } from '../../electron/engine/adapter'
import type { RunEvent, RunWarning } from '../../electron/shared/engineEvents'
import {
  CONSOLE_LOG_TRUNCATION_MARK,
  DEFAULT_CONSOLE_LOG_LIMITS,
  consoleLogPathFor,
  findConsoleLog,
  runRecordPathFor
} from '../../electron/shared/consoleLog'
import type { TranscribeArgs, TranslateArgs } from '../../electron/shared/types'
import { createNativeEngineAdapter, type NativeEngineDeps } from '../../electron/engine/native/nativeAdapter'
import { GEMINI_CAPABILITIES } from '../../electron/engine/providers/gemini'
import type { GenerationProvider, ProviderCallContext, ProviderReply, ProviderRequest } from '../../electron/engine/providers/types'
import type { TranscriptionAudio } from '../../electron/engine/transcribe'

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-consolelog-probe-'))

/**
 * Everything this probe left outside its own working directory.
 *
 * Translation writes to `tempOutputPath()`, which is the OS temp directory rather than anywhere
 * the probe chose — that is the product's behaviour and the probe must not alter it — so the
 * flood scenario alone deposits nearly nine megabytes there per run. Deleting a temp file the
 * probe caused is not the same as deleting one a user's run caused, which is why this list is
 * built from what each scenario is handed back and not from a glob.
 */
const LITTER: string[] = []

/**
 * Shaped like a real key, and never valid.
 *
 * It is here because this phase creates a NEW artefact that leaves the machine — the whole
 * point of the file is that a user can send it — so every scenario asserts the key is not in it.
 *
 * Split for the same reason as `BAD_KEY` in `badkey.ts`: a whole key-shaped literal trips GitHub's
 * secret scanner. The runtime value is unchanged.
 */
const KEY = 'AIza' + 'SyB0000000000000000000000000000000x'

let failures = 0
let passes = 0

/**
 * An error nobody listened for is how a main process dies without saying anything.
 *
 * Node raises an unhandled `'error'` on a child as an uncaught exception, so a spawn the app
 * starts and forgets does not merely go unnoticed — it takes the whole application down. Without
 * this the probe would die mid-run with a stack trace that looks like a harness problem. With it,
 * the same event is a named failure pointing at the child that was dropped.
 */
process.on('uncaughtException', (e) => {
  failures++
  console.log(`  FAIL  the app let an error escape — this kills the real main process — ${e.message}`)
  cleanUp()
  console.log(`\n${passes} passed, ${failures} failed\n\nCONSOLE LOG PROBE FAILED`)
  process.exit(1)
})

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`)
}

interface Ending {
  code: number | null
  outputPath: string
  reason?: string
  logPaths?: string[]
  warnings: RunWarning[]
  outcome?: string
  error?: { kind: string; message: string }
}

interface Launched {
  /** What the start handed back — the output path the run will write to. */
  started: Promise<StartedRun>
  done: Promise<Ending>
  endings: () => number
  events: RunEvent[]
}

let runSeq = 0

/**
 * Start one run the way the app does, and collect its terminal event so each scenario can await
 * its own ending.
 *
 * It counts as well as collects. Several paths reach `finishJob()` for the same job — a close, a
 * kill, a stall, and (since FP8-01) a process error that may be followed by a close — and a page
 * that receives two endings is as broken as one that receives none: the second arrives after the
 * user has moved on. A promise cannot see the difference, so the count is kept separately.
 */
function launch(
  run: { kind: 'translate'; args: TranslateArgs } | { kind: 'transcribe'; args: TranscribeArgs },
  opts: {
    artifactIo?: Partial<RunArtifactIo>
    /** The native adapter's injected seams (Step 1.9). */
    native?: NativeEngineDeps
    description?: string
    /** The four Logs preferences as they stood at Start; token stats alone unless a scenario says. */
    preferences?: RunArtifactPreferences
  } = {}
): Launched {
  let settle: (e: Ending) => void = () => {}
  let calls = 0
  const events: RunEvent[] = []
  const done = new Promise<Ending>((r) => (settle = r))
  const started = startRun({
    ...run,
    runId: `consolelog-${++runSeq}`,
    adapter: () => createNativeEngineAdapter(opts.native),
    deliver: (e) => {
      events.push(e)
      if (e.type !== 'finished') return
      calls++
      settle({
        code: e.exitCode,
        outputPath: e.outputPath,
        reason: e.reason,
        logPaths: e.logPaths,
        warnings: e.warnings,
        outcome: e.outcome,
        ...(e.error ? { error: { kind: e.error.kind, message: e.error.message } } : {})
      })
    },
    secrets: [KEY],
    preferences: opts.preferences ?? { showTokenStats: true, writeTokenReport: false, progressLog: false, thoughtsLog: false },
    ...(opts.artifactIo ? { artifactIo: opts.artifactIo } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {})
  })
  return { started, done, endings: () => calls, events }
}

/** Give any late, duplicate terminal event time to arrive before the count is believed. */
const settleFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for a run to end — and fail loudly if it never does.
 *
 * A stranded job is otherwise INVISIBLE here. Nothing is left pending when a run is lost, so Node
 * drains its event loop and exits 0 part-way through a scenario, and a probe that stopped early
 * reads almost exactly like a probe that passed. This timer is the only thing keeping the process
 * alive long enough to say what happened.
 *
 * It gives up on the whole probe rather than the scenario, because there is one job slot: a run
 * that never ended holds it, so everything after this point would be refused for reasons that
 * have nothing to do with what it was testing.
 */
async function endsWithin(done: Promise<Ending>, ms: number, label: string): Promise<Ending> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms)
  })
  const result = await Promise.race([done, expired])
  clearTimeout(timer)
  if (result === null) {
    check(label, false, `no terminal event within ${ms}ms — the job slot is stranded`)
    cleanUp()
    console.log(`\n${passes} passed, ${failures} failed\n\nCONSOLE LOG PROBE FAILED`)
    process.exit(1)
  }
  return result
}

/** Everything this probe brought into the world, on every way out of it. */
function cleanUp(): void {
  for (const file of [WORK, ...LITTER]) {
    try {
      fs.rmSync(file, { recursive: true, force: true })
    } catch {
      /* the OS reclaims its own temp directory either way */
    }
  }
}

async function main(): Promise<void> {
  await nativeScenarios()

  console.log(`\n${passes} passed, ${failures} failed`)
  cleanUp()
  if (failures > 0) {
    console.log('\nCONSOLE LOG PROBE FAILED')
    process.exit(1)
  }
  console.log('\nCONSOLE LOG PROBE PASSED')
}

// ── S12: the native engine's console (Step 1.9) ───────────────────────────────────
//
// The shipped `startRun` and `stopCurrent` with the native adapter. The audio and the provider are scripted:
// what is under test is the lifecycle and the projection, and a real call is the A/B's job.

const NATIVE_DURATION = 120
const NATIVE_CUES = [
  { start: 1, end: 3, text: 'line one' },
  { start: 10, end: 12, text: 'line two' }
]
const NATIVE_REPLY = JSON.stringify(
  NATIVE_CUES.map((c) => ({ text: c.text, time_start: `00:${String(c.start).padStart(2, '0')}`, time_end: `00:${String(c.end).padStart(2, '0')}` }))
)

function nativeAudio(overrides: Partial<TranscriptionAudio> = {}): TranscriptionAudio {
  const n = NATIVE_DURATION * 10
  const levelsDb = new Array<number>(n).fill(-70)
  for (const c of NATIVE_CUES) for (let w = (c.start - 1) * 10; w < (c.end + 1) * 10; w++) levelsDb[w] = -20
  return {
    prepare: async () => ({ ok: true, path: 'prepared.mp3', converted: false, durationSeconds: NATIVE_DURATION }),
    envelope: async () => ({ ok: true, envelope: { windowSeconds: 0.1, levelsDb, durationSeconds: NATIVE_DURATION } }),
    slice: async () => ({ ok: true, data: Buffer.from('audio'), mimeType: 'audio/mp3' }),
    ...overrides
  }
}

function replyOf(result: ProviderReply['result']): ProviderReply {
  return { result, usage: { promptTokens: 100, thoughtTokens: 5, outputTokens: 40, totalTokens: 145 }, envelope: null, detailKeys: [] }
}

function nativeProvider(generate: (req: ProviderRequest, ctx: ProviderCallContext) => Promise<ProviderReply>): GenerationProvider & { calls: number; keysSeen: string[] } {
  const p = {
    id: 'double',
    capabilities: GEMINI_CAPABILITIES,
    calls: 0,
    keysSeen: [] as string[],
    generate: async (req: ProviderRequest, ctx: ProviderCallContext) => {
      p.calls++
      p.keysSeen.push(ctx.apiKey)
      return generate(req, ctx)
    }
  }
  return p
}

const answers = (): GenerationProvider & { calls: number; keysSeen: string[] } =>
  nativeProvider(async () => replyOf({ ok: true, text: NATIVE_REPLY, finishReason: 'STOP' }))

function nativeArgs(out: string, keys: string[] = [KEY], extra: Partial<TranscribeArgs> = {}): TranscribeArgs {
  return {
    mediaFile: path.join(WORK, 'native-episode.mp3'),
    outputFile: out,
    model: 'gemini-3.7-flash',
    thinkingLevel: 'low',
    apiKeys: keys,
    ...extra
  } as unknown as TranscribeArgs
}

function nativeDeps(extra: NativeEngineDeps = {}): NativeEngineDeps {
  return { settings: () => ({}), audio: () => nativeAudio(), provider: answers(), retry: { policy: { quotaWaitMs: 1, keySwitchIntervalMs: 1, overloadWaitMs: 1, networkWaitMs: 1 } }, ...extra }
}

const logTexts = (events: RunEvent[]): string[] =>
  events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log').map((e) => e.text)

const startedOf = (events: RunEvent[]): Extract<RunEvent, { type: 'started' }> | undefined =>
  events.find((e): e is Extract<RunEvent, { type: 'started' }> => e.type === 'started')

async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) return false
    await settleFor(5)
  }
  return true
}

/**
 * The checks every reserved native run owes, whatever its outcome: one ending, the slot back, the
 * console offered and on disk, every panel line in it once and in order, no key, and none of
 * Translate's sidecars.
 */
async function nativeConsole(label: string, run: Launched, end: Ending, out: string, endLine: string): Promise<string> {
  await settleFor(60)
  check(`${label} the run ends exactly once`, run.endings() === 1, `${run.endings()} endings`)
  check(`${label} the slot is released`, !isRunning())
  check(`${label} the ending has no exit code`, end.code === null, String(end.code))
  const logPath = findConsoleLog(end.logPaths)
  check(`${label} the ending offers the console`, logPath === consoleLogPathFor(out), JSON.stringify(end.logPaths))
  const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
  check(`${label} the run was the native engine's`, startedOf(run.events) !== undefined && text.startsWith('[native engine] '), JSON.stringify(startedOf(run.events)))
  check(`${label} the console opens with the run's safe summary`, text.startsWith('[native engine] transcribe ') && text.includes('model gemini-3.7-flash'))
  check(`${label} and the key is not in it`, !text.includes(KEY), 'THE API KEY LEAKED INTO THE EXPORT')
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l !== '')
  const panel = logTexts(run.events).flatMap((t) => t.split('\n')).filter((l) => l !== '')
  // A projection, exactly: the summary (two lines, three with a description), then the panel's
  // lines and nothing else — not one twice, not one folded into a redraw counter — then the ending.
  const header = lines[2]?.startsWith('description: ') ? 3 : 2
  const body = lines.slice(header, -1)
  check(`${label} the console between its summary and its ending is exactly the panel`, panel.length > 0 && JSON.stringify(body) === JSON.stringify(panel), JSON.stringify({ body, panel }))
  check(`${label} the console ends with how the run ended`, lines.at(-1) === endLine, JSON.stringify(lines.slice(-3)))
  const sidecars = ['.progress.log', '.thoughts.log', '.tokens.json'].filter((s) => fs.readdirSync(path.dirname(out)).some((f) => f.endsWith(s)))
  check(`${label} no Translate-only sidecar exists`, sidecars.length === 0, JSON.stringify(sidecars))
  const recordPath = runRecordPathFor(out)
  check(`${label} the ending offers the run record, then the console`, JSON.stringify((end.logPaths ?? []).slice(-2)) === JSON.stringify([recordPath, logPath]), JSON.stringify(end.logPaths))
  const raw = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf-8') : ''
  const rows = raw.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { schemaVersion: unknown; sequence: unknown; event: { type?: unknown; runId?: unknown } })
  const runId = startedOf(run.events)?.runId
  check(
    `${label} the run record is one schema-1 row per delivered event, in sequence and order, this run's, started first and the ending last`,
    rows.length > 1 && rows.length === run.events.length &&
      rows.every((r, i) => r.schemaVersion === 1 && r.sequence === i + 1 && r.event.runId === runId && r.event.type === run.events[i].type) &&
      rows[0].event.type === 'started' && rows[rows.length - 1].event.type === 'finished',
    JSON.stringify(rows.map((r) => r.event.type))
  )
  check(`${label} and neither the key nor the description is in the run record`, raw !== '' && !raw.includes(KEY) && !raw.includes('A film.'), 'THE RUN RECORD CARRIES A KEY OR THE DESCRIPTION')
  return text
}

async function nativeScenarios(): Promise<void> {
  const previous = process.env.SRT_ENGINE
  process.env.SRT_ENGINE = 'native'
  try {
    // S12a — completed, with a key-bearing description that must reach the console redacted.
    section('S12a — a completed native transcription: the console is the panel, plus its summary and ending')
    {
      const dir = fs.mkdtempSync(path.join(WORK, 'n-a-'))
      const out = path.join(dir, 'episode.en.srt')
      const provider = answers()
      const run = launch({ kind: 'transcribe', args: nativeArgs(out) }, { native: nativeDeps({ provider }), description: `A film. key ${KEY}` })
      const started = await run.started
      const end = await endsWithin(run.done, 30_000, 'S12a the run reached an ending')
      check('S12a it completed', end.outcome === 'completed' && end.reason === undefined, JSON.stringify(end))
      check('S12a the start handed back the destination', started.outputPath === out)
      check('S12a the provider was called once, with the run\u2019s key', provider.calls === 1 && provider.keysSeen[0] === KEY)
      const text = await nativeConsole('S12a', run, end, out, '[run ended: completed]')
      check('S12a the summary names the thinking level and tier', text.includes('thinking level low') && text.includes('service tier standard'))
      check('S12a the description is in the console', text.includes('description: A film. key '))
      check('S12a the segment line is in it', text.includes('Transcribing audio segment 00:00 to 02:00 (part 1 of 1).'))
      check('S12a the saved line is in it', text.includes(`Transcription saved to ${out}`))
      check('S12a the subtitle was written', fs.existsSync(out) && fs.readFileSync(out, 'utf-8').includes('line two'))
      check('S12a the destination holds only the subtitle, its run record and its console', fs.readdirSync(dir).sort().join('|') === [path.basename(consoleLogPathFor(out)), path.basename(runRecordPathFor(out)), 'episode.en.srt'].sort().join('|'), fs.readdirSync(dir).join('|'))
    }

    // S12b — failed: every key rejected by the API.
    section('S12b — a failed native transcription says why, once, and ends failed')
    {
      const dir = fs.mkdtempSync(path.join(WORK, 'n-b-'))
      const out = path.join(dir, 'episode.en.srt')
      const provider = nativeProvider(async (_r, ctx) => replyOf({ ok: false, kind: 'auth', reason: 'invalid', keyIndex: ctx.keyIndex }))
      const run = launch({ kind: 'transcribe', args: nativeArgs(out) }, { native: nativeDeps({ provider }) })
      const end = await endsWithin(run.done, 30_000, 'S12b the run reached an ending')
      check('S12b it failed as an auth failure', end.outcome === 'failed' && end.error?.kind === 'auth', JSON.stringify(end))
      const text = await nativeConsole('S12b', run, end, out, '[run ended: failed]')
      const msg = end.error?.message ?? '\u0000'
      check('S12b the failure is in the console exactly once', text.split(msg).length === 2, msg)
      check('S12b no subtitle was written', !fs.existsSync(out))
    }

    // S12c — stopped mid-request; a second start while it holds the slot is refused before reservation.
    section('S12c — Stop during a request ends the run as stopped; a start meanwhile is refused unreserved')
    {
      const dir = fs.mkdtempSync(path.join(WORK, 'n-c-'))
      const out = path.join(dir, 'episode.en.srt')
      const provider = nativeProvider(
        (_r, ctx) =>
          new Promise<ProviderReply>((resolve) => {
            if (ctx.signal.aborted) resolve(replyOf({ ok: false, kind: 'cancelled' }))
            ctx.signal.addEventListener('abort', () => resolve(replyOf({ ok: false, kind: 'cancelled' })), { once: true })
          })
      )
      const run = launch({ kind: 'transcribe', args: nativeArgs(out) }, { native: nativeDeps({ provider }) })
      const sending = await waitUntil(() => provider.calls === 1, 10_000)
      check('S12c the request is in flight', sending)
      const second = launch({ kind: 'transcribe', args: nativeArgs(path.join(dir, 'other.en.srt')) }, { native: nativeDeps() })
      const refused = await endsWithin(second.done, 10_000, 'S12c the second start reached an ending')
      check('S12c the second start is refused as busy', refused.outcome === 'failed' && refused.error?.kind === 'refusedByApp' && refused.error.message === 'A process is already running.', JSON.stringify(refused))
      check('S12c with no started event and no console', !startedOf(second.events) && (refused.logPaths ?? []).length === 0, JSON.stringify(refused.logPaths))
      check('S12c and the first run still holds the slot', isRunning() && run.endings() === 0)
      stopCurrent()
      const end = await endsWithin(run.done, 10_000, 'S12c the stopped run reached an ending')
      check('S12c it ended stopped, by the user', end.outcome === 'stopped' && end.reason === 'user', JSON.stringify(end))
      const text = await nativeConsole('S12c', run, end, out, '[run ended: stopped, ended by the app: user]')
      check('S12c the console says it was stopped', text.includes('Stopped.'))
      check('S12c no subtitle was written', !fs.existsSync(out))
    }

    // S12d — reserved refusals: no usable key, and a key the preflight rejects. Nothing is sent.
    section('S12d — a native run refused after reservation keeps its console and sends nothing')
    {
      const cases: Array<{ label: string; keys: string[]; preflight?: NativeEngineDeps['preflight']; kind: string }> = [
        { label: 'S12d no key', keys: [''], kind: 'refusedByApp' },
        {
          label: 'S12d rejected key',
          keys: [KEY],
          preflight: async () => ({ verdict: 'rejected', message: 'The API key was rejected as invalid.' }),
          kind: 'auth'
        }
      ]
      for (const c of cases) {
        const dir = fs.mkdtempSync(path.join(WORK, 'n-d-'))
        const out = path.join(dir, 'episode.en.srt')
        const provider = answers()
        const run = launch({ kind: 'transcribe', args: nativeArgs(out, c.keys) }, { native: nativeDeps({ provider, ...(c.preflight ? { preflight: c.preflight } : {}) }) })
        const end = await endsWithin(run.done, 10_000, `${c.label} the run reached an ending`)
        check(`${c.label} it failed, ended by the app's guard`, end.outcome === 'failed' && end.reason === 'guard' && end.error?.kind === c.kind, JSON.stringify(end))
        check(`${c.label} nothing was sent`, provider.calls === 0)
        await nativeConsole(c.label, run, end, out, '[run ended: failed, ended by the app: guard]')
      }
    }

    // S12e — the audio cannot be prepared, and a step that throws.
    section('S12e — a preparation failure and a thrown step each end the run once')
    {
      const dir = fs.mkdtempSync(path.join(WORK, 'n-e-'))
      const out = path.join(dir, 'episode.en.srt')
      const run = launch(
        { kind: 'transcribe', args: nativeArgs(out) },
        { native: nativeDeps({ audio: () => nativeAudio({ prepare: async () => ({ ok: false, error: 'No audio stream in this file.' }) }) }) }
      )
      const end = await endsWithin(run.done, 10_000, 'S12e preparation the run reached an ending')
      check('S12e preparation it failed', end.outcome === 'failed', JSON.stringify(end))
      const text = await nativeConsole('S12e preparation', run, end, out, '[run ended: failed]')
      check('S12e preparation the reason is in the console', text.includes('No audio stream in this file.'))

      const out2 = path.join(dir, 'thrown.en.srt')
      const thrown = launch(
        { kind: 'transcribe', args: nativeArgs(out2) },
        {
          native: nativeDeps({
            audio: () =>
              nativeAudio({
                prepare: async () => {
                  throw new Error(`disk vanished ${KEY}`)
                }
              })
          })
        }
      )
      const settled = await thrown.started.then(() => 'resolved', () => 'rejected')
      const end2 = await endsWithin(thrown.done, 10_000, 'S12e thrown the run reached an ending')
      check('S12e thrown the start settled', settled === 'resolved' || settled === 'rejected', settled)
      check('S12e thrown it failed', end2.outcome === 'failed', JSON.stringify(end2))
      check('S12e thrown the key is not in the ending', !(end2.error?.message ?? '').includes(KEY), 'THE API KEY LEAKED INTO THE ERROR')
      await settleFor(60)
      check('S12e thrown the run ends exactly once', thrown.endings() === 1, `${thrown.endings()} endings`)
      check('S12e thrown the slot is released', !isRunning())
    }

    // S12f — a console that cannot be kept never costs a native run either.
    section('S12f — a native console fault is one warning, a normal ending, and no false path')
    {
      const faults: Array<{ label: string; io: Partial<RunArtifactIo>; copy: string }> = [
        { label: 'S12f open', io: { open: () => null }, copy: 'could not be created' },
        {
          label: 'S12f write',
          io: {
            write: () => {
              throw new Error('ENOSPC: no space left on device')
            }
          },
          copy: 'could not be written in full'
        },
        {
          label: 'S12f close',
          io: {
            close: (fd) => {
              fs.closeSync(fd)
              throw new Error('EIO: i/o error')
            }
          },
          copy: 'could not be closed'
        }
      ]
      for (const { label, io, copy } of faults) {
        const dir = fs.mkdtempSync(path.join(WORK, 'n-f-'))
        const out = path.join(dir, 'episode.en.srt')
        const run = launch({ kind: 'transcribe', args: nativeArgs(out) }, { native: nativeDeps(), artifactIo: io })
        const end = await endsWithin(run.done, 10_000, `${label} the run reached an ending`)
        await settleFor(60)
        check(`${label} the run ends exactly once`, run.endings() === 1, `${run.endings()} endings`)
        check(`${label} the run still completed`, end.outcome === 'completed', JSON.stringify(end))
        const artifact = end.warnings.filter((w) => w.code === 'artifact')
        check(`${label} exactly one artifact warning, naming the fault`, artifact.length === 1 && artifact[0].message.includes(copy), JSON.stringify(end.warnings))
        check(`${label} the console is not offered`, findConsoleLog(end.logPaths) === '', JSON.stringify(end.logPaths))
        check(`${label} the slot is released`, !isRunning())
      }
    }

    await nativeTranslateScenarios()
    await nativeSummaryScenarios()
  } finally {
    if (previous === undefined) delete process.env.SRT_ENGINE
    else process.env.SRT_ENGINE = previous
  }
}

// ── S14: native Translate's reports (Step 2.8) ────────────────────────────────────
//
// The same lifecycle with every Logs preference on. The run stages to the product's own temp output,
// so its reports sit there too; each is listed for clean-up from the path the ending handed back.

const ALL_LOGS: RunArtifactPreferences = { showTokenStats: true, writeTokenReport: true, progressLog: true, thoughtsLog: true }
const REPORTS = [TOKEN_REPORT_SUFFIX, PROGRESS_LOG_SUFFIX, THOUGHTS_LOG_SUFFIX]

function nativeTranslateArgs(input: string, keys: string[] = [KEY]): TranslateArgs {
  return { inputFile: input, targetLang: 'he', model: 'gemini-3.5-flash-lite', thinkingLevel: 'low', apiKeys: keys, batchSize: 2 } as unknown as TranslateArgs
}

function fourCues(name: string): string {
  const p = path.join(WORK, name)
  fs.writeFileSync(p, [1, 2, 3, 4].map((n) => `${n}\n00:00:0${n},000 --> 00:00:0${n},900\nline ${n}\n`).join('\n'), 'utf-8')
  return p
}

/** A reply that translates whatever the batch asked for, with one labelled thought. */
const translates = (): GenerationProvider & { calls: number; keysSeen: string[] } => {
  const p = nativeProvider(async (req) => {
    const asked = JSON.parse((req.parts.find((x) => 'text' in x) as { text: string }).text) as Array<{ index: string; text: string }>
    return replyOf({ ok: true, text: JSON.stringify(asked.map((i) => ({ index: i.index, text: `HE ${i.text}` }))), finishReason: 'STOP', thoughtSummaries: [`thinking about request ${p.calls}`] })
  })
  return p
}

/** Every file the run left on its staged stem: the output, its partial, its console, its reports. */
function stagedFiles(staged: string): string[] {
  if (!staged) return []
  const dir = path.dirname(staged)
  const base = path.basename(staged).replace(/\.[^.]+$/, '')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(base)).map((f) => path.join(dir, f)) : []
}

async function nativeTranslateScenarios(): Promise<void> {
  // S14a — completed with every report on: all of them closed, whole, and offered before the console.
  section('S14a — a completed native translation leaves every report it promised, whole and offered')
  {
    const run = launch({ kind: 'translate', args: nativeTranslateArgs(fourCues('s14a.srt')) }, { native: nativeDeps({ provider: translates() }), preferences: ALL_LOGS })
    const started = await run.started
    const end = await endsWithin(run.done, 30_000, 'S14a the run reached an ending')
    await settleFor(60)
    LITTER.push(...stagedFiles(started.outputPath))
    const stem = started.outputPath.replace(/\.[^.]+$/, '')
    check('S14a it completed, once, and gave the slot back', end.outcome === 'completed' && run.endings() === 1 && !isRunning(), JSON.stringify(end))
    check(
      'S14a the ending offers the token report, progress log and thoughts log, then the run record, then the console',
      JSON.stringify(end.logPaths) === JSON.stringify([...REPORTS.map((s) => stem + s), runRecordPathFor(started.outputPath), consoleLogPathFor(started.outputPath)]),
      JSON.stringify(end.logPaths)
    )
    const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '')
    const tokens = (() => {
      try {
        return JSON.parse(read(stem + TOKEN_REPORT_SUFFIX)) as { mode?: string; output_file?: string; tokens?: { total?: number } }
      } catch {
        return null
      }
    })()
    check('S14a the token report is the run\u2019s, in gst\u2019s shape', tokens?.mode === 'translate' && tokens.output_file === started.outputPath && tokens.tokens?.total === 290, JSON.stringify(tokens))
    check('S14a the progress log ends on the outcome', read(stem + PROGRESS_LOG_SUFFIX).startsWith('Completed: 4/4 lines (100%)\n\n'), JSON.stringify(read(stem + PROGRESS_LOG_SUFFIX)))
    const thoughts = read(stem + THOUGHTS_LOG_SUFFIX)
    check('S14a the thoughts log has one ruled section per batch, and no translated line', /^={80}\n\nBatch 1 thoughts:\n\n={80}\n\nthinking about request 1\n\n={80}\n\nBatch 2 thoughts:\n\n={80}\n\nthinking about request 2\n\n$/.test(thoughts) && !thoughts.includes('HE line'), JSON.stringify(thoughts))
    const consoleText = read(consoleLogPathFor(started.outputPath))
    check('S14a the console opens as a translation and ends with its tally, then the ending', consoleText.startsWith('[native engine] translate ') && /Total Tokens: 290\r?\n\[run ended: completed\]\r?\n?$/.test(consoleText), JSON.stringify(consoleText.slice(-200)))
    check('S14a no report holds the key', end.logPaths?.every((p) => !read(p).includes(KEY)) === true, 'THE API KEY LEAKED INTO A REPORT')
    // Closed: a Windows rename fails on a file someone still holds; every offered file must move.
    const movable = (end.logPaths ?? []).every((p) => {
      try {
        fs.renameSync(p, `${p}.moved`)
        fs.renameSync(`${p}.moved`, p)
        return true
      } catch {
        return false
      }
    })
    check('S14a every offered file is closed before the ending is delivered', movable)
    check('S14a no staged replacement is left behind', stagedFiles(started.outputPath).every((f) => !f.endsWith('.tmp')), JSON.stringify(stagedFiles(started.outputPath)))
  }

  // S14b — stopped mid-request: the reports still close on the outcome.
  section('S14b — a native translation stopped mid-request still finishes its reports')
  {
    const provider = nativeProvider(
      (_r, ctx) =>
        new Promise<ProviderReply>((resolve) => {
          if (ctx.signal.aborted) resolve(replyOf({ ok: false, kind: 'cancelled' }))
          ctx.signal.addEventListener('abort', () => resolve(replyOf({ ok: false, kind: 'cancelled' })), { once: true })
        })
    )
    const run = launch({ kind: 'translate', args: nativeTranslateArgs(fourCues('s14b.srt')) }, { native: nativeDeps({ provider }), preferences: ALL_LOGS })
    // A native start settles with its run, as native Transcribe's does (S12c): Stop comes first.
    check('S14b the request is in flight', await waitUntil(() => provider.calls === 1, 10_000))
    stopCurrent()
    const end = await endsWithin(run.done, 10_000, 'S14b the stopped run reached an ending')
    const started = await run.started
    await settleFor(60)
    LITTER.push(...stagedFiles(started.outputPath))
    const stem = started.outputPath.replace(/\.[^.]+$/, '')
    check('S14b it ended stopped, by the user, once', end.outcome === 'stopped' && end.reason === 'user' && run.endings() === 1 && !isRunning(), JSON.stringify(end))
    check('S14b the three reports, the run record and the console are offered', JSON.stringify(end.logPaths) === JSON.stringify([...REPORTS.map((s) => stem + s), runRecordPathFor(started.outputPath), consoleLogPathFor(started.outputPath)]), JSON.stringify(end.logPaths))
    const progress = fs.existsSync(stem + PROGRESS_LOG_SUFFIX) ? fs.readFileSync(stem + PROGRESS_LOG_SUFFIX, 'utf-8') : ''
    check('S14b the progress log ends on Stopped', /^Stopped(: 0\/4 lines \(0%\))?\n\n/.test(progress), JSON.stringify(progress))
    check('S14b no batch answered, so the thoughts log is empty \u2014 but there', fs.existsSync(stem + THOUGHTS_LOG_SUFFIX) && fs.statSync(stem + THOUGHTS_LOG_SUFFIX).size === 0)
  }

  // S14c — refused by the guard: the console alone, as the CLI's guard endings offer.
  section('S14c — a native translation refused by its guard offers the console and no report')
  {
    const provider = translates()
    const run = launch({ kind: 'translate', args: nativeTranslateArgs(fourCues('s14c.srt'), ['']) }, { native: nativeDeps({ provider }), preferences: ALL_LOGS })
    const started = await run.started
    const end = await endsWithin(run.done, 10_000, 'S14c the run reached an ending')
    await settleFor(60)
    LITTER.push(...stagedFiles(started.outputPath))
    check('S14c it failed by the guard and sent nothing', end.outcome === 'failed' && end.reason === 'guard' && provider.calls === 0, JSON.stringify(end))
    check('S14c only the run record and the console are offered', JSON.stringify(end.logPaths) === JSON.stringify([runRecordPathFor(started.outputPath), consoleLogPathFor(started.outputPath)]), JSON.stringify(end.logPaths))
    check('S14c no report is on disk', stagedFiles(started.outputPath).every((f) => !REPORTS.some((s) => f.endsWith(s))), JSON.stringify(stagedFiles(started.outputPath)))
  }
}

// ── S15: the native console carries what the masked command line carried (Step 4.2, P4-G2) ────────
//
// The CLI's console opened with gst's argv, masked: every path, option, model, language, size, level,
// tier, generation value and log flag the run used, and no secret. The native console must say the
// same facts from the run's own summary — not merely hold them in `started.config` — and nothing the
// summary is forbidden to carry. S4 and S8's ceilings are then re-proved on a native run's console.

const S15_SYSTEM_PROMPT = 'S15-SYSTEM-PROMPT keep every name exactly as written'
const S15_CUE_TEXT = ['Zebra quartz alpha', 'Zebra quartz bravo', 'Zebra quartz charlie', 'Zebra quartz delta']

function s15Source(name: string): string {
  const p = path.join(WORK, name)
  fs.writeFileSync(p, S15_CUE_TEXT.map((t, i) => `${i + 1}\n00:00:0${i + 1},000 --> 00:00:0${i + 1},900\n${t}\n`).join('\n'), 'utf-8')
  return p
}

const consoleLines = (text: string): string[] => text.replace(/\r\n/g, '\n').split('\n').filter((l) => l !== '')

async function nativeSummaryScenarios(): Promise<void> {
  section('S15a — the native console summary names every safe fact the masked command line carried')
  {
    const input = s15Source('s15a.srt')
    const audio = path.join(WORK, 's15a-film.mp3')
    const args = {
      inputFile: input,
      sourceLang: 'en',
      targetLang: 'he',
      // A model that accepts sampling values, so the run sends them (`modelCaps.ts` withholds them from 3.5+).
      model: 'gemini-2.5-flash',
      thinkingBudget: 512,
      apiKeys: [KEY],
      batchSize: 2,
      customGenerationParams: true,
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      systemPrompt: S15_SYSTEM_PROMPT,
      description: `A film about zebras. key ${KEY}`,
      audioFile: audio
    } as unknown as TranslateArgs
    const run = launch(
      { kind: 'translate', args },
      {
        native: nativeDeps({
          provider: translates(),
          translationAudio: () => ({ slice: async () => ({ ok: true, data: Buffer.from('audio'), mimeType: 'audio/mp3' }) })
        }),
        preferences: ALL_LOGS
      }
    )
    const started = await run.started
    const end = await endsWithin(run.done, 30_000, 'S15a translate the run reached an ending')
    await settleFor(60)
    LITTER.push(...stagedFiles(started.outputPath))
    check('S15a translate it completed', end.outcome === 'completed', JSON.stringify(end))
    const logPath = findConsoleLog(end.logPaths)
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    const [head = '', facts = '', described = ''] = consoleLines(text)
    check('S15a translate the summary names the source and the staged output', head === `[native engine] translate "${input}" -> "${started.outputPath}"`, head)
    check('S15a translate the model, thinking budget and tier', facts.startsWith('model gemini-2.5-flash · thinking budget 512 · service tier standard · '), facts)
    check('S15a translate the credential-slot count, never a value', facts.includes(' · 1 API key · '), facts)
    check('S15a translate both languages', facts.includes(' · into Hebrew · ') && facts.includes(' · from English · '), facts)
    check('S15a translate the batch size', facts.includes(' · batches of up to 2 · '), facts)
    check('S15a translate the generation values', facts.includes(' · temperature 0.5 · top-p 0.9 · top-k 40 · '), facts)
    check('S15a translate the audio input', facts.includes(` · with audio "${audio}" · `), facts)
    check('S15a translate that a system prompt was set, without its text', facts.includes(' · custom system prompt · ') && !text.includes(S15_SYSTEM_PROMPT), facts)
    check('S15a translate every log choice', facts.endsWith(' · logs: token stats, token report, progress log, thoughts log'), facts)
    check(
      'S15a translate the effective description, redacted',
      described.startsWith('description: Source language: English. A film about zebras. key ') && !described.includes(KEY),
      described
    )
    check('S15a translate the usage and the ending', /Total Tokens: \d+\r?\n\[run ended: completed\]\r?\n?$/.test(text), JSON.stringify(text.slice(-160)))
    check('S15a translate no credential value anywhere', !text.includes(KEY), 'THE API KEY LEAKED INTO THE EXPORT')
    check('S15a translate no subtitle or translated text', S15_CUE_TEXT.every((t) => !text.includes(t)), 'subtitle text reached the console')
    check('S15a translate no raw provider body', !text.includes('"index"') && !text.includes('thinking about request'), 'a provider body reached the console')
    check('S15a translate no Quota Group label', !/quota group/i.test(text))
  }
  {
    const dir = fs.mkdtempSync(path.join(WORK, 's15a-'))
    const out = path.join(dir, 'film.en.srt')
    const media = path.join(WORK, 's15a-film.mkv')
    const run = launch({ kind: 'transcribe', args: nativeArgs(out, [KEY], { mediaFile: media } as Partial<TranscribeArgs>) }, { native: nativeDeps(), description: `A film about zebras. key ${KEY}` })
    const end = await endsWithin(run.done, 30_000, 'S15a transcribe the run reached an ending')
    await settleFor(60)
    check('S15a transcribe it completed', end.outcome === 'completed', JSON.stringify(end))
    const logPath = findConsoleLog(end.logPaths)
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    const [head = '', facts = '', described = ''] = consoleLines(text)
    check('S15a transcribe the summary names the media and the destination', head === `[native engine] transcribe "${media}" -> "${out}"`, head)
    check(
      'S15a transcribe the model, thinking level, tier, key count and part length',
      facts.startsWith('model gemini-3.7-flash · thinking level low · service tier standard · 1 API key · parts of '),
      facts
    )
    check('S15a transcribe that the audio comes from a video', facts.includes(' · audio from the video · '), facts)
    check('S15a transcribe the log choices', facts.endsWith(' · logs: token stats'), facts)
    check('S15a transcribe the description, redacted', described.startsWith('description: A film about zebras. key ') && !described.includes(KEY), described)
    check('S15a transcribe the ending, and no credential', text.trimEnd().endsWith('[run ended: completed]') && !text.includes(KEY), JSON.stringify(text.slice(-120)))
  }

  section('S15b — a native run that will not stop talking cannot fill the disk')
  {
    const LINES = 120_000
    const LAST = `line ${LINES} — the last thing this run said`
    const dir = fs.mkdtempSync(path.join(WORK, 's15b-'))
    const out = path.join(dir, 'flood.en.srt')
    const run = launch(
      { kind: 'transcribe', args: nativeArgs(out) },
      {
        native: nativeDeps({
          audio: ({ job }) =>
            nativeAudio({
              prepare: async () => {
                for (let i = 1; i < LINES; i++) job.handlers.onOutput('stderr', `line ${i} ${'x'.repeat(80)}`)
                job.handlers.onOutput('stderr', LAST)
                return { ok: false, error: 'No audio stream in this file.' }
              }
            })
        })
      }
    )
    const end = await endsWithin(run.done, 120_000, 'S15b the run reached an ending')
    await settleFor(60)
    const logPath = findConsoleLog(end.logPaths)
    const size = logPath && fs.existsSync(logPath) ? fs.statSync(logPath).size : -1
    const ceiling = DEFAULT_CONSOLE_LOG_LIMITS.headBytes + DEFAULT_CONSOLE_LOG_LIMITS.tailBytes
    check('S15b the run overflowed the ceiling', LINES * 88 > DEFAULT_CONSOLE_LOG_LIMITS.headBytes && end.outcome === 'failed', JSON.stringify({ outcome: end.outcome }))
    check('S15b the file stopped growing', size > 0 && size <= ceiling + 4096, `${size} bytes against a ${ceiling} byte budget`)
    check('S15b it is not merely small', size > DEFAULT_CONSOLE_LOG_LIMITS.headBytes)
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    check('S15b the beginning is intact', text.startsWith('[native engine] transcribe ') && text.includes('line 1 '))
    check('S15b the cut is marked', text.includes(CONSOLE_LOG_TRUNCATION_MARK))
    check('S15b and the ending survived it', text.includes(LAST) && text.includes('No audio stream in this file.'))
    check('S15b the ending is still the ending', text.trimEnd().endsWith('[run ended: failed]'), JSON.stringify(text.slice(-120)))
  }

  section('S15c — a single enormous native line cannot outgrow the file it is written to')
  {
    const HUGE = 4 * 1024 * 1024
    const dir = fs.mkdtempSync(path.join(WORK, 's15c-'))
    const out = path.join(dir, 'huge.en.srt')
    const run = launch(
      { kind: 'transcribe', args: nativeArgs(out) },
      { native: nativeDeps({ audio: () => nativeAudio({ prepare: async () => ({ ok: false, error: `payload:${'x'.repeat(HUGE)}` }) }) }) }
    )
    const end = await endsWithin(run.done, 60_000, 'S15c the run reached an ending')
    await settleFor(60)
    const logPath = findConsoleLog(end.logPaths)
    const size = logPath && fs.existsSync(logPath) ? fs.statSync(logPath).size : -1
    check('S15c the four megabyte line did not become a four megabyte file', size > 0 && size < DEFAULT_CONSOLE_LOG_LIMITS.lineBytes * 2, `${size} bytes from a ${HUGE} byte line`)
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    check('S15c what it was is still legible', text.includes('payload:xxx'))
    check('S15c the run around it is intact', text.startsWith('[native engine] transcribe ') && text.includes('Reading "native-episode.mp3"'))
    check('S15c the cut is admitted', text.includes(CONSOLE_LOG_TRUNCATION_MARK))
    check('S15c and the ending still arrives', text.trimEnd().endsWith('[run ended: failed]'), JSON.stringify(text.slice(-120)))
    check('S15c the job slot is released', !isRunning())
  }
}

void main()
