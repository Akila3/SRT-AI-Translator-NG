/**
 * The wrong-alphabet repair for Hebrew translation output (handoff.md §13.3a, tester-directed into
 * Round 11). AUTHORED-BY: opus-5.5-high
 *
 * Flash-Lite put Arabic letters inside Hebrew words in 55–71 of 7 760 cues per run with no Arabic
 * anywhere in the prompt, and a few Cyrillic/Greek letters besides (gate_ledger.md §5c.9). This is a
 * literal port of the Kodi addon's two repairs, 0.2.566 `resources/lib/srt.py`:
 *
 *  - `strip_leaked_arabic` (`:1913-1969`) with `_clean_arabic_from_line`, `_transliterate_glued_run`,
 *    `_AR2HE`, `_PROTECTED_RE`/`_map_unprotected` (`:1570-1783`). On a line that also carries Hebrew, an
 *    Arabic run glued to a Hebrew letter (at most 8 letters, no space or punctuation) is spelled back in
 *    Hebrew letters; a standalone Arabic run is removed. A line with no Hebrew is never touched, markup
 *    and quoted text are kept byte for byte, and a rewrite that would leave the line without Hebrew is
 *    discarded.
 *  - `fold_foreign_in_hebrew_word` (`:1819-1857`): a Cyrillic, Greek or Armenian run of at most 3 letters
 *    glued to a Hebrew letter is spelled in Hebrew. A standalone foreign word is never touched.
 *
 * Applied in the addon's order (`translate.py:4996`, `:5023`), before any RTL formatting. Latin letters
 * inside a Hebrew word are out of scope: the addon has no repair for them. Python's `str.strip`/`isspace`
 * whitespace is kept where it differs from JavaScript's. Nothing here reads a file or a setting, and
 * nothing throws: as in the addon, any failure returns the text it was given.
 *
 * The caller decides when it applies — a Hebrew target only (§13.3a); it is not safe for Arabic, Persian,
 * Urdu, Pashto or Yiddish text, where it would rewrite correct words.
 */

const ARABIC_CH = '\\u0600-\\u065f\\u066a-\\u06ff\\u0750-\\u077f\\u0870-\\u089f\\u08a0-\\u08ff\\ufb50-\\ufdff\\ufe70-\\ufefc'
const HEBREW_CH = '\\u0590-\\u05ff\\ufb1d-\\ufb4f'
const ARABIC_RUN = new RegExp(`[ \\t]*[${ARABIC_CH}][${ARABIC_CH} \\t\\u0640\\u064b-\\u0652\\u060c\\u061b\\u061f]*`, 'g')
const HAS_HEBREW = new RegExp(`[${HEBREW_CH}]`)
const HAS_ARABIC = new RegExp(`[${ARABIC_CH}]`)
const STARTS_HEBREW = new RegExp(`^[${HEBREW_CH}]`)

const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_LEADING_WS = new RegExp(`^[${PY_WS}]+`)
const PY_TRAILING_WS = new RegExp(`[${PY_WS}]+$`)
const PY_SPACE_CHAR = new RegExp(`^[${PY_WS}]$`)
const pyLstrip = (s: string): string => s.replace(PY_LEADING_WS, '')
const pyRstrip = (s: string): string => s.replace(PY_TRAILING_WS, '')
const pyStrip = (s: string): string => pyRstrip(pyLstrip(s))

const RLE = '\u202B'
const PDF = '\u202C'

const AR2HE: Readonly<Record<string, string>> = {
  'ا': 'א', 'أ': 'א', 'إ': 'א', 'آ': 'א', 'ء': 'א',
  'ب': 'ב', 'ت': 'ת', 'ث': 'ת',
  'ة': 'ה',
  'ج': 'ג', 'ح': 'ח', 'خ': 'ח',
  'د': 'ד', 'ذ': 'ד',
  'ر': 'ר', 'ز': 'ז',
  'س': 'ס', 'ش': 'ש',
  'ص': 'צ', 'ض': 'צ',
  'ط': 'ט', 'ظ': 'ט',
  'ع': 'ע', 'غ': 'ע',
  'ف': 'פ', 'ق': 'ק', 'ك': 'כ',
  'ل': 'ל', 'م': 'מ', 'ن': 'נ',
  'ه': 'ה', 'و': 'ו',
  'ي': 'י', 'ى': 'י', 'ئ': 'י',
  'ؤ': 'ו'
}

const range = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => String.fromCharCode(from + i))
/** Harakat, tatweel and Quranic marks: no consonant, so they drop. */
const AR_MARKS = new Set<string>(['\u0640', ...range(0x064b, 0x0653), ...range(0x0610, 0x061b), ...range(0x0653, 0x0656), '\u0670'])
const HE_FINAL: Readonly<Record<string, string>> = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' }
const MAX_GLUED_RUN = 8

