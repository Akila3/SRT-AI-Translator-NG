/**
 * SubRip, read and written (implementation_plan.md Step 1.6, first form; Step 2.1, canonical `Cue`).
 * AUTHORED-BY: opus-5.5-high
 *
 * `.ass` is deliberately absent (DECISIONS.md D3): NG reads and writes `.srt` only.
 *
 * Two readers live here for two different jobs. `parseSrt`/`formatSrt` (seconds, lenient) serve
 * transcription, where the cues come from a model and a damaged block is reported and skipped.
 * `parseCues`/`serializeCues` (milliseconds, strict) serve translation, where the cues come from
 * the user's file and every one of them must reach the output with its own timing: a block that
 * cannot be read faithfully refuses the whole file instead of disappearing from it.
 */
import os from 'os'
import path from 'path'

/** One subtitle, in seconds. */
export interface SrtCue {
  start: number
  end: number
  text: string
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** `HH:MM:SS,mmm`, rounded to the millisecond. */
export function srtTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return `${pad(Math.floor(ms / 3_600_000), 2)}:${pad(Math.floor(ms / 60_000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`
}

/**
 * The SRT gst wrote through pysubs2: numbered from 1, in the order the model returned them, each
 * cue followed by a blank line, UTF-8 with no BOM, and the platform's line ending (pysubs2 writes in
 * text mode). A cue with no text is dropped and blank lines inside a cue are removed — either one
 * would end the cue early for every SRT reader.
 */
export function formatSrt(cues: readonly SrtCue[], eol: string = os.EOL): string {
  const blocks: string[] = []
  for (const cue of cues) {
    const lines = cue.text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length === 0) continue
    blocks.push(
      [String(blocks.length + 1), `${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}`, ...lines].join(eol) + eol + eol
    )
  }
  return blocks.join('')
}

export interface ParsedSrt {
  cues: SrtCue[]
  /** Non-empty blocks with no usable timing line. Never silently counted as cues. */
  rejectedBlocks: number
}

/** `H:MM:SS,mmm` or `.mmm`; one to three fraction digits, read as a decimal fraction. */
const TIME = String.raw`(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?`
const TIMING_LINE = new RegExp(String.raw`^\s*${TIME}\s*-->\s*${TIME}`)

/** Summed in whole milliseconds, so `,235` reads back as 1.235 and not 1.2349999. */
function seconds(h: string, m: string, s: string, frac: string | undefined): number {
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0
  return (Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + ms) / 1000
}

/**
 * Cues out of an `.srt`. A BOM, CRLF, a missing or non-numeric index line, a dot instead of a comma
 * and trailing position coordinates after the timing are all accepted, as players accept them. A
 * block whose timing line cannot be read is counted in `rejectedBlocks` and contributes no cue, so a
 * caller can tell a damaged file from a short one.
 */
export function parseSrt(text: string): ParsedSrt {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const cues: SrtCue[] = []
  let rejectedBlocks = 0
  for (const block of body.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n')
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
    if (lines.length === 0) continue
    const at = lines.findIndex((l) => TIMING_LINE.test(l))
    if (at < 0 || at > 1) {
      rejectedBlocks += 1
      continue
    }
    const m = TIMING_LINE.exec(lines[at]) as RegExpExecArray
    cues.push({
      start: seconds(m[1], m[2], m[3], m[4]),
      end: seconds(m[5], m[6], m[7], m[8]),
      text: lines
        .slice(at + 1)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join('\n')
    })
  }
  return { cues, rejectedBlocks }
}

/**
 * One cue of a source subtitle. `index` is its 1-based position in the file — the identity the batch
 * loop requests and the number the output carries (gst 3.7.0 `main.py:418-430`, `index=i + 1`). The
 * file's own number lines are not kept, as pysubs2 does not keep them.
 */
export interface Cue {
  readonly index: number
  readonly startMs: number
  readonly endMs: number
  readonly text: string
}

/** Why a file was not read. Each names a block the reader could not attribute to a cue. */
export type CueRefusal = 'format' | 'empty' | 'preface' | 'timing' | 'index'

export type CueParse =
  | { ok: true; cues: Cue[] }
  | { ok: false; reason: CueRefusal; line: number; message: string }

