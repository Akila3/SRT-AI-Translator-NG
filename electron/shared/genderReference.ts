/**
 * Bundle H, the gender reference a Translate run uses (feature_decisions.md §2–§3). Shared by the Translate
 * page, which freezes it at Start, and the run, which reads nothing else. Pure: no I/O, no engine import.
 */

/** §2.2: exactly two strengths. */
export type OracleStrength = 'hard' | 'hint'

/** Where a reference file came from. Decides gender eligibility (H19a), never the user. */
export type ReferenceProvenance = 'disk' | 'opensubtitles' | 'wizdom'

/** `_REF_CHAIN` (§3.4), German included: the walk skips `de` by rule unless 2b prefers it (E47). */
export const REF_CHAIN_WITH_DE: readonly string[] = Object.freeze(['he', 'ar', 'hi', 'es', 'ru', 'pt', 'pl', 'uk', 'fr', 'de', 'it', 'cs', 'ro', 'el', 'bg', 'sr', 'hr', 'sk', 'ur', 'nl'])

/** `per_lang_limit` (§3.4) and the default `per_run_limit` (§3.5). */
export const PER_LANG_LIMIT = 5
export const DEFAULT_PER_RUN_LIMIT = 10

/** The first shipping UI shows the reference controls only when translating into Hebrew (P7). */
export function referenceUiShown(targetLang: string): boolean {
  return targetLang.trim().toLowerCase().split(/[-_]/)[0] === 'he'
}

export type GenderReferenceArgs =
  | {
      readonly mode: 'file'
      /** A disk pick, or the file an OpenSubtitles / Wizdom pick staged in the app's scratch folder. */
      readonly path: string
      readonly provenance: ReferenceProvenance
      /** The detected or user-corrected language (`ar`, `he`, …); null when nothing scored. */
      readonly language: string | null
      /** Feature 1 **This is human Hebrew**: only a disk file in Hebrew can carry it. */
      readonly humanHebrew: boolean
      /** An OpenSubtitles pick's AI / machine-translation flag; null when the service did not say. */
      readonly machineTranslated: boolean | null
      readonly strength: OracleStrength
      readonly hardGermanConfirmed: boolean
    }
  | {
      readonly mode: 'auto'
      readonly imdbId: string
      readonly season?: number
      readonly episode?: number
      /** Request 2b: try this language first this run; null for none. */
      readonly prefer: string | null
      /** `per_run_limit`: at least 1. */
      readonly perRunLimit: number
      readonly strength: OracleStrength
      readonly hardGermanConfirmed: boolean
    }

/**
 * The wording a helper gets (§2.2, E48, W-de-4): a German reference is Hint unless this run's Hard-German
 * confirmation is on, whatever the general control says; any other reference takes the user's strength.
 */
export function effectiveStrength(strength: OracleStrength, referenceLanguage: string | null, hardGermanConfirmed: boolean): OracleStrength {
  if ((referenceLanguage ?? '').toLowerCase().split(/[-_]/)[0] === 'de') return hardGermanConfirmed ? 'hard' : 'hint'
  return strength
}

/** What the page holds while the user edits. Frozen into `GenderReferenceArgs` at Start. */
export interface GenderReferenceDraft {
  mode: 'off' | 'file' | 'auto'
  file: { path: string; name: string; provenance: ReferenceProvenance; language: string | null; machineTranslated: boolean | null } | null
  /** The user's correction of the detected language, for this file only. */
  languagePick: string | null
  humanHebrew: boolean
  prefer: string
  perRunLimit: number
  strength: OracleStrength
  hardGermanConfirmed: boolean
  season: number | null
  episode: number | null
}

export const EMPTY_REFERENCE_DRAFT: GenderReferenceDraft = Object.freeze({
  mode: 'off',
  file: null,
  languagePick: null,
  humanHebrew: false,
  prefer: '',
  perRunLimit: DEFAULT_PER_RUN_LIMIT,
  strength: 'hard',
  hardGermanConfirmed: false,
  season: null,
  episode: null
}) as GenderReferenceDraft

/** The TMDB title the page has selected, as far as the reference needs it. */
export interface ReferenceTitle {
  imdbId: string
  mediaType: 'movie' | 'tv'
}

/** A registry or provider language value as a reference code (`pt-BR` → `pt`); null when blank. */
export function referenceCode(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return null
  const base = v.split(/[-_]/)[0]
  return base === 'iw' ? 'he' : base
}

/** A Hebrew-target reference needs wording for its language: `he`, `ar`, or a `_GENDER_SIGNALS` row (German included). */
export function referenceUsable(code: string | null): boolean {
  return code !== null && REF_CHAIN_WITH_DE.includes(code)
}

/**
 * A new reference file replaces the old one's per-file answers: the language correction, **This is human
 * Hebrew** and the Hard-German confirmation (W-de-4 b2: a new helper load resets it).
 */
export function withReferenceFile(draft: GenderReferenceDraft, file: GenderReferenceDraft['file']): GenderReferenceDraft {
  return { ...draft, file, languagePick: null, humanHebrew: false, hardGermanConfirmed: false }
}

/** W-de-4 b1: once a Start has frozen its arguments, the Hard-German confirmation is spent; the next run asks again. */
export function referenceAfterStart(draft: GenderReferenceDraft): GenderReferenceDraft {
  return draft.hardGermanConfirmed ? { ...draft, hardGermanConfirmed: false } : draft
}

/**
 * §3.3: the file a run's automatic walk accepted fills the field the manual picker fills — an OpenSubtitles file
 * the service flags human, as a picker download of it would be. The mode and the run's frozen arguments stay.
 */
