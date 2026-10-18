/**
 * The Free-tier request journal (`<userData>/quota-budget.json`, implementation_plan.md §12.3).
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * Separate from `config.json` so a request never rewrites Settings. A protected request is written
 * here before it is sent (write-ahead) and reconciled after it answers; restart reads it back so a
 * new session does not forget what the last one sent. Every write is the whole V1 object through a
 * temporary file, flushed and then renamed over the journal, so the file on disk is always one
 * complete version or the one before it.
 *
 * It holds ids, model ids, wall timestamps and token counts only — never a key, prompt, subtitle,
 * audio, output, response body or user text. Records are rebuilt field by field from typed input, so
 * nothing else can be carried into the file.
 *
 * An existing journal this build cannot read (malformed, another version, unreadable) is left exactly
 * as it is and reported as a storage error: an empty budget is never substituted for one that exists.
 */
import fs from 'fs'
import path from 'path'
import type { BudgetMetric, UsageRequestKind } from '../shared/engineEvents'
import { isQuotaGroupId } from '../shared/quotaGroups'

export const QUOTA_BUDGET_FILE = 'quota-budget.json'
/** RPM and input-TPM are trailing one-minute windows; a reservation younger than this still counts. */
export const BUDGET_WINDOW_MS = 60_000

export interface BudgetReservationRecord {
  kind: 'reservation'
  /** `${runId}:${run-local monotonically increasing attempt}`. */
  attemptId: string
  groupId: string
  model: string
  requestKind: UsageRequestKind
  /** Wall time, persisted immediately before dispatch. */
  reservedAt: string
  estimatedInputTokens?: number
  actualInputTokens?: number
  reconciledAt?: string
}

export interface BudgetNotBeforeRecord {
  kind: 'notBefore'
  groupId: string
  model: string
  metric: BudgetMetric
  observedAt: string
  /** Absolute wall time. */
  until: string
  source: 'api-retry' | 'api-reset'
}

export interface BudgetDailyRecord {
  kind: 'daily'
  groupId: string
  model: string
  periodStart: string
  resetAt: string
  /** Only reservations already removed from `reservations`. */
  compactedRequestCount: number
  exhausted: boolean
  resetSource: 'api' | 'pacific'
  updatedAt: string
}

export interface QuotaBudgetJournalV1 {
  version: 1
  reservations: BudgetReservationRecord[]
  notBefore: BudgetNotBeforeRecord[]
  daily: BudgetDailyRecord[]
}

export type JournalStorageError = { ok: false; code: 'storage'; message: string }
export type JournalWrite = { ok: true } | JournalStorageError

/** The file system as the journal uses it. Gates replace it to fail a write or read a crafted file. */
export interface JournalIo {
  /** The file's text, or null when it does not exist. Throws when it exists but cannot be read. */
  read(file: string): string | null
  /** Temp, flush, atomic replace. Throws on any failure, leaving the previous file in place. */
  writeAtomic(file: string, text: string): void
}

let tempCounter = 0

/**
 * Waits before each retry of a refused rename. Windows refuses a rapid rename over a fresh file while
 * a scanner holds it (`EPERM`/`EBUSY`/`EACCES`); the run-artifact writer measured these clearing within
 * 75 ms. Synchronous, so the sum (155 ms) is the most one write-ahead can stall.
 */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [5, 10, 20, 40, 80]
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const retryPause = new Int32Array(new SharedArrayBuffer(4))

