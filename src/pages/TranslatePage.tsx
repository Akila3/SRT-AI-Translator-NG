import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import {
  Box,
  BoxTitle,
  Label,
  Select,
  Button,
  Elapsed,
  ProgressBar,
  LogPanel,
  StatusCard,
  Working
} from '../components/ui'
import { FreeTierNotice } from '../components/FreeTierNotice'
import { TokenUsageCard } from '../components/TokenUsageCard'
import { SubTrackPanel } from '../components/SubTrackPanel'
import { InputFilePicker } from '../components/InputFilePicker'
import { TmdbSearch } from '../components/TmdbSearch'
import { GenderReferencePanel, referenceIdentity } from '../components/GenderReferencePanel'
import {
  EMPTY_REFERENCE_DRAFT,
  genderReferenceArgs,
  referenceAfterStart,
  referenceFromRun,
  referenceHandoffMark,
  referenceUiShown,
  runSourceIdentity,
  seasonEpisodeFromName,
  withReferenceFile,
  type GenderReferenceDraft,
  type ReferenceHandoffMark,
  type ReferenceTitle
} from '../../electron/shared/genderReference'
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, langLabel } from '../data/languages'
import { consoleLogPathFor, findConsoleLog } from '../../electron/shared/consoleLog'
import { companionName } from '../lib/outputName'
import { combineDescriptionSections } from '../lib/contextDescription'
import { defaultTrackIndex, selectVideoSource } from '../lib/inputSelection'
import { failureSentence, useRunner } from '../lib/useRunner'
import { ResumeChoice, resumeContinueAction } from '../components/ResumeChoice'
import { FailedBatchRetry } from '../components/FailedBatchRetry'
import { RESUMABLE_TRANSLATE_NOTE } from '../../electron/shared/types'
import { keptLinesText } from '../../electron/shared/runCopy'
import type {
  AppSettings,
  FailedSpanRetryDecision,
  ResumeDecision,
  ResumeInspectRequest,
  ResumeInspectResult,
  ResumeOffer,
  SubtitleCandidate,
  SubtitleEncoding,
  SubtitleInspectRequest,
  SubtitleInspectResult,
  SubtitleReceipt,
  SubtitleTrack,
  TranslateArgs
} from '../../electron/shared/types'

const VIDEO_FILTERS = [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'ts'] }]
// .ass stays pickable so the file is refused by name when chosen (DECISIONS D3), not hidden from the dialog.
const SUBTITLE_FILTERS = [{ name: 'Subtitles', extensions: ['srt', 'ass'] }]
const AUDIO_FILTERS = [
  { name: 'Audio/Video', extensions: ['mp3', 'aac', 'wav', 'm4a', 'flac', 'mp4', 'mkv'] }
]

/**
 * One piece of ffmpeg work this page is waiting on.
 *
 * `export` is a track written to a file the user chose; `prepare` is the silent extraction
 * that turns a chosen track into translation input. `pct` is null until the first report,
 * and stays null for a container that will not say how long it is.
 */
interface FfmpegTask {
  kind: 'export' | 'prepare'
  pct: number | null
  startedAt: number
}

/**
 * Which of the saved reports did NOT get the name they are supposed to have.
 *
 * The reports are named after the subtitle — `episode.srt` gets `episode.tokens.json` — so a name
 * already occupied by a stranger's file is stepped to `episode-2.tokens.json` rather than overwriting
 * it. That is the right trade, and it has a cost worth stating out loud: the file that still LOOKS
 * like this run's report is the older one, and this run's real report is somewhere nobody was told
 * about (SOL-15). A stepped name is anything that does not begin with the subtitle's stem and a dot.
 */
function renamedAmong(sidecars: string[], subtitlePath: string): string[] {
  const base = subtitlePath.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.[^.]*$/, '')
  if (!stem) return []
  return sidecars.filter((p) => {
    const name = p.split(/[\\/]/).pop() ?? ''
    return !name.startsWith(`${stem}.`)
  })
}

// ── Native resume (Phase 3, Step 3.4) ───────────────────────────────────────────────────────────

/** What a Start takes from Settings and the page's free text, read again at the moment it is sent. */
export function runSettingsArgs(
  cfg: AppSettings,
  description: string
): Omit<TranslateArgs, 'inputFile' | 'videoFile' | 'audioFile' | 'streamIndex' | 'sourceLang' | 'sourceReceipt' | 'targetLang'> {
  return {
    model: cfg.model,
    apiKeys: cfg.apiKeys,
    batchSize: cfg.batchSize,
    batchContext: cfg.batchContext,
    batchContextLines: cfg.batchContextLines,
    customGenerationParams: cfg.customGenerationParams,
    temperature: cfg.temperature,
    topP: cfg.topP,
    topK: cfg.topK,
    thinkingLevel: cfg.thinkingLevel,
    thinkingBudget: cfg.thinkingBudget,
    serviceTier: cfg.serviceTier,
    paidQuota: cfg.paidQuota,
    disableStreaming: cfg.disableStreaming,
    description: description || undefined,
    systemPrompt: cfg.systemPrompt || undefined,
    ffmpegPath: cfg.ffmpegPath || undefined,
    writeTokenReport: cfg.writeTokenReport,
    progressLog: cfg.progressLog,
    thoughtsLog: cfg.thoughtsLog,
    ...settingsHebrewFlags(cfg)
  }
}

// ── Advanced Hebrew correction (Feature 17) ──────────────────────────────────────────────────────

export type AdvancedHebrewFlags = Pick<Required<TranslateArgs>, 'hebrewSpeakerRepair' | 'hebrewMethodB' | 'hebrewC1Spanish' | 'hebrewC1Portuguese'>

/** The four values as a run takes them: anything but a stored `true` is off. */
export function advancedHebrewFlags(from: Partial<Record<keyof AdvancedHebrewFlags, unknown>> | null | undefined): AdvancedHebrewFlags {
  return {
    hebrewSpeakerRepair: from?.hebrewSpeakerRepair === true,
    hebrewMethodB: from?.hebrewMethodB === true,
    hebrewC1Spanish: from?.hebrewC1Spanish === true,
    hebrewC1Portuguese: from?.hebrewC1Portuguese === true
  }
}

/** The four as Settings hands them to a run: all off while the Advanced Hebrew correction master is off. */
export function settingsHebrewFlags(cfg: AppSettings | null | undefined): AdvancedHebrewFlags {
  return advancedHebrewFlags(cfg?.hebrewAdvanced === true ? cfg : null)
}

export const ADVANCED_HEBREW_LAYER_LABELS: Readonly<Record<keyof AdvancedHebrewFlags, string>> = {
  hebrewSpeakerRepair: 'Experimental speaker-gender repair',
  hebrewMethodB: 'Experimental unread-gender Method B',
  hebrewC1Spanish: 'Spanish reference rules',
  hebrewC1Portuguese: 'Portuguese reference rules'
}
export const ADVANCED_HEBREW_REQUESTED_TITLE = 'Advanced Hebrew correction requested'
export const ADVANCED_HEBREW_REQUESTED_NOTE = 'Eligibility is checked at run time; an enabled option may abstain.'
export const ADVANCED_HEBREW_INACTIVE_TITLE = 'Advanced Hebrew correction inactive'
export const ADVANCED_HEBREW_INACTIVE_NOTE = 'These saved options apply only when the target language is Hebrew.'

/**
 * A Settings language default that changed is followed by the Translate picker only while the picker still
 * shows the previous default (or nothing): a language chosen on this page is kept. 1.1.0 seeded once at
 * launch because re-seeding wiped a page choice; this follows without wiping one.
 */
export function followedLanguage(current: string, previousDefault: string, nextDefault: string): string {
  if (previousDefault === nextDefault) return current
  return current === previousDefault || current === '' ? nextDefault : current
}

/**
 * Which values the card describes: the run's snapshot while a Start is preparing, offering, running or
 * showing its ending; current Settings and target while idle.
 */
export function hebrewCardFor(
  run: { flags: AdvancedHebrewFlags; targetLang: string } | null,
  held: boolean,
  settings: AppSettings | null,
  targetLang: string
): { flags: AdvancedHebrewFlags; targetLang: string } {
  return held && run ? run : { flags: settingsHebrewFlags(settings), targetLang }
}

