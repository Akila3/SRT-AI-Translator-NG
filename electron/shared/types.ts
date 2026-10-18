import type { AlignmentMode, AlignmentReason, AlignmentResult, ArbitrationReason } from './alignment'
import type { RunKind } from './engineEvents'
import type { GenderReferenceArgs } from './genderReference'

/**
 * The engine's own default for `--resume-context-size` (cli.py). Shared so the main
 * process and the Settings UI agree on the value at which the flag is omitted entirely.
 */
export const DEFAULT_RESUME_CONTEXT_SIZE = 50

/** Previous source lines sent before each batch when Cross-Batch Context is on (feature_decisions.md D15-1R). */
export const DEFAULT_BATCH_CONTEXT_LINES = 5
/** Not lower: with a one-line block Flash-Lite 3.5 translates the context line instead of the batch (tester TD15-3). */
export const MIN_BATCH_CONTEXT_LINES = 4
export const MAX_BATCH_CONTEXT_LINES = 10

/** Whether the dedicated transcription path polishes its cue wording (Stage C) unless the user turns it off. */
export const DEFAULT_TRANSCRIBE_POLISH = true

export interface SubtitleTrack {
  index: number
  codec: string
  lang: string
  name: string
  isImage: boolean
}

/** Whether a picked FFmpeg override may be stored. `reason` is fixed copy: never a raw error, path or stack. */
export type FfmpegPathValidation = { ok: true } | { ok: false; reason: string }

/**
 * How a saved right-to-left subtitle copy is prepared for players (feature_decisions.md D12-13/D12-14).
 * The ids are stable; the Settings labels are Smart RTL, Hebrew Compatibility, Classic RTL,
 * Basic-Player RTL and Old Subtitle Repair, in this order.
 */
export type RtlMethod = 'hybrid' | 'kodi_rtl_base' | 'gst_compatibility' | 'kodi_reverse' | 'kodi_legacy'

export const RTL_METHODS: readonly RtlMethod[] = [
  'hybrid',
  'kodi_rtl_base',
  'gst_compatibility',
  'kodi_reverse',
  'kodi_legacy'
]

