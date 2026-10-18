/**
 * The Align tab (implementation_plan.md §17.5 C.3; feature_decisions.md §4.2, §4.4, §4.6).
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * The page names the two files and a mode (Global, or the explicit Advanced piecewise action) and shows
 * what main decided. It never chooses a profile, a verdict, an executable or an output path, and never
 * starts Advanced by itself: Apply hands main the result id, and main's Save dialog is the one
 * explicit confirmation. It keeps its own state and does not touch the shared store, so the other tabs'
 * inputs are never changed from here.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Box, BoxTitle, Button, FilePicker, Label, Select, Working } from '../components/ui'
import { failureSentence, useRunner, type RunStatus } from '../lib/useRunner'
import { modelCapabilities } from '../../electron/shared/modelCaps'
import { resolveTranscribeSettings, transcribeRefusalMessage } from '../../electron/shared/transcribeSettings'
import { offersPiecewise, type AlignmentMode, type AlignmentMovement } from '../../electron/shared/alignment'
import type {
  AlignAdvancedDiagnostics,
  AlignAdvancedStatus,
  AlignAnalysis,
  AlignApplyResult,
  AlignAttempt,
  AlignDiagnosticExportResult,
  AlignDiagnosticOpenResult,
  AlignDiagnosticReplay,
  AlignEvidence,
  AlignRepair,
  AlignPreviewRow,
  AlignTranscriptionOffer,
  AppSettings,
  TranscribeArgs
} from '../../electron/shared/types'

const SUBTITLE_FILTERS = [{ name: 'SubRip subtitle', extensions: ['srt'] }]
const MEDIA_FILTERS = [
  { name: 'Video/Audio', extensions: ['mkv', 'mp4', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'mp3', 'aac', 'wav', 'm4a', 'flac'] }
]

type Result = Extract<AlignAnalysis, { status: 'result' }>
type Refused = Extract<AlignAnalysis, { status: 'refused' }>

/** The exact Global copy (§4.2); not paraphrased anywhere else. */
export const ALIGN_COPY = Object.freeze({
  acceptLabel: 'ACCEPT — Good match',
  checkLabel: 'CHECK — Partial match',
  acceptAction: 'Apply…',
  checkAction: 'Apply with caution…',
  piecewiseAction: 'Try piecewise alignment',
  applyNote: 'You choose where to save the aligned copy. Your original subtitle is never changed.',
  /** Beside Apply when the result kept the file's own timings (E159d, the tester's request). */
  keptIdentityNote: 'These subtitles are already aligned, so Apply just saves a copy with the same timings for you to use. Your original subtitle is never changed.'
})

/** The timing diagnostic (Bundle M §16.0.6, §16.0.8). Main chooses every file; an opened one only replays. */
export const DIAGNOSTIC_COPY = Object.freeze({
  title: 'Timing diagnostic',
  about:
    'A timing diagnostic holds only times, counts and codes: no subtitle text, no file names and no paths. Export one to show how Align decided; open one to replay that decision.',
  exportAction: 'Export timing diagnostic…',
  openAction: 'Open timing diagnostic…',
  replayTitle: 'Timing diagnostic replay',
  replayNote: 'Replay of the timing comparison. This file cannot change any subtitle.',
  close: 'Close'
})

/** 84.5 → "84.5", 85 → "85". */
export function formatPct(n: number): string {
  return (Math.round(n * 10) / 10).toString()
}

/** The exact Advanced copy (§4.6): the action, and the name a piecewise result carries. */
export const ADVANCED_COPY = Object.freeze({
  action: 'Advanced → Piecewise (ALASS)',
  globalMode: 'Global',
  piecewiseMode: 'Advanced → Piecewise (ALASS)',
  /** With a video reference, Advanced uses ALASS's own speech detector and nothing else in the file. */
  media:
    'With a video file, ALASS listens for speech in its audio with its own detector, on this computer (nothing is uploaded). ' +
    'The video\u2019s subtitle tracks are not used, and a refusal does not fall back to Global or a transcription.'
})

/** §4.2's CHECK warning for the mode that produced the result; the two are not interchangeable. */
export function checkWarning(coveragePct: number, mode: AlignmentMode = 'global'): string {
  const support = mode === 'piecewise' ? 'this piecewise alignment' : 'one global map'
  return `Only ${formatPct(coveragePct)}% of dialogue cues support ${support}. Review unsupported sections before applying.`
}

/** +2340 → "+2.340 s". */
export function formatShift(ms: number): string {
  return `${ms >= 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(3)} s`
}

/** `HH:MM:SS,mmm`, as the file writes it. */
export function formatCueTime(ms: number): string {
  const sign = ms < 0 ? '-' : ''
  const t = Math.abs(Math.round(ms))
  const pad = (n: number, w: number): string => String(n).padStart(w, '0')
  return `${sign}${pad(Math.floor(t / 3_600_000), 2)}:${pad(Math.floor(t / 60_000) % 60, 2)}:${pad(Math.floor(t / 1000) % 60, 2)},${pad(t % 1000, 3)}`
}

const FPS_CHANGES: Array<[number, string]> = [
  [25 / (24000 / 1001), '23.976 → 25 fps'],
  [(24000 / 1001) / 25, '25 → 23.976 fps'],
  [25 / 24, '24 → 25 fps'],
  [24 / 25, '25 → 24 fps'],
  [24 / (24000 / 1001), '23.976 → 24 fps'],
  [(24000 / 1001) / 24, '24 → 23.976 fps'],
  [(30000 / 1001) / 25, '25 → 29.97 fps'],
  [25 / (30000 / 1001), '29.97 → 25 fps']
]

/** The map in words: how far the subtitles move and whether they are sped up or slowed down. */
export function describeMap(scale: number | null, offsetMs: number | null): string {
  if (scale === null || offsetMs === null) return '—'
  const shift = formatShift(offsetMs)
  if (Math.abs(scale - 1) < 0.0002) return `shift ${shift}, no speed change`
  const known = FPS_CHANGES.find(([s]) => Math.abs(scale - s) < 0.0005)
  return `shift ${shift}, speed ×${scale.toFixed(6)}${known ? ` (like ${known[1]})` : ''}`
}

