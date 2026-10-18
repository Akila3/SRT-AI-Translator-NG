/**
 * FP-2 / REP-16: run the output-sanity detector across every real subtitle pair on this machine.
 *
 * G3 in the gate suite proves the *algorithm* against synthetic fixtures that ship with the repo.
 * This probe proves the *calibration*, which G3 cannot: the thresholds are only trustworthy if a
 * genuine translation never trips them, and "genuine" has to mean more than the one Hebrew file the
 * figures were measured on. The plan admitted that gap in as many words — "it does not cover every
 * supported language" — and this closes it with whatever the corpus holds.
 *
 * The corpus is copyrighted subtitle text and lives in `.secrets/`, which is git-ignored, so this
 * probe SKIPS cleanly when it is absent. Nothing here is committed as a fixture.
 *
 * Two kinds of pair:
 *
 * 1. **Real tool output** — Pachinko and the Boeing documentary, both produced by this app, both
 *    already index-aligned. These are the closest thing to production input that exists.
 * 2. **Professional pairs, timestamp-aligned** — separate subtitle files for the same title in up to
 *    ten languages. They are not index-aligned as shipped (different segmentation), so pairing them
 *    by index would compare unrelated cues and test nothing. Matching on start time first produces a
 *    genuinely parallel pair, which is what production looks like.
 *
 * Every pair is then re-run with the recorded filler injected, which turns the false-positive sweep
 * into a detection sweep over the same material.
 */
import fs from 'fs'
import path from 'path'
import { scanTranslatedOutput } from '../../electron/shared/outputSanity'

const CORPUS = path.join(process.cwd(), '.secrets')

/** The two-character filler the model actually returned, from the Bad Sisters debug log. */
const FILLER = 'ב-'

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail = ''): boolean {
  if (ok) {
    passed++
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
  return ok
}

interface TimedCue {
  start: number
  text: string
}

function parseTimed(text: string): TimedCue[] {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const cues: TimedCue[] = []
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    const t = lines.findIndex((l) => l.includes('-->'))
    if (t < 0) continue
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(lines[t])
    if (!m) continue
    const start =
      Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4])
    const body2 = lines.slice(t + 1).join('\n').trim()
    if (body2 === '') continue
    cues.push({ start, text: body2 })
  }
  return cues
}

function toSrt(cues: string[]): string {
  return cues
    .map((text, i) => {
      const s = i * 2000
      const fmt = (ms: number): string => {
        const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
        const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0')
        const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
        const msPart = String(ms % 1000).padStart(3, '0')
        return `${h}:${m}:${sec},${msPart}`
      }
      return `${i + 1}\n${fmt(s)} --> ${fmt(s + 1800)}\n${text}\n`
    })
    .join('\n')
}

/** Pair two subtitle files by start time, so the cues actually correspond. */
function alignByTime(a: TimedCue[], b: TimedCue[]): { source: string[]; output: string[] } {
  const source: string[] = []
  const output: string[] = []
  let j = 0
  for (const cue of a) {
    while (j < b.length - 1 && Math.abs(b[j + 1].start - cue.start) < Math.abs(b[j].start - cue.start)) {
      j++
    }
    if (j < b.length && Math.abs(b[j].start - cue.start) <= 1000) {
      source.push(cue.text)
      output.push(b[j].text)
    }
  }
  return { source, output }
}

/** Replace a stretch of the output with the filler, reproducing the measured fault. */
function corrupt(output: string[], from: number, length: number): string[] {
  const copy = [...output]
  for (let i = from; i < Math.min(from + length, copy.length); i++) copy[i] = FILLER
  return copy
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

function findWorks(): Array<{ label: string; source: string; outputs: string[] }> {
  const works: Array<{ label: string; source: string; outputs: string[] }> = []
  const root = path.join(CORPUS, 'SRT')
  if (!fs.existsSync(root)) return works
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const srts = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.srt'))
    const eng = srts.find((e) => /\.eng\.srt$/i.test(e.name))
    if (eng && srts.length > 1) {
      works.push({
        label: path.basename(dir),
        source: path.join(dir, eng.name),
        outputs: srts.filter((e) => e.name !== eng.name).map((e) => path.join(dir, e.name))
      })
    }
    for (const e of entries.filter((x) => x.isDirectory())) walk(path.join(dir, e.name))
  }
  walk(root)
  return works
}

