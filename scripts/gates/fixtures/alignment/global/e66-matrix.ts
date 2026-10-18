/**
 * The E66 global/different-cut matrix as committed, non-private fixtures (implementation_plan.md
 * §9.4b "Required implementation and release gates"; ledger E66; `alass_evaluation.md` §17).
 *
 * Two families, both synthetic and labelled before any aligner runs:
 *   - `selfTestCases()` is the private research mirror's own self-test, ported value for value
 *     (its cadence, transforms, drops and extras).
 *   - `corpusAnalog()` rebuilds each of the 20 E66 corpus rows (`.secrets/ALASS/detector-final/
 *     detector_fixture_manifest.json`, SHA-256 2e9f8327…bedb) on a seeded 736-cue timeline instead of
 *     the held film's, so the class of every row is reproducible without its timing leaving `.secrets/`.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import { asCues, keepEvenly, retimed, speech, type PlainCue } from './fixtures'
import type { Cue } from '../../../../../electron/engine/srt'

export type MatrixClass = 'global_control' | 'wrong_title_control' | 'piecewise_positive' | 'generic'

export interface MatrixCase {
  name: string
  fixtureClass: MatrixClass
  source: Cue[]
  reference: Cue[]
  expectVerdict?: 'accept' | 'check' | 'refuse'
  expectReason?: string
}

const ms = (minute: number, second: number): number => (minute * 60 + second) * 1000

/** `_synthetic_base`: 1.6 s cues on a deterministic, non-repeating 3.2–5.1 s cadence from 00:10. */
function syntheticBase(count = 120, irregular = true): PlainCue[] {
  const out: PlainCue[] = []
  let t = ms(0, 10)
  for (let i = 1; i <= count; i += 1) {
    out.push({ start: t, end: t + 1600 + (i % 5) * 40, text: `Dialogue line ${i} with enough letters.` })
    t += irregular ? 3200 + ((i * 7919 + i * i * 37 + i * i * i * 3) % 1900) : 4000
  }
  return out
}