/** pysubs2 1.9.0 `time.py:8`, the shipped engine's reader: 1–2 digit fields, `,` or `.`, 1–3 fraction digits. */
const STAMP = /(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/g
const INDEX_LINE = /^\s*\d+\s*$/
const BLANK_LINE = /^\s*$/
const LINE_BREAK = /\r\n|\r|\n/
/** `99:59:59,999`, the largest time SubRip can write (pysubs2 `subrip.py`, `MAX_REPRESENTABLE_TIME`). */
const MAX_CUE_MS = 100 * 3_600_000 - 1
const STYLED_EXTS = new Set(['.ass', '.ssa'])

function stampsOf(line: string): RegExpMatchArray[] {
  return [...line.matchAll(STAMP)]
}

function stampMs(m: RegExpMatchArray): number {
  return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, '0'))
}

function otherFormat(body: string): string | null {
  if (body.includes('[Script Info]') || body.includes('[V4+ Styles]')) return 'an ASS/SSA subtitle'
  if (body.trimStart().startsWith('WEBVTT')) return 'a WebVTT subtitle'
  if (body.includes('http://www.w3.org/ns/ttml')) return 'a TTML subtitle'
  return null
}

function refuse(reason: CueRefusal, line: number, message: string): CueParse {
  return { ok: false, reason, line, message }
}

/**
 * Cues out of already-decoded SubRip text, with the boundaries pysubs2 1.9.0 draws (the reader the
 * shipped engine uses, `subrip.py` `from_file`): a timing line is any line holding exactly two
 * timestamps; a cue's text is every line up to the next timing line, trimmed, with a number line
 * directly above that timing taken as the next cue's number. A BOM, CRLF or CR, `.` for `,`, short
 * fractions, a missing number line, no blank line between cues, out-of-order or reversed times,
 * position coordinates, empty cues and blank lines inside a cue are all read as pysubs2 reads them.
 *
 * It refuses, rather than reading, the three shapes pysubs2 resolves by losing text silently: text
 * before the first cue, a line with `-->` that is not two timestamps (pysubs2 drops the cue it
 * starts), and a line above a timing that is neither blank nor a number (it belongs to no cue
 * unambiguously). And it keeps the one pysubs2 drops by rule: a last cue whose final line is a number
 * keeps that line, because no cue follows it to own it. ASS, SSA, WebVTT and TTML refuse by name
 * (DECISIONS.md D3); nothing here decodes bytes, wraps RTL or repairs text.
 */
export function parseCues(text: string, options: { path?: string } = {}): CueParse {
  const body = text.replace(/^\uFEFF/, '')
  const ext = options.path ? path.extname(options.path).toLowerCase() : ''
  const named = STYLED_EXTS.has(ext) ? 'an ASS/SSA subtitle' : otherFormat(body)
  if (named) {
    return refuse('format', 1, `This is ${named}. The built-in translator reads SubRip (.srt) files only.`)
  }

  const lines = body.split(LINE_BREAK)
  const timings: { at: number; startMs: number; endMs: number }[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const found = stampsOf(lines[i])
    if (found.length === 2) {
      timings.push({ at: i, startMs: stampMs(found[0]), endMs: stampMs(found[1]) })
    } else if (lines[i].includes('-->')) {
      return refuse(
        'timing',
        i + 1,
        `Line ${i + 1} looks like a subtitle timing but cannot be read, so the subtitle it starts would be lost. Fix that line and try again.`
      )
    }
  }
  if (timings.length === 0) {
    return refuse('empty', 1, 'This file has no subtitle timings, so there is nothing to translate.')
  }

  const first = timings[0].at
  for (let i = 0; i < first; i += 1) {
    if (BLANK_LINE.test(lines[i])) continue
    if (i === first - 1 && INDEX_LINE.test(lines[i])) continue
    return refuse(
      'preface',
      i + 1,
      `Line ${i + 1} has text before the first subtitle. It belongs to no subtitle and would be lost, so the file was not translated.`
    )
  }

  const cues: Cue[] = []
  for (let k = 0; k < timings.length; k += 1) {
    const { at, startMs, endMs } = timings[k]
    const next = k + 1 < timings.length ? timings[k + 1].at : lines.length
    let stop = next
    if (k + 1 < timings.length && next - 1 > at) {
      const above = lines[next - 1]
      if (INDEX_LINE.test(above)) stop = next - 1
      else if (!BLANK_LINE.test(above)) {
        return refuse(
          'index',
          next,
          `Line ${next} sits directly above a subtitle timing but is not a subtitle number, so it is unclear which subtitle it belongs to.`
        )
      }
    }
    cues.push({ index: k + 1, startMs, endMs, text: lines.slice(at + 1, stop).join('\n').trim() })
  }
  return { ok: true, cues }
}

/**
 * `text` with the two timestamps of its k-th timing line (the k-th line `parseCues` reads as a timing)
 * replaced by `times[k]`, and every other character kept: number lines, cue text and its whitespace,
 * blank lines, position coordinates, separators and line endings. `null` when the text does not have
 * exactly `times.length` timing lines; throws `RangeError` for a time SubRip cannot write.
 */
