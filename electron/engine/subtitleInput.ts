/**
 * Subtitle intake — the one owner of raw subtitle bytes (implementation_plan.md §14.2 D14.1, Bundle A;
 * feature_decisions.md §2.6–2.9, §17.5 D14-2).
 * AUTHORED-BY: opus-5.5-high
 *
 * Everything that turns a user's subtitle file into text goes through here. `srt.ts` never guesses
 * an encoding.
 *
 * The ladder (§2.6): BOM → strict UTF-8 → a CLOSED set of legacy Windows code pages, each decode scored
 * for linguistic plausibility. Encoding and language are one decision: the winning decode names the
 * language. A hint (track tag, filename) only breaks a tie between plausible candidates; it never makes
 * an implausible decode win. Nothing plausible → refusal, with the user's language override as the way
 * through. Valid UTF-8 is never reinterpreted.
 *
 * A code page is in the closed set only with ≥5 provenance-labelled real files behind it
 * (`scripts/gates/fixtures/encoding/manifest.json`) and a zero-silent-corruption result (§17.5).
 *
 * BiDi controls are stripped from the ANALYSIS copy only (§2.9); decoded text handed onward keeps them.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export type LegacyEncoding =
  | 'windows-1250'
  | 'windows-1251'
  | 'windows-1252'
  | 'windows-1253'
  | 'windows-1254'
  | 'windows-1255'
  | 'windows-1256'

export type SubtitleEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le-bom' | 'utf-16be-bom' | LegacyEncoding

export const LEGACY_ENCODINGS: readonly LegacyEncoding[] = [
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256'
]

/** What inspection pins: the exact bytes Start must find again, and how they are to be decoded. */
export interface SubtitleReceipt {
  /** Canonical (realpath) location of the inspected file. */
  path: string
  byteLength: number
  sha256: string
  encoding: SubtitleEncoding
}

export interface SubtitleCandidate {
  encoding: SubtitleEncoding
  /** Registry language value (`electron/shared/languages.ts`), `''` when no language scored. */
  language: string
  score: number
  /**
   * Only when the chosen language reads these bytes more than one way: the first line where this
   * reading differs from the others, so the user can pick the one that looks right.
   */
  preview?: string
}

export interface SubtitleInspection {
  receipt: SubtitleReceipt
  format: 'srt' | 'ass'
  /** How the encoding was decided. `override` = the user's language choice selected the code page. */
  encodingSource: 'bom' | 'utf8' | 'detected' | 'override'
  /** `false` when two plausible decodes with different text compete. Always true for BOM/UTF-8. */
  encodingCertain: boolean
  /** Detected (or overridden) language; `''` when the text names none. */
  language: string
  languageCertain: boolean
  /** The hint decided between near-tied candidates. */
  hintUsed: boolean
  /** Plausible alternatives, best first, for the confirmation card. */
  candidates: SubtitleCandidate[]
  /** First dialogue line of the chosen decode, tags and BiDi controls removed. */
  preview: string
}

export type SubtitleRefusalCode =
  | 'read-failed'
  | 'empty'
  | 'utf16-no-bom'
  | 'ass-legacy'
  | 'undetectable'
  | 'override-unsupported'
  | 'path-mismatch'
  | 'changed'
  | 'not-srt'

export type SubtitleInspectResult =
  | { ok: true; inspection: SubtitleInspection }
  | { ok: false; code: SubtitleRefusalCode; error: string }

export interface InspectOptions {
  /** Path the bytes came from: names the receipt and decides `.srt`/`.ass`. */
  path: string
  /** Registry language value from a track tag or filename. Tiebreaker only. */
  hint?: string
  /** The user's language override. Decides the language, and for legacy bytes the code page. */
  language?: string
  /**
   * The reading the user picked when the override language allows several code pages that decode these
   * bytes differently. Must be one of that language's code pages; ignored for BOM/UTF-8 bytes.
   */
  encoding?: SubtitleEncoding
}

// ---------------------------------------------------------------------------------------------------
// Language profiles. `stop` are the commonest dialogue words; `forbid` are letters the language does not
// use but a sibling does (Cyrillic and Central-European neighbours are told apart mostly by these).

type Script =
  | 'Latin'
  | 'Cyrillic'
  | 'Greek'
  | 'Hebrew'
  | 'Arabic'
  | 'Devanagari'
  | 'Han'
  | 'Kana'
  | 'Hangul'
  | 'Thai'
  | 'Georgian'
  | 'Armenian'
  | 'Ethiopic'
  | 'Bengali'
  | 'Gurmukhi'
  | 'Gujarati'
  | 'Tamil'
  | 'Telugu'
  | 'Kannada'
  | 'Malayalam'
  | 'Sinhala'

interface LangProfile {
  lang: string
  script: Script
  stop: string
  forbid?: string
  /** Legacy code pages this language is written in. Empty → UTF-8/BOM only. */
  cps: LegacyEncoding[]
}

const W1250: LegacyEncoding[] = ['windows-1250']
const W1252: LegacyEncoding[] = ['windows-1252']

