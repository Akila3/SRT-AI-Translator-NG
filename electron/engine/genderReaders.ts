/**
 * Bundle H: the designated Hebrew gender readers and the helper-eligibility rules (H17–H20, H19a/b).
 *
 * Two readers, never a vote between them:
 * - **Addressee** is the Kodi add-on's (`0.2.533 arabic_gender.py:497-711`): `addressesFemale` /
 *   `addressesMale` on Hebrew, `referenceAddresseeGender` on a helper line (Hebrew, Arabic, and the nine
 *   `_ADDRESSEE_MARKERS` languages), plus the default-OFF Spanish/Portuguese rules (Feature 17 C1).
 * - **Speaker** is `heb_gender.detect()[0]` as corrected by the source-item-17 research:
 *   `מנסה` out of both present lists, and present-tense
 *   forms do not vote for the speaker when a confirmed second-person pronoun is also present.
 *
 * Every reader reads ORIGINAL cue text (`feature_decisions.md` §2.9a) and returns `null` for "does not mark it".
 * The Python patterns are ported with Python's Unicode semantics: `\w` is a letter, digit or `_` in any script,
 * `\b` is a boundary of that class, and `$` also matches before one final newline.
 */
import { REF_CHAIN_WITH_DE } from '../shared/genderReference'

export type Gender = 'M' | 'F'
export type Reading = Gender | null
export type GenderAxis = 'addressee' | 'speaker'

