/**
 * Quota Groups: which configured keys share one client-local Free-tier budget.
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * A group is declared by the user, never inferred from key text (D8-4): two keys in one Google project
 * share that project's limits, and the app cannot see projects. Group A's id is the literal `group-a`
 * and is permanent; any other id is `quota-group:<uuid>` from an injected factory, and a label is
 * display text that never becomes an id. Every function here is pure and receives no key text.
 *
 * Non-destructive by construction: a malformed, orphaned or duplicated stored record gets a safe
 * runtime reading (its slot budgets as Group A, which is the conservative direction) and a typed repair
 * reason. Nothing here rewrites what is on disk except the mutation the user asked for, and an
 * unchanged element keeps its object identity so the writer can keep the stored original.
 */
import type { AppSettings, LearnedQuotaEvidence, ManualQuotaValues, QuotaGroupSettings } from './types'

export const DEFAULT_QUOTA_GROUP_ID = 'group-a'
export const DEFAULT_QUOTA_GROUP_LABEL = 'Group A'
const GENERATED_ID = /^quota-group:[0-9a-z][0-9a-z-]{7,}$/i

export type QuotaGroupMutation =
  | { type: 'create'; label: string }
  | { type: 'rename'; groupId: string; label: string }
  | { type: 'assignKey'; keySlot: number; groupId: string }
  | { type: 'setManualLimits'; groupId: string; model: string; values: ManualQuotaValues }
  | { type: 'clearLearned'; groupId: string; model: string }
  | { type: 'delete'; groupId: string }

export interface QuotaGroupRuntimeView {
  groups: Array<QuotaGroupSettings & { displayLabel: string; repairRequired: boolean }>
  resolvedKeyGroupIds: string[]
  repairReasons: Array<{
    kind: 'missing' | 'orphan' | 'malformed' | 'duplicateId' | 'duplicateLabel'
    keySlot?: number
    groupId?: string
  }>
}

type MutationFailureCode = 'invalidLabel' | 'invalidGroup' | 'defaultGroup' | 'assigned' | 'activeRun' | 'invalidModel' | 'invalidLimits'

export type QuotaGroupMutationResult =
  | { ok: true; settings: AppSettings; view: QuotaGroupRuntimeView; createdGroupId?: string }
  | { ok: false; code: MutationFailureCode; message: string; settings: AppSettings; view: QuotaGroupRuntimeView }

/** The fields this module reads; the full Settings object is accepted wherever this is. */
export type QuotaGroupFields = Pick<AppSettings, 'apiKeys' | 'apiKeyQuotaGroups' | 'quotaGroups'>

export function createDefaultQuotaGroup(): QuotaGroupSettings {
  return { id: DEFAULT_QUOTA_GROUP_ID, label: DEFAULT_QUOTA_GROUP_LABEL, manualByModel: {} }
}

/** A stored id this build can budget against: `group-a` or a generated `quota-group:` id. */
export function isQuotaGroupId(id: unknown): id is string {
  return id === DEFAULT_QUOTA_GROUP_ID || (typeof id === 'string' && GENERATED_ID.test(id))
}

/** How many key slots Settings shows: the stored keys, and never fewer than one. */
function slotCount(settings: QuotaGroupFields): number {
  return Math.max(1, Array.isArray(settings.apiKeys) ? settings.apiKeys.length : 0)
}

function labelKey(label: string): string {
  return label.trim().toLocaleLowerCase()
}

/** Ids that more than one stored group carries. Such a group is ambiguous: no record of it is trusted. */
export function ambiguousQuotaGroupIds(settings: Pick<AppSettings, 'quotaGroups'>): Set<string> {
  const stored = Array.isArray(settings.quotaGroups) ? settings.quotaGroups : []
  const once = new Set<string>()
  const twice = new Set<string>()
  for (const g of stored) {
    const id = g?.id
    if (typeof id !== 'string') continue
    if (once.has(id)) twice.add(id)
    once.add(id)
  }
  return twice
}

