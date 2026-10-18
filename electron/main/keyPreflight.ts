/**
 * The main process's one owner of key-slot metadata and the key check's result (Step 4.1).
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * `keySlotsFor` and `noUsableApiKeyMessage` moved here unchanged from `pythonBridge.ts`, so the
 * model refresh, the IPC guards and the run adapters read slots from one place without importing the
 * CLI bridge. Ordering stays in `shared/keyOrder.ts`; request routing stays in `engine/keys.ts`.
 */
import { getSettings } from './store'
import type { KeySlot } from '../shared/keyOrder'

/**
 * What a key preflight can conclude, and what to tell the user.
 *
 * Asymmetric on purpose, exactly like `guardModelForSpawn`: only `rejected` stops a run.
 * "I could not reach Google" is not evidence against the key, and refusing to start because the
 * network blinked would be a worse failure than letting the engine report the truth.
 */
export interface KeyPreflight {
  verdict: 'valid' | 'rejected' | 'unchecked'
  message: string
}

/**
 * Describe each non-empty key slot with the validity/tier metadata stored for it.
 *
 * THE single place slot metadata is assembled in the main process. `modelsList` ranks
 * the same descriptors to decide which keys are "active", and that answer must match the
 * pair this file actually spawns with — if the two drifted, a model could be offered
 * because a reserve key can see it and then 404 at spawn time.
 *
 * `apiKeyValid`/`apiKeyTiers` are index-aligned with `apiKeys`, so slot i is read
 * directly; the indexOf fallback covers a caller passing a re-ordered/partial array.
 */
export function keySlotsFor(apiKeys: string[]): KeySlot[] {
  const s = getSettings()
  const slots: KeySlot[] = []
  apiKeys.forEach((raw, i) => {
    const k = typeof raw === 'string' ? raw.trim() : ''
    if (!k) return
    const stored = s.apiKeys ?? []
    const idx =
      typeof stored[i] === 'string' && stored[i].trim() === k
        ? i
        : stored.findIndex((x) => typeof x === 'string' && x.trim() === k)
    slots.push({
      index: i,
      valid: idx >= 0 ? s.apiKeyValid?.[idx] ?? null : null,
      tier: idx >= 0 ? s.apiKeyTiers?.[idx] ?? 'free' : 'free'
    })
  })
  return slots
}

/**
 * What to tell the user when ranking produced no spawnable key.
 *
 * Empty configured slots and an all-rejected set are different situations; both refuse
 * the start (SOL-30) and both must say what to do next rather than spawning without `-k`.
 */
export function noUsableApiKeyMessage(slots: readonly KeySlot[]): string {
  if (slots.length === 0) {
    return 'No API key is configured. Open Settings > Gemini API Keys and enter a key before starting.'
  }
  return (
    'Every configured API key was rejected by Google. Open Settings > Gemini API Keys, ' +
    'fix or replace a key, and run “Fetch Models & Check API Keys” before starting again.'
  )
}