/** Python's `round` for the transform: nearest, exact halves to even. */
function pyRound(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** `_transform_cues`: one global map, plus a cumulative step from each `[boundaryMs, stepMs]` on. */
function transform(cues: readonly PlainCue[], o: { scale?: number; offsetMs?: number; piecewise?: [number, number][] } = {}): PlainCue[] {
  const scale = o.scale ?? 1
  const offset = o.offsetMs ?? 0
  const steps = [...(o.piecewise ?? [])].sort((a, b) => a[0] - b[0])
  return cues.map((c) => {
    let extra = 0
    for (const [boundary, step] of steps) if (c.start >= boundary) extra = step
    return { ...c, start: pyRound(c.start * scale + offset + extra), end: pyRound(c.end * scale + offset + extra) }
  })
}

/** `_drop_every`: remove each `step`-th cue (1-based). */
function dropEvery(cues: readonly PlainCue[], step: number): PlainCue[] {
  return cues.filter((_, i) => (i + 1) % step !== 0)
}

/** `_add_extras`: a 350 ms extra line at the middle of each `step`-th cue at least 400 ms long. */
function addExtras(cues: readonly PlainCue[], step: number): PlainCue[] {
  const out: PlainCue[] = []
  let extra = 0
  cues.forEach((c, i) => {
    out.push({ ...c })
    if ((i + 1) % step === 0 && c.end - c.start >= 400) {
      extra += 1
      const mid = Math.floor((c.start + c.end) / 2)
      out.push({ start: mid, end: mid + 350, text: `Extra dialogue cue ${extra} long enough.` })
    }
  })
  return out
}

/** Each `step`-th cue split in two halves, as a re-segmented release would carry it. */
function splitEvery(cues: readonly PlainCue[], step: number): PlainCue[] {
  return cues.flatMap((c, i) => {
    if ((i + 1) % step !== 0) return [c]
    const mid = Math.floor((c.start + c.end) / 2)
    return [
      { start: c.start, end: mid, text: `${c.text} first half` },
      { start: mid + 1, end: c.end, text: `${c.text} second half` }
    ]
  })
}

function relabel(cues: readonly PlainCue[], label: string): PlainCue[] {
  return cues.map((c, i) => ({ ...c, text: `${label} ${i + 1} answers.` }))
}

/** The research mirror's eleven self-test cases (`align_detector.py:1449-1548`). */
export function selfTestCases(): MatrixCase[] {
  const base = syntheticBase()
  const long = syntheticBase(1500)
  const wrong: PlainCue[] = Array.from({ length: 120 }, (_, k) => {
    const i = k + 1
    const start = ms(2, 0) + i * 5113 + ((i * 173) % 900)
    return { start, end: start + 1500, text: `Unrelated dialogue line ${i} here.` }
  })
  const c = (name: string, fixtureClass: MatrixClass, s: PlainCue[], r: PlainCue[], e: Partial<MatrixCase> = {}): MatrixCase => ({
    name,
    fixtureClass,
    source: asCues(s),
    reference: asCues(r),
    ...e
  })
  return [
    c('global_offset_5000ms', 'global_control', base, transform(base, { offsetMs: 5000 }), { expectVerdict: 'accept' }),
    c('arbitrary_scale_1_04', 'global_control', base, transform(base, { scale: 1.04, offsetMs: 1200 }), { expectVerdict: 'accept' }),
    c('feature_length_scale_1_03', 'global_control', long, transform(long, { scale: 1.03, offsetMs: 800 }), { expectVerdict: 'accept' }),
    c('one_gap_60000ms', 'piecewise_positive', base, transform(base, { piecewise: [[ms(4, 0), 60_000]] }), { expectReason: 'likely_different_cut' }),
    c('two_gap_45000_30000ms', 'piecewise_positive', base, transform(base, { piecewise: [[ms(3, 0), 45_000], [ms(6, 0), 75_000]] }), {
      expectReason: 'likely_different_cut'
    }),
    c('wrong_title_shuffle', 'wrong_title_control', base, wrong, { expectReason: 'weak_correspondence' }),
    c('seven_cue_insufficient', 'generic', syntheticBase(7), syntheticBase(7), { expectReason: 'insufficient' }),
    c('identity_no_movement', 'global_control', base.slice(0, 40), base.slice(0, 40), { expectVerdict: 'accept' }),
    c('missing_every_5th', 'global_control', base, transform(dropEvery(base, 5), { offsetMs: 5000 }), { expectVerdict: 'check' }),
    c('extra_every_8th', 'global_control', base, transform(addExtras(base, 8), { offsetMs: 5000 }), { expectVerdict: 'accept' }),
    c(
      'segmented_plus_gap',
      'generic',
      long,
      transform(addExtras(dropEvery(long, 11), 13), { scale: 1.01, offsetMs: 2000, piecewise: [[ms(45, 0), 90_000]] }),
      { expectVerdict: 'refuse', expectReason: 'likely_different_cut' }
    )
  ]
}

/** 25/23.976, as the corpus row `fps_25_over_23976` planted it. */
const FPS_25_OVER_23976 = 25 / (24000 / 1001)

/**
 * The 20 corpus rows rebuilt on a seeded 736-cue timeline. Row names, classes and expected labels are
 * the manifest's; every cut is at the same fraction of the film the manifest's provenance names.
 */
export function corpusAnalog(): MatrixCase[] {
  const base = speech(736, 7361, 'Line')
  const at = (fraction: number): number => base[Math.floor(base.length * fraction)].start
  const ref = (cues: PlainCue[]): PlainCue[] => relabel(cues, 'Reference line')
  const c = (name: string, fixtureClass: MatrixClass, s: PlainCue[], r: PlainCue[], e: Partial<MatrixCase> = {}): MatrixCase => ({
    name,
    fixtureClass,
    source: asCues(s),
    reference: asCues(r),
    ...e
  })
  const zeroSixth = base.map((q, i) => (i === 5 ? { ...q, end: q.start } : q))
  return [
    c('already_aligned', 'global_control', base, ref(base), { expectVerdict: 'accept' }),
    c('global_offset_5000ms', 'global_control', base, ref(transform(base, { offsetMs: 5000 })), { expectVerdict: 'accept' }),
    c('fps_25_over_23976', 'global_control', base, ref(transform(base, { scale: FPS_25_OVER_23976 })), { expectVerdict: 'accept' }),
    c('arbitrary_global_scale_1_03', 'global_control', base, ref(transform(base, { scale: 1.03, offsetMs: 1500 })), { expectVerdict: 'accept' }),
    c('missing_every_7_plus_offset', 'global_control', base, ref(transform(dropEvery(base, 7), { offsetMs: 5000 })), { expectVerdict: 'accept' }),
    c('extra_every_40_plus_offset', 'global_control', base, ref(transform(addExtras(base, 40), { offsetMs: 5000 })), { expectVerdict: 'accept' }),
    c('segmentation_only_plus_offset', 'global_control', base, ref(transform(splitEvery(base, 10), { offsetMs: 5000 }))),
    c('sparse_global_offset', 'global_control', base, ref(transform(keepEvenly(base, Math.floor(base.length / 50)), { offsetMs: 5000 }))),
    c('eight_cue_global_offset', 'global_control', base.slice(0, 8), ref(transform(base.slice(0, 8), { offsetMs: 5000 }))),
    c('seven_cue_boundary', 'global_control', base.slice(0, 7), ref(transform(base.slice(0, 7), { offsetMs: 5000 })), { expectReason: 'insufficient' }),
    c('wrong_title_same_density', 'wrong_title_control', base, retimed(speech(736, 9361, 'Unrelated line', 7000), 1, 0, 'Unrelated reference'), {
      expectVerdict: 'refuse'
    }),
    c('malformed_nonpositive', 'global_control', zeroSixth, ref(transform(base, { offsetMs: 5000 })), { expectReason: 'malformed' }),
    c('different_cut_one_gap_60000ms_E63f', 'piecewise_positive', base, ref(transform(base, { piecewise: [[at(0.5), 60_000]] })), {
      expectReason: 'likely_different_cut'
    }),
    c('different_cut_two_gaps', 'piecewise_positive', base, ref(transform(base, { piecewise: [[at(1 / 3), 30_000], [at(2 / 3), 75_000]] })), {
      expectReason: 'likely_different_cut'
    }),
    c(
      'different_cut_fps_plus_gap',
      'piecewise_positive',
      base,
      ref(transform(base, { scale: FPS_25_OVER_23976, piecewise: [[at(0.5), 45_000]] })),
      { expectReason: 'likely_different_cut' }
    ),
    c(
      'different_cut_segmented',
      'piecewise_positive',
      base,
      ref(transform(splitEvery(base, 10), { offsetMs: 2000, piecewise: [[at(0.5), 60_000]] })),
      { expectReason: 'likely_different_cut' }
    ),
    c('different_cut_small_5000ms', 'piecewise_positive', base, ref(transform(base, { piecewise: [[at(0.5), 5000]] })), {
      expectReason: 'likely_different_cut'
    }),
    c('different_cut_early_edge', 'piecewise_positive', base, ref(transform(base, { piecewise: [[at(0.1), 5000]] })), {
      expectReason: 'likely_different_cut'
    }),
    c('different_cut_late_edge', 'piecewise_positive', base, ref(transform(base, { piecewise: [[at(0.9), 5000]] })), {
      expectReason: 'likely_different_cut'
    }),
    c(
      'different_cut_multiple_small',
      'piecewise_positive',
      base,
      ref(transform(base, { piecewise: [[at(0.25), 3000], [at(0.5), 7000], [at(0.75), 12_000]] })),
      { expectReason: 'likely_different_cut' }
    )
  ]
}
