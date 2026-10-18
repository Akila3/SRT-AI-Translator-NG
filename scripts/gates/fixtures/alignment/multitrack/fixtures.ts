/**
 * Bundle M multitrack fixtures (implementation_plan.md §16.0.3, §16.0.7 M-C…M-G): several embedded text
 * tracks of one film. Every timeline comes from the seeded generators in `../global/fixtures` and every
 * line is an author-written label, so no subtitle text enters git. Each track's truth is the transform
 * that built it.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import type { Cue } from '../../../../../electron/engine/srt'
import { asCues, keepEvenly, PAL_FROM_FILM, retimed, speech, type PlainCue } from '../global/fixtures'

/** The subtitle being aligned: 200 lines on the wrong clock. */
export const MT_SOURCE: PlainCue[] = speech(200, 6001, 'Line')
/** Where this film's speech is: the source's lines moved by this map. */
export const MT_TRUTH = { scale: PAL_FROM_FILM, offsetMs: 2340 }

export function mtSource(): Cue[] {
  return asCues(MT_SOURCE)
}

/**
 * One release's text track: the source's lines where the speech is, moved `extraMs` further, each start
 * and end off by up to ±`jitterMs`. Two releases with different seeds are independent witnesses (their
 * raw times differ by more than the 50 ms family rule); the same release shifted by a second is a
 * genuinely different timing.
 */
export function release(extraMs: number, seed: number, jitterMs = 40): Cue[] {
  return asCues(retimed(MT_SOURCE, MT_TRUTH.scale, MT_TRUTH.offsetMs + extraMs, 'Track line', jitterMs, seed))
}

/** A near-copy of `track`: every start and end within ±`within` ms, so one family with it (D16-3). */
export function copyOf(track: readonly Cue[], within = 20): Cue[] {
  return track.map((c, i) => {
    const d = ((i * 7919) % (2 * within + 1)) - within
    return { index: c.index, startMs: c.startMs + d, endMs: c.endMs + d, text: c.text }
  })
}

/** The same release cut into different lines: only 70% of them, so its own line boundaries differ. */
export function resegmented(extraMs: number, seed: number): Cue[] {
  return asCues(keepEvenly(retimed(MT_SOURCE, MT_TRUTH.scale, MT_TRUTH.offsetMs + extraMs, 'Track line', 40, seed), 140))
}

/** Another film's track: nothing in it lines up with the source. */
export function unrelatedTrack(): Cue[] {
  return asCues(speech(200, 9101, 'Other', 7000))
}

/**
 * A track already on the source's clock, as A–I's never-worsen rule keeps it: the source's own times,
 * the first half 150 ms late and the second half 150 ms early (`sign` −1 mirrors it, a second witness).
 */
export function identityTrack(sign: 1 | -1 = 1): Cue[] {
  const half = MT_SOURCE.length / 2
  return asCues(
    MT_SOURCE.map((c, i) => {
      const d = sign * (i < half ? 150 : -150)
      return { start: c.start + d, end: c.end + d, text: 'Track line' }
    })
  )
}

/** A track on the source's own clock that has only 75% of its lines: a `check` within T of identity. */
export function identityPartial(): Cue[] {
  return asCues(keepEvenly(MT_SOURCE, 150).map((c) => ({ ...c, text: 'Track line' })))
}

/** Source cues moved by `deltaMs`: an A–I result shape for the pure distance and side gates. */
export function shiftedBy(cues: readonly Cue[], deltaMs: number): Cue[] {
  return cues.map((c) => ({ ...c, startMs: c.startMs + deltaMs, endMs: c.endMs + deltaMs }))
}
