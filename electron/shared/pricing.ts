/**
 * The dated cost estimate (implementation_plan.md Step 3.1, AR3-10). AUTHORED-BY: opus-5.5-high
 *
 * `pricing.json` is gst 3.8.3's table copied byte for byte (`codebase_map.md` §24.2, SHA-256
 * `1c3893c5…fa8`), so the rates and their date travel with the app and are never fetched. An
 * estimate exists only for an exact model id and an exact tier column; there is no Standard fallback,
 * no alias and no guess. The Batch column is kept as data but no setting selects it.
 *
 * Price: prompt tokens at the input rate plus thought and output tokens at the output rate, per
 * million. Thoughts are billed as output.
 */
import table from './pricing.json'
import type { Usage, UsageBucket } from './engineEvents'

export type PricedTier = 'standard' | 'flex' | 'priority'

/** The settings values that select a column, mapped only to the same-named column. */
const TIERS: ReadonlySet<string> = new Set<PricedTier>(['standard', 'flex', 'priority'])

interface Rate {
  input: number
  output: number
}

/** When the captured rates were last updated, as the table says (`YYYY-MM-DD`). */
export const PRICING_UPDATED: string = table.updated
export const PRICING_CURRENCY: string = table.currency
export const PRICING_SOURCE: string = table.source

export const COST_UNAVAILABLE_COPY = 'Cost estimate unavailable for this model and service tier.'

function rateFrom(value: unknown): Rate | null {
  if (typeof value !== 'object' || value === null) return null
  const { input, output } = value as { input?: unknown; output?: unknown }
  if (typeof input !== 'number' || typeof output !== 'number') return null
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null
  return { input, output }
}

type Models = Record<string, Record<string, unknown> | undefined>

/** The exact model's exact tier column, or null. `models` is injectable for the gates. */
export function priceRate(model: string, serviceTier: string | undefined, models: unknown = table.models): Rate | null {
  if (typeof serviceTier !== 'string' || !TIERS.has(serviceTier)) return null
  if (typeof models !== 'object' || models === null) return null
  if (!Object.prototype.hasOwnProperty.call(models, model)) return null
  const row = (models as Models)[model]
  if (typeof row !== 'object' || row === null || !Object.prototype.hasOwnProperty.call(row, serviceTier)) return null
  return rateFrom(row[serviceTier])
}

function count(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

function costAt(rate: Rate, input: number, thoughts: number, output: number): number {
  return (input * rate.input) / 1e6 + ((thoughts + output) * rate.output) / 1e6
}

function tokenBearing(b: UsageBucket): boolean {
  return [b.estimatedInputTokens, b.actualInputTokens, b.outputTokens, b.thoughtTokens, b.billedButUnusableTokens].some(
    (n) => n !== undefined && n !== 0
  )
}

/**
 * The run's estimated cost in USD, or null when it cannot be stated exactly.
 *
 * Without buckets the top-level totals are priced against `model`. With buckets every token-bearing
 * bucket must name an exact table model and carry actual input, output and thought counts; their
 * sums must equal the top-level totals; each is priced at the run's one tier. Any bucket that cannot
 * be priced makes the whole estimate unavailable: an estimated-only input count or a partial total is
 * never shown.
 */
export function estimateCost(model: string, serviceTier: string | undefined, usage: Usage, models: unknown = table.models): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const { promptTokens, thoughtTokens, outputTokens } = usage
  if (!count(promptTokens) || !count(thoughtTokens) || !count(outputTokens)) return null

  if (usage.buckets === undefined) {
    const rate = priceRate(model, serviceTier, models)
    return rate ? costAt(rate, promptTokens, thoughtTokens, outputTokens) : null
  }
  if (!Array.isArray(usage.buckets)) return null
  let input = 0
  let thoughts = 0
  let output = 0
  let cost = 0
  for (const b of usage.buckets) {
    if (typeof b !== 'object' || b === null) return null
    if (!tokenBearing(b)) continue
    if (!count(b.actualInputTokens) || !count(b.outputTokens) || !count(b.thoughtTokens)) return null
    const rate = priceRate(b.model, serviceTier, models)
    if (!rate) return null
    input += b.actualInputTokens
    thoughts += b.thoughtTokens
    output += b.outputTokens
    cost += costAt(rate, b.actualInputTokens, b.thoughtTokens, b.outputTokens)
  }
  if (input !== promptTokens || thoughts !== thoughtTokens || output !== outputTokens) return null
  return cost
}

/** A copy of `usage` carrying its estimate, or without one when none can be stated. */
export function withCostEstimate(usage: Usage, model: string, serviceTier: string | undefined): Usage {
  const { costEstimate: _stale, ...rest } = usage
  const cost = estimateCost(model, serviceTier, rest)
  return cost === null ? rest : { ...rest, costEstimate: cost }
}

/** USD, to the cent once it reaches one, else to four places so a small run is not shown as zero. */
export function formatCostUsd(value: number): string {
  if (value === 0) return '$0.00'
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`
}
