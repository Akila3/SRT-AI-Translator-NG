import fs from 'fs'
import { randomUUID } from 'crypto'
import Store from 'electron-store'
import { DEFAULT_BATCH_CONTEXT_LINES, DEFAULT_RESUME_CONTEXT_SIZE, DEFAULT_TRANSCRIBE_POLISH, type AppSettings, type LearnedQuotaEvidence, type ModelInfo } from '../shared/types'
import {
  applyQuotaGroupMutation,
  createDefaultQuotaGroup,
  DEFAULT_QUOTA_GROUP_ID,
  followKeySlots,
  recordLearnedEvidence,
  type QuotaGroupMutation,
  type QuotaGroupMutationResult
} from '../shared/quotaGroups'
import type { SettingsRevisionSource } from '../engine/adapter'
import { CURRENT_SCHEMA_VERSION, migrateSettings, sanitizeSettingsView, readVersion } from './migrations'

/**
 * Static seed model list.
 *
 * Two properties matter and are easy to break:
 *
 * 1. It is ALIAS-FREE. Earlier builds injected invented `-latest` ids that Google does
 *    not publish, which the engine rejects with a hard `exit(1)` (main.py:645) and which
 *    additionally defeat its thinking-config substring match (main.py:207-243).
 * 2. It is DISPLAY-ONLY and explicitly `source: 'seed'` — never evidence that a model is
 *    runnable. Only a live fetch against the user's own key proves that.
 *
 * Ids are taken from the engine's pricing.json intersected with what this app supports.
 */
export const DEFAULT_MODELS: ModelInfo[] = [
  { id: 'gemini-3.5-flash', label: 'Gemini Flash 3.5', source: 'seed', availableOn: [] },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini Flash Lite 3.1', source: 'seed', availableOn: [] },
  { id: 'gemini-3.1-pro', label: 'Gemini Pro 3.1', source: 'seed', availableOn: [] },
  { id: 'gemini-2.5-flash', label: 'Gemini Flash 2.5', source: 'seed', availableOn: [] },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini Flash Lite 2.5', source: 'seed', availableOn: [] },
  { id: 'gemini-2.5-pro', label: 'Gemini Pro 2.5', source: 'seed', availableOn: [] }
]

/**
 * Static fallback only — the newest flash-lite in the seed list. The live rule
 * (`resolveDefaultModel` over the runnable set) supersedes it on the first successful
 * refresh.
 *
 * This constant MUST stay alias-free: migration M3 remaps stored aliases to it and then
 * bumps the schema version, and migrations never re-run. An alias here would strand
 * every migrated profile on an unrunnable id, permanently.
 */
export const DEFAULT_MODEL_ID = 'gemini-3.1-flash-lite'

const defaults: AppSettings = {
  // MUST be 0: electron-store returns the default for absent keys, so any other value
  // makes every legacy profile claim it is already migrated.
  schemaVersion: 0,
  sourceLang: 'auto',
  targetLang: '',
  apiKeys: [''],
  apiKeyTiers: ['free'],
  apiKeyValid: [null],
  apiKeyError: [''],
  theme: 'auto',
  model: DEFAULT_MODEL_ID,
  modelNeedsVerification: false,
  batchSize: 100,
  // ON is what a new install sees. An existing profile without the key is pinned to false by M8.
  batchContext: true,
  batchContextLines: DEFAULT_BATCH_CONTEXT_LINES,
  customGenerationParams: false,
  temperature: 1.0,
  topP: 0.95,
  topK: null,
  thinkingLevel: 'low',
  thinkingBudget: 512,
  transcribeOverride: false,
  transcribeModel: '',
  transcribeThinkingLevel: '',
  transcribeThinkingBudget: 0,
  transcribePolish: DEFAULT_TRANSCRIBE_POLISH,
  transcribePolishModel: '',
  serviceTier: 'standard',
  paidQuota: false,
  disableStreaming: false,
  resumeContextSize: DEFAULT_RESUME_CONTEXT_SIZE,
  tmdbApiKey: 'a07324c669cac4d96789197134ce272b',
  outputFolder: '',
  rtlEnabled: true,
  rtlMethod: 'hybrid',
  ffmpegPath: '',
  systemPrompt: '',
  showTokenStats: true,
  writeTokenReport: false,
  progressLog: false,
  thoughtsLog: false,
  cachedModels: DEFAULT_MODELS,
  modelsUpdatedAt: null,
  automaticFreeTierProtection: true,
  manualQuotaLimitsEnabled: false,
  allowPaidFallback: false,
  manualQuotaReservePercent: 10,
  apiKeyQuotaGroups: [DEFAULT_QUOTA_GROUP_ID],
  quotaGroups: [createDefaultQuotaGroup()],
  learnedQuotaEvidence: [],
  hebrewAdvanced: false,
  hebrewSpeakerRepair: false,
  hebrewMethodB: false,
  hebrewC1Spanish: false,
  hebrewC1Portuguese: false,
  openSubtitlesApiKey: '',
  openSubtitlesUsername: '',
  openSubtitlesPassword: '',
  subtitleSourceOpenSubtitles: true,
  subtitleSourceWizdom: false
}

