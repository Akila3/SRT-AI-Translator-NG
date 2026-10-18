// A stand-in for alass.exe for the R13.5 Align-service gates (implementation_plan.md §17 R13.5): it writes
// a chosen output timeline so the gates can show that NG's own A–I check over that output — never
// ALASS's exit code, score or report — decides the verdict.
// Run as: node fake-alass-outputs.mjs <behaviour> <args...>   (the real CLI's arguments, `--` then files)
// AUTHORED-BY: opus-5.5-high
import { spawn } from 'child_process'
import fs from 'fs'

const [behaviour, ...args] = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('alass-cli 2.0.0\n')
  process.exit(0)
}

const sep = args.indexOf('--')
const [ref, input, output] = args.slice(sep + 1)
const reportAt = args[args.indexOf('--json-report') + 1]

const STAMP = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/
const ms = (h, m, s, f) => ((+h * 60 + +m) * 60 + +s) * 1000 + +f
const stamp = (t) => {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(t / 3_600_000))}:${p(Math.floor(t / 60_000) % 60)}:${p(Math.floor(t / 1000) % 60)},${p(t % 1000, 3)}`
}
const read = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split(/\n\n+/)
    .filter((b) => b.trim())
    .map((b) => {
      const [, timing, ...text] = b.split('\n')
      const m = STAMP.exec(timing)
      return { start: ms(m[1], m[2], m[3], m[4]), end: ms(m[5], m[6], m[7], m[8]), text: text.join('\n') }
    })
const write = (cues) => fs.writeFileSync(output, cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'))

const source = read(input)
const reference = read(ref)
// "follow": each line takes the reference line at the same position — a perfect piecewise result.
const follow = () => source.map((c, i) => ({ ...c, start: reference[i].start, end: reference[i].end }))

const report = () => ({
  candidate_only: true,
  engine: { name: 'alass-cli', version: '2.0.0' },
  fps: { ratio_label: '1', scaling_factor: 1.0 },
  input_cue_count: source.length,
  mode: args.includes('--no-split') ? 'no_split' : 'piecewise',
  parameters: { fps_guessing: true, interval_ms: 1, speed_optimization: 1, split_penalty: 7 },
  reference_cue_count: reference.length,
  schema_version: 1,
  score: 1.0e9,
  shift_groups: [{ cue_count: source.length, delta_ms: 0, first_start_ms: 0, last_start_ms: 0 }],
  warnings: []
})

switch (behaviour) {
  case 'follow':
    write(follow())
    break
  case 'alter-text':
    write(follow().map((c, i) => (i === 1 ? { ...c, text: `${c.text} (changed)` } : c)))
    break
  case 'drop-cue':
    write(follow().slice(0, -1))
    break
  case 'scramble':
    // Monotonic, well-formed, and unrelated to the reference: exit 0 and a perfect-looking report.
    write(source.map((c, i) => ({ ...c, start: 1000 + i * 977 + ((i * 7919) % 613), end: 1000 + i * 977 + ((i * 7919) % 613) + 300 })))
    break
  case 'hang':
    setInterval(() => {}, 1 << 30)
    break
  case 'pipe-holder': {
    // A descendant that inherits this process's pipes and outlives it: when this process is killed
    // alone, `close` waits for the descendant. Its pid is left in the run folder for the gate.
    // `detached`: on Windows Node otherwise kills its children's job when it dies.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'inherit', detached: true, windowsHide: true })
    fs.writeFileSync('holder.pid', String(holder.pid))
    setInterval(() => {}, 1 << 30)
    break
  }
  case 'exit3':
    process.exit(3)
    break
  default:
    process.stderr.write(`unknown behaviour ${behaviour}\n`)
    process.exit(64)
}
if (behaviour !== 'hang' && behaviour !== 'pipe-holder') fs.writeFileSync(reportAt, JSON.stringify(report(), null, 2))
