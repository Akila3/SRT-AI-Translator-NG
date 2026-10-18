// A stand-in for alass.exe, for the R13.4 process matrix and R13.7's speech export (implementation_plan.md §17).
// Run as: node fake-alass.mjs <behaviour> <recordDir> <alass arguments...>
// It reads and writes only what the real CLI would (`--json-report`, then `-- ref input output`,
// relative to its working folder), plus `<recordDir>/record-<pid>.json` when asked to record.
// AUTHORED-BY: opus-5.5-high
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

const [behaviour, recordDir, ...args] = process.argv.slice(2)

if (args[0] === '--version') {
  process.stdout.write(behaviour === 'wrong-version' ? 'alass-cli 1.9.0\n' : 'alass-cli 2.0.0\n')
  process.exit(behaviour === 'version-fails' ? 2 : 0)
}

const sep = args.indexOf('--')
const [ref, input, output] = args.slice(sep + 1)
const reportAt = args[args.indexOf('--json-report') + 1]
const opt = (name, fallback) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback)
const cues = (file) => (fs.readFileSync(file, 'utf8').match(/-->/g) || []).length

const report = (over = {}) => {
  const n = cues(input)
  return {
    candidate_only: true,
    engine: { name: 'alass-cli', version: '2.0.0' },
    fps: { ratio_label: '1', scaling_factor: 1.0 },
    input_cue_count: n,
    mode: args.includes('--no-split') ? 'no_split' : 'piecewise',
    parameters: { fps_guessing: !args.includes('--disable-fps-guessing'), interval_ms: opt('--interval', 1), speed_optimization: opt('--speed-optimization', 1), split_penalty: opt('--split-penalty', 7) },
    // A media reference's "cues" are its voice-activity spans; the fake claims three.
    reference_cue_count: path.extname(ref) === '.srt' ? cues(ref) : 3,
    schema_version: 1,
    score: 1.0,
    shift_groups: n ? [{ cue_count: n, delta_ms: 0, first_start_ms: 0, last_start_ms: 0 }] : [],
    warnings: [],
    ...over
  }
}
const succeed = (over) => {
  fs.copyFileSync(input, output)
  fs.writeFileSync(reportAt, JSON.stringify(report(over), null, 2))
}
const hang = () => setInterval(() => {}, 1 << 30)

// The speech export (`-- media _ speech.srt`, R13.7): the spans as SubRip and a vad_export report.
if (input === '_') {
  const spans = (n) => Array.from({ length: n }, (_, i) => `${i + 1}\n00:00:0${i + 1},000 --> 00:00:0${i + 1},500\nx\n`).join('\n')
  const vad = (n, over = {}) => JSON.stringify({ candidate_only: true, engine: { name: 'alass-cli', version: '2.0.0' }, fps: null, mode: 'vad_export', reference_span_count: n, schema_version: 1, score: null, shift_groups: [], warnings: [], ...over }, null, 2)
  const alignmentReport = JSON.stringify({
    candidate_only: true,
    engine: { name: 'alass-cli', version: '2.0.0' },
    fps: { ratio_label: '1', scaling_factor: 1.0 },
    input_cue_count: 3,
    mode: 'piecewise',
    parameters: { fps_guessing: true, interval_ms: 1, speed_optimization: 1, split_penalty: 7 },
    reference_cue_count: 3,
    schema_version: 1,
    score: 1.0,
    shift_groups: [{ cue_count: 3, delta_ms: 0, first_start_ms: 0, last_start_ms: 0 }],
    warnings: []
  })
  const exported = {
    ok: [spans(3), vad(3)],
    record: [spans(3), vad(3)],
    'hang-align': [spans(3), vad(3)],
    'align-other-ref': [spans(3), vad(3)],
    'vad-empty': ['', vad(0)],
    'vad-silent-text': [spans(1), vad(0)],
    'vad-short': [spans(2), vad(3)],
    'vad-bytes': [Buffer.from([0x31, 0x0a, 0xff, 0xfe, 0x0a]), vad(1)],
    'vad-not-vad': [spans(3), alignmentReport]
  }
  if (behaviour in exported) {
    if (behaviour === 'record') fs.writeFileSync(path.join(recordDir, `record-${process.pid}.json`), JSON.stringify({ args, cwd: process.cwd(), env: process.env, refExists: fs.existsSync(ref) }))
    const write = () => {
      fs.writeFileSync(output, exported[behaviour][0])
      fs.writeFileSync(reportAt, exported[behaviour][1])
      process.exit(0)
    }
    // hang-align spends 1.5 s exporting, so a per-step deadline would outlast the run's one deadline.
    if (behaviour === 'hang-align') setTimeout(write, 1500)
    else write()
  }
}

