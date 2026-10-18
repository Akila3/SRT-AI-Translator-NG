import React from 'react'
import type { Usage } from '../../electron/shared/engineEvents'
import { CostEstimate } from './ui'

/**
 * The run's token figures, shared by Translate (inside `StatusCard`) and Transcribe (above its log)
 * — implementation_plan.md §12.10. Shown only when Show Token Usage is on and the run has reported
 * usage; the caller decides both. It carries numbers and safe labels only: no wait or advice prose,
 * which is `FreeTierNotice`'s. AUTHORED-BY: opus-5.5-high
 */
export function TokenUsageCard({
  tokens,
  model,
  cost,
  usage
}: {
  tokens: { prompt: number; thoughts: number; output: number; total: number }
  model: string
  /** A run that prices its usage; absent for one that does not. */
  cost?: { estimate: number | null } | null
  /** The run's cumulative usage, for request and retry totals when it states them. */
  usage?: Usage | null
}): React.JSX.Element {
  const cols: { label: string; value: number; className: string }[] = [
    { label: 'Prompt', value: tokens.prompt, className: 'text-blue-600 dark:text-blue-400' },
    { label: 'Thoughts', value: tokens.thoughts, className: 'text-purple-600 dark:text-purple-400' },
    { label: 'Output', value: tokens.output, className: 'text-green-600 dark:text-green-400' },
    { label: 'Total', value: tokens.total, className: 'text-gray-900 dark:text-gray-100' }
  ]
  const requests = usage?.requestCount
  const retries = usage?.retryCount ?? 0
  const unusable = usage?.billedButUnusableTokens ?? 0
  const extras = [
    typeof requests === 'number' && requests > 0 ? `${requests.toLocaleString()} request${requests === 1 ? '' : 's'}` : null,
    retries > 0 ? `${retries.toLocaleString()} retr${retries === 1 ? 'y' : 'ies'}` : null,
    unusable > 0 ? `${unusable.toLocaleString()} billed tokens not usable` : null
  ].filter((x): x is string => x !== null)
  // Per model and Quota Group, once a run has called more than one; the labels arrive already redacted.
  // Token counts are measurements, not generation requests, so they are not listed here.
  const buckets = (usage?.buckets ?? []).filter((b) => b.attempts > 0 && b.requestKind !== 'countTokens')
  const byBucket =
    buckets.length > 1
      ? buckets.map((b) => `${b.model}${b.quotaGroupLabel ? ` (${b.quotaGroupLabel})` : ''}: ${b.attempts.toLocaleString()} request${b.attempts === 1 ? '' : 's'}`).join(' · ')
      : null
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
        Token Usage{model ? ` · ${model}` : ''}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {cols.map((c) => (
          <div key={c.label}>
            <div className="mb-0.5 text-[10px] text-gray-400 dark:text-gray-500">{c.label}</div>
            <div className={`text-[15px] font-semibold tabular-nums ${c.className}`}>{c.value.toLocaleString()}</div>
          </div>
        ))}
      </div>
      {extras.length > 0 && <div className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">{extras.join(' · ')}</div>}
      {byBucket && <div className="mt-1 break-words text-[11px] text-gray-500 dark:text-gray-400">{byBucket}</div>}
      {cost && (
        <div className="mt-2 border-t border-gray-100 pt-2 dark:border-gray-700">
          <CostEstimate estimate={cost.estimate} />
        </div>
      )}
    </div>
  )
}