export interface AppSettings {
  /**
   * Persisted-settings format version. `defaults` MUST keep this at 0: electron-store
   * returns the default for any absent key, so a non-zero default would make every
   * legacy profile report "already migrated" and skip the whole chain.
   */
  schemaVersion: number
  sourceLang: string
  targetLang: string
  apiKeys: string[]
  apiKeyTiers: string[]
  apiKeyValid: (boolean | null)[]
  apiKeyError: string[]
  theme: string
  model: string
  /**
   * Advisory flag set by the offline migrations when the stored model id looks
   * suspicious but cannot be proven gone. It drives a UI hint and NOTHING else — it
   * must never authorise a reset. Cleared by the first `activeComplete` refresh that
   * finds the id.
   */
  modelNeedsVerification: boolean
  batchSize: number
  batchContext: boolean
  /** Previous source lines (4–10) sent before each batch while `batchContext` is on. */
  batchContextLines: number
  /** When false, temperature/top-p/top-k are omitted entirely so the model's own defaults apply. */
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
  thinkingLevel: string
  thinkingBudget: number
  /**
   * Transcribe-page override of Settings → Model & Generation. Default off: this tab
   * uses the global model and thinking values. When on, the three fields below are
   * what a transcribe run sends. Empty strings / budget 0 mean "use the global".
   * No schema bump: sanitizeSettingsView overlays these from defaults when absent.
   */
  transcribeOverride: boolean
  transcribeModel: string
  transcribeThinkingLevel: string
  transcribeThinkingBudget: number
  /**
   * Transcribe tab, dedicated model only: a text pass tidies the wording of the built cues (Stage C).
   * It never changes a cue's count or timing. Unavailable on the general path. No schema bump: it
   * overlays from defaults when absent.
   */
  transcribePolish: boolean
  /** The polishing model; '' means the translation model above. Never a transcription model. Overlays from defaults when absent. */
  transcribePolishModel: string
  serviceTier: string
  paidQuota: boolean
  /**
   * No control sets it: every request already waits for the whole response (D4). Kept because stored
   * profiles and paused-job records carry it, and a record whose frozen settings lose a field no longer resumes.
   */
  disableStreaming: boolean
  /** Lines of prior context replayed when resuming an interrupted job. 50 = engine default, 0 disables. */
  resumeContextSize: number
  tmdbApiKey: string
  outputFolder: string
  /**
   * Settings → Output → RTL subtitle formatting. On prepares the saved copy with `rtlMethod`; Off saves
   * logical text. Turning it off never clears `rtlMethod`. No schema bump: both overlay from defaults.
   */
  rtlEnabled: boolean
  /** Always one of RTL_METHODS in the runtime view (`sanitizeRtlMethod`); a stored unknown value stays on disk. */
  rtlMethod: RtlMethod
  ffmpegPath: string
  systemPrompt: string
  showTokenStats: boolean
  writeTokenReport: boolean
  progressLog: boolean
  thoughtsLog: boolean
  cachedModels: ModelInfo[]
  modelsUpdatedAt: string | null
  /**
   * Bundle F (feature_decisions.md D8-1…D8-16). Paces Free-key requests from the app's own journal of
   * requests it sent. Only a literal `false` turns it off.
   */
  automaticFreeTierProtection: boolean
  /** Manual AI Studio limits take part only while this AND Automatic Protection are on. Values survive off. */
  manualQuotaLimitsEnabled: boolean
  /** A Free-primary route may cross to a Paid key only while this is on. A Paid primary never needs it. */
  allowPaidFallback: boolean
  /** One global headroom on manual values: usable = floor(limit × (100 − p) / 100). 0 ≤ p < 100. */
  manualQuotaReservePercent: number
  /** One group id per key slot, positional like `apiKeys`. Main-process owned (`settings:mutateQuotaGroup`). */
  apiKeyQuotaGroups: string[]
  /** Main-process owned. Group A (`group-a`) always exists. */
  quotaGroups: QuotaGroupSettings[]
  /** Structured 429 evidence only, bounded per group/model/metric. Main-process owned. */
  learnedQuotaEvidence: LearnedQuotaEvidence[]
  /**
   * The Advanced Hebrew correction master switch (tester 2026-10-18). Off: the four layers below are not
   * shown and a run takes all four as off, whatever they store; their values survive. A profile that never
   * stored it reads on exactly when one of the four is stored on. No schema bump.
   */
  hebrewAdvanced: boolean
  /**
   * Feature 17 (implementation_plan.md §9.9d): four independent, default-OFF Advanced Hebrew correction
   * layers, used only while `hebrewAdvanced` is on. Each requests its layer; none certifies eligibility or execution.
   */
  hebrewSpeakerRepair: boolean
  hebrewMethodB: boolean
  hebrewC1Spanish: boolean
  hebrewC1Portuguese: boolean
  /**
   * Bundle H OpenSubtitles credentials, all optional (feature_decisions.md §3.1c). Blank key: the shared key
   * pool is used. Username and password both entered: downloads are charged to that account. Plaintext in this
   * store, like every other credential (D9 / §10.4); swept by the run's redaction; never sent to the renderer
   * in a log or an error. No schema bump: each overlays from its default.
   */
  openSubtitlesApiKey: string
  openSubtitlesUsername: string
  openSubtitlesPassword: string
  /** Settings → Subtitle sources (NG-new, §3.1b). OpenSubtitles default on; Wizdom default off. */
  subtitleSourceOpenSubtitles: boolean
  subtitleSourceWizdom: boolean
}

/** Values copied from AI Studio. Absent means unknown; never a shipped default. */
export interface ManualQuotaValues {
  rpm?: number
  tpm?: number
  rpd?: number
}

/** A user-declared set of keys that share one client-local budget. The label is user text; the id is not. */
export interface QuotaGroupSettings {
  id: string
  label: string
  manualByModel: Record<string, ManualQuotaValues>
}

/** One structured quota observation from an API 429. Never raw body, key or content. */
export interface LearnedQuotaEvidence {
  groupId: string
  model: string
  metric?: 'rpm' | 'tpm' | 'rpd' | 'other'
  limit?: number
  resetAt?: string
  observedAt: string
  source: 'api-429'
  fingerprint: string
  detailKeys: string[]
}

export interface ModelInfo {
  id: string
  label: string
  /**
   * Where this entry came from. `seed` means "we ship this id in a static list" and is
   * explicitly NOT evidence that the model is runnable — only `live` is.
   */
  source: 'live' | 'seed'
  /** API-key slot indices whose fetch returned this id. Always empty for seed entries. */
  availableOn: number[]
  /**
   * Bundle F: the official Models API maxima for this exact id, positive integers only. Seed entries
   * carry none; a conflict between keys keeps the earlier value rather than picking a winner.
   */
  inputTokenLimit?: number
  outputTokenLimit?: number
  limitsFetchedAt?: string
}

/** Per-key validation outcome shown next to each API key slot. */
export interface KeyCheck {
  valid: boolean | null
  error: string
}

/** What one API key slot returned during a refresh. */
export interface SlotFetchResult {
  /** Index into `AppSettings.apiKeys`. */
  slot: number
  /** True when this slot was actually queried (an empty slot is skipped). */
  queried: boolean
  /** True when the query returned a model list without error. */
  ok: boolean
  /** Raw model ids this slot reported. Empty unless `ok`. */
  ids: string[]
}

