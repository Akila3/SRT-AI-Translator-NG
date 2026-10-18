/**
 * Bounded failure for one logical request (implementation_plan.md Step 1.8). AUTHORED-BY: opus-5.5-high
 *
 * Ported from gst's call loop; citations are against the port source, 3.8.3 `main.py`, and where
 * transcription differs, against 3.7.0 (`main.py:1890-1929`), which is what 1.1.0 ships:
 *
 *  - **quota** (`:812-824`): switch key when more than 60 s have passed since the last quota error
 *    and a spare key exists (`:814`); otherwise wait 60 s (`:820-822`) and send again. Improved: a
 *    quota answer that says how long to wait (`retryAfterMs`) is waited for instead of a fixed minute.
 *  - **the consecutive-error ceiling** (`:201-202`, `max_consecutive_errors = 3`): counted at `:798`,
 *    enforced at `:804-809`, and **reset to 0 on success at `:782`**. ⚠ The reset is load-bearing: a
 *    run that fails twice, succeeds, then fails twice more must not stop. Here the caller resets it
 *    (`RetryBudget.accept`) when it commits the unit, because only the caller knows a reply was usable.
 *  - **overload** (`:826-835`, 3.7.0 `:1907-1915`): 429/500/503 wait 60 s and send again.
 *
 * Three differences, each an enhancement:
 *
 *  - Transcription in 3.7.0 had **no ceiling at all**: quota waited forever and any other error was
 *    sent again after one second, forever (`:1893-1929`). That is why 1.1.0 needed a stall watch. The
 *    ceiling of three now bounds every kind, and one budget is shared across them all, so three
 *    failures of different kinds also stop (D14 §14.4: `R = 2` retries after the first attempt).
 *  - Classification is structured (`providers/gemini.ts` `classifyHttpFailure`), not a substring
 *    test, and **quota is decided before generic 429/5xx** (`:410-426` there), so rate pressure can
 *    never enter a recovery policy that shrinks work (Feature 8 D8-8/D8-15).
 *  - Every request has its own deadline (register B1 half 2, B2) instead of a stall inferred from
 *    silence. A deadline that fires after the request left is terminal: the service may already have
 *    accepted and billed it (AS-D14-5). The CLI's stall watch went with the CLI (Step 4.5).
 *
 * What is NOT retried, by the D14 §14.4 matrix: a rejected request, permission, location, an
 * oversized body, an in-flight timeout and an unclassified failure stop at once; a key the provider
 * calls invalid leaves the rotation and the next key is tried without spending the budget; a block or
 * an unusable reply is returned to the caller, whose own table decides (Step 1.8a for transcription).
 * One exception (Bundle G, R18-PR PR-4): a rejection the provider marks `safetyThreshold` is sent once
 * more, at `OFF`, before it can stop anything.
 *
 * SECURITY: slot numbers only. No key value enters this module, its notices or its errors.
 */
import type { QuotaEvidenceDetail, RunError, Usage, UsageRequestKind } from '../shared/engineEvents'
import type { KeyRotation } from './keys'
import type { BatchFailure } from './providers/types'

/** gst's `max_consecutive_errors` (`main.py:202`). */
export const MAX_CONSECUTIVE_ERRORS = 3
/** gst's quota countdown (`main.py:820-822`). */
export const QUOTA_WAIT_MS = 60_000
/** gst's key-switch spacing (`main.py:814`). */
export const KEY_SWITCH_INTERVAL_MS = 60_000
/** gst's overload pause (`main.py:833`; 3.7.0 `:1914`). */
export const OVERLOAD_WAIT_MS = 60_000
/** gst's pause before resending after any other error in translation (`main.py:863`). */
export const NETWORK_WAIT_MS = 5_000
/**
 * The longest one request may take, and the longest wait this module will sit through. Ten minutes
 * is the quiet span after which 1.1.0's stall watch ended a CLI run (its tier 2, 600 000 ms), so
 * neither limit ends anything 1.1.0 would have let finish.
 */
const TEN_QUIET_MINUTES_MS = 600_000
export const REQUEST_TIMEOUT_MS = TEN_QUIET_MINUTES_MS
export const MAX_WAIT_MS = TEN_QUIET_MINUTES_MS

