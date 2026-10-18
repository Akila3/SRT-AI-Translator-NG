/**
 * When a Free-tier request may next be sent (implementation_plan.md §12.4). Pure: it reads the journal
 * and the known limits, returns a readiness, and never sleeps, sends or reads Settings itself.
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * For one Quota Group and model, each metric's ceiling comes from enabled manual limits (after the
 * reserve), else the newest usable learned 429 ceiling, else nothing: an unknown metric never waits.
 * RPM and input TPM are trailing 60-second client windows on a monotonic clock; RPD is counted from
 * the reset period's start (the API's reset when one was given, else midnight in America/Los_Angeles).
 * A structured retry or reset hint is an absolute not-before. The answer is the latest of these — one
 * wait naming the metric that binds, never one sleep per metric.
 *
 * A row written by an earlier session has only its wall time. Its age is the wall difference, a
 * negative age (the clock went back) counts as zero, and the remainder is placed on this session's
 * monotonic clock. A forward wall jump makes old rows look older than they are; that is AS-F8-8's
 * stated limitation and is not corrected here.
 */
import type { BudgetMetric, UsageRequestKind } from '../shared/engineEvents'
import type { AppSettings, LearnedQuotaEvidence } from '../shared/types'
import { ambiguousQuotaGroupIds, isUsableCeiling, usableManualCapacity } from '../shared/quotaGroups'
import {
  BUDGET_WINDOW_MS,
  pacificPeriod,
  type BudgetReservationRecord,
  type JournalWrite,
  type QuotaBudgetJournalV1,
  type QuotaBudgetStore
} from '../main/quotaBudgetStore'

export type LimitMetric = 'rpm' | 'tpm' | 'rpd'
export const LIMIT_METRICS: readonly LimitMetric[] = ['rpm', 'tpm', 'rpd']

export interface ResolvedLimit {
  source: 'manual' | 'learned' | 'unknown'
  /** The usable ceiling (manual after the reserve); null when unknown. */
  limit: number | null
}

/** The Settings this module reads. */
export type BudgetSettings = Pick<
  AppSettings,
  'automaticFreeTierProtection' | 'manualQuotaLimitsEnabled' | 'manualQuotaReservePercent' | 'quotaGroups' | 'learnedQuotaEvidence'
>

