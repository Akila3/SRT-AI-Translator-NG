/**
 * REP-2 — does a transcription with a bad key actually END now?
 *
 * This is the acceptance row no gate can reach. The gates prove the engine's arithmetic against
 * fixtures; they cannot prove that the real provider, called the real way, rejects the key in the
 * shape the run expects — or that the defences fire in the right order when it does. The original
 * measurement was six hours and forty minutes and 97 GB, ended by a full disk.
 *
 * FIDELITY. Everything runs through the shipped runner, native adapter, Gemini provider and FFmpeg;
 * the provider is only wrapped to count what reached it. The third arm deliberately withholds the
 * preflight to reach the request itself — which is also the honest test of the backstop, since the
 * preflight cannot foresee a key revoked mid-run. The CLI arms (B2–B4 through gst) went with the CLI
 * at Step 4.5 (gate_ledger.md §5m.0 Receipt 2, successors NB0–NB4).
 *
 * COST. No valid API key, no quota, no network beyond rejected requests: the whole point is a key
 * that is *not* valid. It needs FFmpeg (bundled) to build a ten-second sine wave.
 *
 * Run with `node scripts/verify/run-badkey.mjs`. Exits non-zero on failure.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { refreshModels } from '../../electron/main/modelsList'
import type { KeyPreflight } from '../../electron/main/keyPreflight'
import { configureRunnerRuntime, isRunning, startRun } from '../../electron/engine/runner'
configureRunnerRuntime({ settingsRevisions: { current: () => 0, subscribe: () => () => {} } })
import { createNativeEngineAdapter } from '../../electron/engine/native/nativeAdapter'
import { createGeminiProvider } from '../../electron/engine/providers/gemini'
import type { GenerationProvider } from '../../electron/engine/providers/types'
import type { RunEvent } from '../../electron/shared/engineEvents'
import { findConsoleLog } from '../../electron/shared/consoleLog'
import type { TranscribeArgs } from '../../electron/shared/types'

const ROOT = process.cwd()
const EXE = process.platform === 'win32' ? '.exe' : ''
const BIN = path.join(ROOT, 'resources', 'bin')
const FFMPEG = path.join(BIN, `ffmpeg${EXE}`)
const WORK = path.join(ROOT, '.tmp-badkey-probe')

/**
 * A key that is syntactically plausible and certainly not valid.
 *
 * Shaped like a real one so the API rejects it on authentication rather than on parsing, which
 * is the failure REP-2 recorded.
 *
 * Written in two pieces because that shape is also what GitHub's secret scanner looks for, and it
 * opened an alert against this line. Concatenation leaves the runtime value byte-identical, which
 * matters more here than anywhere else in the repository: this string is sent to the live API, and
 * changing it could move the rejection from authentication to parsing and quietly invalidate the
 * very thing the probe exists to prove.
 */
const BAD_KEY = 'AIza' + 'SyB0000000000000000000000000000000x'

/** Long enough for the engine to start work, short enough not to waste anyone's minute. */
const CLIP_SECONDS = 10

/** Ceiling on how long the backstop probe will wait before declaring the run unbounded. */
const PATIENCE_MS = 150_000

let failures = 0
let passes = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function run(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args)
    p.on('error', () => resolve(-1))
    p.on('close', (code) => resolve(code))
  })
}

function transcribeArgs(media: string, out: string): TranscribeArgs {
  return {
    mediaFile: media,
    outputFile: out,
    targetLang: 'en',
    model: 'gemini-2.5-flash-lite',
    apiKeys: [BAD_KEY],
    thinkingLevel: 'default',
    thinkingBudget: 0,
    customGenerationParams: false,
    temperature: 0.7,
    topP: 0.95,
    topK: null
  }
}

// ── Native successors (Step 4.2, P4-G2) ──────────────────────────────────────────
//
// Three questions of the native engine: the preflight refuses before anything is
// sent, a throwing preflight is survived, and a key the API rejects mid-run ends the run by itself with
// a bounded number of attempts. Through the shipped runner, native adapter, Gemini provider and FFmpeg;
// the provider is only wrapped to count what reached it.

