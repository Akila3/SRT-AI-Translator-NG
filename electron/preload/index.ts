import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  FfmpegPathValidation,
  ModelInfo,
  SubtitleTrack,
  TranslateArgs,
  TranscribeArgs,
  TmdbResult,
  TmdbDetails,
  FfmpegProgress,
  KeyCheck,
  SlotFetchResult,
  RefreshOutcome,
  SaveResult,
  SubtitleInspectRequest,
  SubtitleInspectResult,
  ResumeInspectRequest,
  ResumeInspectResult,
  SourceLanguageDetectRequest,
  SourceLanguageDetectResult,
  AlignAnalyzeRequest,
  AlignAnalysis,
  AlignPreviewRequest,
  AlignPreview,
  AlignApplyRequest,
  AlignApplyResult,
  AlignProgress,
  AlignAdvancedStatus,
  AlignDiagnosticExportRequest,
  AlignDiagnosticExportResult,
  AlignDiagnosticOpenResult,
  OsCheckResult,
  OsSearchResult,
  SubtitleFetchResult,
  WizdomSearchResult
} from '../shared/types'
import type { RunEvent } from '../shared/engineEvents'
import type { QuotaGroupMutation, QuotaGroupMutationResult } from '../shared/quotaGroups'

/**
 * What `models:checkKeys` resolves to. Wider than the old shape because the renderer now
 * needs the per-slot evidence to label keys and explain a partial refresh, instead of
 * being handed a single boolean and left to guess.
 */
export interface CheckKeysResponse {
  results: KeyCheck[]
  slots: SlotFetchResult[]
  models: ModelInfo[]
  unionIds: string[]
  runnableIds: string[]
  activeSlots: number[]
  refreshOutcome: RefreshOutcome
  /**
   * True when the keys changed while they were being checked, so NOTHING from this result
   * was applied. Separate from `refreshOutcome`, which describes how complete the fetch
   * was — a discarded result can be perfectly complete and still describe keys that are no
   * longer there. Treat every other field as informational when this is set.
   */
  discarded: boolean
  /** The selection after the Step 4a rules ran; may differ from what was stored. */
  model: string
  /** Human-readable explanation when a rule fired or the refresh was incomplete. */
  notice: string
  updatedAt: string
  anyValid: boolean
}

/**
 * What the save dialog resolves to.
 *
 * It used to be the subtitle's path alone, and the renderer DERIVED the console log's name from it.
 * That stopped being safe once sidecars are written exclusively: an occupied name is stepped, so
 * the destination is no longer predictable and has to be reported (SOL-12). `path` is `''` when the
 * user cancelled, exactly as the bare string was.
 */
/**
 * Re-exported so existing importers keep working. The declaration itself now lives in
 * `shared/types.ts`, where the MAIN process can see it too — it was declared here alone, so the
 * handler that produces it was unchecked against it, and one branch had gone on returning the bare
 * string this replaced (SOL-15).
 */
export type { SaveResult }