/**
 * What the Translate box says about the four options (implementation_plan.md §9.9d): nothing when all are
 * off; "requested" for a Hebrew target, listing only the ON layers; "inactive" for any other target. It
 * describes a request, never an outcome, and never disables Start.
 */
export function AdvancedHebrewCard({ flags, targetLang }: { flags: AdvancedHebrewFlags; targetLang: string }): React.JSX.Element | null {
  const on = (Object.keys(ADVANCED_HEBREW_LAYER_LABELS) as (keyof AdvancedHebrewFlags)[]).filter((k) => flags[k])
  if (on.length === 0) return null
  if (referenceUiShown(targetLang)) {
    return (
      <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
        <p className="font-semibold">{ADVANCED_HEBREW_REQUESTED_TITLE}</p>
        <ul className="mt-1 list-disc pl-5">
          {on.map((k) => (
            <li key={k}>{ADVANCED_HEBREW_LAYER_LABELS[k]}</li>
          ))}
        </ul>
        <p className="mt-1">{ADVANCED_HEBREW_REQUESTED_NOTE}</p>
      </div>
    )
  }
  return (
    <div className="mb-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300">
      <p className="font-semibold">{ADVANCED_HEBREW_INACTIVE_TITLE}</p>
      <p className="mt-1">{ADVANCED_HEBREW_INACTIVE_NOTE}</p>
    </div>
  )
}

/**
 * The pickers a Start names, for `resume:inspect`. An extracted track is named by its container and
 * stream, never by the temp file it was extracted to; the native adapter derives the same role.
 */
export function resumeInspectRequest(args: TranslateArgs): ResumeInspectRequest {
  const audio = args.audioFile ? { audioFile: args.audioFile } : {}
  if (args.streamIndex !== undefined && args.videoFile) {
    return { kind: 'translate', inputKind: 'extractedTrack', inputFile: args.inputFile, containerFile: args.videoFile, streamIndex: args.streamIndex, targetLang: args.targetLang, ...audio }
  }
  return { kind: 'translate', inputKind: 'subtitleFile', inputFile: args.inputFile, targetLang: args.targetLang, ...(args.videoFile ? { videoFile: args.videoFile } : {}), ...audio }
}

/** The start decision an inspection answer leads to without asking: none for the CLI, `fresh` for no work. */
export function startDecisionFor(found: ResumeInspectResult): { ask: ResumeOffer } | { resume: ResumeDecision | undefined } {
  if (found === 'unsupported') return { resume: undefined }
  if (found === null) return { resume: { action: 'fresh' } }
  return { ask: found }
}

/** An offer waiting for the user, with the Start that found it. */
interface PendingResume {
  offer: ResumeOffer
  args: TranslateArgs
  source: string
}

export const RESUME_INSPECT_LABEL = 'Checking for unfinished work'
export const RESUME_INSPECT_NOTE = 'The app is reading the complete selected file to verify saved work. Large media can take a few minutes.'

// ── The subtitle's language and encoding (Bundle A, feature_decisions §2.6–§2.8) ────────────────

/** Both inspections of one file: what it looks like on its own, and how the user's language reads it. */
export interface SourceInspected {
  path: string
  /** The language the second inspection was asked for: an explicit choice, or 'auto' when there was none. */
  userLang: string
  /** The reading the second inspection was asked for, when the user picked one. */
  encoding?: SubtitleEncoding
  detect: SubtitleInspectResult
  applied: SubtitleInspectResult | null
}

/**
 * What the page knows about the subtitle it would translate.
 *
 * `confirm` blocks Start (§2.7: insistent when not certain). `ready` carries what Start sends — the real
 * source language, or 'auto' only when the user asked the model to work it out — and the receipt Start
 * re-checks the file against.
 */
export type SourceCheck =
  | { kind: 'none' }
  | { kind: 'checking' }
  | {
      kind: 'refused'
      message: string
      /** The refusal came from the user's language choice, so choosing again or reverting can answer it. */
      canChange: boolean
    }
  | {
      kind: 'confirm'
      reason: 'language' | 'encoding' | 'undetectable' | 'mismatch' | 'reading'
      /** Best guess ('' when nothing scored); for `mismatch`, the language the file reads as. */
      guess: string
      /** For `mismatch`: the Source Language the user set. */
      chosen: string
      preview: string
      /** Whether "let the model work it out" is honest: only when the bytes themselves are not in doubt. */
      allowAuto: boolean
      /** For `reading`: each way the chosen language reads the bytes, with the line where they differ. */
      readings?: SubtitleCandidate[]
    }
  | {
      kind: 'ready'
      language: string
      receipt: SubtitleReceipt
      how: 'detected' | 'picked' | 'chosen' | 'auto'
      /** A certain detection, shown beside a language the user chose. */
      detected: string
      /** The decoded first line of a file that was not UTF-8, so a wrong reading is visible. */
      preview: string
    }

/** The language the second inspection reads the file as: the per-file pick, else the Source Language. */
export function sourceUserLanguage(filePick: string | null, srcLang: string): string {
  return filePick ?? srcLang
}

export async function inspectSource(
  inspect: (req: SubtitleInspectRequest) => Promise<SubtitleInspectResult>,
  path: string,
  trackLanguage: string | undefined,
  userLang: string,
  encoding?: SubtitleEncoding
): Promise<SourceInspected> {
  const ask = async (req: SubtitleInspectRequest): Promise<SubtitleInspectResult> => {
    try {
      return await inspect(req)
    } catch (e) {
      return { ok: false, code: 'read-failed', error: `The subtitle file could not be checked: ${String(e)}` }
    }
  }
  const detect = await ask({ path, trackLanguage })
  const pinned = userLang !== 'auto' ? encoding : undefined
  const applied = userLang !== 'auto' ? await ask({ path, trackLanguage, language: userLang, ...(pinned ? { encoding: pinned } : {}) }) : null
  return { path, userLang, ...(pinned ? { encoding: pinned } : {}), detect, applied }
}

export function sourceCheck(ins: SourceInspected, filePick: string | null, srcLang: string): SourceCheck {
  const d = ins.detect
  const detected = d.ok && d.inspection.languageCertain ? d.inspection.language : ''
  const explicit = filePick ?? (srcLang !== 'auto' ? srcLang : null)
  if (explicit && explicit !== 'auto') {
    const a = ins.applied
    if (!a) return { kind: 'checking' }
    if (!a.ok) return { kind: 'refused', message: a.error, canChange: a.code === 'override-unsupported' }
    // A Source Language carried over from an earlier file picks this file's code page. When a certain
    // detection reads the bytes with a different one, the model would be sent different letters.
    if (
      filePick === null &&
      d.ok &&
      d.inspection.encodingCertain &&
      detected &&
      a.inspection.receipt.encoding !== d.inspection.receipt.encoding
    ) {
      return { kind: 'confirm', reason: 'mismatch', guess: detected, chosen: explicit, preview: d.inspection.preview, allowAuto: false }
    }
    // The chosen language allows more than one code page and they give different letters: the user
    // picks the reading, never the order the code pages are listed in.
    if (!a.inspection.encodingCertain) {
      return {
        kind: 'confirm',
        reason: 'reading',
        guess: explicit,
        chosen: explicit,
        preview: '',
        allowAuto: false,
        readings: a.inspection.candidates
      }
    }
    const legacy = a.inspection.encodingSource === 'override' || a.inspection.encodingSource === 'detected'
    return {
      kind: 'ready',
      language: explicit,
      receipt: a.inspection.receipt,
      how: filePick !== null ? 'picked' : 'chosen',
      detected,
      preview: legacy ? a.inspection.preview : ''
    }
  }
  if (!d.ok) {
    return d.code === 'undetectable'
      ? { kind: 'confirm', reason: 'undetectable', guess: '', chosen: '', preview: '', allowAuto: false }
      : { kind: 'refused', message: d.error, canChange: false }
  }
  const i = d.inspection
  const preview = i.encodingSource === 'detected' ? i.preview : ''
  if (explicit === 'auto' && i.encodingCertain) {
    return { kind: 'ready', language: 'auto', receipt: i.receipt, how: 'auto', detected, preview }
  }
  if (explicit === null && i.encodingCertain && i.languageCertain && i.language) {
    return { kind: 'ready', language: i.language, receipt: i.receipt, how: 'detected', detected, preview }
  }
  return {
    kind: 'confirm',
    reason: i.encodingCertain ? 'language' : 'encoding',
    guess: i.language,
    chosen: '',
    preview: i.preview,
    allowAuto: i.encodingCertain
  }
}