const PROFILES: LangProfile[] = [
  { lang: 'he', script: 'Hebrew', cps: ['windows-1255'],
    stop: 'של לא את זה אני אתה מה על הוא היא אם כל יש לי לך אבל כן רק עם שלי אנחנו הם זאת כמו אין היה טוב אותו אז עכשיו פה כאן למה איך אותך אותי הזה' },
  { lang: 'ar', script: 'Arabic', cps: ['windows-1256'], forbid: 'پچژگٹڈڑںے',
    stop: 'من في على لا ما هذا ان أن إلى الى هل انا أنا انت أنت هو هي لم كان عن مع هذه ماذا لقد نحن كل انه إنه لك لن يا ذلك الذي كيف لماذا هنا الان الآن اذا إذا' },
  { lang: 'fa', script: 'Arabic', cps: ['windows-1256'], forbid: 'ٹڈڑںےة',
    stop: 'و به از این که را با در من تو است نه چی رو یه اون ما هم برای چه خب اینجا شما هست میخوام نمیدونم داری دارم باید کن' },
  { lang: 'ur', script: 'Arabic', cps: ['windows-1256'], forbid: 'ژة',
    stop: 'ہے کے میں کی نہیں کا کو سے اور یہ آپ کیا ہیں تم ہو تھا وہ مجھے ہم' },
  { lang: 'ru', script: 'Cyrillic', cps: ['windows-1251'], forbid: 'іїєґўјљњћђќѓѕџ',
    stop: 'не что я ты в и на это он с мы как вы а так да но она все нет меня мне его у тебя о за было есть только же по вот ну мой чтобы' },
  { lang: 'uk', script: 'Cyrillic', cps: ['windows-1251'], forbid: 'ыэёъўјљњћђќѓѕџ',
    stop: 'не що я ти в і на це він з ми як ви а так та але вона все ні мене мені його у тебе ще вже тут був бути їх є чи щоб' },
  { lang: 'be', script: 'Cyrillic', cps: ['windows-1251'], forbid: 'ищъїєґјљњћђќѓѕџ',
    stop: 'не і я ты у на гэта што ён з мы як вы а так але яна усё мне яго цябе тут ўжо быў' },
  { lang: 'bg', script: 'Cyrillic', cps: ['windows-1251'], forbid: 'ыэёіїєґўјљњћђќѓѕџ',
    stop: 'не да се и на е това че ще си в за ми съм ли ти от с ако какво той тя ние вие но как може беше има тук сега добре защо всичко' },
  { lang: 'sr', script: 'Cyrillic', cps: ['windows-1251'], forbid: 'ыэёъщйяюєіїґўќѓѕ',
    stop: 'не да је и у се сам ти то ли на шта ми си са за што ово али како нисам мене он она бити био ћу ћеш када овде' },
  { lang: 'mk', script: 'Cyrillic', cps: ['windows-1251'], forbid: 'ыэёъщйяюєіїґўћђ',
    stop: 'не да е и се на ќе ти ми тоа што си сум од за со ова но како тој таа ние вие зошто сега тука многу нешто само може' },
  { lang: 'pl', script: 'Latin', cps: W1250, forbid: 'řůěťďňŕĺőű',
    stop: 'nie się to jest że na w i z co jak ja ty do tak mnie mi ale czy o tu już go jestem był tylko mam ma wiesz sie dobrze może jesteś' },
  { lang: 'cs', script: 'Latin', cps: W1250, forbid: 'łąęśżźńőűŕĺľ',
    stop: 'to je se na že ne v a jsem co já ty si jak tak mi by tady ale jsi s z mě o jen už do víš máme bude není proč' },
  { lang: 'sk', script: 'Latin', cps: W1250, forbid: 'łąęśżźńőűřůě',
    stop: 'to je sa na že nie v a som čo ja ty si ako tak mi by tu ale s z ma o len už do vieš bude prečo nič aj' },
  { lang: 'hu', script: 'Latin', cps: W1250, forbid: 'łąęśżźńřůěčšžćđţşăťď',
    stop: 'a az hogy nem és is ez egy meg már csak de mi te én van ha el ki mit jó igen itt most még volt nincs kell miért vagy' },
  { lang: 'hr', script: 'Latin', cps: W1250, forbid: 'łąęśżźńřůěőűţşăťď',
    stop: 'je da ne se i u to sam na ti li što mi si za ovo ali kako nisam me on ona biti bio ću ćeš kad ovdje sve tko' },
  { lang: 'bs', script: 'Latin', cps: W1250, forbid: 'łąęśżźńřůěőűţşăťď',
    stop: 'je da ne se i u to sam na ti li šta mi si za ovo ali kako nisam me on ona biti bio ću ćeš kad ovdje sve ko' },
  { lang: 'sr', script: 'Latin', cps: W1250, forbid: 'łąęśżźńřůěőűţşăťď',
    stop: 'je da ne se i u to sam na ti li šta mi si za ovo ali kako nisam me on ona biti bio ću ćeš kad ovde sve ko' },
  { lang: 'sl', script: 'Latin', cps: W1250, forbid: 'łąęśżźńřůěőűćđţşăťď',
    stop: 'je da ne se in v to sem na ti kaj mi si za pa ali kako me on ona bil bo ga tukaj zdaj kje zakaj tudi lahko samo' },
  { lang: 'ro', script: 'Latin', cps: W1250, forbid: 'łąęśżźńřůěőűčšžćđťď',
    stop: 'nu să sa e de și şi si la ce în in a că ca o mă te pe eu tu ești eşti sunt este cu un mai ai am aici asta dar bine ştiu știu' },
  { lang: 'sq', script: 'Latin', cps: ['windows-1250', 'windows-1252'],
    stop: 'të në e nuk një që është me për unë ti ai ajo çfarë po jam do ke ka' },
  { lang: 'tr', script: 'Latin', cps: ['windows-1254'], forbid: 'ðýþ',
    stop: 'bir bu ve ne ben sen mi için de da çok o değil var yok ama şey daha gibi evet hayır mı sana beni seni onu burada şimdi nasıl neden iyi' },
  { lang: 'el', script: 'Greek', cps: ['windows-1253'],
    stop: 'και να το θα δεν τι είναι η ο μου σου με που τα του της στο για εγώ εσύ αυτό ναι όχι μας ένα τον την είσαι είμαι εδώ' },
  { lang: 'en', script: 'Latin', cps: W1252,
    stop: "the you i to a it and that of is what in me this we don't no have do be for your not my on he are was know just i'm it's can get with all so" },
  { lang: 'fr', script: 'Latin', cps: W1252, forbid: 'ñãõ',
    stop: "je de vous pas le la que est tu un et ce à les une il ne en des pour on qui c'est me mais oui non du au nous elle bien ça moi" },
  { lang: 'es', script: 'Latin', cps: W1252, forbid: 'ãõçàèùâêôœ',
    stop: 'que de no la el a y es en lo un por qué me se una te los con para mi está si bien pero yo eso las sí su tu aquí del al como le más esto ya todo esta muy estoy hay tú él ahora' },
  { lang: 'pt', script: 'Latin', cps: W1252, forbid: 'ñœ',
    stop: 'que não de o a é e um você eu do da uma para se isso em me com no na os está mas por sim aqui tem bem como ele ela vai só meu foi ser estou já isto muito então nós' },
  { lang: 'ca', script: 'Latin', cps: W1252, forbid: 'ñãõ',
    stop: 'que de no el la és a i en un per em et què ho ja molt això amb els les bé aquí però sí tinc ara vull som estàs hi' },
  { lang: 'gl', script: 'Latin', cps: W1252, forbid: 'ãõç',
    stop: 'que non de o a é e un eu do da unha para se iso en me con no na os está pero por si aquí ten ben como el ela vai só meu foi ser estou xa moito agora ti' },
  { lang: 'de', script: 'Latin', cps: W1252, forbid: 'ñãõçœ',
    stop: 'ich die du der und nicht das ist zu sie es ein was wir ja er den mit mir in sich mich dich hier auf haben so dass aber wie eine nein bin hast kann' },
  { lang: 'it', script: 'Latin', cps: W1252, forbid: 'ñãõçœ',
    stop: 'non che di è e il la un a per mi ti ho si sono lo cosa ma una in con me se questo hai bene sei ci no mio qui come del perché va io tu lui lei ha' },
  { lang: 'nl', script: 'Latin', cps: W1252,
    stop: 'ik je het de dat is niet een en van wat we in ze hij op te zijn maar met voor dit er mij heb ben jij ja nee hier kan niets wel weet hebben gaan' },
  { lang: 'sv', script: 'Latin', cps: W1252,
    stop: 'jag det är du inte att en och har vi på i som för han med vad kan så ett till den var hon om mig dig här nu ja nej ska vill' },
  { lang: 'da', script: 'Latin', cps: W1252,
    stop: 'jeg det er du ikke at en og har vi på i som for han med hvad kan så et til den var hun om mig dig her nu ja nej skal vil' },
  { lang: 'no', script: 'Latin', cps: W1252,
    stop: 'jeg det er du ikke at en og har vi på i som for han med hva kan så et til den var hun om meg deg her nå ja nei skal vil' },
  { lang: 'fi', script: 'Latin', cps: W1252,
    stop: 'on en se ei että ja mitä minä sinä hän me te tämä oli olen olet mutta niin kun jos vain nyt täällä kaikki mikä miksi joo kyllä sinun minun hyvä' },
  { lang: 'et', script: 'Latin', cps: W1252,
    stop: 'on ei ja see et ma sa mis kas ta me te oli olen aga siis nii kui ainult nüüd siin kõik miks jah sinu minu hea mul sul' },
  { lang: 'is', script: 'Latin', cps: W1252,
    stop: 'ég er það að ekki þú og á við hann hún í um hvað já nei með þetta var vera hér núna mig þig' },
  { lang: 'id', script: 'Latin', cps: W1252,
    stop: 'aku kau yang tidak ini itu dan apa di kita saya kamu ada akan dia untuk dengan ya tak bisa sudah mereka harus tahu kami juga tapi jangan sini begitu' },
  { lang: 'ms', script: 'Latin', cps: W1252,
    stop: 'aku kau yang tidak ini itu dan apa di kita saya awak ada akan dia untuk dengan ya tak boleh sudah mereka mesti tahu kami juga tapi jangan sini begitu' },
  { lang: 'tl', script: 'Latin', cps: W1252,
    stop: 'ang ng sa na ko mo ka ako ikaw siya hindi ito ay kung lang pa ba naman mga kayo tayo ano bakit dito oo' },
  { lang: 'sw', script: 'Latin', cps: W1252,
    stop: 'na ya wa kwa ni la za hii hapana ndiyo mimi wewe yeye sisi nini kama lakini sana hapa sasa tu' },
  { lang: 'lt', script: 'Latin', cps: [],
    stop: 'ne aš tu kad tai ir kas jis ji mes jūs čia dabar gerai taip man tau yra buvo' },
  { lang: 'lv', script: 'Latin', cps: [],
    stop: 'es tu ne ir un ka tas kas viņš viņa mēs jūs šeit tagad labi jā nē man tev bija' },
  { lang: 'hi', script: 'Devanagari', cps: [], stop: 'है के में की नहीं का को से और मैं तुम यह आप क्या हूँ हैं था' },
  { lang: 'mr', script: 'Devanagari', cps: [], stop: 'आहे आणि नाही मी तू हे ते काय मला तुला आहेस होता' },
  { lang: 'ne', script: 'Devanagari', cps: [], stop: 'छ र हो म यो त्यो गर्न छैन तिमी हामी के थियो' }
]

