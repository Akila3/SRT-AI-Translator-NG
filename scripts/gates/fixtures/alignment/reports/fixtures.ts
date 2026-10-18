/**
 * ALASS report fixtures (implementation_plan.md §17 R13.3). Synthetic timelines only: every cue is
 * "Line N" on a generated schedule, so no subtitle text or private timing enters git.
 *
 * All three samples are byte-for-byte what `resources/bin/alass/2.0.0/alass.exe` (SHA-256
 * ea314c5c…e5aa, `vendor/alass/2.0.0/build-receipt.json`) wrote with `--split-penalty 7
 * --speed-optimization 1 --interval 1`: `PIECEWISE_SAMPLE` for `syntheticPair('two_part')`,
 * `NO_SPLIT_SAMPLE` for `syntheticPair('offset')` with `--no-split`, and `VAD_SAMPLE` for
 * `-- ref.srt _ spans.srt`. The R13.3 gate re-runs the executable and requires the same bytes.
 *
 * AUTHORED-BY: opus-5.5-high
 */

const stamp = (ms: number): string => {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}
const srt = (cues: readonly { s: number; e: number }[]): string => cues.map((c, i) => `${i + 1}\n${stamp(c.s)} --> ${stamp(c.e)}\nLine ${i + 1}\n`).join('\n')

/**
 * 150 reference cues on an uneven schedule. `offset`: the input is the reference 3 s late throughout.
 * `two_part`: the first 75 cues are 3 s late and the rest 9 s late, the shape piecewise exists for.
 */
export function syntheticPair(kind: 'offset' | 'two_part'): { reference: string; input: string; cues: number } {
  const ref = Array.from({ length: 150 }, (_, i) => {
    const s = 2000 + i * 4000 + ((i * 37) % 900)
    return { s, e: s + 1500 + ((i * 53) % 1200) }
  })
  const late = (i: number): number => (kind === 'offset' || i < 75 ? 3000 : 9000)
  return { reference: srt(ref), input: srt(ref.map((c, i) => ({ s: c.s + late(i), e: c.e + late(i) }))), cues: ref.length }
}

export const PIECEWISE_SAMPLE = `{
  "candidate_only": true,
  "engine": {
    "name": "alass-cli",
    "version": "2.0.0"
  },
  "fps": {
    "ratio_label": "23.976/24",
    "scaling_factor": 0.999
  },
  "input_cue_count": 150,
  "mode": "piecewise",
  "parameters": {
    "fps_guessing": true,
    "interval_ms": 1,
    "speed_optimization": 1.0,
    "split_penalty": 7.0
  },
  "reference_cue_count": 150,
  "schema_version": 1,
  "score": 143.98084545624442,
  "shift_groups": [
    {
      "cue_count": 37,
      "delta_ms": -2906,
      "first_start_ms": 5000,
      "last_start_ms": 149432
    },
    {
      "cue_count": 38,
      "delta_ms": -2795,
      "first_start_ms": 153469,
      "last_start_ms": 301038
    },
    {
      "cue_count": 41,
      "delta_ms": -8640,
      "first_start_ms": 311075,
      "last_start_ms": 471655
    },
    {
      "cue_count": 34,
      "delta_ms": -8433,
      "first_start_ms": 475692,
      "last_start_ms": 607113
    }
  ],
  "warnings": []
}`

export const NO_SPLIT_SAMPLE = `{
  "candidate_only": true,
  "engine": {
    "name": "alass-cli",
    "version": "2.0.0"
  },
  "fps": {
    "ratio_label": "1",
    "scaling_factor": 1.0
  },
  "input_cue_count": 150,
  "mode": "no_split",
  "parameters": {
    "fps_guessing": true,
    "interval_ms": 1,
    "speed_optimization": 1.0,
    "split_penalty": 7.0
  },
  "reference_cue_count": 150,
  "schema_version": 1,
  "score": 149.9999657459557,
  "shift_groups": [
    {
      "cue_count": 150,
      "delta_ms": -3000,
      "first_start_ms": 5000,
      "last_start_ms": 601113
    }
  ],
  "warnings": []
}`

export const VAD_SAMPLE = `{
  "candidate_only": true,
  "engine": {
    "name": "alass-cli",
    "version": "2.0.0"
  },
  "fps": null,
  "mode": "vad_export",
  "reference_span_count": 150,
  "schema_version": 1,
  "score": null,
  "shift_groups": [],
  "warnings": []
}`

