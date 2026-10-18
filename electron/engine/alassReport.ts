/**
 * Decoder for the ALASS sidecar's `--json-report`, schema version 1
 * (`vendor/alass/2.0.0/report-schema-v1.json`; writer `vendor/alass/2.0.0/source/alass-cli/src/main.rs`).
 * AUTHORED-BY: opus-5.5-high
 *
 * Pure: bytes in, a decoded report or one error out. No file, process, clock or alignment code.
 *
 * A report is candidate evidence (implementation_plan.md §9.4b): it states what ALASS did, never
 * whether the result is usable. The decoded shape therefore has no verdict, reason or preview field,
 * and this module imports nothing that has one. Only `independent-align` over the transformed output
 * against the reference may decide (Bundle C item 7).
 *
 * Exact, not lenient: every field the writer emits must be present with its type and range, no other
 * field may appear, and the parts must agree with each other. An error names a schema location, never
 * a value or key from the file.
 */

export const ALASS_REPORT_SCHEMA_VERSION = 1
export const ALASS_ENGINE = Object.freeze({ name: 'alass-cli', version: '2.0.0' } as const)

/** Bounds a well-formed report sits far inside: a 2 000-cue film split at every cue is ~250 KiB. */
export const ALASS_REPORT_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxCount: 1_000_000,
  /** SubRip's largest time is 99:59:59,999. */
  maxAbsMs: 360_000_000,
  maxIntervalMs: 60_000
})

export const ALASS_WARNINGS = Object.freeze([
  'reference file has no subtitle lines',
  'file with incorrect subtitles has no lines',
  'some subtitles now have negative timings',
  'writing VobSub IDX can lead to unexpected results'
] as const)
export type AlassWarning = (typeof ALASS_WARNINGS)[number]

/** `main.rs` `desc` and `ratios`: reference FPS over input FPS. */
const FPS_RATIOS: Readonly<Record<string, number>> = Object.freeze({
  '1': 1,
  '25/24': 25 / 24,
  '25/23.976': 25 / 23.976,
  '24/25': 24 / 25,
  '24/23.976': 24 / 23.976,
  '23.976/25': 23.976 / 25,
  '23.976/24': 23.976 / 24
})
export type AlassFpsLabel = '1' | '25/24' | '25/23.976' | '24/25' | '24/23.976' | '23.976/25' | '23.976/24'

export interface AlassShiftGroup {
  cueCount: number
  deltaMs: number
  firstStartMs: number
  lastStartMs: number
}

interface AlassReportBase {
  schemaVersion: 1
  candidateOnly: true
  engine: { name: 'alass-cli'; version: '2.0.0' }
}

export interface AlassAlignmentReport extends AlassReportBase {
  mode: 'no_split' | 'piecewise'
  parameters: { intervalMs: number; splitPenalty: number; speedOptimization: number | null; fpsGuessing: boolean }
  fps: { ratioLabel: AlassFpsLabel; scalingFactor: number }
  /** ALASS's own objective. Diagnostic only; `null` when the writer had no finite value. */
  score: number | null
  referenceCueCount: number
  inputCueCount: number
  shiftGroups: AlassShiftGroup[]
  warnings: AlassWarning[]
}

export interface AlassVadReport extends AlassReportBase {
  mode: 'vad_export'
  referenceSpanCount: number
}

export type AlassReport = AlassAlignmentReport | AlassVadReport

export type AlassReportError =
  | 'oversize'
  | 'not_utf8'
  | 'not_json'
  | 'not_object'
  | 'unknown_schema'
  | 'unknown_engine'
  | 'unknown_mode'
  | 'missing_field'
  | 'unknown_field'
  | 'bad_field'
  | 'inconsistent'

export type AlassReportDecode = { ok: true; report: AlassReport } | { ok: false; error: AlassReportError; field?: string }