/** Scripts that name their language on their own. Only reachable through BOM/UTF-8 except Hebrew/Greek. */
const SCRIPT_LANGUAGE: Partial<Record<Script, string>> = {
  Kana: 'ja',
  Hangul: 'ko',
  Thai: 'th',
  Georgian: 'ka',
  Armenian: 'hy',
  Ethiopic: 'am',
  Bengali: 'bn',
  Gurmukhi: 'pa',
  Gujarati: 'gu',
  Tamil: 'ta',
  Telugu: 'te',
  Kannada: 'kn',
  Malayalam: 'ml',
  Sinhala: 'si'
}

const SCRIPT_TESTS: [Script, RegExp][] = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Han', /\p{Script=Han}/u],
  ['Kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Georgian', /\p{Script=Georgian}/u],
  ['Armenian', /\p{Script=Armenian}/u],
  ['Ethiopic', /\p{Script=Ethiopic}/u],
  ['Bengali', /\p{Script=Bengali}/u],
  ['Gurmukhi', /\p{Script=Gurmukhi}/u],
  ['Gujarati', /\p{Script=Gujarati}/u],
  ['Tamil', /\p{Script=Tamil}/u],
  ['Telugu', /\p{Script=Telugu}/u],
  ['Kannada', /\p{Script=Kannada}/u],
  ['Malayalam', /\p{Script=Malayalam}/u],
  ['Sinhala', /\p{Script=Sinhala}/u]
]

