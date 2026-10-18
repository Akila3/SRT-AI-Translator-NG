/**
 * Align fallback fixtures (C.4): synthetic audio envelopes and synthetic transcripts. Every timeline is
 * built from the seeded generators in `../global/fixtures`, and every line is an author-written label, so
 * no subtitle text or audio enters git. The ground truth of each fixture is the transform that built it.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import { alignmentSweep, type AlignmentAudio, type AlignmentEnvelope } from '../../../../../electron/main/ffmpeg'
import type { Cue } from '../../../../../electron/engine/srt'
import { asCues, PAL_FROM_FILM, retimed, speech, type PlainCue } from '../global/fixtures'

export interface Span {
  start: number
  end: number
}

/** Loud speech over silence, or over a quieter bed that only the lowest thresholds hear. */
const SPEECH_DB = -20
const SILENCE_DB = -75

/** One envelope per hop: window `i` (starting at `i · hop`) is speech when its start lies inside a span. */
export function envelopesFor(spans: readonly Span[], totalMs: number, bedDb = SILENCE_DB): AlignmentEnvelope[] {
  return [50, 100].map((hopMs) => {
    const levelsDb: number[] = []
    let k = 0
    for (let t = 0; t < totalMs; t += hopMs) {
      while (k < spans.length && spans[k].end <= t) k += 1
      levelsDb.push(k < spans.length && spans[k].start <= t ? SPEECH_DB : bedDb)
    }
    return { hopMs, levelsDb }
  })
}

/** What `audioForAlignment` returns for a file whose speech sits exactly at `spans`. */
export function alignmentAudio(spans: readonly Span[], opts: { bedDb?: number; tailMs?: number } = {}): Extract<AlignmentAudio, { ok: true }> {
  const totalMs = (spans.length ? spans[spans.length - 1].end : 0) + (opts.tailMs ?? 30_000)
  const envelopes = envelopesFor(spans, totalMs, opts.bedDb)
  return {
    ok: true,
    durationSeconds: totalMs / 1000,
    channels: 2,
    streamIndex: 1,
    filter: 'highpass=f=1000,lowpass=f=4000,aresample=async=1',
    decodedSeconds: totalMs / 1000,
    envelopes,
    candidates: alignmentSweep(envelopes)
  }
}

const spansOf = (cues: readonly PlainCue[]): Span[] => cues.map((c) => ({ start: c.start, end: c.end }))

/** The subtitle every fallback fixture aligns: 200 lines on the wrong clock. */
export const FALLBACK_SOURCE: PlainCue[] = speech(200, 6001, 'Line')
export const FALLBACK_TRUTH = { scale: PAL_FROM_FILM, offsetMs: 2340 }
const onFilm = retimed(FALLBACK_SOURCE, FALLBACK_TRUTH.scale, FALLBACK_TRUTH.offsetMs, 'Spoken', 40, 811)

export function fallbackSource(): Cue[] {
  return asCues(FALLBACK_SOURCE)
}

/** The film's speech is where the subtitle's lines belong, over silence: every threshold hears it. */
export function audioMatching(): Extract<AlignmentAudio, { ok: true }> {
  return alignmentAudio(spansOf(onFilm))
}

/**
 * The same speech over a −55 dB music bed. The sweep's first arms (−60 dB) hear one span covering the
 * whole film; only a higher threshold separates the lines. The pick must not be sweep order.
 */
export function audioUnderMusic(): Extract<AlignmentAudio, { ok: true }> {
  return alignmentAudio(spansOf(onFilm), { bedDb: -55 })
}

/** Speech of another film's cadence: nothing in it lines up with this subtitle. */
export function audioUnrelated(): Extract<AlignmentAudio, { ok: true }> {
  return alignmentAudio(spansOf(speech(200, 9101, 'Other', 7000)))
}

/** A transcript: lines where the speech is, each start/end off by up to ±`jitterMs`. */
export function transcriptNear(jitterMs: number, seed = 911): Cue[] {
  return asCues(retimed(FALLBACK_SOURCE, FALLBACK_TRUTH.scale, FALLBACK_TRUTH.offsetMs, 'Heard words', jitterMs, seed))
}

/**
 * The supplied GST transcripts' failure shapes (`feature_decisions.md` §5.3), synthesised: whole-second
 * boundaries and every third start leading the speech by 0.5–2 s; with `jump`, from line 121 on the
 * timeline also falls back by 22 s.
 */
export function transcriptGstShaped(jump = false): Cue[] {
  const quantised = retimed(FALLBACK_SOURCE, FALLBACK_TRUTH.scale, FALLBACK_TRUTH.offsetMs, 'Heard words').map((c, i) => {
    const lead = i % 3 === 0 ? 500 + ((i * 377) % 1500) : 0
    const back = jump && i >= 120 ? -22_000 : 0
    const start = Math.floor((c.start - lead + back) / 1000) * 1000
    return { start, end: start + 1000 + (Math.ceil((c.end - c.start) / 1000) - 1) * 1000, text: c.text }
  })
  return quantised.map((c, i) => ({ index: i + 1, startMs: c.start, endMs: c.end, text: c.text }))
}

/** A transcript of a different film (the wrong file was transcribed): no global map exists. */
export function transcriptUnrelated(): Cue[] {
  return asCues(speech(200, 9101, 'Other words', 7000))
}