function wallOf(s: string | undefined): number | null {
  if (typeof s !== 'string') return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/** The newest usable learned ceiling for one metric; at equal times the later row. */
function learnedCeiling(rows: readonly LearnedQuotaEvidence[], groupId: string, model: string, metric: LimitMetric): number | null {
  let best: { at: number; i: number; limit: number } | null = null
  rows.forEach((r, i) => {
    if (r.groupId !== groupId || r.model !== model || r.metric !== metric || !isUsableCeiling(r)) return
    const at = wallOf(r.observedAt) ?? Number.NEGATIVE_INFINITY
    if (!best || at > best.at || (at === best.at && i > best.i)) best = { at, i, limit: r.limit as number }
  })
  return best ? (best as { limit: number }).limit : null
}

/**
 * Enabled manual (after the reserve) > usable learned > unknown, per metric. Manual values count only
 * while Automatic Protection and manual limits are both on; turned off, they are kept and skipped.
 */
export function resolveLimits(settings: BudgetSettings, groupId: string, model: string): Record<LimitMetric, ResolvedLimit> {
  // An id two stored groups carry is ambiguous: neither record's manual values are capacity.
  const group = ambiguousQuotaGroupIds(settings).has(groupId) ? undefined : (Array.isArray(settings.quotaGroups) ? settings.quotaGroups : []).find((g) => g?.id === groupId)
  const manual = settings.automaticFreeTierProtection !== false && settings.manualQuotaLimitsEnabled === true ? group?.manualByModel?.[model] : undefined
  const out = {} as Record<LimitMetric, ResolvedLimit>
  for (const metric of LIMIT_METRICS) {
    const entered = manual?.[metric]
    const usable = entered !== undefined ? usableManualCapacity(entered, settings.manualQuotaReservePercent) : null
    if (usable !== null) {
      out[metric] = { source: 'manual', limit: usable }
      continue
    }
    const learned = learnedCeiling(settings.learnedQuotaEvidence ?? [], groupId, model, metric)
    out[metric] = learned !== null ? { source: 'learned', limit: learned } : { source: 'unknown', limit: null }
  }
  return out
}

export interface BudgetClock {
  /** Monotonic milliseconds for this process. */
  monoNow(): number
  /** Wall milliseconds since the epoch. */
  wallNow(): number
}

export const systemBudgetClock: BudgetClock = {
  monoNow: () => performance.now(),
  wallNow: () => Date.now()
}

/** A row's place on this session's monotonic clock: its own reading if it was sent here, else its wall age. */
export function rowMono(wallMs: number, clock: BudgetClock, own?: number): number {
  if (own !== undefined) return own
  return clock.monoNow() - Math.max(0, clock.wallNow() - wallMs)
}

export type Readiness =
  | { state: 'ready'; tpm: TpmInfo }
  | { state: 'waiting'; metric: BudgetMetric; readyAtMono: number; untilEpochMs: number; tpm: TpmInfo }
  | { state: 'dailyExhausted'; untilEpochMs: number; resetSource: 'api' | 'pacific'; tpm: TpmInfo }

/** Whether input TPM could protect this send: unknown ceiling, known with no estimate, or applied. */
export type TpmInfo = 'unknown' | 'noEstimate' | 'applied'

export interface ReadinessInput {
  journal: Readonly<QuotaBudgetJournalV1>
  limits: Record<LimitMetric, ResolvedLimit>
  groupId: string
  model: string
  /** The next request's exact input tokens, or null when no admissible estimate exists. */
  estimate: number | null
  clock: BudgetClock
  /** Monotonic readings of rows this session wrote, by attempt id. */
  own?: ReadonlyMap<string, number>
}

interface Row {
  mono: number
  wall: number
  tokens: number | null
}

const BINDING_ORDER: readonly BudgetMetric[] = ['rpm', 'tpm', 'rpd', 'retry', 'other']

export function readiness(input: ReadinessInput): Readiness {
  const { journal, limits, groupId, model, clock } = input
  const monoNow = clock.monoNow()
  const wallNow = clock.wallNow()
  const toEpoch = (mono: number) => Math.round(wallNow + (mono - monoNow))
  const rows: Row[] = journal.reservations
    .filter((r) => r.groupId === groupId && r.model === model)
    .map((r: BudgetReservationRecord) => {
      const wall = Date.parse(r.reservedAt)
      return { mono: rowMono(wall, clock, input.own?.get(r.attemptId)), wall, tokens: r.actualInputTokens ?? r.estimatedInputTokens ?? null }
    })
  const inWindow = rows.filter((r) => monoNow - r.mono < BUDGET_WINDOW_MS).sort((a, b) => a.mono - b.mono)

  const tpm: TpmInfo = limits.tpm.limit === null ? 'unknown' : input.estimate === null ? 'noEstimate' : 'applied'
  const candidates: Array<{ metric: BudgetMetric; at: number }> = []

  const rpm = limits.rpm.limit
  if (rpm !== null && inWindow.length >= rpm) candidates.push({ metric: 'rpm', at: inWindow[inWindow.length - rpm].mono + BUDGET_WINDOW_MS })

  const tpmLimit = limits.tpm.limit
  if (tpmLimit !== null && input.estimate !== null) {
    let used = inWindow.reduce((s, r) => s + (r.tokens ?? 0), 0)
    let at = monoNow
    // Drop the oldest rows until this request fits. One larger than the whole ceiling waits only for an
    // empty window and is then sent: the client cannot split it, and Google has admitted such a request
    // (probe D1: ~400k input against a stated 250k TPM), so its answer, not this rule, decides it.
    for (let i = 0; used + input.estimate > tpmLimit && i < inWindow.length; i++) {
      used -= inWindow[i].tokens ?? 0
      at = inWindow[i].mono + BUDGET_WINDOW_MS
    }
    if (at > monoNow) candidates.push({ metric: 'tpm', at })
  }

  for (const n of journal.notBefore) {
    if (n.groupId !== groupId || n.model !== model) continue
    const until = Date.parse(n.until)
    if (until > wallNow) candidates.push({ metric: n.metric, at: monoNow + (until - wallNow) })
  }

  // RPD: reset-bounded, never rolling.
  const daily = journal.daily.find((d) => d.groupId === groupId && d.model === model && Date.parse(d.periodStart) <= wallNow && wallNow < Date.parse(d.resetAt))
  const period = daily
    ? { start: Date.parse(daily.periodStart), reset: Date.parse(daily.resetAt), source: daily.resetSource }
    : (() => {
        const p = pacificPeriod(wallNow)
        return { start: p.periodStart, reset: p.resetAt, source: 'pacific' as const }
      })()
  const usedToday = (daily?.compactedRequestCount ?? 0) + rows.filter((r) => r.wall >= period.start).length
  const rpd = limits.rpd.limit
  if (daily?.exhausted || (rpd !== null && usedToday >= rpd)) {
    return { state: 'dailyExhausted', untilEpochMs: period.reset, resetSource: period.source, tpm }
  }

  let binding: { metric: BudgetMetric; at: number } | null = null
  for (const c of candidates) {
    if (!binding || c.at > binding.at || (c.at === binding.at && BINDING_ORDER.indexOf(c.metric) < BINDING_ORDER.indexOf(binding.metric))) binding = c
  }
  if (!binding || binding.at <= monoNow) return { state: 'ready', tpm }
  return { state: 'waiting', metric: binding.metric, readyAtMono: binding.at, untilEpochMs: toEpoch(binding.at), tpm }
}

/** The journal as the budget uses it. */
export type BudgetJournal = Pick<QuotaBudgetStore, 'current' | 'loadError' | 'reserve' | 'reconcile' | 'recordNotBefore' | 'markDailyExhausted' | 'compact'>

export interface ReserveIntent {
  attemptId: string
  groupId: string
  model: string
  requestKind: UsageRequestKind
  estimate: number | null
}

export interface RequestBudget {
  check(groupId: string, model: string, estimate: number | null): Readiness | { state: 'storageError'; message: string }
  /** Write-ahead: the send may begin only after this returns ok. */
  reserve(intent: ReserveIntent): JournalWrite
  /** After the answer, once per attempt; an absent actual keeps the estimate. */
  reconcile(attemptId: string, actualInputTokens?: number): JournalWrite
  /** Attempt ids sent in this process and not yet reconciled (kept by compaction). */
  inFlight(): ReadonlySet<string>
  compact(): JournalWrite
  /** An explicit API retry interval: this group sends nothing for this model before `untilEpochMs`. */
  notBefore(groupId: string, model: string, metric: BudgetMetric, untilEpochMs: number): JournalWrite
  /** Structured daily exhaustion for this group and model, until the API's reset or Pacific midnight. */
  exhausted(groupId: string, model: string, apiResetEpochMs?: number): JournalWrite
}

export function createRequestBudget(deps: { journal: BudgetJournal; settings: () => BudgetSettings; clock?: BudgetClock }): RequestBudget {
  const clock = deps.clock ?? systemBudgetClock
  const own = new Map<string, number>()
  const open = new Set<string>()
  const view = (groupId: string, model: string, estimate: number | null) => {
    const journal = deps.journal.current()
    if (!journal) return null
    return readiness({ journal, limits: resolveLimits(deps.settings(), groupId, model), groupId, model, estimate, clock, own })
  }
  return {
    check(groupId, model, estimate) {
      const r = view(groupId, model, estimate)
      return r ?? { state: 'storageError', message: deps.journal.loadError()?.message ?? 'The Free-tier request record is unavailable.' }
    },
    reserve(intent) {
      const mono = clock.monoNow()
      const written = deps.journal.reserve({
        attemptId: intent.attemptId,
        groupId: intent.groupId,
        model: intent.model,
        requestKind: intent.requestKind,
        reservedAt: new Date(clock.wallNow()),
        ...(intent.estimate !== null ? { estimatedInputTokens: intent.estimate } : {})
      })
      if (written.ok) {
        own.set(intent.attemptId, mono)
        open.add(intent.attemptId)
      }
      return written
    },
    reconcile(attemptId, actualInputTokens) {
      const written = deps.journal.reconcile(attemptId, { ...(actualInputTokens !== undefined ? { actualInputTokens } : {}), at: new Date(clock.wallNow()) })
      if (written.ok) open.delete(attemptId)
      return written
    },
    inFlight: () => open,
    compact: () => deps.journal.compact(new Date(clock.wallNow()), open),
    notBefore: (groupId, model, metric, untilEpochMs) =>
      deps.journal.recordNotBefore({ groupId, model, metric, observedAt: new Date(clock.wallNow()), until: new Date(untilEpochMs), source: 'api-retry' }),
    exhausted: (groupId, model, apiResetEpochMs) =>
      deps.journal.markDailyExhausted({
        groupId,
        model,
        at: new Date(clock.wallNow()),
        ...(apiResetEpochMs !== undefined ? { apiResetAt: new Date(apiResetEpochMs) } : {})
      })
  }
}
