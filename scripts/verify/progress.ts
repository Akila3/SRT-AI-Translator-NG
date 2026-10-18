/**
 * REP-11 — does our own ffmpeg actually report progress, and is the report true?
 *
 * The gates prove the parser. They cannot prove the thing the parser exists for: that a real
 * ffmpeg, invoked the way the app invokes it, streams `-progress` output at all, that the
 * numbers climb, and — the part with teeth — that adding those flags did not change the file
 * that comes out. A subtitle export that gained a byte, or an MP3 the engine can no longer
 * read, would be a far worse defect than the silence this phase set out to fix.
 *
 * FIDELITY. Every call goes through the app's own `extractTrack` / `convertAudioToMp3`, so
 * the argv, the tool resolution and the progress plumbing are the shipped ones.
 *
 * COST. None. No API key, no network, no quota: one synthetic fixture built by FFmpeg itself,
 * plus any real media already sitting in `.secrets/fixtures` (used read-only, and skipped
 * when absent).
 *
 * Run with `node scripts/verify/run-progress.mjs`. Exits non-zero on failure.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { convertAudioToMp3, extractTrack, probeDuration, probeTracks } from '../../electron/main/ffmpeg'

const ROOT = process.cwd()
const EXE = process.platform === 'win32' ? '.exe' : ''
const FFMPEG = path.join(ROOT, 'resources', 'bin', `ffmpeg${EXE}`)
const FIXTURE_DIR = path.join(ROOT, '.secrets', 'fixtures')
const WORK = path.join(ROOT, '.tmp-progress-probe')

/**
 * An hour of audio, so the conversion lasts long enough to report more than once.
 *
 * ffmpeg emits a progress block roughly twice a second of WALL time, and it compresses a
 * sine wave far faster than real time, so a short fixture would finish inside the first
 * reporting interval and prove nothing.
 */
const AUDIO_SECONDS = 3600

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

function skip(name: string, why: string): void {
  console.log(`  SKIP  ${name} — ${why}`)
}

function run(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args)
    p.on('error', () => resolve(-1))
    p.on('close', (code) => resolve(code))
  })
}

/** Everything one task reported, in order. */
interface Recorded {
  reports: Array<{ pct: number | null; elapsedMs: number }>
}

function recorder(): { rec: Recorded; onProgress: (pct: number | null, ms: number) => void } {
  const rec: Recorded = { reports: [] }
  return { rec, onProgress: (pct, elapsedMs) => rec.reports.push({ pct, elapsedMs }) }
}

/** The invariants every task's report stream must satisfy, whatever the task was. */
function checkStream(label: string, rec: Recorded, expectPct: boolean): void {
  check(`${label} reported progress at all`, rec.reports.length > 0, `${rec.reports.length} reports`)
  if (rec.reports.length === 0) return

  const pcts = rec.reports.map((r) => r.pct)
  if (expectPct) {
    check(`${label} knew the duration, so every report is a percentage`, pcts.every((p) => p !== null))
  }
  const known = pcts.filter((p): p is number => p !== null)
  check(`${label} never reported 100 while still running`, known.every((p) => p < 100))
  check(`${label} stayed inside 0-99`, known.every((p) => p >= 0 && p <= 99))
  check(
    `${label} never went backwards`,
    known.every((p, i) => i === 0 || p >= known[i - 1])
  )
  check(
    `${label} the clock only moves forwards`,
    rec.reports.every((r, i) => i === 0 || r.elapsedMs >= rec.reports[i - 1].elapsedMs)
  )
  console.log(
    `        ${rec.reports.length} reports, ${known.length === 0 ? 'no percentages' : `${known[0]}% → ${known[known.length - 1]}%`}, ${
      rec.reports[rec.reports.length - 1].elapsedMs
    } ms`
  )
}