const ALIGNMENT_KEYS = ['candidate_only', 'engine', 'fps', 'input_cue_count', 'mode', 'parameters', 'reference_cue_count', 'schema_version', 'score', 'shift_groups', 'warnings']
const VAD_KEYS = ['candidate_only', 'engine', 'fps', 'mode', 'reference_span_count', 'schema_version', 'score', 'shift_groups', 'warnings']

class Refusal {
  constructor(
    readonly error: AlassReportError,
    readonly field?: string
  ) {}
}
const refuse = (error: AlassReportError, field?: string): never => {
  throw new Refusal(error, field)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/**
 * Exactly `keys`, each own and present; reports the first missing, then the first unexpected. An
 * unexpected key's name comes from the file, so it is never repeated: the error names where it is.
 */
function exactKeys(o: Record<string, unknown>, keys: readonly string[], at: string): void {
  for (const k of keys) if (!has(o, k)) refuse('missing_field', at ? `${at}.${k}` : k)
  for (const k of Object.keys(o)) if (!keys.includes(k)) refuse('unknown_field', at || '(root)')
}

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) refuse('bad_field', field)
  return v as number
}

function finite(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) refuse('bad_field', field)
  return v as number
}

function engine(v: unknown): AlassReportBase['engine'] {
  if (!isRecord(v)) return refuse('bad_field', 'engine')
  exactKeys(v, ['name', 'version'], 'engine')
  if (v.name !== ALASS_ENGINE.name || v.version !== ALASS_ENGINE.version) refuse('unknown_engine', 'engine')
  return { name: ALASS_ENGINE.name, version: ALASS_ENGINE.version }
}

function alignment(o: Record<string, unknown>, mode: 'no_split' | 'piecewise'): AlassAlignmentReport {
  const L = ALASS_REPORT_LIMITS
  exactKeys(o, ALIGNMENT_KEYS, '')

  const p = o.parameters
  if (!isRecord(p)) return refuse('bad_field', 'parameters')
  exactKeys(p, ['fps_guessing', 'interval_ms', 'speed_optimization', 'split_penalty'], 'parameters')
  const intervalMs = int(p.interval_ms, 'parameters.interval_ms', 1, L.maxIntervalMs)
  const splitPenalty = finite(p.split_penalty, 'parameters.split_penalty')
  const speedOptimization = p.speed_optimization === null ? null : finite(p.speed_optimization, 'parameters.speed_optimization')
  if (typeof p.fps_guessing !== 'boolean') refuse('bad_field', 'parameters.fps_guessing')
  const fpsGuessing = p.fps_guessing as boolean

  const f = o.fps
  if (!isRecord(f)) return refuse('bad_field', 'fps')
  exactKeys(f, ['ratio_label', 'scaling_factor'], 'fps')
  if (typeof f.ratio_label !== 'string' || !has(FPS_RATIOS, f.ratio_label)) refuse('bad_field', 'fps.ratio_label')
  const ratioLabel = f.ratio_label as AlassFpsLabel
  const scalingFactor = finite(f.scaling_factor, 'fps.scaling_factor')
  if (Math.abs(scalingFactor - FPS_RATIOS[ratioLabel]) > 1e-9) refuse('inconsistent', 'fps')
  if (!fpsGuessing && ratioLabel !== '1') refuse('inconsistent', 'fps')

  const score = o.score === null ? null : finite(o.score, 'score')
  const referenceCueCount = int(o.reference_cue_count, 'reference_cue_count', 0, L.maxCount)
  const inputCueCount = int(o.input_cue_count, 'input_cue_count', 0, L.maxCount)

  if (!Array.isArray(o.shift_groups)) return refuse('bad_field', 'shift_groups')
  if (o.shift_groups.length > inputCueCount) refuse('inconsistent', 'shift_groups')
  let covered = 0
  const shiftGroups = o.shift_groups.map((g): AlassShiftGroup => {
    if (!isRecord(g)) return refuse('bad_field', 'shift_groups[]')
    exactKeys(g, ['cue_count', 'delta_ms', 'first_start_ms', 'last_start_ms'], 'shift_groups[]')
    const cueCount = int(g.cue_count, 'shift_groups[].cue_count', 1, L.maxCount)
    const deltaMs = int(g.delta_ms, 'shift_groups[].delta_ms', -L.maxAbsMs, L.maxAbsMs)
    const firstStartMs = int(g.first_start_ms, 'shift_groups[].first_start_ms', -L.maxAbsMs, L.maxAbsMs)
    const lastStartMs = int(g.last_start_ms, 'shift_groups[].last_start_ms', -L.maxAbsMs, L.maxAbsMs)
    if (lastStartMs < firstStartMs) refuse('inconsistent', 'shift_groups[]')
    covered += cueCount
    return { cueCount, deltaMs, firstStartMs, lastStartMs }
  })
  if (covered !== inputCueCount) refuse('inconsistent', 'shift_groups')
  if (mode === 'no_split' && shiftGroups.length > 1) refuse('inconsistent', 'shift_groups')

  if (!Array.isArray(o.warnings)) return refuse('bad_field', 'warnings')
  const warnings = o.warnings.map((w): AlassWarning => {
    if (typeof w !== 'string' || !(ALASS_WARNINGS as readonly string[]).includes(w)) refuse('bad_field', 'warnings[]')
    return w as AlassWarning
  })
  if (new Set(warnings).size !== warnings.length) refuse('inconsistent', 'warnings')
  if ((referenceCueCount === 0) !== warnings.includes('reference file has no subtitle lines')) refuse('inconsistent', 'warnings')
  if ((inputCueCount === 0) !== warnings.includes('file with incorrect subtitles has no lines')) refuse('inconsistent', 'warnings')

  return {
    schemaVersion: 1,
    candidateOnly: true,
    engine: engine(o.engine),
    mode,
    parameters: { intervalMs, splitPenalty, speedOptimization, fpsGuessing },
    fps: { ratioLabel, scalingFactor },
    score,
    referenceCueCount,
    inputCueCount,
    shiftGroups,
    warnings
  }
}

