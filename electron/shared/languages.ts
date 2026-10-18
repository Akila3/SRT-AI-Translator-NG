export interface LangOption {
  value: string
  label: string
  /**
   * The name the model is given: gst's `-l`, and the native instruction's target (Gemini understands
   * full language names). A regional value names its variety ("Brazilian Portuguese"), never the
   * generic language (implementation_plan.md §14.7).
   */
  gstName: string
}

export const LANGUAGES: LangOption[] = [
  { value: 'auto', label: 'Auto Detect', gstName: '' },
  { value: 'af', label: 'Afrikaans', gstName: 'Afrikaans' },
  { value: 'sq', label: 'Albanian', gstName: 'Albanian' },
  { value: 'am', label: 'Amharic', gstName: 'Amharic' },
  { value: 'ar', label: 'Arabic', gstName: 'Arabic' },
  { value: 'ar-EG', label: 'Arabic (Egypt)', gstName: 'Egyptian Arabic' },
  { value: 'hy', label: 'Armenian', gstName: 'Armenian' },
  { value: 'az', label: 'Azerbaijani', gstName: 'Azerbaijani' },
  { value: 'eu', label: 'Basque', gstName: 'Basque' },
  { value: 'be', label: 'Belarusian', gstName: 'Belarusian' },
  { value: 'bn', label: 'Bengali', gstName: 'Bengali' },
  { value: 'bs', label: 'Bosnian', gstName: 'Bosnian' },
  { value: 'bg', label: 'Bulgarian', gstName: 'Bulgarian' },
  { value: 'ca', label: 'Catalan', gstName: 'Catalan' },
  { value: 'zh', label: 'Chinese (Simplified)', gstName: 'Simplified Chinese' },
  { value: 'zh-TW', label: 'Chinese (Traditional)', gstName: 'Traditional Chinese' },
  { value: 'hr', label: 'Croatian', gstName: 'Croatian' },
  { value: 'cs', label: 'Czech', gstName: 'Czech' },
  { value: 'da', label: 'Danish', gstName: 'Danish' },
  { value: 'nl', label: 'Dutch', gstName: 'Dutch' },
  { value: 'en', label: 'English', gstName: 'English' },
  { value: 'et', label: 'Estonian', gstName: 'Estonian' },
  { value: 'fi', label: 'Finnish', gstName: 'Finnish' },
  { value: 'fr', label: 'French', gstName: 'French' },
  { value: 'gl', label: 'Galician', gstName: 'Galician' },
  { value: 'ka', label: 'Georgian', gstName: 'Georgian' },
  { value: 'de', label: 'German', gstName: 'German' },
  { value: 'el', label: 'Greek', gstName: 'Greek' },
  { value: 'gu', label: 'Gujarati', gstName: 'Gujarati' },
  { value: 'ht', label: 'Haitian Creole', gstName: 'Haitian Creole' },
  { value: 'he', label: 'Hebrew', gstName: 'Hebrew' },
  { value: 'hi', label: 'Hindi', gstName: 'Hindi' },
  { value: 'hu', label: 'Hungarian', gstName: 'Hungarian' },
  { value: 'is', label: 'Icelandic', gstName: 'Icelandic' },
  { value: 'id', label: 'Indonesian', gstName: 'Indonesian' },
  { value: 'ga', label: 'Irish', gstName: 'Irish' },
  { value: 'it', label: 'Italian', gstName: 'Italian' },
  { value: 'ja', label: 'Japanese', gstName: 'Japanese' },
  { value: 'kn', label: 'Kannada', gstName: 'Kannada' },
  { value: 'kk', label: 'Kazakh', gstName: 'Kazakh' },
  { value: 'ko', label: 'Korean', gstName: 'Korean' },
  { value: 'ky', label: 'Kyrgyz', gstName: 'Kyrgyz' },
  { value: 'lv', label: 'Latvian', gstName: 'Latvian' },
  { value: 'lt', label: 'Lithuanian', gstName: 'Lithuanian' },
  { value: 'mk', label: 'Macedonian', gstName: 'Macedonian' },
  { value: 'ms', label: 'Malay', gstName: 'Malay' },
  { value: 'ml', label: 'Malayalam', gstName: 'Malayalam' },
  { value: 'mr', label: 'Marathi', gstName: 'Marathi' },
  { value: 'mn', label: 'Mongolian', gstName: 'Mongolian' },
  { value: 'ne', label: 'Nepali', gstName: 'Nepali' },
  { value: 'no', label: 'Norwegian', gstName: 'Norwegian' },
  { value: 'ps', label: 'Pashto', gstName: 'Pashto' },
  { value: 'fa', label: 'Persian', gstName: 'Persian' },
  { value: 'pl', label: 'Polish', gstName: 'Polish' },
  { value: 'pt', label: 'Portuguese', gstName: 'Portuguese' },
  { value: 'pt-PT', label: 'Portuguese (Portugal)', gstName: 'European Portuguese' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)', gstName: 'Brazilian Portuguese' },
  { value: 'pa', label: 'Punjabi', gstName: 'Punjabi' },
  { value: 'ro', label: 'Romanian', gstName: 'Romanian' },
  { value: 'ru', label: 'Russian', gstName: 'Russian' },
  { value: 'sr', label: 'Serbian', gstName: 'Serbian' },
  { value: 'si', label: 'Sinhala', gstName: 'Sinhala' },
  { value: 'sk', label: 'Slovak', gstName: 'Slovak' },
  { value: 'sl', label: 'Slovenian', gstName: 'Slovenian' },
  { value: 'so', label: 'Somali', gstName: 'Somali' },
  { value: 'es', label: 'Spanish', gstName: 'Spanish' },
  { value: 'es-ES', label: 'Spanish (Spain)', gstName: 'Spanish (Spain)' },
  { value: 'es-MX', label: 'Spanish (Mexico)', gstName: 'Mexican Spanish' },
  { value: 'sw', label: 'Swahili', gstName: 'Swahili' },
  { value: 'sv', label: 'Swedish', gstName: 'Swedish' },
  { value: 'tl', label: 'Tagalog', gstName: 'Tagalog' },
  { value: 'tg', label: 'Tajik', gstName: 'Tajik' },
  { value: 'ta', label: 'Tamil', gstName: 'Tamil' },
  { value: 'te', label: 'Telugu', gstName: 'Telugu' },
  { value: 'th', label: 'Thai', gstName: 'Thai' },
  { value: 'tr', label: 'Turkish', gstName: 'Turkish' },
  { value: 'tk', label: 'Turkmen', gstName: 'Turkmen' },
  { value: 'uk', label: 'Ukrainian', gstName: 'Ukrainian' },
  { value: 'ur', label: 'Urdu', gstName: 'Urdu' },
  { value: 'uz', label: 'Uzbek', gstName: 'Uzbek' },
  { value: 'vi', label: 'Vietnamese', gstName: 'Vietnamese' },
  { value: 'cy', label: 'Welsh', gstName: 'Welsh' },
  { value: 'xh', label: 'Xhosa', gstName: 'Xhosa' },
  { value: 'yo', label: 'Yoruba', gstName: 'Yoruba' },
  { value: 'zu', label: 'Zulu', gstName: 'Zulu' }
]