export function retimeSubRipText(text: string, times: readonly { startMs: number; endMs: number }[]): string | null {
  const parts = text.split(/(\r\n|\r|\n)/)
  let k = 0
  for (let i = 0; i < parts.length; i += 2) {
    const found = stampsOf(parts[i])
    if (found.length !== 2) continue
    if (k >= times.length) return null
    const [a, b] = found
    const line = parts[i]
    const aEnd = a.index! + a[0].length
    parts[i] =
      line.slice(0, a.index!) + cueTimestamp(times[k].startMs) + line.slice(aEnd, b.index!) + cueTimestamp(times[k].endMs) + line.slice(b.index! + b[0].length)
    k += 1
  }
  return k === times.length ? parts.join('') : null
}

/**
 * A cue's text without the RTL wrapper gst adds to it (`U+202B` + text + `U+202C`, 3.7.0
 * `main.py:1455-1485`), removed as matched pairs at the cue's two edges. Characters inside the text,
 * and an unmatched control at one edge, are kept: they belong to the text, not to the wrapper.
 */
export function stripCueEdgeControls(text: string): string {
  let t = text
  while (t.length >= 2 && t.startsWith('\u202B') && t.endsWith('\u202C')) t = t.slice(1, -1)
  return t
}

/**
 * `text` with each cue's text (the lines `parseCues` reads, from the first non-blank to the last)
 * replaced line for line by `transform`, and every other byte kept: BOM, number lines, timings, blank
 * lines and each line's own ending. `transform` sees the lines joined by `\n` and must return the same
 * number of lines. `null` when a `-->` line is not a timing or a transform changes the line count.
 */
export function mapCueText(text: string, transform: (cueText: string) => string): string | null {
  const parts = text.split(/(\r\n|\r|\n)/)
  const lines: string[] = []
  for (let i = 0; i < parts.length; i += 2) lines.push(parts[i])
  const timings: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const found = stampsOf(lines[i]).length
    if (found === 2) timings.push(i)
    else if (lines[i].includes('-->')) return null
  }
  for (let k = 0; k < timings.length; k += 1) {
    const at = timings[k]
    const next = k + 1 < timings.length ? timings[k + 1] : lines.length
    let stop = next
    if (k + 1 < timings.length && next - 1 > at && INDEX_LINE.test(lines[next - 1])) stop = next - 1
    let first = at + 1
    let last = stop - 1
    while (first <= last && BLANK_LINE.test(lines[first])) first += 1
    while (last >= first && BLANK_LINE.test(lines[last])) last -= 1
    if (first > last) continue
    const changed = transform(lines.slice(first, last + 1).join('\n')).split('\n')
    if (changed.length !== last - first + 1) return null
    for (let j = 0; j < changed.length; j += 1) lines[first + j] = changed[j]
  }
  for (let i = 0; i < lines.length; i += 1) parts[i * 2] = lines[i]
  return parts.join('')
}

/**
 * 0.2.533 `srt.py:40-42` and `:52-56`, Python `(?m)^` kept exact: a line start is the text's start or just after
 * `\n` (JavaScript's `m` flag would also start a line after `\r`, U+2028 and U+2029). `pre` keeps a leading
 * dialogue dash and, in the Hebrew-gated form, one bounded inline tag (`<i>`, `<b>`, `<font …>`).
 */
