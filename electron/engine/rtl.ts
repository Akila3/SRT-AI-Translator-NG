/**
 * Right-to-left display copies of SubRip text (implementation_plan.md §9.6b; feature_decisions.md
 * D12-9…D12-16). AUTHORED-BY: opus-5.5-high
 *
 * Pure: no file, no provider, no settings read. Every copy is derived again from canonical logical
 * text — the engine's temp, the native partial — after `stripCueEdgeControls` removes the one wrapper
 * the old engine adds, so a method is never applied to its own output and nothing accumulates. Cue
 * count, numbers, timings, line order and line endings are kept; only cue text lines change.
 *
 * The five methods are ports of what was measured on 192 real files / 151 115 cues
 * (a private corpus probe; receipt `rtl_real_corpus_evaluation.md`, ledger E82):
 *   hybrid             Smart RTL: line-aware RLE…PDF; inside a known RTL target every line with RTL
 *                      letters, otherwise only lines whose RTL letters outnumber their LTR letters;
 *                      markup kept, each RTL run inside a style wrapped on its own.
 *   kodi_rtl_base      Hebrew Compatibility: the same wrap for Hebrew lines only (Kodi rtl_base, minus
 *                      the multi-style branch that deletes tags).
 *   gst_compatibility  Classic RTL: gst 3.7.0's whole-cue rule — strong RTL (+RLE/RLI) outnumbers
 *                      strong LTR (+LRE/LRI), counted over the raw cue — and one RLE…PDF around it.
 *   kodi_reverse       Basic-Player RTL: Kodi 0.2.548 `_reverse_fix_one_text_line` — end punctuation
 *                      physically moved to the start of Hebrew lines.
 *   kodi_legacy        Old Subtitle Repair: Kodi 0.2.548 `_fix_one_text_line` — leading punctuation
 *                      moved back to the end.
 * The Kodi ports keep Python's semantics where JavaScript differs: Python whitespace for `strip()`
 * and `\s`, and `[^\n]` for `.`. Lines are split on line breaks only (Python's `splitlines` would
 * also split on U+2028/U+2029 and a few C0 separators, which subtitles do not carry).
 */
import type { RtlMethod } from '../shared/types'
import type { RtlLanguage } from '../shared/languages'
import { mapCueText, parseCues, stripCueEdgeControls } from './srt'

export const RLE = '\u202B'
export const PDF = '\u202C'

// ── Unicode bidirectional classes (Python 3.14 `unicodedata`, Unicode 16.0) ──────────────────────
// Ranges of assigned code points; unassigned code points inside a range are bridged (no text has them).

/** Bidi_Class R or AL. */
const RTL_RANGES =
  '5be,5c0,5c3,5c6,5d0-5f4,608,60b,60d,61b-64a,66d-66f,671-6d5,6e5-6e6,6ee-6ef,6fa-710,712-72f,74d-7a5,7b1-7ea,7f4-7f5,7fa,7fe-815,81a,824,828,830-858,85e-88e,8a0-8c9,200f,fb1d,fb1f-fb28,fb2a-fd3d,fd50-fdc7,fdf0-fdfc,fe70-fefc,10800-1091b,10920-10a00,10a10-10a35,10a40-10ae4,10aeb-10b35,10b40-10d23,10d4a-10d65,10d6f-10d8f,10e80-10ea9,10ead-10ec4,10f00-10f45,10f51-10f81,10f86-10ff6,1e800-1e8cf,1e900-1e943,1e94b-1eebb'

