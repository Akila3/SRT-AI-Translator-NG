/**
 * The choice a native Start offers when the job has unfinished work (implementation_plan.md Step 3.4,
 * feature_decisions.md AR3-6). AUTHORED-BY: opus-5.5-high
 *
 * Exactly two actions and no third: Continue with the record's frozen behaviour, or Start over with the
 * current settings. An offer that cannot continue keeps Continue visible but disabled and says why, so
 * the only destructive action is the user's own click on Start over. Nothing here talks to main: the
 * page turns the click into the start decision it sends.
 */
import React from 'react'
import { Button } from './ui'
import { RESUME_INVALID_REASON_COPY, type ResumeOffer } from '../../electron/shared/types'

export const RESUME_CHOICE_COPY = {
  title: 'Unfinished work found',
  continueBody: 'Continue with the original run settings, or start over with the current settings.',
  retryBody: 'The failed subtitle section is ready to retry. Continue to review retry settings, or start over with the current settings.',
  invalidTitle: 'Saved work cannot continue',
  invalidTail: 'Start over to discard only the app-owned resumable work and use current settings.',
  continueLabel: 'Continue',
  startOverLabel: 'Start over'
} as const

export interface ResumeChoiceView {
  title: string
  body: string
  continueEnabled: boolean
}

/** What the dialog says for an offer, branch by branch. */
export function resumeChoiceView(offer: ResumeOffer): ResumeChoiceView {
  if (offer.state === 'invalid') {
    return { title: RESUME_CHOICE_COPY.invalidTitle, body: `${RESUME_INVALID_REASON_COPY[offer.reason]} ${RESUME_CHOICE_COPY.invalidTail}`, continueEnabled: false }
  }
  return {
    title: RESUME_CHOICE_COPY.title,
    body: offer.nextAction === 'retryFailedSpan' ? RESUME_CHOICE_COPY.retryBody : RESUME_CHOICE_COPY.continueBody,
    continueEnabled: true
  }
}

/**
 * What Continue does. A pending failed section opens the retry dialog on the page without taking the
 * run slot (AR3-7); main refuses a plain continue until that section is covered.
 */
export function resumeContinueAction(offer: ResumeOffer): 'continue' | 'retryDialog' | null {
  if (offer.state !== 'valid') return null
  return offer.nextAction === 'retryFailedSpan' ? 'retryDialog' : 'continue'
}

export function ResumeChoice({
  offer,
  busy,
  onContinue,
  onStartOver
}: {
  offer: ResumeOffer
  /** A decision is being sent: both actions wait for it. */
  busy: boolean
  onContinue: () => void
  onStartOver: () => void
}): React.JSX.Element {
  const view = resumeChoiceView(offer)
  return (
    <div
      role="dialog"
      aria-labelledby="resume-choice-title"
      aria-describedby="resume-choice-body"
      className="mt-4 rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25"
    >
      <p id="resume-choice-title" className="text-sm font-semibold text-amber-900 dark:text-amber-200">
        {view.title}
      </p>
      <p id="resume-choice-body" className="mt-1 text-sm text-amber-800 dark:text-amber-300">
        {view.body}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={onContinue} disabled={!view.continueEnabled || busy}>
          {RESUME_CHOICE_COPY.continueLabel}
        </Button>
        <Button variant="secondary" onClick={onStartOver} disabled={busy}>
          {RESUME_CHOICE_COPY.startOverLabel}
        </Button>
      </div>
    </div>
  )
}
