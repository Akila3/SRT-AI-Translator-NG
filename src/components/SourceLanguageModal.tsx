/**
 * The spoken-language question the dedicated transcription model needs before it runs
 * (feature_decisions.md D5-17, D5-13, D5-14). AUTHORED-BY: opus-5.5-high
 *
 * Shown by the Transcribe page as the last step of Start, and only when the model about to run is the
 * dedicated one. It is a modal on purpose: a plausible wrong code costs most of the transcript with no
 * error, so the user must look at the answer once. Detection only pre-fills it; when detection
 * abstained the field is empty and Start is refused until a language is picked. Exactly one bare code
 * leaves it. Nothing here talks to main.
 */
import React, { useEffect, useState } from 'react'
import { Button, Select, Spinner } from './ui'
import { TARGET_LANGUAGES, langLabel } from '../../electron/shared/languages'
import type { SourceLanguageDetectResult } from '../../electron/shared/types'

/** What the detection pass said; `detecting` while it runs. */
export type SourceLanguageDetectionView = { kind: 'detecting' } | SourceLanguageDetectResult

export const SOURCE_LANGUAGE_COPY = {
  title: 'Which language is spoken in this file?',
  why:
    'gemini-3.5-transcribe writes down one language per file: the one you choose here. If the choice is wrong, ' +
    'most of the transcript is lost without any error. What comes back is short, in the right script, and nothing says lines are missing.',
  detecting: 'Listening to six short samples from across the file…',
  detected: (label: string) => `Detected from six short samples across the file: ${label}. Check it before you start.`,
  abstained: {
    zxx: 'No speech was heard in the samples, so the language could not be detected. Choose it to continue.',
    disagreement: 'The samples did not agree on one language. Choose the main spoken language to continue.',
    unrecognised: 'The answer was not a language this app knows. Choose it to continue.',
    failed: 'Detection did not finish. Choose the language to continue.',
    unavailable:
      'Not detected: the translation model chosen in Settings is a transcription model, and only a general model can recognise a language. Choose it to continue.'
  },
  placeholder: 'Choose a language…',
  trade:
    'Prefer not to choose? Cancel and pick a general model, such as gemini-3.7-flash, on the Transcribe tab. It needs no language. ' +
    'For the same 12 minutes it uses about 29k tokens where this model uses about 18k, and its timestamps are whole seconds where this model’s are 100 ms.',
  confirmLabel: 'Transcribe',
  cancelLabel: 'Cancel'
} as const

const BARE = /^[a-z]{2,3}$/

/** One option per language the model is sent: bare codes only, named for speech rather than writing. */
export function sourceLanguageChoices(): { value: string; label: string }[] {
  return TARGET_LANGUAGES.filter((l) => BARE.test(l.value)).map((l) => ({ value: l.value, label: l.value === 'zh' ? 'Chinese' : l.label }))
}

export interface SourceLanguageModalView {
  /** The picker's starting value: the detected code, or empty. */
  initial: string
  note: string
  detecting: boolean
}

export function sourceLanguageModalView(detection: SourceLanguageDetectionView): SourceLanguageModalView {
  if (detection.kind === 'detecting') return { initial: '', note: SOURCE_LANGUAGE_COPY.detecting, detecting: true }
  if (detection.kind === 'detected' && confirmedSourceCode(detection.code)) {
    const code = confirmedSourceCode(detection.code)!
    return { initial: code, note: SOURCE_LANGUAGE_COPY.detected(code === 'zh' ? 'Chinese' : langLabel(code)), detecting: false }
  }
  const reason = detection.kind === 'abstained' ? detection.reason : 'unrecognised'
  return { initial: '', note: SOURCE_LANGUAGE_COPY.abstained[reason], detecting: false }
}

/** The one code a confirmation may send, or null: it must be a listed bare code. */
export function confirmedSourceCode(choice: string): string | null {
  return sourceLanguageChoices().some((c) => c.value === choice) ? choice : null
}

export function SourceLanguageModal({
  detection,
  busy,
  onConfirm,
  onCancel
}: {
  detection: SourceLanguageDetectionView
  /** A settings write is still pending, or Start is already on its way: confirming waits. */
  busy: boolean
  onConfirm: (code: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const view = sourceLanguageModalView(detection)
  const [choice, setChoice] = useState(view.initial)
  const [touched, setTouched] = useState(false)
  // Detection answers after the dialog opens; it fills the picker only if the user has not picked yet.
  useEffect(() => {
    if (!touched) setChoice(view.initial)
  }, [view.initial, touched])
  const code = confirmedSourceCode(choice)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-language-title"
        aria-describedby="source-language-why"
        className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-800"
      >
        <p id="source-language-title" className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">
          {SOURCE_LANGUAGE_COPY.title}
        </p>
        <p id="source-language-why" className="mt-2 text-sm text-gray-700 dark:text-gray-300">
          {SOURCE_LANGUAGE_COPY.why}
        </p>
        <p className="mt-3 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          {view.detecting && <Spinner />}
          <span>{view.note}</span>
        </p>
        <Select
          className="mt-2 w-full"
          value={choice}
          onChange={(v) => {
            setTouched(true)
            setChoice(v)
          }}
          options={[{ value: '', label: SOURCE_LANGUAGE_COPY.placeholder }, ...sourceLanguageChoices()]}
        />
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{SOURCE_LANGUAGE_COPY.trade}</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {SOURCE_LANGUAGE_COPY.cancelLabel}
          </Button>
          <Button onClick={() => code && onConfirm(code)} disabled={!code || busy}>
            {SOURCE_LANGUAGE_COPY.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
