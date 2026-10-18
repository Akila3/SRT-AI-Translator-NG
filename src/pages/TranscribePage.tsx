import React, { useEffect, useState, useRef } from 'react'
import { useStore } from '../store/useStore'
import {
  Box,
  BoxTitle,
  Label,
  FilePicker,
  Button,
  Elapsed,
  ProgressBar,
  LogPanel,
  Select,
  NumberInput,
  ToggleRow,
  Working
} from '../components/ui'
import { ResumeChoice, resumeContinueAction } from '../components/ResumeChoice'
import { InputFilePicker } from '../components/InputFilePicker'
import { FreeTierNotice } from '../components/FreeTierNotice'
import { TokenUsageCard } from '../components/TokenUsageCard'
import { derivedOutputFor } from '../lib/inputSelection'
import { thinkingLevelsForModel } from '../data/freeTier'
import { RESUME_INSPECT_LABEL, RESUME_INSPECT_NOTE, startDecisionFor } from './TranslatePage'
import {
  transcribeFailedDetail,
  transcribeIncompleteDetail,
  transcribeResumableDetail,
  transcribeUnsavedDetail
} from '../../electron/shared/runCopy'
import { failureSentence, useRunner } from '../lib/useRunner'
import { findConsoleLog } from '../../electron/shared/consoleLog'
import { effectiveThinkingLevel, modelCapabilities } from '../../electron/shared/modelCaps'
import {
  resolveTranscribeSettings,
  seedTranscribeOverride,
  transcribeRefusalMessage,
  transcribeEngineWarning,
  dedicatedThinkingReason,
  transcribeDescriptionReason,
  transcribePolishAvailability,
  polishModelProblem,
  POLISH_DESC,
  POLISH_TIP,
  POLISH_MODEL_LABEL,
  POLISH_MODEL_TIP,
  isDedicatedTranscribeModel,
  asksSourceLanguage,
  createSerialPatchQueue
} from '../../electron/shared/transcribeSettings'
import { SourceLanguageModal, type SourceLanguageDetectionView } from '../components/SourceLanguageModal'
import type { AppSettings, ResumeDecision, ResumeInspectResult, ResumeOffer, TranscribeArgs } from '../../electron/shared/types'
import { EMPTY_TRANSCRIPT_SIGNAL, type RunWarning } from '../../electron/shared/engineEvents'

const MEDIA_FILTERS = [
  { name: 'Audio/Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'aac', 'wav', 'm4a', 'flac'] }
]

// D7-8. Still the one `description` hint the model receives; the transcription model takes no system
// instruction (D5-5), so nothing here may suggest one.
export const TRANSCRIBE_CUSTOM_CONTEXT_TIP =
  'Use this optional field to add context or instructions about names, jargon, topic, spelling, or other preferences. It is not required for transcription.\n\n' +
  '• The app already sends everything required.\n\n' +
  '• The field can remain empty.\n\n' +
  '• Its content is only additional guidance.\n\n' +
  '• It supplements rather than replaces built-in instructions.'

/** A completed run's last line: green when the transcript has words, amber when it saved none. */
export function TranscribeDoneLine({ warnings, outputPath }: { warnings: readonly RunWarning[]; outputPath: string }): React.JSX.Element {
  if (warnings.some((w) => w.signals?.includes(EMPTY_TRANSCRIPT_SIGNAL))) {
    return (
      <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
        ⚠ No words were found in this audio. An empty subtitle file was saved → {outputPath}
      </p>
    )
  }
  return <p className="text-sm font-medium text-green-700 dark:text-green-400">✅ Transcription saved → {outputPath}</p>
}

/** Points at an incomplete subtitle in its folder; never offered as the finished output. */
function PartialLink({ file }: { file: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => window.api.showItemInFolder(file)}
      className="mt-1 text-sm text-brand hover:underline"
    >
      Show the incomplete file
    </button>
  )
}