/** Bidi_Class L. */
const LTR_RANGES =
  '41-5a,61-7a,aa,b5,ba,c0-d6,d8-f6,f8-2b8,2bb-2c1,2d0-2d1,2e0-2e4,2ee,370-373,376-37d,37f,386,388-3f5,3f7-482,48a-589,903-939,93b,93d-940,949-94c,94e-950,958-961,964-980,982-9b9,9bd-9c0,9c7-9cc,9ce-9e1,9e6-9f1,9f4-9fa,9fc-9fd,a03-a39,a3e-a40,a59-a6f,a72-a74,a76,a83-ab9,abd-ac0,ac9-acc,ad0-ae1,ae6-af0,af9,b02-b39,b3d-b3e,b40,b47-b4c,b57-b61,b66-b77,b83-bbf,bc1-bcc,bd0-bf2,c01-c03,c05-c39,c3d,c41-c44,c58-c61,c66-c77,c7f-c80,c82-cb9,cbd-ccb,cd5-ce1,ce6-cf3,d02-d3a,d3d-d40,d46-d4c,d4e-d61,d66-d7f,d82-dc6,dcf-dd1,dd8-e30,e32-e33,e40-e46,e4f-eb0,eb2-eb3,ebd-ec6,ed0-f17,f1a-f34,f36,f38,f3e-f6c,f7f,f85,f88-f8c,fbe-fc5,fc7-102c,1031,1038,103b-103c,103f-1057,105a-105d,1061-1070,1075-1081,1083-1084,1087-108c,108e-109c,109e-135a,1360-138f,13a0-13fd,1401-167f,1681-169a,16a0-1711,1715-1731,1734-1751,1760-1770,1780-17b3,17b6,17be-17c5,17c7-17c8,17d4-17da,17dc,17e0-17e9,1810-1884,1887-18a8,18aa-191e,1923-1926,1929-1931,1933-1938,1946-19da,1a00-1a16,1a19-1a1a,1a1e-1a55,1a57,1a61,1a63-1a64,1a6d-1a72,1a80-1aad,1b04-1b33,1b35,1b3b,1b3d-1b41,1b43-1b6a,1b74-1b7f,1b82-1ba1,1ba6-1ba7,1baa,1bae-1be5,1be7,1bea-1bec,1bee,1bf2-1c2b,1c34-1c35,1c3b-1cc7,1cd3,1ce1,1ce9-1cec,1cee-1cf3,1cf5-1cf7,1cfa-1dbf,1e00-1fbc,1fbe,1fc2-1fcc,1fd0-1fdb,1fe0-1fec,1ff2-1ffc,200e,2071,207f,2090-209c,2102,2107,210a-2113,2115,2119-211d,2124,2126,2128,212a-212d,212f-2139,213c-213f,2145-2149,214e-214f,2160-2188,2336-237a,2395,249c-24e9,26ac,2800-28ff,2c00-2ce4,2ceb-2cee,2cf2-2cf3,2d00-2d70,2d80-2dde,3005-3007,3021-3029,302e-302f,3031-3035,3038-303c,3041-3096,309d-309f,30a1-30fa,30fc-31bf,31f0-321c,3220-324f,3260-327b,327f-32b0,32c0-32cb,32d0-3376,337b-33dd,33e0-33fe,3400-4dbf,4e00-a48c,a4d0-a60c,a610-a66e,a680-a69d,a6a0-a6ef,a6f2-a6f7,a722-a787,a789-a801,a803-a805,a807-a80a,a80c-a824,a827,a830-a837,a840-a873,a880-a8c3,a8ce-a8d9,a8f2-a8fe,a900-a925,a92e-a946,a952-a97c,a983-a9b2,a9b4-a9b5,a9ba-a9bb,a9be-a9e4,a9e6-aa28,aa2f-aa30,aa33-aa34,aa40-aa42,aa44-aa4b,aa4d-aa7b,aa7d-aaaf,aab1,aab5-aab6,aab9-aabd,aac0,aac2-aaeb,aaee-aaf5,ab01-ab69,ab70-abe4,abe6-abe7,abe9-abec,abf0-fb17,ff21-ff3a,ff41-ff5a,ff66-ffdc,10000-10100,10102-1013f,1018d-1018e,101d0-101fc,10280-102d0,10300-10375,10380-107ba,11000,11002-11037,11047-1104d,11066-1106f,11071-11072,11075,11082-110b2,110b7-110b8,110bb-110c1,110cd-110f9,11103-11126,1112c,11136-11172,11174-11176,11182-111b5,111bf-111c8,111cd-111ce,111d0-1122e,11232-11233,11235,11238-1123d,1123f-11240,11280-112de,112e0-112e2,112f0-112f9,11302-11339,1133d-1133f,11341-11363,11380-113ba,113c2-113cd,113cf,113d1,113d3-113d8,11400-11437,11440-11441,11445,11447-1145d,1145f-114b2,114b9,114bb-114be,114c1,114c4-115b1,115b8-115bb,115be,115c1-115db,11600-11632,1163b-1163c,1163e,11641-11659,11680-116aa,116ac,116ae-116af,116b6,116b8-1171a,1171e,11720-11721,11726,11730-1182e,11838,1183b-11938,1193d,1193f-11942,11944-119d3,119dc-119df,119e1-11a00,11a07-11a08,11a0b-11a32,11a39-11a3a,11a3f-11a46,11a50,11a57-11a58,11a5c-11a89,11a97,11a9a-11c2f,11c3e-11c8f,11ca9,11cb1,11cb4,11d00-11d30,11d46,11d50-11d8e,11d93-11d94,11d96,11d98-11ef2,11ef5-11ef8,11f02-11f35,11f3e-11f3f,11f41,11f43-11f59,11fb0-11fd4,11fff-1343f,13441-13446,13460-1611d,1612a-1612c,16130-16aed,16af5-16b2f,16b37-16f4a,16f50-16f87,16f93-16fe1,16fe3,16ff0-1bc9c,1bc9f,1ccd6-1ccef,1cf50-1d166,1d16a-1d172,1d183-1d184,1d18c-1d1a9,1d1ae-1d1e8,1d2c0-1d2f3,1d360-1d6c0,1d6c2-1d6da,1d6dc-1d6fa,1d6fc-1d714,1d716-1d734,1d736-1d74e,1d750-1d76e,1d770-1d788,1d78a-1d7a8,1d7aa-1d7c2,1d7c4-1d7cb,1d800-1d9ff,1da37-1da3a,1da6d-1da74,1da76-1da83,1da85-1da8b,1df00-1df2a,1e030-1e06d,1e100-1e12c,1e137-1e2ad,1e2c0-1e2eb,1e2f0-1e2f9,1e4d0-1e4eb,1e4f0-1e5ed,1e5f0-1e7fe,1f110-1f12e,1f130-1f169,1f170-1f1ac,1f1e6-1f251,20000-323af,f0000-10fffd'