const REASON_LABEL: Record<Refused['reason'], string> = {
  malformed: 'The file has structural problems',
  insufficient: 'Too few dialogue lines',
  wrong_title: 'Looks like a different film or episode',
  weak_correspondence: 'No single global map fits',
  likely_different_cut: 'Looks like a different cut',
  invariant_failure: 'The map would break the file',
  invalid_request: 'Choose both files first',
  source_unreadable: 'The subtitle could not be read',
  reference_unreadable: 'The reference could not be read',
  reference_not_text: 'The reference is an image subtitle',
  no_text_reference: 'No usable subtitle track',
  media_unreadable: 'The media file could not be read',
  audio_unusable: 'The audio gave no usable timing',
  transcription_failed: 'The transcription did not finish',
  offer_expired: 'That offer is no longer valid',
  busy: 'Another job is running',
  analysis_failed: 'The analysis could not finish',
  advanced_unavailable: 'Advanced is not available',
  advanced_failed: 'ALASS gave no usable result',
  embedded_track_conflict: 'The subtitle tracks disagree'
}

/** A piecewise refusal judged ALASS's output, not a global map, so these reasons are worded for it. */
const PIECEWISE_REASON_LABEL: Partial<Record<Refused['reason'], string>> = {
  weak_correspondence: 'ALASS’s result does not fit the reference',
  likely_different_cut: 'ALASS’s result still disagrees in places',
  invariant_failure: 'ALASS’s result would break the file'
}

export function refusalLabel(reason: Refused['reason'], mode: AlignmentMode = 'global'): string {
  return `REFUSED — ${(mode === 'piecewise' ? PIECEWISE_REASON_LABEL[reason] : undefined) ?? REASON_LABEL[reason] ?? 'No result'}`
}

function Stat({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{label}</div>
      <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{value}</div>
    </div>
  )
}

/**
 * A piecewise result has no single map. ALASS's own figures are shown as what they are — its proposal —
 * since NG's verdict never reads them.
 */
export function piecewiseMapText(advanced?: AlignAdvancedDiagnostics): string {
  const sections = advanced ? `${advanced.shiftGroups.toLocaleString()} section${advanced.shiftGroups === 1 ? '' : 's'}` : 'sections'
  const fps = advanced && advanced.fpsRatio !== '1' ? `, frame-rate ratio ${advanced.fpsRatio}` : ''
  return `piecewise — ALASS moved the subtitle in ${sections}${fps}; the app then checked its result against the reference`
}

/** The Map line when the file was already aligned and its own times were kept. */
export const KEPT_IDENTITY_MAP = 'already aligned — the timings are kept unchanged'

/** One line per side read with repair. A clause whose count is 0 is left out. */
export function repairLine(r: AlignRepair): string {
  const subtitles = (n: number): string => `${n.toLocaleString()} subtitle${n === 1 ? '' : 's'}`
  const ending = (n: number): string => (n === 1 ? 'ends when or before it starts' : 'end when or before they start')
  const counts =
    r.outOfOrder > 0 && r.endAtOrBeforeStart > 0
      ? `${subtitles(r.outOfOrder)} out of time order and ${r.endAtOrBeforeStart.toLocaleString()} that ${ending(r.endAtOrBeforeStart)}`
      : r.outOfOrder > 0
        ? `${subtitles(r.outOfOrder)} out of time order`
        : `${subtitles(r.endAtOrBeforeStart)} that ${ending(r.endAtOrBeforeStart)}`
  if (r.side === 'reference') return `The reference had ${counts}. Align used a tidied copy of its timings.`
  const kept =
    r.endAtOrBeforeStart > 0
      ? 'In the result every subtitle keeps its place and its text, only the times change, and a subtitle that ended when or before it started still does.'
      : 'In the result every subtitle keeps its place and its text, only the times change.'
  return `The subtitle to align had ${counts}. Align checked the timing on a tidied copy. ${kept}`
}

/** Why an embedded track was skipped, or why a usable one is not the answer (Bundle M §16.0.4). */
export const ATTEMPT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  image: 'image subtitle, not text',
  not_text: 'not a text subtitle format',
  too_large: 'too large to check: at most 8 MiB and 20,000 lines',
  too_many_tracks: 'only the first 128 subtitle tracks are checked',
  outvoted: 'outvoted: more independent tracks agree on a different timing',
  split_family: 'a copy of a track counted on another side, so it adds nothing'
})

/** One "References tried" line after the reference's name. */
export function attemptText(a: AlignAttempt): string {
  if (a.verdict === 'skipped') return `skipped (${ATTEMPT_LABEL[a.reason] ?? a.reason.replace(/_/g, ' ')})`
  return a.reason === 'outvoted' || a.reason === 'split_family' ? `${a.verdict}, not used (${ATTEMPT_LABEL[a.reason]})` : a.verdict
}

/** "Track 2", "Tracks 1 and 3", "Tracks 1, 2 and 4". */
function trackList(ordinals: number[]): string {
  if (ordinals.length === 1) return `Track ${ordinals[0]}`
  return `Tracks ${ordinals.slice(0, -1).join(', ')} and ${ordinals[ordinals.length - 1]}`
}

/** Which embedded tracks agreed, how many independent witnesses each side had, and how it was decided. */
export function trackEvidenceLines(evidence: AlignEvidence): string[] {
  const a = evidence.arbitration
  if (!a) return []
  const witnesses = (n: number): string => `${n} independent ${n === 1 ? 'witness' : 'witnesses'}`
  const lines = a.sides.map(
    (s) => `${trackList(s.members)} ${s.members.length === 1 ? 'gives one timing' : 'agree on one timing'}: ${witnesses(s.witnesses)}${a.winner === s.id ? ' (used)' : ''}.`
  )
  const families = new Map<number, number[]>()
  for (const t of evidence.tracks ?? []) if (t.family !== null) families.set(t.family, [...(families.get(t.family) ?? []), t.ordinal])
  for (const members of families.values()) if (members.length > 1) lines.push(`${trackList(members)} have the same timings, so they count as one witness.`)
  if (a.tieBroken === 'audio') lines.push('The sides had the same number of witnesses, and the speech in the audio settled it.')
  if (a.winner === null) lines.push('No side has more independent witnesses, and the audio could not settle it.')
  return lines
}