/** UI source list includes Auto Detect; target list excludes it. */
export const SOURCE_LANGUAGES = LANGUAGES
export const TARGET_LANGUAGES = LANGUAGES.filter((l) => l.value !== 'auto')

/** Case and `-`/`_` are spelling, not meaning: `zh-tw`, `ZH_TW` and `zh-TW` are one value. */
function lookupKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/_/g, '-')
}

const byKey = new Map(LANGUAGES.map((l) => [lookupKey(l.value), l]))

/** The registry's own spelling of a language value, or `''` when it is not one. */
export function canonicalLanguage(raw: string | undefined): string {
  return raw ? (byKey.get(lookupKey(raw))?.value ?? '') : ''
}

export function langLabel(code: string): string {
  return byKey.get(lookupKey(code))?.label ?? code
}

export function gstLanguageName(code: string): string {
  return byKey.get(lookupKey(code))?.gstName ?? code
}

/** ffprobe ISO 639-2/B (3-letter) → our 2-letter UI codes */
export const ISO3_TO_CODE: Record<string, string> = {
  AFR: 'af', SQI: 'sq', ALB: 'sq', AMH: 'am', ARA: 'ar', ARM: 'hy', HYE: 'hy',
  AZE: 'az', EUS: 'eu', BAQ: 'eu', BEL: 'be', BEN: 'bn', BOS: 'bs', BUL: 'bg',
  CAT: 'ca', CHI: 'zh', ZHO: 'zh', HRV: 'hr', CZE: 'cs', CES: 'cs', DAN: 'da',
  DUT: 'nl', NLD: 'nl', ENG: 'en', EST: 'et', FIN: 'fi', FRE: 'fr', FRA: 'fr',
  GLG: 'gl', GEO: 'ka', KAT: 'ka', GER: 'de', DEU: 'de', GRE: 'el', ELL: 'el',
  GUJ: 'gu', HAT: 'ht', HEB: 'he', HIN: 'hi', HUN: 'hu', ISL: 'is', ICE: 'is',
  IND: 'id', GLE: 'ga', ITA: 'it', JPN: 'ja', KAN: 'kn', KAZ: 'kk', KOR: 'ko',
  KIR: 'ky', LAV: 'lv', LIT: 'lt', MAC: 'mk', MKD: 'mk', MAY: 'ms', MSA: 'ms',
  MAL: 'ml', MAR: 'mr', MON: 'mn', NEP: 'ne', NOR: 'no', PUS: 'ps', PER: 'fa',
  FAS: 'fa', POL: 'pl', POR: 'pt', PAN: 'pa', RON: 'ro', RUM: 'ro', RUS: 'ru',
  SRP: 'sr', SIN: 'si', SLK: 'sk', SLO: 'sk', SLV: 'sl', SOM: 'so', SPA: 'es',
  SWA: 'sw', SWE: 'sv', TGL: 'tl', TAJ: 'tg', TAM: 'ta', TEL: 'te', THA: 'th',
  TUR: 'tr', TUK: 'tk', UKR: 'uk', URD: 'ur', UZB: 'uz', VIE: 'vi', WEL: 'cy',
  CYM: 'cy', XHO: 'xh', YOR: 'yo', ZUL: 'zu'
}

