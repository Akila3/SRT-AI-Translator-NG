/**
 * Versioned, non-destructive settings migrations.
 *
 * DATA-LOSS SENSITIVE. Persisted user data — API keys, the model cache and the model
 * selection — flows through here, so every rule below is deliberate:
 *
 *  - `defaults.schemaVersion` MUST be 0. electron-store returns the default for any
 *    absent key, so any other default makes legacy profiles report "already migrated"
 *    and skip the entire chain.
 *  - Migrations run at module load, offline, before any window or fetch exists. They
 *    therefore cannot prove that a model is gone and MUST NOT replace one. The strongest
 *    action available to them is to raise `modelNeedsVerification`.
 *  - Filter, never reset. The pre-existing code wiped the whole model cache whenever it
 *    contained one of four ids; M4 removes only the offending entries.
 *  - Idempotent throughout, because electron-store gives no cross-key transaction: a
 *    crash between the write and the version bump must be harmless on the next launch.
 *  - Versioned steps do not invent a replacement for a malformed field (anti-loop: a bad
 *    value must never wedge the chain). Runtime sanitisation (`sanitizeSettingsView`) is a
 *    separate pass: it exposes this build's AppSettings types to every consumer (arrays
 *    and scalars). Persistable repairs are only lossless coercions (a scalar key becomes
 *    a one-element array). Unconvertible values stay on disk; the seed list and empty
 *    slots exist only in the runtime view. A newer build's profile is never written by
 *    this pass.
 *
 * Kept free of electron-store and electron imports so the gate G1/G1b fixtures can run
 * the real chain rather than a copy of it.
 */
import {
  DEFAULT_BATCH_CONTEXT_LINES,
  MAX_BATCH_CONTEXT_LINES,
  MIN_BATCH_CONTEXT_LINES,
  RTL_METHODS,
  type AppSettings,
  type LearnedQuotaEvidence,
  type ManualQuotaValues,
  type ModelInfo,
  type QuotaGroupSettings,
  type RtlMethod
} from '../shared/types'
import { createDefaultQuotaGroup, DEFAULT_QUOTA_GROUP_ID } from '../shared/quotaGroups'

/** Bumped by the step that owns the migration: Steps 5 (1-3), 3b (4), REP-28 (5), Bundle L R-L.1 (6), Bundle F F1 (7), Feature 17 F17.0 (8). */
export const CURRENT_SCHEMA_VERSION = 8

/** Feature 17's four layer switches, in Settings order. */
export const FEATURE17_FIELDS = ['hebrewSpeakerRepair', 'hebrewMethodB', 'hebrewC1Spanish', 'hebrewC1Portuguese'] as const

/**
 * Ids a previous build removed from the picker. Two of them (`gemini-2.0-flash`,
 * `gemini-2.0-flash-lite`) are REAL models listed in the engine's own pricing.json;
 * they were dropped by a display-curation rule, not because they ceased to exist. That
 * is precisely why M1 only flags them.
 */
export const SUSPICIOUS_MODEL_IDS = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite'
]

const ALIAS_RE = /-latest$/

export interface MigrationContext {
  /** The static fallback M3 remaps aliases to. MUST already be alias-free (Step 5a.0). */
  defaultModelId: string
  /** Used by M5 to fill fields that a legacy profile has never heard of. */
  defaults: Pick<AppSettings, 'customGenerationParams' | 'resumeContextSize' | 'modelNeedsVerification'>
}

