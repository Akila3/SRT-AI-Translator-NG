import { listGeminiModels, type GeminiProviderOptions } from '../engine/providers/gemini'
import type { BatchFailure, ListedModel, ModelListContext, ModelListResult, ModelTokenLimits } from '../engine/providers/types'
import { keySlotsFor } from './keyPreflight'
import { DEFAULT_MODELS, getSettings } from './store'
import { activeKeySlots } from '../shared/keyOrder'
import type {
  CheckKeysResult,
  KeyCheck,
  ModelInfo,
  RefreshOutcome,
  SlotFetchResult
} from '../shared/types'

type Family = 'flash-lite' | 'flash' | 'pro' | 'other'

/**
 * Ids we invented and injected unconditionally in an earlier build. Google does not
 * publish them, so the engine's membership check rejects them outright (main.py:645),
 * and even a real one would defeat its thinking-config substring match
 * (main.py:207-243). They are filtered out of every path: the fetch, the cache and the
 * seed.
 */
const ALIAS_RE = /-latest$/

/** Version as an ordered tuple. NEVER parse this with parseFloat — `3.10` must beat `3.9`. */
export interface ModelVersion {
  major: number
  minor: number
}

interface Parsed {
  id: string
  versioned: boolean
  family: Family
  version: ModelVersion | null
  variant: string
  preview: boolean
}

const FAMILY_RANK: Record<Family, number> = { flash: 0, 'flash-lite': 1, pro: 2, other: 3 }

/** Anything below Gemini 2.x is long deprecated and only clutters the picker. */
const MIN_DISPLAYED_MAJOR = 2

function familyOf(variant: string): Family {
  if (variant.startsWith('flash-lite')) return 'flash-lite'
  if (variant.startsWith('flash')) return 'flash'
  if (variant.startsWith('pro')) return 'pro'
  return 'other'
}

function isPreviewVariant(variant: string): boolean {
  return /preview|exp/.test(variant)
}

function parse(id: string): Parsed {
  const v = id.match(/^gemini-(\d+)(?:\.(\d+))?-(.+)$/)
  if (v) {
    const variant = v[3]
    return {
      id,
      versioned: true,
      family: familyOf(variant),
      version: { major: parseInt(v[1], 10), minor: v[2] ? parseInt(v[2], 10) : 0 },
      variant,
      preview: isPreviewVariant(variant)
    }
  }
  return { id, versioned: false, family: 'other', version: null, variant: '', preview: /preview|exp/.test(id) }
}

/**
 * Ordered version comparison. Returns >0 when `a` is newer.
 *
 * The previous implementation used `parseFloat`, which makes `parseFloat('3.10') === 3.1`
 * and therefore ranks `gemini-3.10-flash-lite` BELOW `gemini-3.9-flash-lite` — silently
 * picking the older model as "newest lite".
 */
export function compareVersions(a: ModelVersion | null, b: ModelVersion | null): number {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.major !== b.major) return a.major - b.major
  return a.minor - b.minor
}

export function formatVersion(v: ModelVersion | null): string {
  if (!v) return ''
  return v.minor ? `${v.major}.${v.minor}` : `${v.major}`
}

