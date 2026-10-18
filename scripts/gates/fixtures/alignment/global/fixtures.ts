/**
 * Alignment global fixtures (implementation_plan.md §17.4, Bundle B). Synthetic and deterministic:
 * every timeline comes from a seeded generator and every line is an author-written label, so no
 * subtitle text enters git (handoff.md §24, tester decision 2026-10-06). The ground truth of each
 * fixture is the transform that built it, never something an aligner reported.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import type { Cue } from '../../../../../electron/engine/srt'

export interface PlainCue {
  start: number
  end: number
  text: string
}

export interface AlignmentFixture {
  name: string
  purpose: string
  source: Cue[]
  reference: Cue[]
  /** The map that built the reference from the source: `t_ref = scale * t_src + offsetMs`. */
  truth?: { scale: number; offsetMs: number }
}

/** mulberry32: a small seeded generator, so a fixture is the same on every machine and run. */
function generator(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Speech-like cadence: 3.2–5.1 s between starts, 1.2–2.6 s on screen, never touching. */
export function speech(count: number, seed: number, label: string, firstMs = 10_000): PlainCue[] {
  const next = generator(seed)
  const out: PlainCue[] = []
  let t = firstMs
  for (let i = 1; i <= count; i += 1) {
    const duration = 1200 + Math.floor(next() * 1400)
    out.push({ start: t, end: t + duration, text: `${label} ${i} is spoken here.` })
    t += 3200 + Math.floor(next() * 1900)
  }
  return out
}

/** The same lines on another release's clock, each start/end moved by up to ±`jitterMs`. */
export function retimed(cues: readonly PlainCue[], scale: number, offsetMs: number, label: string, jitterMs = 0, seed = 1): PlainCue[] {
  const next = generator(seed)
  return cues.map((c, i) => {
    const j = jitterMs ? Math.round((next() * 2 - 1) * jitterMs) : 0
    return {
      start: Math.round(scale * c.start + offsetMs) + j,
      end: Math.round(scale * c.end + offsetMs) + j,
      text: `${label} ${i + 1} answers.`
    }
  })
}

/** Exactly `keep` of the cues, spread evenly through the file. */
export function keepEvenly<T>(cues: readonly T[], keep: number): T[] {
  const n = cues.length
  return cues.filter((_, i) => Math.floor(((i + 1) * keep) / n) > Math.floor((i * keep) / n))
}

const NON_DIALOGUE = ['♪ Soft humming ♪', '[Door slams]', '(Sighs)', '<i>[Thunder]</i>', '# La la la #']

/** A non-dialogue cue (music, sound effect, bracketed) in the gap after every `every`-th cue. */
export function withNonDialogue(cues: readonly PlainCue[], every: number): PlainCue[] {
  const out: PlainCue[] = []
  cues.forEach((c, i) => {
    out.push(c)
    const next = cues[i + 1]
    if ((i + 1) % every === 0 && next && next.start - c.end >= 900) {
      const mid = Math.floor((c.end + next.start) / 2)
      out.push({ start: mid - 300, end: mid + 300, text: NON_DIALOGUE[Math.floor(i / every) % NON_DIALOGUE.length] })
    }
  })
  return out
}

/** Numbered 1..N in time order, as `parseCues` hands them to every caller. */
export function asCues(cues: readonly PlainCue[]): Cue[] {
  return [...cues].sort((a, b) => a.start - b.start).map((c, i) => ({ index: i + 1, startMs: c.start, endMs: c.end, text: c.text }))
}

/** 25 fps from 23.976 (PAL speed-up), as Kodi's discrete scale list rounds it. */
export const PAL_FROM_FILM = 1.042708

/** Bundle B.1 — the oracle profile's fixtures (implementation_plan.md §17.4 B.0 names: 7v8). */
export function oracleFixtures(): AlignmentFixture[] {
  const seven = withNonDialogue(speech(7, 701, 'Line'), 2)
  const eight = withNonDialogue(speech(8, 801, 'Line'), 2)
  const thirty = speech(30, 3001, 'Line')
  const film = speech(250, 2501, 'Line')
  const partialSource = speech(200, 2001, 'Line')
  return [
    {
      name: 'seven-cue-source',
      purpose: '7 dialogue cues (plus music/sound cues) against 30: too few on the source side',
      source: asCues(seven),
      reference: asCues(retimed(thirty, 1, 1500, 'Reference line'))
    },
    {
      name: 'seven-cue-reference',
      purpose: '30 dialogue cues against 7 (plus music/sound cues): too few on the reference side',
      source: asCues(thirty),
      reference: asCues(withNonDialogue(retimed(speech(7, 702, 'Line'), 1, 1500, 'Reference line'), 2))
    },
    {
      name: 'eight-cue-pair',
      purpose: 'exactly 8 dialogue cues each side (plus music/sound cues): proceeds to the estimator',
      source: asCues(eight),
      reference: asCues(withNonDialogue(retimed(speech(8, 801, 'Line'), 1, 1500, 'Reference line'), 2)),
      truth: { scale: 1, offsetMs: 1500 }
    },
    {
      name: 'histogram-tie',
      purpose: 'shifts alternate 2240/2260 ms, splitting the votes evenly across two buckets: Kodi takes the first peak it saw',
      source: asCues(speech(12, 1201, 'Line')),
      reference: asCues(
        speech(12, 1201, 'Line').map((c, i) => {
          const shift = i % 2 ? 2260 : 2240
          return { start: c.start + shift, end: c.end + shift, text: `Reference line ${i + 1} answers.` }
        })
      ),
      truth: { scale: 1, offsetMs: 2250 }
    },
    {
      name: 'fps-offset',
      purpose: '250 cues, PAL speed-up plus 2.34 s, ±40 ms timing noise, sound cues both sides: gate OK',
      source: asCues(withNonDialogue(film, 9)),
      reference: asCues(withNonDialogue(retimed(film, PAL_FROM_FILM, 2340, 'Reference line', 40, 11), 13)),
      truth: { scale: PAL_FROM_FILM, offsetMs: 2340 }
    },
    {
      name: 'partial-70',
      purpose: 'only 70% of the source has a counterpart: §2.3 keeps this band as a usable oracle',
      source: asCues(partialSource),
      reference: asCues(keepEvenly(retimed(partialSource, 1, -3250, 'Reference line', 40, 12), 140)),
      truth: { scale: 1, offsetMs: -3250 }
    },
    {
      name: 'wrong-title',
      purpose: 'an unrelated film of the same density: no correspondence, gate FAILED',
      source: asCues(speech(200, 2001, 'Line')),
      reference: asCues(speech(200, 9001, 'Unrelated line', 7000))
    }
  ]
}

/** The same cues with every dialogue line written as `line`; music and sound cues are left as they are. */
function inScript(cues: readonly PlainCue[], line: string): PlainCue[] {
  return cues.map((c) => (NON_DIALOGUE.includes(c.text) ? c : { ...c, text: line }))
}

/** `eight-cue-pair`'s timelines (music and sound cues included) with the dialogue in other scripts. */
function scriptFixture(name: string, sourceLine: string, referenceLine: string, scripts: string): AlignmentFixture {
  return {
    name,
    purpose: `eight-cue-pair's timing with ${scripts} dialogue: Kodi's letter ranges see no dialogue, Unicode letters see all 8`,
    source: asCues(inScript(withNonDialogue(speech(8, 801, 'Line'), 2), sourceLine)),
    reference: asCues(inScript(withNonDialogue(retimed(speech(8, 801, 'Line'), 1, 1500, 'Reference line'), 2), referenceLine)),
    truth: { scale: 1, offsetMs: 1500 }
  }
}

/** Short cues at random times across `[fromMs, toMs)`: a reference with no cadence in common. */
function scattered(count: number, seed: number, fromMs: number, toMs: number, label: string): PlainCue[] {
  const next = generator(seed)
  const starts = Array.from({ length: count }, () => fromMs + Math.floor(next() * (toMs - fromMs)))
  return starts.sort((a, b) => a - b).map((start, i) => ({ start, end: start + 700, text: `${label} ${i + 1} answers.` }))
}

/** The four coverage boundaries: 200 source lines, the reference keeping exactly `keep` of them. */
function coverageFixture(keep: number): AlignmentFixture {
  const source = speech(200, 6001, 'Line')
  return {
    name: `coverage-${(keep / 2).toFixed(1)}`,
    purpose: `${keep} of 200 source lines have a counterpart: retained coverage is exactly ${(keep / 2).toFixed(1)}%`,
    source: asCues(source),
    reference: asCues(keepEvenly(retimed(source, 1, -3250, 'Reference line', 40, 61), keep)),
    truth: { scale: 1, offsetMs: -3250 }
  }
}

/**
 * Bundle B.2 — the independent-align profile's fixtures (§17.4 B.0 names: outlier, 60/85-percent,
 * wrong-title). `outliers-planted` is §4.1a's gate: a credit block at the head and narration at the
 * tail, each a consistent 220–230 ms off the true map (inside the 250 ms pairing window, so only the
 * refit can reject them), duplicated timings on both sides, and ±40 ms noise on the true pairs.
 */
export function independentFixtures(): AlignmentFixture[] {
  const truth = { scale: PAL_FROM_FILM, offsetMs: 2340 }
  const at = (t: number): number => Math.round(truth.scale * t + truth.offsetMs)
  const body = speech(240, 7001, 'Line', 60_000)
  const bodyRef = retimed(body, truth.scale, truth.offsetMs, 'Reference line', 40, 71)
  const credits = Array.from({ length: 10 }, (_, i) => ({ start: 10_000 + i * 4500, end: 11_500 + i * 4500 }))
  const tailFrom = body[body.length - 1].end + 4000
  const narration = Array.from({ length: 10 }, (_, i) => ({ start: tailFrom + i * 4500, end: tailFrom + 1500 + i * 4500 }))
  const outlierSource: PlainCue[] = [
    ...credits.map((c, i) => ({ ...c, text: `Opening credit ${i + 1} names the crew.` })),
    ...narration.map((c, i) => ({ ...c, text: `Narrator line ${i + 1} closes the story.` })),
    ...body.slice(99, 105).map((c, i) => ({ ...c, text: `Overlapping voice ${i + 1} talks at once.` }))
  ]
  const outlierRef: PlainCue[] = [
    ...credits.map((c, i) => ({ start: at(c.start) - 220, end: at(c.end) - 220, text: `Reference credit ${i + 1} answers.` })),
    ...narration.map((c, i) => ({ start: at(c.start) + 230, end: at(c.end) + 230, text: `Reference narrator ${i + 1} answers.` })),
    ...bodyRef.slice(149, 155).map((c, i) => ({ ...c, text: `Reference echo ${i + 1} answers.` }))
  ]
  const dense = speech(200, 6001, 'Line')
  const mixed = speech(30, 3001, 'Line')
  return [
    coverageFixture(170),
    coverageFixture(169),
    coverageFixture(120),
    coverageFixture(119),
    {
      name: 'outliers-planted',
      purpose: 'PAL speed-up plus 2.34 s; head credits −220 ms, tail narration +230 ms, duplicated timings both sides',
      source: asCues([...body, ...outlierSource]),
      reference: asCues([...bodyRef, ...outlierRef]),
      truth
    },
    {
      name: 'wrong-title-sparse',
      purpose: 'an unrelated reference of 60 short cues: random-level vote and overlap below 60% coverage',
      source: asCues(dense),
      reference: asCues(scattered(60, 6101, 10_000, 850_000, 'Unrelated line'))
    },
    {
      name: 'wrong-title-dense',
      purpose: 'an unrelated film of the same density: vote and overlap above the random band, coverage below 60%',
      source: asCues(dense),
      reference: asCues(speech(200, 9101, 'Unrelated line', 7000))
    },
    scriptFixture('script-kana-han', 'こんにちは', '你好', 'Japanese kana / Chinese Han'),
    scriptFixture('script-hangul-thai', '안녕하세요', 'สวัสดี', 'Korean Hangul / Thai'),
    {
      name: 'script-mixed',
      purpose: '30 lines, every 5th in kana, against a Latin reference: the oracle hints only the 24 Kodi reads; independent-align pairs all 30',
      source: asCues(mixed.map((c, i) => ((i + 1) % 5 === 0 ? { ...c, text: 'こんにちは' } : c))),
      reference: asCues(retimed(mixed, 1, 1500, 'Reference line')),
      truth: { scale: 1, offsetMs: 1500 }
    }
  ]
}
