/**
 * REP-11a — does the run's preparation reach the page as it happens, or in one late burst?
 *
 * The reported symptom was that transcription's log panel stays empty through the whole audio
 * extraction and then prints everything at once. Under the CLI the cause was the frozen engine's
 * stdout buffering (`scripts/gst_entry.py`); that half of the probe went with the CLI at Step 4.5
 * (gate_ledger.md §5m.0 Receipt 2, successor NF). The native engine has no stdout to buffer, so
 * what is measured is the run's own `phase` events and FFmpeg's progress.
 *
 * FIDELITY. The fixture goes through the app's own preparation on the bundled FFmpeg, and the run
 * is started through the real runner with the real native adapter.
 *
 * COST. None. The fixture is generated from FFmpeg's synthetic sources, the key is a dummy, and the
 * provider is a stand-in that stops the run at its first request, so nothing reaches the network.
 *
 * Run with `node scripts/verify/run-buffering.mjs`. Exits non-zero if the preparation does not stream.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { configureRunnerRuntime, startRun, stopCurrent } from '../../electron/engine/runner'
configureRunnerRuntime({ settingsRevisions: { current: () => 0, subscribe: () => () => {} } })
import { createNativeEngineAdapter } from '../../electron/engine/native/nativeAdapter'
import { GEMINI_CAPABILITIES } from '../../electron/engine/providers/gemini'
import type { GenerationProvider } from '../../electron/engine/providers/types'
import type { RunEvent } from '../../electron/shared/engineEvents'
import type { TranscribeArgs } from '../../electron/shared/types'

const ROOT = process.cwd()
const EXE = process.platform === 'win32' ? '.exe' : ''
const FFMPEG = path.join(ROOT, 'resources', 'bin', `ffmpeg${EXE}`)
const WORK = path.join(ROOT, '.tmp-buffer-probe')
const FIXTURE = path.join(WORK, 'probe-10min.mkv')
const FIXTURE_SECONDS = 600

/** Hard ceiling; the run normally ends far sooner, at its first request. */
const KILL_AFTER_MS = 120_000

function run(cmd: string, args: string[]): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args)
    let err = ''
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('close', (code) => resolve({ code, err }))
    p.on('error', (e) => resolve({ code: -1, err: e.message }))
  })
}

async function makeFixture(): Promise<void> {
  if (fs.existsSync(FIXTURE) && fs.statSync(FIXTURE).size > 0) return
  fs.mkdirSync(WORK, { recursive: true })
  const r = await run(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=320x240:r=5:d=${FIXTURE_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${FIXTURE_SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    FIXTURE
  ])
  if (r.code !== 0) throw new Error(`fixture build failed: ${r.err.slice(-600)}`)
}

function probeArgs(outputFile: string): TranscribeArgs {
  return {
    mediaFile: FIXTURE,
    outputFile,
    targetLang: 'en',
    model: 'gemini-2.5-flash',
    // Never a real key: the run is stopped before anything is sent.
    apiKeys: ['DUMMY-KEY-NOT-REAL'],
    thinkingLevel: 'low',
    thinkingBudget: 512,
    customGenerationParams: false,
    temperature: 1,
    topP: 0.95,
    topK: null
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(FFMPEG)) throw new Error(`missing ${FFMPEG} — add FFmpeg`)
  console.log('building synthetic fixture...')
  await makeFixture()

  const failures = await nativeArm()
  if (failures.length) {
    console.error('\nFAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
}

/**
 * NF — the native engine's preparation on the synthetic fixture and the bundled FFmpeg (Step 4.2, P4-G2).
 *
 * There is no engine stdout to buffer: the run's own `phase` events and FFmpeg's progress are the
 * user's evidence that extraction is under way. Both must arrive while it happens rather than after.
 * The provider is a stand-in that ends the run at its first call, so nothing is ever sent.
 */
async function nativeArm(): Promise<string[]> {
  const failures: string[] = []
  const t0 = Date.now()
  const arrivals: Array<{ atMs: number; what: string }> = []
  const progress: number[] = []
  let calls = 0
  const provider: GenerationProvider = {
    id: 'stops-at-first-call',
    capabilities: GEMINI_CAPABILITIES,
    generate: (_req, ctx) => {
      calls++
      arrivals.push({ atMs: Date.now() - t0, what: 'first request (not sent)' })
      stopCurrent()
      return new Promise((resolve) => {
        const cancelled = { result: { ok: false as const, kind: 'cancelled' as const }, usage: null, envelope: null, detailKeys: [] }
        if (ctx.signal.aborted) resolve(cancelled)
        ctx.signal.addEventListener('abort', () => resolve(cancelled), { once: true })
      })
    }
  }
  let finished: Extract<RunEvent, { type: 'finished' }> | undefined
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, KILL_AFTER_MS)
    void startRun({
      kind: 'transcribe',
      runId: 'buffering-native',
      args: { ...probeArgs(path.join(WORK, 'native.srt')), model: 'gemini-3.7-flash' },
      adapter: () => createNativeEngineAdapter({ provider, onProgress: () => progress.push(Date.now() - t0) }),
      deliver: (e) => {
        if (e.type === 'phase') arrivals.push({ atMs: Date.now() - t0, what: `phase ${e.phase}` })
        if (e.type === 'finished') {
          finished = e
          clearTimeout(timer)
          resolve()
        }
      },
      secrets: ['DUMMY-KEY-NOT-REAL'],
      preferences: { showTokenStats: true, writeTokenReport: false, progressLog: false, thoughtsLog: false }
    }).catch(() => resolve())
  })

  console.log('\n--- native arrival ---')
  for (const a of arrivals) console.log(`  ${String(a.atMs).padStart(6)} ms  ${a.what}`)
  console.log(`  ${progress.length} FFmpeg progress update(s)${progress.length ? `, ${progress[0]}–${progress.at(-1)} ms` : ''}`)

  const preparing = arrivals.find((a) => a.what === 'phase preparing')?.atMs ?? -1
  const working = arrivals.find((a) => a.what === 'phase working')?.atMs ?? -1
  const during = new Set(progress.filter((ms) => ms > preparing && (working < 0 || ms < working)))
  if (preparing < 0 || working < 0) failures.push('NF the native run never reached both its preparation and its first part')
  else if (working - preparing < 100 || during.size < 2) {
    failures.push(
      `NF native preparation events arrived together (preparing ${preparing} ms, working ${working} ms, ` +
        `${during.size} distinct progress updates between) — the page would sit blank through extraction`
    )
  }
  if (calls > 1 || finished?.outcome !== 'stopped') failures.push(`NF the run was not stopped at its first request (${calls} calls, ${finished?.outcome})`)
  if (!failures.length) console.log('\nPASS  NF native preparation phase and progress events arrive as they happen, and nothing was sent')
  return failures
}

main().catch((e) => {
  console.error('PROBE FAILED:', (e as Error).message)
  process.exit(1)
})