export interface RetryPolicy {
  maxConsecutiveErrors: number
  quotaWaitMs: number
  keySwitchIntervalMs: number
  overloadWaitMs: number
  networkWaitMs: number
  requestTimeoutMs: number
  maxWaitMs: number
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
  quotaWaitMs: QUOTA_WAIT_MS,
  keySwitchIntervalMs: KEY_SWITCH_INTERVAL_MS,
  overloadWaitMs: OVERLOAD_WAIT_MS,
  networkWaitMs: NETWORK_WAIT_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  maxWaitMs: MAX_WAIT_MS
})

/** Time, injectable so every branch runs offline in milliseconds. */
export interface RetryClock {
  now(): number
  /** Resolves `false` if the signal ended the wait, `true` once the time has passed. */
  sleep(ms: number, signal: AbortSignal): Promise<boolean>
}

export const systemClock: RetryClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false)
      const done = (ok: boolean) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(ok)
      }
      const onAbort = () => done(false)
      const timer = setTimeout(() => done(true), Math.max(0, ms))
      signal.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * The run's retry state: gst's `consecutive_error_count` and its `last_time`. One per run; the
 * count is reset by `accept` when the caller commits a unit, never by a retry or a recovery.
 */
export class RetryBudget {
  private count = 0
  private lastQuotaAt = Number.NEGATIVE_INFINITY

  get consecutive(): number {
    return this.count
  }

  /** gst `main.py:782`: the unit was committed. */
  accept(): void {
    this.count = 0
  }

  /** @internal */
  fail(): number {
    return ++this.count
  }

  /** @internal gst `:814` then `:823`: whether a quota error may switch key, recording the time either way. */
  quotaSwitchDue(now: number, intervalMs: number): boolean {
    const due = now - this.lastQuotaAt > intervalMs
    this.lastQuotaAt = now
    return due
  }
}

/** What happens next after one failed attempt (D14 §14.4, common route action). */
export type RouteAction =
  | { action: 'retry'; waitMs: number; switchKey: boolean }
  | { action: 'reject-key' }
  | { action: 'stop' }
  | { action: 'caller' }
  | { action: 'cancelled' }

/**
 * The route action for one failure. Pure apart from the quota timestamp it records on `budget`, so
 * it is called exactly once per failed attempt.
 */
export function routeAction(
  failure: BatchFailure,
  ctx: { budget: RetryBudget; canSwitchKey: boolean; now: number; policy: RetryPolicy }
): RouteAction {
  const { policy } = ctx
  const wait = (ms: number): RouteAction => (ms > policy.maxWaitMs ? { action: 'stop' } : { action: 'retry', waitMs: ms, switchKey: false })
  // A non-finite or negative hint is no evidence; it never becomes a wait (D14 §14.5 failure list).
  const hinted = (ms: number | undefined, fallback: number): number => (ms !== undefined && Number.isFinite(ms) && ms >= 0 ? ms : fallback)
  switch (failure.kind) {
    case 'cancelled':
      return { action: 'cancelled' }
    case 'auth':
      return failure.reason === 'invalid' ? { action: 'reject-key' } : { action: 'stop' }
    case 'quota': {
      const due = ctx.budget.quotaSwitchDue(ctx.now, policy.keySwitchIntervalMs)
      if (due && ctx.canSwitchKey) return { action: 'retry', waitMs: 0, switchKey: true }
      // A daily quota does not come back in a minute; waiting for it is the stall gst could not end.
      if (failure.metric === 'rpd') return { action: 'stop' }
      return wait(hinted(failure.retryAfterMs, policy.quotaWaitMs))
    }
    case 'rate-limit':
      return wait(hinted(failure.retryAfterMs, policy.overloadWaitMs))
    case 'overload':
      return wait(policy.overloadWaitMs)
    case 'network': {
      // A setting on this computer, or a proxy login, is not fixed by sending again (gst stops too).
      const setup = networkSetupFailure(failure.cause)
      return setup && setup !== 'ERR_NG_PROXY_TUNNEL' ? { action: 'stop' } : wait(policy.networkWaitMs)
    }
    case 'blocked':
    case 'malformed':
      return { action: 'caller' }
    case 'timeout':
    case 'request-invalid':
    case 'response-too-large':
    case 'unknown':
      return { action: 'stop' }
  }
}