/** Python's Unicode `\w`, `\b`, and `$` without MULTILINE. */
const W = '[\\p{L}\\p{N}_]'
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`
const PY_END = '(?=\\n?$)'
/** Python `re.I | re.U` → JavaScript `iu`; Python `\w`/`\b` → the classes above. */
function pyUnicode(pattern: string): RegExp {
  return new RegExp(pattern.replace(/\\b/g, B).replace(/\\w/g, W), 'iu')
}

/**
 * Invisible direction marks are not text: a human Hebrew file that starts a line with U+202B still starts it
 * with `את` (Round 19A A.1, `gate_ledger.md` §5s.24). Every reader below reads through this.
 */
const DIRECTION_MARKS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/g
function visible(text: string | null | undefined): string {
  return (text ?? '').replace(DIRECTION_MARKS, '')
}
export const withoutDirectionMarks = visible

// ── Arabic (helper line) ───────────────────────────────────────────────────────

const AR = '\\u0621-\\u064a'
/** The consonantal 2fs present suffix, six-letter floor, closed clitic set (`arabic_gender.py:532-533`). */
const AR_2FS_PRESENT =
  `(?<![${AR}])\\u062a[${AR}]{2,5}[\\u0621-\\u0629\\u062b-\\u064a]\\u064a\\u0646` +
  '(?:\\u0646\\u064a|\\u0647\\u0645\\u0627|\\u0647\\u0627|\\u0647\\u0645|\\u0647\\u0646|\\u0643\\u0645|\\u0647|\\u0643)?' +
  `(?![${AR}])`
const AR_FEM: readonly RegExp[] = [
  '\\u0623\\u0646\\u062a\\u0650', '\\u0644\\u0643\\u0650', '\\u0628\\u0643\\u0650', '\\u0639\\u0644\\u064a\\u0643\\u0650',
  '\\u0645\\u0639\\u0643\\u0650', '\\u0625\\u0644\\u064a\\u0643\\u0650', '\\u0645\\u0646\\u0643\\u0650',
  '\\u0643\\u0650\\s', `\\u0643\\u0650${PY_END}`, '\\u062a\\u0650\\s', `\\u062a\\u0650${PY_END}`, '\\u064a\\u0627 \\u0633\\u064a\\u062f\\u062a\\u064a',
  AR_2FS_PRESENT
].map((p) => new RegExp(p, 'u'))
const AR_MASC: readonly RegExp[] = [
  '\\u0623\\u0646\\u062a\\u064e', '\\u0644\\u0643\\u064e', '\\u0628\\u0643\\u064e', '\\u0639\\u0644\\u064a\\u0643\\u064e',
  '\\u0645\\u0639\\u0643\\u064e', '\\u0625\\u0644\\u064a\\u0643\\u064e', '\\u0645\\u0646\\u0643\\u064e',
  '\\u0643\\u064e\\s', `\\u0643\\u064e${PY_END}`, '\\u062a\\u064e\\s', `\\u062a\\u064e${PY_END}`
].map((p) => new RegExp(p, 'u'))
/** Nouns that wear the 2fs shape: exercises, dragons, with possessives (`arabic_gender.py:525-527`). */
const AR_NOUN_EXCEPTIONS = new RegExp(`(?<![${AR}])(?:تمارين|تنانين)(?:ها|هما|هم|هن|ه|كم|كن|ك|نا|ي)?(?![${AR}])`, 'gu')

// ── Hebrew ────────────────────────────────────────────────────────────────────

const HE = 'א-ת'
/** The proclitics glued to a pronoun: and, that, when, and their combinations (`arabic_gender.py:533`). */
const HE_PRO = '(?:ו|ש|כש|וש|וכש)?'
/** Unpointed `את` as a pronoun: not followed by a definite noun (`arabic_gender.py:534-535`). */
const HE_REF_FEM = new RegExp(`(?<![${HE}])${HE_PRO}את(?![${HE}])(?!\\s*ה)`, 'gu')
const HE_FEM_VERB = new RegExp(`(?<![${HE}])${HE_PRO}(?:תגידי|תסמכי|תשמרי|תעשי|תבואי|תלכי|תחכי|תקחי|תתני|תדברי|תראי|תשמעי)(?![${HE}])`, 'u')
const HE_FEM_IMPER = new RegExp(`(?<![${HE}])${HE_PRO}(?:בואי|לכי|חכי|קחי|תני|סלחי|עזרי)(?![${HE}])`, 'u')
/** A clause-leading `את`, or one after a subordinating clitic (`arabic_gender.py:548-550`). */
const HE_FEM_CLAUSE = new RegExp(`(?:^|[.!?\\n,:;—-])\\s*(?:ו)?את(?![${HE}])|(?<![${HE}])(?:ש|כש|וש|וכש)את(?![${HE}])`, 'gu')
/** What makes `את` an object marker, matched at the start of the text after it (`arabic_gender.py:553-554`). */
const HE_AT_OBJ = new RegExp(`^\\s+(?:זה|זאת|זו|אלה|אלו|כל(?!\\s+כך)|מה|מי|עצמ|אות|כך|של|ה(?!ולכת\\s+(?:בלי|איתי)(?![${HE}]))[${HE}])`, 'u')
/** The reviewed predicates a feminine `את` must lead into (`arabic_gender.py:557-560`). */
const HE_AT_PREDICATE = new RegExp(
  '^\\s+(?:(?:כל\\s+כך|מאוד|ממש|ודאי|בטעות|כבר|עדיין|לא)\\s+){0,3}' +
    `(?:יפה|מוכנה|מבהילה|מפחידה|מעמידה|יודעת|חוזרת|צריכה|יכולה|רוצה|חייבת|בטוחה|עייפה|צודקת|טועה|מבינה|מקשיבה|מדברת|הולכת|נראית)(?![${HE}])`,
  'u'
)
/** `אתה` with its proclitics; never the `אתה` inside `ראתה` (`arabic_gender.py:578-579`). */
const HE_MASC = new RegExp(`(?<![${HE}])(?:ו|ש|כש|וש|וכש)?אתה(?![${HE}])`, 'u')

function clauseFeminine(text: string, finder: RegExp): boolean {
  for (const m of text.matchAll(finder)) {
    const tail = text.slice((m.index ?? 0) + m[0].length)
    if (!HE_AT_OBJ.test(tail) && HE_AT_PREDICATE.test(tail)) return true
  }
  return false
}

/** `_he_addresses_female`: conservative feminine-address evidence; uncertain Hebrew abstains. */
function heAddressesFemale(text: string): boolean {
  try {
    if (HE_FEM_VERB.test(text) || HE_FEM_IMPER.test(text)) return true
    return clauseFeminine(text, HE_FEM_CLAUSE)
  } catch {
    return false
  }
}

/** Moran `addresses_female`: feminine-address candidate; not speaker or referent identity. */
export function addressesFemale(text: string | null | undefined): boolean {
  return heAddressesFemale(visible(text))
}

/** Moran `addresses_male`: the masculine second-person pronoun, with its proclitics. */
export function addressesMale(text: string | null | undefined): boolean {
  try {
    return HE_MASC.test(visible(text))
  } catch {
    return false
  }
}

/** The addressee axis of a Hebrew line: F or M only when exactly one reader fires. */
export function hebrewAddressee(text: string | null | undefined): Reading {
  const f = addressesFemale(text)
  const m = addressesMale(text)
  if (f === m) return null
  return f ? 'F' : 'M'
}

/** The "you" pronoun alone: a pronoun `את` (not an object marker) → F, `אתה` → M; both or neither → null. */
export function pronounAddressee(text: string | null | undefined): Reading {
  const t = visible(text)
  let f = false
  for (const m of t.matchAll(HE_REF_FEM)) if (!HE_AT_OBJ.test(t.slice((m.index ?? 0) + m[0].length))) f = true
  const m = HE_MASC.test(t)
  if (f === m) return null
  return f ? 'F' : 'M'
}

/**
 * The output reading behind a C1 addressee correction (Round 19A A.6, D19A-2): the Hebrew reader, or, where it
 * abstains, the pronoun alone. The C1 evidence already says who is addressed; the pronoun says which gender the
 * Hebrew gave them (`את משוגעת`, `את לבדך`). The base reader is not changed.
 */
export function c1OutputAddressee(text: string | null | undefined): Reading {
  return hebrewAddressee(text) ?? pronounAddressee(text)
}

// ── the other chain languages' addressee markers (`arabic_gender.py:614-641`) ──

const ADDRESSEE_MARKERS: Readonly<Record<string, readonly [readonly RegExp[], readonly RegExp[]]>> = Object.freeze({
  ru: [[pyUnicode('(?<![\\u0430-\\u044f\\u0451])\\u0442\\u044b\\b[^.!?]{0,40}?\\b\\w+\\u043b\\u0430\\b')], [pyUnicode('(?<![\\u0430-\\u044f\\u0451])\\u0442\\u044b\\b[^.!?]{0,40}?\\b\\w+\\u043b\\b')]],
  uk: [[pyUnicode('(?<![\\u0430-\\u044f\\u0456\\u0457])\\u0442\\u0438\\b[^.!?]{0,40}?\\b\\w+\\u043b\\u0430\\b')], [pyUnicode('(?<![\\u0430-\\u044f\\u0456\\u0457])\\u0442\\u0438\\b[^.!?]{0,40}?\\b\\w+(\\u0432|\\u0438\\u0439)\\b')]],
  bg: [[pyUnicode('(?<![\\u0430-\\u044f])\\u0442\\u0438\\b[^.!?]{0,40}?\\b\\w+(\\u043b\\u0430|\\u043d\\u0430)\\b')], [pyUnicode('(?<![\\u0430-\\u044f])\\u0442\\u0438\\b[^.!?]{0,40}?\\b\\w+(\\u0435\\u043d|\\u043b)\\b')]],
  pl: [[pyUnicode('\\w+\\u0142a\\u015b\\b')], [pyUnicode('\\w+\\u0142e\\u015b\\b')]],
  cs: [[pyUnicode('\\w+la\\s+jsi\\b')], [pyUnicode('\\w+l\\s+jsi\\b')]],
  sk: [[pyUnicode('\\w+la\\s+si\\b')], [pyUnicode('\\w+l\\s+si\\b')]],
  sr: [[pyUnicode('\\bti\\s+si\\b[^.!?]{0,30}?\\b\\w+la\\b')], [pyUnicode('\\bti\\s+si\\b[^.!?]{0,30}?\\b\\w+(ao|io)\\b')]],
  hr: [[pyUnicode('\\bti\\s+si\\b[^.!?]{0,30}?\\b\\w+la\\b')], [pyUnicode('\\bti\\s+si\\b[^.!?]{0,30}?\\b\\w+(ao|io)\\b')]],
  hi: [[pyUnicode('(\\u0924\\u0941\\u092e|\\u0906\\u092a)[^\\u0964?!]{0,30}?\\u0940\\s+(\\u0939\\u094b|\\u0939\\u0948\\u0902)')], [pyUnicode('(\\u0924\\u0941\\u092e|\\u0906\\u092a)[^\\u0964?!]{0,30}?\\u0947\\s+(\\u0939\\u094b|\\u0939\\u0948\\u0902)')]]
})

/** The languages `referenceAddresseeGender` reads. Anything else returns null. */
export const ADDRESSEE_READER_LANGUAGES: readonly string[] = Object.freeze(['he', 'ar', ...Object.keys(ADDRESSEE_MARKERS)])

/**
 * Moran `reference_addressee_gender`: F, M, or null when the helper line does not mark it unambiguously.
 * Hebrew and Arabic are read directly; the nine `_ADDRESSEE_MARKERS` languages by their own pattern pair.
 */
export function referenceAddresseeGender(text: string | null | undefined, lang: string): Reading {
  const refText = visible(text)
  if (!refText) return null
  try {
    let f: boolean
    let m: boolean
    if (lang === 'he') {
      f = heAddressesFemale(refText)
      m = HE_MASC.test(refText)
    } else if (lang === 'ar') {
      const signal = refText.replace(AR_NOUN_EXCEPTIONS, ' ')
      f = AR_FEM.some((p) => p.test(signal))
      m = AR_MASC.some((p) => p.test(refText))
    } else if (Object.prototype.hasOwnProperty.call(ADDRESSEE_MARKERS, lang)) {
      const [fem, masc] = ADDRESSEE_MARKERS[lang]
      f = fem.some((p) => p.test(refText))
      m = masc.some((p) => p.test(refText))
    } else {
      return null
    }
    if (f && !m) return 'F'
    if (m && !f) return 'M'
    return null
  } catch {
    return null
  }
}

// ── Feature 17 C1: Spanish and Portuguese (`gender_extras_research.py:316-405`) ──

const ES_FORMS: Readonly<Record<Gender, ReadonlySet<string>>> = {
  F: new Set(['cansada', 'preparada', 'lista', 'segura', 'loca', 'equivocada', 'preocupada', 'asustada', 'sola', 'casada', 'enamorada', 'muerta', 'viva', 'ocupada']),
  M: new Set(['cansado', 'preparado', 'listo', 'seguro', 'loco', 'equivocado', 'preocupado', 'asustado', 'solo', 'casado', 'enamorado', 'muerto', 'vivo', 'ocupado'])
}
const PT_FORMS: Readonly<Record<Gender, ReadonlySet<string>>> = {
  F: new Set(['cansada', 'pronta', 'certa', 'errada', 'preocupada', 'assustada', 'sozinha', 'casada', 'apaixonada', 'morta', 'viva', 'ocupada', 'louca', 'obrigada']),
  M: new Set(['cansado', 'pronto', 'certo', 'errado', 'preocupado', 'assustado', 'sozinho', 'casado', 'apaixonado', 'morto', 'vivo', 'ocupado', 'louco', 'obrigado'])
}
const ES_PREDICATE = new RegExp(
  `(?<!${W})(?:(?:tú|vos)\\s+)?(?:estás|eres|pareces|te\\s+sientes)\\s+(?:(?:muy|tan|bastante|realmente)\\s+)?(${W}+)(?!${W})`,
  'giu'
)
const PT_PREDICATE = new RegExp(
  `(?<!${W})(?:(?:você)\\s+(?:está|é|parece|se\\s+sente)|(?:tu\\s+)?(?:estás|és|pareces|te\\s+sentes))\\s+(?:(?:muito|tão|bastante|realmente)\\s+)?(${W}+)(?!${W})`,
  'giu'
)

export type C1Language = 'es' | 'pt'

/** A second-person predicate adjective from a short reviewed list; both genders present → null. */
export function romanceAddressee(text: string | null | undefined, language: C1Language): Reading {
  const [matcher, forms] = language === 'es' ? [ES_PREDICATE, ES_FORMS] : [PT_PREDICATE, PT_FORMS]
  const votes = new Set<Gender>()
  for (const m of visible(text).matchAll(matcher)) {
    const word = m[1].toLowerCase()
    for (const g of ['F', 'M'] as const) if (forms[g].has(word)) votes.add(g)
  }
  return votes.size === 1 ? [...votes][0] : null
}

// ── the speaker reader (corrected `heb_gender.detect()[0]`) ────────────────────

const PRESENT_SG: Readonly<Record<Gender, ReadonlySet<string>>> = {
  M: new Set(['הולך', 'יכול', 'אומר', 'יודע', 'בא', 'צריך', 'עובד', 'מדבר', 'חושב', 'מרגיש', 'מוכן', 'בטוח', 'עייף', 'גדול', 'קטן', 'שמח', 'מצטער', 'נשאר', 'יושב', 'עומד', 'זוכר', 'מבין', 'מת', 'אוהב', 'חייב', 'נותן', 'לוקח', 'מבקש', 'מנסה', 'חוזר', 'קולט', 'מעביר', 'רוצֶה']),
  F: new Set(['הולכת', 'יכולה', 'אומרת', 'יודעת', 'באה', 'צריכה', 'עובדת', 'מדברת', 'חושבת', 'מרגישה', 'מוכנה', 'בטוחה', 'עייפה', 'גדולה', 'קטנה', 'שמחה', 'מצטערת', 'נשארת', 'יושבת', 'עומדת', 'זוכרת', 'מבינה', 'מתה', 'אוהבת', 'חייבת', 'נותנת', 'לוקחת', 'מבקשת', 'מנסה', 'חוזרת', 'קולטת', 'מעבירה'])
}
const PRESENT_PL: Readonly<Record<Gender, ReadonlySet<string>>> = {
  M: new Set(['הולכים', 'יכולים', 'אומרים', 'יודעים', 'באים', 'צריכים', 'עובדים', 'מדברים', 'חושבים', 'מרגישים', 'מוכנים', 'בטוחים', 'עייפים', 'גדולים', 'קטנים', 'שמחים', 'יושבים', 'עומדים', 'זוכרים', 'מבינים']),
  F: new Set(['הולכות', 'יכולות', 'אומרות', 'יודעות', 'באות', 'צריכות', 'עובדות', 'מדברות', 'חושבות', 'מרגישות', 'מוכנות', 'בטוחות', 'עייפות', 'גדולות', 'קטנות', 'שמחות', 'יושבות', 'עומדות', 'זוכרות', 'מבינות'])
}
/** Final-heh present verbs shared by both genders, and invariant adjectives: no evidence. */
const AMBIGUOUS_WORDS: ReadonlySet<string> = new Set(['רוצה', 'עושה', 'רואה', 'קונה', 'שותה', 'בונה', 'פונה', 'יפה', 'מחכה'])
/** Longest first. */
const CLITICS = ['וכש', 'מש', 'כש', 'וש', 'ול', 'וב', 'ומ', 'וה', 'ש', 'ו', 'ה', 'כ', 'ל', 'ב', 'מ'] as const
const HE_WORD = /[א-ת׳״']+/gu
/** The `אתן` predicates that confirm a feminine-plural "you" rather than "I will give". */
const FEMININE_PLURAL: ReadonlySet<string> = new Set(['יודעות', 'מוכנות', 'עייפות', 'צודקות', 'טועות', 'מבינות', 'מקשיבות', 'מדברות', 'הולכות', 'נראות', 'חוזרות', 'צריכות', 'יכולות', 'רוצות', 'חייבות', 'בטוחות'])

function stripPrefix(word: string): string {
  for (const c of CLITICS) if (word.startsWith(c) && word.length - c.length >= 3) return word.slice(c.length)
  return word
}

function matchGender(words: ReadonlySet<string>, forms: Readonly<Record<Gender, ReadonlySet<string>>>): Set<Gender> {
  const out = new Set<Gender>()
  for (const g of ['M', 'F'] as const) for (const w of words) if (forms[g].has(w)) {
    out.add(g)
    break
  }
  return out
}

/**
 * The dual-anchor mute (H19b): a confirmed second-person pronoun. `אתה` with proclitics; whole-token `אתם`;
 * `אתן` only with a feminine-plural predicate; a clause `את` or a guarded `את` leading into a reviewed predicate.
 * Never raw `את`, never the whole `addressesFemale`.
 */
function confirmedSecondPerson(text: string, words: ReadonlySet<string>): boolean {
  if (HE_MASC.test(text)) return true
  if (words.has('אתם')) return true
  if (words.has('אתן') && [...words].some((w) => FEMININE_PLURAL.has(w))) return true
  return clauseFeminine(text, HE_FEM_CLAUSE) || clauseFeminine(text, HE_REF_FEM)
}

/** What opens a speaker clause: the first-person pronouns, and `הייתי` ("I was", `הייתי צריכה`). */
const FIRST_PERSON: ReadonlySet<string> = new Set(['אני', 'אנחנו', 'אנו', 'הייתי'])
/** A subject that is not the speaker: the words after it are its own (`שהוא מת`, `כל אחד עובד`). */
const OTHER_SUBJECT: ReadonlySet<string> = new Set(['הוא', 'היא', 'הם', 'הן', 'זה', 'זאת', 'זו', 'אחד', 'אחת', 'מישהו', 'מישהי', 'כולם', 'אתה', 'אתם', 'אתן'])
/** Hebrew drops "I" from these at the start of a sentence: `לא יודעת, אבל…`, `מצטער, אני…`. */
const PRONOUN_DROPPED: ReadonlySet<string> = new Set(['יודע', 'יודעת', 'מצטער', 'מצטערת'])
/** Right after "I" these are a copula, not a new subject: `אני הוא זה ש…`, `אני זו ש…`. */
const COPULA: ReadonlySet<string> = new Set(['הוא', 'היא', 'זה', 'זו', 'זאת'])
const SUBJECT_PROCLITIC = /^(?:וכש|כש|וש|ש|ו)/u
/** A Hebrew word, an ellipsis (a pause), a clause end, a dialogue dash at a line start, or a comma. */
const CLAUSE_TOKENS = /[א-ת׳״']+|\.{2,}|…|[.!?;:]|(?:^|\n)[ \t]*-|,/gu
const HE_LETTER_FIRST = /^[א-ת]/u

/**
 * The words the speaker says about themself (Round 19A A.2): from a first-person anchor to the next clause end,
 * dialogue dash or other subject, plus a pronoun-dropped `(לא) יודע` / `מצטער` that opens a sentence. A present
 * form outside every such clause is someone else's.
 */
function speakerClauseWords(t: string): Set<string> {
  const out = new Set<string>()
  let open = false
  let sentenceStart = true
  /** The previous token opened the clause (or continued its copula), with no comma since. */
  let afterAnchor = false
  for (const [tok] of t.matchAll(CLAUSE_TOKENS)) {
    if (tok === '…' || tok.startsWith('..')) continue
    if (tok === ',') {
      afterAnchor = false
      continue
    }
    if (!HE_LETTER_FIRST.test(tok)) {
      open = false
      sentenceStart = true
      afterAnchor = false
      continue
    }
    const bare = tok.replace(SUBJECT_PROCLITIC, '')
    if (sentenceStart && PRONOUN_DROPPED.has(tok)) out.add(tok)
    sentenceStart = sentenceStart && tok === 'לא'
    if (FIRST_PERSON.has(tok) || FIRST_PERSON.has(bare)) {
      open = true
      afterAnchor = true
    } else if (afterAnchor && COPULA.has(tok)) {
      afterAnchor = true
    } else if (OTHER_SUBJECT.has(tok) || OTHER_SUBJECT.has(bare)) {
      open = false
      afterAnchor = false
    } else {
      afterAnchor = false
      if (open) {
        out.add(tok)
        out.add(stripPrefix(tok))
      }
    }
  }
  return out
}

const SECOND_PERSON: ReadonlySet<string> = new Set(['אתה', 'את', 'אתם', 'אתן'])
const THIRD_SUBJECT: ReadonlySet<string> = new Set([...OTHER_SUBJECT].filter((w) => !SECOND_PERSON.has(w)))

export interface ClauseWord {
  readonly word: string
  /** Offset of the word in the mark-free text. */
  readonly at: number
  /** Whose clause the word is in: the speaker's ("I …") or the addressee's ("you …"); null when neither. */
  readonly axis: GenderAxis | null
}

/**
 * Every Hebrew word of a line with the clause it belongs to (Round 19A A.4). The speaker clause follows A.2's
 * rule; a second-person pronoun (`את` only when it is not an object marker) opens an addressee clause, which a
 * clause end, a dialogue dash, a first-person pronoun or a third-person subject closes.
 */
export function clauseWords(text: string | null | undefined): { text: string; words: ClauseWord[] } {
  const t = visible(text)
  const words: ClauseWord[] = []
  let open: GenderAxis | null = null
  let sentenceStart = true
  let afterAnchor = false
  for (const m of t.matchAll(CLAUSE_TOKENS)) {
    const tok = m[0]
    const at = m.index ?? 0
    if (tok === '…' || tok.startsWith('..')) continue
    if (tok === ',') {
      afterAnchor = false
      continue
    }
    if (!HE_LETTER_FIRST.test(tok)) {
      open = null
      sentenceStart = true
      afterAnchor = false
      continue
    }
    const bare = tok.replace(SUBJECT_PROCLITIC, '')
    const dropped = sentenceStart && PRONOUN_DROPPED.has(tok)
    sentenceStart = sentenceStart && tok === 'לא'
    if (FIRST_PERSON.has(tok) || FIRST_PERSON.has(bare)) {
      open = 'speaker'
      afterAnchor = true
      words.push({ word: tok, at, axis: null })
    } else if (afterAnchor && COPULA.has(tok)) {
      words.push({ word: tok, at, axis: null })
    } else if (SECOND_PERSON.has(bare) && !(bare === 'את' && HE_AT_OBJ.test(t.slice(at + tok.length)))) {
      open = 'addressee'
      afterAnchor = false
      words.push({ word: tok, at, axis: 'addressee' })
    } else if (THIRD_SUBJECT.has(tok) || THIRD_SUBJECT.has(bare)) {
      open = null
      afterAnchor = false
      words.push({ word: tok, at, axis: null })
    } else {
      afterAnchor = false
      words.push({ word: tok, at, axis: dropped ? 'speaker' : open })
    }
  }
  return { text: t, words }
}

/** The speaker axis of a Hebrew line: present-tense gender inside a first-person clause, muted by a confirmed "you". */
export function speakerGender(text: string | null | undefined): Reading {
  const t = visible(text)
  const raw = new Set(t.match(HE_WORD) ?? [])
  const words = new Set(raw)
  for (const w of raw) words.add(stripPrefix(w))
  for (const w of AMBIGUOUS_WORDS) words.delete(w)
  words.delete('מנסה')
  const hasSpeaker = words.has('אני') || words.has('אנחנו') || words.has('אנו')
  if (!hasSpeaker || confirmedSecondPerson(t, words)) return null
  const clause = speakerClauseWords(t)
  for (const w of AMBIGUOUS_WORDS) clause.delete(w)
  clause.delete('מנסה')
  const present = matchGender(clause, PRESENT_SG)
  for (const g of matchGender(clause, PRESENT_PL)) present.add(g)
  return present.size === 1 ? [...present][0] : null
}

// ── mixed address: a "you" that disagrees with its own verb (Round 19A A.3) ─────

const HE_INTENSIFIERS = '(?:(?:כל\\s+כך|מאוד|ממש|ודאי|בטעות|כבר|עדיין|לא|באמת|פשוט|גם)\\s+){0,3}'
/** `HE_AT_PREDICATE`'s reviewed words without the forms both genders share (`רוצה`, `יפה`, `טועה`). */
const HE_FEM_PREDICATE_WORDS: ReadonlySet<string> = new Set(['מוכנה', 'מבהילה', 'מפחידה', 'מעמידה', 'יודעת', 'חוזרת', 'צריכה', 'יכולה', 'חייבת', 'בטוחה', 'עייפה', 'צודקת', 'מבינה', 'מקשיבה', 'מדברת', 'הולכת', 'נראית'])
/** `אתה` with its proclitics, then up to three intensifiers, then the next word. */
const HE_MASC_THEN_WORD = new RegExp(`(?<![${HE}])(?:ו|ש|כש|וש|וכש)?אתה\\s+${HE_INTENSIFIERS}([${HE}]+)`, 'gu')
/** A clause `את` (as `HE_FEM_CLAUSE`), then up to three intensifiers, then the next word. */
const HE_CLAUSE_FEM_THEN_WORD = new RegExp(
  `(?:(?:^|[.!?\\n,:;—-])\\s*(?:ו)?|(?<![${HE}])(?:ש|כש|וש|וכש))את\\s+${HE_INTENSIFIERS}([${HE}]+)`,
  'gu'
)
/**
 * Reviewed second-person feminine futures. A shape test (`ת..י`) also matches masculine words such as `תלוי`
 * and `תורכי` (validator R19A-01), so only listed verbs count.
 */
const HE_2FS_FUTURE: ReadonlySet<string> = new Set([
  'תוכלי', 'תלכי', 'תגידי', 'תעשי', 'תבואי', 'תראי', 'תהיי', 'תצטרכי', 'תרצי', 'תחזרי', 'תשבי', 'תקחי', 'תתני',
  'תשמעי', 'תדברי', 'תחשבי', 'תזכרי', 'תביני', 'תגיעי', 'תישארי', 'תעזבי', 'תאמרי', 'תכתבי', 'תאכלי', 'תשתי',
  'תספרי', 'תבקשי', 'תנסי', 'תעזרי', 'תפסיקי', 'תחכי', 'תדאגי', 'תסלחי', 'תשכחי', 'תצאי', 'תיכנסי'
])

function genderedPresent(word: string, g: Gender): boolean {
  return !AMBIGUOUS_WORDS.has(word) && word !== 'מנסה' && PRESENT_SG[g].has(word)
}

/**
 * The line holds a "you" whose own predicate is the other gender: `אתה חושבת`, `אתה תוכלי`, or a clause
 * `את חושב`. A repair reply that creates one is ungrammatical whatever the requested axis reads.
 */
export function mixedAddress(text: string | null | undefined): boolean {
  const t = visible(text)
  for (const m of t.matchAll(HE_MASC_THEN_WORD)) {
    const w = m[1]
    if (genderedPresent(w, 'F') || HE_FEM_PREDICATE_WORDS.has(w) || HE_2FS_FUTURE.has(w)) return true
  }
  for (const m of t.matchAll(HE_CLAUSE_FEM_THEN_WORD)) {
    const tail = t.slice((m.index ?? 0) + m[0].indexOf('את') + 2)
    if (!HE_AT_OBJ.test(tail) && genderedPresent(m[1], 'M')) return true
  }
  return false
}

// ── reference languages ───────────────────────────────────────────────────────

/**
 * `_REF_CHAIN` (§3.4; `arabic_gender.py:247-248` plus `de` after `fr`): the one ordered list, shared with the
 * Translate page and the walk. The walk skips `de` by rule, never by a second list.
 */
export const REF_CHAIN: readonly string[] = REF_CHAIN_WITH_DE

/** `_REF_LANG_ALIASES` (`arabic_gender.py:263-283`), plus German for 2b prefer and Feature 1 (E47/W-de-5). */
const REF_LANG_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  he: ['he', 'iw', 'heb', 'hebrew'],
  ar: ['ar', 'ara', 'arabic'],
  es: ['es', 'sp', 'spa', 'spanish'],
  fr: ['fr', 'fre', 'fra', 'french'],
  ru: ['ru', 'rus', 'russian'],
  it: ['it', 'ita', 'italian'],
  pt: ['pt', 'por', 'pb', 'pob', 'pt-br', 'ptbr', 'portuguese', 'brazilian portuguese', 'brazillian portuguese'],
  pl: ['pl', 'pol', 'polish'],
  uk: ['uk', 'ukr', 'ukrainian'],
  hi: ['hi', 'hin', 'hindi'],
  cs: ['cs', 'cze', 'ces', 'czech'],
  ro: ['ro', 'rum', 'ron', 'romanian'],
  el: ['el', 'gr', 'gre', 'ell', 'greek'],
  bg: ['bg', 'bul', 'bulgarian'],
  sr: ['sr', 'srp', 'scc', 'serbian'],
  hr: ['hr', 'hrv', 'scr', 'croatian'],
  sk: ['sk', 'slo', 'slk', 'slovak'],
  ur: ['ur', 'urd', 'urdu'],
  nl: ['nl', 'dut', 'nld', 'dutch'],
  de: ['de', 'ger', 'deu', 'german']
})
const ALIAS_TO_CODE: ReadonlyMap<string, string> = new Map(Object.entries(REF_LANG_ALIASES).flatMap(([code, aliases]) => aliases.map((a) => [a, code] as const)))

/** A provider's or the detector's language label as a reference code (`pt-BR` → `pt`), or null. */
export function referenceLanguage(label: string | null | undefined): string | null {
  const l = (label ?? '').trim().toLowerCase().replace('_', '-')
  if (!l) return null
  return ALIAS_TO_CODE.get(l) ?? ALIAS_TO_CODE.get(l.split('-')[0]) ?? null
}

/**
 * Reference languages with gender-prompt wording for a Hebrew target besides `he` and `ar`: the add-on's
 * `_GENDER_SIGNALS` rows (`prompt.py:206-240`) and NG's dedicated German row (W-de-5). `prompt.ts` owns the text.
 */
export const GENDER_SIGNAL_LANGUAGES: readonly string[] = Object.freeze(['es', 'fr', 'ru', 'it', 'pt', 'pl', 'uk', 'hi', 'cs', 'ro', 'el', 'bg', 'sr', 'hr', 'sk', 'ur', 'nl', 'de'])

// ── H19a: which helper may hint, and which may also drive speaker repair ──────

/** Where the helper came from. A Wizdom file is never gender-eligible; an OpenSubtitles MT file never. */
export type HelperProvenance =
  | { readonly kind: 'opensubtitles'; readonly language: string; readonly machineTranslated: boolean }
  | { readonly kind: 'disk'; readonly language: string | null; readonly humanHebrew: boolean }
  | { readonly kind: 'wizdom' }

function hasHebrewTargetBlock(lang: string | null): boolean {
  return lang === 'ar' || (lang !== null && GENDER_SIGNAL_LANGUAGES.includes(lang))
}

/**
 * H19a, first-pass hint: an OpenSubtitles file not flagged AI/MT; a disk Hebrew file only with **This is human
 * Hebrew**; a disk file in Arabic or a `_GENDER_SIGNALS` language (German included). Wizdom never. A disk file in
 * any other language is ignored. OS-MT cannot be overridden.
 */
export function hintEligible(helper: HelperProvenance): boolean {
  if (helper.kind === 'wizdom') return false
  const lang = referenceLanguage(helper.language)
  if (helper.kind === 'opensubtitles') return !helper.machineTranslated && (lang === 'he' || hasHebrewTargetBlock(lang))
  return lang === 'he' ? helper.humanHebrew : hasHebrewTargetBlock(lang)
}

/** H19a, speaker repair: a hint-eligible helper whose language is Hebrew (a Hebrew disk file still needs the box). */
export function speakerEligible(helper: HelperProvenance): boolean {
  return hintEligible(helper) && referenceLanguage(helper.kind === 'wizdom' ? null : helper.language) === 'he'
}

// ── flags: one designated reader per axis, no voting ──────────────────────────

/** The Feature-17 layers a run asked for, frozen at Start. */
export interface GenderLayers {
  readonly speaker: boolean
  readonly methodB: boolean
  readonly c1Spanish: boolean
  readonly c1Portuguese: boolean
}

export const NO_GENDER_LAYERS: GenderLayers = Object.freeze({ speaker: false, methodB: false, c1Spanish: false, c1Portuguese: false })

/** Which layer raised a correction: the Bundle H base addressee repair, or one Feature-17 layer. */
export type GenderLayer = 'addressee' | 'speaker' | 'c1Spanish' | 'c1Portuguese' | 'methodB'

export interface GenderCorrection {
  readonly axis: GenderAxis
  readonly requestedGender: Gender
  readonly layer: GenderLayer
}

export interface FlagInput {
  /** The source cues, original text, in order. */
  readonly source: readonly { readonly index: number; readonly text: string }[]
  /** The run's translation of each cue, by cue index. */
  readonly output: ReadonlyMap<number, string>
  /** The aligned helper line for each hinted cue, by cue index. */
  readonly oracle: ReadonlyMap<number, string>
  /** Null when the run has no reference; only the C1 source caller can then read. */
  readonly helper: HelperProvenance | null
  /** The run's source language code, or null for Auto Detect. */
  readonly sourceLanguage: string | null
  readonly layers: GenderLayers
}

export interface FlagResult {
  /** Cue index → the corrections wanted for it, each axis at most once. */
  readonly flags: ReadonlyMap<number, readonly GenderCorrection[]>
  /** Cues where the addressee callers disagreed and so abstained, by the layers that took part. */
  readonly conflicts: ReadonlyMap<GenderLayer, number>
  /** Cues where a layer's reader marked a gender on the helper side (its evidence), by layer. */
  readonly evidence: ReadonlyMap<GenderLayer, number>
}

function c1Of(lang: string | null, layers: GenderLayers): { lang: C1Language; layer: GenderLayer } | null {
  if (lang === 'es' && layers.c1Spanish) return { lang: 'es', layer: 'c1Spanish' }
  if (lang === 'pt' && layers.c1Portuguese) return { lang: 'pt', layer: 'c1Portuguese' }
  return null
}

/**
 * The direct flags (H17/H18/H19b and C1). For every hinted cue with an eligible helper:
 * - addressee: the helper's designated reading (its language's reader, or C1 for an es/pt helper when that
 *   layer is on) and, when on, the es/pt SOURCE caller over the same cue; all present readings must agree or the
 *   cue abstains; flagged when the output's Hebrew addressee reads the opposite gender;
 * - speaker (Feature-17 speaker layer only): a Hebrew speaker-eligible helper, flagged when the output's speaker
 *   reads the opposite gender.
 * Without an eligible helper only the C1 source caller reads, and only when its language's layer is on.
 */
export function designatedFlags(input: FlagInput): FlagResult {
  const flags = new Map<number, GenderCorrection[]>()
  const conflicts = new Map<GenderLayer, number>()
  const evidence = new Map<GenderLayer, number>()
  const bump = (m: Map<GenderLayer, number>, l: GenderLayer) => m.set(l, (m.get(l) ?? 0) + 1)
  const helper = input.helper && hintEligible(input.helper) ? input.helper : null
  const sourceC1 = c1Of(referenceLanguage(input.sourceLanguage), input.layers)
  if (!helper && !sourceC1) return { flags, conflicts, evidence }
  const helperLang = helper ? referenceLanguage(helper.kind === 'wizdom' ? null : helper.language) : null
  const helperC1 = c1Of(helperLang, input.layers)
  const speaker = helper !== null && input.layers.speaker && speakerEligible(helper)
  for (const cue of input.source) {
    const ref = helper ? input.oracle.get(cue.index) : undefined
    const out = input.output.get(cue.index)
    if ((!ref && !sourceC1) || out === undefined) continue
    const corrections: GenderCorrection[] = []

    const readings: { gender: Gender; layer: GenderLayer }[] = []
    const base = ref && helperLang ? referenceAddresseeGender(ref, helperLang) : null
    if (base) readings.push({ gender: base, layer: 'addressee' })
    if (ref && helperC1) {
      const g = romanceAddressee(ref, helperC1.lang)
      if (g) readings.push({ gender: g, layer: helperC1.layer })
    }
    if (sourceC1) {
      const g = romanceAddressee(cue.text, sourceC1.lang)
      if (g) readings.push({ gender: g, layer: sourceC1.layer })
    }
    for (const l of new Set(readings.map((r) => r.layer))) bump(evidence, l)
    const genders = new Set(readings.map((r) => r.gender))
    if (genders.size > 1) {
      for (const l of new Set(readings.map((r) => r.layer))) bump(conflicts, l)
    } else if (genders.size === 1) {
      const target = readings[0].gender
      const c1 = readings.find((r) => r.layer !== 'addressee')
      const direct = hebrewAddressee(out)
      const observed = direct ?? (c1 ? pronounAddressee(out) : null)
      if (observed !== null && observed !== target) {
        const layer = direct === null && c1 ? c1.layer : readings.some((r) => r.layer === 'addressee') ? 'addressee' : readings[0].layer
        corrections.push({ axis: 'addressee', requestedGender: target, layer })
      }
    }

    if (speaker && ref) {
      const wanted = speakerGender(ref)
      if (wanted) {
        bump(evidence, 'speaker')
        const observed = speakerGender(out)
        if (observed !== null && observed !== wanted) corrections.push({ axis: 'speaker', requestedGender: wanted, layer: 'speaker' })
      }
    }
    if (corrections.length) flags.set(cue.index, corrections)
  }
  return { flags, conflicts, evidence }
}

/**
 * The helper's designated reading on one axis, for Method B's comparison. With `source`, an addressee reading
 * the enabled es/pt SOURCE caller contradicts abstains, as `designatedFlags` abstains on the same cue (R19-04).
 */
export function helperReading(axis: GenderAxis, ref: string, helper: HelperProvenance, layers: GenderLayers, source?: { text: string; language: string | null }): Reading {
  if (!hintEligible(helper)) return null
  const lang = referenceLanguage(helper.kind === 'wizdom' ? null : helper.language)
  if (axis === 'speaker') return speakerEligible(helper) ? speakerGender(ref) : null
  const base = lang ? referenceAddresseeGender(ref, lang) : null
  const c1 = c1Of(lang, layers)
  const extra = c1 ? romanceAddressee(ref, c1.lang) : null
  if (base && extra && base !== extra) return null
  const reading = base ?? extra
  const sourceC1 = source ? c1Of(referenceLanguage(source.language), layers) : null
  const fromSource = reading && source && sourceC1 ? romanceAddressee(source.text, sourceC1.lang) : null
  return fromSource && fromSource !== reading ? null : reading
}

/** The output's designated reading on one axis. */
export function outputReading(axis: GenderAxis, text: string): Reading {
  return axis === 'speaker' ? speakerGender(text) : hebrewAddressee(text)
}

/** The reading a correction's veto checks: a C1 addressee correction also reads the pronoun alone (A.6). */
export function correctionReading(c: GenderCorrection, text: string): Reading {
  return c.axis === 'addressee' && (c.layer === 'c1Spanish' || c.layer === 'c1Portuguese') ? c1OutputAddressee(text) : outputReading(c.axis, text)
}
