import React, { useEffect, useRef, useState } from 'react'
import { Label, NumberInput, Select, Button, Tooltip } from './ui'
import { InputFilePicker } from './InputFilePicker'
import { langLabel } from '../data/languages'
import {
  REF_CHAIN_WITH_DE,
  PER_LANG_LIMIT,
  draftLanguage,
  referenceCode,
  referenceTitleUsable,
  referenceUsable,
  withReferenceFile,
  type GenderReferenceDraft,
  type ReferenceTitle
} from '../../electron/shared/genderReference'
import type { AppSettings, OsCandidate, SubtitleFetchResult } from '../../electron/shared/types'

/** Translate tab, Bundle H (feature_decisions.md §2–§3). Shown only for a Hebrew target (P7). */
export const REFERENCE_TITLE = 'Gender Reference'
export const REFERENCE_MODE_TIP =
  'A human subtitle of the same film or episode in a language that marks gender (Hebrew, Arabic, Spanish, Russian and others). Each line’s counterpart is shown to the model, so “you” and “I” get the right gender instead of a guess. Off by default.\n\nChoose a file: a subtitle on this computer, or one you pick from an OpenSubtitles or Wizdom search.\n\nDownload automatically: the app finds one on OpenSubtitles when you press Start.'
export const REFERENCE_MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'file', label: 'Choose a file' },
  { value: 'auto', label: 'Download automatically' }
]
/**
 * The mode menu for the current title: "Download automatically" is greyed until a TMDB title with an IMDb id is
 * selected — it searches with that id. A missing key, username or password never greys it (the pool key always
 * exists). Off and Choose a file are always available. A mode already set stays set when the title is cleared.
 */
export function referenceModeOptions(titleUsable: boolean): { value: string; label: string; disabled?: boolean }[] {
  return titleUsable ? REFERENCE_MODE_OPTIONS : REFERENCE_MODE_OPTIONS.map((o) => (o.value === 'auto' ? { ...o, disabled: true } : o))
}
export const REFERENCE_AUTO_NEEDS_TITLE = '“Download automatically” needs a TMDB title. Select one in the TMDB search above to turn it on.'
export const REFERENCE_AUTO_TITLE_MISSING = 'No TMDB title is selected. Select one in the TMDB search above: automatic download searches with it.'
export const REFERENCE_SEARCH_NEEDS_TITLE = 'Select a TMDB title above to search online.'
export const REFERENCE_AUTO_TIP = [
  'At Start, the app searches OpenSubtitles.com for this title (it needs a TMDB title selected above, for its IMDb id) and downloads human subtitles until one lines up with your subtitle in time. That file becomes the gender reference.',
  `Languages are tried in quality order — Hebrew, then Arabic, Hindi, Spanish, Russian and so on — up to ${PER_LANG_LIMIT} files per language and the run’s download limit below. Files OpenSubtitles marks as AI or machine translated, or does not mark at all, are skipped. German is tried only when you prefer it.`,
  'Where the downloads come from: with nothing entered in Settings → Subtitle Sources, the app uses the shared pool of community keys (the method the Kodi add-on uses), so this works without any account. With your own API key, that key is used; with a username and password, downloads are counted against your account’s daily allowance.',
  'If nothing suitable is found, the translation runs without a reference.'
].join('\n\n')
export const REFERENCE_HUMAN_HEBREW_LABEL = 'This is human Hebrew'
export const REFERENCE_HUMAN_HEBREW_TIP =
  'Tick only if you are 100% sure this file was made by a person, not by AI or machine translation. Machine-translated Hebrew tends to default to masculine, and correcting gender from it would make the output worse. If you are not sure, leave it off: the file is then not used for gender.'
export const REFERENCE_STRENGTH_TIP = [
  'Hard: the reference’s gender is a rule the model must follow. Hint: the same facts as a preference, applied only where the reference marks gender unambiguously. Use Hint if the translation starts copying the reference’s wording.',
  'Which to choose depends on the language of the reference file (the translation itself is always into Hebrew):',
  '• Hebrew reference: Hard, the setting the Kodi add-on this comes from was validated with.\n• Arabic reference: Hard. An estimate, not yet tested: Arabic marks “you” as male or female the way Hebrew does.\n• German reference: Hint, which the app uses unless you confirm Hard for the run. Tested: Hard showed no clear gain.\n• Any other language (Spanish, Russian, French and the rest): Hint. An estimate, not yet tested: these languages mark gender in fewer places, so a strict rule has less to go on.'
].join('\n\n')
export const REFERENCE_STRENGTH_OPTIONS = [
  { value: 'hard', label: 'Hard' },
  { value: 'hint', label: 'Hint' }
]
export const REFERENCE_GERMAN_NOTE =
  'German reference — experimental and unmeasured. It uses Hint wording by default. Its Hard wording failed to establish a net benefit in the Kodi add-on’s production test, so tick the box below only to opt into that method for this run.'