switch (behaviour) {
  case 'hang-align':
    hang()
    break
  case 'align-other-ref':
    succeed({ reference_cue_count: 2 })
    break
  case 'ok':
    succeed()
    break
  case 'record':
    fs.writeFileSync(path.join(recordDir, `record-${process.pid}.json`), JSON.stringify({ args, cwd: process.cwd(), env: process.env, refExists: fs.existsSync(ref) }))
    succeed()
    break
  case 'exit3':
    fs.writeFileSync(output, '1\n00:00:01,000 --> 00:00:0')
    fs.writeFileSync(reportAt, '{"schema_version": 1,')
    process.exit(3)
    break
  case 'hang':
    hang()
    break
  case 'grandchild': {
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: ['ignore', 'inherit', 'inherit'] })
    fs.writeFileSync(path.join(recordDir, 'grandchild.pid'), String(g.pid))
    hang()
    break
  }
  case 'spam-stdout': {
    const chunk = Buffer.alloc(64 * 1024, 0x2e)
    const go = () => process.stdout.write(chunk, go)
    go()
    break
  }
  case 'spam-stderr': {
    const chunk = Buffer.alloc(64 * 1024, 0x21)
    const go = () => process.stderr.write(chunk, go)
    go()
    break
  }
  case 'big-output':
    fs.writeFileSync(output, Buffer.alloc(256 * 1024, 0x41))
    fs.writeFileSync(reportAt, JSON.stringify(report(), null, 2))
    break
  case 'big-report':
    fs.copyFileSync(input, output)
    fs.writeFileSync(reportAt, ' '.repeat(5 * 1024 * 1024) + JSON.stringify(report()))
    break
  case 'no-output':
    break
  case 'no-report':
    fs.copyFileSync(input, output)
    break
  case 'bad-report':
    fs.copyFileSync(input, output)
    fs.writeFileSync(reportAt, JSON.stringify(report({ verdict: 'accept' }), null, 2))
    break
  case 'other-mode':
    succeed({ mode: args.includes('--no-split') ? 'piecewise' : 'no_split', shift_groups: [{ cue_count: cues(input), delta_ms: 0, first_start_ms: 0, last_start_ms: 0 }] })
    break
  case 'other-penalty':
    succeed({ parameters: { fps_guessing: true, interval_ms: 1, speed_optimization: 1, split_penalty: 8 } })
    break
  case 'other-count': {
    const n = cues(input) - 1
    succeed({ input_cue_count: n, shift_groups: [{ cue_count: n, delta_ms: 0, first_start_ms: 0, last_start_ms: 0 }] })
    break
  }
  case 'vad-report':
    fs.copyFileSync(input, output)
    fs.writeFileSync(reportAt, JSON.stringify({ candidate_only: true, engine: { name: 'alass-cli', version: '2.0.0' }, fps: null, mode: 'vad_export', reference_span_count: 3, schema_version: 1, score: null, shift_groups: [], warnings: [] }, null, 2))
    break
  case 'output-dir':
    fs.mkdirSync(output)
    fs.writeFileSync(reportAt, JSON.stringify(report(), null, 2))
    break
  default:
    process.stderr.write(`unknown behaviour ${behaviour}\n`)
    process.exit(64)
}