function decodeRanges(table: string): Uint32Array {
  const parts = table.split(',')
  const out = new Uint32Array(parts.length * 2)
  parts.forEach((part, i) => {
    const [a, b] = part.split('-')
    out[i * 2] = parseInt(a, 16)
    out[i * 2 + 1] = parseInt(b ?? a, 16)
  })
  return out
}

const RTL_CLASS = decodeRanges(RTL_RANGES)
const LTR_CLASS = decodeRanges(LTR_RANGES)

function inRanges(cp: number, ranges: Uint32Array): boolean {
  let lo = 0
  let hi = ranges.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cp < ranges[mid * 2]) hi = mid - 1
    else if (cp > ranges[mid * 2 + 1]) lo = mid + 1
    else return true
  }
  return false
}

/** Bidi_Class R or AL. */
export function isStrongRtl(cp: number): boolean {
  return inRanges(cp, RTL_CLASS)
}

/** Bidi_Class L. */
export function isStrongLtr(cp: number): boolean {
  return inRanges(cp, LTR_CLASS)
}

// ── shared pieces of the measured probe ──────────────────────────────────────────────────────────

/** Direction controls and the BOM: what a method may remove from a line's edges and re-add. */
const EDGE_CONTROLS = new Set(['\u061C', '\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\uFEFF'])
/** SubRip/HTML tags and ASS override blocks, kept byte for byte by every method. */
const ANY_TAG = /<[^<>\r\n]+>|\{\\[^{}\r\n]+\}/g
const ANY_TAG_SPLIT = /(<[^<>\r\n]+>|\{\\[^{}\r\n]+\})/
const ANY_TAG_FULL = /^(?:<[^<>\r\n]+>|\{\\[^{}\r\n]+\})$/
const HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]/
/** A username/handle-shaped tail that is provably safe to wrap (Kodi `_WRAPPABLE_LATIN_TAIL_RE`). */
const SAFE_LATIN_TAIL = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*[.,;:!?…]$/

