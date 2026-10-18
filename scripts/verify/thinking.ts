/**
 * REP-1 claim 3 probe — are thought summaries kept apart from the translation, and only when asked for?
 *
 * Investigation tooling, not a product change. It exists because a user reported an empty
 * thoughts log and the static answer ("Google returned no thoughts") is a claim about a
 * remote service that only a real call can settle.
 *
 * The run goes through the real `translate:start` handler, so what is measured is what the app
 * sends. Scenarios A–F measured gst's argv and its streaming flush; they went with the CLI at
 * Step 4.5 (gate_ledger.md §5m.0 Receipt 2: observational, no assertion, successor NT).
 *
 * COST: two small API calls, on a 12-cue fixture.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { setSettings } from '../../electron/main/store'
import { registerIpc, setMainWindow } from '../../electron/main/ipc'
import { __invokeIpc } from '../gates/stubs/electron'
import type { RunEvent } from '../../electron/shared/engineEvents'

const ROOT = process.cwd()
const KEY_FILE = path.join(ROOT, '.secrets', 'gemini-key.txt')
const SOURCE_SRT = path.join(ROOT, '.secrets', 'SRT', 'Fleabag', 'Fleabag.S01E01.eng.srt')
const TIMEOUT_MS = 300_000
const CUES = 12

let secret = ''
const mask = (t: string): string => (secret ? t.split(secret).join('***KEY***') : t)

function loadKey(): string {
  const fromEnv = process.env.GEMINI_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const line = fs
    .readFileSync(KEY_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  if (!line) {
    console.error(`\n${KEY_FILE} contains no key line.\n`)
    process.exit(1)
  }
  // The file labels its lines ("Free: …"); `live.ts` strips the label the same way.
  return /^[A-Za-z][A-Za-z ]{0,20}[:=]\s*(\S+)/.exec(line)?.[1] ?? line
}

/** First N cues of a real subtitle — real dialogue is likelier to provoke reasoning than a toy fixture. */
function fixture(): string {
  const raw = fs.readFileSync(SOURCE_SRT, 'utf8').replace(/^\uFEFF/, '')
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim())
  return blocks.slice(0, CUES).join('\n\n') + '\n'
}

/**
 * NT — the native engine through the `translate:start` handler (Step 4.2, P4-G2).
 *
 * Native reads the provider's thought summaries as labelled parts, never by parsing text out of a
 * stream, so the question changes from "did any arrive" to "are they kept apart": thought text in
 * the thoughts log under its batch heading and never in the translation, and no thoughts log at
 * all when the Setting is off. Flash-Lite 3.5 at LOW, so an empty summary is a recorded outcome.
 */
const ntFailures: string[] = []

function nt(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) ntFailures.push(label)
}

async function nativeScenario(work: string, body: string): Promise<void> {
  const events: RunEvent[] = []
  const contents = { isDestroyed: () => false, send: (channel: string, payload: unknown) => channel === 'engine:event' && events.push(payload as RunEvent) }
  setMainWindow({ isDestroyed: () => false, on: () => undefined, webContents: contents } as unknown as Parameters<typeof setMainWindow>[0])
  registerIpc()
  setSettings({ cachedModels: [], apiKeys: [secret] })
  await __invokeIpc('models:checkKeys', [secret])

  const runOnce = async (id: string, thoughtsLog: boolean): Promise<Extract<RunEvent, { type: 'finished' }> | undefined> => {
    const dir = path.join(work, id)
    fs.mkdirSync(dir)
    const input = path.join(dir, 'fixture.srt')
    fs.writeFileSync(input, body, 'utf8')
    setSettings({ writeTokenReport: true, progressLog: true, thoughtsLog })
    const runId = `thinking-${id}`
    await __invokeIpc('translate:start', {
      runId,
      inputFile: input,
      sourceLang: 'en',
      targetLang: 'he',
      model: 'gemini-3.5-flash-lite',
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
      disableStreaming: false
    })
    const deadline = Date.now() + TIMEOUT_MS
    while (!events.some((e) => e.runId === runId && e.type === 'finished') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    return events.find((e): e is Extract<RunEvent, { type: 'finished' }> => e.runId === runId && e.type === 'finished')
  }

  console.log('=== NT — native thought summaries through translate:start (level low) ===')
  const on = await runOnce('NT', true)
  const started = events.find((e): e is Extract<RunEvent, { type: 'started' }> => e.runId === 'thinking-NT' && e.type === 'started')
  // A native ending carries no exit code.
  nt('NT the run is the native engine\u2019s and completes', started !== undefined && on?.exitCode === null && on?.outcome === 'completed', mask(JSON.stringify({ outcome: on?.outcome, error: on?.error })))
  const readIf = (p: string | undefined): string => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
  const output = readIf(on?.outputPath)
  nt('NT the translation is whole', (output.match(/-->/g) ?? []).length === CUES, `${(output.match(/-->/g) ?? []).length} cues`)
  const thoughtsPath = on?.logPaths.find((p) => p.endsWith('.thoughts.log'))
  nt('NT with the Setting on, the thoughts log is offered', !!thoughtsPath && fs.existsSync(thoughtsPath), JSON.stringify(on?.logPaths))
  const thoughts = readIf(thoughtsPath)
  const content = thoughts
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^=+$/.test(l) && !/^Batch \d+(\.\d+)? thoughts:$/.test(l))
  let tokens: number | null = null
  try {
    tokens = JSON.parse(readIf(on?.logPaths.find((p) => p.endsWith('.tokens.json'))))?.tokens?.thoughts ?? null
  } catch {
    /* absent — recorded as null */
  }
  console.log(`        thinking tokens ${tokens}; ${content.length} thought line(s); thoughts log ${thoughts.length} B`)
  nt('NT every thought sits under a batch heading', content.length === 0 || /^={80}\r?\n\r?\nBatch 1 thoughts:\r?\n/.test(thoughts), JSON.stringify(thoughts.slice(0, 120)))
  nt('NT no thought text reached the translation', content.every((l) => l.length < 12 || !output.includes(l)), 'a thought line is in the subtitle')

  const off = await runOnce('NT-off', false)
  const stem = (off?.outputPath ?? '').replace(/\.[^.]+$/, '')
  nt('NT with the Setting off, the run still completes', off?.outcome === 'completed', mask(JSON.stringify({ outcome: off?.outcome, error: off?.error })))
  nt(
    'NT with the Setting off, no thoughts log is written or offered',
    !!stem && !fs.existsSync(`${stem}.thoughts.log`) && !(off?.logPaths ?? []).some((p) => p.endsWith('.thoughts.log')),
    JSON.stringify(off?.logPaths)
  )
  console.log('')
}

async function main(): Promise<void> {
  secret = loadKey()
  setSettings({ apiKeys: [secret], apiKeyValid: [true], apiKeyTiers: ['free'] })

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-thinking-'))
  const body = fixture()
  console.log(`\nFixture: ${CUES} cues from ${path.basename(SOURCE_SRT)}`)
  console.log(`Work dir: ${work}\n`)

  await nativeScenario(work, body)

  if (ntFailures.length) {
    console.log(`\nNT FAILED:\n${ntFailures.map((f) => `  - ${f}`).join('\n')}`)
    process.exitCode = 1
  }
  console.log(`\nArtifacts kept in: ${work}\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