const REJECTED_MESSAGE = 'Invalid API key. Double-check the key from Google AI Studio and try again.'
const FORBIDDEN_MESSAGE = 'This API key is not authorized for the Gemini API. Enable it in Google AI Studio.'
const NETWORK_MESSAGE = 'Could not reach Google. Check your internet connection and try again.'

const NETWORK_SETUP_MESSAGES: Readonly<Record<string, string>> = {
  ERR_NG_PROXY_AUTH: 'The proxy set on this computer asked for a login that was missing or not accepted. Check the user name and password in the proxy setting.',
  ERR_NG_PROXY_TUNNEL: 'The proxy set on this computer would not connect to Google. Check the proxy setting, or ask whoever runs the network.',
  ERR_NG_PROXY_CONFIG: 'The proxy set on this computer cannot be used: only http and https proxies are supported. Check HTTPS_PROXY / ALL_PROXY or the Windows proxy setting.',
  ERR_NG_CA_FILE: 'The certificate file named by SSL_CERT_FILE could not be used. Check that it exists and holds certificates.'
}

/** The proxy or certificate code a network failure carries (`proxy.ts`, `responseLimit.ts`), if any. */
function networkSetupFailure(cause: unknown): string | null {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' && code in NETWORK_SETUP_MESSAGES ? code : null
}

function minutes(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 120 ? `${s} seconds` : `${Math.round(s / 60)} minutes`
}

/**
 * The public projection of a provider failure (D14 §14.4, last column). The wording of the three
 * kinds 1.1.0 already names is its own (`cli/engineErrors.ts:33-40` at `b6b75ae`).
 */
export function projectFailure(failure: Exclude<BatchFailure, { kind: 'cancelled' }>, policy: RetryPolicy = DEFAULT_RETRY_POLICY): RunError {
  switch (failure.kind) {
    case 'auth':
      if (failure.reason === 'invalid') return { kind: 'auth', authReason: 'invalid', keyIndex: failure.keyIndex, message: REJECTED_MESSAGE }
      if (failure.reason === 'permission') return { kind: 'forbidden', authReason: 'permission', keyIndex: failure.keyIndex, message: FORBIDDEN_MESSAGE }
      return {
        kind: 'unsupportedLocation',
        authReason: 'unsupported-location',
        keyIndex: failure.keyIndex,
        message: 'Google does not offer the Gemini API from this location for this key. Nothing more was sent.'
      }
    case 'quota': {
      const err: RunError = {
        kind: 'quota',
        message:
          failure.metric === 'rpd'
            ? 'The daily quota for this model is used up on every key this run may use. Try again tomorrow, or use a paid key.'
            : 'The quota for this model is used up for now. Wait a bit and try again, or use a paid key.',
        detailKeys: failure.detailKeys
      }
      if (failure.retryAfterMs !== undefined) err.retryAfterMs = failure.retryAfterMs
      if (failure.quotaDetails?.length) {
        err.quotaDetails = failure.quotaDetails.map((d) => ({ ...d }))
      } else if (failure.metric) {
        const detail: QuotaEvidenceDetail = { metric: failure.metric }
        if (failure.explicitLimit !== undefined) detail.limit = failure.explicitLimit
        err.quotaDetails = [detail]
      }
      return err
    }
    case 'rate-limit': {
      const err: RunError = { kind: 'rateLimit', message: 'Google is limiting how fast this key may send requests. Wait a bit and try again.', detailKeys: failure.detailKeys }
      if (failure.retryAfterMs !== undefined) err.retryAfterMs = failure.retryAfterMs
      return err
    }
    case 'overload':
      return { kind: 'overload', message: 'The model is overloaded right now. Try again in a few minutes.' }
    case 'network': {
      const setup = networkSetupFailure(failure.cause)
      return { kind: 'network', message: setup ? NETWORK_SETUP_MESSAGES[setup] : NETWORK_MESSAGE }
    }
    case 'timeout':
      return failure.stage === 'in-flight'
        ? {
            kind: 'timeout',
            message: `No reply came within ${minutes(policy.requestTimeoutMs)}. It was not sent again, because Google may already have accepted it.`
          }
        : { kind: 'timeout', message: `The request could not be sent within ${minutes(policy.requestTimeoutMs)}.` }
    case 'request-invalid':
      return { kind: 'invalidRequest', message: 'Google rejected the request as invalid for this model. Check the model and its settings.', detailKeys: failure.detailKeys }
    case 'response-too-large':
      return { kind: 'responseTooLarge', limitBytes: failure.limitBytes, message: 'The reply was larger than this app accepts, so it was not read.' }
    case 'blocked': {
      const err: RunError = { kind: 'blocked', blockScope: failure.scope, message: 'The model refused this request.' }
      if (failure.reason) err.blockReason = failure.reason
      return err
    }
    case 'malformed':
      return {
        kind: 'malformed',
        message: failure.cause === 'truncated' ? 'The model stopped before its reply was complete.' : 'The model\u2019s reply could not be read.'
      }
    case 'unknown':
      return { kind: 'unknown', message: 'Google returned an error this app does not recognise.', detailKeys: failure.detailKeys }
  }
}