export function quotaGroupRuntimeView(settings: QuotaGroupFields): QuotaGroupRuntimeView {
  const reasons: QuotaGroupRuntimeView['repairReasons'] = []
  const stored = Array.isArray(settings.quotaGroups) ? settings.quotaGroups : []
  const ambiguous = ambiguousQuotaGroupIds(settings)
  const seen = new Set<string>()
  const usable: QuotaGroupSettings[] = []
  for (const g of stored) {
    const id = g?.id
    if (!isQuotaGroupId(id)) {
      reasons.push({ kind: 'malformed', ...(typeof id === 'string' && id ? { groupId: id } : {}) })
      continue
    }
    if (seen.has(id)) {
      reasons.push({ kind: 'duplicateId', groupId: id })
      continue
    }
    seen.add(id)
    usable.push(g)
  }
  if (!seen.has(DEFAULT_QUOTA_GROUP_ID)) {
    reasons.push({ kind: 'missing', groupId: DEFAULT_QUOTA_GROUP_ID })
    usable.unshift(createDefaultQuotaGroup())
  } else {
    // Group A always reads first, wherever it was stored.
    const a = usable.findIndex((g) => g.id === DEFAULT_QUOTA_GROUP_ID)
    if (a > 0) usable.unshift(...usable.splice(a, 1))
  }

  const labelCount = new Map<string, number>()
  for (const g of usable) {
    const k = labelKey(typeof g.label === 'string' ? g.label : '')
    labelCount.set(k, (labelCount.get(k) ?? 0) + 1)
  }
  const groups = usable.map((g) => {
    const raw = typeof g.label === 'string' ? g.label.trim() : ''
    const clash = raw === '' || (labelCount.get(labelKey(raw)) ?? 0) > 1
    const labelRepair = clash && !(g.id === DEFAULT_QUOTA_GROUP_ID && raw === '')
    const repairRequired = labelRepair || ambiguous.has(g.id)
    if (labelRepair) reasons.push({ kind: 'duplicateLabel', groupId: g.id })
    const fallback = g.id === DEFAULT_QUOTA_GROUP_ID ? DEFAULT_QUOTA_GROUP_LABEL : 'Unnamed group'
    const displayLabel = !clash ? raw : g.id === DEFAULT_QUOTA_GROUP_ID && raw === '' ? fallback : `${raw || fallback} (${shortId(g.id)})`
    return { ...g, displayLabel, repairRequired }
  })

  const known = new Set(groups.map((g) => g.id))
  const slots = Array.isArray(settings.apiKeyQuotaGroups) ? settings.apiKeyQuotaGroups : []
  const resolvedKeyGroupIds: string[] = []
  for (let i = 0; i < slotCount(settings); i++) {
    const id = slots[i]
    if (id === undefined) {
      reasons.push({ kind: 'missing', keySlot: i })
      resolvedKeyGroupIds.push(DEFAULT_QUOTA_GROUP_ID)
    } else if (typeof id !== 'string' || !known.has(id)) {
      reasons.push({ kind: 'orphan', keySlot: i, ...(typeof id === 'string' && id ? { groupId: id } : {}) })
      resolvedKeyGroupIds.push(DEFAULT_QUOTA_GROUP_ID)
    } else if (ambiguous.has(id) && id !== DEFAULT_QUOTA_GROUP_ID) {
      reasons.push({ kind: 'duplicateId', keySlot: i, groupId: id })
      resolvedKeyGroupIds.push(DEFAULT_QUOTA_GROUP_ID)
    } else {
      resolvedKeyGroupIds.push(id)
    }
  }
  return { groups, resolvedKeyGroupIds, repairReasons: reasons }
}

function shortId(id: string): string {
  return id === DEFAULT_QUOTA_GROUP_ID ? 'A' : id.replace(/^quota-group:/, '').slice(0, 6)
}

/** The group slot array after key slot `removedSlot` is removed: it follows the keys, and keeps one slot. */
export function reindexQuotaGroupSlots(groupIds: string[], removedSlot: number): string[] {
  const next = groupIds.filter((_, i) => i !== removedSlot)
  return next.length ? next : [DEFAULT_QUOTA_GROUP_ID]
}

/**
 * The group slot array for a new key list, from the previous one. A key added at the end joins Group
 * A; a removed key takes its slot with it (found as the first position where the lists differ); an
 * edit in place keeps the array exactly. Ambiguity between identical keys resolves to the later slot.
 */
export function followKeySlots(previousKeys: readonly string[], nextKeys: readonly string[], groupIds: readonly string[]): string[] {
  const before = Math.max(1, previousKeys.length)
  const after = Math.max(1, nextKeys.length)
  const padded = [...groupIds]
  while (padded.length < before) padded.push(DEFAULT_QUOTA_GROUP_ID)
  if (after > before) {
    while (padded.length < after) padded.push(DEFAULT_QUOTA_GROUP_ID)
    return padded
  }
  if (after < before) {
    let removed = nextKeys.findIndex((k, i) => k !== previousKeys[i])
    if (removed < 0) removed = before - 1
    let out = padded
    for (let n = before - after; n > 0; n--) out = reindexQuotaGroupSlots(out, removed)
    return out
  }
  return padded
}

function positiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/** A reserve this build can apply: finite and `0 ≤ p < 100`. Anything else makes manual capacity unavailable. */
export function validReservePercent(p: unknown): p is number {
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p < 100
}

/** `floor(limit × (100 − p) / 100)`, or null when the reserve is unusable or the result is below one. */
export function usableManualCapacity(limit: number, reservePercent: unknown): number | null {
  if (!positiveInteger(limit) || !validReservePercent(reservePercent)) return null
  const usable = Math.floor((limit * (100 - reservePercent)) / 100)
  return usable >= 1 ? usable : null
}

/** A learned row that states a proactive ceiling: one of the three metrics with a positive integer limit. */
export function isUsableCeiling(row: LearnedQuotaEvidence): boolean {
  return (row.metric === 'rpm' || row.metric === 'tpm' || row.metric === 'rpd') && positiveInteger(row.limit)
}

function validTime(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * Add one learned observation and keep, per group/model/metric category, only the newest usable
 * ceiling row and the newest observation row (one row may be both). Newest is by valid `observedAt`;
 * at equal time the later receipt (array position) wins. Rows from separate responses are never merged.
 */
export function recordLearnedEvidence(rows: readonly LearnedQuotaEvidence[], row: LearnedQuotaEvidence): LearnedQuotaEvidence[] {
  const all = [...rows, row]
  const category = (r: LearnedQuotaEvidence) => `${r.groupId}\u0000${r.model}\u0000${r.metric ?? 'other'}`
  const target = category(row)
  const newer = (a: number, b: number) => {
    const ta = validTime(all[a].observedAt) ?? Number.NEGATIVE_INFINITY
    const tb = validTime(all[b].observedAt) ?? Number.NEGATIVE_INFINITY
    return ta !== tb ? ta > tb : a > b
  }
  let newestAny = -1
  let newestCeiling = -1
  all.forEach((r, i) => {
    if (category(r) !== target) return
    if (newestAny < 0 || newer(i, newestAny)) newestAny = i
    if (isUsableCeiling(r) && (newestCeiling < 0 || newer(i, newestCeiling))) newestCeiling = i
  })
  return all.filter((r, i) => category(r) !== target || i === newestAny || i === newestCeiling)
}

const MESSAGES: Record<MutationFailureCode, string> = {
  invalidLabel: 'Give the group a name that no other group uses.',
  invalidGroup: 'That Quota Group no longer exists. Reopen Settings and try again.',
  defaultGroup: 'Group A always exists and cannot be deleted.',
  assigned: 'Move every key out of this group before deleting it.',
  activeRun: 'A run that is in progress may use this group. Delete it after the run ends.',
  invalidModel: 'Limits can only be saved for a model id.',
  invalidLimits: 'Each limit must be a whole number above zero, and must stay at least 1 after the safety reserve.'
}

export function applyQuotaGroupMutation(
  settings: AppSettings,
  mutation: QuotaGroupMutation,
  activeGroupIds: ReadonlySet<string>,
  uuid: () => string
): QuotaGroupMutationResult {
  const view = quotaGroupRuntimeView(settings)
  const fail = (code: MutationFailureCode): QuotaGroupMutationResult => ({ ok: false, code, message: MESSAGES[code], settings, view })
  const done = (next: AppSettings, createdGroupId?: string): QuotaGroupMutationResult => ({
    ok: true,
    settings: next,
    view: quotaGroupRuntimeView(next),
    ...(createdGroupId ? { createdGroupId } : {})
  })
  const stored = Array.isArray(settings.quotaGroups) ? settings.quotaGroups : []
  const usableIds = new Set(view.groups.map((g) => g.id))
  // An id two stored groups carry names no one group, so no key may join it and no record of it may be
  // renamed or limited. Deleting it removes every record with it. Group A stays assignable: a slot on
  // an ambiguous id already budgets as Group A.
  const ambiguous = ambiguousQuotaGroupIds(settings)
  const editsOne = mutation.type === 'rename' || mutation.type === 'setManualLimits' || (mutation.type === 'assignKey' && mutation.groupId !== DEFAULT_QUOTA_GROUP_ID)
  if (editsOne) for (const id of ambiguous) usableIds.delete(id)
  /** Stored position of a usable group; -1 for a Group A that exists only in the view. */
  const at = (id: string) => stored.findIndex((g) => g?.id === id)
  const labelFree = (label: string, except?: string) =>
    view.groups.every((g) => g.id === except || labelKey(g.displayLabel) !== labelKey(label))
  /** Group A materialised on disk when an edit needs it to exist there. */
  const withA = (): QuotaGroupSettings[] => (at(DEFAULT_QUOTA_GROUP_ID) >= 0 ? [...stored] : [createDefaultQuotaGroup(), ...stored])

  switch (mutation.type) {
    case 'create': {
      const label = typeof mutation.label === 'string' ? mutation.label.trim() : ''
      if (!label || !labelFree(label)) return fail('invalidLabel')
      const id = `quota-group:${uuid()}`
      if (!isQuotaGroupId(id) || usableIds.has(id)) return fail('invalidGroup')
      return done({ ...settings, quotaGroups: [...withA(), { id, label, manualByModel: {} }] }, id)
    }
    case 'rename': {
      if (!usableIds.has(mutation.groupId)) return fail('invalidGroup')
      const label = typeof mutation.label === 'string' ? mutation.label.trim() : ''
      if (!label || !labelFree(label, mutation.groupId)) return fail('invalidLabel')
      const list = withA()
      const i = list.findIndex((g) => g?.id === mutation.groupId)
      list[i] = { ...list[i], label }
      return done({ ...settings, quotaGroups: list })
    }
    case 'assignKey': {
      const n = slotCount(settings)
      if (!Number.isInteger(mutation.keySlot) || mutation.keySlot < 0 || mutation.keySlot >= n) return fail('invalidGroup')
      if (!usableIds.has(mutation.groupId)) return fail('invalidGroup')
      const slots = [...(Array.isArray(settings.apiKeyQuotaGroups) ? settings.apiKeyQuotaGroups : [])]
      while (slots.length < n) slots.push(DEFAULT_QUOTA_GROUP_ID)
      slots[mutation.keySlot] = mutation.groupId
      const quotaGroups = at(DEFAULT_QUOTA_GROUP_ID) >= 0 || mutation.groupId !== DEFAULT_QUOTA_GROUP_ID ? stored : withA()
      return done({ ...settings, apiKeyQuotaGroups: slots, quotaGroups })
    }
    case 'setManualLimits': {
      if (!usableIds.has(mutation.groupId)) return fail('invalidGroup')
      const model = typeof mutation.model === 'string' ? mutation.model.trim() : ''
      if (!model) return fail('invalidModel')
      const values: ManualQuotaValues = {}
      for (const metric of ['rpm', 'tpm', 'rpd'] as const) {
        const v = mutation.values?.[metric]
        if (v === undefined) continue
        if (!positiveInteger(v)) return fail('invalidLimits')
        // A combination the reserve would make unusable is refused, never clamped (§12.4).
        if (validReservePercent(settings.manualQuotaReservePercent) && usableManualCapacity(v, settings.manualQuotaReservePercent) === null) {
          return fail('invalidLimits')
        }
        values[metric] = v
      }
      const list = withA()
      const i = list.findIndex((g) => g?.id === mutation.groupId)
      const manualByModel = { ...(list[i].manualByModel ?? {}) }
      if (Object.keys(values).length) manualByModel[model] = values
      else delete manualByModel[model]
      list[i] = { ...list[i], manualByModel }
      return done({ ...settings, quotaGroups: list })
    }
    case 'clearLearned': {
      if (!usableIds.has(mutation.groupId)) return fail('invalidGroup')
      const rows = Array.isArray(settings.learnedQuotaEvidence) ? settings.learnedQuotaEvidence : []
      return done({ ...settings, learnedQuotaEvidence: rows.filter((r) => !(r.groupId === mutation.groupId && r.model === mutation.model)) })
    }
    case 'delete': {
      if (mutation.groupId === DEFAULT_QUOTA_GROUP_ID) return fail('defaultGroup')
      if (!usableIds.has(mutation.groupId)) return fail('invalidGroup')
      const slots = Array.isArray(settings.apiKeyQuotaGroups) ? settings.apiKeyQuotaGroups : []
      if (slots.includes(mutation.groupId) || view.resolvedKeyGroupIds.includes(mutation.groupId)) return fail('assigned')
      if (activeGroupIds.has(mutation.groupId)) return fail('activeRun')
      const rows = Array.isArray(settings.learnedQuotaEvidence) ? settings.learnedQuotaEvidence : []
      return done({
        ...settings,
        quotaGroups: stored.filter((g) => g?.id !== mutation.groupId),
        learnedQuotaEvidence: rows.filter((r) => r.groupId !== mutation.groupId)
      })
    }
  }
}