/** Why Start must wait for this subtitle, or '' when it need not. */
export function sourceBlockReason(check: SourceCheck): string {
  switch (check.kind) {
    case 'checking':
      return 'Still reading the subtitle file — try again in a moment.'
    case 'refused':
      return check.message
    case 'confirm':
      return check.reason === 'reading'
        ? 'Choose how the subtitle’s letters are read first — see the note under Languages.'
        : 'Confirm the subtitle’s language first — see the note under Languages.'
    default:
      return ''
  }
}

/** What Start sends about the source, or null while it may not start. */
export function startSource(check: SourceCheck): Pick<TranslateArgs, 'sourceLang' | 'sourceReceipt'> | null {
  return check.kind === 'ready' ? { sourceLang: check.language, sourceReceipt: check.receipt } : null
}

export function sourceConfirmText(check: Extract<SourceCheck, { kind: 'confirm' }>): string {
  switch (check.reason) {
    case 'reading':
      return (
        `This file is not UTF-8, and ${langLabel(check.chosen)} is written in more than one code page. ` +
        'Read each way, some letters come out differently. Choose the reading where the line looks right.'
      )
    case 'mismatch':
      return (
        `The Source Language is set to ${langLabel(check.chosen)}, but this file reads as ${langLabel(check.guess)}. ` +
        `This file is not UTF-8, so the language decides how its letters are read — as ${langLabel(check.chosen)} they would come out wrong.`
      )
    case 'undetectable':
      return (
        'This file is not UTF-8, and the app cannot tell which language it is in. Choose its language so its ' +
        'letters are read correctly, or re-save the file as UTF-8.'
      )
    case 'encoding':
      return (
        'This file is not UTF-8, and its letters could be read more than one way. ' +
        (check.guess ? `The best reading is ${langLabel(check.guess)}. ` : '') +
        'Confirm its language, or choose the right one — the language decides how the letters are read.'
      )
    default:
      return (
        'The app cannot be sure which language this subtitle is in. ' +
        (check.guess ? `It looks like ${langLabel(check.guess)}. ` : '') +
        'Confirm it, choose the right one, or let the model work it out as Auto Detect always has.'
      )
  }
}

const PICK_LANGUAGES = [{ value: '', label: '— choose —' }, ...TARGET_LANGUAGES]

