/**
 * Pure API-key slot ranking, shared by the main process and the renderer.
 *
 * SECURITY CONTRACT: this module takes and returns **slot indices only**. No key
 * material may ever be passed in or out. `pythonBridge.orderKeysByValidity` is a thin
 * wrapper that maps indices back to key strings locally in main; the renderer uses the
 * indices directly so it can show which slots will be used without ever handling a
 * secret.
 *
 * Keeping ONE ranking implementation is load-bearing beyond tidiness: the "active set"
 * that gates automatic model changes is defined as what this function returns, and that
 * is only a sound basis for "what can run right now" while the display path and the
 * spawn path rank and truncate identically.
 */

import type { ModelInfo } from './types'

export interface KeySlot {
  /** Index into `AppSettings.apiKeys`. Callers must pre-filter empty slots. */
  index: number
  valid: boolean | null
  /** 'free' | 'paid'. Carried for callers that report the effective tier; not used for ranking. */
  tier: string
}

/**
 * Translation emits two keys (`-k` / `-k2`). Transcription emits only the primary.
 * This constant is the translation/active-set size; a spawn that cannot switch must
 * slice the ranked list to 1 itself (SOL-23).
 */
export const ACTIVE_SET_SIZE = 2

/**
 * Rank slots so a known-valid key is always primary: valid first, unchecked next,
 * known-invalid dropped entirely. An all-rejected set is empty — a start must refuse
 * rather than resurrect credentials the API already refused (SOL-30). Ties keep the
 * caller's original order.
 */
export function orderKeySlots(slots: readonly KeySlot[]): number[] {
  const rank = (v: boolean | null): number => (v === true ? 0 : v === null ? 1 : 2)
  return slots
    .filter((s) => s.valid !== false)
    .map((slot, position) => ({ slot, position }))
    .sort((a, b) => rank(a.slot.valid) - rank(b.slot.valid) || a.position - b.position)
    .map((e) => e.slot.index)
}

/**
 * The ACTIVE SET: exactly the slots `buildTranslateArgs` emits as `-k` / `-k2`.
 *
 * Its size comes from the ranked list, **never** from a count of configured slots. The
 * ranking drops known-invalid slots, so one valid key plus invalid reserves yields a
 * ONE-slot active set even though two slots are configured. Sizing it by configured
 * count would overstate cardinality and silently freeze default auto-advance for those
 * users, and for every single-key user.
 */
export function activeKeySlots(slots: KeySlot[]): number[] {
  return orderKeySlots(slots).slice(0, ACTIVE_SET_SIZE)
}

/** Display role of a slot for the current ranking. */
export type KeyRole = 'primary' | 'fallback' | 'reserve'

/** Map ranked slot indices to their role, for the secret-safe key list in Settings. */
export function keyRoles(slots: KeySlot[]): Map<number, KeyRole> {
  const ordered = orderKeySlots(slots)
  const roles = new Map<number, KeyRole>()
  ordered.forEach((index, position) => {
    roles.set(index, position === 0 ? 'primary' : position === 1 ? 'fallback' : 'reserve')
  })
  return roles
}

/**
 * `ModelInfo.availableOn` holds SLOT INDICES, so it only means anything while those
 * indices still denote the keys that produced the evidence. Editing a key replaces the
 * identity behind an index, and removing one renumbers every index above it — either way
 * the stored evidence silently starts describing a different key.
 *
 * That matters beyond a cosmetic label: `guardModelForSpawn` reads exactly this field to
 * decide whether a model is proven available, so stale evidence turns the pre-spawn guard
 * from a check into a rubber stamp.
 *
 * Both helpers below are deliberately NON-destructive about the user's selection: an entry
 * that loses all evidence degrades to `seed` (i.e. "unverified"), never disappears. Losing
 * evidence is not proof of absence, and only a refresh may produce new evidence.
 */
function remapEvidence(models: ModelInfo[], remap: (slot: number) => number | null): ModelInfo[] {
  return models.map((m) => {
    if (m.source !== 'live') return m
    const kept = (m.availableOn ?? [])
      .map(remap)
      .filter((s): s is number => s !== null)
    return kept.length ? { ...m, availableOn: kept } : { ...m, source: 'seed', availableOn: [] }
  })
}

/** A key was edited in place: whatever slot `slot` reported was reported by a different key. */
export function forgetSlotEvidence(models: ModelInfo[], slot: number): ModelInfo[] {
  return remapEvidence(models, (s) => (s === slot ? null : s))
}

/** A key was removed: drop its evidence and shift every higher slot down to match. */
export function reindexEvidenceAfterRemoval(models: ModelInfo[], removed: number): ModelInfo[] {
  return remapEvidence(models, (s) => (s === removed ? null : s > removed ? s - 1 : s))
}
