import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getSettings, mutateQuotaGroup, setSettings, setSettingsFromRenderer, settingsRevisions } from './store'
import { activeQuotaGroups, admitOneShot, type OneShotAdmission, type OneShotOutcome } from '../engine/run'
import { createRequestBudget } from '../engine/requestBudget'
import type { QuotaGroupMutation } from '../shared/quotaGroups'
import { probeTracks, extractTrack, validateFfmpegPath, spreadSample } from './ffmpeg'
import { tmdbSearch, tmdbCast } from './tmdb'
import { checkOpenSubtitles, downloadOpenSubtitles, fetchWizdomView, openSubtitlesClient, openSubtitlesSecrets, searchOpenSubtitles, searchWizdomView } from './osService'
import { acceptedReferenceOf, type AcceptedReference } from './referenceWalk'
import type { OsSearchQuery } from './opensubtitles'
import {
  refreshModels,
  buildModelList,
  checkApiKeys,
  guardModelForSpawn,
  resolveDefaultModel,
  resolveDefaultModelWithBasis,
  summarizeRefresh,
  withModelLimits,
  type ModelAvailability
} from './modelsList'
import { tempOutputPath } from './tempFiles'
import { keySlotsFor, noUsableApiKeyMessage, type KeyPreflight } from './keyPreflight'
import { copyExclusive, writeExclusive } from './exclusiveFile'
import { ACTIVE_SET_SIZE, activeKeySlots, orderKeySlots } from '../shared/keyOrder'
import { modelRequestConfig, shouldPersistSamplingToggleOff } from '../shared/modelCaps'
import { dedicatedTranscribeArgs, isDedicatedTranscribeModel } from '../shared/transcribeSettings'
import { detectSourceLanguage } from '../engine/sourceLanguage'
import { createGeminiProvider } from '../engine/providers/gemini'
import type { GenerationProvider, ProviderReply } from '../engine/providers/types'
import { CONSOLE_LOG_SUFFIX, RUN_RECORD_SUFFIX } from '../shared/consoleLog'
import { PARTIAL_SUFFIX, fileBaseline, unchangedSince, writeDerivative, type OutputIo } from '../engine/output'
import { rtlCopy, type RtlChoice } from '../engine/rtl'
import { mapCueText, parseCues, stripCueEdgeControls } from '../engine/srt'
import { repairWrongAlphabet } from '../engine/wrongAlphabet'
import { sanitizeRtlMethod } from './migrations'
import { scanTranslatedOutput, toRunWarning, type SanityWarning } from '../shared/outputSanity'
import type { RunEvent } from '../shared/engineEvents'
import { createNativeEngineAdapter } from '../engine/native/nativeAdapter'
import { configureRunnerRuntime, isRunning, startRun, stopCurrent } from '../engine/runner'
import type { RunArtifactPreferences } from '../engine/runArtifacts'
import { decodeSubtitleBuffer, inspectSubtitleFile, LEGACY_ENCODINGS, type LegacyEncoding } from '../engine/subtitleInput'
import { normalizeRtlLanguage, subtitleLanguageHint } from '../shared/languages'
import { createAlignService } from './alignService'
import type {
  AlignProgress,
  TranslateArgs,
  TranscribeArgs,
  AppSettings,
  FfmpegProgress,
  FfmpegTaskKind,
  ModelInfo,
  RefreshOutcome,
  SaveResult,
  SlotFetchResult,
  ResumeInspectResult,
  SubtitleInspectRequest,
  SubtitleInspectResult,
  SourceLanguageDetectRequest,
  SourceLanguageDetectResult,
  OsCheckResult,
  OsSearchResult,
  SubtitleFetchResult,
  WizdomSearchResult
} from '../shared/types'
import { parseInspectRequest, resumeStore } from './resumeStore'
import { quotaBudgetStoreAt } from './quotaBudgetStore'

/** Cutting six samples and one short call; past this the modal opens empty rather than keep the user waiting. */
const DETECT_LANGUAGE_LIMIT_MS = 120_000

let win: BrowserWindow | null = null
export function setMainWindow(w: BrowserWindow): void {
  win = w
  // Dropped as soon as it goes, because from SOL-04 onwards the main process deliberately OUTLIVES
  // it: `before-quit` holds the app open while the engine is terminated, and every engine line,
  // progress tick and terminal event produced during that window used to be pushed at a destroyed
  // object. That throws in the main process, and it would throw part-way through the very shutdown
  // sequence that was added to stop orphaning the engine (SOL-11).
  w.on('closed', () => {
    if (win === w) win = null
  })
}

/**
 * Push an event to the renderer, if there is still a renderer.
 *
 * Both halves are checked. `win.isDestroyed()` is not enough on its own: the WebContents can be
 * gone while the BrowserWindow object is still reachable, and it is `webContents.send` that throws.
 * Dropping an event here is always the right answer — there is nothing left to display it, and the
 * shutdown path's real work is terminating the child, deleting scratch files and closing the
 * console, none of which needs a window.
 */
function send(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send(channel, payload)
  } catch {
    // A renderer that went away between the check and the send. Nothing to deliver to, and this
    // sits on the path that ends a run — throwing here would strand the job it is ending.
  }
}

/**
 * Read a finished subtitle and compare it against its source (REP-16).
 *
 * Guarded to the point of paranoia on purpose: this runs on the path that delivers the terminal
 * event, so anything it threw would strand a finished job with no `done` at all — a worse failure
 * than the corruption it looks for. A missing, empty, unreadable or unparseable file simply
 * produces no warnings. It is the only *read* this path performs, and the files were written
 * moments earlier, so they are small and warm.
 *
 * `sourceText`, when given, is the verified intake text the engine read (native, Bundle A) and is used
 * instead of reading `sourcePath`, which then only names it.
 */
export function scanOutputWarnings(sourcePath: string, outputPath: string, sourceText?: string): SanityWarning[] {
  try {
    if (!outputPath || (sourceText === undefined && !sourcePath)) return []
    if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) return []
    if (sourceText === undefined && (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile())) return []
    const source = sourceText ?? fs.readFileSync(sourcePath, 'utf-8')
    const output = fs.readFileSync(outputPath, 'utf-8')
    return scanTranslatedOutput(source, output)
  } catch {
    return []
  }
}

/**
 * `subtitle:inspect`: read the chosen subtitle once and say what it is (Bundle A, D14.1). The receipt it
 * returns goes back in `TranslateArgs.sourceReceipt`, so Start can prove it is translating these bytes.
 * The hint is the track's tag or the filename's; it only ever breaks a tie.
 *
 * A file Start's cue reader would refuse (ASS/SSA, WebVTT, no timings, text with no cue) is refused here
 * with the same sentence, so the page says so when the file is picked instead of asking for its language.
 */
export function inspectSubtitleRequest(req: SubtitleInspectRequest): SubtitleInspectResult {
  if (!req || typeof req.path !== 'string' || req.path === '') {
    return { ok: false, code: 'read-failed', error: 'No subtitle file was given.' }
  }
  const hint = subtitleLanguageHint(req.path, typeof req.trackLanguage === 'string' ? req.trackLanguage : undefined)
  const language = typeof req.language === 'string' && req.language !== '' && req.language !== 'auto' ? req.language : undefined
  const encoding = language && typeof req.encoding === 'string' && (LEGACY_ENCODINGS as readonly string[]).includes(req.encoding) ? (req.encoding as LegacyEncoding) : undefined
  const inspected = inspectSubtitleFile(req.path, { ...(hint ? { hint } : {}), ...(language ? { language } : {}), ...(encoding ? { encoding } : {}) })
  if (!inspected.ok) return inspected
  const { receipt } = inspected.inspection
  let cues: ReturnType<typeof parseCues>
  try {
    cues = parseCues(decodeSubtitleBuffer(fs.readFileSync(receipt.path), receipt.encoding), { path: receipt.path })
  } catch (e) {
    return { ok: false, code: 'read-failed', error: `The subtitle file could not be read: ${(e as Error).message}` }
  }
  return cues.ok ? inspected : { ok: false, code: 'not-srt', error: cues.message }
}