interface NativeBadKeyOutcome {
  events: RunEvent[]
  finished: Extract<RunEvent, { type: 'finished' }> | undefined
  endings: number
  ms: number
  threw: string | null
  runningAfter: boolean
  calls: number
  console: string
}

let nativeSeq = 0

function nativeTranscribe(
  media: string,
  out: string,
  preflight?: (key: string, signal: AbortSignal) => Promise<KeyPreflight>
): Promise<NativeBadKeyOutcome> {
  const real = createGeminiProvider()
  let calls = 0
  const provider: GenerationProvider = {
    ...real,
    generate: (req, ctx) => {
      calls++
      return real.generate(req, ctx)
    }
  }
  const events: RunEvent[] = []
  const startedAt = Date.now()
  let threw: string | null = null
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      setTimeout(() => {
        const finals = events.filter((e): e is Extract<RunEvent, { type: 'finished' }> => e.type === 'finished')
        const logPath = findConsoleLog(finals[0]?.logPaths)
        resolve({
          events,
          finished: finals[0],
          endings: finals.length,
          ms: Date.now() - startedAt,
          threw,
          runningAfter: isRunning(),
          calls,
          console: logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
        })
      }, 750)
    }
    const guard = setTimeout(finish, PATIENCE_MS)
    startRun({
      kind: 'transcribe',
      runId: `badkey-native-${++nativeSeq}`,
      args: { ...transcribeArgs(media, out), model: 'gemini-3.7-flash', thinkingLevel: 'low' },
      adapter: () => createNativeEngineAdapter({ provider, ...(preflight ? { preflight } : {}) }),
      deliver: (e) => {
        events.push(e)
        if (e.type === 'finished') {
          clearTimeout(guard)
          finish()
        }
      },
      secrets: [BAD_KEY],
      preferences: { showTokenStats: true, writeTokenReport: false, progressLog: false, thoughtsLog: false }
    }).catch((err: unknown) => {
      threw = err instanceof Error ? err.message : String(err)
      clearTimeout(guard)
      finish()
    })
  })
}

const logLines = (o: NativeBadKeyOutcome): string[] =>
  o.events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log').map((e) => e.text)