const FOREIGN2HE: Record<string, string> = {}
for (const [source, hebrew] of [
  [
    '\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044b\u044d\u044e\u044f',
    '\u05d0\u05d1\u05d5\u05d2\u05d3\u05d0\u05d6\u05d6\u05d9\u05d9\u05e7\u05dc\u05de\u05e0\u05d5\u05e4\u05e8\u05e1\u05ea\u05d5\u05e4\u05d7\u05e6\u05e6\u05e9\u05e9\u05d9\u05d0\u05d5\u05d0'
  ],
  [
    '\u03b1\u03b2\u03b3\u03b4\u03b5\u03b6\u03b7\u03b8\u03b9\u03ba\u03bb\u03bc\u03bd\u03be\u03bf\u03c0\u03c1\u03c2\u03c3\u03c4\u03c5\u03c6\u03c7\u03c8\u03c9',
    '\u05d0\u05d1\u05d2\u05d3\u05d0\u05d6\u05d0\u05ea\u05d9\u05e7\u05dc\u05de\u05e0\u05e1\u05d5\u05e4\u05e8\u05e1\u05e1\u05ea\u05d5\u05e4\u05d7\u05e4\u05d5'
  ],
  [
    '\u0561\u0562\u0563\u0564\u0565\u0566\u0567\u0568\u0569\u056a\u056b\u056c\u056d\u056e\u056f\u0570\u0571\u0572\u0573\u0574\u0575\u0576\u0577\u0578\u0579\u057a\u057b\u057c\u057d\u057e\u057f\u0580\u0581\u0582\u0583\u0584\u0585\u0586',
    '\u05d0\u05d1\u05d2\u05d3\u05d0\u05d6\u05d0\u05d0\u05ea\u05d6\u05d9\u05dc\u05d7\u05e6\u05e7\u05d4\u05d6\u05e2\u05e6\u05de\u05d9\u05e0\u05e9\u05d5\u05e6\u05e4\u05d2\u05e8\u05e1\u05d5\u05ea\u05e8\u05e6\u05d5\u05e4\u05e7\u05d5\u05e4'
  ]
]) {
  // Python's zip stops at the shorter string.
  for (let i = 0; i < Math.min(source.length, hebrew.length); i++) {
    FOREIGN2HE[source[i]] = hebrew[i]
    FOREIGN2HE[source[i].toUpperCase()] = hebrew[i]
  }
}
const escapeClass = (ch: string): string => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
const FOREIGN_CLASS = `[${Object.keys(FOREIGN2HE).sort().map(escapeClass).join('')}]+`
const FOREIGN_RUN = new RegExp(FOREIGN_CLASS, 'g')
const FOREIGN_RUN_ANY = new RegExp(FOREIGN_CLASS)
const MAX_FOREIGN_RUN = 3