/** Python's `str.isspace()` set, which is also what Python's `\s` matches. */
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_WS_EDGES = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g')

function pyStrip(s: string): string {
  return s.replace(PY_WS_EDGES, '')
}

function withoutTagsAndControls(text: string): string {
  let out = ''
  for (const ch of text.replace(ANY_TAG, '')) if (!EDGE_CONTROLS.has(ch)) out += ch
  return out
}

function edgeStrip(line: string): string {
  let start = 0
  let end = line.length
  while (start < end && EDGE_CONTROLS.has(line[start])) start++
  while (end > start && EDGE_CONTROLS.has(line[end - 1])) end--
  return line.slice(start, end)
}

function hasHebrew(text: string): boolean {
  return HEBREW.test(withoutTagsAndControls(text))
}

function hasAnyRtl(text: string): boolean {
  for (const ch of withoutTagsAndControls(text)) if (isStrongRtl(ch.codePointAt(0) as number)) return true
  return false
}

function dominantlyRtl(text: string): boolean {
  let rtl = 0
  let ltr = 0
  for (const ch of withoutTagsAndControls(text)) {
    const cp = ch.codePointAt(0) as number
    if (isStrongRtl(cp)) rtl++
    else if (isStrongLtr(cp)) ltr++
  }
  return rtl > ltr
}

function isSafeLatinTail(line: string): boolean {
  return SAFE_LATIN_TAIL.test(pyStrip(withoutTagsAndControls(line)))
}

/** RLE…PDF around the line, and around each RTL text run between its tags, so a style never resets the base. */
function wrapKeepingTags(line: string): string {
  const clean = edgeStrip(line)
  if (!ANY_TAG_SPLIT.test(clean)) return RLE + clean + PDF
  let out = ''
  for (const token of clean.split(ANY_TAG_SPLIT)) {
    if (!token) continue
    if (ANY_TAG_FULL.test(token)) out += token
    else if (hasAnyRtl(token)) out += RLE + edgeStrip(token) + PDF
    else out += edgeStrip(token)
  }
  return RLE + out + PDF
}

function splitLines(text: string): { lines: string[]; trailing: string } {
  const normalized = text.replace(/\r\n?/g, '\n')
  const trailing = normalized.endsWith('\n') ? '\n' : ''
  const core = trailing ? normalized.slice(0, -1) : normalized
  return { lines: core === '' ? [] : core.split('\n'), trailing }
}

/** Probe `map_lines`: a blank line ends the cue's RTL state; a line with Hebrew starts it. */
function mapLines(text: string, mapper: (line: string, cueHebrew: boolean) => string): string {
  const { lines, trailing } = splitLines(text)
  let cueHebrew = false
  const out = lines.map((line) => {
    if (!pyStrip(line)) {
      cueHebrew = false
      return line
    }
    if (hasHebrew(line)) cueHebrew = true
    return mapper(line, cueHebrew)
  })
  return out.join('\n') + trailing
}

// ── the five methods ─────────────────────────────────────────────────────────────────────────────

function hybrid(text: string, known: boolean): string {
  const { lines, trailing } = splitLines(text)
  const shouldWrap = (line: string) => hasAnyRtl(line) && (known || dominantlyRtl(line))
  let cueRtl = lines.some(shouldWrap)
  const out = lines.map((line) => {
    if (!pyStrip(line)) {
      cueRtl = false
      return line
    }
    const clean = edgeStrip(line)
    if (shouldWrap(clean)) return wrapKeepingTags(clean)
    return known && cueRtl && isSafeLatinTail(clean) ? RLE + clean + PDF : clean
  })
  return out.join('\n') + trailing
}

