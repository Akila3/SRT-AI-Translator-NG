/**
 * The review a pending failed section opens from Continue (implementation_plan.md Step 3.5,
 * feature_decisions.md AR3-7). AUTHORED-BY: opus-5.5-high
 *
 * It starts at the failed request's own model, size and context, and lets the user change them for this
 * retry only: another model, a smaller size, or context switched off — never on when the failed request
 * had none. Nothing here writes Settings or talks to main: the page sends the chosen retry through the
 * same Start the run uses, and Cancel goes back to the Continue / Start over choice.
 */
import React, { useState } from 'react'
import { Button, Label, NumberInput, Select, Toggle } from './ui'
import { modelCapabilities } from '../../electron/shared/modelCaps'
import type { FailedSpanRetryDecision, ModelInfo, ResumeOffer } from '../../electron/shared/types'

export const FAILED_BATCH_RETRY_COPY = {
  title: 'Retry failed section',
  model: 'Model',
  batchSize: 'Batch size',
  context: 'Include previous context',
  retry: 'Retry section',
  cancel: 'Cancel',
  note: 'A successful retry pauses again. Choose Continue to resume later sections.'
} as const

export type RetryOffer = Extract<ResumeOffer, { nextAction: 'retryFailedSpan' }>

export interface RetryForm {
  model: string
  batchSize: number | null
  useContext: boolean
}

/** The failed request as it ran: its model, its effective size for this section, its context. */
export function retryDefaults(offer: RetryOffer): RetryForm {
  return { model: offer.failedSpan.originalModel, batchSize: offer.failedSpan.maxBatchSize, useContext: offer.failedSpan.contextEnabled }
}

/** The translation models the user can pick now, with the original kept visible if the list lacks it. */
export function retryModelOptions(cached: readonly ModelInfo[], original: string): { value: string; label: string }[] {
  const options = cached.filter((m) => modelCapabilities(m.id).structuredOutput).map((m) => ({ value: m.id, label: m.label }))
  if (original && !options.some((o) => o.value === original)) options.unshift({ value: original, label: `${original} (not in fetched list)` })
  return options
}

/** The retry to send, or null while the form does not describe one this section allows. */
export function retryDecisionFor(offer: RetryOffer, form: RetryForm): FailedSpanRetryDecision | null {
  const size = form.batchSize
  if (!form.model.trim() || size === null || !Number.isSafeInteger(size) || size < 1 || size > offer.failedSpan.maxBatchSize) return null
  if (form.useContext && !offer.failedSpan.contextEnabled) return null
  return { action: 'retryFailedSpan', resumeId: offer.resumeId, model: form.model.trim(), batchSize: size, useContext: form.useContext }
}

export function FailedBatchRetry({
  offer,
  models,
  busy,
  onRetry,
  onCancel
}: {
  offer: RetryOffer
  models: readonly ModelInfo[]
  /** A decision is being sent: both actions wait for it. */
  busy: boolean
  onRetry: (decision: FailedSpanRetryDecision) => void
  onCancel: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<RetryForm>(() => retryDefaults(offer))
  const decision = retryDecisionFor(offer, form)
  const most = offer.failedSpan.maxBatchSize
  return (
    <div
      role="dialog"
      aria-labelledby="failed-batch-retry-title"
      className="mt-4 rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25"
    >
      <p id="failed-batch-retry-title" className="text-sm font-semibold text-amber-900 dark:text-amber-200">
        {FAILED_BATCH_RETRY_COPY.title}
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label>{FAILED_BATCH_RETRY_COPY.model}</Label>
          <Select value={form.model} onChange={(model) => setForm({ ...form, model })} options={retryModelOptions(models, offer.failedSpan.originalModel)} disabled={busy} />
        </div>
        <div>
          <Label>{FAILED_BATCH_RETRY_COPY.batchSize}</Label>
          <NumberInput value={form.batchSize} onChange={(batchSize) => setForm({ ...form, batchSize })} min={1} max={most} step={1} disabled={busy} />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Toggle
          checked={form.useContext}
          onChange={(useContext) => setForm({ ...form, useContext })}
          disabled={busy || !offer.failedSpan.contextEnabled}
        />
        <span className="text-sm text-amber-900 dark:text-amber-200">{FAILED_BATCH_RETRY_COPY.context}</span>
      </div>
      <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">{FAILED_BATCH_RETRY_COPY.note}</p>
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={() => decision && onRetry(decision)} disabled={!decision || busy}>
          {FAILED_BATCH_RETRY_COPY.retry}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {FAILED_BATCH_RETRY_COPY.cancel}
        </Button>
      </div>
    </div>
  )
}