/** The measured evidence: what was compared, how much of it agreed, and the map. Numbers only. */
export function EvidenceSummary({
  evidence,
  piecewise,
  advanced
}: {
  evidence: AlignEvidence
  /** The evidence judges ALASS's output, so the map line describes that instead of a global map. */
  piecewise?: boolean
  advanced?: AlignAdvancedDiagnostics
}): React.JSX.Element {
  const matched = evidence.retained !== null ? `${evidence.retained.toLocaleString()} of ${evidence.sourceDialogue.toLocaleString()}` : '—'
  const decided = trackEvidenceLines(evidence)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 sm:grid-cols-4 dark:border-gray-700 dark:bg-gray-900/40">
        <Stat label="Reference" value={evidence.reference} />
        <Stat label="Dialogue cues matched" value={evidence.coveragePct !== null ? `${formatPct(evidence.coveragePct)}%` : '—'} />
        <Stat label="Lines that agree" value={matched} />
        <Stat label="Typical error" value={evidence.residualAbsMedianMs !== null ? `${Math.round(evidence.residualAbsMedianMs)} ms` : '—'} />
      </div>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        <span className="font-semibold">Map:</span>{' '}
        {piecewise ? piecewiseMapText(advanced) : evidence.keptIdentity ? KEPT_IDENTITY_MAP : describeMap(evidence.scale, evidence.offsetMs)}
      </p>
      {evidence.repairs?.map((r, i) => (
        <p key={i} className="text-sm text-gray-700 dark:text-gray-300">
          {repairLine(r)}
        </p>
      ))}
      {evidence.attempts.length > 1 && (
        <div className="text-xs text-gray-600 dark:text-gray-400">
          <div className="mb-1 font-semibold">References tried, in order</div>
          <ul className="list-inside list-disc space-y-0.5">
            {evidence.attempts.map((a, i) => (
              <li key={i}>
                {a.reference}: {attemptText(a)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {decided.length > 0 && (
        <div className="text-xs text-gray-600 dark:text-gray-400">
          <div className="mb-1 font-semibold">How the subtitle tracks were decided</div>
          <ul className="list-inside list-disc space-y-0.5">
            {decided.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Before and after for each cue. The text is the user's own line, shown here and nowhere else. */
export function PreviewTable({ rows, total, onMore }: { rows: AlignPreviewRow[]; total: number; onMore?: () => void }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="thin-scroll max-h-80 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
            <tr>
              <th className="px-2 py-1.5 font-semibold">#</th>
              <th className="px-2 py-1.5 font-semibold">Now</th>
              <th className="px-2 py-1.5 font-semibold">Aligned</th>
              <th className="px-2 py-1.5 font-semibold">Text</th>
            </tr>
          </thead>
          <tbody className="font-mono text-gray-800 dark:text-gray-200">
            {rows.map((r) => (
              <tr key={r.index} className="border-t border-gray-100 align-top dark:border-gray-700/60">
                <td className="px-2 py-1 text-gray-500">{r.index}</td>
                <td className="whitespace-nowrap px-2 py-1">{formatCueTime(r.startMs)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-brand">{formatCueTime(r.newStartMs)}</td>
                <td className="whitespace-pre-wrap px-2 py-1 font-sans">{r.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span>
          Showing {rows.length.toLocaleString()} of {total.toLocaleString()} cues
        </span>
        {onMore && rows.length < total && (
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onMore}>
            Show more
          </Button>
        )}
      </div>
    </div>
  )
}

/** Main's representative moves (start, quarters, end): where lines go, without their text. */
export function MovementPreview({ movements }: { movements: AlignmentMovement[] }): React.JSX.Element | null {
  if (movements.length === 0) return null
  return (
    <div className="text-xs text-gray-600 dark:text-gray-400">
      <div className="mb-1 font-semibold">How the cues move, from the start to the end of the file</div>
      <ul className="space-y-0.5 font-mono">
        {movements.map((m) => (
          <li key={m.index}>
            Cue {m.index}: {formatCueTime(m.fromMs)} → {formatCueTime(m.toMs)} ({formatShift(m.deltaMs)})
          </li>
        ))}
      </ul>
    </div>
  )
}

export function modeLabel(mode: AlignmentMode | undefined): string {
  return mode === 'piecewise' ? ADVANCED_COPY.piecewiseMode : ADVANCED_COPY.globalMode
}

/**
 * An accept or check result: the label, the evidence, the preview and the one Apply action. A check
 * carries §4.2's exact warning for its mode and the cautious action label; both go to the same Save dialog.
 */
export function AlignResultCard({
  result,
  rows,
  applying,
  saved = false,
  onApply,
  onMore
}: {
  result: Result
  rows: AlignPreviewRow[]
  applying: boolean
  /** Main consumed the result on a successful save; a second Apply could only be refused. */
  saved?: boolean
  onApply: () => void
  onMore?: () => void
}): React.JSX.Element {
  const check = result.verdict === 'check'
  const mode = result.mode ?? 'global'
  const movements = result.alignment && result.alignment.verdict !== 'refuse' ? result.alignment.movements : []
  return (
    <Box>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{modeLabel(mode)}</div>
      <div className={`mb-3 text-sm font-bold tracking-wide ${check ? 'text-amber-600 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}>
        {check ? ALIGN_COPY.checkLabel : ALIGN_COPY.acceptLabel}
      </div>
      {check && (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          {checkWarning(result.evidence.arbitration?.checkCoveragePct ?? result.evidence.coveragePct ?? 0, mode)}
        </p>
      )}
      <EvidenceSummary evidence={result.evidence} piecewise={mode === 'piecewise'} advanced={result.advanced} />
      {movements.length > 0 && (
        <div className="mt-3">
          <MovementPreview movements={movements} />
        </div>
      )}
      <div className="mt-4">
        <PreviewTable rows={rows} total={result.preview.total} onMore={onMore} />
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={onApply} disabled={applying || saved}>
          {check ? ALIGN_COPY.checkAction : ALIGN_COPY.acceptAction}
        </Button>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {result.evidence.keptIdentity && mode !== 'piecewise' ? ALIGN_COPY.keptIdentityNote : ALIGN_COPY.applyNote}
        </span>
      </div>
    </Box>
  )
}

/** How often a busy Advanced is asked again; each ask is a status read, never a run. */
export const ADVANCED_BUSY_RECHECK_MS = 5_000

/**
 * Advanced's status from main. Only the latest ask may land, so an older answer never overwrites a newer
 * one. While main says busy — an earlier ALASS tree has not ended — it asks again every `everyMs` until
 * main says otherwise; `stop` ends that with the page. It only reads the status: it never starts anything.
 */
export function advancedStatusWatcher(
  ask: () => Promise<AlignAdvancedStatus>,
  set: (s: AlignAdvancedStatus) => void,
  everyMs: number = ADVANCED_BUSY_RECHECK_MS
): { refresh: () => void; stop: () => void } {
  let latest = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const refresh = (): void => {
    if (stopped) return
    clear()
    const mine = ++latest
    const land = (s: AlignAdvancedStatus): void => {
      if (stopped || mine !== latest) return
      set(s)
      if (!s.available && s.reason === 'busy') timer = setTimeout(refresh, everyMs)
    }
    ask().then(land, (e: unknown) =>
      land({
        available: false,
        reason: 'not_runnable',
        message: `Advanced could not be checked: ${(e as Error)?.message ?? String(e)}. Global alignment still works.`
      })
    )
  }
  return {
    refresh,
    stop: () => {
      stopped = true
      clear()
    }
  }
}

/** Why Advanced cannot run right now, or null when it can. Not yet known counts as not runnable. */
export function advancedBlock(status: AlignAdvancedStatus | null): string | null {
  if (status === null) return 'Checking whether Advanced is available…'
  return status.available ? null : status.message
}

/**
 * A refusal: the reason and the measured findings. There is no Apply. A Global `likely_different_cut`
 * adds §4.4's explicit Try piecewise action — still a refusal, and it runs only when clicked.
 */
export function AlignRefusalCard({
  refusal,
  advanced = null,
  disabled = false,
  onTryPiecewise
}: {
  refusal: Refused
  advanced?: AlignAdvancedStatus | null
  disabled?: boolean
  onTryPiecewise?: () => void
}): React.JSX.Element {
  const offer = !!onTryPiecewise && !!refusal.alignment && offersPiecewise(refusal.alignment)
  const fromMedia = refusal.alignment?.referenceKind === 'embedded' || refusal.alignment?.referenceKind === 'audio'
  const blocked = advancedBlock(advanced)
  return (
    <Box>
      {refusal.mode === 'piecewise' && (
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{modeLabel('piecewise')}</div>
      )}
      <div className="mb-2 text-sm font-bold tracking-wide text-red-700 dark:text-red-400">{refusalLabel(refusal.reason, refusal.mode)}</div>
      <p className="mb-3 text-sm text-gray-700 dark:text-gray-300">{refusal.message}</p>
      {refusal.evidence && refusal.evidence.sourceCues > 0 && (
        <EvidenceSummary evidence={refusal.evidence} piecewise={refusal.mode === 'piecewise'} advanced={refusal.advanced} />
      )}
      {offer && (
        <div className="mt-4 space-y-2 rounded-md border border-gray-200 px-3 py-3 dark:border-gray-700">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Parts of the file agree with the reference at different shifts, as when a scene is added or removed in one
            release. Piecewise alignment (ALASS) can move the subtitle in sections. The app checks its result with the same rules
            before you see a preview, and nothing is saved until you Apply.
          </p>
          {fromMedia && <p className="text-sm text-gray-700 dark:text-gray-300">{ADVANCED_COPY.media}</p>}
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={onTryPiecewise} disabled={disabled || blocked !== null}>
              {ALIGN_COPY.piecewiseAction}
            </Button>
            {blocked && <span className="text-xs text-gray-500 dark:text-gray-400">{blocked}</span>}
          </div>
        </div>
      )}
    </Box>
  )
}

/**
 * Advanced (§4.6): its own action with its own availability. When ALASS is missing, altered or busy only
 * this action is disabled, with main's reason; Global above is unaffected.
 */
export function AdvancedPanel({
  status,
  ready,
  media = false,
  onRun
}: {
  status: AlignAdvancedStatus | null
  /** Both files are chosen and nothing is running — the same condition as Analyze. */
  ready: boolean
  /** The reference is a video file. */
  media?: boolean
  onRun: () => void
}): React.JSX.Element {
  const blocked = advancedBlock(status)
  return (
    <Box>
      <BoxTitle>Advanced</BoxTitle>
      <div className="flex items-start gap-3">
        <Button variant="secondary" onClick={onRun} disabled={!ready || blocked !== null}>
          {ADVANCED_COPY.action}
        </Button>
        <div className="space-y-1 text-xs text-gray-500 dark:text-gray-400">
          <p>
            For a different cut of the film, where one global map cannot fit — for example a scene added or removed. ALASS
            moves the subtitle in sections; the app then checks its result against the same reference with the same rules, and
            nothing is saved until you Apply. It does not repair the timing of individual lines.
          </p>
          {media && <p>{ADVANCED_COPY.media}</p>}
          {blocked && <p className="text-amber-700 dark:text-amber-400">{blocked}</p>}
        </div>
      </div>
    </Box>
  )
}

/** 95 → "1 min 35 s", 6125 → "1 h 42 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
}

/**
 * The normal Transcribe run's arguments, built from Settings exactly as the Transcribe tab builds them
 * (`TranscribePage.handleStart`), with the offer's main-owned file as the output. Nothing here is the
 * Transcribe tab's own input: its chosen file, output and description are left as they are.
 */
export function alignTranscribeArgs(s: AppSettings, mediaFile: string, outputFile: string): TranscribeArgs {
  const run = resolveTranscribeSettings(s)
  return {
    mediaFile,
    outputFile,
    targetLang: '',
    model: run.model,
    apiKeys: s.apiKeys,
    thinkingLevel: run.thinkingLevel,
    thinkingBudget: run.thinkingBudget,
    customGenerationParams: s.customGenerationParams,
    temperature: s.temperature,
    topP: s.topP,
    topK: s.topK,
    ffmpegPath: s.ffmpegPath || undefined
  }
}

export const OFFER_COPY = Object.freeze({
  title: 'Try again with a transcription of the video?',
  confirm: 'Transcribe and align again',
  decline: 'No thanks'
})

/**
 * The ask-first card (tester 2026-10-07): what the transcription is for, what it costs in time and quota,
 * what the user gains, and what happens either way — before anything is sent.
 */
export function TranscriptionOfferCard({
  offer,
  onConfirm,
  onDecline,
  disabled = false,
  starting = false
}: {
  offer: AlignTranscriptionOffer
  onConfirm: () => void
  onDecline: () => void
  disabled?: boolean
  /** A Confirm is already on its way: a second one is refused, while Decline can still withdraw it. */
  starting?: boolean
}): React.JSX.Element {
  const [lo, hi] = offer.estimateMinutes
  const time = lo === hi ? `about ${lo} minute${lo === 1 ? '' : 's'}` : `about ${lo}–${hi} minutes`
  const requests = `${offer.requests} request${offer.requests === 1 ? '' : 's'}`
  return (
    <Box className="border-blue-200 bg-blue-50/40 dark:border-blue-900/50 dark:bg-blue-950/30">
      <BoxTitle>{OFFER_COPY.title}</BoxTitle>
      <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
        <p>
          <span className="font-semibold">What it is for.</span> Gemini would transcribe the video&apos;s dialogue. Align then uses only
          the times at which lines are spoken, as anchors, to look once more for one global map for your subtitle. Your subtitle
          keeps its own text; the transcript&apos;s words are never used and are deleted afterwards.
        </p>
        <p>
          <span className="font-semibold">What you could gain.</span> If the anchors agree, you get an ACCEPT or CHECK result with a
          preview, as usual. Nothing is saved until you Apply.
        </p>
        <p>
          <span className="font-semibold">What it costs.</span> {formatDuration(offer.audioSeconds)} of audio, sent as {requests} to{' '}
          <span className="font-mono">{offer.model}</span>; {time}, longer when Gemini is busy (a busy model can also make it fail, and
          then nothing is changed). It uses your Gemini API quota — on a paid key it is billed — and the quota is spent even if
          Align refuses again.
        </p>
        <p>
          <span className="font-semibold">What it cannot promise.</span> Transcript timings can be off by half a second or more. When they
          disagree, Align refuses again rather than guess; it never copies the transcript&apos;s times into your subtitle.
        </p>
        <p>
          <span className="font-semibold">If you say no.</span> Nothing is sent and nothing changes. You can still align against another
          subtitle file that is already in sync.
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          It runs as a normal transcription with the Transcribe tab&apos;s model and settings, one job at a time: Translate and Transcribe
          wait until it finishes. The Transcribe tab&apos;s own files are not touched.
        </p>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={onConfirm} disabled={disabled || starting}>
          {OFFER_COPY.confirm}
        </Button>
        <Button variant="secondary" onClick={onDecline} disabled={disabled}>
          {OFFER_COPY.decline}
        </Button>
      </div>
    </Box>
  )
}

export type ConsentOutcome =
  | { kind: 'started' }
  | { kind: 'withdrawn' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'model_changed'; model: string }

/**
 * The Confirm half of ask-first. Settings are read fresh (the normal Transcribe run uses them), then the
 * run starts only if this confirmation still owns the offer and the model is the one the card named.
 */
export async function consentToTranscription(
  offer: AlignTranscriptionOffer,
  mediaFile: string,
  io: { getSettings(): Promise<AppSettings>; stillOwned(): boolean; launch(args: TranscribeArgs): Promise<void> }
): Promise<ConsentOutcome> {
  const s = await io.getSettings()
  if (!io.stillOwned()) return { kind: 'withdrawn' }
  const args = alignTranscribeArgs(s, mediaFile, offer.outputPath)
  if (!modelCapabilities(args.model).supportsTranscription) {
    return { kind: 'unsupported', message: transcribeRefusalMessage(args.model, s.transcribeOverride) }
  }
  if (args.model !== offer.model) return { kind: 'model_changed', model: args.model }
  await io.launch(args)
  return { kind: 'started' }
}

/**
 * How the consented run ended, read from the runner's status alone: a refused or failed launch can go
 * straight from Confirm to `error` without a `running` state ever being rendered.
 */
export function transcriptionEnding(status: RunStatus): 'done' | 'stopped' | 'error' | null {
  return status === 'done' || status === 'stopped' || status === 'error' ? status : null
}

/** `prev` with `page` appended, only when it continues `prev` exactly where it was asked to. */
export function previewRowsAfter(prev: AlignPreviewRow[], askedFrom: number, page: { from: number; rows: AlignPreviewRow[] } | null): AlignPreviewRow[] {
  return page && page.from === askedFrom && prev.length === askedFrom ? [...prev, ...page.rows] : prev
}

/** Main could not (yet) delete a temporary folder: say where it is, since it may hold transcript text. */
export function CleanupNotice({ text }: { text: string }): React.JSX.Element {
  return (
    <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      {text}
    </p>
  )
}

export function applyOutcomeText(outcome: AlignApplyResult): string {
  if (outcome.ok) return `Saved: ${outcome.path}`
  return outcome.code === 'cancelled' ? '' : outcome.message
}

/** What an Export or Open said. A cancelled dialog says nothing; an opened file shows its replay card instead. */
export function diagnosticOutcomeText(outcome: AlignDiagnosticExportResult | AlignDiagnosticOpenResult): string {
  if (outcome.ok) return 'path' in outcome ? `Timing diagnostic saved: ${outcome.path}` : ''
  return outcome.code === 'cancelled' ? '' : outcome.message
}

/** Export only for an outcome main can export; Open is always there. Neither ever applies anything. */
export function DiagnosticActions({
  exportable,
  busy = false,
  onExport,
  onOpen
}: {
  exportable: boolean
  busy?: boolean
  onExport: () => void
  onOpen: () => void
}): React.JSX.Element {
  return (
    <Box>
      <BoxTitle>{DIAGNOSTIC_COPY.title}</BoxTitle>
      <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{DIAGNOSTIC_COPY.about}</p>
      <div className="flex items-center gap-3">
        {exportable && (
          <Button variant="secondary" onClick={onExport} disabled={busy}>
            {DIAGNOSTIC_COPY.exportAction}
          </Button>
        )}
        <Button variant="secondary" onClick={onOpen} disabled={busy}>
          {DIAGNOSTIC_COPY.openAction}
        </Button>
      </div>
    </Box>
  )
}

/** An opened diagnostic, replayed in main: what it decided and whether every recorded step came out the same. */
export function DiagnosticReplayCard({ replay, onClose }: { replay: AlignDiagnosticReplay; onClose?: () => void }): React.JSX.Element {
  const verdict =
    replay.verdict === 'refuse'
      ? refusalLabel(replay.reason as Refused['reason'])
      : replay.verdict === 'check'
        ? ALIGN_COPY.checkLabel
        : ALIGN_COPY.acceptLabel
  const map = replay.keptIdentity ? KEPT_IDENTITY_MAP : describeMap(replay.transform?.scale ?? null, replay.transform?.offsetMs ?? null)
  return (
    <Box>
      <BoxTitle>{DIAGNOSTIC_COPY.replayTitle}</BoxTitle>
      <p className="mb-3 text-sm text-gray-700 dark:text-gray-300">{DIAGNOSTIC_COPY.replayNote}</p>
      <div className="mb-2 text-sm font-bold tracking-wide text-gray-800 dark:text-gray-100">{verdict}</div>
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 sm:grid-cols-4 dark:border-gray-700 dark:bg-gray-900/40">
        <Stat label="Subtitle lines" value={replay.sourceCues.toLocaleString()} />
        <Stat label="Comparisons" value={replay.calls.toLocaleString()} />
        <Stat label="Subtitle tracks" value={replay.tracks.toLocaleString()} />
        <Stat label="Sides" value={replay.sides > 0 ? replay.sides.toLocaleString() : '—'} />
      </div>
      <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
        <span className="font-semibold">Map:</span> {map}
      </p>
      {replay.stage === 'arbitration' && (
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
          {replay.winner === null
            ? 'No side of the subtitle tracks won.'
            : `Side ${replay.winner} of the subtitle tracks won${replay.tieBroken === 'audio' ? ', settled by the speech in the audio' : ''}.`}
        </p>
      )}
      <p className={`mt-3 text-sm ${replay.matches ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
        {replay.matches
          ? 'Replayed on this computer: every recorded comparison came out exactly the same.'
          : `Replayed on this computer: ${replay.mismatches.length.toLocaleString()} recorded ${replay.mismatches.length === 1 ? 'step' : 'steps'} came out differently (${replay.mismatches.join(', ')}).`}
      </p>
      {onClose && (
        <div className="mt-4">
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClose}>
            {DIAGNOSTIC_COPY.close}
          </Button>
        </div>
      )}
    </Box>
  )
}

/** Strictly increasing within this renderer, and past any generation main saw before a reload. */
function nextGeneration(prev: number): number {
  return Math.max(Date.now(), prev + 1)
}

export default function AlignPage(): React.JSX.Element {
  const [sourcePath, setSourcePath] = useState('')
  const [refKind, setRefKind] = useState<'subtitle' | 'media'>('subtitle')
  const [refPath, setRefPath] = useState('')
  const [analysis, setAnalysis] = useState<AlignAnalysis | null>(null)
  const [rows, setRows] = useState<AlignPreviewRow[]>([])
  const [running, setRunning] = useState<{ generation: number; since: number } | null>(null)
  const [step, setStep] = useState<{ label: string; pct: number | null }>({ label: '', pct: null })
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState<AlignApplyResult | null>(null)
  /** The consented transcription, from Confirm until the analysis that uses its transcript starts. */
  const [tx, setTx] = useState<{ offer: AlignTranscriptionOffer; generation: number; since: number } | null>(null)
  const [offerNote, setOfferNote] = useState('')
  /** A Confirm between its click and the run's start; anything that withdraws the offer clears it. */
  const pendingStart = useRef<{ token: string } | null>(null)
  const [starting, setStarting] = useState(false)
  const [advanced, setAdvanced] = useState<AlignAdvancedStatus | null>(null)
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagNote, setDiagNote] = useState('')
  const [replay, setReplay] = useState<AlignDiagnosticReplay | null>(null)
  const generation = useRef(0)
  const runner = useRunner()

  const advancedWatch = useRef<ReturnType<typeof advancedStatusWatcher> | null>(null)
  const refreshAdvanced = (): void => advancedWatch.current?.refresh()

  useEffect(() => {
    const w = advancedStatusWatcher(() => window.api.alignAdvancedStatus(), setAdvanced)
    advancedWatch.current = w
    w.refresh()
    return () => {
      w.stop()
      if (advancedWatch.current === w) advancedWatch.current = null
    }
  }, [])

  const withdrawStart = (): void => {
    pendingStart.current = null
    setStarting(false)
  }

  useEffect(
    () =>
      window.api.onAlignProgress((p) => {
        if (p.generation === generation.current) setStep({ label: p.label, pct: p.pct })
      }),
    []
  )

  /** Inputs changed: what is on screen no longer describes them. */
  const invalidate = (): void => {
    const held = running?.generation ?? analysis?.generation
    if (held) void window.api.alignCancel(held)
    if (tx) void runner.stop()
    withdrawStart()
    generation.current = nextGeneration(generation.current)
    setTx(null)
    setOfferNote('')
    setRunning(null)
    setAnalysis(null)
    setRows([])
    setApplied(null)
    setDiagNote('')
  }

  const exportDiagnostic = async (): Promise<void> => {
    if ((analysis?.status !== 'result' && analysis?.status !== 'refused') || !analysis.diagnosticExportable) return
    const g = analysis.generation
    setDiagBusy(true)
    try {
      const out = await window.api.alignExportDiagnostic({ generation: g })
      if (generation.current === g) setDiagNote(diagnosticOutcomeText(out))
    } catch (e) {
      setDiagNote(`The timing diagnostic could not be saved: ${(e as Error)?.message ?? String(e)}`)
    } finally {
      setDiagBusy(false)
    }
  }

  const openDiagnostic = async (): Promise<void> => {
    setDiagBusy(true)
    try {
      const out = await window.api.alignOpenDiagnostic()
      if (out.ok) setReplay(out.replay)
      setDiagNote(diagnosticOutcomeText(out))
    } catch (e) {
      setDiagNote(`The timing diagnostic could not be opened: ${(e as Error)?.message ?? String(e)}`)
    } finally {
      setDiagBusy(false)
    }
  }

  const analyze = async (transcriptionToken?: string, mode: AlignmentMode = 'global'): Promise<void> => {
    const g = nextGeneration(generation.current)
    generation.current = g
    withdrawStart()
    setAnalysis(null)
    setRows([])
    setApplied(null)
    setOfferNote('')
    setDiagNote('')
    setStep({ label: 'Starting…', pct: null })
    setRunning({ generation: g, since: Date.now() })
    let out: AlignAnalysis
    try {
      out = await window.api.alignAnalyze({
        generation: g,
        sourcePath,
        reference: { kind: refKind, path: refPath },
        ...(transcriptionToken ? { transcriptionToken } : {}),
        ...(mode === 'piecewise' ? { mode } : {})
      })
    } catch (e) {
      out = {
        status: 'refused',
        generation: g,
        verdict: 'refuse',
        reason: 'analysis_failed',
        message: `The analysis could not finish: ${(e as Error)?.message ?? String(e)}. Nothing was changed; try again.`,
        evidence: null
      }
    }
    if (mode === 'piecewise') refreshAdvanced()
    if (generation.current !== g) return
    setRunning(null)
    if (out.status === 'result' || out.status === 'refused') setAnalysis(out)
    if (out.status === 'result') setRows(out.preview.rows)
  }

  const analyzePiecewise = (): void => void analyze(undefined, 'piecewise')

  const confirmTranscription = async (): Promise<void> => {
    if (analysis?.status !== 'refused' || !analysis.transcriptionOffer || tx || pendingStart.current) return
    const offer = analysis.transcriptionOffer
    const offerGeneration = analysis.generation
    // Claimed before the first await, so Decline, a changed input or a new analysis can withdraw it.
    const claim = { token: offer.token }
    pendingStart.current = claim
    setStarting(true)
    setOfferNote('')
    try {
      const outcome = await consentToTranscription(offer, refPath, {
        getSettings: () => window.api.getSettings(),
        stillOwned: () => pendingStart.current === claim,
        launch: async (args) => {
          withdrawStart()
          // One synchronous batch: the first render with `tx` already has this run's status, never an
          // earlier run's ending.
          runner.reset()
          setTx({ offer, generation: offerGeneration, since: Date.now() })
          await runner.start((runId) => window.api.startTranscribe({ ...args, runId }))
        }
      })
      if (outcome.kind === 'unsupported') setOfferNote(outcome.message)
      if (outcome.kind === 'model_changed') {
        setAnalysis((a) =>
          a?.status === 'refused' && a.transcriptionOffer?.token === offer.token
            ? { ...a, transcriptionOffer: { ...a.transcriptionOffer, model: outcome.model } }
            : a
        )
        setOfferNote(`The Transcribe model is now ${outcome.model}, not ${offer.model}. The card above is updated; confirm again to use it.`)
      }
    } finally {
      if (pendingStart.current === claim) withdrawStart()
    }
  }

  const declineTranscription = (): void => {
    if (analysis?.status !== 'refused' || !analysis.transcriptionOffer) return
    withdrawStart()
    void window.api.alignCancel(analysis.generation)
    setAnalysis({ ...analysis, transcriptionOffer: undefined })
    setOfferNote('No transcription was run and nothing was sent.')
  }

  // The consented run has ended: on success the transcript's times become anchors; otherwise say why.
  useEffect(() => {
    if (!tx) return
    const status = transcriptionEnding(runner.state.status)
    if (!status) return
    const token = tx.offer.token
    setTx(null)
    if (status === 'done') {
      void analyze(token)
      return
    }
    // The spent offer and its partial transcript go; a new Analyze makes a fresh offer.
    void window.api.alignCancel(tx.generation)
    setAnalysis((a) => (a?.status === 'refused' && a.transcriptionOffer?.token === token ? { ...a, transcriptionOffer: undefined } : a))
    setOfferNote(
      status === 'stopped'
        ? 'The transcription was stopped, so nothing was aligned. Nothing was changed. Analyze again for a fresh offer.'
        : `The transcription did not finish, so nothing was aligned. ${failureSentence(runner.state, 'transcribe') ?? runner.state.error?.message ?? ''} Analyze again for a fresh offer.`.replace(/\s+/g, ' ').trim()
    )
  }, [runner.state.status, tx])

  const cancel = (): void => {
    if (!running) return
    void window.api.alignCancel(running.generation)
    generation.current = nextGeneration(generation.current)
    setRunning(null)
  }

  const more = async (): Promise<void> => {
    if (analysis?.status !== 'result') return
    const g = analysis.generation
    const from = rows.length
    const page = await window.api.alignPreview({ generation: g, resultId: analysis.resultId, from, count: 100 })
    if (generation.current !== g) return
    setRows((prev) => previewRowsAfter(prev, from, page))
  }

  const apply = async (): Promise<void> => {
    if (analysis?.status !== 'result') return
    const g = analysis.generation
    setApplying(true)
    try {
      const out = await window.api.alignApply({ generation: g, resultId: analysis.resultId })
      if (generation.current === g) setApplied(out)
    } finally {
      setApplying(false)
    }
  }

  const ready = sourcePath !== '' && refPath !== '' && !running && !tx

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Box>
        <BoxTitle>Align subtitle timing</BoxTitle>
        <div className="grid grid-cols-1 gap-4 text-sm text-gray-600 sm:grid-cols-2 dark:text-gray-300">
          <div>
            <div className="mb-1 font-semibold text-gray-900 dark:text-gray-100">What it does</div>
            <p>
              Fixes a subtitle that runs early, late or drifts, using a reference with the right timing: another subtitle of
              the same release, or the video file itself. It finds one global map — a shift, and a speed change such as
              23.976 → 25 fps — and only offers it when the evidence supports it. For a different cut of the film,
              Advanced below can align it in sections instead.
            </p>
          </div>
          <div>
            <div className="mb-1 font-semibold text-gray-900 dark:text-gray-100">What it changes</div>
            <p>
              Only the times. Every cue keeps its number, its text, its encoding and its line endings. Nothing is written
              until you choose where to save the aligned copy, and the original file is never changed.
            </p>
          </div>
        </div>
      </Box>

      <Box>
        <BoxTitle>Input</BoxTitle>
        <div className="space-y-4">
          <div>
            <Label tip="The .srt file whose timing is wrong. It is read once and never modified.">Subtitle to align</Label>
            <FilePicker
              value={sourcePath}
              placeholder="Choose the .srt file to fix"
              onPick={async () => {
                const p = await window.api.openFile(SUBTITLE_FILTERS)
                if (p) {
                  invalidate()
                  setSourcePath(p)
                }
              }}
              onClear={() => {
                invalidate()
                setSourcePath('')
              }}
            />
          </div>
          <div>
            <Label
              tip={
                'What has the right timing.\n\nAnother subtitle: an .srt of the same film that is already in sync, in any language.\n\n' +
                'Video file: each of its text subtitle tracks is tried in order. Image tracks (PGS, VobSub) are pictures and are never used as text.'
              }
            >
              Reference
            </Label>
            <div className="flex gap-2">
              <Select
                value={refKind}
                onChange={(v) => {
                  invalidate()
                  setRefKind(v as 'subtitle' | 'media')
                  setRefPath('')
                }}
                options={[
                  { value: 'subtitle', label: 'Another subtitle (.srt)' },
                  { value: 'media', label: 'The video file' }
                ]}
                className="w-56"
                disabled={!!running}
              />
              <div className="flex-1">
                <FilePicker
                  value={refPath}
                  placeholder={refKind === 'subtitle' ? 'Choose a subtitle that is in sync' : 'Choose the video file'}
                  onPick={async () => {
                    const p = await window.api.openFile(refKind === 'subtitle' ? SUBTITLE_FILTERS : MEDIA_FILTERS)
                    if (p) {
                      invalidate()
                      setRefPath(p)
                    }
                  }}
                  onClear={() => {
                    invalidate()
                    setRefPath('')
                  }}
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => void analyze()} disabled={!ready}>
              Analyze
            </Button>
            {running && (
              <Button variant="secondary" onClick={cancel}>
                Cancel
              </Button>
            )}
          </div>
          {running && <Working label={step.label || 'Working…'} pct={step.pct} since={running.since} />}
        </div>
      </Box>

      {tx && (
        <Box>
          <BoxTitle>Transcribing for timing anchors</BoxTitle>
          <div className="space-y-3">
            <Working
              label={runner.state.statusText || 'Transcribing…'}
              pct={runner.state.progress > 0 ? Math.round(runner.state.progress) : null}
              since={tx.since}
              note={`Expected ${tx.offer.estimateMinutes[0]}–${tx.offer.estimateMinutes[1]} minutes. Align runs again by itself when it finishes.`}
            />
            <Button variant="secondary" onClick={() => void runner.stop()}>
              Stop transcription
            </Button>
          </div>
        </Box>
      )}

      {analysis?.status === 'result' && (
        <AlignResultCard
          result={analysis}
          rows={rows}
          applying={applying}
          saved={applied?.ok === true}
          onApply={() => void apply()}
          onMore={() => void more()}
        />
      )}
      {analysis?.status === 'refused' && <AlignRefusalCard refusal={analysis} advanced={advanced} disabled={!ready} onTryPiecewise={analyzePiecewise} />}
      {(analysis?.status === 'result' || analysis?.status === 'refused') && analysis.cleanupNotice && <CleanupNotice text={analysis.cleanupNotice} />}
      {analysis?.status === 'refused' && analysis.transcriptionOffer && !tx && (
        <TranscriptionOfferCard
          offer={analysis.transcriptionOffer}
          onConfirm={() => void confirmTranscription()}
          onDecline={declineTranscription}
          disabled={!!running}
          starting={starting}
        />
      )}
      {offerNote && <p className="text-sm text-gray-600 dark:text-gray-400">{offerNote}</p>}
      {applied && applyOutcomeText(applied) && (
        <div
          className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${
            applied.ok
              ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-300'
              : 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300'
          }`}
        >
          <span className="flex-1 break-all">{applyOutcomeText(applied)}</span>
          {applied.ok && (
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => void window.api.showItemInFolder(applied.path)}>
              Show in folder
            </Button>
          )}
        </div>
      )}

      <AdvancedPanel status={advanced} ready={ready} media={refKind === 'media'} onRun={analyzePiecewise} />

      <DiagnosticActions
        exportable={(analysis?.status === 'result' || analysis?.status === 'refused') && analysis.diagnosticExportable === true && !running}
        busy={diagBusy}
        onExport={() => void exportDiagnostic()}
        onOpen={() => void openDiagnostic()}
      />
      {diagNote && <p className="text-sm text-gray-600 dark:text-gray-400">{diagNote}</p>}
      {replay && <DiagnosticReplayCard replay={replay} onClose={() => setReplay(null)} />}
    </div>
  )
}