/** Markup and explicitly quoted literals are data, not alphabet-slip evidence (`srt.py:1702-1704`). */
const PROTECTED_SOURCE = /<!--.*?-->|<\/?[A-Za-z][A-Za-z0-9:_-]*(?:[^<>"']|"[^"]*"|'[^']*')*>|"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/.source
const PROTECTED_ANY = new RegExp(PROTECTED_SOURCE, 's')
const PROTECTED = new RegExp(PROTECTED_SOURCE, 'gs')

function hasProtected(text: string): boolean {
  return PROTECTED_ANY.test(text)
}

/** `_map_unprotected`: protected bytes and the whitespace at each boundary stay exactly as supplied. */
function mapUnprotected(text: string, transform: (part: string) => string): string {
  const out: string[] = []
  let start = 0
  const visit = (part: string): void => {
    if (pyStrip(part)) {
      const left = part.slice(0, part.length - pyLstrip(part).length)
      const right = part.slice(pyRstrip(part).length)
      out.push(left + transform(pyStrip(part)) + right)
    } else out.push(part)
  }
  PROTECTED.lastIndex = 0
  for (const match of text.matchAll(PROTECTED)) {
    const at = match.index as number
    visit(text.slice(start, at))
    out.push(match[0])
    start = at + match[0].length
  }
  visit(text.slice(start))
  return out.join('')
}

/** `_transliterate_glued_run`: the Hebrew spelling of a run that is part of a Hebrew word, else null. */
function transliterateGluedRun(run: string, before: string, after: string, ateSpace: boolean): string | null {
  if (ateSpace) return null
  const core = run.replace(/[ \t]+$/, '')
  const tail = run.slice(core.length)
  if (!core || core.length > MAX_GLUED_RUN) return null
  const endsWord = !!tail || !(after && STARTS_HEBREW.test(after))
  const touches = (before && STARTS_HEBREW.test(before)) || (!tail && after && STARTS_HEBREW.test(after))
  if (!touches) return null
  const out: string[] = []
  for (const ch of core) {
    if (AR_MARKS.has(ch)) continue
    const he = AR2HE[ch]
    if (he === undefined) return null
    out.push(he)
  }
  if (!out.length) return null
  if (endsWord) out[out.length - 1] = HE_FINAL[out[out.length - 1]] ?? out[out.length - 1]
  return out.join('') + tail
}

const WRAP_EDGE_START = new RegExp(`^([${RLE}${PDF}]*)[ \\t]+`)
const WRAP_EDGE_END = new RegExp(`[ \\t]+([${RLE}${PDF}]*)$`)

/** `_clean_arabic_from_line`: repair visible unquoted text; keep markup and quoted literals. */
function cleanArabicFromLine(body: string): string {
  if (hasProtected(body)) return mapUnprotected(body, cleanArabicFromLine)
  let cleaned = body.replace(ARABIC_RUN, (match: string, start: number) => {
    const end = start + match.length
    const ateSpace = match[0] === ' ' || match[0] === '\t'
    const after = body.slice(end, end + 1)
    const before = start ? body.slice(start - 1, start) : ''
    const glued = transliterateGluedRun(match, before, after, ateSpace)
    if (glued !== null) return glued
    const tight = !ateSpace && !!after && !PY_SPACE_CHAR.test(after) && !!before && !PY_SPACE_CHAR.test(before)
    return tight ? '' : ' '
  })
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ')
  cleaned = cleaned.replace(/[ \t]+(<\/)/g, '$1')
  cleaned = cleaned.replace(WRAP_EDGE_START, '$1')
  cleaned = cleaned.replace(WRAP_EDGE_END, '$1')
  cleaned = pyStrip(cleaned)
  if (pyLstrip(body).startsWith('-') && cleaned && !cleaned.startsWith('-')) cleaned = '- ' + cleaned
  return cleaned
}

/** Each `\n` line of `text`, its trailing `\r` kept aside, through `fix`; joined back unchanged. */
function eachLine(text: string, fix: (body: string) => string): string {
  return text
    .split('\n')
    .map((line) => {
      const cr = line.endsWith('\r') ? '\r' : ''
      const body = cr ? line.slice(0, -1) : line
      return fix(body) + cr
    })
    .join('\n')
}

/** `strip_leaked_arabic`: no cue, no line and no line's Hebrew is ever removed. */
export function stripLeakedArabic(text: string): string {
  if (!text) return text
  try {
    if (hasProtected(text)) return mapUnprotected(text, stripLeakedArabic)
    if (!HAS_ARABIC.test(text)) return text
    return eachLine(text, (body) => {
      if (!(HAS_ARABIC.test(body) && HAS_HEBREW.test(body))) return body
      const cleaned = cleanArabicFromLine(body)
      return cleaned && HAS_HEBREW.test(cleaned) ? cleaned : body
    })
  } catch {
    return text
  }
}

/** `fold_foreign_in_hebrew_word`: only a short run glued to a Hebrew letter; adds Hebrew, removes nothing else. */
export function foldForeignInHebrewWord(text: string): string {
  if (!text) return text
  try {
    if (hasProtected(text)) return mapUnprotected(text, foldForeignInHebrewWord)
    if (!FOREIGN_RUN_ANY.test(text)) return text
    return eachLine(text, (body) => {
      if (!HAS_HEBREW.test(body)) return body
      return body.replace(FOREIGN_RUN, (run: string, at: number) => {
        if (run.length > MAX_FOREIGN_RUN) return run
        const before = at ? body.slice(at - 1, at) : ''
        const after = body.slice(at + run.length, at + run.length + 1)
        if (!((before && STARTS_HEBREW.test(before)) || (after && STARTS_HEBREW.test(after)))) return run
        const he = [...run].map((c) => FOREIGN2HE[c])
        if (!(after && STARTS_HEBREW.test(after))) he[he.length - 1] = HE_FINAL[he[he.length - 1]] ?? he[he.length - 1]
        return he.join('')
      })
    })
  } catch {
    return text
  }
}

export interface WrongAlphabetRepair {
  text: string
  /** Lines the Arabic step rewrote, counted as the addon counts them (`translate.py:4999-5000`). */
  arabicLines: number
  /** Lines the Cyrillic/Greek/Armenian step rewrote. */
  foreignLines: number
}

function changedLines(before: string, after: string): number {
  const a = before.split('\n')
  const b = after.split('\n')
  let n = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++
  return n
}

/**
 * Both repairs, in the addon's order, on one cue's text. The line count never changes; a result that
 * did would be refused by the caller and the cue kept as it was.
 */
export function repairWrongAlphabet(text: string): WrongAlphabetRepair {
  const arabic = stripLeakedArabic(text)
  const folded = foldForeignInHebrewWord(arabic)
  return { text: folded, arabicLines: changedLines(text, arabic), foreignLines: changedLines(arabic, folded) }
}