/** One attempt's result, as the caller judged it. */
export type AttemptResult<T> =
  | { ok: true; value: T; usage?: Usage | null }
  | { ok: false; failure: BatchFailure; usage?: Usage | null }

export interface AttemptContext {
  /** The slot to send with. The caller maps it to the key at the moment of the call and nowhere else. */
  keySlot: number
  /** With a request gate: the Quota Group this attempt was routed and reserved by. */
  quotaGroupId?: string
  /** One-based, across every attempt of this request. */
  attempt: number
  signal: AbortSignal
  timeoutMs: number
}

/** Said before each wait or resend, for the log and the unit's `retrying` state. */
export interface RetryNotice {
  attempt: number
  failure: BatchFailure['kind']
  consecutive: number
  waitMs: number
  /** Set when the next attempt uses a different slot. */
  switchedTo?: number
  /** Set when a slot was rejected and left the rotation. */
  rejected?: number
  /**
   * Bundle G (PR-4): the next attempt is the one resend after Google refused the safety thresholds. It
   * carries `OFF`, so a count made for the refused request no longer describes it.
   */
  safetyResend?: true
  message: string
}

export type RetryOutcome<T> =
  | { ok: true; value: T; attempts: number; usage: Usage[] }
  | {
      ok: false
      /** `ceiling` and `terminal` end the run; `caller` hands a block or unusable reply back; `no-key` means every slot was rejected. */
      reason: 'ceiling' | 'terminal' | 'caller' | 'no-key' | 'cancelled'
      /** Absent only for `cancelled`. */
      error?: RunError
      failure?: BatchFailure
      /** The request gate stopped the run before this attempt was sent: nothing about the request failed. */
      beforeSend?: true
      /** The run's request record cannot be written: the run ends, and no later stage may carry on. */
      storage?: true
      /** A successful reply's usage, discarded because its attempt's record could not be written. */
      discarded?: Usage
      attempts: number
      usage: Usage[]
    }

/** One gated attempt: where it was routed, and its write-ahead reservation when it has one. */
export interface GateTicket {
  slot: number
  groupId: string
  tier: 'free' | 'paid'
  attemptId: string | null
}

export type GateDecision =
  | { kind: 'send'; slot: number; ticket: GateTicket }
  | { kind: 'stop'; failure: BatchFailure; error: RunError; storage?: true }
  | { kind: 'cancelled' }

/** A required request-record write failed: nothing more may be sent in this run. */
export interface GateStorageFault {
  failure: BatchFailure
  error: RunError
}

/**
 * Bundle F's request gate (`run.ts` `createRequestGate`, implementation_plan.md §12.4–§12.6). With one,
 * the gate — not the rotation — chooses each attempt's slot, waits for the budget, and is told how every
 * attempt ended; a retry's wait becomes the gate's, so it is spent against the budget and Settings
 * rather than a blind timer.
 */
export interface AttemptGate {
  /** `requestKind`: what this request is for the accounting, when it is not the gate's own kind (a Bundle G recovery request). */
  before(input: { current: number | null; live: readonly number[]; signal: AbortSignal; failure: BatchFailure | null; requestKind?: UsageRequestKind }): Promise<GateDecision>
  /**
   * The retry policy chose to wait `waitMs` after `failure` on `ticket`. `true`: the gate sends the next
   * attempt to a consented Paid key at once instead (a Free-route overload), so nothing waits.
   */
  retryWait(ticket: GateTicket, failure: BatchFailure, waitMs: number): boolean | void
  /** Once per attempt that was sent, whatever its outcome. A fault ends the request at once, even after a success. */
  after(ticket: GateTicket, result: { failure: BatchFailure | null; usage: Usage | null }): GateStorageFault | null
}

