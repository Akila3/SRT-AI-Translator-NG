/**
 * Which credential slot a native request uses, and which one it moves to.
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * SECURITY CONTRACT, the same as `shared/keyOrder.ts`: slot indices in, slot indices out. A key value
 * never enters this module; the caller maps the current slot back to its key at the moment of the call
 * and nowhere else.
 *
 * First form (implementation_plan.md Step 1.3): rotation over exactly the slots each run kind gets
 * today. Translation gets the active set — `-k` and `-k2` (`pythonBridge.ts:474-476`). Transcription
 * gets the primary alone — `-k` only (`pythonBridge.ts:619-620`), and its model guard checks one slot
 * (`ipc.ts:982`). `ACTIVE_SET_SIZE` stays 2: Bundle F ranks the full list inside this module
 * (`rankedNativeSlots`) rather than widening the shared CLI/refresh/auto-selection contract (AR3-9, BR-1),
 * and `chooseRoute` picks each gated attempt's slot by tier and Quota Group (§12.5).
 */
import type { BudgetMetric } from '../shared/engineEvents'
import { ACTIVE_SET_SIZE, orderKeySlots, type KeySlot } from '../shared/keyOrder'
import type { RequestKind } from '../shared/modelCaps'

/** How many ranked slots a run of each kind is given. */
export const RUN_KEY_SLOTS: Readonly<Record<RequestKind, number>> = Object.freeze({
  translate: ACTIVE_SET_SIZE,
  transcribe: 1
})

/**
 * The slots a run may use, best first. Known-invalid slots are already gone (`orderKeySlots`), so an
 * empty result means the run must refuse rather than resurrect a rejected credential (SOL-30).
 */
export function runKeySlots(kind: RequestKind, slots: readonly KeySlot[]): number[] {
  return orderKeySlots(slots).slice(0, RUN_KEY_SLOTS[kind])
}

export interface KeyRotation {
  /** Every slot this run was given, in rank order, including any rejected since. */
  readonly slots: readonly number[]
  /** The slot the next request uses. `null` once every slot has been rejected. */
  current(): number | null
  /** Whether another slot exists to move to. */
  canSwitch(): boolean
  /**
   * Move to the next slot, wrapping. Returns the new slot, or `null` when there is nowhere to go —
   * the engine's `_switch_api` returning False (`main.py:1001-1018`), after which a quota wait is the
   * only option.
   */
  switchKey(): number | null
  /**
   * The provider said this slot's key is invalid (Step 1.8). It leaves the rotation for the rest of
   * the run, so it is never sent again, and the next live slot becomes current. Returns that slot, or
   * `null` when none is left. A key that is merely busy or out of quota is never rejected here.
   */
  reject(slot: number): number | null
  /** The slots rejected during this run, in the order they were rejected. */
  rejected(): readonly number[]
  /** The slots not rejected, in rank order. */
  live(): readonly number[]
  /** Make a live slot current (the request gate's choice). Returns false for a rejected or unknown slot. */
  moveTo(slot: number): boolean
}

/** A rotation over `slots`, starting at the first. Refuses an empty list: there is nothing to run on. */
export function createKeyRotation(slots: readonly number[]): KeyRotation {
  if (slots.length === 0) throw new RangeError('A key rotation needs at least one usable slot.')
  const all = Object.freeze([...slots])
  const live = [...slots]
  const gone: number[] = []
  let position = 0
  return Object.freeze({
    slots: all,
    current: () => (live.length ? live[position] : null),
    canSwitch: () => live.length > 1,
    switchKey: () => {
      if (live.length < 2) return null
      position = (position + 1) % live.length
      return live[position]
    },
    reject: (slot: number) => {
      const at = live.indexOf(slot)
      if (at >= 0) {
        live.splice(at, 1)
        gone.push(slot)
        if (at < position) position -= 1
        else if (position >= live.length) position = 0
      }
      return live.length ? live[position] : null
    },
    rejected: () => Object.freeze([...gone]),
    live: () => Object.freeze([...live]),
    moveTo: (slot: number) => {
      const at = live.indexOf(slot)
      if (at < 0) return false
      position = at
      return true
    }
  })
}

// ── Bundle F: group-aware native routing (implementation_plan.md §12.5, D8-11) ──────────────

/**
 * Every ranked non-invalid slot a native run may route through. `ACTIVE_SET_SIZE` still sizes the CLI,
 * Fetch Models completeness and auto-selection; it does not cap native routing.
 */
export function rankedNativeSlots(slots: readonly KeySlot[]): number[] {
  return orderKeySlots(slots)
}

/** One routable slot, as the router sees it before each attempt. Slot indices and group ids only. */
export interface RouteSlot {
  slot: number
  tier: 'free' | 'paid'
  groupId: string
  /** Positive live evidence that this slot's key does not list the run's model. Unknown is eligible. */
  modelAbsent: boolean
}