const api = {
  // settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', patch),
  /** The only way a window changes Quota Groups, key assignments or learned limits. */
  mutateQuotaGroup: (mutation: QuotaGroupMutation): Promise<QuotaGroupMutationResult> =>
    ipcRenderer.invoke('settings:mutateQuotaGroup', mutation),

  // models
  getCachedModels: (): Promise<{ models: ModelInfo[]; updatedAt: string | null }> =>
    ipcRenderer.invoke('models:getCached'),
  refreshModels: (
    apiKey: string
  ): Promise<{
    models: ModelInfo[]
    updatedAt: string
    keyValid: boolean
    error: string
    notice: string
  }> => ipcRenderer.invoke('models:refresh', apiKey),
  checkApiKeys: (keys: string[]): Promise<CheckKeysResponse> =>
    ipcRenderer.invoke('models:checkKeys', keys),

  // dialogs
  openFile: (filters?: Electron.FileFilter[]): Promise<string> =>
    ipcRenderer.invoke('dialog:openFile', { filters }),
  openFolder: (): Promise<string> => ipcRenderer.invoke('dialog:openFolder'),
  /**
   * The OS path of a file dropped onto a source field, or '' when it has none. Synchronous, and the
   * only route a dropped `File` takes to a path: no IPC, no file access, nothing read.
   */
  pathForDroppedFile: (file: File): string => {
    try {
      const p = webUtils.getPathForFile(file)
      return typeof p === 'string' ? p : ''
    } catch {
      return ''
    }
  },
  /** Whether a picked FFmpeg override may be stored; checked in main from the filesystem, never run. */
  validateFfmpegPath: (path: string): Promise<FfmpegPathValidation> => ipcRenderer.invoke('ffmpeg:validatePath', path),
  saveFile: (args: {
    srcPath?: string
    defaultName: string
    defaultDir?: string
    logPaths?: string[]
    /** The file the user chose to translate, so the token report can name it instead of a temp path. */
    inputPath?: string
  }): Promise<SaveResult> => ipcRenderer.invoke('dialog:saveFile', args),

  // shell
  showItemInFolder: (p: string): Promise<void> => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  // video
  probeTracks: (filePath: string): Promise<SubtitleTrack[]> =>
    ipcRenderer.invoke('video:probeTracks', filePath),
  extractTrack: (args: {
    filePath: string
    subtitleIndex: number
    isImage: boolean
    defaultName: string
  }): Promise<{ ok: boolean; error?: string; canceled?: boolean; path?: string }> =>
    ipcRenderer.invoke('video:extractTrack', args),
  extractToTemp: (args: {
    filePath: string
    subtitleIndex: number
  }): Promise<{ ok: boolean; error?: string; path?: string }> =>
    ipcRenderer.invoke('video:extractToTemp', args),

  // tmdb
  tmdbSearch: (query: string, type: 'all' | 'movie' | 'tv'): Promise<TmdbResult[]> =>
    ipcRenderer.invoke('tmdb:search', { query, type }),
  tmdbCast: (tmdbId: string, mediaType: 'movie' | 'tv'): Promise<TmdbDetails> =>
    ipcRenderer.invoke('tmdb:cast', { tmdbId, mediaType }),

  // subtitle sources (Bundle H)
  openSubtitlesCheck: (): Promise<OsCheckResult> => ipcRenderer.invoke('opensubtitles:check'),
  openSubtitlesSearch: (query: { imdbId: string; season?: number; episode?: number; languages: string[] }): Promise<OsSearchResult> =>
    ipcRenderer.invoke('opensubtitles:search', query),
  openSubtitlesDownload: (fileId: number, fileName: string, language?: string): Promise<SubtitleFetchResult> =>
    ipcRenderer.invoke('opensubtitles:download', { fileId, fileName, language }),
  wizdomSearch: (query: { imdbId: string; season?: number; episode?: number }): Promise<WizdomSearchResult> => ipcRenderer.invoke('wizdom:search', query),
  wizdomFetch: (id: string, sourcePath?: string): Promise<SubtitleFetchResult> => ipcRenderer.invoke('wizdom:fetch', { id, sourcePath }),
  /** The file a finished run's automatic walk accepted (staged in scratch); null when there is none. */
  referenceAccepted: (runId: string): Promise<{ path: string; name: string; language: string | null } | null> => ipcRenderer.invoke('reference:accepted', runId),
  subtitlesCancel: (): Promise<void> => ipcRenderer.invoke('subtitles:cancel'),

  // subtitle intake
  /** Read a subtitle once and report its encoding, language and receipt (Bundle A). */
  inspectSubtitle: (req: SubtitleInspectRequest): Promise<SubtitleInspectResult> =>
    ipcRenderer.invoke('subtitle:inspect', req),

  // align (Bundle C): main owns the profile, the verdict, the bytes and the destination
  alignAnalyze: (req: AlignAnalyzeRequest): Promise<AlignAnalysis> => ipcRenderer.invoke('align:analyze', req),
  alignCancel: (generation: number): Promise<void> => ipcRenderer.invoke('align:cancel', generation),
  alignPreview: (req: AlignPreviewRequest): Promise<AlignPreview | null> => ipcRenderer.invoke('align:preview', req),
  /** Opens the Save dialog in main; nothing is written unless the user confirms there. */
  alignApply: (req: AlignApplyRequest): Promise<AlignApplyResult> => ipcRenderer.invoke('align:apply', req),
  /** Whether Advanced (piecewise) can run; when it cannot, only Advanced is disabled. */
  alignAdvancedStatus: (): Promise<AlignAdvancedStatus> => ipcRenderer.invoke('align:advanced-status'),
  /** Bundle M: opens main's Save dialog for the live outcome's timing diagnostic; nothing else is written. */
  alignExportDiagnostic: (req: AlignDiagnosticExportRequest): Promise<AlignDiagnosticExportResult> => ipcRenderer.invoke('align:export-diagnostic', req),
  /** Bundle M: opens main's Open dialog and returns a replay; it can never preview or apply. */
  alignOpenDiagnostic: (): Promise<AlignDiagnosticOpenResult> => ipcRenderer.invoke('align:open-diagnostic'),
  onAlignProgress: (cb: (p: AlignProgress) => void): (() => void) => {
    const listener = (_e: unknown, payload: AlignProgress): void => cb(payload)
    ipcRenderer.on('align:progress', listener)
    return () => ipcRenderer.removeListener('align:progress', listener)
  },

  // native resume (Phase 3): read-only; the pickers go in, an opaque offer or null comes back
  inspectResume: (req: ResumeInspectRequest): Promise<ResumeInspectResult> => ipcRenderer.invoke('resume:inspect', req),

  // translate / transcribe
  startTranslate: (args: TranslateArgs): Promise<string> =>
    ipcRenderer.invoke('translate:start', args),
  startTranscribe: (args: TranscribeArgs): Promise<string> =>
    ipcRenderer.invoke('transcribe:start', args),
  // the dedicated model's spoken-language proposal, asked for as Start opens the language modal
  detectSourceLanguage: (req: SourceLanguageDetectRequest): Promise<SourceLanguageDetectResult> =>
    ipcRenderer.invoke('transcribe:detect-language', req),
  cancelSourceLanguageDetection: (): Promise<boolean> => ipcRenderer.invoke('transcribe:cancel-detect-language'),
  stop: (): Promise<boolean> => ipcRenderer.invoke('translate:stop'),
  isRunning: (): Promise<boolean> => ipcRenderer.invoke('translate:isRunning'),

  // streaming events
  /** The typed run stream (`engineEvents.ts`). Both kinds share it, addressed by `runId`. */
  onEngineEvent: (cb: (e: RunEvent) => void): (() => void) => {
    const listener = (_e: unknown, payload: RunEvent): void => cb(payload)
    ipcRenderer.on('engine:event', listener)
    return () => ipcRenderer.removeListener('engine:event', listener)
  },
  /**
   * How far an ffmpeg task has got — a channel of its own, separate from the engine's output
   * stream, so that a tick every half second never lands in the log panel.
   *
   * Every page receives every task, because a transcription's audio conversion and a track
   * export can genuinely overlap; the `kind` field is what lets a page recognise its own.
   */
  onFfmpegProgress: (cb: (p: FfmpegProgress) => void): (() => void) => {
    const listener = (_e: unknown, payload: FfmpegProgress): void => cb(payload)
    ipcRenderer.on('ffmpeg:progress', listener)
    return () => ipcRenderer.removeListener('ffmpeg:progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