async function main(): Promise<void> {
  console.log('\n=== REP-11 — ffmpeg progress, measured against a real ffmpeg ===\n')

  if (!fs.existsSync(FFMPEG)) {
    console.log(`FFmpeg not found at ${FFMPEG}. Run \`npm run check:bin\` first.`)
    process.exit(1)
  }
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  // ── P1 — the audio conversion, on a fixture built here ──────────────────────
  const rawM4a = path.join(WORK, 'long.m4a')
  const built = await run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${AUDIO_SECONDS}`,
    '-c:a', 'aac', '-b:a', '96k', rawM4a
  ])
  if (built !== 0 || !fs.existsSync(rawM4a)) {
    check('the audio conversion fixture was built', false, 'ffmpeg could not build the .m4a fixture')
  } else {
    const duration = await probeDuration(rawM4a)
    check(
      'the fixture reports its duration, which is what makes a percentage possible',
      duration !== null && Math.abs(duration - AUDIO_SECONDS) < 5,
      String(duration)
    )

    const { rec, onProgress } = recorder()
    const outMp3 = path.join(WORK, 'converted.mp3')
    const res = await convertAudioToMp3(rawM4a, outMp3, undefined, undefined, onProgress)
    check('the conversion succeeded', res.ok, res.error ?? '')
    checkStream('the conversion', rec, true)

    // The regression that matters: the flags must not change the product. A silent run and a
    // reporting run have to produce the same bytes, or every transcription now uploads
    // something subtly different from what was verified in FP-1's round trip.
    const silentMp3 = path.join(WORK, 'converted-silent.mp3')
    const silent = await convertAudioToMp3(rawM4a, silentMp3, undefined, undefined)
    check('the same conversion without progress also succeeded', silent.ok, silent.error ?? '')
    if (res.ok && silent.ok) {
      check(
        'asking for progress did not change the audio the engine receives',
        fs.readFileSync(outMp3).equals(fs.readFileSync(silentMp3))
      )
    }

    // ── FP6-01 — Stop has to reach the duration probe, not only the conversion ──
    //
    // Progress inserted a second child process, and it runs BEFORE the one the abort signal
    // was written for. The first check below is the load-bearing one: it asks the probe
    // directly whether cancellation reaches it, because on this machine ffprobe answers in
    // milliseconds and the timing checks that follow would pass either way. The scenario in
    // the finding — an unreachable network path, where that read is bounded by nothing —
    // cannot be staged here, so the wiring is asserted instead of the symptom.
    const probeAborted = new AbortController()
    probeAborted.abort()
    check(
      'a cancelled duration probe does not read the file at all',
      (await probeDuration(rawM4a, undefined, probeAborted.signal)) === null
    )

    const preAborted = new AbortController()
    preAborted.abort()
    const preOut = path.join(WORK, 'aborted-before.mp3')
    const t0 = Date.now()
    const pre = await convertAudioToMp3(rawM4a, preOut, undefined, preAborted.signal, () => {})
    const preMs = Date.now() - t0
    check('an already-cancelled conversion refuses rather than running', !pre.ok)
    check('and returns at once, without waiting on the duration probe', preMs < 2000, `${preMs} ms`)
    check('leaving no partial file behind', !fs.existsSync(preOut))

    // Cancelled mid-flight. The full conversion takes ~14 s, so finishing in a small fraction
    // of that is the evidence the process was actually killed rather than allowed to finish.
    const midAborted = new AbortController()
    const midOut = path.join(WORK, 'aborted-during.mp3')
    setTimeout(() => midAborted.abort(), 500)
    const t1 = Date.now()
    const mid = await convertAudioToMp3(rawM4a, midOut, undefined, midAborted.signal, () => {})
    const midMs = Date.now() - t1
    check('a conversion cancelled while running stops', !mid.ok)
    check('well before it would have finished', midMs < 5000, `${midMs} ms`)
    check('and cleans up after itself', !fs.existsSync(midOut))
  }

  // ── P2 — a subtitle export, on real media if this machine has any ───────────
  const media = fs.existsSync(FIXTURE_DIR)
    ? fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => ['.mkv', '.mp4', '.mov', '.webm'].includes(path.extname(f).toLowerCase()))
        .map((f) => path.join(FIXTURE_DIR, f))
    : []

  if (media.length === 0) {
    skip('the subtitle export', `no media in ${FIXTURE_DIR}`)
  } else {
    const video = media[0]
    const tracks = await probeTracks(video)
    const text = tracks.find((t) => !t.isImage)
    if (!text) {
      skip('the subtitle export', `${path.basename(video)} has no text track`)
    } else {
      console.log(`  using ${path.basename(video)} track ${text.index} (${text.lang || 'untagged'})`)
      const { rec, onProgress } = recorder()
      const out = path.join(WORK, 'export.srt')
      const res = await extractTrack(video, text.index, out, false, undefined, onProgress)
      check('the export succeeded', res.ok, res.error ?? '')
      check('and wrote a non-empty file', fs.existsSync(out) && fs.statSync(out).size > 0)
      checkStream('the export', rec, true)

      // The silent path is the one the other verification probes and any future caller use;
      // it must still work, and must still produce exactly the same subtitle.
      const silentOut = path.join(WORK, 'export-silent.srt')
      const silent = await extractTrack(video, text.index, silentOut, false)
      check('the same export without progress also succeeded', silent.ok, silent.error ?? '')
      if (res.ok && silent.ok) {
        check(
          'asking for progress did not change the extracted subtitle',
          fs.readFileSync(out).equals(fs.readFileSync(silentOut))
        )
      }
    }
  }

  console.log(`\n${passes} passed, ${failures} failed`)
  fs.rmSync(WORK, { recursive: true, force: true })
  if (failures > 0) {
    console.log('\nPROBE FAILED — ffmpeg progress is not behaving as the UI now claims.')
    process.exit(1)
  }
  if (passes === 0) {
    console.log('\nPROBE FAILED — no progress scenario ran, so this is not a pass.')
    process.exit(1)
  }
  console.log('\nALL PROGRESS PROBES PASSED')
}

void main()