/** Newest first, fully deterministic so the dropdown order never flickers. */
function compareForDisplay(a: Parsed, b: Parsed): number {
  if (a.versioned !== b.versioned) return a.versioned ? -1 : 1
  const byVersion = compareVersions(b.version, a.version)
  if (byVersion !== 0) return byVersion
  if (FAMILY_RANK[a.family] !== FAMILY_RANK[b.family]) return FAMILY_RANK[a.family] - FAMILY_RANK[b.family]
  if (a.preview !== b.preview) return a.preview ? 1 : -1
  if (a.variant.length !== b.variant.length) return a.variant.length - b.variant.length
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function titleCase(s: string): string {
  return s
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Build a friendly label from a raw model id, e.g. gemini-3.1-flash-lite -> Gemini Flash Lite 3.1 */
export function friendlyLabel(id: string): string {
  const known = DEFAULT_MODELS.find((m) => m.id === id)
  if (known) return known.label
  const p = parse(id)
  if (p.versioned) return `Gemini ${titleCase(p.variant)} ${formatVersion(p.version)}`
  return id
}

/** Model id -> the API-key slot indices whose fetch returned it. */
export type ModelAvailability = Record<string, number[]>

/**
 * Turn raw model ids into the curated, friendly, ordered dropdown list.
 *
 * Pure and idempotent, because it runs on BOTH the cache read (`models:getCached`) and
 * the cache write — a non-idempotent change here corrupts the stored list on the next
 * launch.
 *
 * @param rawIds       ids to offer: the union of everything the queried keys returned,
 *                     or the ids already in the cache.
 * @param availability per-id evidence of which key slots returned it. Supplying a
 *                     non-empty map means a fetch has succeeded, which is what switches
 *                     the seed off — the seed is a display fallback for profiles that
 *                     have never fetched, never a claim that a model is runnable.
 */
export function buildModelList(rawIds: string[], availability: ModelAvailability = {}, carry: readonly ModelInfo[] = []): ModelInfo[] {
  const hasLiveEvidence = Object.keys(availability).length > 0

  const ids = new Set<string>()
  for (const raw of rawIds) {
    const id = (raw || '').trim().toLowerCase()
    if (!id || ALIAS_RE.test(id)) continue
    ids.add(id)
  }
  if (!hasLiveEvidence) for (const m of DEFAULT_MODELS) ids.add(m.id)

  const kept = Array.from(ids)
    .map(parse)
    // Unparseable ids stay in the list (grouped last) but are excluded from the default
    // computation in resolveDefaultModel, so they can never win by accident.
    .filter((p) => !p.versioned || (p.version?.major ?? 0) >= MIN_DISPLAYED_MAJOR)
    .sort(compareForDisplay)

  return kept.map((p) => {
    const slots = availability[p.id]
    const live = Array.isArray(slots) && slots.length > 0
    const base = friendlyLabel(p.id)
    const entry: ModelInfo = {
      id: p.id,
      // Previews are always offered (never auto-selected) and must be visibly marked so
      // the choice is informed.
      label: p.preview && !/preview/i.test(base) ? `${base} (Preview)` : base,
      source: live ? 'live' : 'seed',
      availableOn: live ? [...slots].sort((a, b) => a - b) : []
    }
    // The official limits ride along with a live entry being re-curated; a seed entry carries none.
    return live ? withLimitsOf(entry, carry.find((c) => c?.source === 'live' && c.id === p.id)) : entry
  })
}

const LIMIT_FIELDS = ['inputTokenLimit', 'outputTokenLimit'] as const

function isPositiveWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function withLimitsOf(entry: ModelInfo, from: ModelInfo | undefined): ModelInfo {
  if (!from) return entry
  const out: ModelInfo = { ...entry }
  for (const f of LIMIT_FIELDS) if (isPositiveWhole(from[f])) out[f] = from[f]
  if ((out.inputTokenLimit !== undefined || out.outputTokenLimit !== undefined) && typeof from.limitsFetchedAt === 'string') {
    out.limitsFetchedAt = from.limitsFetchedAt
  }
  return out
}

/** One key's official per-model maxima, by accepted id. Positive whole numbers only. */
export type SlotModelLimits = Record<string, ModelTokenLimits>

/** The limits a key's complete list reported for the ids this app accepted from it. */
export function listedLimits(models: readonly ListedModel[], accepted: readonly string[]): SlotModelLimits {
  const keep = new Set(accepted)
  const out: SlotModelLimits = {}
  for (const m of models) {
    const id = (m.id || '').trim().toLowerCase()
    if (!keep.has(id)) continue
    const limits: ModelTokenLimits = {}
    for (const f of LIMIT_FIELDS) if (isPositiveWhole(m[f])) limits[f] = m[f]
    if (limits.inputTokenLimit !== undefined || limits.outputTokenLimit !== undefined) out[id] = limits
  }
  return out
}

export interface LimitMerge {
  models: ModelInfo[]
  /** Ids whose keys reported different valid values for a field. Their known value was kept. */
  conflicts: string[]
}

/**
 * Attach the official limits the answering keys reported, field by field (§12.6). Keys that agree
 * refresh the field and `limitsFetchedAt`; keys that disagree leave the value already known (or none)
 * and the id is reported — key order or the larger value never picks a winner. A field no key
 * reported keeps what was known. A seed entry carries none.
 */
export function withModelLimits(models: readonly ModelInfo[], observed: readonly SlotModelLimits[], prior: readonly ModelInfo[], fetchedAt: string): LimitMerge {
  const conflicts: string[] = []
  const merged = models.map((m) => {
    if (m.source !== 'live') return m
    const known = withLimitsOf({ ...m }, prior.find((p) => p?.source === 'live' && p.id === m.id))
    const out: ModelInfo = { id: m.id, label: m.label, source: m.source, availableOn: m.availableOn }
    let refreshed = false
    let conflicted = false
    for (const f of LIMIT_FIELDS) {
      const values = new Set(observed.map((o) => o[m.id]?.[f]).filter(isPositiveWhole))
      if (values.size === 1) {
        out[f] = [...values][0]
        refreshed = true
      } else {
        if (values.size > 1) conflicted = true
        if (known[f] !== undefined) out[f] = known[f]
      }
    }
    if (conflicted) conflicts.push(m.id)
    if (out.inputTokenLimit !== undefined || out.outputTokenLimit !== undefined) {
      if (refreshed) out.limitsFetchedAt = fetchedAt
      else if (known.limitsFetchedAt !== undefined) out.limitsFetchedAt = known.limitsFetchedAt
    }
    return out
  })
  return { models: merged, conflicts }
}

/**
 * The newest `flash-lite`, per the user's rule: "we go by newest flash-lite model, not
 * by cheapest". Falls back to the newest `flash`, then to the newest model of any
 * family.
 *
 * The caller MUST pass the runnable set (Step 3b) — never the seed and never the union.
 * Previews and unparseable ids are excluded from the computation entirely.
 * Returns null when nothing qualifies, which callers must treat as "leave the user's
 * selection alone".
 */
export function resolveDefaultModel(models: ModelInfo[]): string | null {
  return resolveDefaultModelWithBasis(models).id
}

/** How a default was arrived at. See `resolveDefaultModelWithBasis`. */
export type DefaultBasis = 'flash-lite' | 'flash' | 'fallback' | 'none'

/**
 * The same computation, plus WHY that model won.
 *
 * The auto-advance rule identifies "the user never overrode the default" by comparing the
 * stored id against the previous list's default. That test is only meaningful when the
 * previous default was a genuine flash-lite/flash pick. When neither family was present,
 * `resolveDefaultModel` falls back to "the newest of anything", which would make a
 * deliberately chosen `pro` look like an un-overridden default and let auto-advance move
 * the user off it — a silent override loss. Callers making that comparison must require a
 * basis of `flash-lite` or `flash`.
 */
export function resolveDefaultModelWithBasis(models: ModelInfo[]): {
  id: string | null
  basis: DefaultBasis
} {
  const eligible = models
    .map((m) => parse(m.id))
    .filter((p) => p.versioned && !p.preview)
    .sort(compareForDisplay)
  if (eligible.length === 0) return { id: null, basis: 'none' }

  const newestOf = (family: Family): string | null => eligible.find((p) => p.family === family)?.id ?? null
  const lite = newestOf('flash-lite')
  if (lite) return { id: lite, basis: 'flash-lite' }
  const flash = newestOf('flash')
  if (flash) return { id: flash, basis: 'flash' }
  return { id: eligible[0].id, basis: 'fallback' }
}

/**
 * What a failed fetch proves about the KEY, which is not the same as what it says.
 *
 * MAN-4: with the network down, three keys were branded invalid, and the panel then said both
 * "3 keys invalid" and "could not be checked" about the same keys. The cause is that the verdict
 * was binary — every failure, including a DNS error, was persisted as `false`, the identical
 * value a rejected key gets — so a network outage accused the user's credentials.
 *
 * The rule is the one used everywhere else in this app: brand something only on positive
 * evidence. `rejected` requires the API to have actually refused the credential. Everything
 * else, INCLUDING an error we do not recognise, is `unchecked` — we learned nothing.
 *
 * Quota is deliberately `unchecked` rather than `rejected`: a 429 means the key is real and
 * working and merely busy, and calling that invalid would demote a perfectly good key in the
 * spawn ranking (`orderKeySlots` skips known-invalid keys).
 */
export type KeyVerdict = 'valid' | 'rejected' | 'unchecked'

const FETCH_MESSAGES = {
  timeout: () =>
    `The model fetch gave up after ${Math.round(FETCH_TIMEOUT_MS / 1000)} seconds. ` +
    'The network may be unreachable, or Google may be slow to answer. ' +
    'This does not mean the key is invalid.',
  invalid: 'Invalid API key. Double-check the key from Google AI Studio and try again.',
  permission: 'This API key is not authorized for the Gemini API. Enable it in Google AI Studio.',
  quota:
    'Quota exceeded for this key, so it could not be checked. The key itself is fine — wait a ' +
    'bit and retry, or use a paid key.',
  network: 'Could not reach Google. Check your internet connection and try again.',
  unknown:
    'Could not retrieve models — the reason was not recognised, so this says nothing about the ' +
    'key itself. Check your internet connection and try again.'
} as const

export function classifyFetchFailure(
  out: string,
  timedOut: boolean
): { verdict: Exclude<KeyVerdict, 'valid'>; error: string } {
  if (timedOut) {
    return {
      verdict: 'unchecked',
      error: FETCH_MESSAGES.timeout()
    }
  }
  const clean = out.replace(/\u001b\[[0-9;]*m/g, ' ')
  if (/API_KEY_INVALID|api key not valid|invalid authentication|unauthenticated|\b401\b/i.test(clean)) {
    return {
      verdict: 'rejected',
      error: FETCH_MESSAGES.invalid
    }
  }
  if (/permission_denied|\b403\b/i.test(clean)) {
    return {
      verdict: 'rejected',
      error: FETCH_MESSAGES.permission
    }
  }
  if (/resource_exhausted|quota|\b429\b/i.test(clean)) {
    return {
      verdict: 'unchecked',
      error: FETCH_MESSAGES.quota
    }
  }
  if (/getaddrinfo|enotfound|etimedout|econnrefused|network|failed to fetch|connection/i.test(clean)) {
    return {
      verdict: 'unchecked',
      error: FETCH_MESSAGES.network
    }
  }
  return {
    verdict: 'unchecked',
    error: FETCH_MESSAGES.unknown
  }
}

/**
 * The same rule for the SDK's typed answer (Step 4.1): only an explicit credential refusal is
 * `rejected`. A location the API does not serve is not a statement about the key.
 */
export function classifyListFailure(failure: BatchFailure): { verdict: Exclude<KeyVerdict, 'valid'>; error: string } {
  switch (failure.kind) {
    case 'auth':
      if (failure.reason === 'invalid') return { verdict: 'rejected', error: FETCH_MESSAGES.invalid }
      if (failure.reason === 'permission') return { verdict: 'rejected', error: FETCH_MESSAGES.permission }
      return {
        verdict: 'unchecked',
        error: 'Google does not offer the Gemini API in this location, so the key could not be checked. This says nothing about the key itself.'
      }
    case 'timeout':
      return { verdict: 'unchecked', error: FETCH_MESSAGES.timeout() }
    case 'quota':
    case 'rate-limit':
      return { verdict: 'unchecked', error: FETCH_MESSAGES.quota }
    case 'network':
      return { verdict: 'unchecked', error: FETCH_MESSAGES.network }
    case 'cancelled':
      return { verdict: 'unchecked', error: 'Cancelled.' }
    default:
      return { verdict: 'unchecked', error: FETCH_MESSAGES.unknown }
  }
}

export interface RefreshResult {
  /** Raw ids this key reported, alias-filtered. Empty when the fetch failed. */
  ids: string[]
  verdict: KeyVerdict
  /** True only for `valid`. Kept so callers that only care whether a list arrived read the same. */
  keyValid: boolean
  error: string
  /** The official limits this key's list reported (`listedLimits`). Present only when it reported any. */
  limits?: SlotModelLimits
}

/**
 * How long one key's fetch may run before it is abandoned, every page included.
 *
 * Sized for the CLI, whose frozen binary needed about six seconds to start before a byte reached the
 * network; kept, because a premature timeout would report a working key as unreachable, which is
 * worse than waiting. ListModels normally answers in under three seconds.
 *
 * The honest worst case: `checkApiKeys` awaits each key in turn, so this budget multiplies by the
 * number of configured keys — three keys, three minutes, and only if every key hangs.
 */
const FETCH_TIMEOUT_MS = 60_000

/** Ids that are not models of a family this app translates or transcribes with. */
const NON_TEXT_FAMILY = /srt-translator|embedding|aqa|tts|image|vision|robotics|computer-use/

export interface RefreshOptions {
  /** Gates only: the list call and its deadline. Production lists through `providers/gemini.ts`. */
  list?: (ctx: ModelListContext) => Promise<ModelListResult>
  timeoutMs?: number
  provider?: GeminiProviderOptions
}

/**
 * The product's id policy over a complete list: lower-case Gemini ids, no `-latest` alias (it would
 * bypass the thinking-config match) and no family this app does not use.
 */
export function acceptedModelIds(ids: readonly string[]): { ids: string[]; aliasesSeen: number } {
  const out = new Set<string>()
  let aliasesSeen = 0
  for (const raw of ids) {
    const id = (raw || '').trim().toLowerCase()
    if (!/^gemini-[a-z0-9.\-]+$/.test(id) || NON_TEXT_FAMILY.test(id)) continue
    if (ALIAS_RE.test(id)) {
      aliasesSeen++
      continue
    }
    out.add(id)
  }
  return { ids: Array.from(out), aliasesSeen }
}

/**
 * Ask one API key what models it can see.
 *
 * Returns raw ids rather than a curated list on purpose: availability decisions
 * (union / intersection / "provably absent") must be made on what the API actually said,
 * never on what our display curation chose to keep. Curating first would let a cosmetic
 * filter masquerade as proof that a model no longer exists.
 *
 * No process is started. The call is bounded by `FETCH_TIMEOUT_MS` and by `signal`; once either
 * fires this settles, and an answer that arrives later changes nothing.
 */
export async function refreshModels(apiKey: string, signal?: AbortSignal, opts: RefreshOptions = {}): Promise<RefreshResult> {
  if (!apiKey || !apiKey.trim()) {
    // Nothing was asked, so nothing was learned — an empty slot is not a rejected one.
    return { ids: [], verdict: 'unchecked', keyValid: false, error: 'No API key provided.' }
  }
  if (signal?.aborted) {
    return { ids: [], verdict: 'unchecked', keyValid: false, error: 'Cancelled.' }
  }
  const ctx: ModelListContext = { apiKey: apiKey.trim(), signal, timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS }
  let result: ModelListResult
  try {
    result = opts.list ? await opts.list(ctx) : await listGeminiModels(ctx, opts.provider)
  } catch {
    result = { ok: false, failure: { ok: false, kind: 'unknown', detailKeys: [] }, pages: 0 }
  }
  // A cancelled fetch learned nothing, whatever it had collected.
  if (signal?.aborted) {
    return { ids: [], verdict: 'unchecked', keyValid: false, error: 'Cancelled.' }
  }
  if (!result.ok) {
    const { verdict, error } = classifyListFailure(result.failure)
    return { ids: [], verdict, keyValid: false, error }
  }
  const { ids, aliasesSeen } = acceptedModelIds(result.models.map((m) => m.id))
  if (aliasesSeen > 0) {
    console.log(`[models] ignored ${aliasesSeen} "-latest" alias id(s) returned by the API`)
  }
  if (ids.length === 0) {
    // The API answered and listed nothing this app can run: evidence of nothing, about the key.
    return {
      ids: [],
      verdict: 'unchecked',
      keyValid: false,
      error: 'Google answered but listed no Gemini model this app can use, so this says nothing about the key itself.'
    }
  }
  const limits = listedLimits(result.models, ids)
  return { ids, verdict: 'valid', keyValid: true, error: '', ...(Object.keys(limits).length ? { limits } : {}) }
}

export interface RefreshSummary {
  unionIds: string[]
  runnableIds: string[]
  models: ModelInfo[]
  availability: ModelAvailability
  refreshOutcome: RefreshOutcome
}

/**
 * Turn per-slot fetch results into the availability picture the model rules depend on.
 *
 * Pure, so the evidence rules can be exercised directly by the gate fixtures.
 *
 * @param activeSlots the ACTIVE SET — `orderKeySlots(...).slice(0, 2)` computed from the
 *        validity that was in force BEFORE this refresh. It must be the pre-refresh
 *        ranking: ranking on the fresh results would drop every slot that just failed,
 *        making `activeComplete` vacuously true and defeating the whole point of the bar.
 */
export function summarizeRefresh(slots: SlotFetchResult[], activeSlots: number[]): RefreshSummary {
  const queried = slots.filter((s) => s.queried)
  const answered = queried.filter((s) => s.ok)

  const availability: ModelAvailability = {}
  for (const slot of answered) {
    for (const id of slot.ids) {
      if (!availability[id]) availability[id] = []
      if (!availability[id].includes(slot.slot)) availability[id].push(slot.slot)
    }
  }
  const unionIds = Object.keys(availability)

  // Runnable = present on EVERY active-set slot, because the engine may switch between
  // -k and -k2 mid-run (_switch_api, main.py:1001-1018). With one key that is simply
  // that key's list. If no active slot answered, fall back to whatever did answer, so a
  // fresh install can still be seeded.
  const activeAnswered = answered.filter((s) => activeSlots.includes(s.slot))
  const basis = activeAnswered.length ? activeAnswered : answered
  const runnableIds = basis.length ? unionIds.filter((id) => basis.every((s) => s.ids.includes(id))) : []

  const allComplete = queried.length > 0 && answered.length === queried.length
  const activeComplete =
    activeSlots.length > 0 && activeSlots.every((i) => answered.some((s) => s.slot === i))
  const refreshOutcome: RefreshOutcome = allComplete
    ? 'allComplete'
    : activeComplete
      ? 'activeComplete'
      : answered.length > 0
        ? 'partial'
        : 'failed'

  return {
    unionIds,
    runnableIds,
    // Never degrade to the seed on a failed refresh: the caller keeps the last known
    // list instead. Handing back the seed here is what made a failed fetch look like a
    // successful one ("N models available") in the old UI.
    models: unionIds.length ? buildModelList(unionIds, availability) : [],
    availability,
    refreshOutcome
  }
}

/** What was already known about one slot, before this check ran. */
export interface PriorVerdict {
  valid: boolean | null
  error: string
  /**
   * Whether that verdict still describes the key sitting in this slot. Editing a key clears
   * its verdict in `SettingsPage.updateKey`, so this is a belt-and-braces identity check
   * rather than the only guard — but a retained rejection is exactly the thing that must
   * never outlive the credential it was about.
   */
  sameKey: boolean
}

/**
 * Carry a PROVEN rejection through a check that proved nothing.
 *
 * FP-7 made a failed fetch persist `null` instead of `false`, which is right for the key it
 * learned nothing about — and wrong for a key already refused by the API, because `null` is
 * usable. `orderKeySlots` drops `valid === false` and ranks `null` above it, so an offline
 * check silently returned a dead credential to the pool, and it could be promoted to `-k`
 * on the next run. FP-7's own transcription preflight then makes that worse rather than
 * better: it reads the primary slot, so a resurrected dead key turns a run that used to
 * succeed on the fallback into a run that is refused outright.
 *
 * ONLY a rejection is carried, and the asymmetry is the point:
 *
 *  - `false` is the one verdict with operational weight — it removes a key from the pool —
 *    so erasing it without contrary evidence changes what a run does.
 *  - `true` is deliberately allowed to decay to `unchecked`. The key stays usable either
 *    way, so nothing operational turns on it, and the Settings panel reads the persisted
 *    verdict for both its marks and its summary. Retaining `true` would answer a failed
 *    check with "✓ N of N keys valid" — which is MAN-4's own report with the polarity
 *    flipped, since the keys in that report had been valid before the network went down.
 *
 * This is also only sound because of FP-7: `false` now means the API refused the key and
 * nothing else. Under the old binary verdict it could equally have meant a DNS failure, and
 * carrying THAT forward would have made a network fault permanent.
 */
export function keepProvenRejections(
  results: readonly KeyCheck[],
  slots: readonly SlotFetchResult[],
  prior: readonly PriorVerdict[]
): KeyCheck[] {
  return results.map((res, i) => {
    // This round learned something. Evidence always wins, in both directions.
    if (res.valid !== null) return res
    // An empty slot was never asked, and must never inherit a verdict about a key that is
    // no longer there — the user clearing a bad key is how they expect to clear its ✗.
    if (!slots[i]?.queried) return res
    const was = prior[i]
    if (was?.sameKey && was.valid === false) {
      // The error travels with the verdict. A ✗ carrying "Could not reach Google" would be
      // MAN-4's confusion again: the mark says the API refused this key, so the sentence
      // beside it has to be the refusal, not the network.
      return { valid: false, error: was.error }
    }
    return res
  })
}

/**
 * Validate every provided key individually and record what EACH one returned.
 *
 * The previous implementation kept only the first valid key's list and threw the rest
 * away, while spawn time may promote a different pair — so a model visible only to a
 * reserve key could be selected and then fail partway through a job.
 */
export async function checkApiKeys(keys: string[], opts: RefreshOptions = {}): Promise<CheckKeysResult> {
  // Snapshot the ranking BEFORE the new results land (see summarizeRefresh). Built with
  // the same helper spawn uses, so "active" here means exactly the slots a run would use.
  const activeSlots = activeKeySlots(keySlotsFor(keys))

  const results: KeyCheck[] = []
  const slots: SlotFetchResult[] = []
  const observedLimits: SlotModelLimits[] = []

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (!key || !key.trim()) {
      results.push({ valid: null, error: '' })
      slots.push({ slot: i, queried: false, ok: false, ids: [] })
      continue
    }
    const res = await refreshModels(key, undefined, opts)
    // `null` is the persisted spelling of "unchecked". It already meant "never checked", and
    // "asked, learned nothing" is the same state as far as every consumer is concerned — which
    // is what keeps this fix out of the settings schema and out of a migration.
    results.push({
      valid: res.verdict === 'valid' ? true : res.verdict === 'rejected' ? false : null,
      error: res.error
    })
    slots.push({ slot: i, queried: true, ok: res.keyValid, ids: res.ids })
    if (res.keyValid) observedLimits.push(res.limits ?? {})
  }

  // A check that learned nothing must not undo what was already proven. Applied here rather
  // than at the persistence site so main and the renderer are handed one story, and so the
  // rule sits in a pure function a gate can reach.
  //
  // `slots` is deliberately NOT merged: a retained verdict is a statement about a key, never
  // about the models it can see. Fabricating fetch evidence here would let a slot that
  // answered nothing count towards `activeComplete` and overwrite the model cache.
  const stored = getSettings()
  const merged = keepProvenRejections(
    results,
    slots,
    keys.map((key, i) => ({
      valid: stored.apiKeyValid?.[i] ?? null,
      error: stored.apiKeyError?.[i] ?? '',
      sameKey: (stored.apiKeys?.[i] ?? '') === key
    }))
  )

  const summary = summarizeRefresh(slots, activeSlots)
  const limited = withModelLimits(summary.models, observedLimits, (stored.cachedModels as ModelInfo[] | undefined) ?? [], new Date().toISOString())
  if (limited.conflicts.length) {
    console.log(`[models] ${limited.conflicts.length} model(s) reported different token limits on different keys; the limits already known were kept`)
  }
  return {
    results: merged,
    slots,
    models: limited.models,
    unionIds: summary.unionIds,
    runnableIds: summary.runnableIds,
    activeSlots,
    refreshOutcome: summary.refreshOutcome,
    // Read from the merged list so every consumer sees one verdict set. The two agree on
    // `true` by construction — only a rejection is ever carried forward — but reading the
    // pre-merge array here is the kind of near-miss that survives a later change to the rule.
    anyValid: merged.some((r) => r.valid === true)
  }
}

export type ModelGuardVerdict = { ok: boolean; warning?: string; error?: string }

/**
 * Pre-spawn guard: check the chosen model against the runnable set so a doomed run fails
 * immediately with an actionable message instead of after the user has waited for the
 * engine's own `exit(1)` (main.py:645).
 *
 * Deliberately asymmetric: it BLOCKS only on positive evidence of absence, and merely
 * WARNS when availability is unknown. Refusing to start because the network was down
 * would be worse than letting the engine report the truth.
 *
 * "May switch" is only a warning while the active set has more than one slot (translation).
 * A one-slot set (transcription) cannot switch: absence on that slot is a refusal (SOL-23).
 */
export function guardModelForSpawn(
  model: string,
  cachedModels: ModelInfo[],
  activeSlots: number[]
): ModelGuardVerdict {
  const live = cachedModels.filter((m) => m.source === 'live')
  if (live.length === 0) {
    return {
      ok: true,
      warning:
        'Models have not been verified against your API key yet. If the run fails with ' +
        '"model not available", open Settings and use "Fetch Models & Check API Keys".'
    }
  }

  const entry = cachedModels.find((m) => m.id === model)
  if (!entry || entry.source !== 'live') {
    return {
      ok: false,
      error:
        `The selected model "${model}" was not in the list your API key returned. ` +
        'Open Settings > Gemini API Keys, run "Fetch Models & Check API Keys", and pick a model from the refreshed list.'
    }
  }

  const missingOn = activeSlots.filter((slot) => !entry.availableOn.includes(slot))
  if (missingOn.length > 0) {
    if (activeSlots.length <= 1) {
      return {
        ok: false,
        error:
          `The selected model "${model}" was not reported by the API key this run will use` +
          (missingOn.length ? ` (slot ${missingOn.map((i) => i + 1).join(', ')})` : '') +
          '. Open Settings > Gemini API Keys, run "Fetch Models & Check API Keys", and pick a model that key can see.'
      }
    }
    return {
      ok: true,
      warning:
        `"${model}" was not reported by API key slot ${missingOn.map((i) => i + 1).join(', ')}, ` +
        'which this run may switch to for extra quota. The run may fail if that happens.'
    }
  }

  return { ok: true }
}