export function SourceLanguageNote({
  check,
  picked,
  revertLabel,
  onPick,
  onRevert
}: {
  check: SourceCheck
  /** A per-file choice is in force, so reverting it means something. */
  picked: boolean
  revertLabel: string
  onPick: (language: string, encoding?: SubtitleEncoding) => void
  onRevert: () => void
}): React.JSX.Element | null {
  const [changing, setChanging] = useState(false)
  if (check.kind === 'none') return null
  if (check.kind === 'checking') {
    return <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Reading the subtitle file…</p>
  }
  const pick = (language: string, encoding?: SubtitleEncoding): void => {
    setChanging(false)
    if (language) onPick(language, encoding)
  }
  const picker = (
    <Select value="" onChange={(language) => pick(language)} options={PICK_LANGUAGES} className="mt-2 w-full sm:w-64" />
  )
  const link = 'text-sm text-brand underline hover:no-underline'
  const changeLinks = (label: string): React.JSX.Element => (
    <>
      <button className={link} onClick={() => setChanging((v) => !v)}>
        {changing ? 'cancel' : label}
      </button>
      {picked && (
        <button className={link} onClick={onRevert}>
          {revertLabel}
        </button>
      )}
    </>
  )
  if (check.kind === 'refused') {
    return (
      <div className="mt-3 rounded-md border border-red-300 bg-red-50 px-3.5 py-3 dark:border-red-800/60 dark:bg-red-900/20">
        <p className="text-sm text-red-700 dark:text-red-300">{check.message}</p>
        {check.canChange && (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">{changeLinks('choose another language')}</div>
            {changing && picker}
          </>
        )}
      </div>
    )
  }
  if (check.kind === 'confirm' && check.reason === 'reading') {
    return (
      <div className="mt-3 rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">⚠ Check how the subtitle’s letters are read before starting.</p>
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">{sourceConfirmText(check)}</p>
        <div className="mt-2 flex flex-col items-start gap-2">
          {(check.readings ?? []).map((r) => (
            <Button key={r.encoding} variant="secondary" onClick={() => pick(check.chosen, r.encoding)}>
              <span dir="auto">“{r.preview}”</span> ({r.encoding})
            </Button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">{changeLinks('choose another language')}</div>
        {changing && picker}
      </div>
    )
  }
  if (check.kind === 'confirm') {
    return (
      <div className="mt-3 rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">⚠ Check the subtitle’s language before starting.</p>
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">{sourceConfirmText(check)}</p>
        {check.preview && (
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300" dir="auto">
            First line, read that way: “{check.preview}”
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {check.reason === 'mismatch' ? (
            <>
              <Button variant="secondary" onClick={() => pick(check.guess)}>
                Use {langLabel(check.guess)}
              </Button>
              <Button variant="ghost" onClick={() => pick(check.chosen)}>
                Keep {langLabel(check.chosen)}
              </Button>
            </>
          ) : (
            check.guess && (
              <Button variant="secondary" onClick={() => pick(check.guess)}>
                Yes, it’s {langLabel(check.guess)}
              </Button>
            )
          )}
          {check.allowAuto && (
            <Button variant="ghost" onClick={() => pick('auto')}>
              Let the model work it out
            </Button>
          )}
          <button className={link} onClick={() => setChanging((v) => !v)}>
            {changing ? 'cancel' : 'choose another language'}
          </button>
        </div>
        {changing && picker}
      </div>
    )
  }
  const what =
    check.how === 'auto'
      ? 'Auto Detect — the model works out the language'
      : `${langLabel(check.language)} (${check.how === 'detected' ? 'detected' : check.how === 'picked' ? 'your choice' : 'Source Language'})`
  return (
    <div className="mt-3 text-sm text-gray-700 dark:text-gray-300">
      <p>
        This subtitle: <span className="font-medium">{what}</span>
        {check.detected && check.how !== 'detected' && check.detected !== check.language && (
          <span className="text-gray-500 dark:text-gray-400"> — it reads as {langLabel(check.detected)}</span>
        )}{' '}
        <button className={link} onClick={() => setChanging((v) => !v)}>
          {changing ? 'cancel' : 'change'}
        </button>
        {check.how === 'picked' || check.how === 'auto' ? (
          <>
            {' · '}
            <button className={link} onClick={onRevert}>
              {revertLabel}
            </button>
          </>
        ) : null}
      </p>
      {check.preview && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400" dir="auto">
          Not UTF-8; read as {check.receipt.encoding}: “{check.preview}”
        </p>
      )}
      {changing && picker}
    </div>
  )
}

export default function TranslatePage(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patch)
  const { state, start, stop, reset, runId } = useRunner()

  const [srtFile, setSrtFile] = useState('')
  const [videoFile, setVideoFile] = useState('')
  const [audioFile, setAudioFile] = useState('')
  const [tracks, setTracks] = useState<SubtitleTrack[]>([])
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null)
  const [probing, setProbing] = useState(false)
  const [srcLang, setSrcLang] = useState('auto')
  const [tgtLang, setTgtLang] = useState('')
  // Two fields, one `description`: joined only when a run is assembled (D7-3…D7-5).
  const [tmdbContext, setTmdbContext] = useState('')
  const [customContext, setCustomContext] = useState('')
  const [tmdbResetKey, setTmdbResetKey] = useState(0)
  /** Bundle H: the gender reference being edited, and the TMDB title it searches by. Frozen at Start. */
  const [reference, setReference] = useState<GenderReferenceDraft>(EMPTY_REFERENCE_DRAFT)
  const [referenceTitle, setReferenceTitle] = useState<ReferenceTitle | null>(null)
  /** The source/title/episode and reference selection the last Start froze; the walked file belongs to them. */
  const handoffMark = useRef<ReferenceHandoffMark | null>(null)
  // The Advanced Hebrew card's run snapshot: set at Start, kept through the run and its ending, dropped by New.
  const [hebrewRun, setHebrewRun] = useState<{ flags: AdvancedHebrewFlags; targetLang: string } | null>(null)
  const [startHeld, setStartHeld] = useState(false)
  const [savedPath, setSavedPath] = useState('')
  /** Where the save put the console log — its name is stepped if one was already there (SOL-12). */
  const [savedConsolePath, setSavedConsolePath] = useState('')
  /** Reports that could not take their usual name, so the panel can say which (SOL-15). */
  const [renamedSidecars, setRenamedSidecars] = useState<string[]>([])
  /** Canonical names still sitting beside the saved subtitle that this run did not write (SOL-15). */
  const [staleSidecars, setStaleSidecars] = useState<string[]>([])
  /** Why Save failed, or why a sidecar did not land beside a successful subtitle (SOL-22). */
  const [saveError, setSaveError] = useState('')
  /**
   * What the user chose to translate, frozen when the run started.
   *
   * The pickers stay live after a run finishes — Save and the file inputs are on screen together —
   * so reading them at save time would let a token report name a file that was never translated.
   * That is worse than the dead temp path REP-1 set out to fix: a stale path is obviously stale,
   * while a confident wrong one is not.
   */
  const [runSource, setRunSource] = useState('')
  const [startError, setStartError] = useState('')
  const [showLog, setShowLog] = useState(false)
  /**
   * The ffmpeg work this page is waiting on, or null when there is none.
   *
   * It is held here rather than in the panel because the panel is keyed by `videoFile` and so
   * does not survive a video change — while the ffmpeg process it started does, and nothing in
   * the main process serialises `video:extractTrack`. Kept in the child, the lock was released
   * by the remount and a second extraction could start beside the first (validator finding
   * FP5-01). The panel takes and releases it; the promise that releases it outlives the panel.
   *
   * It is now a task rather than a boolean because the same lock answers a second question —
   * how far along that work is. The two belong together: exactly one ffmpeg task runs from
   * this page at a time, so "is one running" and "which one, and how far" are one state.
   */
  const [ffmpeg, setFfmpeg] = useState<FfmpegTask | null>(null)
  /** When the current run started, for the clock shown while nothing measurable has happened. */
  const [runStartedAt, setRunStartedAt] = useState(0)
  /** When the track scan started, for the same reason: a 50 GB container takes a while. */
  const [probeStartedAt, setProbeStartedAt] = useState(0)
  /**
   * The user's answer about one subtitle's language — a language, or 'auto' to let the model work it
   * out — and, when that language reads the bytes more than one way, the reading chosen. Bound to that
   * file's path, so it can never carry over to the next file.
   */
  const [sourcePick, setSourcePick] = useState<{ path: string; language: string; encoding?: SubtitleEncoding } | null>(null)
  /** A track already extracted by a Start that stopped to ask about its language; reused by the next Start. */
  const [extracted, setExtracted] = useState<{ key: string; path: string; trackLanguage?: string } | null>(null)
  const [inspected, setInspected] = useState<SourceInspected | null>(null)
  /** Bumped by every Browse, so choosing the same file again reads it again. */
  const [sourceLoads, setSourceLoads] = useState(0)
  /** Same fence as `probeEpoch`: a slower, older inspection must not land on a newer file. */
  const inspectEpoch = useRef(0)
  /** Phase 3: the native offer waiting for Continue or Start over. */
  const [resumeChoice, setResumeChoice] = useState<PendingResume | null>(null)
  /** Phase 3: a failed section the user chose to retry, for the retry dialog (Step 3.5). */
  const [retryChoice, setRetryChoice] = useState<PendingResume | null>(null)
  /** When the whole-input resume inspection started; 0 when none is running. */
  const [resumeCheckSince, setResumeCheckSince] = useState(0)
  /** Bumped when the job the pickers name changes, and by New: a late inspection or a stale offer is dropped. */
  const resumeEpoch = useRef(0)

  /**
   * The console log's name once it has a home, or '' while the run has none.
   *
   * Taken from what the save actually WROTE rather than derived from the saved subtitle's name.
   * It used to be derived, on the reasoning that the sidecar lands on a destination re-derived from
   * the same base — true until sidecars became non-destructive, at which point an occupied name is
   * stepped to a free one and the derivation would name a file that does not exist (SOL-12).
   */
  const consoleLogName = savedConsolePath.split(/[\\/]/).pop() ?? ''

  /**
   * Where the console log is RIGHT NOW, for a run with no saved subtitle to sit beside.
   *
   * `logPaths` is only ever populated by the terminal event, so a non-empty value here already
   * means the run has ended — there is no separate status to check. It empties on `reset()`,
   * which is correct: New starts a run that has no log yet.
   */
  const consoleLogPath = findConsoleLog(state.logPaths)

  /**
   * Follow the ffmpeg progress channel for as long as this page exists.
   *
   * A report for a kind this page is not waiting on is ignored rather than shown: a
   * transcription's audio conversion runs on the other page under the job lock, and can
   * genuinely overlap a track export started here.
   */
  useEffect(
    () =>
      window.api.onFfmpegProgress((p) => {
        setFfmpeg((cur) => {
          // `done` is deliberately not acted on: the awaits below own the end of these two
          // tasks, and clearing here as well would race a task that starts immediately after.
          if (!cur || cur.kind !== p.kind || p.done) return cur
          return { ...cur, pct: p.pct }
        })
      }),
    []
  )

  // The language pickers start from the saved defaults and follow a later Settings change only while they
  // still show the previous default (`followedLanguage`). While a run holds the page — preparing, offering,
  // running or showing its ending — nothing moves; the change is taken when the hold ends.
  const langDefaults = useRef<{ src: string; tgt: string } | null>(null)
  const langHeld = state.status !== 'idle' || startHeld || resumeChoice !== null || retryChoice !== null
  /**
   * Which probe (or Clear) currently owns the track list.
   *
   * `probeTracks` is async and a later pick can finish first. Applying whichever promise
   * resolves last would show A's streams against B's path — then Start extracts the wrong
   * index (SOL-37). Bumping this on every pick and on Clear makes a stale completion a no-op.
   */
  const probeEpoch = useRef(0)
  /** Sync lock for Start: React's `isRunning` / `ffmpeg` flags lag a second click (SOL-39). */
  const startOwned = useRef(false)
  useEffect(() => {
    if (!settings) return
    const was = langDefaults.current
    if (was && langHeld) return
    langDefaults.current = { src: settings.sourceLang, tgt: settings.targetLang }
    setSrcLang((cur) => (was ? followedLanguage(cur, was.src, settings.sourceLang) : settings.sourceLang))
    setTgtLang((cur) => (was ? followedLanguage(cur, was.tgt, settings.targetLang) : settings.targetLang))
  }, [settings, langHeld])

  const trackKey = videoFile && selectedTrack !== null ? `${videoFile}\n${selectedTrack}` : ''
  const subject: { path: string; trackLanguage?: string } | null = srtFile
    ? { path: srtFile }
    : extracted && extracted.key === trackKey
      ? { path: extracted.path, trackLanguage: extracted.trackLanguage }
      : null
  // §3.3: once a run has ended, the file its automatic walk accepted fills the field the manual picker fills —
  // only while the draft still belongs to that run's source, title and episode, read when the reply arrives.
  const sourceIdentity = runSourceIdentity(srtFile, videoFile, selectedTrack)
  const referenceSource = useRef<{ path: string; title: ReferenceTitle | null }>({ path: '', title: null })
  referenceSource.current = { path: sourceIdentity, title: referenceTitle }
  const endedRun = state.status !== 'idle' && state.status !== 'running' ? runId() : null
  useEffect(() => {
    if (!endedRun) return
    const mark = handoffMark.current
    let live = true
    window.api
      .referenceAccepted(endedRun)
      .then((file) => {
        if (!live || !file) return
        setReference((d) => referenceFromRun(d, referenceIdentity(referenceSource.current.path, referenceSource.current.title, d.season, d.episode), mark, file))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [endedRun])
  const filePick = subject && sourcePick?.path === subject.path ? sourcePick.language : null
  const pickEncoding = filePick !== null ? sourcePick?.encoding : undefined
  const userLang = sourceUserLanguage(filePick, srcLang)
  useEffect(() => {
    const epoch = ++inspectEpoch.current
    if (!subject) return
    void inspectSource(window.api.inspectSubtitle, subject.path, subject.trackLanguage, userLang, pickEncoding).then((r) => {
      if (epoch === inspectEpoch.current) setInspected(r)
    })
  }, [subject?.path, subject?.trackLanguage, userLang, pickEncoding, sourceLoads])
  const check: SourceCheck = !subject
    ? { kind: 'none' }
    : inspected && inspected.path === subject.path && inspected.userLang === userLang && inspected.encoding === (userLang !== 'auto' ? pickEncoding : undefined)
      ? sourceCheck(inspected, filePick, srcLang)
      : { kind: 'checking' }
  const hardRefused = check.kind === 'refused' && !check.canChange
  useEffect(() => {
    resumeEpoch.current += 1
    setResumeChoice(null)
    setRetryChoice(null)
  }, [srtFile, videoFile, selectedTrack, tgtLang, audioFile])

  /** One accepted video, from Browse or a drop. */
  function selectVideo(p: string): Promise<void> {
    return selectVideoSource(p, probeEpoch, (path) => window.api.probeTracks(path), {
      begin: (path) => {
        setVideoFile(path)
        setProbing(true)
        setProbeStartedAt(Date.now())
        setTracks([])
        setSelectedTrack(null)
      },
      apply: (t) => {
        setTracks(t)
        setSelectedTrack(defaultTrackIndex(t))
      },
      settle: () => setProbing(false)
    })
  }

  function clearVideo(): void {
    probeEpoch.current += 1
    setVideoFile('')
    setTracks([])
    setSelectedTrack(null)
    setProbing(false)
    setExtracted(null)
  }

  /**
   * Take or release the lock on the track panel's behalf.
   *
   * The release only clears an export, never whatever else might hold the lock. The two
   * tasks cannot overlap today — each refuses to start while the other holds it — but a lock
   * that any caller can clear is one edit away from being no lock at all.
   */
  function setExportBusy(running: boolean): void {
    setFfmpeg((cur) => {
      if (running) return { kind: 'export', pct: null, startedAt: Date.now() }
      return cur?.kind === 'export' ? null : cur
    })
  }

  if (!settings) return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading…</div>

  const isRunning = state.status === 'running'
  const runHeldForCard = state.status !== 'idle' || startHeld || resumeChoice !== null || retryChoice !== null
  const fillerWarnings = state.warnings.filter((w) => w.code === 'filler').map((w) => w.message)
  const timingWarnings = state.warnings.filter((w) => w.code === 'timing').map((w) => w.message)
  const fragmentLogNote = state.warnings.find((w) => w.code === 'fragment')?.message ?? null
  const abortExplain = failureSentence(state, 'translate')

  /**
   * Why this run cannot start, or an empty string when it can.
   *
   * Every one of these used to be a silently disabled button (REP-10). A control that refuses
   * without saying what would enable it is indistinguishable from a broken one — the tester
   * reported Start as "not responding" — and the sentence explaining the commonest case was
   * already written inside `handleStart`, where the disabled gate guaranteed nobody would ever
   * see it.
   */
  function whyCannotStart(): string {
    if (!tgtLang) return 'Choose a target language first.'
    // One ffmpeg call at a time from this page. Two at once on a large container is exactly
    // the machine-load complaint REP-11 arrived with, and the second would appear to hang.
    if (ffmpeg) {
      return ffmpeg.kind === 'export'
        ? 'A track is still being extracted — wait for it to finish.'
        : 'Already preparing the selected track.'
    }
    if (srtFile) return sourceBlockReason(check)
    if (!videoFile) {
      return 'Provide a subtitle file (.srt), or a video with a selectable text track.'
    }
    // A refused extracted track is extracted again by Start, so only a question holds Start here — or a
    // refusal of the user's own language choice, which extracting again cannot answer.
    if (selectedTrack !== null) return subject && !hardRefused ? sourceBlockReason(check) : ''
    // A video whose tracks are still being read has no tracks yet, and saying it contains none
    // would be a wrong answer rather than a slow one.
    if (probing) return 'Still scanning this video’s subtitle tracks — try again in a moment.'
    if (tracks.length === 0) {
      return 'No subtitle tracks were found in this video. Provide a subtitle file instead.'
    }
    // The reported case, which had no message anywhere: every track is a bitmap, so there is
    // no text to translate. Reading one would need OCR, which is a feature rather than a flag,
    // so the honest answer is to say so and point at what IS possible.
    if (tracks.every((t) => t.isImage)) {
      return (
        'This video’s subtitles are image-based (PGS) and cannot be translated — ' +
        'extract one as a .sup instead, or provide a subtitle file.'
      )
    }
    return 'Choose which subtitle track to translate.'
  }

  async function handleStart(): Promise<void> {
    if (startOwned.current) return
    setStartError('')
    setSavedPath('')
    setSavedConsolePath('')
    setRenamedSidecars([])
    setStaleSidecars([])
    setSaveError('')
    setShowLog(false)
    const cfg = settings
    if (!cfg) return

    const refusal = whyCannotStart()
    if (refusal) {
      setStartError(refusal)
      return
    }
    // Frozen here, before any await, with the rest of the run's choices.
    const referenceStart = genderReferenceArgs(reference, tgtLang, referenceTitle, cfg.subtitleSourceOpenSubtitles)
    if ('refusal' in referenceStart) {
      setStartError(referenceStart.refusal)
      return
    }
    handoffMark.current = referenceHandoffMark(reference, referenceIdentity(sourceIdentity, referenceTitle, reference.season, reference.episode))
    // W-de-4 b1: the Hard-German confirmation is this run's; the next Start begins without it.
    setReference(referenceAfterStart)
    startOwned.current = true
    setResumeChoice(null)
    setRetryChoice(null)
    setHebrewRun({ flags: settingsHebrewFlags(cfg), targetLang: tgtLang })
    setStartHeld(true)
    const resumeAt = resumeEpoch.current

    try {
    // Read before the first await, not after: extracting a track from a large video runs for
    // minutes, and nothing stops the user editing the pickers while it does.
    const chosenSource = srtFile || videoFile
    const trackIndex = !srtFile && videoFile ? selectedTrack : null

    let inputFile = srtFile
    let source = check
    // If translating from a video's embedded track, extract it first. This used to be silent
    // — the button still read "Start Translation" while ffmpeg walked a 50 GB container for
    // minutes (REP-11). The task state below is what puts a bar and a clock on screen, and
    // what stops a second ffmpeg call being started on top of this one.
    if (!inputFile && videoFile && selectedTrack !== null) {
      const key = trackKey
      const trackLanguage = tracks.find((t) => t.index === selectedTrack)?.lang || undefined
      // A Start that stopped to ask about this track's language already extracted it; re-walking a
      // 50 GB container to answer one question would repeat REP-11.
      let trackPath = subject && !hardRefused ? subject.path : ''
      if (!trackPath) {
        setFfmpeg({ kind: 'prepare', pct: null, startedAt: Date.now() })
        let res: { ok: boolean; path?: string }
        try {
          res = await window.api.extractToTemp({ filePath: videoFile, subtitleIndex: selectedTrack })
        } catch (e) {
          // A rejected invoke used to leave the press with no visible effect at all — the same
          // shape of dead end REP-10 records, arrived at from the other direction.
          setStartError(`Could not extract the selected subtitle track: ${String(e)}`)
          return
        } finally {
          // In a finally because a failure must not leave the page permanently unable to start
          // anything: this lock is what every other action on the page checks.
          setFfmpeg(null)
        }
        if (!res.ok || !res.path) {
          setStartError('Could not extract the selected subtitle track. Is FFmpeg installed?')
          return
        }
        trackPath = res.path
        setExtracted({ key, path: trackPath, trackLanguage })
      }
      if (!(subject?.path === trackPath && check.kind === 'ready')) {
        const pickHere = sourcePick?.path === trackPath ? sourcePick.language : null
        const encodingHere = pickHere !== null ? sourcePick?.encoding : undefined
        const ins = await inspectSource(window.api.inspectSubtitle, trackPath, trackLanguage, sourceUserLanguage(pickHere, srcLang), encodingHere)
        setInspected(ins)
        source = sourceCheck(ins, pickHere, srcLang)
      }
      inputFile = trackPath
    }
    if (!inputFile) {
      // Unreachable while `whyCannotStart` covers every path above. Kept so that a later edit
      // to those rules cannot end with the engine spawned against no input at all.
      setStartError('Provide a subtitle file (.srt), or a video with a selectable text track.')
      return
    }
    const intake = startSource(source)
    if (!intake) {
      setStartError(sourceBlockReason(source))
      return
    }

    const description = combineDescriptionSections(tmdbContext, customContext)
    const args: TranslateArgs = {
      inputFile,
      videoFile: videoFile || undefined,
      audioFile: audioFile || undefined,
      // The selected track's stream, so main names the job by its container rather than the temp copy.
      ...(trackIndex !== null ? { streamIndex: trackIndex } : {}),
      sourceLang: intake.sourceLang,
      sourceReceipt: intake.sourceReceipt,
      targetLang: tgtLang,
      ...runSettingsArgs(cfg, description),
      ...(referenceStart.args ? { genderReference: referenceStart.args } : {})
    }

    // Phase 3: main reads the whole selected input to look for this job's unfinished work. Outside the
    // run slot, so it can take as long as the film is big; a change of picker meanwhile drops the answer.
    setResumeCheckSince(Date.now())
    let found: ResumeInspectResult
    try {
      found = await window.api.inspectResume(resumeInspectRequest(args))
    } catch (e) {
      setStartError(`Could not check for unfinished work: ${e instanceof Error ? e.message : String(e)}`)
      return
    } finally {
      setResumeCheckSince(0)
    }
    if (resumeAt !== resumeEpoch.current) return
    const next = startDecisionFor(found)
    if ('ask' in next) {
      setResumeChoice({ offer: next.ask, args, source: chosenSource })
      return
    }
    await launch(next.resume ? { ...args, resume: next.resume } : args, chosenSource)
    } finally {
      startOwned.current = false
      setStartHeld(false)
    }
  }

  async function launch(args: TranslateArgs, chosenSource: string): Promise<void> {
    // What was sent: a Continue or a retry reads Settings again when the user answers the offer.
    setHebrewRun({ flags: advancedHebrewFlags(args), targetLang: args.targetLang })
    setRunSource(chosenSource)
    setRunStartedAt(Date.now())
    // The next Start extracts afresh, as it always has; the copy was kept only to answer a question.
    setExtracted(null)
    await start((runId) => window.api.startTranslate({ ...args, runId }))
  }

  /**
   * The user's answer to an offer. Continue sends the record's id with the current credentials; main
   * runs the record's own settings. Start over sends the current settings. A pending failed section
   * opens its retry dialog instead, and nothing is sent until the user confirms there.
   */
  async function chooseResume(action: 'continue' | 'startOver'): Promise<void> {
    const choice = resumeChoice
    if (!choice || !settings || startOwned.current || isRunning) return
    if (action === 'continue') {
      const next = resumeContinueAction(choice.offer)
      if (next === null) return
      if (next === 'retryDialog') {
        setResumeChoice(null)
        setRetryChoice(choice)
        return
      }
    }
    startOwned.current = true
    try {
      setResumeChoice(null)
      const description = combineDescriptionSections(tmdbContext, customContext)
      const resume: ResumeDecision = { action, resumeId: choice.offer.resumeId }
      await launch({ ...choice.args, ...runSettingsArgs(settings, description), resume }, choice.source)
    } finally {
      startOwned.current = false
    }
  }

  /** The retry the user confirmed (AR3-7): the same Start, carrying the section's run-local choices. */
  async function retrySection(decision: FailedSpanRetryDecision): Promise<void> {
    const choice = retryChoice
    if (!choice || !settings || startOwned.current || isRunning) return
    startOwned.current = true
    try {
      setRetryChoice(null)
      const description = combineDescriptionSections(tmdbContext, customContext)
      await launch({ ...choice.args, ...runSettingsArgs(settings, description), resume: decision }, choice.source)
    } finally {
      startOwned.current = false
    }
  }

  /** Cancel goes back to the same offer; nothing was sent. */
  function cancelRetry(): void {
    const choice = retryChoice
    setRetryChoice(null)
    if (choice) setResumeChoice(choice)
  }

  function handleNew(): void {
    reset()
    // Page state only: the saved work stays, and the same job's next Start offers it again.
    resumeEpoch.current += 1
    setResumeChoice(null)
    setRetryChoice(null)
    setSavedPath('')
    setSavedConsolePath('')
    setRenamedSidecars([])
    setStaleSidecars([])
    setSaveError('')
    // Through the helper, never `setVideoFile('')`: that would skip the SOL-37 epoch bump
    // and let an in-flight probe repopulate tracks for a video no longer in the field.
    clearVideo()
    setSrtFile('')
    setSourcePick(null)
    setInspected(null)
    setAudioFile('')
    setTmdbContext('')
    setCustomContext('')
    setTmdbResetKey((k) => k + 1)
    setReferenceTitle(null)
    // The mode, strength and download limit carry over; the file, the episode and the per-run answers do not.
    setReference((d) => ({ ...EMPTY_REFERENCE_DRAFT, mode: d.mode, strength: d.strength, perRunLimit: d.perRunLimit }))
    setHebrewRun(null)
    setRunSource('')
    setStartError('')
    setShowLog(false)
    setRunStartedAt(0)
    setProbeStartedAt(0)
  }

  async function handleSave(): Promise<void> {
    if (!state.outputPath) return
    setSaveError('')
    // Keep the format the engine actually produced. It writes according to the output
    // path's extension, so proposing ".srt" for an ASS job would mislabel the file.
    const ext = /\.ass$/i.test(state.outputPath) ? '.ass' : '.srt'
    // Same snapshot, same reason: the proposed filename must describe the run being saved, not
    // whatever happens to be in the pickers now. The convention itself now lives in one place,
    // shared with track extraction — see `outputName.ts`.
    const name = companionName(runSource, tgtLang, ext)
    let saved
    try {
      saved = await window.api.saveFile({
        srcPath: state.outputPath,
        defaultName: name,
        defaultDir: settings?.outputFolder || undefined,
        logPaths: state.logPaths.length ? state.logPaths : undefined,
        // What the user picked for THIS run, not what the engine was handed and not whatever the
        // pickers hold now: for a video the engine received an extracted temp track, and for a
        // re-encoded subtitle a temp `.utf8.srt`. Neither exists by the time they open the token
        // report sitting next to the file they saved.
        inputPath: runSource || undefined
      })
    } catch (e) {
      setSaveError(`Could not save: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (saved.error && !saved.path) {
      setSaveError(saved.error)
      return
    }
    if (saved.path) {
      setSavedPath(saved.path)
      // Reported, not derived. The sidecar is written exclusively, so a name already in use is
      // stepped and `consoleLogPathFor(savedPath)` would name a file that is not there (SOL-12).
      setSavedConsolePath(saved.consolePath)
      // A stepped name is worth SAYING. The reports are named after the subtitle, so one that had to
      // take a different name no longer looks like it belongs to this run — and the file that does
      // look like it belongs is the older one still sitting there. Naming them is what keeps the
      // association honest (SOL-15).
      setRenamedSidecars(renamedAmong(saved.sidecars, saved.path))
      setStaleSidecars(saved.stale ?? [])
      if (saved.error) setSaveError(saved.error)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Box>
        <BoxTitle>Input Files</BoxTitle>
        <div className="space-y-4">
          <div>
            <Label tip="The subtitle file you want to translate — a SubRip .srt. This is the only required input for basic translation: no video or audio needed. An .ass/.ssa file is refused when you choose it: this version translates .srt only, and styled subtitles are not converted. If you have a video file instead, use the Video File field below to extract subtitles from it. A .srt that is not UTF-8 is read in its own language's code page: the app works out which, shows what it found under Languages, and asks you to confirm when it cannot be sure. Your file is never changed.">
              Subtitle File (.srt)
            </Label>
            <InputFilePicker
              value={srtFile}
              placeholder="Required (unless Video File is provided)"
              filters={SUBTITLE_FILTERS}
              onSelect={(p) => {
                setSrtFile(p)
                setSourcePick(null)
                setSourceLoads((n) => n + 1)
                // Loading a new SRT invalidates the prior TMDB context, and the custom context with it.
                setTmdbContext('')
                setCustomContext('')
                setTmdbResetKey((k) => k + 1)
                // …and the gender reference, which was a subtitle of the previous title.
                setReferenceTitle(null)
                setReference((d) => ({ ...withReferenceFile(d, null), season: null, episode: null }))
              }}
              onClear={() => setSrtFile('')}
            />
          </div>

          <div>
            <Label tip="Optional. Provide a video file to scan its embedded subtitle tracks — pick which track to translate without extracting it first. Requires FFmpeg (configure path in Settings → Advanced if not on PATH).">
              Video File
            </Label>
            <InputFilePicker
              value={videoFile}
              placeholder="Optional — extract embedded subtitles (FFmpeg)"
              filters={VIDEO_FILTERS}
              onSelect={selectVideo}
              onClear={clearVideo}
            />
            {/*
              The clock is the point. ffprobe on a 50 GB file over a network share can take
              a while, and a static line gives no way to tell "working" from "wedged".
            */}
            {probing && (
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                Scanning subtitle tracks… <Elapsed since={probeStartedAt} />
              </p>
            )}
            <div className="mt-2">
              {/*
                REP-9: the key is what clears the panel's extraction result when a different
                video is loaded. Without it React keeps the same instance, and the previous
                film's "Saved → …" survives — pointing at a real file, so the panel actively
                asserts that THIS video's subtitles were extracted. Resetting by `key` cannot
                miss a field the way a hand-written reset of three named values can.
              */}
              <SubTrackPanel
                key={videoFile}
                videoFile={videoFile}
                tracks={tracks}
                targetLang={tgtLang}
                selectedIndex={selectedTrack}
                onSelect={setSelectedTrack}
                busy={ffmpeg !== null}
                busyPct={ffmpeg?.kind === 'export' ? ffmpeg.pct : null}
                onBusy={setExportBusy}
              />
            </div>
          </div>

          <div>
            <Label tip="Optional. An audio track (or video) whose audio Gemini analyses to determine speaker genders — improves gendered pronouns in languages like Hebrew, Spanish, French. Requires FFmpeg.">
              Audio File
            </Label>
            <InputFilePicker
              value={audioFile}
              placeholder="Optional — gender-aware context (FFmpeg)"
              filters={AUDIO_FILTERS}
              onSelect={(p) => setAudioFile(p)}
              onClear={() => setAudioFile('')}
            />
          </div>
        </div>
      </Box>

      <Box>
        <BoxTitle>Languages</BoxTitle>
        <div className="flex gap-6">
          <div className="flex-1">
            <Label tip="The language the original subtitles are written in. 'Auto Detect' is recommended: the app reads the subtitle, shows the language it found below, and lets you change it for that file. When it cannot be sure, it asks before starting. Set a specific language here only if you want it used for every file.">
              Source Language
            </Label>
            <Select
              value={srcLang}
              onChange={(v) => {
                setSrcLang(v)
                setSourcePick(null)
              }}
              options={SOURCE_LANGUAGES}
              className="w-full"
            />
          </div>
          <div className="flex-1">
            <Label tip="The language to translate into. Required. If a video track already matches this language, you'll be warned and offered to extract it instead of re-translating.">
              Target Language
            </Label>
            <Select
              value={tgtLang}
              onChange={setTgtLang}
              options={[{ value: '', label: '— choose —' }, ...TARGET_LANGUAGES]}
              className="w-full"
            />
          </div>
        </div>
        <SourceLanguageNote
          key={subject?.path ?? ''}
          check={check}
          picked={filePick !== null}
          revertLabel={srcLang === 'auto' ? 'revert to detected' : `revert to ${langLabel(srcLang)}`}
          onPick={(language, encoding) => {
            if (subject) setSourcePick({ path: subject.path, language, ...(encoding ? { encoding } : {}) })
          }}
          onRevert={() => setSourcePick(null)}
        />
      </Box>

      <Box>
        <TmdbSearch
          key={tmdbResetKey}
          tmdbContext={tmdbContext}
          onTmdbContextChange={setTmdbContext}
          customContext={customContext}
          onCustomContextChange={setCustomContext}
          onTitleChange={(t) => {
            setReferenceTitle(t)
            if (t?.mediaType === 'tv') {
              const se = seasonEpisodeFromName((srtFile || videoFile).split(/[\\/]/).pop() ?? '')
              if (se) setReference((d) => (d.season === null && d.episode === null ? { ...d, season: se.season, episode: se.episode } : d))
            }
          }}
        />
      </Box>

      {referenceUiShown(tgtLang) && (
        <Box>
          <GenderReferencePanel
            draft={reference}
            setDraft={setReference}
            title={referenceTitle}
            sourcePath={subject?.path ?? ''}
            sourceKey={sourceIdentity}
            settings={settings}
            disabled={isRunning}
          />
        </Box>
      )}

      <Box>
        <BoxTitle>Translate</BoxTitle>
        {startError && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{startError}</p>}
        <AdvancedHebrewCard {...hebrewCardFor(hebrewRun, runHeldForCard, settings, tgtLang)} />
        <div className="flex items-center gap-2">
          {!isRunning ? (
            // An open resume choice is the way forward; Start would only ask the same question again.
            resumeChoice || retryChoice ? null : (
            /*
              Disabled only while a job is running or its track is being extracted — and the
              first of those is belt-and-braces, since this branch is not rendered then.
              Everything else that would prevent a run is now reported by `handleStart` in
              words rather than by a button that does nothing. See `whyCannotStart`.

              The label changes during preparation because the reported complaint was
              precisely that it did not: a button still offering to start something is the
              strongest possible claim that nothing has started.

              `key` on Start vs Stop is load-bearing (SOL-39). Keyboard clicks have
              `detail === 0`, which the pointer filter cannot catch. Reusing the same
              DOM node would let a leftover Enter/Space activate Stop.
            */
            <Button
              key="run-start"
              onClick={(e) => {
                if (e.detail > 1) return
                void handleStart()
              }}
              disabled={isRunning || ffmpeg !== null || resumeCheckSince > 0}
            >
              {ffmpeg?.kind === 'prepare' ? 'Extracting track…' : 'Start Translation'}
            </Button>
            )
          ) : (
            <Button
              key="run-stop"
              variant="danger"
              onClick={(e) => {
                if (e.detail > 1) return
                void stop()
              }}
            >
              Stop
            </Button>
          )}
          {state.status === 'done' && (
            <>
              <Button variant="secondary" onClick={handleSave}>
                Save Subtitles…
              </Button>
              <Button variant="ghost" onClick={handleNew}>
                New
              </Button>
            </>
          )}
          {!tgtLang && <span className="text-xs text-gray-400 dark:text-gray-500">Choose a target language to begin.</span>}
        </div>

        {ffmpeg?.kind === 'prepare' && (
          <div className="mt-4">
            <Working
              label="Extracting the selected subtitle track"
              pct={ffmpeg.pct}
              since={ffmpeg.startedAt}
              note="FFmpeg reads the whole container to find the track, so this takes as long as the film is big. The translation starts on its own when it finishes."
            />
          </div>
        )}
        {resumeCheckSince > 0 && (
          <div className="mt-4">
            <Working label={RESUME_INSPECT_LABEL} pct={null} since={resumeCheckSince} note={RESUME_INSPECT_NOTE} />
          </div>
        )}
        {resumeChoice && !isRunning && (
          <ResumeChoice
            offer={resumeChoice.offer}
            busy={startOwned.current}
            onContinue={() => void chooseResume('continue')}
            onStartOver={() => void chooseResume('startOver')}
          />
        )}
        {retryChoice && !isRunning && retryChoice.offer.state === 'valid' && retryChoice.offer.nextAction === 'retryFailedSpan' && (
          <FailedBatchRetry
            offer={retryChoice.offer}
            models={settings?.cachedModels ?? []}
            busy={startOwned.current}
            onRetry={(decision) => void retrySection(decision)}
            onCancel={cancelRetry}
          />
        )}
        {/*
          An export can still be running when New clears the video. SubTrackPanel is keyed
          by `videoFile` and returns null once the field is empty, so the row that was
          showing "Extracting…" is gone. The lock itself is left alone (it is what stops a
          second ffmpeg call); this is the progress that lock used to display.
        */}
        {ffmpeg?.kind === 'export' && !videoFile && (
          <div className="mt-4">
            <Working
              label="Finishing a track extraction started before New"
              pct={ffmpeg.pct}
              since={ffmpeg.startedAt}
            />
          </div>
        )}

        {(isRunning || state.status === 'done' || state.status === 'error' || state.status === 'stopped') && (
          <div className="mt-4 space-y-3">
            {/*
              Nothing measurable has happened yet, so the bar says "alive" instead of "0%".
              The engine's own preparation — extracting the audio for gender context, sizing
              the first batch — reports nothing at all while it runs, and a 0% bar under a
              window that has been open for two minutes reads as a hang.
            */}
            <ProgressBar pct={state.progress} indeterminate={isRunning && state.progress === 0} />
            {isRunning && state.progress === 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Working for <Elapsed since={runStartedAt} /> — the engine reports no progress
                while it prepares, which on a large file takes a few minutes.
              </p>
            )}

            {fragmentLogNote && (
              <div className="rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25">
                <p className="text-sm text-amber-800 dark:text-amber-300">{fragmentLogNote}</p>
              </div>
            )}

            {/* Native waits, group switches, Paid fallback, daily stops and resizes: one notice, none otherwise. */}
            <FreeTierNotice
              running={isRunning}
              budget={state.budget}
              advice={state.advice}
              savedBatchSize={settings.batchSize}
              onUseBatchSize={(n) => void patch({ batchSize: n })}
            />

            {state.status === 'error' || state.status === 'stopped' ? (
              <>
                {/* What a failed or stopped run already spent stays visible after it ends. */}
                {settings.showTokenStats && state.tokens && (
                  <TokenUsageCard tokens={state.tokens} model={settings.model} cost={{ estimate: state.costEstimate }} usage={state.usage} />
                )}
                <LogPanel rows={state.log} />
              </>
            ) : (
              <StatusCard
                running={isRunning}
                statusText={state.statusText}
                currentLine={state.currentLine}
                totalLines={state.totalLines}
                batchSize={settings.batchSize}
                tokens={state.tokens}
                showTokens={settings.showTokenStats}
                model={settings.model}
                cost={{ estimate: state.costEstimate }}
                usage={state.usage}
                batchProgress={state.currentUnit > 0 && state.totalUnits ? { current: state.currentUnit, total: state.totalUnits } : null}
              />
            )}

            {state.status === 'done' && (
              <p className="text-sm font-medium text-green-700 dark:text-green-400">✅ Translation complete.</p>
            )}

            {/*
              REP-16. The engine validates a batch by counting items, not by reading them, so a run
              that filled 136 cues with two characters still reported success. This says so before
              the user picks a destination — it never blocks the save, and the file is untouched.
            */}
            {state.status === 'done' && fillerWarnings.length > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  ⚠ Part of this translation does not look right.
                </p>
                {fillerWarnings.map((w, i) => (
                  <p key={i} className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                    {w}
                  </p>
                ))}
              </div>
            )}
            {state.status === 'done' && timingWarnings.length > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  ⚠ Text may be correct but on the wrong timings.
                </p>
                {timingWarnings.map((w, i) => (
                  <p key={i} className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                    {w}
                  </p>
                ))}
              </div>
            )}
            {/*
              Bundle G: a line the model would not translate keeps its source text. Said here, before a
              destination is picked, so a save never completes without the user knowing how many.
            */}
            {state.status === 'done' && state.preserved.length > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  ⚠ {state.preserved.length} of {state.totalLines || state.preserved.length} line{state.preserved.length === 1 ? ' is' : 's are'} kept in the source language.
                </p>
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                  The saved subtitle has them untranslated, at their own times: {keptLinesText(state.preserved)}.
                </p>
              </div>
            )}
            {state.status === 'error' && (
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">
                    {abortExplain ??
                      `Process ended with an error (exit code ${state.exitCode}). Check the log above.`}
                  </p>
                  {state.resumable ? (
                    <p className="mt-1 text-sm text-red-600/80 dark:text-red-400/80">{RESUMABLE_TRANSLATE_NOTE}</p>
                  ) : (
                    abortExplain && (
                      <p className="mt-1 text-sm text-red-600/80 dark:text-red-400/80">
                        The run did not finish, so nothing was saved.
                      </p>
                    )
                  )}
                </div>
                <Button variant="ghost" onClick={handleNew}>
                  New
                </Button>
              </div>
            )}
            {/*
              A run the user ended is not a failure, and saying so in red told them the app had
              broken when it had done exactly what they asked.
            */}
            {state.status === 'stopped' && (
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {state.resumable ? `Stopped. ${RESUMABLE_TRANSLATE_NOTE}` : 'Stopped. Nothing was saved.'}
                </p>
                <Button variant="ghost" onClick={handleNew}>
                  New
                </Button>
              </div>
            )}

            {/* Raw log is hidden by default on success; power users can expand it. */}
            {state.status !== 'error' && state.status !== 'stopped' && state.log.length > 0 && (
              <div>
                <button
                  onClick={() => setShowLog((v) => !v)}
                  className="text-xs text-gray-500 hover:text-brand dark:text-gray-400"
                >
                  {showLog ? 'Hide' : 'Show'} log
                </button>
                {showLog && (
                  <div className="mt-2">
                    <LogPanel rows={state.log} />
                  </div>
                )}
              </div>
            )}

            {saveError && !savedPath && (
              <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
            )}

            {savedPath && (
              <>
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  Saved → {savedPath}{' '}
                  <button onClick={() => window.api.showItemInFolder(savedPath)} className="text-brand hover:underline">
                    Open folder
                  </button>
                </p>
                {/*
                  Said once, after the save, because that is the moment the file exists where the
                  user can reach it: until then it is in temp, waiting for a destination. The
                  panel above is capped and collapses repeats — this file is neither, which is
                  the whole reason it was asked for (REP-1, REP-3).
                */}
                {consoleLogName && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    The complete console for this run was saved beside it, as {consoleLogName} —
                    uncapped and uncollapsed, unlike the panel above.
                  </p>
                )}
                {/*
                  Said rather than left to be discovered. A report that had to take another name is
                  still this run's report, and the file holding its usual name belongs to an older
                  one — which is exactly the wrong way round for anyone reading the folder (SOL-15).
                */}
                {renamedSidecars.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-500">
                    Files of those names were already there and were left alone, so{' '}
                    {renamedSidecars.length === 1 ? 'this run’s report was' : 'this run’s reports were'}{' '}
                    saved as {renamedSidecars.map((p) => p.split(/[\\/]/).pop()).join(', ')}.
                  </p>
                )}
                {staleSidecars.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-500">
                    Older files still sitting beside this subtitle under their usual names (
                    {staleSidecars.map((p) => p.split(/[\\/]/).pop()).join(', ')}) were left
                    alone — they are not this run.
                  </p>
                )}
                {saveError && (
                  <p className="text-xs text-amber-700 dark:text-amber-500">{saveError}</p>
                )}
              </>
            )}

            {/*
              The run that did NOT reach a Save.

              Routing this page's console through `dialog:saveFile` is right for a successful run
              and wrong for every other one: a stopped or failed translation has no subtitle to
              save, so gating the log on `savedPath` withheld it from precisely the runs it exists
              for. The file is already written — `finish()` reports it on every ending — so this
              points at the original in temp rather than at a copy that will never be made.
            */}
            {!savedPath && consoleLogPath && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                The complete console for this run → {consoleLogPath}{' '}
                <button
                  onClick={() => window.api.showItemInFolder(consoleLogPath)}
                  className="text-brand hover:underline"
                >
                  Show it
                </button>
              </p>
            )}
          </div>
        )}
      </Box>
    </div>
  )
}