/** This build's AppSettings. Runtime-view fallback only — never Conf constructor defaults. */
export const DEFAULT_SETTINGS: AppSettings = defaults

export const store = new Store<AppSettings>({
  // Empty on purpose. Conf writes `defaults ∪ file` at construction whenever they differ,
  // which would dump this build's schema into a newer-build profile before migrations
  // even run (SOL-35). This build's defaults are applied by sanitizeSettingsView.
  defaults: {} as AppSettings
})

/**
 * Run the migration chain once, at module load, and write the result in a SINGLE call.
 *
 * The previous code applied several unconditional, un-versioned edits on every start —
 * including a full `cachedModels` reset — which is one of the two candidate causes of
 * the "fetched models do not persist" bug.
 */
function runMigrations(): void {
  const result = migrateSettings(store.store as unknown as Record<string, unknown>, {
    defaultModelId: DEFAULT_MODEL_ID,
    defaults: {
      customGenerationParams: defaults.customGenerationParams,
      resumeContextSize: defaults.resumeContextSize,
      modelNeedsVerification: defaults.modelNeedsVerification
    }
  })

  for (const note of result.notes) console.log(`[settings-migration] ${note}`)
  if (result.downgrade) return

  // Shape repair is a separate pass from the versioned steps: M4/M6 leave a non-array cache
  // untouched so a bad field cannot loop, but consumers iterate it as ModelInfo[]. A current
  // version with the same damage skips the chain entirely. Neither case may reach the UI.
  const sanitized = sanitizeSettingsView(result.settings, DEFAULT_SETTINGS)
  for (const note of sanitized.notes) console.log(`[settings-sanitize] ${note}`)
  if (!result.changed && !sanitized.changed) return

  // One tiny backup before the first migrated write turns a migration bug from
  // unrecoverable into a support instruction.
  try {
    const backup = store.path.replace(/config\.json$/i, `config.pre-v${CURRENT_SCHEMA_VERSION}.bak`)
    if (fs.existsSync(store.path) && !fs.existsSync(backup)) {
      fs.copyFileSync(store.path, backup)
      console.log(`[settings-migration] backed up config.json to ${backup}`)
    }
  } catch (err) {
    console.warn(`[settings-migration] could not write the pre-migration backup: ${String(err)}`)
  }

  store.set(sanitized.persist as unknown as Partial<AppSettings>)
  if (result.changed) {
    console.log(
      `[settings-migration] migrated settings from schemaVersion ${result.fromVersion} to ${result.toVersion}`
    )
  }
}

runMigrations()

export function getSettings(): AppSettings {
  const { settings } = sanitizeSettingsView(
    store.store as unknown as Record<string, unknown>,
    DEFAULT_SETTINGS
  )
  return settings as unknown as AppSettings
}

/**
 * The Settings revision (implementation_plan.md §12.4 step 6): starts at zero, advances only after a
 * Settings write has returned, and tells each subscriber the new number synchronously. A run's budget
 * wait treats any advance as "recompute before sending"; it never reads which field changed.
 */
let revision = 0
const revisionListeners = new Set<(revision: number) => void>()

export const settingsRevisions: SettingsRevisionSource = Object.freeze({
  current: () => revision,
  subscribe: (listener: (revision: number) => void) => {
    revisionListeners.add(listener)
    return () => {
      revisionListeners.delete(listener)
    }
  }
})