function renameOver(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
      Atomics.wait(retryPause, 0, 0, RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

export const fsJournalIo: JournalIo = {
  read(file) {
    try {
      return fs.readFileSync(file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.${++tempCounter}.tmp`
    try {
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeSync(fd, text)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      // A scanner briefly holding the fresh file refuses the rename on Windows; that clears in ms.
      renameOver(tmp, file)
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* the temporary is not the journal; a leftover one is never read */
      }
      throw err
    }
  }
}

export function emptyJournal(): QuotaBudgetJournalV1 {
  return { version: 1, reservations: [], notBefore: [], daily: [] }
}

const REQUEST_KINDS: readonly UsageRequestKind[] = ['generation', 'countTokens', 'recovery']
const METRICS: readonly BudgetMetric[] = ['rpm', 'tpm', 'rpd', 'retry', 'other']
const ATTEMPT_ID = /^[^\s:]+:\d+$/

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isWall(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v))
}
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}
function isModel(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && !/\s/.test(v)
}

function reservationOf(r: unknown): BudgetReservationRecord | null {
  if (!isObject(r) || r.kind !== 'reservation') return null
  if (typeof r.attemptId !== 'string' || !ATTEMPT_ID.test(r.attemptId)) return null
  if (!isQuotaGroupId(r.groupId) || !isModel(r.model)) return null
  if (!REQUEST_KINDS.includes(r.requestKind as UsageRequestKind) || !isWall(r.reservedAt)) return null
  const out: BudgetReservationRecord = {
    kind: 'reservation',
    attemptId: r.attemptId,
    groupId: r.groupId,
    model: r.model,
    requestKind: r.requestKind as UsageRequestKind,
    reservedAt: r.reservedAt
  }
  if (r.estimatedInputTokens !== undefined) {
    if (!isCount(r.estimatedInputTokens)) return null
    out.estimatedInputTokens = r.estimatedInputTokens
  }
  if (r.actualInputTokens !== undefined) {
    if (!isCount(r.actualInputTokens)) return null
    out.actualInputTokens = r.actualInputTokens
  }
  if (r.reconciledAt !== undefined) {
    if (!isWall(r.reconciledAt)) return null
    out.reconciledAt = r.reconciledAt
  }
  return out
}

function notBeforeOf(r: unknown): BudgetNotBeforeRecord | null {
  if (!isObject(r) || r.kind !== 'notBefore') return null
  if (!isQuotaGroupId(r.groupId) || !isModel(r.model) || !METRICS.includes(r.metric as BudgetMetric)) return null
  if (!isWall(r.observedAt) || !isWall(r.until) || (r.source !== 'api-retry' && r.source !== 'api-reset')) return null
  return { kind: 'notBefore', groupId: r.groupId, model: r.model, metric: r.metric as BudgetMetric, observedAt: r.observedAt, until: r.until, source: r.source }
}

function dailyOf(r: unknown): BudgetDailyRecord | null {
  if (!isObject(r) || r.kind !== 'daily') return null
  if (!isQuotaGroupId(r.groupId) || !isModel(r.model) || !isWall(r.periodStart) || !isWall(r.resetAt)) return null
  if (!isCount(r.compactedRequestCount) || typeof r.exhausted !== 'boolean') return null
  if ((r.resetSource !== 'api' && r.resetSource !== 'pacific') || !isWall(r.updatedAt)) return null
  return {
    kind: 'daily',
    groupId: r.groupId,
    model: r.model,
    periodStart: r.periodStart,
    resetAt: r.resetAt,
    compactedRequestCount: r.compactedRequestCount,
    exhausted: r.exhausted,
    resetSource: r.resetSource,
    updatedAt: r.updatedAt
  }
}

export type JournalParse = { ok: true; journal: QuotaBudgetJournalV1 } | { ok: false; reason: 'malformed' | 'unsupported'; message: string }

/** Every record must read back exactly; one that does not makes the whole file unreadable, never half-used. */
export function parseJournal(text: string): JournalParse {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'malformed', message: 'is not valid JSON' }
  }
  if (!isObject(raw)) return { ok: false, reason: 'malformed', message: 'is not a journal object' }
  if (raw.version !== 1) return { ok: false, reason: 'unsupported', message: `has version ${JSON.stringify(raw.version)}, which this version of the app cannot read` }
  if (!Array.isArray(raw.reservations) || !Array.isArray(raw.notBefore) || !Array.isArray(raw.daily)) {
    return { ok: false, reason: 'malformed', message: 'is missing one of its record lists' }
  }
  const reservations = raw.reservations.map(reservationOf)
  const notBefore = raw.notBefore.map(notBeforeOf)
  const daily = raw.daily.map(dailyOf)
  if (reservations.includes(null) || notBefore.includes(null) || daily.includes(null)) {
    return { ok: false, reason: 'malformed', message: 'has a record this version of the app cannot read' }
  }
  return {
    ok: true,
    journal: {
      version: 1,
      reservations: reservations as BudgetReservationRecord[],
      notBefore: notBefore as BudgetNotBeforeRecord[],
      daily: daily as BudgetDailyRecord[]
    }
  }
}

// ── the official RPD reset: midnight in America/Los_Angeles ──────────────────────────────────────

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

function pacificParts(ms: number): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {}
  for (const part of PACIFIC.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second }
}

/** The instant of local midnight starting the Pacific calendar day `y-m-d` (midnight is never a DST edge). */
function pacificMidnight(y: number, m: number, d: number): number {
  const naive = Date.UTC(y, m - 1, d)
  let guess = naive + 8 * 3_600_000
  for (let i = 0; i < 3; i++) {
    const p = pacificParts(guess)
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - guess
    const next = naive - offset
    if (next === guess) break
    guess = next
  }
  return guess
}

/** The Pacific calendar day holding `wallMs`: its start and the next midnight, which is the RPD reset. */
export function pacificPeriod(wallMs: number): { periodStart: number; resetAt: number } {
  const p = pacificParts(wallMs)
  const start = pacificMidnight(p.y, p.m, p.d)
  const tomorrow = new Date(Date.UTC(p.y, p.m - 1, p.d + 1))
  const resetAt = pacificMidnight(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate())
  return { periodStart: start, resetAt }
}

// ── the store ─────────────────────────────────────────────────────────────────────────────────────

export interface ReservationInput {
  attemptId: string
  groupId: string
  model: string
  requestKind: UsageRequestKind
  reservedAt: Date
  estimatedInputTokens?: number
}

export interface NotBeforeInput {
  groupId: string
  model: string
  metric: BudgetMetric
  observedAt: Date
  until: Date
  source: 'api-retry' | 'api-reset'
}

export interface DailyExhaustionInput {
  groupId: string
  model: string
  at: Date
  /** A more specific API reset; without one the Pacific midnight is used and labelled so. */
  apiResetAt?: Date
}

export interface QuotaBudgetStore {
  /** The journal as last loaded or written; null while it is unreadable. */
  current(): Readonly<QuotaBudgetJournalV1> | null
  /** Set when the existing journal could not be read. Every write then refuses and leaves the file alone. */
  loadError(): JournalStorageError | null
  reserve(input: ReservationInput): JournalWrite
  /** Idempotent by `attemptId`. Records actual input when supplied; never drops the estimate. */
  reconcile(attemptId: string, outcome: { actualInputTokens?: number; at: Date }): JournalWrite
  /** Per group/model/metric only the latest `until` is kept. A not-later value writes nothing. */
  recordNotBefore(input: NotBeforeInput): JournalWrite
  markDailyExhausted(input: DailyExhaustionInput): JournalWrite
  /**
   * Fold reservations no retained metric can still use into their period's daily count; drop expired
   * not-before and finished periods. Rows in `inFlight`, younger than the window, or stamped in the
   * future (a clock moved back) are kept, and so is an unreconciled row until its reset period ends.
   */
  compact(now: Date, inFlight?: ReadonlySet<string>): JournalWrite
}

function storageError(file: string, detail: string): JournalStorageError {
  return {
    ok: false,
    code: 'storage',
    message:
      `The Free-tier request record "${path.basename(file)}" ${detail}. Nothing more will be sent in this run. ` +
      'Fix or remove the file, or turn off Automatic Free-Tier Protection in Settings to run without it.'
  }
}

export function openQuotaBudgetStore(file: string, io: JournalIo = fsJournalIo): QuotaBudgetStore {
  let journal: QuotaBudgetJournalV1 | null = null
  let broken: JournalStorageError | null = null
  try {
    const text = io.read(file)
    if (text === null) journal = emptyJournal()
    else {
      const parsed = parseJournal(text)
      if (parsed.ok) journal = parsed.journal
      else broken = storageError(file, `${parsed.message}, so it was left as it is`)
    }
  } catch (err) {
    broken = storageError(file, `could not be read (${err instanceof Error ? err.message : String(err)})`)
  }

  /** Write `next` whole; adopt it only once it is on disk. */
  const write = (next: QuotaBudgetJournalV1): JournalWrite => {
    if (broken) return broken
    try {
      io.writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
    } catch (err) {
      return storageError(file, `could not be saved (${err instanceof Error ? err.message : String(err)})`)
    }
    journal = next
    return { ok: true }
  }
  const state = (): QuotaBudgetJournalV1 | JournalStorageError => broken ?? (journal as QuotaBudgetJournalV1)
  const invalid = (what: string): JournalStorageError => ({ ok: false, code: 'storage', message: `The Free-tier request record refused ${what}. Nothing more will be sent in this run.` })

  return {
    current: () => journal,
    loadError: () => broken,

    reserve(input) {
      const j = state()
      if ('code' in j) return j
      if (!ATTEMPT_ID.test(input.attemptId) || !isQuotaGroupId(input.groupId) || !isModel(input.model) || !REQUEST_KINDS.includes(input.requestKind)) {
        return invalid('a request it could not identify')
      }
      if (j.reservations.some((r) => r.attemptId === input.attemptId)) return invalid('a request id it had already recorded')
      const record: BudgetReservationRecord = {
        kind: 'reservation',
        attemptId: input.attemptId,
        groupId: input.groupId,
        model: input.model,
        requestKind: input.requestKind,
        reservedAt: input.reservedAt.toISOString()
      }
      if (input.estimatedInputTokens !== undefined) {
        if (!isCount(input.estimatedInputTokens)) return invalid('an estimate that is not a token count')
        record.estimatedInputTokens = input.estimatedInputTokens
      }
      return write({ ...j, reservations: [...j.reservations, record] })
    },

    reconcile(attemptId, outcome) {
      const j = state()
      if ('code' in j) return j
      const i = j.reservations.findIndex((r) => r.attemptId === attemptId)
      if (i < 0 || j.reservations[i].reconciledAt !== undefined) return { ok: true }
      // Field order is the parser's, so a record reads back exactly as it was held.
      const updated: BudgetReservationRecord = { ...j.reservations[i] }
      if (outcome.actualInputTokens !== undefined && isCount(outcome.actualInputTokens)) updated.actualInputTokens = outcome.actualInputTokens
      updated.reconciledAt = outcome.at.toISOString()
      const reservations = [...j.reservations]
      reservations[i] = updated
      return write({ ...j, reservations })
    },

    recordNotBefore(input) {
      const j = state()
      if ('code' in j) return j
      if (!isQuotaGroupId(input.groupId) || !isModel(input.model) || !METRICS.includes(input.metric)) return invalid('a wait it could not identify')
      const same = (r: BudgetNotBeforeRecord) => r.groupId === input.groupId && r.model === input.model && r.metric === input.metric
      const existing = j.notBefore.find(same)
      if (existing && Date.parse(existing.until) >= input.until.getTime()) return { ok: true }
      const record: BudgetNotBeforeRecord = {
        kind: 'notBefore',
        groupId: input.groupId,
        model: input.model,
        metric: input.metric,
        observedAt: input.observedAt.toISOString(),
        until: input.until.toISOString(),
        source: input.source
      }
      return write({ ...j, notBefore: [...j.notBefore.filter((r) => !same(r)), record] })
    },

    markDailyExhausted(input) {
      const j = state()
      if ('code' in j) return j
      if (!isQuotaGroupId(input.groupId) || !isModel(input.model)) return invalid('a daily limit it could not identify')
      const at = input.at.getTime()
      const period = pacificPeriod(at)
      const resetAt = input.apiResetAt && input.apiResetAt.getTime() > at ? input.apiResetAt.getTime() : period.resetAt
      const resetSource: BudgetDailyRecord['resetSource'] = input.apiResetAt && input.apiResetAt.getTime() > at ? 'api' : 'pacific'
      const i = j.daily.findIndex((d) => d.groupId === input.groupId && d.model === input.model && Date.parse(d.periodStart) <= at && at < Date.parse(d.resetAt))
      const daily = [...j.daily]
      if (i >= 0) {
        const d = daily[i]
        daily[i] = {
          ...d,
          exhausted: true,
          // An API reset replaces the calculated Pacific one, earlier or later. Between two API resets the later holds.
          ...(resetSource === 'api' && (d.resetSource === 'pacific' || resetAt > Date.parse(d.resetAt)) ? { resetAt: new Date(resetAt).toISOString(), resetSource } : {}),
          updatedAt: input.at.toISOString()
        }
      } else {
        daily.push({
          kind: 'daily',
          groupId: input.groupId,
          model: input.model,
          periodStart: new Date(period.periodStart).toISOString(),
          resetAt: new Date(resetAt).toISOString(),
          compactedRequestCount: 0,
          exhausted: true,
          resetSource,
          updatedAt: input.at.toISOString()
        })
      }
      return write({ ...j, daily })
    },

    compact(now, inFlight = new Set<string>()) {
      const j = state()
      if ('code' in j) return j
      const nowMs = now.getTime()
      const daily = j.daily.filter((d) => Date.parse(d.resetAt) > nowMs).map((d) => ({ ...d }))
      const periodFor = (groupId: string, model: string, at: number) =>
        daily.find((d) => d.groupId === groupId && d.model === model && Date.parse(d.periodStart) <= at && at < Date.parse(d.resetAt))
      const reservations: BudgetReservationRecord[] = []
      let folded = 0
      for (const r of j.reservations) {
        const at = Date.parse(r.reservedAt)
        if (inFlight.has(r.attemptId) || at > nowMs || nowMs - at < BUDGET_WINDOW_MS) {
          reservations.push(r)
          continue
        }
        // An attempt never reconciled (the process ended while it was out) stays a row until its own
        // reset period is over: its outcome is unknown, and only the period's end says nothing can use it.
        if (r.reconciledAt === undefined) {
          const own = periodFor(r.groupId, r.model, at)
          if ((own ? Date.parse(own.resetAt) : pacificPeriod(at).resetAt) > nowMs) {
            reservations.push(r)
            continue
          }
          folded++
          continue
        }
        folded++
        // Outside the window, a reservation counts only toward its own reset period's daily total.
        const own = periodFor(r.groupId, r.model, at)
        if (own) {
          own.compactedRequestCount += 1
          own.updatedAt = now.toISOString()
          continue
        }
        const period = pacificPeriod(at)
        if (period.resetAt <= nowMs) continue
        daily.push({
          kind: 'daily',
          groupId: r.groupId,
          model: r.model,
          periodStart: new Date(period.periodStart).toISOString(),
          resetAt: new Date(period.resetAt).toISOString(),
          compactedRequestCount: 1,
          exhausted: false,
          resetSource: 'pacific',
          updatedAt: now.toISOString()
        })
      }
      const notBefore = j.notBefore.filter((n) => Date.parse(n.until) > nowMs)
      if (folded === 0 && notBefore.length === j.notBefore.length && daily.length === j.daily.length) return { ok: true }
      return write({ version: 1, reservations, notBefore, daily })
    }
  }
}

const opened = new Map<string, QuotaBudgetStore>()

/**
 * One store per journal file per process, so two runs never hold two views of one file. A store that
 * could not read its file is opened again, so a file the user fixed or removed is used without a restart.
 */
export function quotaBudgetStoreAt(userDataDir: string): QuotaBudgetStore {
  const file = path.join(userDataDir, QUOTA_BUDGET_FILE)
  let store = opened.get(file)
  if (!store || store.loadError()) {
    store = openQuotaBudgetStore(file)
    opened.set(file, store)
  }
  return store
}