export interface MigrationResult {
  /** The migrated object. Unknown keys are passed through untouched. */
  settings: Record<string, unknown>
  /** Version the profile came in at (absent === 0). */
  fromVersion: number
  /** Version the profile is at on the way out. */
  toVersion: number
  /** True when anything at all needs writing back. */
  changed: boolean
  /** True when the profile came from a NEWER build and was deliberately left alone. */
  downgrade: boolean
  /** Human-readable trail; the caller logs these once. */
  notes: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function readVersion(raw: Record<string, unknown>): number {
  const v = raw.schemaVersion
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

export function migrateSettings(
  raw: Record<string, unknown>,
  ctx: MigrationContext
): MigrationResult {
  const from = readVersion(raw)
  // Read before any step adds a field: an empty object is a brand-new install (M8).
  const existingProfile = Object.keys(raw).length > 0
  const next: Record<string, unknown> = { ...raw }
  const notes: string[] = []
  let changed = false

  const setField = (key: string, value: unknown, note: string): void => {
    next[key] = value
    changed = true
    notes.push(note)
  }

  if (from > CURRENT_SCHEMA_VERSION) {
    // Downgrade guard. A profile written by a newer build must not be "repaired" —
    // rewriting fields we do not understand is data loss, not recovery.
    return {
      settings: raw,
      fromVersion: from,
      toVersion: from,
      changed: false,
      downgrade: true,
      notes: [
        `settings schemaVersion ${from} is newer than this build's ${CURRENT_SCHEMA_VERSION}; ` +
          'skipping all migrations and leaving the profile untouched'
      ]
    }
  }

  if (from === CURRENT_SCHEMA_VERSION) {
    return {
      settings: raw,
      fromVersion: from,
      toVersion: from,
      changed: false,
      downgrade: false,
      notes: []
    }
  }

  // ── M1 (v<1): flag a suspicious model id. NEVER replace it. ────────────────────
  // A migration runs offline and cannot prove a model is gone; only an `allComplete`
  // refresh can. Replacing here would silently destroy a valid user override.
  if (from < 1) {
    const model = next.model
    if (typeof model === 'string' && SUSPICIOUS_MODEL_IDS.includes(model)) {
      if (next.modelNeedsVerification !== true) {
        setField(
          'modelNeedsVerification',
          true,
          `M1: stored model "${model}" was dropped by an older build's picker; flagged for verification (left unchanged)`
        )
      }
    }
  }

  // ── M2 (v<1): per-key validity/error became arrays. ────────────────────────────
  if (from < 1) {
    if (!Array.isArray(next.apiKeyValid)) {
      const v = next.apiKeyValid
      setField(
        'apiKeyValid',
        [v === true || v === false ? v : null],
        'M2: coerced scalar apiKeyValid into a single-element array'
      )
    }
    if (!Array.isArray(next.apiKeyError)) {
      const e = next.apiKeyError
      setField(
        'apiKeyError',
        [typeof e === 'string' ? e : ''],
        'M2: coerced scalar apiKeyError into a single-element array'
      )
    }
  }

  // ── M3 (v<2): remap an invented "-latest" alias to a real, versioned id. ───────
  // The alias is a name WE fabricated and injected, not a choice among real models, so
  // remapping it is not destroying a user selection. It maps to the STATIC constant —
  // migrations have no live model data and must never call a resolver.
  if (from < 2) {
    const model = next.model
    if (typeof model === 'string' && ALIAS_RE.test(model)) {
      if (ALIAS_RE.test(ctx.defaultModelId)) {
        // Step 5a.0 was skipped. Remapping an alias to another alias would strand the
        // profile permanently, because the version bump makes this unreachable again.
        notes.push(
          `M3: REFUSED to remap "${model}" — DEFAULT_MODEL_ID is itself an alias ` +
            `("${ctx.defaultModelId}"). De-alias the store constants (Step 5a.0) first.`
        )
      } else {
        setField('model', ctx.defaultModelId, `M3: remapped alias "${model}" to "${ctx.defaultModelId}"`)
        if (next.modelNeedsVerification !== true) {
          setField('modelNeedsVerification', true, 'M3: flagged the remapped model for verification')
        }
      }
    }
  }

  // ── M4 (v<2): filter aliases out of the model cache. ───────────────────────────
  // Replaces the old unconditional `cachedModels = DEFAULT_MODELS` reset, which is the
  // one genuinely destructive operation in the previous code.
  if (from < 2) {
    const cached = next.cachedModels
    if (Array.isArray(cached)) {
      const kept = cached.filter(
        (m) => !(isPlainObject(m) && typeof m.id === 'string' && ALIAS_RE.test(m.id))
      )
      if (kept.length !== cached.length) {
        setField(
          'cachedModels',
          kept,
          `M4: removed ${cached.length - kept.length} "-latest" alias entr${
            cached.length - kept.length === 1 ? 'y' : 'ies'
          } from the model cache; kept the other ${kept.length}`
        )
      }
    } else if (cached !== undefined) {
      notes.push('M4: cachedModels is not an array; left untouched')
    }
  }

  // ── M5 (v<3): introduce fields that legacy profiles have never seen. ───────────
  if (from < 3) {
    const introduced: [string, unknown][] = [
      ['customGenerationParams', ctx.defaults.customGenerationParams],
      ['resumeContextSize', ctx.defaults.resumeContextSize],
      ['modelNeedsVerification', ctx.defaults.modelNeedsVerification]
    ]
    for (const [key, value] of introduced) {
      if (next[key] === undefined) {
        setField(key, value, `M5: added missing field ${key}`)
      }
    }
  }

  // ── M6 (v<4, owned by Step 3b): backfill model provenance. ─────────────────────
  // A cache written before provenance existed carries no evidence that anything is
  // runnable, so it backfills as `seed` — unverified — rather than as false `live`.
  if (from < 4) {
    const cached = next.cachedModels
    if (Array.isArray(cached)) {
      let touched = 0
      const backfilled = cached.map((m) => {
        if (!isPlainObject(m)) return m
        const hasSource = m.source === 'live' || m.source === 'seed'
        const hasAvailability = Array.isArray(m.availableOn)
        if (hasSource && hasAvailability) return m
        touched++
        return {
          ...m,
          source: hasSource ? m.source : 'seed',
          availableOn: hasAvailability ? m.availableOn : []
        }
      })
      if (touched > 0) {
        setField(
          'cachedModels',
          backfilled,
          `M6: backfilled provenance (source/availableOn) on ${touched} cached model entr${
            touched === 1 ? 'y' : 'ies'
          }`
        )
      }
    } else if (cached !== undefined) {
      notes.push('M6: cachedModels is not an array; left untouched')
    }
  }

  // ── M7 (v<5, REP-28): retired thinkingLevel "disabled" → "default". ───────────
  // "Disabled" used to be coerced to a real thinking_level (minimal/low) or to
  // --no-thinking. Neither is omit-the-flag, which is what the user asked for and
  // what Google documents as the model's own default. A leftover enum value would
  // render as a blank Select.
  if (from < 5 && next.thinkingLevel === 'disabled') {
    setField('thinkingLevel', 'default', 'M7: mapped thinkingLevel "disabled" to "default" (send nothing)')
  }

  // ── M8 (v<6, Bundle L): Cross-Batch Context defaults ON for new installs only. ─
  // A profile that already existed and never stored the key ran with it off, so it keeps
  // off. A stored value of either kind, and the line count, are never written here.
  if (from < 6 && existingProfile && next.batchContext === undefined) {
    setField('batchContext', false, 'M8: kept Cross-Batch Context off for an existing profile that never stored it')
  }

  // ── M9 (v<7): Free-tier protection fields, added only where missing. ──────────
  // Every key slot that has no group joins Group A; a present value of any shape is left exactly as
  // it is (the runtime view reads it conservatively). Nothing is reordered and no number is invented.
  // A brand-new install gets nothing: its view already reads these defaults (as with M8).
  if (from < 7 && existingProfile) {
    const introduced: [string, unknown][] = [
      ['automaticFreeTierProtection', true],
      ['manualQuotaLimitsEnabled', false],
      ['allowPaidFallback', false],
      ['manualQuotaReservePercent', 10],
      ['quotaGroups', [createDefaultQuotaGroup()]],
      ['learnedQuotaEvidence', []]
    ]
    for (const [key, value] of introduced) {
      if (next[key] === undefined) setField(key, value, `M9: added missing field ${key}`)
    }
    const keyCount = Array.isArray(next.apiKeys) ? Math.max(1, next.apiKeys.length) : 1
    const groups = next.apiKeyQuotaGroups
    if (groups === undefined) {
      setField('apiKeyQuotaGroups', Array.from({ length: keyCount }, () => DEFAULT_QUOTA_GROUP_ID), 'M9: put every key slot in Group A')
    } else if (Array.isArray(groups) && groups.length < keyCount) {
      const filled = [...groups]
      while (filled.length < keyCount) filled.push(DEFAULT_QUOTA_GROUP_ID)
      setField('apiKeyQuotaGroups', filled, `M9: put ${keyCount - groups.length} key slot(s) with no group in Group A`)
    }
  }

  // ── M10 (v<8, Feature 17 F17.0): the four Advanced Hebrew correction switches, OFF. ──
  // Only a missing field is added. A stored boolean of either value, and a malformed value (which the
  // runtime view reads as false), are left exactly as they are. A brand-new install's view reads false.
  if (from < 8 && existingProfile) {
    for (const key of FEATURE17_FIELDS) {
      if (next[key] === undefined) setField(key, false, `M10: added missing field ${key}`)
    }
  }

  // The version bump comes LAST, so a crash mid-chain simply re-runs it next launch.
  next.schemaVersion = CURRENT_SCHEMA_VERSION

  return {
    settings: next,
    fromVersion: from,
    toVersion: CURRENT_SCHEMA_VERSION,
    changed: true,
    downgrade: false,
    notes: changed ? notes : [...notes, 'no field changes were required; version bumped only']
  }
}

/**
 * Runtime shape repair, not a versioned migration.
 *
 * `migrateSettings` certifies a version even when a field was unreadable, so consumers must
 * not be handed `cachedModels: {}`, `[null]`, or `model: 123` just because the profile is
 * "current". The `settings` view is this build's AppSettings: iterable arrays, and every
 * other field overlaid only when its runtime type matches. Persistable repairs are only
 * lossless (a scalar key or `apiKeyValid: false` becomes a one-element array). Unconvertible
 * values stay on disk. A newer-schema profile gets the same view wraps without a write.
 */
export function sanitizeSettingsView(
  raw: Record<string, unknown>,
  fallback: AppSettings
): {
  settings: Record<string, unknown>
  persist: Record<string, unknown>
  notes: string[]
  changed: boolean
} {
  const from = readVersion(raw)
  if (from > CURRENT_SCHEMA_VERSION) {
    return {
      settings: runtimeSafe(raw, fallback),
      persist: raw,
      notes: [],
      changed: false
    }
  }

  const notes: string[] = []
  const persist: Record<string, unknown> = { ...raw }
  let changed = false

  const keys = losslessStringList(raw.apiKeys)
  if (keys.converted) {
    persist.apiKeys = keys.value
    changed = true
    notes.push(keys.note)
  }
  const valid = losslessTriStateList(raw.apiKeyValid)
  if (valid.converted) {
    persist.apiKeyValid = valid.value
    changed = true
    notes.push(valid.note)
  }
  const errors = losslessStringList(raw.apiKeyError)
  if (errors.converted) {
    persist.apiKeyError = errors.value
    changed = true
    notes.push(errors.note)
  }
  const tiers = losslessStringList(raw.apiKeyTiers, 'free')
  if (tiers.converted) {
    persist.apiKeyTiers = tiers.value
    changed = true
    notes.push(tiers.note)
  }
  const cached = losslessCachedModels(raw.cachedModels)
  if (cached.converted) {
    persist.cachedModels = cached.value
    changed = true
    notes.push(cached.note)
  }

  return {
    settings: runtimeSafe(persist, fallback),
    persist,
    notes,
    changed
  }
}

function losslessStringList(
  v: unknown,
  nonStringInArray = ''
): { converted: boolean; value: string[]; note: string } {
  if (typeof v === 'string') {
    return { converted: true, value: [v], note: 'wrapped a scalar string into a one-element array' }
  }
  if (!Array.isArray(v)) {
    return { converted: false, value: [], note: '' }
  }
  const value = v.map((x) => (typeof x === 'string' ? x : nonStringInArray))
  const converted = value.some((x, i) => x !== v[i])
  return {
    converted,
    value,
    note: converted ? 'coerced non-string array entries' : ''
  }
}

function losslessTriStateList(v: unknown): {
  converted: boolean
  value: Array<boolean | null>
  note: string
} {
  if (v === true || v === false || v === null) {
    return {
      converted: true,
      value: [v],
      note: 'wrapped a scalar validity verdict into a one-element array'
    }
  }
  if (!Array.isArray(v)) {
    return { converted: false, value: [], note: '' }
  }
  const value = v.map((x) => (x === true || x === false ? x : null))
  const converted = value.some((x, i) => x !== v[i])
  return {
    converted,
    value,
    note: converted ? 'coerced non-tristate validity entries to unchecked' : ''
  }
}

function losslessCachedModels(v: unknown): {
  converted: boolean
  value: ModelInfo[]
  note: string
} {
  if (!Array.isArray(v)) {
    return { converted: false, value: [], note: '' }
  }
  const kept: ModelInfo[] = []
  let mutated = false
  for (const entry of v) {
    const n = normalizeCachedEntry(entry)
    if (!n) {
      mutated = true
      continue
    }
    kept.push(n)
    if (!cachedEntryEqual(entry, n)) mutated = true
  }
  return {
    converted: mutated,
    value: kept,
    note: mutated
      ? 'normalised cached model entries (dropped unusable ones; live evidence needs an availableOn array)'
      : ''
  }
}

/**
 * This build's AppSettings, with only values whose runtime type consumers already
 * assume. Starts from `fallback` so a garbage field (`model: 123`) cannot override a
 * string and crash every mounted page (SOL-29). Scalar key/validity wraps land in the
 * view even on a newer-schema profile, without being persisted (SOL-30).
 */
function runtimeSafe(raw: Record<string, unknown>, fallback: AppSettings): Record<string, unknown> {
  const view: Record<string, unknown> = { ...fallback }
  view.schemaVersion = readVersion(raw)

  const keys = losslessStringList(raw.apiKeys)
  view.apiKeys = typeof raw.apiKeys === 'string' || Array.isArray(raw.apiKeys) ? keys.value : fallback.apiKeys
  const valid = losslessTriStateList(raw.apiKeyValid)
  view.apiKeyValid =
    raw.apiKeyValid === true || raw.apiKeyValid === false || raw.apiKeyValid === null || Array.isArray(raw.apiKeyValid)
      ? valid.value
      : fallback.apiKeyValid
  const errors = losslessStringList(raw.apiKeyError)
  view.apiKeyError =
    typeof raw.apiKeyError === 'string' || Array.isArray(raw.apiKeyError) ? errors.value : fallback.apiKeyError
  const tiers = losslessStringList(raw.apiKeyTiers, 'free')
  view.apiKeyTiers =
    typeof raw.apiKeyTiers === 'string' || Array.isArray(raw.apiKeyTiers) ? tiers.value : fallback.apiKeyTiers

  if (!Array.isArray(raw.cachedModels)) {
    view.cachedModels = fallback.cachedModels.map((m) => ({ ...m }))
  } else {
    view.cachedModels = raw.cachedModels
      .map(normalizeCachedEntry)
      .filter((m): m is ModelInfo => m !== null)
  }

  const skip = new Set([
    'schemaVersion',
    'apiKeys',
    'apiKeyValid',
    'apiKeyError',
    'apiKeyTiers',
    'cachedModels',
    'manualQuotaReservePercent',
    'apiKeyQuotaGroups',
    'quotaGroups',
    'learnedQuotaEvidence'
  ])
  for (const key of Object.keys(fallback) as (keyof AppSettings)[]) {
    if (skip.has(key)) continue
    view[key] = overlayField(key, fallback[key], raw[key])
  }
  // Absent reads as the default; a present value this build cannot apply stays visibly invalid (NaN)
  // so manual capacity becomes unavailable instead of a guessed percentage being used.
  const reserve = raw.manualQuotaReservePercent
  view.manualQuotaReservePercent =
    reserve === undefined
      ? fallback.manualQuotaReservePercent
      : typeof reserve === 'number' && Number.isFinite(reserve) && reserve >= 0 && reserve < 100
        ? reserve
        : Number.NaN
  view.apiKeyQuotaGroups = quotaGroupSlotsView(raw.apiKeyQuotaGroups, fallback.apiKeyQuotaGroups)
  view.quotaGroups = Array.isArray(raw.quotaGroups) ? raw.quotaGroups.map(quotaGroupView) : fallback.quotaGroups.map((g) => ({ ...g, manualByModel: {} }))
  view.learnedQuotaEvidence = Array.isArray(raw.learnedQuotaEvidence) ? raw.learnedQuotaEvidence.map(learnedView) : []
  // The generic overlay accepts any string; a method is one of five ids or the recommended one.
  view.rtlMethod = sanitizeRtlMethod(view.rtlMethod)
  view.batchContextLines = sanitizeBatchContextLines(raw.batchContextLines)
  // Absent: on only when a layer is stored on, so a profile already using one keeps it working.
  if (raw.hebrewAdvanced === undefined) view.hebrewAdvanced = FEATURE17_FIELDS.some((k) => raw[k] === true)
  return view
}

/**
 * The stored previous-context line count as an integer 4–10 (D15-1R; tester TD15-3). Absent,
 * fractional, non-finite and out-of-range values read as 5; nothing is written back.
 */
export function sanitizeBatchContextLines(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_BATCH_CONTEXT_LINES &&
    value <= MAX_BATCH_CONTEXT_LINES
    ? value
    : DEFAULT_BATCH_CONTEXT_LINES
}

/**
 * The stored RTL display method as one of the five ids (feature_decisions.md D12-14). Missing, non-string
 * and unknown values (a newer build's method included) read as `'hybrid'`; nothing is written back.
 */
export function sanitizeRtlMethod(value: unknown): RtlMethod {
  return typeof value === 'string' && (RTL_METHODS as readonly string[]).includes(value) ? (value as RtlMethod) : 'hybrid'
}

function overlayField(key: keyof AppSettings, fallbackVal: unknown, incoming: unknown): unknown {
  if (incoming === undefined) return fallbackVal
  if (key === 'topK') {
    if (incoming === null) return null
    return typeof incoming === 'number' && Number.isFinite(incoming) ? incoming : fallbackVal
  }
  if (key === 'modelsUpdatedAt') {
    if (incoming === null) return null
    return typeof incoming === 'string' ? incoming : fallbackVal
  }
  if (typeof fallbackVal === 'string') return typeof incoming === 'string' ? incoming : fallbackVal
  if (typeof fallbackVal === 'boolean') return typeof incoming === 'boolean' ? incoming : fallbackVal
  if (typeof fallbackVal === 'number') {
    return typeof incoming === 'number' && Number.isFinite(incoming) ? incoming : fallbackVal
  }
  return fallbackVal
}

function normalizeCachedEntry(m: unknown): ModelInfo | null {
  if (!isPlainObject(m) || typeof m.id !== 'string' || !m.id) return null
  const label = typeof m.label === 'string' && m.label ? m.label : m.id
  const slots = Array.isArray(m.availableOn)
    ? m.availableOn.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : null
  if (m.source === 'live' && slots) {
    return withLimitEvidence({ ...m, id: m.id, label, source: 'live', availableOn: slots })
  }
  // A seed entry is not evidence of anything, its token limits included.
  const seed: ModelInfo = { ...m, id: m.id, label, source: 'seed', availableOn: [] }
  delete seed.inputTokenLimit
  delete seed.outputTokenLimit
  delete seed.limitsFetchedAt
  return seed
}

/** Token limits in the view only as positive integers; anything else reads as unknown. */
function withLimitEvidence(m: ModelInfo): ModelInfo {
  const out = { ...m }
  const ok = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0
  if (!ok(out.inputTokenLimit)) delete out.inputTokenLimit
  if (!ok(out.outputTokenLimit)) delete out.outputTokenLimit
  if (typeof out.limitsFetchedAt !== 'string') delete out.limitsFetchedAt
  return out
}

/** Per-slot group ids as stored; a non-string entry reads as '' (an orphan the view maps to Group A). */
function quotaGroupSlotsView(v: unknown, fallback: string[]): string[] {
  if (typeof v === 'string') return [v]
  if (!Array.isArray(v)) return [...fallback]
  return v.map((x) => (typeof x === 'string' ? x : ''))
}

function manualValuesView(v: unknown): ManualQuotaValues {
  const out: ManualQuotaValues = {}
  if (!isPlainObject(v)) return out
  for (const k of ['rpm', 'tpm', 'rpd'] as const) {
    const n = v[k]
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[k] = n
  }
  return out
}

/** One stored group, typed. Its position is kept so the writer can keep a record it did not change. */
function quotaGroupView(g: unknown): QuotaGroupSettings {
  if (!isPlainObject(g)) return { id: '', label: '', manualByModel: {} }
  const manualByModel: Record<string, ManualQuotaValues> = {}
  if (isPlainObject(g.manualByModel)) {
    for (const [model, values] of Object.entries(g.manualByModel)) manualByModel[model] = manualValuesView(values)
  }
  return { id: typeof g.id === 'string' ? g.id : '', label: typeof g.label === 'string' ? g.label : '', manualByModel }
}

function learnedView(r: unknown): LearnedQuotaEvidence {
  const row: LearnedQuotaEvidence = { groupId: '', model: '', observedAt: '', source: 'api-429', fingerprint: '', detailKeys: [] }
  if (!isPlainObject(r)) return row
  if (typeof r.groupId === 'string') row.groupId = r.groupId
  if (typeof r.model === 'string') row.model = r.model
  if (typeof r.observedAt === 'string') row.observedAt = r.observedAt
  if (typeof r.fingerprint === 'string') row.fingerprint = r.fingerprint
  if (Array.isArray(r.detailKeys)) row.detailKeys = r.detailKeys.filter((k): k is string => typeof k === 'string')
  if (r.metric === 'rpm' || r.metric === 'tpm' || r.metric === 'rpd' || r.metric === 'other') row.metric = r.metric
  if (typeof r.limit === 'number' && Number.isFinite(r.limit)) row.limit = r.limit
  if (typeof r.resetAt === 'string') row.resetAt = r.resetAt
  return row
}

function cachedEntryEqual(raw: unknown, n: ModelInfo): boolean {
  if (!isPlainObject(raw)) return false
  if (raw.id !== n.id || raw.label !== n.label || raw.source !== n.source) return false
  if (!Array.isArray(raw.availableOn) || raw.availableOn.length !== n.availableOn.length) return false
  return raw.availableOn.every((slot, i) => slot === n.availableOn[i])
}

/** Convenience for callers that already hold a typed settings object. */
export function migrateAppSettings(raw: AppSettings, ctx: MigrationContext): MigrationResult {
  return migrateSettings(raw as unknown as Record<string, unknown>, ctx)
}