/**
 * How complete one refresh attempt was. Deliberately NOT persisted: it describes a
 * single fetch, and a stale value could later authorise a destructive reset.
 *
 * - `allComplete`    every configured non-empty slot answered. Required to reset a
 *                    user's model override, because that destroys an explicit choice.
 * - `activeComplete` every slot in the ACTIVE SET answered. Enough to auto-advance the
 *                    default, which is reversible. A one-key user has a one-slot active
 *                    set, so this is reachable for them.
 * - `partial`        something answered, but the active set is not fully covered.
 * - `failed`         nothing answered.
 */
export type RefreshOutcome = 'allComplete' | 'activeComplete' | 'partial' | 'failed'

export interface CheckKeysResult {
  results: KeyCheck[]
  /** Per-slot fetch detail. Replaces the old "take the list from the first valid key". */
  slots: SlotFetchResult[]
  /** Display list: the union of every live id, or the seed when no fetch ever succeeded. */
  models: ModelInfo[]
  /** Union of ids across every slot that answered. */
  unionIds: string[]
  /** Intersection across the active set — the ids that can actually run right now. */
  runnableIds: string[]
  /** `orderKeySlots(...).slice(0, 2)`: the slots buildTranslateArgs will emit. */
  activeSlots: number[]
  refreshOutcome: RefreshOutcome
  anyValid: boolean
}

export interface TranslateArgs {
  /** Minted by the renderer so it can recognise its own events — see `RunId`. */
  runId?: RunId
  inputFile: string
  videoFile?: string
  audioFile?: string
  streamIndex?: number
  sourceLang: string
  targetLang: string
  model: string
  apiKeys: string[]
  batchSize: number
  batchContext: boolean
  /** Absent reads as DEFAULT_BATCH_CONTEXT_LINES; anything outside 4–10 is projected to it. */
  batchContextLines?: number
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
  thinkingLevel: string
  thinkingBudget: number
  serviceTier: string
  paidQuota: boolean
  disableStreaming: boolean
  description?: string
  systemPrompt?: string
  ffmpegPath?: string
  resumeFrom?: number
  resumeContextSize?: number
  writeTokenReport: boolean
  progressLog: boolean
  thoughtsLog: boolean
  /**
   * What the page's inspection (`subtitle:inspect`) pinned. Start re-reads the file once and refuses if
   * its path or digest no longer matches, then decodes with this encoding. Without one, Start inspects
   * the bytes itself and refuses anything that would have needed the user's confirmation.
   */
  sourceReceipt?: SubtitleReceipt
  /**
   * The native engine's answer to `resume:inspect` (Phase 3). Absent is `fresh`, which main refuses
   * while unfinished work exists for this job. A retry of a failed section (AR3-7) travels the same way.
   * Never part of the frozen configuration; the CLI ignores it.
   */
  resume?: ResumeDecision | FailedSpanRetryDecision
  /** Bundle H: the run's gender reference, frozen at Start. Absent: none (Off, or a non-Hebrew target). */
  genderReference?: GenderReferenceArgs
  /**
   * Feature 17, frozen at Start with the other Settings values. Consulted only for a Hebrew target, and
   * each gates exactly its own layer. Absent reads as off.
   */
  hebrewSpeakerRepair?: boolean
  hebrewMethodB?: boolean
  hebrewC1Spanish?: boolean
  hebrewC1Portuguese?: boolean
}

// ── Subtitle intake (Bundle A, D14.1) ─────────────────────────────────────────────────────────────
// The IPC face of `electron/engine/subtitleInput.ts`, declared here because the renderer cannot see
// engine files. A gate holds the two declarations identical.

export type SubtitleEncoding =
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16le-bom'
  | 'utf-16be-bom'
  | 'windows-1250'
  | 'windows-1251'
  | 'windows-1252'
  | 'windows-1253'
  | 'windows-1254'
  | 'windows-1255'
  | 'windows-1256'

export interface SubtitleReceipt {
  /** Canonical (realpath) location of the inspected file. */
  path: string
  byteLength: number
  sha256: string
  encoding: SubtitleEncoding
}

export interface SubtitleCandidate {
  encoding: SubtitleEncoding
  /** Registry language value, `''` when no language scored. */
  language: string
  score: number
  /** Only when the chosen language reads the bytes more than one way: this reading's first differing line. */
  preview?: string
}