/** Simplified-only vs Traditional-only forms of very common characters. */
const HAN_SIMPLIFIED = '这们说个时为会来对没过还么吗间们后让开里见长问实给东车门马鸟钱发经头现关点电从'
const HAN_TRADITIONAL = '這們說個時為會來對沒過還麼嗎間們後讓開裡見長問實給東車門馬鳥錢發經頭現關點電從'

/** Arabic-script spelling variants folded together before matching (Persian files in cp1256 use ي/ك). */
function foldArabic(s: string): string {
  return s.replace(/[\u064B-\u065F\u0670]/g, '').replace(/[ىيی]/g, 'ي').replace(/[كک]/g, 'ك').replace(/[أإآ]/g, 'ا')
}

interface CompiledProfile extends LangProfile {
  stopSet: Set<string>
  forbidSet: Set<string>
}

const COMPILED: CompiledProfile[] = PROFILES.map((p) => {
  const words = p.stop.split(/\s+/).filter(Boolean)
  const norm = p.script === 'Arabic' ? words.map(foldArabic) : words
  return { ...p, stopSet: new Set(norm), forbidSet: new Set([...(p.forbid ?? '')]) }
})

/** Every language that can be decided from a legacy code page, and the code pages it allows. */
export function legacyEncodingsFor(language: string): LegacyEncoding[] {
  const base = language.split('-')[0].toLowerCase()
  const out = new Set<LegacyEncoding>()
  for (const p of PROFILES) if (p.lang === base) for (const cp of p.cps) out.add(cp)
  return [...out]
}

// ---------------------------------------------------------------------------------------------------

const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\uFEFF]/g