function hebrewCompatibility(text: string): string {
  return mapLines(text, (line, cueHebrew) => {
    const clean = edgeStrip(line)
    if (hasHebrew(clean)) return wrapKeepingTags(clean)
    if (cueHebrew && isSafeLatinTail(clean)) return RLE + clean + PDF
    return clean
  })
}

/** gst 3.7.0 `main.py:1455-1485`: counted over the raw cue, markup and controls included. */
function gstDominantlyRtl(text: string): boolean {
  let rtl = 0
  let ltr = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    if (cp === 0x202b || cp === 0x2067 || isStrongRtl(cp)) rtl++
    else if (cp === 0x202a || cp === 0x2066 || isStrongLtr(cp)) ltr++
  }
  return rtl > ltr
}

function classic(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  const trailing = normalized.endsWith('\n') ? '\n' : ''
  const core = trailing ? normalized.slice(0, -1) : normalized
  return (gstDominantlyRtl(core) ? RLE + core + PDF : core) + trailing
}

// Kodi 0.2.548 `srt.py:74-433`, sha256 E2D010FB…DFB20, ported with Python's whitespace and `.`.
const KODI_INVISIBLE = new Set(['\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\uFEFF'])
const P = '.,;:!?…'
const HEB_LETTER = '\\u0590-\\u05FF'
const OPEN_TAGS = '(?:<[a-zA-Z!][^>]*>)*'
const CLOSE_TAGS = '(?:</[a-zA-Z][^>]*>)*'
const KODI_LEADING_PUNCT = new RegExp(
  `^(-[${PY_WS}]+)?(${OPEN_TAGS})([${P}]+)[${PY_WS}]*(${OPEN_TAGS})([${HEB_LETTER}][^\\n]*?)(${CLOSE_TAGS})[${PY_WS}]*$`
)
const KODI_ELLIPSIS = /^(?:\.{2,}|…+)$/
const KODI_TRAILING_PUNCT = new RegExp(
  `^(-[${PY_WS}]+)?(${OPEN_TAGS})((?=[^\\n]*[${HEB_LETTER}])[^\\n]*?[^${P}${PY_WS}])([${P}]+)(${CLOSE_TAGS})[${PY_WS}]*$`
)
const KODI_DASHED_LEADING_PUNCT = new RegExp(
  `^(-[${PY_WS}]+)(${OPEN_TAGS})([${P}]+)((?=[^\\n]*[${HEB_LETTER}])[^\\n]*?[^${P}${PY_WS}])(${CLOSE_TAGS})[${PY_WS}]*$`
)
const KODI_HEB_LETTER = new RegExp(`[${HEB_LETTER}]`)
const KODI_LATIN_TAIL_PUNCT = new RegExp(
  `^(-[${PY_WS}]+)?(${OPEN_TAGS})([^\\n]*?[^${P}${PY_WS}])([${P}]+)(${CLOSE_TAGS})[${PY_WS}]*$`
)

function kodiStrip(line: string): string {
  let s = pyStrip(line)
  while (s && KODI_INVISIBLE.has(s[0])) s = s.slice(1)
  while (s && KODI_INVISIBLE.has(s[s.length - 1])) s = s.slice(0, -1)
  return s
}

/** `_fix_one_text_line(line, move_ellipsis=False)`. */
function kodiFixOneLine(line: string): string {
  const stripped = kodiStrip(line)
  if (!stripped) return line
  const unchanged = stripped !== pyStrip(line) ? stripped : line
  const m = KODI_LEADING_PUNCT.exec(stripped)
  if (!m) return unchanged
  const dash = m[1] ?? ''
  const openTags = (m[2] ?? '') + (m[4] ?? '')
  const leading = m[3]
  const rest = m[5] ?? ''
  const closeTags = m[6] ?? ''
  if (KODI_ELLIPSIS.test(leading)) return unchanged
  if (!rest) return unchanged
  if (P.includes(rest[rest.length - 1])) return dash + openTags + rest + closeTags
  return dash + openTags + rest + leading + closeTags
}