function settingsWritten(): void {
  revision += 1
  for (const listener of [...revisionListeners]) {
    try {
      listener(revision)
    } catch {
      /* a subscriber's fault never undoes a write */
    }
  }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const rest = { ...patch }
  delete rest.schemaVersion
  const file = store.store as unknown as Record<string, unknown>
  // A key added or removed moves its group slot in this same write (§12.3), so the slot arrays can
  // never describe different keys, even for a moment.
  if (Array.isArray(rest.apiKeys) && rest.apiKeyQuotaGroups === undefined) {
    const before = getSettings()
    const followed = followKeySlots(before.apiKeys, rest.apiKeys, rawGroupSlots(file, before.apiKeyQuotaGroups))
    if (JSON.stringify(followed) !== JSON.stringify(file.apiKeyQuotaGroups)) rest.apiKeyQuotaGroups = followed
  }
  if (readVersion(file) > CURRENT_SCHEMA_VERSION) {
    // Patch keys only. Spreading store.store would write this build's defaults (and Conf
    // already merges them into the getter) into a profile this build does not own (SOL-35).
    store.set(rest as unknown as Partial<AppSettings>)
    settingsWritten()
    return getSettings()
  }
  const merged = { ...file, ...rest }
  const { persist } = sanitizeSettingsView(merged, DEFAULT_SETTINGS)
  store.set(persist as unknown as Partial<AppSettings>)
  settingsWritten()
  return getSettings()
}

/** The stored per-slot group ids, with a non-string entry kept as it was stored. */
function rawGroupSlots(file: Record<string, unknown>, view: string[]): string[] {
  const raw = file.apiKeyQuotaGroups
  return Array.isArray(raw) ? (raw as string[]) : view
}

/** The three arrays only main may write: a renderer patch that names them has them removed (§12.3). */
export const MAIN_OWNED_SETTINGS = ['apiKeyQuotaGroups', 'quotaGroups', 'learnedQuotaEvidence'] as const

/** `settings:set` from a window: Feature 8 scalars pass, the managed group/evidence arrays do not. */
export function setSettingsFromRenderer(patch: Partial<AppSettings>): AppSettings {
  const rest: Partial<AppSettings> = { ...(patch ?? {}) }
  for (const key of MAIN_OWNED_SETTINGS) delete rest[key]
  return setSettings(rest)
}

/**
 * One element of the written array: the stored original where the reducer left the element as it
 * found it (same object), so a record this build reads only partly is not rewritten by an edit to
 * another one. A changed or new element is written as the reducer made it.
 */
function keepUntouched<T>(rawList: unknown, viewBefore: readonly T[], viewAfter: readonly T[]): unknown[] {
  const raw = Array.isArray(rawList) ? rawList : []
  return viewAfter.map((el) => {
    const i = viewBefore.indexOf(el)
    return i >= 0 && i < raw.length ? raw[i] : el
  })
}

/**
 * Apply one Quota Group edit (`settings:mutateQuotaGroup`): re-read the stored Settings, run the pure
 * reducer with the active-run registry's ids, and write once. A refused edit writes nothing.
 */
export function mutateQuotaGroup(
  mutation: QuotaGroupMutation,
  activeGroupIds: ReadonlySet<string>,
  uuid: () => string = randomUUID
): QuotaGroupMutationResult {
  const before = getSettings()
  const result = applyQuotaGroupMutation(before, mutation, activeGroupIds, uuid)
  if (!result.ok) return result
  const file = store.store as unknown as Record<string, unknown>
  const after = result.settings
  const patch: Record<string, unknown> = {}
  if (after.quotaGroups !== before.quotaGroups) patch.quotaGroups = keepUntouched(file.quotaGroups, before.quotaGroups, after.quotaGroups)
  if (after.learnedQuotaEvidence !== before.learnedQuotaEvidence) {
    patch.learnedQuotaEvidence = keepUntouched(file.learnedQuotaEvidence, before.learnedQuotaEvidence, after.learnedQuotaEvidence)
  }
  if (after.apiKeyQuotaGroups !== before.apiKeyQuotaGroups) {
    const raw = rawGroupSlots(file, before.apiKeyQuotaGroups)
    patch.apiKeyQuotaGroups = after.apiKeyQuotaGroups.map((id, i) => (id === before.apiKeyQuotaGroups[i] && i < raw.length ? raw[i] : id))
  }
  store.set(patch as unknown as Partial<AppSettings>)
  settingsWritten()
  const settings = getSettings()
  return { ...result, settings }
}

/**
 * Record one structured 429 observation (D8-6), bounded per group/model/metric. Called by a run as it
 * learns, so it advances the revision like any Settings write: a waiting request recomputes.
 */
export function recordQuotaEvidence(row: LearnedQuotaEvidence): void {
  const before = getSettings()
  const file = store.store as unknown as Record<string, unknown>
  const next = recordLearnedEvidence(before.learnedQuotaEvidence, row)
  store.set({ learnedQuotaEvidence: keepUntouched(file.learnedQuotaEvidence, before.learnedQuotaEvidence, next) } as unknown as Partial<AppSettings>)
  settingsWritten()
}