const LEAKED_SPEAKER = /(?<![^\n])(?<pre>[ \t]*(?:-[ \t]+)?)[A-Z][A-Z0-9 '.-]{1,30}:[ \t]*/g
const LEAKED_SPEAKER_HE = /(?<![^\n])(?<pre>[ \t]*(?:<[^>\n]{1,40}>[ \t]*)?(?:-[ \t]+)?)[A-Z][A-Z0-9 '.-]{1,30}:[ \t]*(?=[^\n]*[\u0590-\u05ff])/g
/** The source side of `stripLeakedSpeakerTags`: the Hebrew-gated form's prefix (one bounded inline tag) without its Hebrew gate. */
const SOURCE_SPEAKER = /(?<![^\n])(?<pre>[ \t]*(?:<[^>\n]{1,40}>[ \t]*)?(?:-[ \t]+)?)[A-Z][A-Z0-9 '.-]{1,30}:[ \t]*/g

/**
 * `strip_leaked_speaker_prefix` (0.2.533 `srt.py:1285-1306`): an ALL-CAPS Latin `NAME:` at a line start is removed,
 * its dash and tag kept. `hebrewOnly` — the form for Hebrew output — removes it only when the rest of that line
 * has a Hebrew letter, so `WARNING:`, `PART 2:` and `HTTP://` captions stay byte for byte. Every line and line
 * break survives; empty input or a failure returns the text unchanged.
 */
export function stripLeakedSpeakerPrefix(text: string, hebrewOnly = false): string {
  if (!text) return text
  try {
    return text.replace(hebrewOnly ? LEAKED_SPEAKER_HE : LEAKED_SPEAKER, (...args) => (args[args.length - 1] as { pre: string }).pre)
  } catch {
    return text
  }
}

/**
 * The `NAME` of each line-start speaker tag the source carries, recognised with the same prefix (dash, one
 * bounded inline tag) the output strip removes, so a marked-up source label is protected too (R19-03).
 */
function speakerTags(text: string): Set<string> {
  const tags = new Set<string>()
  for (const m of text.matchAll(SOURCE_SPEAKER)) tags.add(m[0].slice(m.groups!.pre.length).replace(/:[ \t]*$/, ''))
  return tags
}

/**
 * The Hebrew-gated strip on one translated cue, anchored to its source cue: a tag is a leak only when the source
 * cue does not carry the same `NAME:`. A hearing-impaired source's own speaker label, which the translation keeps
 * as 1.1.0 does, is not removed. Every line and line break survives; a failure returns the text unchanged.
 */
export function stripLeakedSpeakerTags(text: string, sourceCue: string): string {
  if (!text) return text
  try {
    const kept = speakerTags(sourceCue)
    return text.replace(LEAKED_SPEAKER_HE, (whole: string, ...args) => {
      const pre = (args[args.length - 1] as { pre: string }).pre
      return kept.has(whole.slice(pre.length).replace(/:[ \t]*$/, '')) ? whole : pre
    })
  } catch {
    return text
  }
}

export type CueWriteProblem = 'sequence' | 'timing' | 'text'

export class CueWriteError extends Error {
  constructor(
    readonly problem: CueWriteProblem,
    readonly index: number,
    message: string
  ) {
    super(message)
    this.name = 'CueWriteError'
  }
}

/** `HH:MM:SS,mmm` from whole milliseconds. Throws outside what SubRip can write rather than clamping. */
export function cueTimestamp(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_CUE_MS) {
    throw new RangeError(`not a SubRip time: ${ms}`)
  }
  return `${pad(Math.floor(ms / 3_600_000), 2)}:${pad(Math.floor(ms / 60_000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`
}

/**
 * The text a cue is written with: trimmed, with blank lines inside it removed — the same as
 * pysubs2's writer (`subrip.py` `to_file`), since a blank line ends a cue for every other reader.
 */
export function writtenCueText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().replace(/\n+/g, '\n')
}

/**
 * Why `text` cannot be written as one cue's text, or `null`. A line that `parseCues` would read as a
 * timing line, or that carries `-->`, would split or refuse the file on the way back in.
 */
export function cueTextProblem(text: string): string | null {
  for (const line of writtenCueText(text).split('\n')) {
    if (stampsOf(line).length === 2 || line.includes('-->')) return 'a line of the text reads as a subtitle timing'
  }
  return null
}

/**
 * The SRT pysubs2 writes for these cues (gst 3.7.0 `main.py:432-438`, measured against pysubs2 1.9.0):
 * each cue's own number, its own times, its text, then a blank line; an empty cue stays as an empty
 * cue; UTF-8 with no BOM is the caller's to write; the platform's line ending. It writes what it is
 * given: numbers that are not exactly 1..N in order, a time SubRip cannot hold, or text that would
 * not read back as the same cue throw `CueWriteError` instead of being renumbered, clamped or edited.
 */
export function serializeCues(cues: readonly Cue[], eol: string = os.EOL): string {
  const blocks: string[] = []
  cues.forEach((cue, i) => {
    if (cue.index !== i + 1) {
      throw new CueWriteError('sequence', cue.index, `cue ${i + 1} carries number ${cue.index}`)
    }
    let timing: string
    try {
      timing = `${cueTimestamp(cue.startMs)} --> ${cueTimestamp(cue.endMs)}`
    } catch (err) {
      throw new CueWriteError('timing', cue.index, `cue ${cue.index}: ${(err as Error).message}`)
    }
    const problem = cueTextProblem(cue.text)
    if (problem) throw new CueWriteError('text', cue.index, `cue ${cue.index}: ${problem}`)
    blocks.push(`${cue.index}${eol}${timing}${eol}${writtenCueText(cue.text).split('\n').join(eol)}${eol}${eol}`)
  })
  return blocks.join('')
}