export function referenceFromWalk(draft: GenderReferenceDraft, walked: { path: string; name: string; language: string | null }): GenderReferenceDraft {
  return withReferenceFile(draft, { path: walked.path, name: walked.name, provenance: 'opensubtitles', language: referenceCode(walked.language), machineTranslated: false })
}

/**
 * The source a Translate run reads, as the user chose it: the subtitle file, else the video and its subtitle
 * stream. A track extracted to a scratch file has the same identity before extraction, after a language
 * question and after launch — the scratch path is never part of it.
 */
export function runSourceIdentity(srtFile: string, videoFile: string, track: number | null): string {
  return srtFile || (videoFile && track !== null ? `${videoFile}\n${track}` : '')
}

/** What a run's walked file belongs to, taken at Start: the source/title/episode identity and the reference selection. */
export interface ReferenceHandoffMark {
  readonly identity: string
  readonly mode: GenderReferenceDraft['mode']
  readonly filePath: string | null
}

export function referenceHandoffMark(draft: GenderReferenceDraft, identity: string): ReferenceHandoffMark {
  return { identity, mode: draft.mode, filePath: draft.file?.path ?? null }
}

/**
 * The walked file fills the field only while the draft still belongs to the run that accepted it: the same
 * source, title and episode, and no newer reference selection. Otherwise the draft is returned unchanged.
 */
export function referenceFromRun(
  draft: GenderReferenceDraft,
  identityNow: string,
  mark: ReferenceHandoffMark | null,
  walked: { path: string; name: string; language: string | null }
): GenderReferenceDraft {
  if (mark === null || identityNow !== mark.identity || draft.mode !== mark.mode || (draft.file?.path ?? null) !== mark.filePath) return draft
  return referenceFromWalk(draft, walked)
}

export function draftLanguage(draft: GenderReferenceDraft): string | null {
  return draft.languagePick ?? draft.file?.language ?? null
}

/** `S01E02` / `s1e2` in a file name: the defaults for a TV title's season and episode. */
export function seasonEpisodeFromName(name: string): { season: number; episode: number } | null {
  const m = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?![0-9])/i.exec(name)
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null
}

/**
 * Start's refusals while Gender Reference is on (tester sanction 2026-10-17, R19-10): each names the setting
 * that asks for the missing piece, and that Off translates without it.
 */
const REFERENCE_OFF_WAY = 'or set Gender Reference to Off to translate without a reference.'
export const REFERENCE_FILE_MISSING = `Gender Reference is set to Choose a file, but no reference subtitle is chosen. Choose one, ${REFERENCE_OFF_WAY}`
export const REFERENCE_TITLE_MISSING = `Gender Reference is set to Download automatically, which needs a TMDB title with an IMDb id. Select one under TMDB Context, choose a file instead, ${REFERENCE_OFF_WAY}`
export const REFERENCE_EPISODE_MISSING = `Gender Reference is set to Download automatically, which needs this TV show’s season and episode. Enter them, ${REFERENCE_OFF_WAY}`
export const REFERENCE_OS_OFF = `Gender Reference is set to Download automatically, which needs OpenSubtitles turned on in Settings → Subtitle Sources. Turn it on, ${REFERENCE_OFF_WAY}`
export const REFERENCE_LIMIT_INVALID = `Gender Reference is set to Download automatically, and Downloads This Run must be a whole number of at least 1. Correct it, ${REFERENCE_OFF_WAY}`

/** A TMDB title automatic download can search with: one carrying an IMDb id. The panel greys the mode without one. */
export function referenceTitleUsable(title: ReferenceTitle | null): title is ReferenceTitle {
  return title !== null && /^tt\d+$/.test(title.imdbId)
}

/**
 * Start's snapshot, or the reason Start cannot run. `null` when the run has no reference: the controls are
 * hidden (non-Hebrew target) or set to Off.
 */
export function genderReferenceArgs(
  draft: GenderReferenceDraft,
  targetLang: string,
  title: ReferenceTitle | null,
  openSubtitlesOn: boolean
): { args: GenderReferenceArgs | null } | { refusal: string } {
  if (!referenceUiShown(targetLang) || draft.mode === 'off') return { args: null }
  if (draft.mode === 'file') {
    if (!draft.file) return { refusal: REFERENCE_FILE_MISSING }
    const { path, provenance, machineTranslated } = draft.file
    const language = draftLanguage(draft)
    return {
      args: Object.freeze({
        mode: 'file',
        path,
        provenance,
        language,
        humanHebrew: provenance === 'disk' && language === 'he' && draft.humanHebrew,
        machineTranslated: provenance === 'opensubtitles' ? machineTranslated : null,
        strength: draft.strength,
        hardGermanConfirmed: draft.hardGermanConfirmed
      })
    }
  }
  if (!openSubtitlesOn) return { refusal: REFERENCE_OS_OFF }
  if (!referenceTitleUsable(title)) return { refusal: REFERENCE_TITLE_MISSING }
  if (title.mediaType === 'tv' && (draft.season === null || draft.episode === null)) return { refusal: REFERENCE_EPISODE_MISSING }
  if (!Number.isSafeInteger(draft.perRunLimit) || draft.perRunLimit < 1) return { refusal: REFERENCE_LIMIT_INVALID }
  return {
    args: Object.freeze({
      mode: 'auto',
      imdbId: title.imdbId,
      ...(title.mediaType === 'tv' ? { season: draft.season as number, episode: draft.episode as number } : {}),
      prefer: draft.prefer || null,
      perRunLimit: draft.perRunLimit,
      strength: draft.strength,
      hardGermanConfirmed: draft.hardGermanConfirmed
    })
  }
}
