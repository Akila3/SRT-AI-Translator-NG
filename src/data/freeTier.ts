/**
 * Free-tier rate-limit guidance for the Paid Quota tooltip.
 *
 * ── REVALIDATION MARKER — last checked 2026-08-18 ──────────────────────────────────
 * Before changing anything here, re-read RATE_LIMITS_URL. Do NOT copy figures from a
 * plan document, a previous version of this file, or a third-party tracker: this table
 * was wrong for months precisely because numbers were copied forward without being
 * re-read, and nothing in the UI could reveal that.
 *
 * Finding on 2026-08-18: **Google's rate-limits page no longer publishes a per-model
 * free-tier table.** It defines RPM/TPM/RPD, documents the paid usage tiers and the
 * spend-based limits, and then defers per-model figures to AI Studio ("Rate limits
 * depend on a variety of factors ... and can be viewed in Google AI Studio"). Every
 * per-model free-tier number in circulation is therefore third-party, and the trackers
 * disagree with each other by up to 4x on TPM and 6x on RPD.
 *
 * So this file ships NO free-tier numbers. That is the deliberate outcome, not an
 * omission: a figure the user cannot distinguish from a verified one is worse than a
 * clear "look it up", because the app has no way to correct it and the user has no
 * reason to doubt it. The `limits` variant is retained for the day Google publishes an
 * official table again — populate it only from that page, with its own `asOf`.
 */
export type TierInfo =
  | { kind: 'limits'; rpm: string; rpd: string; tpm: string; tpr: string; asOf: string; source: string }
  | { kind: 'none'; reason: string; asOf: string; source: string }
  | { kind: 'unknown' }

/** When the claims in this file were last checked against Google's documentation. */
export const RATE_LIMITS_UPDATED = '2026-08'
export const RATE_LIMITS_URL = 'https://ai.google.dev/gemini-api/docs/rate-limits'
export const AI_STUDIO_URL = 'https://aistudio.google.com'

/**
 * Flash and Flash-Lite do have a free tier — its size is simply not published per model
 * any more, so the honest answer is "unknown, check AI Studio" rather than a number.
 */
const UNKNOWN: TierInfo = { kind: 'unknown' }

/**
 * Pro is the one qualitative claim worth making, because it changes what the user should
 * do rather than merely how fast they can go: no amount of free-tier pacing helps if
 * there is no free allowance. Attributed honestly — this is not on Google's rate-limits
 * page either, so the tooltip says where it comes from and defers to AI Studio.
 */
const PRO: TierInfo = {
  kind: 'none',
  reason: 'Google removed Pro models from the free tier in April 2026; access is paid or trial-level',
  asOf: '2026-04',
  source: 'independent rate-limit trackers, checked 2026-08 — not stated on Google\u2019s rate-limits page'
}

export const FREE_TIER: Record<string, TierInfo> = {
  'gemini-3.5-flash': UNKNOWN,
  'gemini-3.1-flash-lite': UNKNOWN,
  'gemini-3.1-pro': PRO,
  'gemini-2.5-flash': UNKNOWN,
  'gemini-2.5-flash-lite': UNKNOWN,
  'gemini-2.5-pro': PRO
}

/**
 * Per-family fallback for fetched models not listed above. Only the Pro family resolves
 * to a claim; everything else is `unknown`, which is the truthful answer now that no
 * official per-model table exists.
 */
export function lookupFreeTier(model: string): TierInfo {
  if (FREE_TIER[model]) return FREE_TIER[model]
  if (!/^gemini-/.test(model)) return { kind: 'unknown' }
  if (/pro/.test(model)) return PRO
  return { kind: 'unknown' }
}

export function paidQuotaTooltip(model: string, modelLabel: string): string {
  const tier = lookupFreeTier(model)

  let body: string
  if (tier.kind === 'limits') {
    body =
      `When OFF — the app adds conservative delays to stay within the free-tier rate limits for ${modelLabel}:\n` +
      `• ~${tier.rpm} RPM  — requests per minute\n` +
      `• ~${tier.rpd} RPD  — requests per day\n` +
      `• ~${tier.tpm} TPM  — tokens per minute\n` +
      `• ~${tier.tpr} tokens per request\n\n` +
      `Typical free-tier figures, not your account's (${tier.source}, checked ${tier.asOf}). ` +
      `Your live limits are in ${AI_STUDIO_URL}.`
  } else if (tier.kind === 'none') {
    body =
      `${modelLabel} has NO free tier — ${tier.reason} (as of ${tier.asOf}; ${tier.source}). ` +
      `Free-tier pacing cannot keep you inside an allowance that does not exist, so without billing ` +
      `this model returns quota errors whatever this setting says. Confirm in ${AI_STUDIO_URL}.`
  } else {
    body =
      `When OFF — the app paces requests conservatively to stay inside the free tier for ${modelLabel}.\n\n` +
      `No specific numbers are shown because Google no longer publishes a per-model free-tier table ` +
      `(${RATE_LIMITS_URL} now defers to AI Studio), and the third-party figures in circulation ` +
      `disagree with each other. Your account's actual limits are shown live in ${AI_STUDIO_URL}.`
  }

  return (
    `Reflects the tier you set on the API key this run will actually use (its "Primary" badge in ` +
    `Gemini API Keys). Set it there, not here.\n\n` +
    `${body}\n\n` +
    `Quota is counted per Google Cloud PROJECT, not per key — adding more keys created under the same ` +
    `project does not raise your limits.\n\n` +
    `When ON — rate limiting is disabled and the app runs at full speed. Only accurate if the key is ` +
    `really on a paid plan, or you will hit 429 quota errors.`
  )
}

export const THINKING_LEVELS = [
  { value: 'default', label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

/** Options a thinking-level Select should offer, given this model's accepted set. */
export function thinkingLevelsForModel(
  accepted: readonly string[],
  current?: string
): { value: string; label: string }[] {
  const opts = THINKING_LEVELS.filter((o) => accepted.includes(o.value))
  if (current && !opts.some((o) => o.value === current)) {
    const orphan = THINKING_LEVELS.find((o) => o.value === current)
    opts.push(orphan ?? { value: current, label: `${current} (not supported)` })
  }
  return opts
}

export const SERVICE_TIERS = [
  { value: 'standard', label: 'Standard (Default)' },
  { value: 'flex', label: 'Flex' },
  { value: 'priority', label: 'Priority' }
]
