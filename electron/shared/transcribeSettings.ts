/**
 * What a Transcribe run actually uses, when the page can override Settings.
 *
 * The four `transcribe*` fields live on AppSettings so they survive restart. They are
 * not a schema migration: absent keys overlay from defaults (`false` / `''` / `0`).
 * `0` on the budget means "not set" — the engine cannot deliver a zero budget anyway.
 *
 * Every capability decision on the Transcribe page (thinking control, the
 * supportsTranscription refusal, argv) MUST read the resolved model, never
 * `settings.model` alone. Otherwise the page would describe one model and run another.
 */

import { modelCapabilities } from './modelCaps'
import type { AppSettings, TranscribeArgs } from './types'

export interface TranscribeSettingsInput {
  transcribeOverride: boolean
  transcribeModel: string
  transcribeThinkingLevel: string
  transcribeThinkingBudget: number
  model: string
  thinkingLevel: string
  thinkingBudget: number
}

export interface ResolvedTranscribeSettings {
  model: string
  thinkingLevel: string
  thinkingBudget: number
}

/** The model and thinking values a Transcribe run will send. */
export function resolveTranscribeSettings(s: TranscribeSettingsInput): ResolvedTranscribeSettings {
  if (!s.transcribeOverride) {
    return {
      model: s.model,
      thinkingLevel: s.thinkingLevel,
      thinkingBudget: s.thinkingBudget
    }
  }
  return {
    model: s.transcribeModel || s.model,
    thinkingLevel: s.transcribeThinkingLevel || s.thinkingLevel,
    thinkingBudget: s.transcribeThinkingBudget || s.thinkingBudget
  }
}

/**
 * Seed the override fields from the current globals, keeping any values already stored
 * so turning the toggle off and on does not wipe a previous choice.
 */
export function seedTranscribeOverride(s: TranscribeSettingsInput): {
  transcribeOverride: true
  transcribeModel: string
  transcribeThinkingLevel: string
  transcribeThinkingBudget: number
} {
  return {
    transcribeOverride: true,
    transcribeModel: s.transcribeModel || s.model,
    transcribeThinkingLevel: s.transcribeThinkingLevel || s.thinkingLevel,
    transcribeThinkingBudget: s.transcribeThinkingBudget || s.thinkingBudget
  }
}

/**
 * Pre-flight refusal for a model the engine will not transcribe. Audio-incapable
 * (not Gemini 2.5/3.x) is a hard stop. Dedicated transcription models are a different
 * case: they can be selected (`supportsTranscription` stays true) and get
 * `transcribeEngineWarning` instead of this refusal.
 */
export function transcribeRefusalMessage(model: string, override: boolean): string {
  const where = override
    ? 'pick a different model above'
    : 'pick a different model in Settings → Model & Generation'
  return `Transcription requires a Gemini 2.5 or 3.x model. "${model}" cannot transcribe — ${where}.`
}

/**
 * Dedicated transcription ids (`transcribe` in the id). The app sends them their own request — the
 * audio, one language code and word timing, no instruction and no schema — so they run; what the
 * user needs is the trade against a general model (feature_decisions.md D5-14).
 * Distinct from `transcribeRefusalMessage`, which is the audio-incapable hard stop.
 *
 * REP-33: the substring is not enough. A stored or future id can contain `transcribe`
 * and still fail `supportsTranscription` (e.g. `gemini-2.0-transcribe`). That case is
 * the hard-stop UI; this warning is only the overlay on a model that can actually be started.
 */
export function isDedicatedTranscribeModel(model: string): boolean {
  return (model || '').toLowerCase().includes('transcribe')
}

/** What was measured about a general model and two languages, and no more (implementation_plan.md §9.8b, U20). */
export const GENERAL_MODEL_MULTILINGUAL_NOTE =
  'In one 60-second test with two languages, a general model kept both. That has not been shown for a full-length film.'

/**
 * `null` when the resolved model is not a startable dedicated transcription id. Both sides of the
 * trade: the one-language limit, and the lower cost and finer timing that are its upside.
 */
export function transcribeEngineWarning(model: string): string | null {
  if (!isDedicatedTranscribeModel(model)) return null
  if (!modelCapabilities(model).supportsTranscription) return null
  return (
    `"${model}" is the dedicated transcription model. It writes down one language per file, the one you confirm ` +
    'when you press Start, and drops speech in any other language without saying so. In return it is cheaper and ' +
    'more precise: about 18k tokens for 12 minutes of audio where a general model such as gemini-3.7-flash uses ' +
    'about 29k, and timestamps to 100 ms where a general model’s are whole seconds. A general model needs no ' +
    `language. ${GENERAL_MODEL_MULTILINGUAL_NOTE}`
  )
}