export const REFERENCE_GERMAN_CONFIRM_LABEL = 'Use Hard wording for German this run'
export const REFERENCE_PREFER_TIP =
  'Optional. If you know this title has a good subtitle in one language, it is tried first (up to five files), before the usual order.'
export const REFERENCE_LIMIT_TIP =
  'The most OpenSubtitles downloads this run may use, frozen with the service’s remaining allowance at the first download. Default 10: five tries in Hebrew still leave five for Arabic.'
export const REFERENCE_WIZDOM_NOTE = 'A Wizdom file is never used for the gender hint or repair (Settings → Subtitle Sources).'
const SUBTITLE_FILTERS = [{ name: 'Subtitles', extensions: ['srt'] }]

const referenceOptions = REF_CHAIN_WITH_DE.map((c) => ({ value: c, label: langLabel(c) || c }))

function candidateOrder(a: OsCandidate, b: OsCandidate): number {
  const ia = REF_CHAIN_WITH_DE.indexOf(referenceCode(a.language) ?? '')
  const ib = REF_CHAIN_WITH_DE.indexOf(referenceCode(b.language) ?? '')
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.downloadCount - a.downloadCount
}

function mtBadge(c: OsCandidate): string {
  return c.machineTranslated === true ? 'AI / MT' : c.machineTranslated === null ? 'MT unknown' : 'human'
}

/** A download's staged files; each carries the language it is used as (feature_decisions.md §3.3). */
export interface StagedPick {
  files: { path: string; name: string; language: string | null; mislabelled: boolean }[]
  provenance: 'opensubtitles' | 'wizdom'
  machineTranslated: boolean | null
}

/** What the panel's results and requests belong to: one source, title and episode. */
export function referenceIdentity(sourcePath: string, title: ReferenceTitle | null, season: number | null, episode: number | null): string {
  return JSON.stringify([sourcePath, title?.imdbId ?? null, title?.mediaType ?? null, season, episode])
}

export const REFERENCE_REQUEST_FAILED = 'The request could not be completed. Try again.'

/** Automatic mode: what the shared file field holds — after a run, the file the walk accepted (§3.3). */
export function referenceFieldNote(file: NonNullable<GenderReferenceDraft['file']>): string {
  const from = file.provenance === 'opensubtitles' ? 'OpenSubtitles' : file.provenance === 'wizdom' ? 'Wizdom' : 'this computer'
  const lang = file.language ? `, ${langLabel(file.language) || file.language}` : ''
  return `Reference file: ${file.name} (${from}${lang}). Choose “Use this file” to translate with it again without downloading.`
}

/** The line after a download: how many files, the language correction when detection overrode the listing, and the allowance. */
export function downloadedMessage(r: Extract<SubtitleFetchResult, { ok: true }>, first: StagedPick['files'][number], listed: string | null, provenance: 'opensubtitles' | 'wizdom'): string {
  const head =
    r.files.length > 1
      ? `${r.files.length} subtitles in the download; ${r.chosenBy === 'alignment' ? 'the one that lines up best with your subtitle is selected' : 'the first is selected'} — change it below.`
      : 'Downloaded.'
  const name = (c: string | null): string => (c ? langLabel(c) || c : '')
  const corrected =
    first.mislabelled && listed && first.language
      ? ` ${provenance === 'wizdom' ? 'Wizdom' : 'OpenSubtitles'} lists it as ${name(listed)}, but it reads as ${name(first.language)}, so the reference language is set to ${name(first.language)} — change it below if that is wrong.`
      : ''
  const left = r.remaining !== null ? ` ${r.remaining} downloads left today.` : ''
  return `${head}${corrected}${left}`
}