async function nativeArms(clip: string, preflight: (key: string, signal: AbortSignal) => Promise<KeyPreflight>): Promise<void> {
  console.log('\n=== native engine — the rejected key ===\n')
  const guarded = await nativeTranscribe(clip, path.join(WORK, 'native-guarded.srt'), preflight)
  const started = guarded.events.find((e): e is Extract<RunEvent, { type: 'started' }> => e.type === 'started')
  // A native ending carries no exit code.
  check('NB0 the probe runs the native engine', started !== undefined && guarded.finished?.exitCode === null, JSON.stringify(guarded.finished?.exitCode))

  check('NB2 the preflight ends the run', guarded.endings > 0, 'no terminal event at all')
  check('NB2 exactly one terminal event', guarded.endings === 1, `${guarded.endings}`)
  check('NB2 reported as a failure, not as success', guarded.finished?.outcome === 'failed', String(guarded.finished?.outcome))
  check("NB2 carrying the reason 'guard'", guarded.finished?.reason === 'guard', String(guarded.finished?.reason))
  check('NB2 and it says the key was rejected', /rejected/i.test(guarded.finished?.error?.message ?? ''), guarded.finished?.error?.message ?? '')
  check('NB2 nothing was sent', guarded.calls === 0 && !guarded.events.some((e) => e.type === 'unit'), `${guarded.calls} requests`)
  check('NB2 so the log stayed tiny', logLines(guarded).length < 20, `${logLines(guarded).length} lines`)
  check('NB2 and it took seconds, not hours', guarded.ms < 90_000, `${Math.round(guarded.ms / 1000)}s`)
  check('NB2 and the job slot was released', !guarded.runningAfter)

  console.log('\n  (native: a preflight that throws — the run must survive it, and end)')
  const broken = await nativeTranscribe(path.join(WORK, 'nonexistent.m4a'), path.join(WORK, 'native-broken.srt'), async () => {
    throw new Error('preflight exploded')
  })
  check('NB2a the rejection does not escape the start', broken.threw === null, String(broken.threw))
  check('NB2a the run still reports exactly one terminal event', broken.endings === 1, `${broken.endings}`)
  check('NB2a and the job slot is free afterwards', !broken.runningAfter)
  check(
    'NB2a the failure is reported as a check that did not happen',
    logLines(broken).some((l) => /Could not check the API key/i.test(l)),
    logLines(broken).join(' | ')
  )
  check('NB2a and it was not mistaken for a rejection', broken.finished?.reason !== 'guard', String(broken.finished?.reason))

  console.log('\n  (native: no preflight — the rejected key reaches the request itself)')
  const storm = await nativeTranscribe(clip, path.join(WORK, 'native-storm.srt'))
  check('NB3 a rejected key ends the run by itself', storm.endings > 0 && storm.ms < PATIENCE_MS, `${Math.round(storm.ms / 1000)}s`)
  check('NB3 exactly one terminal event here too', storm.endings === 1, `${storm.endings}`)
  check('NB3 and it is not reported as a success', storm.finished?.outcome === 'failed', String(storm.finished?.outcome))
  check(
    'NB3 the ending names the key as the cause',
    storm.finished?.error?.kind === 'auth' && /key/i.test(storm.finished.error.message),
    JSON.stringify(storm.finished?.error)
  )
  check('NB3 a bounded number of requests, not a loop', storm.calls >= 1 && storm.calls <= 3, `${storm.calls} requests`)
  check('NB3 and the job slot is free afterwards', !storm.runningAfter)

  const everything = [guarded, broken, storm]
  check(
    'NB4 no event or console line contains the key',
    everything.every((o) => !JSON.stringify(o.events).includes(BAD_KEY) && !o.console.includes(BAD_KEY)),
    'THE API KEY LEAKED'
  )
  check(
    'NB4 the console names the key count',
    [guarded, storm].every((o) => o.console.startsWith('[native engine] transcribe ') && o.console.includes(' · 1 API key')),
    guarded.console.split('\n').slice(0, 2).join(' | ')
  )
}

async function main(): Promise<void> {
  console.log('\n=== REP-2 — a transcription with a rejected key has to end ===\n')

  if (!fs.existsSync(FFMPEG)) {
    console.log(`FFmpeg not found at ${FFMPEG}. Run \`npm run check:bin\` first.`)
    process.exit(1)
  }
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  const clip = path.join(WORK, 'clip.mp3')
  const built = await run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${CLIP_SECONDS}`,
    '-c:a', 'libmp3lame', '-b:a', '64k', clip
  ])
  if (built !== 0 || !fs.existsSync(clip)) {
    console.log('  FAIL  ffmpeg could not build the audio fixture')
    process.exit(1)
  }

  // ── B1 — the classification, which is what makes the refusal safe ───────────
  console.log('  (asking the API about the bad key — one round trip)')
  const verdict = await refreshModels(BAD_KEY)
  check('a rejected key is classified as rejected, not merely "failed"', verdict.verdict === 'rejected', `${verdict.verdict}: ${verdict.error}`)
  if (verdict.verdict === 'unchecked') {
    console.log('        (no network? every assertion below assumes the API is reachable)')
  }

  // The preflight the IPC supplies, built from the same model-list call.
  const preflight = async (apiKey: string, signal: AbortSignal): Promise<KeyPreflight> => {
    const res = await refreshModels(apiKey, signal)
    if (res.verdict === 'valid') return { verdict: 'valid', message: '' }
    if (res.verdict === 'rejected') {
      return { verdict: 'rejected', message: `The API rejected this key: ${res.error}` }
    }
    return { verdict: 'unchecked', message: `Could not check the key: ${res.error}` }
  }

  await nativeArms(clip, preflight)

  console.log(`\n${passes} passed, ${failures} failed`)
  fs.rmSync(WORK, { recursive: true, force: true })
  if (failures > 0) {
    console.log('\nPROBE FAILED — a bad key can still run away with a transcription.')
    process.exit(1)
  }
  console.log('\nALL BAD-KEY PROBES PASSED')
}

void main()