/**
 * Whether a launch asks for the spoken language first (D5-17): only a dedicated model the page will
 * run. Continue runs the saved work's own model, and its own language, whatever the page shows.
 */
export function asksSourceLanguage(args: Pick<TranscribeArgs, 'model' | 'resume'>): boolean {
  return args.resume?.action !== 'continue' && isDedicatedTranscribeModel(args.model)
}

/** Why the thinking control is greyed for a dedicated id (D5-18); sampling is greyed in Settings for the same reason. */
export function dedicatedThinkingReason(model: string): string | null {
  if (!isDedicatedTranscribeModel(model) || !modelCapabilities(model).supportsTranscription) return null
  return 'This model takes no thinking setting, and Temperature, Top-P and Top-K from Settings are not sent to it.'
}

/**
 * Why Custom Context is disabled for a dedicated id. Measured: the model bills for a text part and
 * does not follow it, so sending the field would charge for nothing and dropping it silently would
 * discard what was typed.
 */
export function transcribeDescriptionReason(model: string): string | null {
  if (!isDedicatedTranscribeModel(model) || !modelCapabilities(model).supportsTranscription) return null
  return 'Not used by this model: it does not follow written instructions (a test showed it bills for them and ignores them), so this field is not sent.'
}

/**
 * Whether the dedicated path's wording polish (Stage C) can be switched on, and why not: only when the
 * model that will transcribe is the dedicated one. Which model polishes is a separate choice
 * (`polishModelProblem`).
 */
export function transcribePolishAvailability(transcribeModel: string): { available: true } | { available: false; reason: string } {
  if (!isDedicatedTranscribeModel(transcribeModel) || !modelCapabilities(transcribeModel).supportsTranscription) {
    return { available: false, reason: 'Only for gemini-3.5-transcribe. A general model writes finished lines itself.' }
  }
  return { available: true }
}

/** The polishing model: the Transcribe tab's choice, or the Settings translation model when none is chosen. */
export function polishModelOf(s: Pick<AppSettings, 'model' | 'transcribePolishModel'>): string {
  return (s.transcribePolishModel || '').trim() || s.model
}

/** Why the polishing model cannot edit text, or null when it can. Polishing is skipped while this is set. */
export function polishModelProblem(s: Pick<AppSettings, 'model' | 'transcribePolishModel'>): string | null {
  const model = polishModelOf(s)
  const fromSettings = !(s.transcribePolishModel || '').trim()
  if (!model.trim()) return 'No translation model is set in Settings. Pick a polishing model here, or polishing is skipped.'
  if (!isDedicatedTranscribeModel(model)) return null
  return fromSettings
    ? `The translation model in Settings, "${model}", is a transcription model and cannot edit text. Pick a polishing model here, or polishing is skipped.`
    : `"${model}" is a transcription model and cannot edit text. Pick another polishing model, or polishing is skipped.`
}

/** A model picked here, not Settings', runs at this thinking level; it is the level the polishing was measured at. */
export const POLISH_OWN_THINKING_LEVEL = 'low'

export const POLISH_DESC =
  'After the lines are built, a text model fixes wording mistakes the transcription model makes, 50 subtitles at a time. ' +
  'It never moves, merges or splits a line, and an edit that does not match its own subtitle is thrown away. If polishing fails, the unpolished subtitles are saved.'

export const POLISH_TIP =
  'What it is: gemini-3.5-transcribe writes down every word exactly as spoken, with its time, so fillers, stutters, missing punctuation and misheard words stay in. ' +
  'Polishing sends the finished subtitle texts, never their times, to a general text model, which removes fillers and stutters, fixes punctuation and grammar, and corrects words that were clearly misheard.\n\n' +
  'When it can be used: only when the model that will transcribe is gemini-3.5-transcribe, chosen in Settings or in the override above. A general model writes finished lines itself, so the switch is greyed for it. When it can be used it is on unless you turn it off.\n\n' +
  'Why it is safe: each subtitle keeps its own time, so its words must stay in it. An edit that moved words to another subtitle, merged two, cut one short or took another subtitle\u2019s text is thrown away, and that subtitle keeps its transcribed wording.\n\n' +
  'What it costs: one extra request for every 50 subtitles, on the polishing model chosen below. On a 66-minute lecture, gemini-3.7-flash added about a third to the transcription\u2019s cost and a little under half to its time.'