/** `_reverse_fix_one_text_line(line, cue_hebrew)`. */
function kodiReverseOneLine(line: string, cueHebrew: boolean): string {
  const stripped = kodiStrip(line)
  if (!stripped) return line
  const unchanged = stripped !== pyStrip(line) ? stripped : line
  const dashed = KODI_DASHED_LEADING_PUNCT.exec(stripped)
  if (dashed && dashed[4]) return (dashed[2] ?? '') + dashed[3] + dashed[4] + (dashed[5] ?? '') + ' -'
  const m = KODI_TRAILING_PUNCT.exec(stripped)
  if (!m) {
    if (cueHebrew && !KODI_HEB_LETTER.test(stripped)) {
      const lm = KODI_LATIN_TAIL_PUNCT.exec(stripped)
      if (lm) {
        const pre = lm[3] ?? ''
        if (pre && !P.includes(pre[0])) return (lm[2] ?? '') + lm[4] + pre + (lm[5] ?? '') + (lm[1] ? ' -' : '')
      }
    }
    return unchanged
  }
  const dash = m[1] ?? ''
  const openTags = m[2] ?? ''
  const rest = m[3] ?? ''
  const trailing = m[4]
  const closeTags = m[5] ?? ''
  if (!rest) return unchanged
  if (P.includes(rest[0])) return openTags + rest + closeTags + (dash ? ' -' : '')
  return openTags + trailing + rest + closeTags + (dash ? ' -' : '')
}

/**
 * One cue's display text under `method`. `text` is canonical (no method-owned wrapper); `language` is
 * a known RTL context (an accepted run's target) or `null` for the content-only fallback.
 */
export function rtlCueText(text: string, method: RtlMethod, language: RtlLanguage | null): string {
  switch (method) {
    case 'hybrid':
      return hybrid(text, language !== null)
    case 'kodi_rtl_base':
      return hebrewCompatibility(text)
    case 'gst_compatibility':
      return classic(text)
    case 'kodi_reverse':
      return mapLines(text, kodiReverseOneLine)
    case 'kodi_legacy':
      return mapLines(text, (line) => kodiFixOneLine(line))
  }
}

export interface RtlChoice {
  /** Settings → Output → RTL subtitle formatting. Off saves canonical logical text. */
  readonly enabled: boolean
  readonly method: RtlMethod
  readonly language: RtlLanguage | null
}

export type RtlCopy = { ok: true; text: string } | { ok: false; message: string }

/**
 * The saved copy of a SubRip file: canonical text when Off, exactly one method when On. Refuses — and
 * the caller then writes nothing — when the text is not SubRip it can read cue by cue, or when the
 * copy would not read back with the same cue numbers and timings.
 */
export function rtlCopy(text: string, choice: RtlChoice): RtlCopy {
  const before = parseCues(text)
  if (!before.ok) return { ok: false, message: before.message }
  const out = mapCueText(text, (cue) => {
    const canonical = stripCueEdgeControls(cue)
    return choice.enabled ? rtlCueText(canonical, choice.method, choice.language) : canonical
  })
  if (out === null) return { ok: false, message: 'The subtitle could not be read cue by cue, so no RTL copy was made.' }
  const after = parseCues(out)
  const same =
    after.ok &&
    after.cues.length === before.cues.length &&
    after.cues.every((c, i) => c.index === before.cues[i].index && c.startMs === before.cues[i].startMs && c.endMs === before.cues[i].endMs)
  if (!same) return { ok: false, message: 'The RTL copy did not keep every subtitle and its timing, so it was not written.' }
  return { ok: true, text: out }
}