/** A marker that must never appear in a decoder error: errors name fields, not file contents. */
export const LEAK_MARKER = 'Line 7 SECRET dialogue'

type Json = Record<string, unknown>
const piecewise = (): Json => JSON.parse(PIECEWISE_SAMPLE) as Json
const vad = (): Json => JSON.parse(VAD_SAMPLE) as Json
const edit = (base: Json, f: (o: Json) => void): string => {
  f(base)
  return JSON.stringify(base, null, 2)
}

/** Each case: the report text, and the exact error (and field) the decoder must return. */
export function malformedReports(): { name: string; text: string | Uint8Array; error: string; field?: string }[] {
  return [
    { name: 'empty file', text: '', error: 'not_json' },
    { name: 'truncated mid-object', text: PIECEWISE_SAMPLE.slice(0, 200), error: 'not_json' },
    { name: 'not UTF-8', text: Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]), error: 'not_utf8' },
    { name: 'a byte-order mark', text: '\ufeff' + VAD_SAMPLE, error: 'not_json' },
    { name: 'an array', text: '[1, 2]', error: 'not_object' },
    { name: 'a string', text: JSON.stringify(LEAK_MARKER), error: 'not_object' },
    { name: 'schema version 2', text: edit(piecewise(), (o) => (o.schema_version = 2)), error: 'unknown_schema', field: 'schema_version' },
    { name: 'no schema version', text: edit(piecewise(), (o) => delete o.schema_version), error: 'unknown_schema', field: 'schema_version' },
    { name: 'schema version as text', text: edit(piecewise(), (o) => (o.schema_version = '1')), error: 'unknown_schema', field: 'schema_version' },
    { name: 'candidate_only false', text: edit(piecewise(), (o) => (o.candidate_only = false)), error: 'bad_field', field: 'candidate_only' },
    { name: 'candidate_only missing', text: edit(piecewise(), (o) => delete o.candidate_only), error: 'bad_field', field: 'candidate_only' },
    { name: 'an unknown mode', text: edit(piecewise(), (o) => (o.mode = LEAK_MARKER)), error: 'unknown_mode', field: 'mode' },
    { name: 'no mode', text: edit(piecewise(), (o) => delete o.mode), error: 'missing_field', field: 'mode' },
    { name: 'a verdict smuggled in', text: edit(piecewise(), (o) => (o.verdict = 'accept')), error: 'unknown_field', field: '(root)' },
    { name: 'preview eligibility smuggled in', text: edit(piecewise(), (o) => (o.preview_eligible = true)), error: 'unknown_field', field: '(root)' },
    { name: 'subtitle text smuggled in', text: edit(piecewise(), (o) => (o.text = LEAK_MARKER)), error: 'unknown_field', field: '(root)' },
    { name: 'subtitle text as a key', text: edit(piecewise(), (o) => (o[LEAK_MARKER] = 1)), error: 'unknown_field', field: '(root)' },
    { name: 'a __proto__ key', text: PIECEWISE_SAMPLE.replace('{', '{"__proto__": {"verdict": "accept"},'), error: 'unknown_field', field: '(root)' },
    { name: 'nesting a million deep', text: '['.repeat(1_000_000) + ']'.repeat(1_000_000), error: 'not_object' },
    { name: 'another engine', text: edit(piecewise(), (o) => ((o.engine as Json).version = '2.0.1')), error: 'unknown_engine', field: 'engine' },
    { name: 'engine with an extra field', text: edit(piecewise(), (o) => ((o.engine as Json).build = 'x')), error: 'unknown_field', field: 'engine' },
    { name: 'no input cue count', text: edit(piecewise(), (o) => delete o.input_cue_count), error: 'missing_field', field: 'input_cue_count' },
    { name: 'a fractional cue count', text: edit(piecewise(), (o) => (o.input_cue_count = 150.5)), error: 'bad_field', field: 'input_cue_count' },
    { name: 'a negative cue count', text: edit(piecewise(), (o) => (o.reference_cue_count = -1)), error: 'bad_field', field: 'reference_cue_count' },
    { name: 'a cue count over the limit', text: edit(piecewise(), (o) => (o.reference_cue_count = 1_000_001)), error: 'bad_field', field: 'reference_cue_count' },
    { name: 'interval 0', text: edit(piecewise(), (o) => ((o.parameters as Json).interval_ms = 0)), error: 'bad_field', field: 'parameters.interval_ms' },
    { name: 'split penalty as text', text: edit(piecewise(), (o) => ((o.parameters as Json).split_penalty = '7')), error: 'bad_field', field: 'parameters.split_penalty' },
    { name: 'fps guessing as a number', text: edit(piecewise(), (o) => ((o.parameters as Json).fps_guessing = 1)), error: 'bad_field', field: 'parameters.fps_guessing' },
    { name: 'parameters missing one', text: edit(piecewise(), (o) => delete (o.parameters as Json).speed_optimization), error: 'missing_field', field: 'parameters.speed_optimization' },
    { name: 'an unknown fps label', text: edit(piecewise(), (o) => ((o.fps as Json).ratio_label = '30/25')), error: 'bad_field', field: 'fps.ratio_label' },
    { name: 'an fps factor that is not its label', text: edit(piecewise(), (o) => ((o.fps as Json).scaling_factor = 1.0427)), error: 'inconsistent', field: 'fps' },
    { name: 'an fps ratio with guessing off', text: edit(piecewise(), (o) => ((o.parameters as Json).fps_guessing = false)), error: 'inconsistent', field: 'fps' },
    { name: 'fps null on an alignment', text: edit(piecewise(), (o) => (o.fps = null)), error: 'bad_field', field: 'fps' },
    { name: 'score as text', text: edit(piecewise(), (o) => (o.score = 'high')), error: 'bad_field', field: 'score' },
    { name: 'groups that cover 149 of 150 cues', text: edit(piecewise(), (o) => ((o.shift_groups as Json[])[0].cue_count = 36)), error: 'inconsistent', field: 'shift_groups' },
    { name: 'an empty group', text: edit(piecewise(), (o) => (o.shift_groups as Json[]).push({ cue_count: 0, delta_ms: 0, first_start_ms: 0, last_start_ms: 0 })), error: 'bad_field', field: 'shift_groups[].cue_count' },
    { name: 'a group that ends before it starts', text: edit(piecewise(), (o) => ((o.shift_groups as Json[])[1].last_start_ms = 1)), error: 'inconsistent', field: 'shift_groups[]' },
    { name: 'a group shift past SubRip range', text: edit(piecewise(), (o) => ((o.shift_groups as Json[])[2].delta_ms = -360_000_001)), error: 'bad_field', field: 'shift_groups[].delta_ms' },
    { name: 'a group with text', text: edit(piecewise(), (o) => ((o.shift_groups as Json[])[0].text = LEAK_MARKER)), error: 'unknown_field', field: 'shift_groups[]' },
    { name: 'shift groups as an object', text: edit(piecewise(), (o) => (o.shift_groups = {})), error: 'bad_field', field: 'shift_groups' },
    {
      name: 'no_split with two groups',
      text: edit(piecewise(), (o) => {
        o.mode = 'no_split'
        o.shift_groups = (o.shift_groups as Json[]).slice(0, 2)
        o.input_cue_count = 75
      }),
      error: 'inconsistent',
      field: 'shift_groups'
    },
    { name: 'a free-text warning', text: edit(piecewise(), (o) => (o.warnings = [LEAK_MARKER])), error: 'bad_field', field: 'warnings[]' },
    { name: 'a warning twice', text: edit(piecewise(), (o) => (o.warnings = ['some subtitles now have negative timings', 'some subtitles now have negative timings'])), error: 'inconsistent', field: 'warnings' },
    { name: 'an empty reference without its warning', text: edit(piecewise(), (o) => (o.reference_cue_count = 0)), error: 'inconsistent', field: 'warnings' },
    { name: 'the empty-input warning on a full input', text: edit(piecewise(), (o) => (o.warnings = ['file with incorrect subtitles has no lines'])), error: 'inconsistent', field: 'warnings' },
    { name: 'vad_export with a score', text: edit(vad(), (o) => (o.score = 1)), error: 'bad_field', field: 'score' },
    { name: 'vad_export with fps', text: edit(vad(), (o) => (o.fps = { ratio_label: '1', scaling_factor: 1 })), error: 'bad_field', field: 'fps' },
    { name: 'vad_export with a group', text: edit(vad(), (o) => (o.shift_groups = [{ cue_count: 1, delta_ms: 0, first_start_ms: 0, last_start_ms: 0 }])), error: 'bad_field', field: 'shift_groups' },
    { name: 'vad_export with alignment fields', text: edit(vad(), (o) => (o.input_cue_count = 3)), error: 'unknown_field', field: '(root)' },
    { name: 'vad_export without a span count', text: edit(vad(), (o) => delete o.reference_span_count), error: 'missing_field', field: 'reference_span_count' }
  ]
}