/** §2.9: BiDi/format marks removed for analysis. Never applied to text handed to a player or the engine. */
export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, '')
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** Decode with an already-decided encoding. A BOM is consumed; nothing else is altered. */
export function decodeSubtitleBuffer(buf: Buffer, encoding: SubtitleEncoding): string {
  switch (encoding) {
    case 'utf-8':
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
    case 'utf-8-bom':
      return new TextDecoder('utf-8').decode(buf.subarray(3))
    case 'utf-16le-bom':
      return new TextDecoder('utf-16le').decode(buf.subarray(2))
    case 'utf-16be-bom':
      return new TextDecoder('utf-16be').decode(buf.subarray(2))
    default:
      return new TextDecoder(encoding).decode(buf)
  }
}

function bomOf(buf: Buffer): SubtitleEncoding | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le-bom'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be-bom'
  return null
}

function isStrictUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/** BOM-less UTF-16: NUL bytes concentrated on one parity. Plain text in any code page here has none. */
function looksLikeUtf16(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  if (n < 8) return false
  let even = 0
  let odd = 0
  for (let i = 0; i < n; i++) if (buf[i] === 0) (i % 2 === 0 ? even++ : odd++)
  const half = n / 2
  return even / half > 0.3 || odd / half > 0.3
}

/** Dialogue text only: no indices, timings, ASS headers/styles or override tags. */
function analysisText(text: string, format: 'srt' | 'ass'): string[] {
  const lines = stripBidiControls(text).replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  if (format === 'ass') {
    for (const l of lines) {
      const m = /^Dialogue:(?:[^,]*,){9}(.*)$/i.exec(l)
      if (m) out.push(m[1].replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, ' '))
    }
  } else {
    for (const l of lines) {
      const t = l.trim()
      if (!t || /^\d+$/.test(t) || t.includes('-->')) continue
      out.push(t.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, ''))
    }
  }
  return out
}

interface TextStats {
  letters: number
  scripts: Map<Script, number>
  tokens: string[]
  /** Letters per char, so `forbid` rates can be computed without rescanning. */
  letterCounts: Map<string, number>
  /** Replacement chars, C1 controls and symbol characters wedged between letters. */
  weird: number
  chars: number
  hanSimplified: number
  hanTraditional: number
  /**
   * Share of Latin words made mostly of accented letters (`àðé`, `Ïðèâåò`): what a non-Latin text looks
   * like through a Latin code page (§2.6 step 3). Real Latin-script dialogue stays far below it.
   */
  accentRunRate: number
}

const WEDGED_SYMBOL = /\p{L}[\u00A1-\u00BF\u00D7\u00F7\u02C6-\u02DD\u2020-\u2030\u2122]\p{L}/gu