function main(): void {
  if (!fs.existsSync(CORPUS)) {
    console.log('SKIP  .secrets/ is not present on this machine — nothing to calibrate against.')
    console.log('      G3 in `npm run test:gates` still proves the algorithm on shipped fixtures.')
    return
  }

  console.log('=== C1 — real tool output, already index-aligned ===')
  const realPairs: Array<{ label: string; src: string; out: string }> = [
    {
      label: 'Pachinko S01E01 en->he (this app)',
      src: path.join(CORPUS, 'Issues/_Reported/Logs/Pachinko.S01E01.eng.srt'),
      out: path.join(CORPUS, 'Issues/_Reported/Logs/Pachinko.S01E01.eng_he.srt')
    }
  ]
  for (const dir of fs.existsSync(path.join(CORPUS, 'Issues/_Reported'))
    ? fs.readdirSync(path.join(CORPUS, 'Issues/_Reported'), { withFileTypes: true })
    : []) {
    if (!dir.isDirectory() || !dir.name.startsWith('“Designed')) continue
    const full = path.join(CORPUS, 'Issues/_Reported', dir.name)
    const files = fs.readdirSync(full).filter((f) => f.toLowerCase().endsWith('.srt'))
    const he = files.find((f) => /_he\.srt$/i.test(f))
    const en = files.find((f) => !/_he\.srt$/i.test(f))
    if (he && en) {
      realPairs.push({
        label: 'Boeing 737 MAX en->he (this app, transcribed source)',
        src: path.join(full, en),
        out: path.join(full, he)
      })
    }
  }

  for (const pair of realPairs) {
    const src = read(pair.src)
    const out = read(pair.out)
    if (!src || !out) {
      console.log(`  SKIP  ${pair.label} — file missing`)
      continue
    }
    const warnings = scanTranslatedOutput(src, out)
    check(
      `${pair.label}: clean output produces no warning`,
      warnings.length === 0,
      warnings.map((w) => `${w.from}-${w.to} ${w.signals.join('+')}`).join('; ')
    )
  }

  console.log('\n=== C2 — professional pairs across languages, timestamp-aligned ===')
  const works = findWorks()
  if (works.length === 0) console.log('  SKIP  no .secrets/SRT corpus present')
  let languagePairs = 0
  const detectionInputs: Array<{ label: string; source: string[]; output: string[] }> = []
  for (const work of works) {
    const srcCues = parseTimed(read(work.source) ?? '')
    if (srcCues.length === 0) continue
    for (const outFile of work.outputs) {
      const outCues = parseTimed(read(outFile) ?? '')
      if (outCues.length === 0) continue
      const { source, output } = alignByTime(srcCues, outCues)
      if (source.length < 100) continue
      languagePairs++
      const lang = path.basename(outFile).replace(/^.*\.([a-z]{2,3})\.srt$/i, '$1')
      const warnings = scanTranslatedOutput(toSrt(source), toSrt(output))
      check(
        `${work.label} en->${lang}: no warning on ${source.length} aligned cues`,
        warnings.length === 0,
        warnings.map((w) => `${w.from}-${w.to} ${w.signals.join('+')}`).join('; ')
      )
      detectionInputs.push({ label: `${work.label} en->${lang}`, source, output })
    }
  }

  console.log(`\n=== C3 — the same material, corrupted: ${detectionInputs.length} pairs ===`)
  let detected = 0
  let missed: string[] = []
  let executed = 0
  for (const pair of detectionInputs) {
    // The measured fault: a 136-cue filler run starting partway through the file.
    const from = Math.min(463, Math.max(30, Math.floor(pair.source.length / 2)))
    const length = Math.min(136, pair.source.length - from)
    if (length < 30) continue
    executed++
    const warnings = scanTranslatedOutput(toSrt(pair.source), toSrt(corrupt(pair.output, from, length)))
    const hit = warnings.some((w) => w.from <= from + 1 && w.to >= from + length - 5)
    if (hit) detected++
    else missed.push(`${pair.label}: ${warnings.map((w) => `${w.from}-${w.to}`).join(';') || 'nothing'}`)
  }
  if (executed === 0) {
    // 0/0 caught is not success (SOL-50). Absent corpus stays a skip, like C2.
    // A corpus that produced no runnable pair is a failed calibration, not a skip.
    if (works.length === 0) {
      console.log('  SKIP  corrupted-variant detection — no .secrets/SRT corpus present')
    } else {
      check(
        'at least one corrupted variant was tested',
        false,
        'no aligned pair had enough cues to run detection'
      )
    }
  } else {
    check(
      `every corrupted variant is caught (${detected}/${executed})`,
      missed.length === 0,
      missed.slice(0, 5).join('\n        ')
    )
  }

  console.log(
    `\n${passed} passed, ${failed} failed — ${realPairs.length} real outputs, ${languagePairs} language pairs`
  )
  if (failed > 0) process.exit(1)
}

main()