export const POLISH_MODEL_LABEL = 'Polishing model'

export const POLISH_MODEL_TIP =
  'Which model edits the text. \u201cSame as translation model\u201d uses the model and thinking level from Settings \u2192 Model & Generation. Any other model runs at Low thinking and changes nothing in Settings.\n\n' +
  'How to choose: tested on three full recordings, in Hebrew, English and Japanese, gemini-3.7-flash made about two to three times as many corrections as gemini-3.5-flash-lite and caught more misheard words. ' +
  'gemini-3.5-flash-lite was about two and a half times as fast and a fifth to a third cheaper, but leaves more mistakes in place. With either model, an edit that does not match its own subtitle is thrown away.\n\n' +
  'Transcription models cannot edit text, so they are not offered.'

/**
 * What main lets through to a Transcribe run, judged on the model that will actually run (the saved
 * record's on Continue): one bare confirmed code only for a dedicated model, and the polish only when
 * its toggle is on and its model can edit text. A general model gets neither.
 */
export function dedicatedTranscribeArgs(
  args: TranscribeArgs,
  s: Pick<AppSettings, 'model' | 'thinkingLevel' | 'thinkingBudget' | 'transcribePolish' | 'transcribePolishModel'>,
  runModel: string = args.model
): TranscribeArgs {
  const { sourceLanguage, polish: _fromRenderer, ...rest } = args
  void _fromRenderer
  if (!isDedicatedTranscribeModel(runModel)) return rest
  const code = typeof sourceLanguage === 'string' && /^[a-z]{2,3}$/.test(sourceLanguage) ? sourceLanguage : undefined
  const model = polishModelOf(s)
  const ownSettings = model === s.model
  const polish =
    s.transcribePolish === true && transcribePolishAvailability(runModel).available && !polishModelProblem(s)
      ? ownSettings
        ? { model, thinkingLevel: s.thinkingLevel, thinkingBudget: s.thinkingBudget }
        : { model, thinkingLevel: POLISH_OWN_THINKING_LEVEL, thinkingBudget: 0 }
      : undefined
  return { ...rest, ...(code ? { sourceLanguage: code } : {}), ...(polish ? { polish } : {}) }
}

/**
 * Serialise async writes so a later patch cannot land before an earlier one, and so
 * Start can wait until the store actually holds the selection the user just made.
 *
 * `useStore.patch` only updates after `setSettings` resolves. Overlapping calls would
 * otherwise complete out of order, and Start against `getState()` would still see the
 * previous override (SOL-55). This queue is local to the Transcribe page — Settings
 * callers keep using `patch` directly.
 *
 * Rejections do not strand later writes, but they are retained until `idle()`
 * reports and consumes them. `useStore.patch` merges partial payloads, so a later
 * successful write of a different field does not replay a failed one — clearing
 * the error on drain would let Start launch mixed (old model + new level) state.
 * Start must abort when `idle()` returns a message.
 */
export interface SerialPatchQueue<T> {
  enqueue(payload: T): void
  /**
   * Wait until nothing is in flight. `null` means every waited-for write succeeded.
   * A string means at least one write in this batch failed — Start must not launch,
   * even if a later partial write succeeded.
   */
  idle(): Promise<string | null>
  pending(): number
}

export function createSerialPatchQueue<T>(
  apply: (payload: T) => Promise<unknown>,
  onPending?: (n: number) => void
): SerialPatchQueue<T> {
  let tail: Promise<void> = Promise.resolve()
  let n = 0
  let batchErrors: string[] = []
  const bump = (delta: number): void => {
    n += delta
    onPending?.(n)
  }
  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  return {
    enqueue(payload) {
      bump(1)
      tail = tail.then(async () => {
        try {
          await apply(payload)
          bump(-1)
        } catch (err) {
          batchErrors.push(messageOf(err))
          bump(-1)
        }
      })
    },
    async idle() {
      do {
        await tail
      } while (n > 0)
      if (batchErrors.length === 0) return null
      const msg = batchErrors[0]
      batchErrors = []
      return msg
    },
    pending() {
      return n
    }
  }
}
