/**
 * Read-with-repair fixtures (Round 8A FE.3, `implementation_plan.md` §9.4c R5). Every cue is synthetic
 * ("Words N is spoken here." from `speech`); nothing private enters git.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import type { Cue } from '../../../../../electron/engine/srt'
import { asCues, retimed, speech } from '../global/fixtures'
import { alignmentAudio, FALLBACK_SOURCE, FALLBACK_TRUTH } from '../fallback/fixtures'

/** A 40-line film on its own clock, the clean original the faults are planted in. */
export function repairFilm(): Cue[] {
  return asCues(speech(40, 7301, 'Words'))
}

/** File positions (0-based) of RP2's three faults. */
export const RP2_FAULTS = Object.freeze({ order: 11, zero: 19, reversed: 29 })

/**
 * RP2's source: line 12 starts 0.5 s before line 11 (`order`), line 20 is zero-length and line 30 ends
 * 0.4 s before it starts (`duration`). Three of 40, within the budget of 4.
 */
export function withRepairableFaults(cues: readonly Cue[]): Cue[] {
  return cues.map((c, i) => {
    if (i === RP2_FAULTS.order) {
      const start = cues[i - 1].startMs - 500
      return { ...c, startMs: start, endMs: start + (c.endMs - c.startMs) }
    }
    if (i === RP2_FAULTS.zero) return { ...c, endMs: c.startMs }
    if (i === RP2_FAULTS.reversed) return { ...c, endMs: c.startMs - 400 }
    return c
  })
}

/**
 * E158 (RP2c/RP2d): `speech(40, 8000 + seed)` films. At 23.976/25 with a 2500 ms offset, the locked
 * +1 ms view of RP2's faults refused `invariant_failure` on these seeds and the +2 ms view accepts
 * (`fixes_and_enhancements_evidence/repair-rounding-arms.txt`). `adjacent`: the line after the
 * zero-length one starts 1 ms after it, so the +2 ms view line overlaps its neighbour.
 */
export const ROUNDING_SEEDS = Object.freeze({
  global: [12, 20, 57, 63, 80, 82, 92, 101, 151, 159],
  advanced: 29,
  adjacentGlobal: 15,
  adjacentAdvanced: 29
})

export function roundingFilm(seed: number, adjacent = false): Cue[] {
  const film = asCues(speech(40, 8000 + seed, 'Words'))
  const z = RP2_FAULTS.zero
  if (!adjacent) return film
  return film.map((c, i) => (i === z + 1 ? { ...c, startMs: film[z].startMs + 1, endMs: film[z].startMs + 1 + (c.endMs - c.startMs) } : c))
}

/** The film's lines where a reference has them: `scale · t + offsetMs`, no jitter, its own text. */
export function referenceFor(cues: readonly Cue[], scale: number, offsetMs: number): Cue[] {
  return asCues(retimed(cues.map((c) => ({ start: c.startMs, end: c.endMs, text: c.text })), scale, offsetMs, 'Heard', 0, 1))
}

/** Plain SubRip text for constructed cues, which may carry faults `serializeCues` would refuse. */
export function srtText(cues: readonly Cue[], eol = '\n'): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp = (t: number): string => `${p(Math.floor(t / 3_600_000))}:${p(Math.floor(t / 60_000) % 60)}:${p(Math.floor(t / 1000) % 60)},${p(t % 1000, 3)}`
  return cues.map((c) => `${c.index}${eol}${stamp(c.startMs)} --> ${stamp(c.endMs)}${eol}${c.text.split('\n').join(eol)}${eol}`).join(eol)
}

/**
 * RP10, the Japanese loud stretch's shape (brief §3.9.1), synthesised: a GST-shaped transcript of the
 * fallback film as the source (whole-second boundaries, every third start 0.5–2 s early), few lines over a
 * loud stretch where the detector fires a span every 450 ms, and one line jumping back 22 s. Probed
 * 2026-10-09: as-is with no jump, as a plain sorted copy and as the repaired view, every one refuses.
 */
export function japaneseShape(): { source: Cue[]; jumpedAt: number; audio: ReturnType<typeof alignmentAudio> } {
  const lo = 90
  const hi = 170
  const onFilm = retimed(FALLBACK_SOURCE, FALLBACK_TRUTH.scale, FALLBACK_TRUTH.offsetMs, 'Spoken', 40, 811)
  const kept = onFilm.filter((_, i) => i < lo || i >= hi || (i - lo) % 6 === 0)
  const gst = kept.map((c, i) => {
    const lead = i % 3 === 0 ? 500 + ((i * 377) % 1500) : 0
    const start = Math.floor((c.start - lead) / 1000) * 1000
    return { index: i + 1, startMs: start, endMs: start + 1000 + (Math.ceil((c.end - c.start) / 1000) - 1) * 1000, text: c.text }
  })
  const jumpedAt = Math.round(gst.length * 0.45)
  const source = gst.map((c, i) => (i === jumpedAt ? { ...c, startMs: c.startMs - 22_000, endMs: c.endMs - 22_000 } : c))
  const a = onFilm[lo].start
  const b = onFilm[hi - 1].end
  const spans = onFilm.filter((c) => c.end <= a || c.start >= b).map((c) => ({ start: c.start, end: c.end }))
  for (let t = a; t < b; t += 450) spans.push({ start: t, end: t + 300 })
  spans.sort((x, y) => x.start - y.start)
  return { source, jumpedAt, audio: alignmentAudio(spans) }
}

/**
 * RP11's service case: a 40-line film whose first line ends 0.8 s before it starts, against a reference
 * 1.1 s earlier. The view is fine; the written first line keeps its −0.8 s and would end before 0:00,
 * which SubRip cannot hold, so check W refuses it (`written:time:1`).
 */
export function reversedFirst(): { film: Cue[]; source: Cue[]; reference: Cue[] } {
  const film = asCues(speech(40, 7303, 'Words', 1200))
  const source = film.map((c, i) => (i === 0 ? { ...c, endMs: c.startMs - 800 } : c))
  return { film, source, reference: referenceFor(film, 1, -film[0].startMs + 100) }
}