export function GenderReferencePanel({
  draft,
  setDraft,
  title,
  sourcePath,
  sourceKey = sourcePath,
  settings,
  disabled
}: {
  draft: GenderReferenceDraft
  setDraft: React.Dispatch<React.SetStateAction<GenderReferenceDraft>>
  title: ReferenceTitle | null
  /** The subtitle file Wizdom aligns its members against; empty for a video track not yet extracted. */
  sourcePath: string
  /** The chosen source (`runSourceIdentity`): the subtitle, or the video and stream — what results belong to. */
  sourceKey?: string
  settings: Pick<AppSettings, 'subtitleSourceOpenSubtitles' | 'subtitleSourceWizdom'>
  disabled: boolean
}): React.JSX.Element {
  const [busy, setBusy] = useState<'' | 'detect' | 'search' | 'download'>('')
  const [message, setMessage] = useState('')
  const [osResults, setOsResults] = useState<OsCandidate[] | null>(null)
  const [wizdomResults, setWizdomResults] = useState<{ id: string; versionName: string }[] | null>(null)
  const [staged, setStaged] = useState<StagedPick | null>(null)
  const language = draftLanguage(draft)
  const query = title ? { imdbId: title.imdbId, ...(title.mediaType === 'tv' && draft.season !== null && draft.episode !== null ? { season: draft.season, episode: draft.episode } : {}) } : null
  const episodeMissing = title?.mediaType === 'tv' && (draft.season === null || draft.episode === null)
  const titleUsable = referenceTitleUsable(title)
  const set = (patch: Partial<GenderReferenceDraft>): void => setDraft((d) => ({ ...d, ...patch }))

  // Results, staged files and pending requests belong to one source, title and episode. When any changes, the
  // generation moves on: what was shown is cleared, and a request still in flight applies nothing on return —
  // not its file, its message or the end of its busy state.
  const identity = referenceIdentity(sourceKey, title, draft.season, draft.episode)
  const generation = useRef(0)
  const shownFor = useRef(identity)
  useEffect(() => {
    if (shownFor.current === identity) return
    shownFor.current = identity
    generation.current += 1
    setOsResults(null)
    setWizdomResults(null)
    setStaged(null)
    setMessage('')
    setBusy('')
  }, [identity])
  useEffect(
    () => () => {
      generation.current += 1
    },
    []
  )

  /** Run one request; its results apply only while the generation it started in is current. */
  async function guarded(kind: 'detect' | 'search' | 'download', work: (current: () => boolean) => Promise<void>): Promise<void> {
    const mine = generation.current
    const current = (): boolean => generation.current === mine
    setBusy(kind)
    try {
      await work(current)
    } catch {
      if (current()) setMessage(REFERENCE_REQUEST_FAILED)
    } finally {
      if (current()) setBusy('')
    }
  }

  function pickDisk(path: string): Promise<void> {
    const name = path.split(/[\\/]/).pop() ?? path
    setStaged(null)
    setDraft((d) => withReferenceFile(d, { path, name, provenance: 'disk', language: null, machineTranslated: null }))
    return guarded('detect', async (current) => {
      const r = await window.api.inspectSubtitle({ path })
      if (!current()) return
      setDraft((d) => (d.file?.path === path ? { ...d, file: { ...d.file, language: r.ok ? referenceCode(r.inspection.language) : null } } : d))
      setMessage(r.ok ? '' : r.error)
    })
  }

  function selectStaged(member: StagedPick['files'][number], s: StagedPick): void {
    setDraft((d) => withReferenceFile(d, { path: member.path, name: member.name, provenance: s.provenance, language: member.language, machineTranslated: s.machineTranslated }))
  }

  function searchOs(): Promise<void> {
    if (!query) return Promise.resolve()
    setMessage('')
    setWizdomResults(null)
    return guarded('search', async (current) => {
      const r = await window.api.openSubtitlesSearch({ ...query, languages: [...REF_CHAIN_WITH_DE] })
      if (!current()) return
      if (r.state === 'failed') {
        setOsResults(null)
        setMessage(r.message)
      } else {
        setOsResults([...r.candidates].sort(candidateOrder).slice(0, 60))
        setMessage(r.message ?? (r.candidates.length ? '' : 'OpenSubtitles has no subtitle for this title in a reference language.'))
      }
    })
  }

  function searchWizdom(): Promise<void> {
    if (!query) return Promise.resolve()
    setMessage('')
    setOsResults(null)
    return guarded('search', async (current) => {
      const r = await window.api.wizdomSearch(query)
      if (!current()) return
      setWizdomResults(r.ok ? r.entries.slice(0, 60) : null)
      setMessage(r.ok ? (r.entries.length ? '' : 'Wizdom has no subtitle for this title.') : r.message)
    })
  }

  function took(r: SubtitleFetchResult, provenance: 'opensubtitles' | 'wizdom', listed: string | null, mt: boolean | null): void {
    if (!r.ok) {
      setMessage(r.message)
      return
    }
    const s: StagedPick = { files: r.files.map((m) => ({ path: m.path, name: m.name, language: referenceCode(m.language) ?? listed, mislabelled: m.mislabelled })), provenance, machineTranslated: mt }
    setStaged(s)
    selectStaged(s.files[0], s)
    setMessage(downloadedMessage(r, s.files[0], listed, provenance))
  }

  function downloadOs(c: OsCandidate): Promise<void> {
    setMessage('')
    return guarded('download', async (current) => {
      const r = await window.api.openSubtitlesDownload(c.fileId, c.fileName, c.language)
      if (current()) took(r, 'opensubtitles', referenceCode(c.language), c.machineTranslated)
    })
  }

  function fetchWizdom(id: string): Promise<void> {
    setMessage('')
    return guarded('download', async (current) => {
      const r = await window.api.wizdomFetch(id, sourcePath || undefined)
      if (current()) took(r, 'wizdom', 'he', null)
    })
  }

  const off = disabled || busy !== ''
  const chosen = draft.file
  const german = draft.mode === 'file' ? language === 'de' : draft.mode === 'auto' && draft.prefer === 'de'

  return (
    <div className="space-y-3">
      <div>
        <Label tip={REFERENCE_MODE_TIP}>{REFERENCE_TITLE}</Label>
        <Select value={draft.mode} onChange={(v) => set({ mode: v as GenderReferenceDraft['mode'] })} options={referenceModeOptions(titleUsable)} className="w-64" />
        {!titleUsable && draft.mode !== 'auto' && <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">{REFERENCE_AUTO_NEEDS_TITLE}</p>}
      </div>

      {draft.mode !== 'off' && title?.mediaType === 'tv' && (
        <div className="flex items-end gap-3">
          <div>
            <Label>Season</Label>
            <NumberInput value={draft.season} min={0} max={99} allowEmpty onChange={(v) => set({ season: v ?? null })} className="w-24" />
          </div>
          <div>
            <Label>Episode</Label>
            <NumberInput value={draft.episode} min={1} max={999} allowEmpty onChange={(v) => set({ episode: v ?? null })} className="w-24" />
          </div>
        </div>
      )}

      {draft.mode === 'file' && (
        <div className="space-y-2">
          <InputFilePicker
            value={chosen ? (chosen.provenance === 'disk' ? chosen.path : `${chosen.name} (${chosen.provenance === 'opensubtitles' ? 'OpenSubtitles' : 'Wizdom'})`) : ''}
            placeholder="A human subtitle of the same title (.srt)"
            filters={SUBTITLE_FILTERS}
            onSelect={(p) => void pickDisk(p)}
            onClear={() => {
              setStaged(null)
              setDraft((d) => withReferenceFile(d, null))
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {settings.subtitleSourceOpenSubtitles && (
              <Button variant="secondary" disabled={off || !query || episodeMissing} onClick={() => void searchOs()}>
                Search OpenSubtitles
              </Button>
            )}
            {settings.subtitleSourceWizdom && (
              <Button variant="secondary" disabled={off || !query || episodeMissing} onClick={() => void searchWizdom()}>
                Search Wizdom
              </Button>
            )}
            {!title && (settings.subtitleSourceOpenSubtitles || settings.subtitleSourceWizdom) && (
              <span className="text-xs text-amber-600 dark:text-amber-400">{REFERENCE_SEARCH_NEEDS_TITLE}</span>
            )}
            {busy === 'search' || busy === 'download' ? <span className="text-xs text-gray-500 dark:text-gray-400">Working…</span> : null}
          </div>
          {staged && staged.files.length > 1 && chosen && chosen.provenance !== 'disk' && (
            <Select
              value={chosen.path}
              onChange={(p) => {
                const m = staged.files.find((x) => x.path === p)
                if (m) selectStaged(m, staged)
              }}
              options={staged.files.map((m) => ({ value: m.path, label: m.name }))}
              className="w-full"
            />
          )}
          {osResults && osResults.length > 0 && (
            <ul className="max-h-56 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200 text-xs dark:divide-gray-700 dark:border-gray-700">
              {osResults.map((c) => (
                <li key={c.fileId} className="flex items-center gap-2 px-2 py-1.5">
                  <span className="w-20 flex-shrink-0 font-semibold">{langLabel(referenceCode(c.language) ?? '') || c.language}</span>
                  <span className="min-w-0 flex-1 truncate" title={c.release || c.fileName}>
                    {c.release || c.fileName}
                  </span>
                  <span className={c.machineTranslated === false ? 'text-green-700 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}>{mtBadge(c)}</span>
                  <span className="w-14 text-right text-gray-500">{c.downloadCount}</span>
                  <Button variant="ghost" disabled={off} onClick={() => void downloadOs(c)}>
                    Use
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {wizdomResults && wizdomResults.length > 0 && (
            <ul className="max-h-56 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200 text-xs dark:divide-gray-700 dark:border-gray-700">
              {wizdomResults.map((w) => (
                <li key={w.id} className="flex items-center gap-2 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate">{w.versionName}</span>
                  <Button variant="ghost" disabled={off} onClick={() => void fetchWizdom(w.id)}>
                    Use
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {draft.file && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                <span>Reference language:</span>
                <Select
                  value={language ?? ''}
                  onChange={(v) => set({ languagePick: v || null })}
                  options={[{ value: '', label: busy === 'detect' ? 'Detecting…' : '— not detected —' }, ...referenceOptions]}
                  className="w-48"
                />
                {draft.file.language && draft.languagePick && draft.languagePick !== draft.file.language && (
                  <button type="button" className="text-brand underline" onClick={() => set({ languagePick: null })}>
                    revert to detected
                  </button>
                )}
              </div>
              {language !== null && !referenceUsable(language) && (
                <p className="text-xs text-amber-600 dark:text-amber-400">{langLabel(language) || language} has no gender wording; this file will not be used.</p>
              )}
              {draft.file.provenance === 'wizdom' && <p className="text-xs text-amber-600 dark:text-amber-400">{REFERENCE_WIZDOM_NOTE}</p>}
              {draft.file.provenance === 'opensubtitles' && draft.file.machineTranslated !== false && (
                <p className="text-xs text-amber-600 dark:text-amber-400">OpenSubtitles marks this file as AI / machine translated, or does not say: it is not used for gender.</p>
              )}
              {draft.file.provenance === 'disk' && language === 'he' && (
                <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                  <input type="checkbox" checked={draft.humanHebrew} onChange={(e) => set({ humanHebrew: e.target.checked })} />
                  {REFERENCE_HUMAN_HEBREW_LABEL}
                  <Tooltip tip={REFERENCE_HUMAN_HEBREW_TIP} />
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {draft.mode === 'auto' && (
        <div className="space-y-3">
          <p className="flex items-center text-xs text-gray-600 dark:text-gray-300">
            Downloads from OpenSubtitles at Start.
            <Tooltip tip={REFERENCE_AUTO_TIP} />
          </p>
          {!titleUsable && <p className="text-xs text-amber-600 dark:text-amber-400">{REFERENCE_AUTO_TITLE_MISSING}</p>}
          {!settings.subtitleSourceOpenSubtitles && <p className="text-xs text-amber-600 dark:text-amber-400">OpenSubtitles is turned off in Settings → Subtitle Sources.</p>}
          {chosen && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <span>
                {referenceFieldNote(chosen)}
              </span>
              <Button variant="ghost" disabled={off} onClick={() => set({ mode: 'file' })}>
                Use this file
              </Button>
            </p>
          )}
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label tip={REFERENCE_PREFER_TIP}>Prefer Language</Label>
              <Select value={draft.prefer} onChange={(v) => set({ prefer: v, hardGermanConfirmed: false })} options={[{ value: '', label: 'No preference' }, ...referenceOptions]} className="w-48" />
            </div>
            <div>
              <Label tip={REFERENCE_LIMIT_TIP}>Downloads This Run</Label>
              <NumberInput value={draft.perRunLimit} min={1} max={100} onChange={(v) => set({ perRunLimit: v ?? 0 })} className="w-24" />
            </div>
          </div>
        </div>
      )}

      {draft.mode !== 'off' &&
        (german ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            <p>{REFERENCE_GERMAN_NOTE}</p>
            <label className="mt-1.5 flex items-center gap-2">
              <input type="checkbox" checked={draft.hardGermanConfirmed} onChange={(e) => set({ hardGermanConfirmed: e.target.checked })} />
              {REFERENCE_GERMAN_CONFIRM_LABEL}
            </label>
          </div>
        ) : (
          <div>
            <Label tip={REFERENCE_STRENGTH_TIP}>Reference Strength</Label>
            <Select value={draft.strength} onChange={(v) => set({ strength: v as GenderReferenceDraft['strength'] })} options={REFERENCE_STRENGTH_OPTIONS} className="w-32" />
          </div>
        ))}

      {message && <p className="text-xs text-gray-600 dark:text-gray-300">{message}</p>}
    </div>
  )
}