export function scanOutputFiles(sourcePath: string, outputPath: string): string[] {
  return scanOutputWarnings(sourcePath, outputPath).map((w) => w.message)
}

/** Finished translations whose target Save may still need; the oldest is forgotten first. */
const RUN_TARGET_LIMIT = 32
const runTargets = new Map<string, string>()

/** Bundle D: the accepted run's target, kept by the file its `finished` event named. */
export function rememberRunTarget(file: string, targetLang: string): void {
  if (!file) return
  const key = path.resolve(file)
  runTargets.delete(key)
  runTargets.set(key, targetLang)
  while (runTargets.size > RUN_TARGET_LIMIT) runTargets.delete(runTargets.keys().next().value as string)
}

/** The target of the run that produced `file`; null when no accepted run in this session named it. */
export function runTargetFor(file: string): string | null {
  return file ? runTargets.get(path.resolve(file)) ?? null : null
}

/**
 * `deliver` for one Translate run, remembering its target from the terminal event. Never throws on the
 * path that delivers that event: remembering is skipped rather than the event lost.
 */
export function deliverRememberingTarget(deliver: (event: RunEvent) => void, targetLang: string): (event: RunEvent) => void {
  return (event) => {
    if (event.type === 'finished') {
      try {
        rememberRunTarget(event.outputPath, targetLang)
        if (event.partialPath) rememberRunTarget(event.partialPath, targetLang)
      } catch {
        /* Save then falls back to the unknown-language context */
      }
    }
    deliver(event)
  }
}

export interface SubtitleSaveRecipe {
  rtl: RtlChoice
  /** The accepted run's target is Hebrew: the copy also gets the wrong-alphabet repair (§13.3a). */
  hebrewTarget: boolean
}

/** Save's recipe from Settings and the accepted run's target; an unknown target is the content-only fallback. */
export function saveRecipeFor(settings: Pick<AppSettings, 'rtlEnabled' | 'rtlMethod'>, targetLang: string | null): SubtitleSaveRecipe {
  const language = normalizeRtlLanguage(targetLang)
  return {
    rtl: { enabled: settings.rtlEnabled !== false, method: sanitizeRtlMethod(settings.rtlMethod), language },
    hebrewTarget: language === 'he'
  }
}

export interface WrongAlphabetCounts {
  arabicLines: number
  foreignLines: number
}

/**
 * The wrong-alphabet repair over each cue's text, gst's edge wrapper removed first, so the RTL method
 * that follows sees the repaired canonical cue. A cue whose repair would change its line count is kept.
 * Null when the text cannot be read cue by cue (the RTL copy then refuses it).
 */
export function repairCueTexts(text: string): { text: string; counts: WrongAlphabetCounts } | null {
  const counts: WrongAlphabetCounts = { arabicLines: 0, foreignLines: 0 }
  const out = mapCueText(text, (cue) => {
    const canonical = stripCueEdgeControls(cue)
    const repaired = repairWrongAlphabet(canonical)
    if (repaired.text.split('\n').length !== canonical.split('\n').length) return canonical
    counts.arabicLines += repaired.arabicLines
    counts.foreignLines += repaired.foreignLines
    return repaired.text
  })
  return out === null ? null : { text: out, counts }
}

/** The line Save adds to the saved console log when the repair changed anything; null otherwise. */
export function wrongAlphabetLogLine(counts: WrongAlphabetCounts): string | null {
  if (!counts.arabicLines && !counts.foreignLines) return null
  const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`
  return (
    `Wrong-alphabet repair (Hebrew target): in the saved copy, fixed ${lines(counts.arabicLines)} with Arabic letters ` +
    `and ${lines(counts.foreignLines)} with Cyrillic, Greek or Armenian letters inside Hebrew words.`
  )
}

/** The run's console log with `note` as its last line; null when it is not UTF-8 text, which is then copied as is. */
export function withLogNote(logPath: string, note: string): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(logPath))
  } catch {
    return null
  }
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${note}\n`
}

/**
 * True when `b` is the file `a` is: the same volume and file id, so a different case, a short name or
 * a hard link all count. Without a file id, the resolved paths, case-insensitively on Windows.
 */
export function sameFileOnDisk(a: string, b: string): boolean {
  let sa: fs.BigIntStats
  let sb: fs.BigIntStats
  try {
    sa = fs.statSync(a, { bigint: true })
    sb = fs.statSync(b, { bigint: true })
  } catch {
    return false
  }
  if (sa.ino !== 0n && sb.ino !== 0n) return sa.dev === sb.dev && sa.ino === sb.ino
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p)
    } catch {
      return path.resolve(p)
    }
  }
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  return fold(real(a)) === fold(real(b))
}

export type SubtitleSave = { ok: true; repair: WrongAlphabetCounts } | { ok: false; error: string }

const NO_REPAIR: WrongAlphabetCounts = { arabicLines: 0, foreignLines: 0 }

/**
 * Put the finished subtitle at `destPath`, which the save dialog obtained consent for.
 *
 * Without a recipe, or for a temp that is not `.srt` (a translated `.ass` saves byte for byte, tester
 * decision 2026-10-10), this is the plain copy Save has always made. Otherwise the temp — the canonical
 * text, never changed here — is read whole, repaired for a Hebrew target, given its RTL copy, and
 * written through the derivative writer: `destPath` ends old-or-new, never half-written, and is never
 * copied over (D12-15). A `destPath` that is the temp itself is refused, and one that changes while the
 * replace waits is left as it now is.
 */
export async function saveSubtitleCopy(srcPath: string, destPath: string, recipe: SubtitleSaveRecipe | null, io?: Partial<OutputIo>): Promise<SubtitleSave> {
  if (!fs.existsSync(srcPath)) return { ok: false, error: 'The translated subtitle is no longer available to save.' }
  if (!recipe || path.extname(srcPath).toLowerCase() !== '.srt') {
    let destExisted = false
    try {
      destExisted = fs.existsSync(destPath)
    } catch {
      destExisted = false
    }
    try {
      fs.copyFileSync(srcPath, destPath)
      return { ok: true, repair: NO_REPAIR }
    } catch (e) {
      if (!destExisted) {
        try {
          fs.unlinkSync(destPath)
        } catch {
          /* partial dest we created */
        }
      }
      const detail = e instanceof Error ? e.message : String(e)
      return { ok: false, error: `Could not save the subtitle: ${detail}` }
    }
  }
  if (sameFileOnDisk(srcPath, destPath)) {
    return { ok: false, error: `Could not save the subtitle: "${path.basename(destPath)}" is the app's own copy of this translation. Choose another name or folder.` }
  }
  const baseline = fileBaseline(destPath)
  if (baseline === null || (baseline.exists && baseline.sha256 === null)) {
    return { ok: false, error: `Could not save the subtitle: "${path.basename(destPath)}" could not be read to check it before replacing it. If it is open in another program, close it there and save again.` }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(srcPath))
  } catch (e) {
    const detail = e instanceof TypeError ? 'it is not UTF-8 text' : e instanceof Error ? e.message : String(e)
    return { ok: false, error: `Could not save the subtitle: ${detail}` }
  }
  let repair = NO_REPAIR
  if (recipe.hebrewTarget) {
    const repaired = repairCueTexts(text)
    if (repaired) {
      text = repaired.text
      repair = repaired.counts
    }
  }
  const copy = rtlCopy(text, recipe.rtl)
  if (!copy.ok) return { ok: false, error: `Could not save the subtitle: ${copy.message}` }
  const written = await writeDerivative(destPath, copy.text, { ...(io ? { io } : {}), verify: unchangedSince(destPath, baseline) })
  if (!written.ok) {
    const inUse = written.stage === 'replace' && (written.code === 'EPERM' || written.code === 'EBUSY' || written.code === 'EACCES')
    const kept = written.retainedScratch ? ` A temporary copy is left as "${path.basename(written.retainedScratch)}".` : ''
    return {
      ok: false,
      error: inUse
        ? `Could not save the subtitle: "${path.basename(destPath)}" is open in another program. Close it there and save again.${kept}`
        : `Could not save the subtitle: ${written.message}${kept}`
    }
  }
  return { ok: true, repair }
}