export interface SubtitleInspection {
  receipt: SubtitleReceipt
  format: 'srt' | 'ass'
  encodingSource: 'bom' | 'utf8' | 'detected' | 'override'
  encodingCertain: boolean
  language: string
  languageCertain: boolean
  hintUsed: boolean
  candidates: SubtitleCandidate[]
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

export interface SubtitleInspectRequest {
  path: string
  /** The extracted track's language tag (`heb`, `pt-BR`); the filename is used when absent. Tiebreaker only. */
  trackLanguage?: string
  /** The user's language override; for legacy bytes it also selects the code page. */
  language?: string
  /** The reading the user picked when that language decodes the bytes more than one way. */
  encoding?: SubtitleEncoding
}

export interface TranscribeArgs {
  /** Minted by the renderer so it can recognise its own events — see `RunId`. */
  runId?: RunId
  mediaFile: string
  outputFile: string
  targetLang: string
  model: string
  apiKeys: string[]
  thinkingLevel: string
  thinkingBudget: number
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
  /**
   * The stored service tier (N5, `serviceTier: 'both'`). Filled by main from settings, never by the
   * renderer. The CLI does not read it — 1.1.0's transcription argv never carried `--service-tier`
   * (`pythonBridge.ts:609-629`) — and the native engine sends it as Translate does.
   */
  serviceTier?: string
  description?: string
  ffmpegPath?: string
  /**
   * Phase 3 (Step 3.6): the native start decision, as Translate's. A Transcribe offer never asks for a
   * failed-section retry (AR3-7), so only `fresh`, `continue` and `startOver` are accepted.
   */
  resume?: ResumeDecision
  /**
   * Dedicated transcription model only: the one spoken-language code the user confirmed in the modal
   * at Start (feature_decisions.md D5-17). Never set for a general model, which is sent no language.
   */
  sourceLanguage?: string
  /**
   * Dedicated transcription model only: the wording polish (Stage C) and the translation model it runs
   * on. Filled by main from Settings when the toggle is on and polishing is available; never by the renderer.
   */
  polish?: { model: string; thinkingLevel: string; thinkingBudget: number }
}

/** The Transcribe page's request to detect the spoken language before a dedicated run (D5-13). */
export interface SourceLanguageDetectRequest {
  mediaFile: string
}

/** What detection proposed. Anything but one recognised code is an abstention, and the modal opens empty. */
export type SourceLanguageDetectResult =
  | { kind: 'detected'; code: string }
  | { kind: 'abstained'; reason: 'zxx' | 'disagreement' | 'unrecognised' | 'failed' | 'unavailable' }

// ── Native resume (Phase 3, implementation_plan.md "Phase-3 fixed public/configuration contract") ──
// Fixed shapes: no public value carries a checkpoint or partial path, a digest, prompt text, a
// credential or a provider body. Main owns every checkpoint; the renderer sends only its pickers.

export type ResumeInvalidReason =
  | 'checkpointCorrupt'
  | 'checkpointVersion'
  | 'sourceChanged'
  | 'configurationUnavailable'
  | 'outputMissing'
  | 'outputChanged'
  | 'outputInvalid'
  | 'coverageInvalid'
  | 'destinationChanged'
  | 'generationStale'

/** AR3-6's one sentence per reason, said by the offer and by a Continue that main refuses. */
export const RESUME_INVALID_REASON_COPY: Readonly<Record<ResumeInvalidReason, string>> = {
  checkpointCorrupt: 'The saved resume record is damaged.',
  checkpointVersion: 'The saved resume record was created by an unsupported version.',
  sourceChanged: 'The source input changed since this work was saved.',
  configurationUnavailable: 'The original run configuration is no longer supported.',
  outputMissing: 'The resumable partial file is missing.',
  outputChanged: 'The resumable partial file changed outside the app.',
  outputInvalid: 'The resumable partial file is not a valid complete snapshot.',
  coverageInvalid: 'The saved progress does not exactly match the partial output.',
  destinationChanged: "The run's completion target changed since this work was started.",
  generationStale: 'This resume offer is no longer current.'
}

/** What a stopped or failed resumable Translate run says about its kept work. */
export const RESUMABLE_TRANSLATE_NOTE = 'The work so far is kept. Start again with the same subtitle and target language to Continue or Start over.'

export type ResumeOffer =
  | {
      state: 'valid'
      resumeId: string
      kind: RunKind
      updatedAtEpochMs: number
      completedUnits: number
      totalUnits: number
      unit: 'cues' | 'milliseconds'
      nextAction: 'continue'
      failedSpan?: never
    }
  | {
      state: 'valid'
      resumeId: string
      kind: 'translate'
      updatedAtEpochMs: number
      completedUnits: number
      totalUnits: number
      unit: 'cues'
      nextAction: 'retryFailedSpan'
      failedSpan: {
        fromCue: number
        toCue: number
        originalModel: string
        maxBatchSize: number
        contextEnabled: boolean
      }
    }
  | {
      state: 'invalid'
      resumeId: string
      kind: RunKind
      reason: ResumeInvalidReason
    }

export type ResumeInspectRequest =
  | {
      kind: 'translate'
      inputKind: 'subtitleFile'
      inputFile: string
      targetLang: string
      videoFile?: string
      audioFile?: string
    }
  | {
      kind: 'translate'
      inputKind: 'extractedTrack'
      inputFile: string
      containerFile: string
      streamIndex: number
      targetLang: string
      audioFile?: string
    }
  | { kind: 'transcribe'; mediaFile: string; outputFile: string }

/** `resume:inspect`: the CLI engine has no resume; `null` is no unfinished work for this job. */
export type ResumeInspectResult = 'unsupported' | null | ResumeOffer

export type ResumeDecision =
  | { action: 'fresh' }
  | { action: 'continue'; resumeId: string }
  | { action: 'startOver'; resumeId: string }

export type FailedSpanRetryDecision = {
  action: 'retryFailedSpan'
  resumeId: string
  model: string
  batchSize: number
  useContext: boolean
}

/**
 * Which run an event belongs to.
 *
 * Both pages stay mounted for the life of the app (App.tsx keeps them so their inputs survive a
 * tab switch), and both listen on the SAME channel — one `engine:event` for translation and
 * transcription alike. When those events were unaddressed, every runner received every event and a
 * finished run's state was overwritten by the next run of the other kind: its `outputPath` and
 * `logPaths` were replaced, and Save would then copy the other run's file under this one's name
 * (validator finding SOL-01).
 *
 * The id is minted by the RENDERER, before it asks main to start anything, because output begins
 * arriving during that call and an id handed back afterwards would come too late to filter it.
 */
export type RunId = string

/**
 * Which piece of ffmpeg work a progress report belongs to.
 *
 * This is what correlates a report with the thing on screen that is waiting for it, and it is
 * an enumeration rather than a generated id because the three are already mutually exclusive
 * in practice: `export` and `prepare` share the Translate page's single ffmpeg lock, and
 * `convert` can only run inside a transcription job, of which there is at most one. A page
 * therefore ignores any kind it did not start — which matters, because a transcription's
 * conversion and a track export CAN overlap, being on different pages under different locks.
 *
 * - `export`  — a subtitle track written to a file the user chose.
 * - `prepare` — a track extracted to a temp file so it can be translated.
 * - `convert` — audio normalised to MP3 before transcription.
 */
export type FfmpegTaskKind = 'export' | 'prepare' | 'convert'

/**
 * How far one ffmpeg task has got. Its own channel, NOT the engine's output stream: every
 * tick would otherwise become a log row and undo the panel work of FP-3.
 */
export interface FfmpegProgress {
  kind: FfmpegTaskKind
  /**
   * Whole percent, or null when the input's duration is unknown and only elapsed time can
   * honestly be shown. Never reaches 100 while the task is running.
   */
  pct: number | null
  /** Milliseconds since the task started, so a page can show a clock without owning one. */
  elapsedMs: number
  /**
   * The task has ended, however it ended — stop showing it. `pct` is meaningless here.
   * Present because `convert` runs inside a job the renderer never awaits, so nothing else
   * would tell its page that the conversion is over.
   */
  done?: boolean
}

/**
 * Why a run ended, when something other than the engine decided it.
 *
 * A boolean would not do. A killed process and a crashed one both exit non-zero, so the
 * renderer cannot tell them apart, and the main process is the only place that knows — but
 * "the app ended this run" is not one thing: `user` is a button press and reads as Stopped,
 * while `stalled` and `guard` are the app refusing to continue and must keep reading as
 * failures. Reporting either of those as a Stop would tell the user they did something they
 * did not do, and would bury the cause.
 *
 * Absent means the engine exited on its own and the exit code decides, as before.
 */
export type TerminalReason = 'user' | 'stalled' | 'guard'

/**
 * What the save dialog resolves to.
 *
 * It used to be the subtitle's path alone, and the renderer DERIVED the sidecar names from it. That
 * stopped being safe once sidecars stopped overwriting strangers' files: an occupied name is stepped,
 * so the destination is no longer predictable and has to be reported (SOL-12). `path` is `''` when
 * the user cancelled, exactly as the bare string was.
 *
 * Declared HERE rather than in the preload, where it started, so the main-process handler that
 * produces it is checked against it. While it lived on the renderer side alone, one branch of that
 * handler was still returning the bare string this type replaced and nothing objected (SOL-15).
 */
export interface SaveResult {
  path: string
  /** Where the console log actually landed, or '' if there was none to copy. */
  consolePath: string
  /**
   * Where EVERY sidecar actually landed — console, token report, progress, thoughts.
   *
   * Reporting only the console left the other three unaccounted for: a stepped
   * `episode-2.tokens.json` existed and nothing in the app ever mentioned it (SOL-15). With the full
   * list the panel can say plainly that a report was saved under a different name.
   */
  sidecars: string[]
  /**
   * Kept for wire compatibility. `dialog:saveFile` no longer moves sidecars (SOL-12/17, round 5);
   * it always returns `[]`. Leftovers are `stale`.
   */
  displaced: string[]
  /**
   * Canonical sidecar names that still exist beside the saved subtitle and were NOT written by
   * this save — an older run's report, or another tool's file of the same name (SOL-12, SOL-15).
   * They were left untouched; the panel must say so, because their names otherwise look like
   * they belong to the subtitle just saved.
   */
  stale: string[]
  /**
   * Why this save is not a clean success (SOL-22).
   *
   * Absent on cancel and on a picker-only call (`srcPath` omitted). Set with an empty `path`
   * when the subtitle itself could not be written. Set *with* a `path` when the subtitle landed
   * but a requested sidecar did not — the page must still say the report is missing.
   */
  error?: string
}

/** One OpenSubtitles search result: a single-file subtitle (Bundle H, `electron/main/opensubtitles.ts`). */
export interface OsCandidate {
  readonly fileId: number
  readonly fileName: string
  readonly subtitleId: string
  /** The app's language value (`pt-BR`, `pt-PT` and `pm` read as `pt`). */
  readonly language: string
  readonly release: string
  /** true when the service flags it AI or machine translated; null when either flag is missing (unknown). */
  readonly machineTranslated: boolean | null
  readonly hearingImpaired: boolean
  readonly foreignPartsOnly: boolean
  readonly fromTrusted: boolean
  readonly downloadCount: number
  readonly uploadDate: string
  readonly fps: number | null
}

/** Settings → OpenSubtitles → Check. Messages name no key, account or token. */
export interface OsCheckResult {
  readonly key: {
    readonly state: 'accepted' | 'acceptedAtLimit' | 'notAccepted' | 'notAcceptedOrUnavailable' | 'failed'
    readonly source: 'own' | 'pool'
    readonly message: string
  }
  readonly login: {
    readonly state: 'notEntered' | 'ok' | 'rejected' | 'failed'
    readonly remaining: number | null
    readonly message: string
  }
}

export type OsSearchResult =
  | { readonly state: 'complete' | 'partial'; readonly candidates: readonly OsCandidate[]; readonly message: string | null }
  | { readonly state: 'failed'; readonly message: string }

/** A downloaded subtitle source, staged in the app's scratch folder: one file per subtitle it held. */
export type SubtitleFetchResult =
  | {
      readonly ok: true
      /**
       * `language`: what the file is used as — the listed language, or the one detection is certain of over it
       * (`mislabelled`, feature_decisions.md §3.3); null when neither says.
       */
      readonly files: readonly { readonly path: string; readonly name: string; readonly cues: number; readonly language: string | null; readonly mislabelled: boolean }[]
      /** The allowance left after this download, when the service reported it; null is unknown. */
      readonly remaining: number | null
      /**
       * How the first file was chosen when the download held several: `alignment` (it aligned best with the
       * source), `only` (one subtitle), or `none` (nothing aligned, or no source to align with — the user picks).
       */
      readonly chosenBy: 'only' | 'alignment' | 'none'
    }
  | { readonly ok: false; readonly message: string; readonly remaining: number | null }

export type WizdomSearchResult =
  | { readonly ok: true; readonly entries: readonly { readonly id: string; readonly versionName: string }[] }
  | { readonly ok: false; readonly message: string }

export interface TmdbResult {
  id: string
  title: string
  type: 'Movie' | 'TV Show'
  year: string
  poster: string | null
  mediaType: 'movie' | 'tv'
}

export interface CastMember {
  name: string
  character: string
  gender: string
}

export interface TmdbDetails {
  cast: CastMember[]
  title: string
  genres: string
  genreList: string[]
  typeLabel: string
  imdbId: string
  tmdbId: string
  seasons: number
  yearStart: string
  yearEnd: string
  mediaType: 'movie' | 'tv'
}

// ── Align (Bundle C, implementation_plan.md §17.5) ──────────────────────────────────────────────
//
// AUTHORED-BY: opus-5.5-high
//
// Main owns the analysis: the renderer names the two files and a generation it minted, never a
// profile, a verdict, an executable or an output path. R13.5 extends these shapes; it never renames
// the `align:*` channels.

/** What the subtitle is aligned to: another SubRip file, or a media file (its text tracks, then its audio). */
export type AlignReference = { kind: 'subtitle'; path: string } | { kind: 'media'; path: string }

export interface AlignAnalyzeRequest {
  /** Minted by the renderer, strictly increasing. A newer one supersedes and cancels an older one. */
  generation: number
  sourcePath: string
  reference: AlignReference
  /**
   * Consent to the transcription a previous media analysis offered (C.4): that offer's token. The offer
   * is bound in main to the same source bytes and media path; an unknown or used token is refused.
   */
  transcriptionToken?: string
  /**
   * `global` (the default) is NG's one map. `piecewise` is the explicit Advanced action: ALASS proposes
   * a timeline and NG's own A–I check over that output against the reference decides. The renderer
   * names the mode only — never a profile, an executable or an FFmpeg path.
   */
  mode?: AlignmentMode
}

/** Whether Advanced (piecewise, ALASS) can run; anything short of the exact build disables Advanced only. */
export type AlignAdvancedStatus =
  | { available: true }
  | { available: false; reason: 'absent' | 'untrusted' | 'wrong_version' | 'not_runnable' | 'busy'; message: string }

/** What ALASS said about its own run. Diagnostic only: never a verdict and never read by one. */
export interface AlignAdvancedDiagnostics {
  engine: string
  shiftGroups: number
  score: number | null
  fpsRatio: string
}

/** `align.ts` `IndependentReason`: the one taxonomy in `./alignment`. */
export type AlignMatchReason = AlignmentReason

/** Why an analysis stopped before, or instead of, a verdict on a reference. */
export type AlignStopReason =
  | 'invalid_request'
  | 'source_unreadable'
  | 'reference_unreadable'
  | 'reference_not_text'
  | 'no_text_reference'
  | 'media_unreadable'
  | 'audio_unusable'
  | 'transcription_failed'
  | 'offer_expired'
  | 'busy'
  /** Something outside the measured refusals stopped the analysis (a temp folder, a file that vanished). */
  | 'analysis_failed'
  /** Advanced was asked for, and the ALASS component is missing, not the exact build, or still busy. */
  | 'advanced_unavailable'
  /** ALASS ran and did not produce a usable candidate (it failed, overran a bound, or reported inconsistently). */
  | 'advanced_failed'
  /** Bundle M: the embedded text tracks gave different maps with equal support, and the audio could not settle it. */
  | ArbitrationReason

/**
 * One reference tried, in order. Text-free: codec, language and position only. Besides a verdict's own
 * reason: `image`/`not_text` (never extracted), `extract_failed`, `too_large`, `too_many_tracks`, and for
 * a usable track that is not the answer, `outvoted` or `split_family` (Bundle M §16.0.4).
 */
export interface AlignAttempt {
  reference: string
  verdict: 'accept' | 'check' | 'refuse' | 'skipped'
  reason: string
}

/**
 * One probed subtitle stream of a media reference (Bundle M §16.0.4). Anonymous: no language, title,
 * path or text. `usable` tracks are on a side; `refused` ran A–I and refused; `excluded` was read and set
 * aside before A–I (unreadable, too large); `unread` could not be extracted; `listed` was never extracted.
 */
export interface AlignTrackEvidence {
  /** 1-based position among the media file's subtitle streams. */
  ordinal: number
  codec: string
  kind: 'text' | 'image' | 'not_text'
  outcome: 'usable' | 'refused' | 'excluded' | 'unread' | 'listed'
  family: number | null
  side: number | null
  verdict: 'accept' | 'check' | 'refuse' | null
  reason: string | null
  /** SHA-256 of the source's moved times, `[[start,end],…]` as JSON; usable tracks only. */
  vectorSha256: string | null
}

export interface AlignArbitrationSide {
  id: number
  /** The ordinal whose result is the side's result. */
  representative: number
  members: number[]
  /** How many independent witnesses (families) the side holds. */
  witnesses: number
}

/** How several usable embedded tracks were decided (Bundle M §16.0.3). */
export interface AlignArbitration {
  /** T, in milliseconds. */
  tolerance: number
  sides: AlignArbitrationSide[]
  /** The winning side's id, or null when nothing won (a conflict). */
  winner: number | null
  /** `audio` when a tie between sides was settled by the speech in the audio. */
  tieBroken: 'audio' | null
  /**
   * For a winning side whose verdict is `check`: the lowest dialogue coverage among its members. A member's
   * `check` makes the side `check` even when the representative's own coverage is higher, and the warning
   * must quote the coverage that made it so.
   */
  checkCoveragePct: number | null
}

/** Numbers and text-free codes only (no subtitle line is quoted). */
export interface AlignEvidence {
  /** The reference the verdict is about, e.g. "Subtitle file", "Embedded track 2 (subrip, eng)". */
  reference: string
  sourceCues: number
  referenceCues: number
  sourceDialogue: number
  referenceDialogue: number
  coveragePct: number | null
  retainedPct: number | null
  pairs: number | null
  retained: number | null
  vote: number | null
  overlap: number | null
  scale: number | null
  offsetMs: number | null
  residualAbsMedianMs: number | null
  residualAbsP95Ms: number | null
  /**
   * The file was already aligned and its own times were kept. The figures then describe the file as it
   * is (identity map), never the fitted map that was set aside; that one stays in the contract's evidence.
   */
  keptIdentity?: true
  /**
   * Read with repair: a side whose only problems were subtitles out of time order and subtitles ending
   * when or before they start, on at most 1 in 10, was analysed on a tidied copy. Counts only.
   */
  repairs?: AlignRepair[]
  issues: string[]
  attempts: AlignAttempt[]
  /** A media reference's subtitle streams, one per probed stream (Bundle M). Absent on every other chain. */
  tracks?: AlignTrackEvidence[]
  /** Present when at least one embedded text track was usable (Bundle M). */
  arbitration?: AlignArbitration
}

/** One side read with repair; the page shows one line per entry. */
export interface AlignRepair {
  side: 'source' | 'reference'
  outOfOrder: number
  endAtOrBeforeStart: number
}

/** One source cue before and after. `text` is the user's own line, shown in the preview only. */
export interface AlignPreviewRow {
  index: number
  startMs: number
  endMs: number
  newStartMs: number
  newEndMs: number
  text: string
}

export interface AlignPreview {
  total: number
  from: number
  rows: AlignPreviewRow[]
}

/** What the transcription fallback will cost and do, so the user can decide (C.4, tester 2026-10-07). */
export interface AlignTranscriptionOffer {
  token: string
  model: string
  /**
   * Where the consented Transcribe run writes its transcript: a file in main's own scratch folder, read
   * back by main under `token` and removed afterwards. The renderer passes it to the normal Transcribe
   * run as that run's output and never names it to Align.
   */
  outputPath: string
  audioSeconds: number
  /** Requests the run will make: one per transcription chunk. */
  requests: number
  /** Expected wall-clock range in minutes, low and high. */
  estimateMinutes: [number, number]
}

export type AlignAnalysis =
  | {
      status: 'result'
      generation: number
      resultId: string
      verdict: 'accept' | 'check'
      reason: 'ok' | 'partial_coverage'
      evidence: AlignEvidence
      preview: AlignPreview
      /** Temporary folders (possibly holding transcript text) Align has not managed to delete yet. */
      cleanupNotice?: string
      /** Main always sets the three fields below; they are optional only so older shapes still type. */
      mode?: AlignmentMode
      /** The shared contract (`./alignment`) for the verdict this result carries. */
      alignment?: AlignmentResult
      advanced?: AlignAdvancedDiagnostics
      /** Set when `align:export-diagnostic` can export this outcome's timing diagnostic (Bundle M §16.0.6). */
      diagnosticExportable?: true
    }
  | {
      status: 'refused'
      generation: number
      verdict: 'refuse'
      reason: Exclude<AlignMatchReason, 'ok' | 'partial_coverage'> | AlignStopReason
      message: string
      evidence: AlignEvidence | null
      transcriptionOffer?: AlignTranscriptionOffer
      cleanupNotice?: string
      mode?: AlignmentMode
      /** Set when an A–I verdict refused; null when the analysis stopped before one (a stop reason). */
      alignment?: AlignmentResult | null
      advanced?: AlignAdvancedDiagnostics
      diagnosticExportable?: true
    }
  | { status: 'cancelled'; generation: number }
  | { status: 'stale'; generation: number }

export interface AlignPreviewRequest {
  generation: number
  resultId: string
  from: number
  count: number
}

export interface AlignApplyRequest {
  generation: number
  resultId: string
}

export type AlignApplyResult =
  | { ok: true; path: string }
  | {
      ok: false
      /** `changed`: the held candidate no longer matches its own digests, so it was dropped unwritten (Bundle M). */
      code: 'cancelled' | 'stale' | 'source_changed' | 'changed' | 'same_as_source' | 'invalid_destination' | 'write_failed'
      message: string
    }

/**
 * What replaying a timing diagnostic gave (Bundle M §16.0.6). Replay-only: it carries no result id and can
 * never preview, apply or write a subtitle. Counts and codes only.
 */
export interface AlignDiagnosticReplay {
  stage: 'ai' | 'arbitration'
  verdict: 'accept' | 'check' | 'refuse'
  reason: string
  transform: { scale: number; offsetMs: number } | null
  keptIdentity: boolean
  /** Every stored A–I call, and the arbitration when there was one, came out exactly as recorded. */
  matches: boolean
  /** Text-free codes for what differed, e.g. `call:2:verdict`, `arbitration:winner`. */
  mismatches: string[]
  sourceCues: number
  calls: number
  tracks: number
  sides: number
  winner: number | null
  tieBroken: 'audio' | null
}

/** Bundle M: export is keyed by the live generation alone; main chooses the file. */
export interface AlignDiagnosticExportRequest {
  generation: number
}

export type AlignDiagnosticExportResult =
  | { ok: true; path: string }
  | { ok: false; code: 'not_exportable' | 'stale' | 'cancelled' | 'write_failed'; message: string }

export type AlignDiagnosticOpenResult =
  | { ok: true; applicable: false; replay: AlignDiagnosticReplay }
  | { ok: false; code: 'cancelled' | 'too_large' | 'unreadable' | 'invalid'; message: string }

/** `align:progress`: the running analysis's step, in words, and its percentage when it has one. */
export interface AlignProgress {
  generation: number
  label: string
  pct: number | null
}