/** What one Quota Group can do for the run's model right now. */
export type GroupReadiness =
  | { state: 'ready' }
  | { state: 'waiting'; metric: BudgetMetric; readyAtMono: number; untilEpochMs: number }
  | { state: 'dailyExhausted'; untilEpochMs: number; resetSource: 'api' | 'pacific' }

export type RouteChoice =
  | { kind: 'send'; slot: number; groupId: string; tier: 'free' | 'paid'; route: 'free' | 'paid'; paidFallback: boolean }
  | { kind: 'wait'; slot: number; groupId: string; metric: BudgetMetric; readyAtMono: number; untilEpochMs: number }
  | { kind: 'dailyExhausted'; untilEpochMs: number; resetSource: 'api' | 'pacific' }
  /** Every remaining slot has positive evidence that it cannot call the model. Nothing may be sent. */
  | { kind: 'modelUnavailable' }
  /** Every slot this run was given has been rejected. */
  | { kind: 'noKey' }

export interface RouteInput {
  /** The run's live slots in rank order, rejected ones already removed. */
  ranked: readonly RouteSlot[]
  /** The slot the previous attempt used, kept while its group can still send. */
  current: number | null
  allowPaidFallback: boolean
  /** The last attempt on a Free route failed on quota/rate pressure or overload: a consented Paid fallback may now be used. */
  reactive: boolean
  readinessOf(groupId: string): GroupReadiness
}

/**
 * Choose the slot for the next attempt (§12.5).
 *
 * The route is the tier of the effective primary — the first live slot, before model filtering. A Paid
 * route sends through eligible Paid slots without Free pacing; a Free slot on it still waits for its
 * group. A Free route keeps the current group while it can send, otherwise takes the different-group
 * Free slot that can send earliest (rank order on ties). Another key in the same group is never new
 * capacity. A Paid slot on a Free route needs `allowPaidFallback`, and is used only reactively — after a
 * Free attempt failed on quota or overload, or when every eligible Free group is spent for the day.
 */
export function chooseRoute(input: RouteInput): RouteChoice {
  const { ranked } = input
  if (ranked.length === 0) return { kind: 'noKey' }
  const route = ranked[0].tier
  const eligible = ranked.filter((s) => !s.modelAbsent)
  const free = eligible.filter((s) => s.tier === 'free')
  const paid = eligible.filter((s) => s.tier === 'paid')
  const cache = new Map<string, GroupReadiness>()
  const ready = (groupId: string): GroupReadiness => {
    let r = cache.get(groupId)
    if (!r) {
      r = input.readinessOf(groupId)
      cache.set(groupId, r)
    }
    return r
  }
  const send = (s: RouteSlot, paidFallback = false): RouteChoice => ({ kind: 'send', slot: s.slot, groupId: s.groupId, tier: s.tier, route, paidFallback })

  // Free candidates: one slot per group, the current slot for its own group, else the group's best rank.
  const byGroup = new Map<string, RouteSlot>()
  for (const s of free) {
    const held = byGroup.get(s.groupId)
    if (!held || s.slot === input.current) byGroup.set(s.groupId, s)
  }
  const currentSlot = free.find((s) => s.slot === input.current)
  const candidates = [...byGroup.values()].sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b))
  if (currentSlot) {
    candidates.splice(candidates.indexOf(byGroup.get(currentSlot.groupId)!), 1)
    candidates.unshift(byGroup.get(currentSlot.groupId)!)
  }

  if (route === 'paid') {
    for (const s of eligible) {
      if (s.tier === 'paid') return send(s)
      if (ready(s.groupId).state === 'ready') return send(s)
    }
  } else {
    if (eligible.length > 0 && free.length === 0) {
      return paid.length > 0 && input.allowPaidFallback ? send(paid[0], true) : { kind: 'modelUnavailable' }
    }
    for (const s of candidates) if (ready(s.groupId).state === 'ready') return send(s)
  }
  if (eligible.length === 0) return { kind: 'modelUnavailable' }

  let wait: Extract<RouteChoice, { kind: 'wait' }> | null = null
  let reset: Extract<RouteChoice, { kind: 'dailyExhausted' }> | null = null
  for (const s of candidates) {
    const r = ready(s.groupId)
    if (r.state === 'waiting' && (!wait || r.readyAtMono < wait.readyAtMono)) {
      wait = { kind: 'wait', slot: s.slot, groupId: s.groupId, metric: r.metric, readyAtMono: r.readyAtMono, untilEpochMs: r.untilEpochMs }
    }
    if (r.state === 'dailyExhausted' && (!reset || r.untilEpochMs < reset.untilEpochMs)) {
      reset = { kind: 'dailyExhausted', untilEpochMs: r.untilEpochMs, resetSource: r.resetSource }
    }
  }
  if (route === 'free' && paid.length > 0 && input.allowPaidFallback && (input.reactive || !wait)) return send(paid[0], true)
  return wait ?? reset ?? { kind: 'modelUnavailable' }
}