function vad(o: Record<string, unknown>): AlassVadReport {
  exactKeys(o, VAD_KEYS, '')
  if (o.score !== null) refuse('bad_field', 'score')
  if (o.fps !== null) refuse('bad_field', 'fps')
  if (!Array.isArray(o.shift_groups) || o.shift_groups.length !== 0) refuse('bad_field', 'shift_groups')
  if (!Array.isArray(o.warnings) || o.warnings.length !== 0) refuse('bad_field', 'warnings')
  return {
    schemaVersion: 1,
    candidateOnly: true,
    engine: engine(o.engine),
    mode: 'vad_export',
    referenceSpanCount: int(o.reference_span_count, 'reference_span_count', 0, ALASS_REPORT_LIMITS.maxCount)
  }
}

/** Decode one report file's bytes. Never throws. */
export function decodeAlassReport(bytes: Uint8Array): AlassReportDecode {
  try {
    if (bytes.byteLength > ALASS_REPORT_LIMITS.maxBytes) return { ok: false, error: 'oversize' }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return { ok: false, error: 'not_utf8' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, error: 'not_json' }
    }
    if (!isRecord(parsed)) return { ok: false, error: 'not_object' }
    if (!has(parsed, 'schema_version') || parsed.schema_version !== ALASS_REPORT_SCHEMA_VERSION) return { ok: false, error: 'unknown_schema', field: 'schema_version' }
    if (!has(parsed, 'candidate_only') || parsed.candidate_only !== true) return { ok: false, error: 'bad_field', field: 'candidate_only' }
    const mode = parsed.mode
    if (mode === 'no_split' || mode === 'piecewise') return { ok: true, report: alignment(parsed, mode) }
    if (mode === 'vad_export') return { ok: true, report: vad(parsed) }
    return { ok: false, error: has(parsed, 'mode') ? 'unknown_mode' : 'missing_field', field: 'mode' }
  } catch (e) {
    if (e instanceof Refusal) return e.field ? { ok: false, error: e.error, field: e.field } : { ok: false, error: e.error }
    return { ok: false, error: 'bad_field' }
  }
}