export default function TranscribePage(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const { state, start, stop, reset } = useRunner()
  const [mediaFile, setMediaFile] = useState('')
  const [outputFile, setOutputFile] = useState('')
  const [description, setDescription] = useState('')
  const [startError, setStartError] = useState('')
  /** When this run started, for the clock shown while the engine is preparing in silence. */
  const [runStartedAt, setRunStartedAt] = useState(0)
  /**
   * The audio conversion the app runs before the engine, when the file is one the engine
   * cannot read. Null when there is none — which is the common case, since MP3 and WAV are
   * passed straight through and video is the engine's own job.
   *
   * `startedAt` is derived from the report's own elapsed time rather than from when the first
   * report arrived: ffmpeg needs a moment to open a large file, and a clock that started late
   * would quietly under-report every conversion.
   */
  const [convert, setConvert] = useState<{ pct: number | null; startedAt: number } | null>(null)
  const startOwned = useRef(false)
  /** Phase 3 (Step 3.6): the native offer waiting for Continue or Start over, with the Start that found it. */
  const [resumeChoice, setResumeChoice] = useState<{ offer: ResumeOffer; args: TranscribeArgs } | null>(null)
  /** When the whole-media resume inspection started; 0 when none is running. */
  const [resumeCheckSince, setResumeCheckSince] = useState(0)
  /** Bumped when the media or output changes, and by New: a late inspection or a stale offer is dropped. */
  const resumeEpoch = useRef(0)
  /**
   * Override writes go through this queue, not `patch` directly. `patch` only updates
   * the store after IPC returns, so Start against getState() during a pending write
   * would still send the previous model (SOL-55).
   */
  const [savePending, setSavePending] = useState(0)
  /** D5-17: the spoken-language question for a dedicated run, open while Start waits on the answer. */
  const [languageAsk, setLanguageAsk] = useState<SourceLanguageDetectionView | null>(null)
  const languageAnswer = useRef<((code: string | null) => void) | null>(null)
  /** Bumped per question, so a detection that lands after the answer cannot refill a later one. */
  const languageEpoch = useRef(0)
  useEffect(
    () => () => {
      languageAnswer.current?.(null)
      languageAnswer.current = null
    },
    []
  )
  const saveQueue = useRef<ReturnType<typeof createSerialPatchQueue<Partial<AppSettings>>> | null>(null)
  if (saveQueue.current === null) {
    saveQueue.current = createSerialPatchQueue(
      (p) => useStore.getState().patch(p),
      setSavePending
    )
  }

  useEffect(() => {
    const derived = derivedOutputFor(mediaFile, outputFile)
    if (derived !== null) setOutputFile(derived)
  }, [mediaFile, outputFile])

  useEffect(() => {
    resumeEpoch.current += 1
    setResumeChoice(null)
  }, [mediaFile, outputFile])

  useEffect(
    () =>
      window.api.onFfmpegProgress((p) => {
        // Only this page's own preparation. An export started on the Translate page can be
        // running at the same time, under a different lock, and is none of this page's business.
        if (p.kind !== 'convert') return
        setConvert((cur) =>
          // `done` is the only thing that ends this box: the conversion happens inside a job
          // the renderer never awaits, so there is no promise here to hang the ending on.
          p.done
            ? null
            : // The clock is anchored once, on the first report. Recomputing it every tick
              // would restart the timer that draws it and make the seconds stutter.
              { pct: p.pct, startedAt: cur?.startedAt ?? Date.now() - p.elapsedMs }
        )
      }),
    []
  )

  if (!settings) return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading…</div>

  // Capabilities and argv must follow the model this page will actually send, which is
  // the override when the toggle is on and Settings otherwise. Reading `settings.model`
  // here would validate one model and run another.
  const resolved = resolveTranscribeSettings(settings)
  const caps = modelCapabilities(resolved.model)
  const engineWarning = transcribeEngineWarning(resolved.model)
  const thinkingGreyed = dedicatedThinkingReason(resolved.model)
  const descriptionReason = transcribeDescriptionReason(resolved.model)
  const polish = transcribePolishAvailability(resolved.model)
  const polishOn = polish.available && settings.transcribePolish
  const polishProblem = polishModelProblem(settings)
  const isRunning = state.status === 'running'
  const overrideLive = settings.transcribeOverride && !isRunning
  /**
   * Where this run's console was written. Unlike Translate's, this path is already the final
   * one — there is no temp original and no copy — so it is used exactly as it arrives.
   */
  const consoleLog = findConsoleLog(state.logPaths)
  const abortExplain = failureSentence(state, 'transcribe')

  // A Select whose value is absent from its options renders BLANK, which reads as "no
  // model selected" even though one is stored. Settings keeps the id visible in that case;
  // this field must too, or the two pages disagree about what will run.
  const modelOptions = settings.cachedModels.map((m) => ({ value: m.id, label: m.label }))
  if (resolved.model && !settings.cachedModels.some((m) => m.id === resolved.model)) {
    modelOptions.unshift({ value: resolved.model, label: `${resolved.model} (not in fetched list)` })
  }
  // The same rule for the polishing model, whose list leaves out the models that cannot edit text.
  const polishModelOptions = [
    { value: '', label: `Same as translation model (${settings.model || 'none set'})` },
    ...settings.cachedModels.filter((m) => !isDedicatedTranscribeModel(m.id)).map((m) => ({ value: m.id, label: m.label }))
  ]
  if (settings.transcribePolishModel && !polishModelOptions.some((o) => o.value === settings.transcribePolishModel)) {
    polishModelOptions.splice(1, 0, { value: settings.transcribePolishModel, label: `${settings.transcribePolishModel} (not in fetched list)` })
  }

  /**
   * The run as this page's current settings describe it. Null, with the reason shown, when a queued
   * model choice could not be saved or the model cannot transcribe.
   */
  async function currentArgs(media: string, output: string): Promise<TranscribeArgs | null> {
    // The store is only updated after setSettings resolves. Wait out every override
    // write queued from this page, then re-resolve, so Start sends the selection the
    // user just made rather than the previous one (SOL-55). A failed persist must
    // not fall through to launching that previous selection.
    const persistError = await saveQueue.current!.idle()
    if (persistError) {
      setStartError(
        'Could not save the transcription model selection, so the run was not started. ' +
          'Check the model and thinking values and try again.'
      )
      return null
    }
    const s = useStore.getState().settings
    if (!s) return null
    const run = resolveTranscribeSettings(s)
    // The engine refuses transcription outright for anything that is not a Gemini 2.5/3.x
    // model, so say so here instead of spawning a job that exits immediately. The model
    // named is the resolved one — the id this run would send — and the remedy points at
    // the picker that can actually change it.
    if (!modelCapabilities(run.model).supportsTranscription) {
      setStartError(transcribeRefusalMessage(run.model, s.transcribeOverride))
      return null
    }
    const args: TranscribeArgs = {
      mediaFile: media,
      outputFile: output,
      targetLang: '',
      model: run.model,
      apiKeys: s.apiKeys,
      thinkingLevel: run.thinkingLevel,
      thinkingBudget: run.thinkingBudget,
      customGenerationParams: s.customGenerationParams,
      temperature: s.temperature,
      topP: s.topP,
      topK: s.topK,
      // Disabled with its reason on screen for the dedicated model, so not sending it is not a silent drop.
      description: (!transcribeDescriptionReason(run.model) && description) || undefined,
      ffmpegPath: s.ffmpegPath || undefined
    }
    return args
  }

  async function launch(args: TranscribeArgs): Promise<void> {
    setRunStartedAt(Date.now())
    setConvert(null)
    await start((runId) => window.api.startTranscribe({ ...args, runId }))
  }

  /**
   * D5-17: the last gate before a dedicated run, after the resume answer. Detection only proposes;
   * nothing launches until the user confirms one code, and Cancel launches nothing. A general model
   * is sent no language, so it never sees the question. Continue never asks either: main runs the
   * saved work's own model, and a dedicated record's own confirmed language, whatever the page shows.
   */
  async function launchConfirmed(args: TranscribeArgs): Promise<void> {
    if (!asksSourceLanguage(args)) return launch(args)
    const ask = ++languageEpoch.current
    const answer = new Promise<string | null>((resolve) => {
      languageAnswer.current = resolve
    })
    setLanguageAsk({ kind: 'detecting' })
    window.api.detectSourceLanguage({ mediaFile: args.mediaFile }).then(
      (found) => {
        if (ask === languageEpoch.current) setLanguageAsk((cur) => (cur ? found : cur))
      },
      () => {
        if (ask === languageEpoch.current) setLanguageAsk((cur) => (cur ? { kind: 'abstained', reason: 'failed' } : cur))
      }
    )
    const code = await answer
    if (code) await launch({ ...args, sourceLanguage: code })
  }

  function answerSourceLanguage(code: string | null): void {
    languageEpoch.current += 1
    setLanguageAsk(null)
    if (code === null) void window.api.cancelSourceLanguageDetection()
    const resolve = languageAnswer.current
    languageAnswer.current = null
    resolve?.(code)
  }

  async function handleStart(): Promise<void> {
    if (startOwned.current) return
    setStartError('')
    if (!mediaFile) {
      setStartError('Choose an audio or video file to transcribe.')
      return
    }
    // Claim the start lock before waiting: a second click while a save is in flight
    // must not launch two runs once the queue drains.
    startOwned.current = true
    setResumeChoice(null)
    const resumeAt = resumeEpoch.current
    try {
      const args = await currentArgs(mediaFile, outputFile || mediaFile.replace(/\.[^.]+$/, '') + '.srt')
      if (!args) return
      // Phase 3: main reads the whole media file to look for this job's unfinished work. Outside the
      // run slot, so it can take as long as the film is big; a change of file meanwhile drops the answer.
      setResumeCheckSince(Date.now())
      let found: ResumeInspectResult
      try {
        found = await window.api.inspectResume({ kind: 'transcribe', mediaFile: args.mediaFile, outputFile: args.outputFile })
      } catch (e) {
        setStartError(`Could not check for unfinished work: ${e instanceof Error ? e.message : String(e)}`)
        return
      } finally {
        setResumeCheckSince(0)
      }
      if (resumeAt !== resumeEpoch.current) return
      const next = startDecisionFor(found)
      if ('ask' in next) {
        setResumeChoice({ offer: next.ask, args })
        return
      }
      await launchConfirmed(next.resume ? { ...args, resume: next.resume } : args)
    } finally {
      startOwned.current = false
    }
  }

  /**
   * The user's answer to an offer. Continue sends the record's id with the current credentials; main
   * runs the record's own settings, language and polish included, so the page's model is not judged
   * again. Start over sends the current settings.
   */
  async function chooseResume(action: 'continue' | 'startOver'): Promise<void> {
    const choice = resumeChoice
    if (!choice || startOwned.current || isRunning) return
    if (action === 'continue' && resumeContinueAction(choice.offer) !== 'continue') return
    startOwned.current = true
    try {
      setStartError('')
      const latest = useStore.getState().settings
      const args =
        action === 'continue'
          ? { ...choice.args, apiKeys: latest?.apiKeys ?? choice.args.apiKeys }
          : await currentArgs(choice.args.mediaFile, choice.args.outputFile)
      if (!args) return
      setResumeChoice(null)
      const resume: ResumeDecision = { action, resumeId: choice.offer.resumeId }
      await launchConfirmed({ ...args, resume })
    } finally {
      startOwned.current = false
    }
  }

  function handleNew(): void {
    reset()
    // Page state only: the saved work stays, and the same job's next Start offers it again.
    resumeEpoch.current += 1
    setResumeChoice(null)
    // Source and destination together: the effect at lines 48-52 derives the output
    // only when `mediaFile && !outputFile`, so clearing one alone either orphans a
    // path or immediately regenerates it from the old media file.
    setMediaFile('')
    setOutputFile('')
    setDescription('')
    setStartError('')
    setRunStartedAt(0)
    setConvert(null)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Box className="border-blue-200 bg-blue-50/40 dark:border-blue-900/50 dark:bg-blue-950/30">
        <BoxTitle>About Transcription</BoxTitle>
        <div className="grid grid-cols-2 gap-6 text-sm text-gray-700 dark:text-gray-300">
          <div>
            <div className="mb-1 font-semibold text-gray-900 dark:text-gray-100">When to use it</div>
            <p>
              Use this when you have <em>no subtitle file at all</em> — it listens to the spoken audio
              and generates a brand-new SRT in the original spoken language.
            </p>
          </div>
          <div>
            <div className="mb-1 font-semibold text-gray-900 dark:text-gray-100">What it outputs</div>
            <p>
              A timed .srt transcription. To then translate it, take the result over to the Translate
              tab. Requires FFmpeg for audio extraction.
            </p>
          </div>
        </div>
      </Box>

      <Box>
        <BoxTitle>Input</BoxTitle>
        <div className="space-y-4">
          <div>
            <Label tip="The audio or video file to transcribe. Gemini listens to the audio and produces timed subtitles in the language that is spoken. For video, the audio track is extracted automatically (requires FFmpeg).">
              Audio / Video File
            </Label>
            <InputFilePicker
              value={mediaFile}
              placeholder="Choose an audio or video file"
              filters={MEDIA_FILTERS}
              onSelect={(p) => setMediaFile(p)}
              onClear={() => setMediaFile('')}
            />
          </div>
          <div>
            <Label tip="Where the generated .srt transcription will be written. Defaults to the same folder and name as the input file.">
              Output File
            </Label>
            <FilePicker
              value={outputFile}
              placeholder="Output .srt path"
              onPick={async () => {
                // Destination picker only: no source file. dialog:saveFile must not copy, rename
                // or displace anything on this path (SOL-17). Transcription writes straight to
                // the chosen file later.
                const { path: p } = await window.api.saveFile({
                  defaultName: outputFile || 'transcription.srt'
                })
                if (p) setOutputFile(p)
              }}
              onClear={() => setOutputFile('')}
            />
          </div>
        </div>
      </Box>

      <Box>
        <BoxTitle>Model</BoxTitle>
        <ToggleRow
          label="Use a different model for transcription"
          desc="Off (default): this tab uses the model and thinking values from Settings. On: the choices below are stored here and survive restart."
          checked={settings.transcribeOverride}
          onChange={(on) => {
            if (on) saveQueue.current!.enqueue(seedTranscribeOverride(settings))
            else saveQueue.current!.enqueue({ transcribeOverride: false })
          }}
          disabled={isRunning}
          tip={
            'OFF (default): transcription uses the same model and thinking setting as Translate, from Settings → Model & Generation.\n\n' +
            'ON: this page keeps its own model and thinking values. They are written to disk, so they come back after a restart, and they do not change the Settings used for translation.\n\n' +
            'The thinking control follows the model you pick here: a level dropdown for Gemini 3.x, a budget field for Gemini 2.5, and nothing for a model that has no thinking config. A model that cannot accept audio is refused before anything is sent.'
          }
        />
        <div className="mt-4 flex gap-6">
          <div className="flex-1">
            <Label
              tip={
                settings.transcribeOverride
                  ? 'The model this transcription will use. Stored on this tab; turning the override off returns to Settings without forgetting this choice.'
                  : 'The model used for transcription is taken from Settings → Model & Generation. Turn the override on to pick a different one here.'
              }
            >
              Model{settings.transcribeOverride ? '' : ' (from Settings)'}
            </Label>
            <Select
              value={resolved.model}
              onChange={(v) => saveQueue.current!.enqueue({ transcribeModel: v })}
              disabled={!overrideLive}
              options={modelOptions}
              className="w-full"
            />
          </div>
          {caps.thinking === 'level' && (
            <div className="flex-1">
              <Label tip="Thinking level for this transcription (Gemini 3.x). Default sends no thinking-level flag. Low is usually sufficient.">
                Thinking Level
              </Label>
              <Select
                value={resolved.thinkingLevel}
                onChange={(v) => saveQueue.current!.enqueue({ transcribeThinkingLevel: v })}
                disabled={!overrideLive}
                options={thinkingLevelsForModel(caps.acceptedThinkingLevels, resolved.thinkingLevel)}
                className="w-full"
              />
              {effectiveThinkingLevel(resolved.model, resolved.thinkingLevel) !== resolved.thinkingLevel && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  This model does not support “{resolved.thinkingLevel}” — it will run at “
                  {effectiveThinkingLevel(resolved.model, resolved.thinkingLevel)}”.
                </p>
              )}
            </div>
          )}
          {caps.thinking === 'budget' && (
            <div className="flex-1">
              <Label tip="Thinking budget for this transcription (Gemini 2.5). 0 cannot be delivered — the engine discards it.">
                Thinking Budget
              </Label>
              <NumberInput
                value={resolved.thinkingBudget}
                min={caps.thinkingBudgetMin}
                max={caps.thinkingBudgetMax}
                onChange={(v) => saveQueue.current!.enqueue({ transcribeThinkingBudget: v ?? 512 })}
                disabled={!overrideLive}
                className="w-28"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Range for this model: {caps.thinkingBudgetMin} – {caps.thinkingBudgetMax.toLocaleString()}
              </p>
            </div>
          )}
          {/* D5-18: greyed, not absent, for the dedicated model. Only with the override on — off, Settings shows it greyed. */}
          {caps.thinking === 'none' && settings.transcribeOverride && thinkingGreyed && (
            <div className="flex-1">
              <Label tip={thinkingGreyed}>Thinking Level</Label>
              <Select value="" onChange={() => {}} disabled options={[{ value: '', label: 'Not used by this model' }]} className="w-full" />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{thinkingGreyed}</p>
            </div>
          )}
        </div>
        {!caps.supportsTranscription && (
          <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
            {transcribeRefusalMessage(resolved.model, settings.transcribeOverride)}
          </p>
        )}
        {caps.supportsTranscription && engineWarning && (
          <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">{engineWarning}</p>
        )}
        <div className="mt-4">
          <Label tip={TRANSCRIBE_CUSTOM_CONTEXT_TIP}>Custom Context / Prompt (Optional)</Label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!!descriptionReason}
            rows={2}
            placeholder="Optional — names, jargon, topic…"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:bg-gray-100 disabled:text-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
          />
          {descriptionReason && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{descriptionReason}</p>}
        </div>
        <div className="mt-4">
          <ToggleRow
            label="Polish the wording"
            tip={POLISH_TIP}
            desc={polish.available ? POLISH_DESC : polish.reason}
            checked={polishOn}
            onChange={(on) => saveQueue.current!.enqueue({ transcribePolish: on })}
            disabled={!polish.available || isRunning}
          />
          {/* Only while polishing is on: off, or greyed for a general model, there is nothing to choose. */}
          {polishOn && (
            <div className="ml-12 mt-2 max-w-md">
              <Label tip={POLISH_MODEL_TIP}>{POLISH_MODEL_LABEL}</Label>
              <Select
                value={settings.transcribePolishModel}
                onChange={(v) => saveQueue.current!.enqueue({ transcribePolishModel: v })}
                disabled={isRunning}
                options={polishModelOptions}
                className="w-full"
              />
              {polishProblem && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{polishProblem}</p>}
            </div>
          )}
        </div>
      </Box>

      <Box>
        <BoxTitle>Transcribe</BoxTitle>
        {startError && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{startError}</p>}
        {caps.supportsTranscription && engineWarning && !startError && (
          <p className="mb-3 text-sm text-amber-600 dark:text-amber-400">{engineWarning}</p>
        )}
        <div className="flex items-center gap-2">
          {!isRunning ? (
            // An open resume choice is the way forward; Start would only ask the same question again.
            resumeChoice ? null : (
              <Button
                key="run-start"
                onClick={(e) => {
                  if (e.detail > 1) return
                  void handleStart()
                }}
                disabled={!mediaFile || !caps.supportsTranscription || savePending > 0 || resumeCheckSince > 0}
              >
                Start Transcription
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
              <Button variant="secondary" onClick={() => window.api.showItemInFolder(state.outputPath)}>
                Open folder
              </Button>
              <Button variant="ghost" onClick={handleNew}>
                New
              </Button>
            </>
          )}
        </div>

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
        {languageAsk && (
          <SourceLanguageModal
            detection={languageAsk}
            busy={savePending > 0}
            onConfirm={(code) => answerSourceLanguage(code)}
            onCancel={() => answerSourceLanguage(null)}
          />
        )}

        {(isRunning || state.status === 'done' || state.status === 'error' || state.status === 'stopped') && (
          <div className="mt-4 space-y-3">
            {/*
              Transcription is the worst case for silence and the reason this bar can now be
              indeterminate. The engine extracts the audio, downmixes it and compresses it
              before it says anything at all, and its own ffmpeg calls capture their output
              instead of streaming it — so there is no percentage to be had from them at any
              price short of forking the engine. The clock is what can honestly be shown.
            */}
            <ProgressBar pct={state.progress} indeterminate={isRunning && state.progress === 0} />
            {convert && (
              <Working
                label="Converting the audio to MP3, which is the format the engine reads"
                pct={convert.pct}
                since={convert.startedAt}
              />
            )}
            {isRunning && !convert && state.progress === 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Working for <Elapsed since={runStartedAt} /> — the engine extracts and compresses
                the audio before it reports anything, which on a large video takes several
                minutes.
              </p>
            )}
            {/* Native waits, group switches, Paid fallback and daily stops: one notice, none otherwise. */}
            <FreeTierNotice running={isRunning} budget={state.budget} />
            {settings.showTokenStats && state.tokens && (
              <TokenUsageCard tokens={state.tokens} model={resolved.model} cost={{ estimate: state.costEstimate }} usage={state.usage} />
            )}
            <LogPanel rows={state.log} />
            {/*
              Offered on every ending, not just the good one. Transcription writes this file
              beside an output path the user chose before the run, so unlike Translate there is
              no Save step to attach it to — and the ending that most needs a complete log is the
              one that failed, where there is no output to save at all (REP-1, REP-3).
            */}
            {!isRunning && consoleLog && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                The complete console for this run → {consoleLog}{' '}
                <button
                  onClick={() => window.api.showItemInFolder(consoleLog)}
                  className="text-brand hover:underline"
                >
                  Show it
                </button>
              </p>
            )}
            {state.status === 'done' && <TranscribeDoneLine warnings={state.warnings} outputPath={state.outputPath} />}
            {state.status === 'error' && (
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">
                    {abortExplain ??
                      `Process ended with an error (exit code ${state.exitCode}). Check the log above.`}
                  </p>
                  {/*
                    Not the Stop sentence. The engine can write the .srt and then fail during
                    cleanup, so a nonzero exit is not proof that nothing is on disk (SOL-68).
                  */}
                  <p className="mt-1 text-sm text-red-600/80 dark:text-red-400/80">
                    {/* A native ending whose checkpoint holds the partial (AR3-6); otherwise the old sentences. */}
                    {state.resumable ? (
                      transcribeResumableDetail('error')
                    ) : (
                      <>{state.partialPath ? transcribeIncompleteDetail(state.partialPath) : transcribeFailedDetail()}</>
                    )}
                  </p>
                  {state.partialPath && <PartialLink file={state.partialPath} />}
                </div>
                <Button variant="ghost" onClick={handleNew}>
                  New
                </Button>
              </div>
            )}
            {/*
              A run the user ended is not a failure — see MAN-1. Engine 3.7.0 buffers the
              transcription and writes the .srt once at the end (SF-4 probe 2026-09-02, plus
              stage-3 stops whose .progress showed completed minutes). A Stop therefore leaves
              no partial file. Translate's output stays temporary until Save; that page's
              "Nothing was saved" is accurate. The new engine writes each part as it goes, so a
              Stop there can leave an incomplete file, which the run then names.
            */}
            {state.status === 'stopped' && (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {state.resumable ? (
                      transcribeResumableDetail('stopped')
                    ) : (
                      <>
                        Stopped. {state.partialPath ? transcribeIncompleteDetail(state.partialPath) : transcribeUnsavedDetail()}
                      </>
                    )}
                  </p>
                  {state.partialPath && <PartialLink file={state.partialPath} />}
                </div>
                <Button variant="ghost" onClick={handleNew}>
                  New
                </Button>
              </div>
            )}
          </div>
        )}
      </Box>
    </div>
  )
}