/**
 * A track's language tag as a registry value. An ISO 639-2 tag is generic (`por` → `pt`); a regional
 * value is returned only when the tag names it exactly (`pt-BR`, `pt_br`), so an unknown region is
 * never guessed into a listed one.
 */
export function normalizeTrackLang(raw: string | undefined): string {
  if (!raw) return ''
  const up = raw.toUpperCase()
  if (ISO3_TO_CODE[up]) return ISO3_TO_CODE[up]
  return canonicalLanguage(raw)
}

/** The five right-to-left languages the RTL formatting names (feature_decisions.md D12-16). */
export type RtlLanguage = 'he' | 'ar' | 'fa' | 'ps' | 'ur'

/**
 * The only spellings that establish one, matched after case and `_`/`-` folding: the code, the retired
 * `iw`, ISO 639-2 and English names. A regional value counts by its primary subtag (`he-IL`, `ar-EG`).
 * Adding a language needs a registry entry here, a help update and its own fixtures.
 */
const RTL_LANGUAGE_ALIASES: Readonly<Record<string, RtlLanguage>> = {
  he: 'he', iw: 'he', heb: 'he', hebrew: 'he',
  ar: 'ar', ara: 'ar', arabic: 'ar',
  fa: 'fa', fas: 'fa', per: 'fa', persian: 'fa', farsi: 'fa',
  ps: 'ps', pus: 'ps', pashto: 'ps', pushto: 'ps',
  ur: 'ur', urd: 'ur', urdu: 'ur'
}

/**
 * A known RTL language for Smart RTL's context, or `null`. `''`, `auto`, `zxx`, any other language and any
 * non-string are `null`: the caller then uses the line-by-line fallback. Only an accepted run's own target
 * or a user-confirmed transcription code is ever passed here, never model output.
 */
export function normalizeRtlLanguage(value: unknown): RtlLanguage | null {
  if (typeof value !== 'string') return null
  const key = lookupKey(value)
  if (!key) return null
  return RTL_LANGUAGE_ALIASES[key] ?? RTL_LANGUAGE_ALIASES[key.split('-')[0]] ?? null
}

/** Retired ISO 639-1 codes still common in subtitle filenames. */
const RETIRED_CODES: Record<string, string> = { iw: 'he', ji: 'yi', jw: 'jv' }
/** Filename tokens that sit where a language tag would and are not one (`Film.en.forced.srt`). */
const NON_LANGUAGE_TAGS = new Set(['forced', 'sdh', 'cc', 'default', 'full', 'signs', 'songs'])
const byLabel = new Map(LANGUAGES.filter((l) => l.value !== 'auto').map((l) => [l.label.toLowerCase(), l.value]))

/**
 * A subtitle's language HINT for intake (feature_decisions.md §2.6 step 5): the track's own tag when there
 * is one, else the filename's trailing tag (`Film.he.srt`, `Film.heb.srt`, `Film.iw.srt`,
 * `Film.pt-BR.srt`, `Film.Hebrew.srt`). Only the last tag position is read, so a title word elsewhere in
 * the name ("It", "No") is never taken for one. It is only ever a tiebreaker; filenames are not
 * authoritative.
 */
export function subtitleLanguageHint(fileName: string, trackLanguage?: string): string {
  const fromTrack = normalizeTrackLang(trackLanguage)
  if (fromTrack) return fromTrack
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.[^.]+$/, '')
  const tokens = stem.split(/[.\s_[\]()]+/).filter(Boolean)
  if (tokens.length < 2) return ''
  let i = tokens.length - 1
  while (i > 0 && NON_LANGUAGE_TAGS.has(tokens[i].toLowerCase())) i--
  if (i === 0) return ''
  const tag = tokens[i]
  const lower = tag.toLowerCase()
  if (RETIRED_CODES[lower]) return canonicalLanguage(RETIRED_CODES[lower])
  if (/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(tag)) return normalizeTrackLang(tag)
  return byLabel.get(lower) ?? ''
}
