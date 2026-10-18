import React, { useEffect, useState } from 'react'
import type { BudgetSnapshot } from '../../electron/shared/engineEvents'
import type { RunAdvice } from '../lib/useRunner'
import { openExternalLink } from '../lib/openExternal'

const AI_STUDIO_USAGE = 'https://aistudio.google.com/usage'

/**
 * Bundle F's one run notice (implementation_plan.md §12.9, Option A), shared by Translate and
 * Transcribe. It draws only an action the run is taking: a resize, a wait, a budget-caused Quota
 * Group switch, a switch to a Paid key, or a daily stop. Everything else — a normal fit, unknown
 * limits, an ordinary invalid-key fallback — renders nothing. AUTHORED-BY: opus-5.5-high
 *
 * The countdown is local to this component: it is derived from the snapshot's `untilEpochMs` every
 * second and never from a captured number. It authorises nothing; the run's own timer decides when
 * it sends.
 */

/** Whole seconds left until `untilEpochMs`; never negative. */
export function remainingSeconds(untilEpochMs: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((untilEpochMs - now) / 1000))
}

/** `1 hour 2 minutes 5 seconds`: non-zero hours and minutes, and the seconds always. */
export function formatRemaining(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const part = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`
  return [h > 0 ? part(h, 'hour') : null, m > 0 ? part(m, 'minute') : null, part(s, 'second')].filter(Boolean).join(' ')
}

export type FreeTierNoticeView =
  | { kind: 'wait'; message: string; untilEpochMs: number; group?: string }
  | { kind: 'switch'; message: string; group?: string }
  | { kind: 'paid'; message: string }
  | { kind: 'daily'; message: string; untilEpochMs: number | null }
  | { kind: 'resize'; message: string; effective: number }

/**
 * What the notice shows for this run state, or null. Pure, so the gates can drive it. A wait whose
 * time has come is hidden; a daily stop stays after the run ends, so the user knows when to Continue.
 */
export function freeTierNoticeOf(input: { running: boolean; budget: BudgetSnapshot | null; advice: RunAdvice | null; now?: number }): FreeTierNoticeView | null {
  const { running, budget, advice } = input
  const now = input.now ?? Date.now()
  if (budget?.state === 'dailyExhausted') return { kind: 'daily', message: budget.message, untilEpochMs: budget.untilEpochMs ?? null }
  if (running && budget) {
    const group = budget.quotaGroupLabel ? { group: budget.quotaGroupLabel } : {}
    if (budget.state === 'waiting') return remainingSeconds(budget.untilEpochMs, now) > 0 ? { kind: 'wait', message: budget.message, untilEpochMs: budget.untilEpochMs, ...group } : null
    if (budget.state === 'groupSwitch') return { kind: 'switch', message: budget.message, ...group }
    if (budget.state === 'paidFallback') return { kind: 'paid', message: budget.message }
  }
  if (advice?.state === 'resized' && advice.effectiveBatchSize !== undefined) return { kind: 'resize', message: advice.message, effective: advice.effectiveBatchSize }
  return null
}

/** The current time, refreshed every second while `active`; the timer is cleared otherwise and on unmount. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const BOX = 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200'

export function FreeTierNotice({
  running,
  budget,
  advice,
  savedBatchSize,
  onUseBatchSize
}: {
  running: boolean
  budget: BudgetSnapshot | null
  advice?: RunAdvice | null
  /** Translate only: the saved Batch Size, so **Use N in Settings** is offered only when it differs. */
  savedBatchSize?: number
  /** Translate only: the explicit Settings patch. Transcribe has no request-size advice. */
  onUseBatchSize?: (n: number) => void
}): React.JSX.Element | null {
  const timed =
    (budget?.state === 'waiting' && running) || (budget?.state === 'dailyExhausted' && budget.untilEpochMs !== undefined)
  const now = useNow(!!timed)
  const view = freeTierNoticeOf({ running, budget, advice: advice ?? null, now })
  if (!view) return null

  if (view.kind === 'wait') {
    return (
      <div role="status" className={BOX}>
        <div>{view.message}</div>
        <div className="mt-0.5 text-xs">
          {view.group ? `${view.group} · ` : ''}Sending again in {formatRemaining(remainingSeconds(view.untilEpochMs, now))}.
        </div>
      </div>
    )
  }
  if (view.kind === 'switch') {
    return (
      <div role="status" className={BOX}>
        {view.message}
        {view.group ? ` Now using ${view.group}.` : ''}
      </div>
    )
  }
  if (view.kind === 'paid') {
    return (
      <div role="status" className={BOX}>
        {view.message}
      </div>
    )
  }
  if (view.kind === 'daily') {
    const left = view.untilEpochMs !== null ? remainingSeconds(view.untilEpochMs, now) : null
    return (
      <div role="status" className={BOX}>
        <div>{view.message}</div>
        <div className="mt-0.5 text-xs">
          {view.untilEpochMs === null ? (
            <>
              The reset time is not known. Check your limits at{' '}
              <button type="button" className="underline" onClick={() => void openExternalLink(AI_STUDIO_USAGE)}>
                aistudio.google.com/usage
              </button>
              .
            </>
          ) : left === 0 ? (
            'Reset time reached.'
          ) : (
            `Next reset at ${new Date(view.untilEpochMs).toLocaleString()} (in ${formatRemaining(left ?? 0)}).`
          )}
        </div>
      </div>
    )
  }
  const offer = onUseBatchSize && savedBatchSize !== undefined && view.effective !== savedBatchSize
  return (
    <div role="status" className={`${BOX} flex flex-wrap items-center gap-2`}>
      <span className="flex-1">{view.message}</span>
      {offer && (
        <button
          type="button"
          className="rounded border border-amber-400 px-2 py-0.5 text-xs font-medium hover:bg-amber-100 dark:border-amber-600 dark:hover:bg-amber-900/40"
          onClick={() => onUseBatchSize?.(view.effective)}
        >
          Use {view.effective} in Settings
        </button>
      )}
    </div>
  )
}
