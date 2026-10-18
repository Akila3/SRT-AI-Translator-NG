/**
 * Stage B's word timeline for the dedicated transcription model (implementation_plan.md Bundle I,
 * "Stage B — build cues", invariants 1–5). AUTHORED-BY: opus-5.5-high
 *
 * `gemini-3.5-transcribe` measures each word from the start of the audio it was sent, so a chunk, and
 * every bisected piece of one, comes back on its own clock. Everything here puts those words on the
 * file's clock and keeps them there:
 *
 *  1. a word's global time is its piece's start plus its offset;
 *  2. the merged stream is monotonic non-decreasing;
 *  3. no word ends past the container's duration;
 *  4. pieces merge by ABSOLUTE offset, never by the order they came back in — recursion completes out
 *     of order;
 *  5. a word heard on both sides of a cut is one word: it de-duplicates on (global offset, text).
 *
 * Pure: no model, no request, no clock. Times are seconds, compared in whole milliseconds so a
 * `0.1 + 0.2` cannot separate two readings of the same instant.
 */

/** One word on the file's clock, in seconds. */
export interface GlobalWord {
  text: string
  start: number
  end: number
}

/** One word as the model returned it: seconds from the start of the audio it was sent. */
export interface LocalWord {
  word: string
  start: number
  end: number
}

export function ms(seconds: number): number {
  return Math.round(seconds * 1000)
}

/** Invariant 1: the piece's start plus each offset. Empty words are not words. */
export function toGlobal(words: readonly LocalWord[], pieceStartSeconds: number): GlobalWord[] {
  const out: GlobalWord[] = []
  for (const w of words) {
    const text = w.word.trim()
    if (!text) continue
    out.push({ text, start: (ms(pieceStartSeconds) + ms(w.start)) / 1000, end: (ms(pieceStartSeconds) + ms(w.end)) / 1000 })
  }
  return out
}

function sameText(a: string, b: string): boolean {
  return a.normalize('NFC').toLocaleLowerCase() === b.normalize('NFC').toLocaleLowerCase()
}

/**
 * Invariants 2, 4 and 5 together: every piece's words in one stream ordered by global start, whatever
 * order the pieces arrived in, with a word that two pieces both heard at the same instant kept once.
 * Equal starts keep the piece order and then the order inside the piece — never their end times, so
 * a spoken "not yet" with a zero-length "yet" is not read back as "yet not".
 */
export function mergeByOffset(pieces: readonly (readonly GlobalWord[])[]): GlobalWord[] {
  const tagged: { w: GlobalWord; piece: number; at: number }[] = []
  pieces.forEach((p, piece) => p.forEach((w, at) => tagged.push({ w, piece, at })))
  tagged.sort((a, b) => ms(a.w.start) - ms(b.w.start) || a.piece - b.piece || a.at - b.at)
  const out: GlobalWord[] = []
  const from: number[] = []
  for (const { w, piece } of tagged) {
    // The same word at the same instant from a DIFFERENT piece is the cut heard twice. Two equal words
    // at one instant inside one piece are the speaker's, and both stay.
    const dup = out.some((o, i) => from[i] !== piece && ms(o.start) === ms(w.start) && sameText(o.text, w.text))
    if (dup) continue
    out.push({ ...w })
    from.push(piece)
  }
  return out
}

/**
 * Invariant 3, and the order the cue builder relies on: no time below zero or past the container's
 * end, no word ending before it starts, starts non-decreasing.
 */
export function clampToDuration(words: readonly GlobalWord[], durationSeconds: number): GlobalWord[] {
  const limit = ms(Math.max(0, durationSeconds))
  const out: GlobalWord[] = []
  let floor = 0
  for (const w of words) {
    const start = Math.min(limit, Math.max(floor, ms(w.start)))
    const end = Math.min(limit, Math.max(start, ms(w.end)))
    out.push({ text: w.text, start: start / 1000, end: end / 1000 })
    floor = start
  }
  return out
}

/** True when starts never decrease and no end precedes its start: invariant 2 as a check. */
export function isMonotonic(words: readonly { start: number; end: number }[]): boolean {
  for (let i = 0; i < words.length; i++) {
    if (ms(words[i].end) < ms(words[i].start)) return false
    if (i > 0 && ms(words[i].start) < ms(words[i - 1].start)) return false
  }
  return true
}