/** Every `engine:event` leaves through here, so a later step has one place to retire or redirect. */
function sendEngineEvent(event: RunEvent): void {
  send('engine:event', event)
}

let unaddressedRuns = 0

/** The run's id. The run context and its epoch belong to `engine/runner.ts` (§2.2a). */
function runIdFor(runId: string | undefined): string {
  return runId ?? `main-unaddressed-${++unaddressedRuns}`
}

/** Every configured secret at Start — what the run's artifacts are swept for (§10.4). */
function runSecrets(runKeys: readonly string[]): string[] {
  const s = getSettings()
  return [...runKeys, ...s.apiKeys, s.tmdbApiKey, ...openSubtitlesSecrets(s)]
}

function runPreferences(): RunArtifactPreferences {
  const s = getSettings()
  return {
    showTokenStats: s.showTokenStats,
    writeTokenReport: s.writeTokenReport,
    progressLog: s.progressLog,
    thoughtsLog: s.thoughtsLog
  }
}

/**
 * Point a token report at the files the user can actually see (REP-1).
 *
 * The engine records the paths it was handed, which are ours: a temp `.srt` for the output and,
 * when the input needed re-encoding, a temp `.utf8.srt` for the input. Both are gone by the time
 * the user opens the report sitting next to their saved subtitle.
 *
 * Pure, and total. A report we cannot parse is returned untouched, which reproduces exactly what
 * the old copy did — the file is the engine's evidence, and mangling it would be worse than leaving
 * a stale path in it. `inputPath` is optional for the same reason: when the caller does not know
 * the user's source, the original value stays rather than being replaced by a guess.
 */
export function retargetTokenReport(json: string, inputPath: string, outputPath: string): string {
  try {
    const report = JSON.parse(json) as Record<string, unknown>
    if (report === null || typeof report !== 'object' || Array.isArray(report)) return json
    if (outputPath) report.output_file = outputPath
    if (inputPath) report.input_file = inputPath
    // Two-space indent matches what the engine writes, so a user diffing the two sees only paths.
    return JSON.stringify(report, null, 2)
  } catch {
    return json
  }
}

/**
 * Every compound suffix a run can leave beside its subtitle.
 *
 * Compound, and matched as a whole, because `path.extname()` sees only the last dot: it turns
 * `.tokens.json` into `.json` and reduces all three `.log` sidecars to the same `.log`, so the
 * last one copied would silently overwrite the others. The list is therefore exhaustive by
 * obligation — anything that starts writing a new sidecar has to appear here in the same change.
 */
export const KNOWN_SIDECAR_SUFFIXES = [
  '.tokens.json',
  '.progress.log',
  '.thoughts.log',
  CONSOLE_LOG_SUFFIX,
  RUN_RECORD_SUFFIX,
  PARTIAL_SUFFIX
]

/**
 * A partial displaced around an earlier run's (implementation_plan.md §4.1a rule 5) carries its
 * counter inside the compound name — `episode.partial.2.srt` — so no suffix in the list above ends
 * it, and `path.extname()` would flatten it to `.srt`, the subtitle's own extension.
 */
const DISPLACED_PARTIAL = /\.partial\.[0-9a-z]+\.srt$/i