export interface RetryOptions<T> {
  attempt: (ctx: AttemptContext) => Promise<AttemptResult<T>>
  keys: KeyRotation
  budget: RetryBudget
  signal: AbortSignal
  policy?: Partial<RetryPolicy>
  clock?: RetryClock
  onRetry?: (notice: RetryNotice) => void
  gate?: AttemptGate
  /** Given to the gate with every attempt of this request (Bundle G: `recovery`). */
  requestKind?: UsageRequestKind
  /**
   * An unreadable reply is sent again at once, counted with the errors in a row, instead of handed back.
   * Transcription sets it: a part has no recovery for an unreadable reply, so handing it back ends the run.
   */
  resendUnreadable?: boolean
}

function slotName(slot: number): string {
  return `key ${slot + 1}`
}

/**
 * Send one logical request until it succeeds, the budget is spent, or a failure that must not be
 * retried arrives. A wait is a timer, never a send; a Stop during a wait ends it at once.
 */
export async function withRetry<T>(opts: RetryOptions<T>): Promise<RetryOutcome<T>> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...opts.policy }
  const clock = opts.clock ?? systemClock
  const { keys, budget, signal, gate } = opts
  const usage: Usage[] = []
  let attempts = 0
  let lastFailure: BatchFailure | null = null
  let safetyResent = false

  const stopped = (): RetryOutcome<T> => ({ ok: false, reason: 'cancelled', attempts, usage })
  const fail = (reason: 'ceiling' | 'terminal' | 'caller' | 'no-key', failure: BatchFailure, error: RunError): RetryOutcome<T> => ({
    ok: false,
    reason,
    error,
    failure,
    attempts,
    usage
  })

  for (;;) {
    if (signal.aborted) return stopped()
    let slot = keys.current()
    if (slot === null) {
      const rejected = keys.rejected()
      const failure: BatchFailure = { ok: false, kind: 'auth', reason: 'invalid', keyIndex: rejected[rejected.length - 1] ?? 0 }
      return fail('no-key', failure, { ...projectFailure(failure, policy), message: 'Every API key this run may use was rejected as invalid. Check the keys in Settings.' })
    }
    let ticket: GateTicket | null = null
    if (gate) {
      const decision = await gate.before({ current: slot, live: keys.live(), signal, failure: lastFailure, ...(opts.requestKind ? { requestKind: opts.requestKind } : {}) })
      if (decision.kind === 'cancelled') return stopped()
      if (decision.kind === 'stop') {
        return { ok: false, reason: 'terminal', error: decision.error, failure: decision.failure, beforeSend: true, ...(decision.storage ? { storage: true as const } : {}), attempts, usage }
      }
      keys.moveTo(decision.slot)
      slot = decision.slot
      ticket = decision.ticket
    }
    attempts++
    const result = await opts.attempt({
      keySlot: slot,
      attempt: attempts,
      signal,
      timeoutMs: policy.requestTimeoutMs,
      ...(ticket ? { quotaGroupId: ticket.groupId } : {})
    })
    if (result.usage) usage.push(result.usage)
    const fault = gate && ticket ? gate.after(ticket, { failure: result.ok ? null : result.failure, usage: result.usage ?? null }) : null
    if (fault) {
      return {
        ok: false,
        reason: 'terminal',
        error: fault.error,
        failure: fault.failure,
        storage: true,
        ...(result.ok && result.usage ? { discarded: result.usage } : {}),
        attempts,
        usage
      }
    }
    if (result.ok) return { ok: true, value: result.value, attempts, usage }
    const failure = result.failure
    lastFailure = failure
    if (signal.aborted) return stopped()

    // PR-4: the provider has already moved the model to OFF. One resend through the same gate, kept off
    // the consecutive-error count so the refusal itself can never be what ends the run.
    if (failure.kind === 'request-invalid' && failure.safetyThreshold && !safetyResent) {
      safetyResent = true
      opts.onRetry?.({
        attempt: attempts,
        failure: failure.kind,
        consecutive: budget.consecutive,
        waitMs: 0,
        safetyResend: true,
        message: 'Google refused this model\u2019s safety setting; sending the request again with the safety filters off.'
      })
      continue
    }

    let route = routeAction(failure, { budget, canSwitchKey: gate ? false : keys.canSwitch(), now: clock.now(), policy })
    // With a gate a daily quota is the gate's to route: another group may still send, or it stops the run.
    if (gate && route.action === 'stop' && failure.kind === 'quota' && failure.metric === 'rpd') route = { action: 'retry', waitMs: 0, switchKey: false }
    if (opts.resendUnreadable && route.action === 'caller' && failure.kind === 'malformed') route = { action: 'retry', waitMs: 0, switchKey: false }
    switch (route.action) {
      case 'cancelled':
        return stopped()
      case 'stop':
        return fail('terminal', failure, projectFailure(failure as Exclude<BatchFailure, { kind: 'cancelled' }>, policy))
      case 'caller':
        return fail('caller', failure, projectFailure(failure as Exclude<BatchFailure, { kind: 'cancelled' }>, policy))
      case 'reject-key': {
        const next = keys.reject(slot)
        opts.onRetry?.({
          attempt: attempts,
          failure: failure.kind,
          consecutive: budget.consecutive,
          waitMs: 0,
          rejected: slot,
          ...(next !== null ? { switchedTo: next } : {}),
          message:
            next !== null
              ? `${slotName(slot)} was rejected as invalid; it will not be used again in this run. Trying ${slotName(next)}.`
              : `${slotName(slot)} was rejected as invalid; it will not be used again in this run.`
        })
        continue
      }
      case 'retry': {
        const consecutive = budget.fail()
        if (consecutive >= policy.maxConsecutiveErrors) {
          const error = projectFailure(failure as Exclude<BatchFailure, { kind: 'cancelled' }>, policy)
          return fail('ceiling', failure, {
            ...error,
            message: `Stopped after ${policy.maxConsecutiveErrors} errors in a row, so as not to waste quota. Last error: ${error.message}`
          })
        }
        let switchedTo: number | undefined
        if (route.switchKey) switchedTo = keys.switchKey() ?? undefined
        const toPaid = gate && ticket ? gate.retryWait(ticket, failure, route.waitMs) === true : false
        const message =
          toPaid
            ? `The model is overloaded on ${slotName(slot)}; sending this request to your paid key now, as Allow paid fallback permits. Error ${consecutive}/${policy.maxConsecutiveErrors}.`
            : switchedTo !== undefined
            ? `Quota exceeded on ${slotName(slot)}; switching to ${slotName(switchedTo)}. Error ${consecutive}/${policy.maxConsecutiveErrors}.`
            : gate && failure.kind === 'quota' && failure.metric === 'rpd'
              ? `The daily quota is used up on ${slotName(slot)}; checking whether another Quota Group can send. Error ${consecutive}/${policy.maxConsecutiveErrors}.`
            : gate && (failure.kind === 'quota' || failure.kind === 'rate-limit')
              ? `Google asked ${slotName(slot)}'s Quota Group to wait ${minutes(route.waitMs)}; another group sends if one can. Error ${consecutive}/${policy.maxConsecutiveErrors}.`
            : failure.kind === 'quota'
              ? `Quota exceeded; waiting ${minutes(route.waitMs)} before trying again. Error ${consecutive}/${policy.maxConsecutiveErrors}.`
              : failure.kind === 'rate-limit'
                ? `Google is limiting requests; waiting ${minutes(route.waitMs)} before trying again. Error ${consecutive}/${policy.maxConsecutiveErrors}.`
                : failure.kind === 'overload'
                  ? `The model is overloaded; pausing for ${minutes(route.waitMs)}. Error ${consecutive}/${policy.maxConsecutiveErrors}.`
                  : failure.kind === 'malformed'
                    ? `${projectFailure(failure, policy).message} Asking for it again. Error ${consecutive}/${policy.maxConsecutiveErrors}.`
                    : `Could not reach Google; trying again in ${minutes(route.waitMs)}. Error ${consecutive}/${policy.maxConsecutiveErrors}.`
        opts.onRetry?.({
          attempt: attempts,
          failure: failure.kind,
          consecutive,
          waitMs: toPaid ? 0 : route.waitMs,
          ...(switchedTo !== undefined ? { switchedTo } : {}),
          message
        })
        if (!(gate && ticket) && route.waitMs > 0 && !(await clock.sleep(route.waitMs, signal))) return stopped()
        continue
      }
    }
  }
}