function textStats(lines: string[]): TextStats {
  const joined = lines.join('\n')
  const scripts = new Map<Script, number>()
  const letterCounts = new Map<string, number>()
  let letters = 0
  let weird = 0
  let hanSimplified = 0
  let hanTraditional = 0
  for (const ch of joined) {
    const cp = ch.codePointAt(0)!
    if (cp === 0xfffd || (cp >= 0x80 && cp <= 0x9f)) {
      weird++
      continue
    }
    if (!/\p{L}/u.test(ch)) continue
    letters++
    const lower = ch.toLowerCase()
    letterCounts.set(lower, (letterCounts.get(lower) ?? 0) + 1)
    for (const [s, re] of SCRIPT_TESTS) {
      if (re.test(ch)) {
        scripts.set(s, (scripts.get(s) ?? 0) + 1)
        break
      }
    }
    if (HAN_SIMPLIFIED.includes(ch)) hanSimplified++
    else if (HAN_TRADITIONAL.includes(ch)) hanTraditional++
  }
  weird += (joined.match(WEDGED_SYMBOL) ?? []).length
  const tokens = (joined.replace(/[’`´]/g, "'").toLowerCase().match(/\p{L}[\p{L}\p{M}']*/gu) ?? []).map((t) =>
    t.replace(/'+$/, '')
  )
  let latinWords = 0
  let accentRuns = 0
  for (const t of tokens) {
    if (!/^[\p{Script=Latin}']+$/u.test(t)) continue
    latinWords++
    const accented = (t.match(/[^\x00-\x7f']/g) ?? []).length
    if (t.length >= 2 && accented >= 2 && accented / t.replace(/'/g, '').length >= 0.6) accentRuns++
  }
  const accentRunRate = latinWords ? accentRuns / latinWords : 0
  return { letters, scripts, tokens, letterCounts, weird, chars: joined.length, hanSimplified, hanTraditional, accentRunRate }
}

interface Scored {
  language: string
  score: number
  plausible: boolean
}

const MIN_COVERAGE = 0.06
/** Low enough for a Hebrew film with English song lines; coverage, not purity, rejects a wrong decode. */
const MIN_PURITY = 0.5
const MAX_WEIRD = 0.01
/**
 * Measured on the D14.1 corpus: correct Latin-script decodes peak at 0.012 (Turkish); a non-Latin file
 * through a Latin code page is 0.81–0.99. Above this, Latin text cannot be the whole story.
 */
const MAX_ACCENT_RUNS = 0.05

function scoreProfiles(st: TextStats, allowed: (p: LangProfile) => boolean): Scored[] {
  const out: Scored[] = []
  if (st.letters === 0) return out
  const folded = new Map<string, string[]>()
  const tokensFor = (script: Script): string[] => {
    if (script !== 'Arabic') return st.tokens
    let f = folded.get('Arabic')
    if (!f) folded.set('Arabic', (f = st.tokens.map(foldArabic)))
    return f
  }
  const weirdRate = st.weird / Math.max(1, st.chars)
  for (const p of COMPILED) {
    if (!allowed(p)) continue
    const purity = (st.scripts.get(p.script) ?? 0) / st.letters
    if (purity < 0.3) continue
    const toks = tokensFor(p.script)
    let hits = 0
    for (const t of toks) if (p.stopSet.has(t)) hits++
    const coverage = toks.length ? hits / toks.length : 0
    let forbidden = 0
    for (const ch of p.forbidSet) forbidden += st.letterCounts.get(ch) ?? 0
    const forbidRate = forbidden / st.letters
    const forbidFactor = forbidRate > 0.002 ? Math.max(0.1, 1 - forbidRate * 60) : 1
    const accentFactor = p.script === 'Latin' ? Math.max(0, 1 - st.accentRunRate * 10) : 1
    const score = coverage * purity * forbidFactor * accentFactor * Math.max(0, 1 - weirdRate * 20)
    out.push({
      language: p.lang,
      score,
      plausible:
        coverage >= MIN_COVERAGE &&
        purity >= MIN_PURITY &&
        weirdRate <= MAX_WEIRD &&
        forbidFactor > 0.5 &&
        (p.script !== 'Latin' || st.accentRunRate <= MAX_ACCENT_RUNS)
    })
  }
  for (const [script, lang] of Object.entries(SCRIPT_LANGUAGE) as [Script, string][]) {
    const purity = (st.scripts.get(script) ?? 0) / st.letters
    // Japanese mixes Kana with Han; Kana at a fifth of letters is already unmistakable.
    const effective = script === 'Kana' ? Math.min(1, purity * 3) : purity
    if (effective < 0.3) continue
    if (!allowed({ lang, script, stop: '', cps: [] })) continue
    out.push({ language: lang, score: effective * 0.5, plausible: effective >= 0.6 && weirdRate <= MAX_WEIRD })
  }
  const han = (st.scripts.get('Han') ?? 0) / st.letters
  if (han >= 0.6 && (st.scripts.get('Kana') ?? 0) / st.letters < 0.05) {
    const trad = st.hanTraditional > st.hanSimplified
    for (const lang of trad ? ['zh-TW', 'zh'] : ['zh', 'zh-TW']) {
      if (!allowed({ lang, script: 'Han', stop: '', cps: [] })) continue
      const lead = lang === (trad ? 'zh-TW' : 'zh')
      const a = Math.max(st.hanSimplified, st.hanTraditional)
      const b = Math.min(st.hanSimplified, st.hanTraditional)
      const decisive = a >= 5 && a >= 3 * b
      out.push({ language: lang, score: han * (lead ? 0.5 : decisive ? 0.1 : 0.45), plausible: weirdRate <= MAX_WEIRD })
    }
  }
  // One entry per language (sr has a Latin and a Cyrillic profile).
  const best = new Map<string, Scored>()
  for (const s of out) {
    const prev = best.get(s.language)
    if (!prev || s.score > prev.score) best.set(s.language, s)
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}

/** A language decided by its alphabet alone needs only enough letters; the rest need a clear margin. */
const SCRIPT_DECIDED = new Set(['he', 'el', ...Object.values(SCRIPT_LANGUAGE)])
const MIN_TOKENS = 40
const MARGIN = 1.4
const HINT_WINDOW = 0.7

function previewOf(text: string, format: 'srt' | 'ass'): string {
  for (const l of analysisText(text, format)) {
    if ((l.match(/\p{L}/gu) ?? []).length >= 3) return l.trim().slice(0, 120)
  }
  return ''
}

const READING_WINDOW = 120
const READING_LEAD = 40

/**
 * The first dialogue line where two single-byte readings of the same bytes differ, cut to a window that
 * always contains the first differing character. Single-byte code pages map byte i to character i, so
 * both readings' windows cover the same bytes.
 */
function differingLine(text: string, other: string, format: 'srt' | 'ass'): string {
  const a = [...analysisText(text, format)]
  const b = [...analysisText(other, format)]
  for (let i = 0; i < a.length; i++) {
    const line = a[i]
    const alt = b[i] ?? ''
    if (line === alt) continue
    let at = 0
    while (at < line.length && line[at] === alt[at]) at++
    const start = Math.max(0, Math.min(at - READING_LEAD, line.length - READING_WINDOW))
    const end = Math.min(line.length, start + READING_WINDOW)
    return (start > 0 ? '…' : '') + line.slice(start, end).trim() + (end < line.length ? '…' : '')
  }
  return previewOf(text, format)
}

const ASS_LEGACY_REFUSAL =
  'This .ass file is not UTF-8. Re-save it as UTF-8 (most subtitle editors offer "Save as UTF-8") and try ' +
  'again. It was left untouched — guessing a legacy code page would corrupt styled text and style names.'

/**
 * Inspect bytes already in memory. No I/O: the caller read them once and keeps the same Buffer for Start.
 */
export function inspectSubtitleBytes(buf: Buffer, opts: InspectOptions): SubtitleInspectResult {
  const format: 'srt' | 'ass' = path.extname(opts.path).toLowerCase() === '.ass' ? 'ass' : 'srt'
  const base = { path: opts.path, byteLength: buf.length, sha256: sha256Hex(buf) }
  if (buf.length === 0) return { ok: false, code: 'empty', error: 'The subtitle file is empty.' }
  const override = opts.language && opts.language !== 'auto' ? opts.language : ''
  const hint = opts.hint && opts.hint !== 'auto' ? opts.hint : ''

  const bom = bomOf(buf)
  // Checked before UTF-8: ASCII-range UTF-16 is NUL-interleaved and still passes a strict UTF-8 decode.
  if (!bom && looksLikeUtf16(buf)) {
    return {
      ok: false,
      code: 'utf16-no-bom',
      error:
        'This subtitle file looks like UTF-16 without a byte-order mark, so its byte order cannot be known. ' +
        'Re-save it as UTF-8 and try again. The file was left untouched.'
    }
  }
  const unicode: SubtitleEncoding | null = bom ?? (isStrictUtf8(buf) ? 'utf-8' : null)
  if (unicode) {
    const text = decodeSubtitleBuffer(buf, unicode)
    const st = textStats(analysisText(text, format))
    const scored = scoreProfiles(st, () => true)
    const lang = decideLanguage(scored, st.tokens.length, hint, override)
    return {
      ok: true,
      inspection: {
        receipt: { ...base, encoding: unicode },
        format,
        encodingSource: bom ? 'bom' : 'utf8',
        encodingCertain: true,
        language: lang.language,
        languageCertain: lang.certain,
        hintUsed: lang.hintUsed,
        candidates: scored.filter((s) => s.plausible).slice(0, 5).map((s) => ({ encoding: unicode, language: s.language, score: round(s.score) })),
        preview: previewOf(text, format)
      }
    }
  }

  if (format === 'ass') return { ok: false, code: 'ass-legacy', error: ASS_LEGACY_REFUSAL }

  const languageCps = override ? legacyEncodingsFor(override) : []
  if (override && languageCps.length === 0) {
    return {
      ok: false,
      code: 'override-unsupported',
      error:
        `This file is not UTF-8, and no supported legacy code page is known for the chosen language. ` +
        'Choose another language, or re-save the file as UTF-8 and try again. The file was left untouched.'
    }
  }
  const reading = override && opts.encoding ? (languageCps.find((cp) => cp === opts.encoding) ?? null) : undefined
  if (reading === null) {
    return {
      ok: false,
      code: 'override-unsupported',
      error:
        `The chosen reading (${opts.encoding}) is not one the chosen language is written in. ` +
        'Choose the language again. The file was left untouched.'
    }
  }
  const overrideCps = reading ? [reading] : languageCps

  type Legacy = Scored & { encoding: LegacyEncoding; text: string; tokens: number }
  const all: Legacy[] = []
  const cps = override ? overrideCps : LEGACY_ENCODINGS
  for (const cp of cps) {
    const text = decodeSubtitleBuffer(buf, cp)
    const st = textStats(analysisText(text, format))
    for (const s of scoreProfiles(st, (p) => p.cps.includes(cp))) all.push({ ...s, encoding: cp, text, tokens: st.tokens.length })
  }
  all.sort((a, b) => b.score - a.score)

  if (override) {
    const base2 = override.split('-')[0].toLowerCase()
    // One reading per code page the language allows, scored as that language (0 when it did not score).
    const readings = overrideCps
      .map((cp) => {
        const own = all.find((c) => c.encoding === cp && c.language === base2)
        return { encoding: cp, text: own?.text ?? decodeSubtitleBuffer(buf, cp), score: own?.score ?? 0 }
      })
      .sort((a, b) => b.score - a.score)
    const pick = readings[0]
    // A code page that reads the same letters is no rival; one that reads different letters is, unless
    // the language itself clearly prefers the pick. Enumeration order never decides between them.
    const rivals = readings.filter((r) => r !== pick && r.text !== pick.text && !(pick.score > 0 && pick.score >= MARGIN * r.score))
    const ambiguous = rivals.length > 0
    return {
      ok: true,
      inspection: {
        receipt: { ...base, encoding: pick.encoding },
        format,
        encodingSource: 'override',
        encodingCertain: !ambiguous,
        language: override,
        languageCertain: true,
        hintUsed: false,
        candidates: ambiguous
          ? [pick, ...rivals].map((r, _i, set) => ({
              encoding: r.encoding,
              language: override,
              score: round(r.score),
              preview: differingLine(r.text, set.find((o) => o !== r)!.text, format)
            }))
          : [],
        preview: previewOf(pick.text, format)
      }
    }
  }

  const plausible = all.filter((c) => c.plausible)
  if (plausible.length === 0) {
    return {
      ok: false,
      code: 'undetectable',
      error:
        'This subtitle file is not UTF-8, and no supported language decodes it plausibly. Choose the ' +
        "file's language to decode it, or re-save it as UTF-8. The file was left untouched."
    }
  }

  const tokenCount = plausible[0].tokens
  const byLang = plausible.filter((c, i) => plausible.findIndex((d) => d.language === c.language) === i)
  const lang = decideLanguage(byLang, tokenCount, hint, '')
  const chosen = byLang.find((c) => c.language === lang.language) ?? byLang[0]
  // A rival code page only matters when its text actually differs from the chosen decode. It is sought
  // among every plausible decode, not one per language: two code pages can both read as the chosen
  // language and still give different letters.
  const rival = plausible.find((c) => c.encoding !== chosen.encoding && c.text !== chosen.text)
  const encodingCertain =
    (SCRIPT_DECIDED.has(chosen.language) || tokenCount >= MIN_TOKENS) && (!rival || chosen.score >= MARGIN * rival.score)
  return {
    ok: true,
    inspection: {
      receipt: { ...base, encoding: chosen.encoding },
      format,
      encodingSource: 'detected',
      encodingCertain,
      language: chosen.language,
      languageCertain: lang.certain && encodingCertain,
      hintUsed: lang.hintUsed,
      candidates: byLang.slice(0, 5).map((c) => ({ encoding: c.encoding, language: c.language, score: round(c.score) })),
      preview: previewOf(chosen.text, format)
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function decideLanguage(
  scored: Scored[],
  tokenCount: number,
  hint: string,
  override: string
): { language: string; certain: boolean; hintUsed: boolean } {
  if (override) return { language: override, certain: true, hintUsed: false }
  const plausible = scored.filter((s) => s.plausible)
  const top = plausible[0]
  if (!top) return { language: '', certain: false, hintUsed: false }
  const second = plausible[1]
  const hintBase = hint ? hint.split('-')[0].toLowerCase() : ''
  const hinted = hint ? plausible.find((s) => s.language === hint || s.language === hintBase) : undefined
  if (SCRIPT_DECIDED.has(top.language)) return { language: top.language, certain: true, hintUsed: false }
  const clear = !second || top.score >= MARGIN * second.score
  if (hinted && hinted.score >= HINT_WINDOW * top.score && (hinted !== top || !clear)) {
    return { language: hinted.language, certain: true, hintUsed: true }
  }
  return { language: top.language, certain: clear && tokenCount >= MIN_TOKENS, hintUsed: false }
}

/** Read a file once and inspect it. The receipt names the canonical path. */
export function inspectSubtitleFile(filePath: string, opts: Omit<InspectOptions, 'path'> = {}): SubtitleInspectResult {
  let canonical: string
  let buf: Buffer
  try {
    canonical = fs.realpathSync(filePath)
    buf = fs.readFileSync(canonical)
  } catch (e) {
    return { ok: false, code: 'read-failed', error: `The subtitle file could not be read: ${(e as Error).message}` }
  }
  return inspectSubtitleBytes(buf, { ...opts, path: canonical })
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

export type VerifiedSubtitle =
  | { ok: true; buffer: Buffer; text: string; receipt: SubtitleReceipt }
  | { ok: false; code: SubtitleRefusalCode; error: string }

/**
 * Start's single read (§17.5 item 8): read once, recompute the digest, refuse a path or digest mismatch,
 * and return that exact Buffer with its decode. A same-size, same-mtime replacement fails here on digest.
 */
export function readVerifiedSubtitle(inputPath: string, receipt: SubtitleReceipt): VerifiedSubtitle {
  let canonical: string
  let buf: Buffer
  try {
    canonical = fs.realpathSync(inputPath)
    buf = fs.readFileSync(canonical)
  } catch (e) {
    return { ok: false, code: 'read-failed', error: `The subtitle file could not be read: ${(e as Error).message}` }
  }
  if (!samePath(canonical, receipt.path)) {
    return {
      ok: false,
      code: 'path-mismatch',
      error: 'The subtitle file to translate is not the one that was inspected. Load it again and retry.'
    }
  }
  if (buf.length !== receipt.byteLength || sha256Hex(buf) !== receipt.sha256) {
    return {
      ok: false,
      code: 'changed',
      error: 'The subtitle file changed after it was loaded. Load it again so its encoding and language are re-checked.'
    }
  }
  let text: string
  try {
    text = decodeSubtitleBuffer(buf, receipt.encoding)
  } catch (e) {
    return { ok: false, code: 'read-failed', error: `The subtitle file could not be decoded: ${(e as Error).message}` }
  }
  return { ok: true, buffer: buf, text, receipt }
}