function compoundSuffix(file: string): string {
  return (
    KNOWN_SIDECAR_SUFFIXES.find((s) => file.endsWith(s)) ??
    (DISPLACED_PARTIAL.test(file) ? PARTIAL_SUFFIX : path.extname(file))
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Where a sidecar lands when its subtitle is saved to `savedPath`.
 *
 * Split out of the save handler so it can be proven rather than argued about: the property that
 * matters is that the whole set maps to distinct names, and that is a statement about this
 * function, not about a dialog.
 *
 * An unrecognised path keeps `path.extname()`'s answer, which is what the handler has always
 * done. That is a deliberately imperfect fallback — it exists so an unforeseen sidecar is still
 * delivered rather than dropped — and it is exactly why the list above must stay complete.
 */
export function sidecarDestination(logPath: string, savedPath: string): string {
  return `${savedPath.replace(/\.[^.]+$/, '')}${compoundSuffix(logPath)}`
}

/**
 * Canonical sidecar paths that exist beside `savedPath` and were not written by this save.
 *
 * They keep looking like reports about the subtitle the user just saved, which is SOL-15's
 * leftover class — including types this run never generated. Scanning after the write, rather
 * than hoping a rename succeeded, is what makes the warning honest (SOL-15, round 5). The
 * save handler does not move these files; it reports them.
 *
 * A retained transcription partial is leftover work of the same kind, displaced ones included
 * (§4.1a rule 5): offered to the user, never deleted on their behalf.
 */
export function leftoverCanonicals(savedPath: string, written: readonly string[]): string[] {
  const stem = savedPath.replace(/\.[^.]+$/, '')
  const writtenAbs = new Set(written.map((p) => path.resolve(p)))
  const leftover: string[] = []
  for (const suffix of KNOWN_SIDECAR_SUFFIXES) {
    const canonical = `${stem}${suffix}`
    try {
      if (!fs.existsSync(canonical)) continue
    } catch {
      continue
    }
    if (writtenAbs.has(path.resolve(canonical))) continue
    leftover.push(canonical)
  }
  const displaced = new RegExp(`^${escapeRegExp(path.basename(stem))}\\.partial\\.[0-9a-z]+\\.srt$`, 'i')
  let siblings: string[] = []
  try {
    siblings = fs.readdirSync(path.dirname(savedPath))
  } catch {
    siblings = []
  }
  for (const name of siblings.filter((n) => displaced.test(n)).sort()) {
    const file = path.join(path.dirname(savedPath), name)
    if (!writtenAbs.has(path.resolve(file))) leftover.push(file)
  }
  return leftover
}

const EMPTY_SAVE: SaveResult = {
  path: '',
  consolePath: '',
  sidecars: [],
  displaced: [],
  stale: []
}

export interface SingleKeyRefreshScope {
  /** One entry per configured slot, so completeness is judged over the real key set. */
  slots: SlotFetchResult[]
  activeSlots: number[]
  /** False when the supplied key is not one of the configured slots — display only. */
  authoritative: boolean
}

/**
 * Describe a one-key refresh in terms of the user's CONFIGURED slots.
 *
 * The subtlety is the unknown-key case. Building a lone `slot 0` descriptor for a key the
 * user has not saved makes the summary read `allComplete`, which is the strongest evidence
 * bar in the system — the one that authorises deleting a model selection. Nothing about
 * asking a stranger's key justifies that, so the scope is marked non-authoritative and the
 * caller must not persist or apply anything from it.
 */
export function singleKeyRefreshScope(
  configured: string[],
  apiKey: string,
  ids: string[]
): SingleKeyRefreshScope {
  const slotIndex = configured.findIndex((k) => (k ?? '').trim() === apiKey.trim())
  if (slotIndex === -1) {
    return { slots: [{ slot: 0, queried: true, ok: true, ids }], activeSlots: [0], authoritative: false }
  }
  // Every OTHER configured key is recorded as queried-but-unanswered, because that is the
  // truth: this handler asked exactly one key. Claiming `allComplete` from a single answer
  // while other keys are configured would let one key's list authorise a destructive reset
  // of a model the untested keys can still see.
  return {
    slots: configured.map((k, i) => ({
      slot: i,
      queried: !!(k ?? '').trim(),
      ok: i === slotIndex,
      ids: i === slotIndex ? ids : []
    })),
    activeSlots: activeKeySlots(keySlotsFor(configured)),
    authoritative: true
  }
}

/**
 * HTTPS only. `shell.openExternal` and `setWindowOpenHandler` used to forward any scheme;
 * a compromised renderer or a future caller with untrusted content could launch `file:` or
 * a registered custom protocol (SOL-24). Parse failures and anything else are refusals.
 */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Open an approved HTTPS URL.
 *
 * Non-HTTPS is a refusal, not a launch, and resolves without opening. A valid HTTPS URL
 * that the OS cannot open rejects, so `shell:openExternal` can surface it (SOL-24).
 * `setWindowOpenHandler` has no caller to tell — it must catch.
 */
export function openApprovedExternal(url: string): Promise<void> {
  if (!isHttpsUrl(url)) return Promise.resolve()
  return shell.openExternal(url)
}

/**
 * Do these results still describe the keys the user has?
 *
 * A full check is a sequence of network round trips — up to a minute per key against the
 * fetch timeout — and everything it produces is addressed **by slot index**: the verdicts,
 * the error strings, and `ModelInfo.availableOn`, which `guardModelForSpawn` reads as proof
 * that a model exists. Nothing in that payload carries the key it came from, so if a slot's
 * key changed while the fetch was in flight, applying the result writes one key's evidence
 * onto a different key: a brand-new key inherits a ✓ or a ✗ it never earned, and the
 * pre-spawn guard starts vouching for models on a credential that never reported them.
 * `SettingsPage` clears exactly this evidence when a key is edited, and the late write
 * silently puts it back.
 *
 * Tiers are deliberately not compared. They are not part of what a check learns, this
 * handler does not persist them, and `orderKeySlots` does not rank by them — so including
 * them would discard good results for a change that could not have invalidated them.
 *
 * The counterpart in `models:refresh` needs no equivalent because it identifies its slot by
 * key MATERIAL rather than by position (`singleKeyRefreshScope`): an edited key simply stops
 * matching and the scope becomes non-authoritative.
 */
export function keySnapshotChanged(requested: readonly string[], current: readonly string[]): boolean {
  if (requested.length !== current.length) return true
  return requested.some((k, i) => (k ?? '') !== (current[i] ?? ''))
}

export interface ModelSelectionOutcome {
  /** The model the app should now have selected (unchanged unless a rule fired). */
  model: string
  /** Non-empty when the user must be told something about that selection. */
  notice: string
  /** True when a rule changed the stored selection. */
  changed: boolean
}

/**
 * The three — and ONLY three — situations in which a refresh may touch the stored model.
 * Everything else leaves the user's choice alone; a refresh otherwise only ADDS models.
 *
 * Each case is gated on a different refresh outcome because each carries a different
 * consequence. Reads as a single function so the evidence bar for the one destructive
 * case can be checked in one place rather than inferred from scattered conditions.
 */
export function applyModelSelectionRules(
  stored: string,
  prevCached: ModelInfo[],
  next: { models: ModelInfo[]; unionIds: string[]; runnableIds: string[]; outcome: RefreshOutcome }
): ModelSelectionOutcome {
  const runnable = next.models.filter((m) => next.runnableIds.includes(m.id))
  const newDefault = resolveDefaultModel(runnable)
  const verified = next.outcome === 'allComplete' || next.outcome === 'activeComplete'

  // 1. Nothing to protect.
  if (!stored) {
    return newDefault
      ? { model: newDefault, notice: '', changed: true }
      : { model: stored, notice: '', changed: false }
  }

  // 2. PROVEN absent — the only destructive case, so the bar is the strictest one:
  // every configured slot answered, and the id is in none of their lists. A non-empty
  // union is required because an "allComplete" refresh that returned nothing is a bug,
  // not evidence that every model was withdrawn.
  const provenAbsent =
    next.outcome === 'allComplete' &&
    next.unionIds.length > 0 &&
    !next.unionIds.includes(stored)
  if (provenAbsent && newDefault) {
    return {
      model: newDefault,
      notice: `"${stored}" is no longer offered by your API key(s); switched to the newest available model.`,
      changed: true
    }
  }

  // 3. Auto-advance. Gated on activeComplete, NOT allComplete: an unused reserve key going
  // stale is an expected steady state, and letting it veto this would permanently freeze
  // everyone on an old model.
  //
  // The `basis` check is what keeps this from eating a deliberate override: if the
  // previous list contained no flash-lite or flash at all, its "default" was just the
  // newest of whatever was there, and matching against it would prove nothing about
  // whether the user had chosen that model on purpose.
  const prevRunnable = prevCached.filter((m) => m.source === 'live')
  const prev = resolveDefaultModelWithBasis(prevRunnable.length ? prevRunnable : prevCached)
  const prevWasRealDefault = prev.basis === 'flash-lite' || prev.basis === 'flash'
  if (verified && newDefault && prevWasRealDefault && stored === prev.id && newDefault !== stored) {
    return {
      model: newDefault,
      notice: `A newer model is available — switched to ${newDefault}.`,
      changed: true
    }
  }

  // Present somewhere, but not on every key this run may use. The model demonstrably
  // exists, so this is a warning, never a reset.
  if (verified && next.unionIds.includes(stored) && !next.runnableIds.includes(stored)) {
    return {
      model: stored,
      notice: `"${stored}" is not available on every API key this run may use. If the engine switches keys mid-run, it may fail.`,
      changed: false
    }
  }

  if (next.outcome === 'partial' || next.outcome === 'failed') {
    return {
      model: stored,
      notice: 'Some API keys could not be checked — showing the last known model list.',
      changed: false
    }
  }

  return { model: stored, notice: '', changed: false }
}

/**
 * Settings fields that ride with an automatic model change from refresh / key-check.
 *
 * Same rejecting → accepting persist-off as the Settings Select path, in the same
 * `setSettings` patch that writes `model`. Temperature / top-p stay untouched so
 * typed values survive (SOL-70). Shared intent stays stored while the selected
 * model remains rejecting (SOL-69).
 */
export function selectionSettingsPatch(
  current: Pick<AppSettings, 'model' | 'customGenerationParams'>,
  sel: { changed: boolean; model: string }
): Partial<AppSettings> {
  if (!sel.changed) return {}
  const patch: Partial<AppSettings> = { model: sel.model }
  if (shouldPersistSamplingToggleOff(current.model, sel.model, current.customGenerationParams)) {
    patch.customGenerationParams = false
  }
  return patch
}

/**
 * Align's one owner. Apply's Save dialog is the result's one explicit confirmation; it is the only
 * way a destination is chosen, and it offers SubRip only.
 */
export const alignService = createAlignService({
  saveDialog: async (defaultPath) => {
    if (!win) return null
    const res = await dialog.showSaveDialog(win, {
      title: 'Save aligned subtitle',
      defaultPath,
      filters: [{ name: 'SubRip subtitle', extensions: ['srt'] }]
    })
    return res.canceled || !res.filePath ? null : res.filePath
  },
  // Bundle M: a timing diagnostic is chosen and saved through main's own dialogs, JSON only.
  diagnosticSaveDialog: async (defaultPath) => {
    if (!win) return null
    const res = await dialog.showSaveDialog(win, {
      title: 'Export timing diagnostic',
      defaultPath,
      filters: [{ name: 'Timing diagnostic', extensions: ['json'] }]
    })
    return res.canceled || !res.filePath ? null : res.filePath
  },
  diagnosticOpenDialog: async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Open timing diagnostic',
      properties: ['openFile'],
      filters: [{ name: 'Timing diagnostic', extensions: ['json'] }]
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  },
  progress: (p: AlignProgress) => send('align:progress', p)
})

export function registerIpc(): void {
  // Before any window exists (AR3-8): finished or discarded resume work older than a week, and
  // damaged generations moved aside. Paused work is never removed for its age.
  try {
    const cleaned = resumeStore().cleanup()
    if (cleaned.removed || cleaned.quarantined) console.log(`[resume] removed ${cleaned.removed}, quarantined ${cleaned.quarantined}`)
  } catch {
    /* best effort: a store that cannot be read is judged again at the next start */
  }
  // Once, before any run handler exists: every run's waits wake on this one Settings revision source.
  configureRunnerRuntime({ settingsRevisions })

  // ---- Settings ----
  ipcMain.handle('settings:get', () => getSettings())
  // A window may not replace the group/evidence arrays; those change only through the typed mutation.
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => setSettingsFromRenderer(patch))
  ipcMain.handle('settings:mutateQuotaGroup', (_e, mutation: QuotaGroupMutation) => mutateQuotaGroup(mutation, activeQuotaGroups.activeIds()))

  // ---- Models ----
  ipcMain.handle('models:getCached', () => {
    // Re-curate cached ids through the current rules so older caches get the corrected
    // friendly names / filtering without forcing a re-fetch. Provenance is fed back in so
    // re-curation never upgrades a seed entry into a "live" one, nor forgets which key
    // slots reported a live one. Read through getSettings() so a malformed persisted
    // cache cannot throw on `.map` (SOL-29). updatedAt comes from the same view so a
    // missing Conf key is `null`, matching preload's `string | null` (SOL-36).
    const s = getSettings()
    const cached = s.cachedModels
    const availability: ModelAvailability = {}
    for (const m of cached) {
      if (m?.source === 'live' && Array.isArray(m.availableOn) && m.availableOn.length) {
        availability[m.id] = m.availableOn
      }
    }
    const models = buildModelList(cached.map((m) => m.id), availability, cached)
    return { models, updatedAt: s.modelsUpdatedAt ?? null }
  })

  // Single-key refresh (kept for callers that only have one key at hand). The list is
  // curated from that one key's ids, so everything it reports is available on that slot
  // and the runnable set is simply that list.
  ipcMain.handle('models:refresh', async (_e, apiKey: string) => {
    const { ids, keyValid, error, limits } = await refreshModels(apiKey)
    const updatedAt = new Date().toISOString()
    if (!keyValid) return { models: [], updatedAt, keyValid, error, notice: '' }

    const s = getSettings()
    const prevCached = (s.cachedModels as ModelInfo[]) ?? []
    const configured = s.apiKeys ?? []
    const scope = singleKeyRefreshScope(configured, apiKey, ids)
    const refreshed = summarizeRefresh(scope.slots, scope.activeSlots)
    // The official limits this key reported ride along, as on the all-keys check (§12.6).
    const summary = { ...refreshed, models: withModelLimits(refreshed.models, [limits ?? {}], prevCached, updatedAt).models }

    // A key that is not one of the configured slots speaks for nobody: none of the user's
    // own keys were asked, so this list is display material only. Persisting it — or
    // letting it run the selection rules — would let an arbitrary caller-supplied key
    // authorise a "proven absent" reset of a model every configured key can still see.
    if (!scope.authoritative) {
      return { models: summary.models, updatedAt, keyValid, error, notice: '' }
    }

    const sel = applyModelSelectionRules(s.model, prevCached, {
      models: summary.models,
      unionIds: summary.unionIds,
      runnableIds: summary.runnableIds,
      outcome: summary.refreshOutcome
    })
    const verified =
      summary.refreshOutcome === 'allComplete' || summary.refreshOutcome === 'activeComplete'

    const patch: Partial<AppSettings> = {}
    if (verified && summary.models.length > 0) {
      patch.cachedModels = summary.models
      patch.modelsUpdatedAt = updatedAt
    }
    Object.assign(patch, selectionSettingsPatch(s, sel))
    if (verified && summary.unionIds.includes(sel.model)) patch.modelNeedsVerification = false
    setSettings(patch)

    return { models: summary.models, updatedAt, keyValid, error, notice: sel.notice }
  })

  // Validate EVERY provided key and keep each one's answer. The model list is the union,
  // annotated with which slots reported each id; `runnableIds` is the subset available on
  // every active-set key, which is what the picker may safely default to.
  ipcMain.handle('models:checkKeys', async (_e, keys: string[]) => {
    const res = await checkApiKeys(keys)
    const updatedAt = new Date().toISOString()

    // Per-slot fetch diagnostics for the B3 persistence probe. Debug-gated rather than
    // deleted: it is the only way to see which key answered when a refresh comes back
    // partial, but it is per-key detail that should not run in production. Enable with
    // SRT_DEBUG_MODELS=1. Prints slot INDICES and counts only — never key material.
    if (process.env.SRT_DEBUG_MODELS) {
      for (const s of res.slots) {
        console.log(`[models] slot ${s.slot}: queried=${s.queried} ok=${s.ok} ids=${s.ids.length}`)
      }
      console.log(
        `[models] outcome=${res.refreshOutcome} activeSlots=[${res.activeSlots.join(',')}] ` +
          `union=${res.unionIds.length} runnable=${res.runnableIds.length} ` +
          `persisted=${res.models.length > 0}`
      )
    }

    // Nothing here may be applied to a different set of keys than it was learned from.
    // Discarded WHOLE, before the selection rules are even consulted: a partial apply is
    // the worst of the three outcomes, because it would leave the verdicts, the model
    // cache and the stored selection describing different moments.
    if (keySnapshotChanged(keys, getSettings().apiKeys ?? [])) {
      const s = getSettings()
      return {
        results: [],
        slots: [],
        // The persisted list, unchanged — this is what the picker is still showing.
        models: (s.cachedModels as ModelInfo[]) ?? [],
        unionIds: [],
        runnableIds: [],
        activeSlots: activeKeySlots(keySlotsFor(s.apiKeys ?? [])),
        // Truthful about the fetch, which may well have been complete. `discarded` is what
        // says the result was not used, rather than overloading this into a lie.
        refreshOutcome: res.refreshOutcome,
        discarded: true,
        model: s.model,
        notice:
          'Your keys changed while they were being checked, so that result was discarded ' +
          'rather than applied to the keys you have now. Press “Fetch Models & Check API ' +
          'Keys” again.',
        updatedAt,
        anyValid: false
      }
    }

    // The previous cache must be read BEFORE the write below: the auto-advance rule
    // compares the stored model against the PREVIOUS list's default.
    const current = getSettings()
    const prevCached = (current.cachedModels as ModelInfo[]) ?? []
    const sel = applyModelSelectionRules(current.model, prevCached, {
      models: res.models,
      unionIds: res.unionIds,
      runnableIds: res.runnableIds,
      outcome: res.refreshOutcome
    })

    const patch: Partial<AppSettings> = {
      apiKeyValid: res.results.map((r) => r.valid),
      apiKeyError: res.results.map((r) => r.error)
    }
    // Overwrite the cache ONLY at the activeComplete bar. On a partial or failed refresh
    // the union is missing whatever the failed key alone could see, so writing it would
    // quietly delete real models from the picker — and, because the pre-spawn guard reads
    // this cache, could then block a selection that a transient network error caused to
    // "disappear". The last known good list stays, marked stale in the UI instead.
    const verified = res.refreshOutcome === 'allComplete' || res.refreshOutcome === 'activeComplete'
    if (verified && res.models.length > 0) {
      patch.cachedModels = res.models
      patch.modelsUpdatedAt = updatedAt
    }
    Object.assign(patch, selectionSettingsPatch(current, sel))
    // Advisory flag from migrations M1/M3: only live evidence may clear it, and only at
    // the activeComplete bar. A partial refresh proves nothing about the stored id.
    if (verified && res.unionIds.includes(sel.model)) patch.modelNeedsVerification = false
    setSettings(patch)

    return {
      results: res.results,
      slots: res.slots,
      models: res.models,
      unionIds: res.unionIds,
      runnableIds: res.runnableIds,
      activeSlots: res.activeSlots,
      refreshOutcome: res.refreshOutcome,
      discarded: false,
      model: sel.model,
      notice: sel.notice,
      updatedAt,
      anyValid: res.anyValid
    }
  })

  // ---- File dialogs ----
  ipcMain.handle(
    'dialog:openFile',
    async (_e, opts: { filters?: Electron.FileFilter[] }) => {
      if (!win) return ''
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: opts?.filters
      })
      return res.canceled ? '' : res.filePaths[0]
    }
  )

  // Settings → Advanced checks a picked FFmpeg override here before storing it; nothing is run.
  ipcMain.handle('ffmpeg:validatePath', (_e, picked: unknown) => validateFfmpegPath(picked))

  ipcMain.handle('dialog:openFolder', async () => {
    if (!win) return ''
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? '' : res.filePaths[0]
  })

  ipcMain.handle('subtitle:inspect', (_e, req: SubtitleInspectRequest) => inspectSubtitleRequest(req))

  // Phase 3 (Step 3.3): read-only. The renderer names its pickers; main finds and judges the job's
  // saved work. Nothing is written, continued or discarded here.
  ipcMain.handle('resume:inspect', async (_e, req: unknown): Promise<ResumeInspectResult> => {
    const parsed = parseInspectRequest(req)
    if (!parsed) return null
    return resumeStore().inspect(parsed, { ffmpegPath: getSettings().ffmpegPath || undefined })
  })

  ipcMain.handle(
    'dialog:saveFile',
    async (
      _e,
      args: {
        srcPath?: string
        defaultName: string
        defaultDir?: string
        logPaths?: string[]
        /** The file the user chose to translate, so the token report can name it (REP-1). */
        inputPath?: string
      }
    ): Promise<SaveResult> => {
      // Annotated, and the empty return corrected with it. This handler used to return a bare string
      // and was changed to return an object; the no-window path kept returning `''`, which the
      // declared `SaveResult` says cannot happen. Nothing crashed — `''.path` is merely `undefined`
      // and every caller tests it — but a type that is wrong in one branch is a type nobody can rely
      // on, and this round adds a third field to it (SOL-15).
      if (!win) return EMPTY_SAVE
      const defaultPath = args.defaultDir
        ? path.join(args.defaultDir, args.defaultName)
        : args.defaultName
      const res = await dialog.showSaveDialog(win, {
        defaultPath,
        filters: [
          { name: 'Subtitles', extensions: ['srt', 'sup', 'ass'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePath) return EMPTY_SAVE
      // Transcribe uses this handler as a DESTINATION PICKER: no source file, no logs, just a
      // path. Round 4 displaced every canonical sidecar whenever that path already existed, so
      // merely choosing `episode.srt` renamed four reports the user never agreed to move, and
      // Transcribe never mentioned it (SOL-17). A picker must not mutate the disk.
      if (!args.srcPath) {
        return { path: res.filePath, consolePath: '', sidecars: [], displaced: [], stale: [] }
      }

      // The subtitle itself IS the file the dialog obtained consent for. A missing temp, a failed
      // write, or a failed exclusive sidecar used to look like success (SOL-22); a failure here
      // returns before any sidecar is written. Formatting is read as Settings stand now, with the
      // target of the run that produced this temp (D12-15, D12-16).
      const saved = await saveSubtitleCopy(args.srcPath, res.filePath, saveRecipeFor(getSettings(), runTargetFor(args.srcPath)))
      if (!saved.ok) return { ...EMPTY_SAVE, error: saved.error }
      const repairNote = wrongAlphabetLogLine(saved.repair)

      // Sidecars are never overwritten and never renamed. The dialog named one file. Moving a
      // stranger's `episode.console.log` aside "to keep the association honest" was still acting
      // on a file nobody consented to touch (SOL-12, round 5). Exclusive create steps around
      // whatever is already there; leftover canonical names are REPORTED as `stale` so they
      // cannot silently look like this run (SOL-15). A sidecar that cannot be written is
      // reported on `error` rather than swallowed — the subtitle has already landed (SOL-22).
      let consolePath = ''
      const sidecars: string[] = []
      const sidecarErrors: string[] = []
      if (args.logPaths?.length) {
        for (const logPath of args.logPaths) {
          if (!fs.existsSync(logPath)) {
            sidecarErrors.push(`could not find ${path.basename(logPath)}`)
            continue
          }
          const dest = sidecarDestination(logPath, res.filePath)
          const suffix = compoundSuffix(dest)
          try {
            const body = dest.endsWith('.tokens.json')
              ? retargetTokenReport(
                  fs.readFileSync(logPath, 'utf-8'),
                  args.inputPath ?? '',
                  res.filePath
                )
              : suffix === CONSOLE_LOG_SUFFIX && repairNote
                ? withLogNote(logPath, repairNote)
                : null
            const written =
              body !== null
                ? writeExclusive(body, dest, suffix)
                : copyExclusive(logPath, dest, suffix)
            if (written) {
              sidecars.push(written)
              if (suffix === CONSOLE_LOG_SUFFIX) consolePath = written
            } else {
              sidecarErrors.push(`could not write ${path.basename(dest)}`)
            }
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e)
            sidecarErrors.push(`${path.basename(logPath)}: ${detail}`)
          }
        }
      }
      return {
        path: res.filePath,
        consolePath,
        sidecars,
        displaced: [],
        stale: leftoverCanonicals(res.filePath, sidecars),
        ...(sidecarErrors.length
          ? {
              error:
                sidecarErrors.length === 1
                  ? `The subtitle was saved, but a report was not: ${sidecarErrors[0]}`
                  : `The subtitle was saved, but some reports were not: ${sidecarErrors.join('; ')}`
            }
          : {})
      }
    }
  )

  // ---- Shell helpers ----
  ipcMain.handle('shell:showItem', (_e, p: string) => {
    if (p) shell.showItemInFolder(p)
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => openApprovedExternal(url))

  // ---- Video tracks ----
  ipcMain.handle('video:probeTracks', async (_e, filePath: string) => {
    const { ffmpegPath } = getSettings()
    return probeTracks(filePath, ffmpegPath)
  })

  // ---- Align (Bundle C) ----
  // The service decides the verdict, the bytes and the destination; these handlers only forward.
  // R13.5 extends these channels and never renames them.
  ipcMain.handle('align:analyze', (_e, req: unknown) => alignService.analyze(req))
  ipcMain.handle('align:cancel', (_e, generation: unknown) => alignService.cancel(generation))
  ipcMain.handle('align:preview', (_e, req: unknown) => alignService.preview(req))
  ipcMain.handle('align:apply', (_e, req: unknown) => alignService.apply(req))
  // R13.5: whether Advanced (piecewise, ALASS) can run. It takes nothing: main names the executable.
  ipcMain.handle('align:advanced-status', () => alignService.advancedStatus())
  // Bundle M: the live outcome's timing diagnostic, keyed by generation; opening one is replay only.
  ipcMain.handle('align:export-diagnostic', (_e, req: unknown) => alignService.exportDiagnostic(req))
  ipcMain.handle('align:open-diagnostic', () => alignService.openDiagnostic())

  /**
   * Report an ffmpeg task's progress on its OWN channel.
   *
   * Deliberately not a run `log` event: the renderer treats those as engine log lines, so a
   * tick every half second would become a log row, and a long extraction would bury the run in
   * noise that FP-3 exists to prevent.
   */
  const progressTo =
    (kind: FfmpegTaskKind) =>
    (pct: number | null, elapsedMs: number): void =>
      send('ffmpeg:progress', { kind, pct, elapsedMs } satisfies FfmpegProgress)

  const endProgress = (kind: FfmpegTaskKind): void =>
    send('ffmpeg:progress', { kind, pct: null, elapsedMs: 0, done: true } satisfies FfmpegProgress)

  // Extraction to a temp .srt (used as translation input for a chosen track). No longer
  // silent: on a large container this is the minutes-long pause REP-11 was reported against.
  ipcMain.handle(
    'video:extractToTemp',
    async (_e, args: { filePath: string; subtitleIndex: number }) => {
      const { ffmpegPath } = getSettings()
      const out = tempOutputPath('.srt')
      try {
        const res = await extractTrack(
          args.filePath,
          args.subtitleIndex,
          out,
          false,
          ffmpegPath,
          progressTo('prepare')
        )
        return res.ok ? { ok: true, path: out } : { ok: false, error: res.error }
      } finally {
        endProgress('prepare')
      }
    }
  )

  ipcMain.handle(
    'video:extractTrack',
    async (
      _e,
      args: { filePath: string; subtitleIndex: number; isImage: boolean; defaultName: string }
    ) => {
      if (!win) return { ok: false, error: 'no window' }
      const { ffmpegPath, outputFolder } = getSettings()
      const defaultPath = outputFolder
        ? path.join(outputFolder, args.defaultName)
        : args.defaultName
      const res = await dialog.showSaveDialog(win, { defaultPath })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      try {
        const out = await extractTrack(
          args.filePath,
          args.subtitleIndex,
          res.filePath,
          args.isImage,
          ffmpegPath,
          progressTo('export')
        )
        return { ...out, path: res.filePath }
      } finally {
        endProgress('export')
      }
    }
  )

  // ---- TMDB ----
  ipcMain.handle(
    'tmdb:search',
    async (_e, args: { query: string; type: 'all' | 'movie' | 'tv' }) => {
      const { tmdbApiKey } = getSettings()
      return tmdbSearch(tmdbApiKey, args.query, args.type)
    }
  )
  ipcMain.handle(
    'tmdb:cast',
    async (_e, args: { tmdbId: string; mediaType: 'movie' | 'tv' }) => {
      const { tmdbApiKey } = getSettings()
      return tmdbCast(tmdbApiKey, args.tmdbId, args.mediaType)
    }
  )

  // ---- Subtitle sources (Bundle H) ----
  // One subtitle-source request at a time from the renderer; `subtitles:cancel` stops it.
  let subtitleRequest: AbortController | null = null
  const subtitleSignal = (): AbortSignal => {
    subtitleRequest?.abort()
    subtitleRequest = new AbortController()
    return subtitleRequest.signal
  }
  ipcMain.handle('subtitles:cancel', () => {
    subtitleRequest?.abort()
  })
  ipcMain.handle('opensubtitles:check', (): Promise<OsCheckResult> => checkOpenSubtitles(getSettings(), subtitleSignal()))
  ipcMain.handle(
    'opensubtitles:search',
    (_e, args: { imdbId: string; season?: number; episode?: number; languages: string[] }): Promise<OsSearchResult> => {
      const languages = Array.isArray(args?.languages) ? args.languages.filter((l): l is string => typeof l === 'string').slice(0, 40) : []
      const query: OsSearchQuery = {
        imdbId: String(args?.imdbId ?? ''),
        languages,
        ...(Number.isInteger(args?.season) && Number.isInteger(args?.episode) ? { season: args.season, episode: args.episode } : {})
      }
      return searchOpenSubtitles(getSettings(), query, subtitleSignal())
    }
  )
  ipcMain.handle(
    'opensubtitles:download',
    (_e, args: { fileId: number; fileName: string; language?: string }): Promise<SubtitleFetchResult> => {
      if (!Number.isSafeInteger(args?.fileId) || args.fileId <= 0) return Promise.resolve({ ok: false, message: 'No such subtitle.', remaining: null })
      return downloadOpenSubtitles(getSettings(), args.fileId, String(args.fileName ?? ''), typeof args.language === 'string' ? args.language : undefined, subtitleSignal())
    }
  )
  ipcMain.handle(
    'wizdom:search',
    (_e, args: { imdbId: string; season?: number; episode?: number }): Promise<WizdomSearchResult> =>
      searchWizdomView(
        getSettings(),
        String(args?.imdbId ?? ''),
        subtitleSignal(),
        Number.isInteger(args?.season) ? args.season : undefined,
        Number.isInteger(args?.episode) ? args.episode : undefined
      )
  )
  // §3.3: the file a finished run's automatic walk accepted, for the page's reference field.
  ipcMain.handle('reference:accepted', (_e, runId: unknown): AcceptedReference | null => (typeof runId === 'string' ? acceptedReferenceOf(runId) : null))
  ipcMain.handle(
    'wizdom:fetch',
    (_e, args: { id: string; sourcePath?: string }): Promise<SubtitleFetchResult> =>
      fetchWizdomView(getSettings(), String(args?.id ?? ''), typeof args?.sourcePath === 'string' ? args.sourcePath : undefined, subtitleSignal())
  )

  // ---- Translate / Transcribe ----

  /**
   * Check the chosen model against what the keys actually reported, just before spawning.
   *
   * Lives in `ipc` because it is the one point every run passes through.
   *
   * Returns false when the run must not start; the refusal is reported on the same event stream
   * a failed run uses, so the UI needs no new path to surface it.
   *
   * The run's id is not optional in spirit. This is a REFUSAL, and a refusal emits a terminal
   * event — so unaddressed it reaches whichever run is genuinely in progress on the other page and
   * tells it that it has failed, while its engine carries on. Same shape as `refuseStart()`, same
   * remedy (SOL-01).
   */
  /**
   * A refusal never reserved the slot, so on the typed stream it is `error` then `finished` and
   * nothing else (implementation_plan.md §2.1a).
   */
  const refuseByGuard = (runId: string, line: string): false => {
    const error = { kind: 'refusedByApp' as const, message: line }
    sendEngineEvent({ type: 'error', runId, error })
    sendEngineEvent({
      type: 'finished',
      runId,
      outcome: 'failed',
      exitCode: -1,
      reason: 'guard',
      outputPath: '',
      logPaths: [],
      warnings: [],
      error
    })
    return false
  }

  /*
   * The guard's warning is said before the run exists. `startRun` makes it the run's first `log`,
   * directly after `started`, which is where it already sat in the panel; a start refused before
   * reservation (another job holds the slot) carries only `error` and `finished` (§2.1a), so the
   * warning leads that refusal's message instead — the panel showed both lines, in that order.
   */

  const passesModelGuard = (
    runId: string,
    model: string,
    keys: string[],
    activeLimit = ACTIVE_SET_SIZE,
    recorded = false
  ): { ok: true; warning?: string } | { ok: false } => {
    const s = getSettings()
    const slots = keySlotsFor(keys)
    const ranked = orderKeySlots(slots)
    if (ranked.length === 0) {
      return { ok: refuseByGuard(runId, noUsableApiKeyMessage(slots)) }
    }
    const verdict = guardModelForSpawn(
      model,
      s.cachedModels,
      // Slice the ranked full list. Passing a one-element keys array would renumber slots
      // and mis-read `availableOn` (SOL-23). Transcription never emits `-k2`, so its limit is 1.
      ranked.slice(0, activeLimit)
    )
    // A stale or incomplete fetched list never makes a recorded configuration unavailable (AR3-5).
    if (!verdict.ok && recorded) {
      return {
        ok: true,
        warning:
          `"${model}" was not in the list your API key last returned. Continue uses the model the saved work was made with; ` +
          'if your key cannot use it, the run stops with the API\u2019s answer.'
      }
    }
    if (!verdict.ok) {
      return { ok: refuseByGuard(runId, verdict.error ?? 'Model unavailable.') }
    }
    return { ok: true, warning: verdict.warning }
  }

  ipcMain.handle('translate:start', async (_e, args: TranslateArgs) => {
    const startSettings = getSettings()
    const { writeTokenReport, progressLog, thoughtsLog, resumeContextSize } = startSettings
    // Bundle H: the walk's client and credentials are the ones in force at Start; the run never rereads them.
    const referenceClient = startSettings.subtitleSourceOpenSubtitles ? openSubtitlesClient(startSettings) : null
    const runId = runIdFor(args.runId)
    // Continue runs the record's model and a retry the one chosen for it, not the page's, so that is the
    // model the guard must pass.
    const frozen = args.resume?.action === 'continue' ? resumeStore().offerConfig(args.resume.resumeId) : null
    const retryModel = args.resume?.action === 'retryFailedSpan' && typeof args.resume.model === 'string' ? args.resume.model.trim() : ''
    const continued = !retryModel && frozen?.kind === 'translate'
    const guard = passesModelGuard(runId, retryModel || (frozen?.kind === 'translate' ? frozen.model : args.model), args.apiKeys, ACTIVE_SET_SIZE, continued)
    if (!guard.ok) return ''
    const fullArgs: TranslateArgs = {
      ...args,
      writeTokenReport,
      progressLog,
      thoughtsLog,
      resumeContextSize
    }
    const started = await startRun({
      kind: 'translate',
      runId,
      args: fullArgs,
      adapter: () =>
        createNativeEngineAdapter({
          scanOutput: (source, output, text) => scanOutputWarnings(source, output, text).map(toRunWarning),
          resume: resumeStore(),
          quotaBudget: () => quotaBudgetStoreAt(app.getPath('userData')),
          referenceClient
        }),
      deliver: deliverRememberingTarget(sendEngineEvent, args.targetLang),
      notice: guard.warning,
      secrets: runSecrets(fullArgs.apiKeys),
      preferences: runPreferences()
    })
    return started.outputPath
  })

  /**
   * Ask one key whether it still works, for the transcription preflight (REP-2).
   *
   * It reuses `refreshModels`, so the classification of "rejected" versus "could not be checked" is
   * shared with the Settings panel rather than re-derived here. No process is started (Step 4.1): a
   * Stop aborts the call and the run's slot is released by the adapter, with nothing left running.
   */
  const keyPreflight = async (apiKey: string, signal: AbortSignal): Promise<KeyPreflight> => {
    const res = await refreshModels(apiKey, signal)
    if (res.verdict === 'valid') return { verdict: 'valid', message: '' }
    if (res.verdict === 'rejected') {
      return {
        verdict: 'rejected',
        message:
          `The API rejected this key before the transcription started: ${res.error} ` +
          'Nothing was sent and no quota was spent. Open Settings > Gemini API Keys to fix it.'
      }
    }
    return {
      verdict: 'unchecked',
      message: `The API key could not be checked first: ${res.error} Starting anyway.`
    }
  }

  ipcMain.handle('transcribe:start', async (_e, args: TranscribeArgs) => {
    const runId = runIdFor(args.runId)
    // Continue runs the record's model, not the page's, so that is the model the guard checks (Step 3.6).
    const frozen = args.resume?.action === 'continue' ? resumeStore().offerConfig(args.resume.resumeId) : null
    const runModel = frozen?.kind === 'transcribe' ? frozen.model : args.model
    const guard = passesModelGuard(runId, runModel, args.apiKeys, 1, frozen?.kind === 'transcribe')
    if (!guard.ok) return ''
    // Awaited because unreadable audio is converted first; the renderer's contract is unchanged.
    const started = await startRun({
      kind: 'transcribe',
      runId,
      args: dedicatedTranscribeArgs(args, getSettings(), runModel),
      adapter: () =>
        createNativeEngineAdapter({
          preflight: keyPreflight,
          onProgress: (p) => send('ffmpeg:progress', p),
          resume: resumeStore(),
          quotaBudget: () => quotaBudgetStoreAt(app.getPath('userData'))
        }),
      deliver: sendEngineEvent,
      notice: guard.warning,
      secrets: runSecrets(args.apiKeys),
      preferences: runPreferences()
    })
    return started.outputPath
  })

  /**
   * D5-13: six spread samples of the chosen media, one call to the Settings translation model. Outside
   * the run slot, like the resume inspection; a newer request or Cancel aborts an older one. The key is
   * the first ranked slot, read at the moment of the call.
   */
  let detecting: AbortController | null = null
  ipcMain.handle('transcribe:detect-language', async (_e, req: SourceLanguageDetectRequest): Promise<SourceLanguageDetectResult> => {
    detecting?.abort()
    const ctl = new AbortController()
    detecting = ctl
    const timer = setTimeout(() => ctl.abort(), DETECT_LANGUAGE_LIMIT_MS)
    const s = getSettings()
    const slot = orderKeySlots(keySlotsFor(s.apiKeys))[0]
    let dir = ''
    let admission: OneShotAdmission | null = null
    let outcome: OneShotOutcome = {}
    try {
      if (typeof req?.mediaFile !== 'string' || !req.mediaFile) return { kind: 'abstained', reason: 'failed' }
      // Budgeted like any Free request, but never waits: a group that cannot send now opens the modal empty.
      if (slot !== undefined && !isDedicatedTranscribeModel(s.model)) {
        const budget = createRequestBudget({ journal: quotaBudgetStoreAt(app.getPath('userData')), settings: getSettings })
        admission = admitOneShot({ budget, settings: s, slot, model: s.model, token: `detect-${Date.now().toString(36)}` })
        if (!admission.admitted) return { kind: 'abstained', reason: 'failed' }
      }
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-detect-'))
      const detected = await detectSourceLanguage({
        model: s.model,
        config: modelRequestConfig({
          kind: 'translate',
          model: s.model,
          thinkingLevel: s.thinkingLevel,
          thinkingBudget: s.thinkingBudget,
          customGenerationParams: s.customGenerationParams,
          temperature: s.temperature,
          topP: s.topP,
          topK: s.topK,
          serviceTier: s.serviceTier
        }),
        provider: observedProvider(createGeminiProvider(), (reply) => {
          outcome = { ...(reply.usage ? { actualInputTokens: reply.usage.promptTokens } : {}), failure: reply.result.ok ? null : reply.result }
        }),
        apiKey: slot === undefined ? '' : (s.apiKeys[slot] ?? '').trim(),
        keyIndex: slot ?? 0,
        signal: ctl.signal,
        sample: async (count, seconds, signal) => {
          let n = 0
          const out = path.join(dir, 'sample.mp3')
          const cut = await spreadSample(req.mediaFile, count, seconds, out, {
            signal,
            ...(s.ffmpegPath ? { ffmpegPath: s.ffmpegPath } : {}),
            scratchPath: (suffix) => path.join(dir, `piece-${++n}${suffix}`)
          })
          return cut.ok ? { ok: true, data: fs.readFileSync(out), mimeType: 'audio/mp3' } : { ok: false }
        }
      })
      if (admission?.admitted) {
        const recorded = admission.done(outcome)
        admission = null
        // A call whose outcome the request record could not keep is not trusted: the modal opens empty.
        if (!recorded.ok) return { kind: 'abstained', reason: 'failed' }
      }
      return detected
    } catch {
      return { kind: 'abstained', reason: 'failed' }
    } finally {
      if (admission?.admitted) admission.done(outcome)
      clearTimeout(timer)
      if (detecting === ctl) detecting = null
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  ipcMain.handle('transcribe:cancel-detect-language', () => {
    detecting?.abort()
    return true
  })

  ipcMain.handle('translate:stop', () => {
    stopCurrent()
    return true
  })
  ipcMain.handle('translate:isRunning', () => isRunning())
}

/** `provider`, telling `onReply` about every answer `generate` returns, before its caller reads it. */
function observedProvider(provider: GenerationProvider, onReply: (reply: ProviderReply) => void): GenerationProvider {
  return {
    id: provider.id,
    capabilities: provider.capabilities,
    generate: async (request, ctx) => {
      const reply = await provider.generate(request, ctx)
      onReply(reply)
      return reply
    }
  }
}
