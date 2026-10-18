/**
 * The single source of truth for what a given Gemini model id supports.
 *
 * This exists because the same rules used to be implemented twice — in
 * `pythonBridge.thinkingArgs()` and inline in `SettingsPage` — with different logic.
 * That divergence is how the `-latest` bug survived: the UI happily offered a Thinking
 * Level control for an id the engine classified as "no thinking config at all".
 *
 * Thinking / transcription substring matching still mirrors the engine, in the same
 * order, so the UI can never offer a combination the engine will reject:
 *
 *   main.py:210  `if "2.0" in model or "gemini" not in model:`  -> no thinking config
 *   main.py:212  `elif "2.5" in model:`                          -> thinking_budget
 *   main.py:227  `elif "3" in model:`                            -> thinking_level
 *   main.py:214  Gemini 2.5 Pro cannot disable thinking; budget floor is 128
 *   main.py:603  non-pro 2.5 budget range; engine accepts 0, this app cannot deliver it
 *   main.py:1544 transcription requires "gemini" AND ("2.5" OR "3")
 *
 * Two deliberate divergences, both in the safe direction (declining to send a flag
 * rather than inventing one):
 *
 *   - An id containing `transcribe` is `thinking: 'none'` even though the engine's
 *     grammar classifies it as 3.x. Dedicated transcription models reject thinking
 *     configuration (REP-28). `supportsTranscription` stays true — that test is
 *     separate, or the Transcribe page would refuse the model it exists for.
 *   - Per-model thinking *levels* are transcribed from Google's docs, not from the
 *     engine's single `pro → reject minimal` rule (REP-31).
 *
 * `acceptsSamplingParams` is the one rule here that comes from GOOGLE rather than from
 * the engine, and it is the only one that is about the future rather than the present.
 * See `SAMPLING_DEPRECATED_FROM`.
 */

export type ThinkingMode = 'level' | 'budget' | 'none'

/** Values Gemini 3.x `thinking_level` accepts. `default` means omit the flag. */
export type ThinkingLevelId = 'default' | 'minimal' | 'low' | 'medium' | 'high'

export interface ModelCapabilities {
  /** Which thinking control (if any) the engine reads for this model. */
  thinking: ThinkingMode
  /**
   * Whether this app can actually turn thinking off for the model.
   *
   * Always false. Google documents `thinkingBudget = 0` as a disable for 2.5 Flash /
   * Flash-Lite, and the engine's `--no-thinking` exists, but `--no-thinking` coerces 3.x
   * to `minimal` and `cli.py` drops a falsy 0, so neither path is deliverable.
   */
  canDisableThinking: boolean
  /** Valid `--thinking-budget` range; only meaningful when `thinking === 'budget'`. */
  thinkingBudgetMin: number
  thinkingBudgetMax: number
  /**
   * Thinking-level values this model accepts, including `default` (send nothing).
   * Empty when `thinking !== 'level'`.
   */
  acceptedThinkingLevels: ThinkingLevelId[]
  /** `gst transcribe` hard-errors for anything that is not a Gemini 2.5/3.x model. */
  supportsTranscription: boolean
  /**
   * Whether `temperature` / `top_p` / `top_k` still do anything on this model.
   *
   * False means the three flags must not be sent AT ALL, regardless of what the user has
   * configured — see `SAMPLING_DEPRECATED_FROM` for why that is a correctness requirement
   * rather than tidiness.
   */
  acceptsSamplingParams: boolean
  /**
   * Whether a `responseMimeType` + response schema request reaches this model (D5-4). The shipping
   * engine sends one to every model (`main.py:245-247`, `:309-311`); a dedicated transcription id
   * refuses it (gate_ledger.md §5.17).
   */
  structuredOutput: boolean
  /**
   * The grid this model's timestamps actually land on, in milliseconds (AR2-1): `100` for the
   * dedicated model's measured word offsets, `1000` for whole seconds, `null` when no trustworthy
   * fixed grid is known. A request may never ask for finer than this.
   */
  timestampGranularityMs: number | null
}

/**
 * Where Google's sampling-parameter deprecation begins, as a version rather than a list.
 *
 * > **Starting with Gemini 3.6 Flash and Gemini 3.5 Flash-Lite, the following API changes
 * > apply to these models and all future Gemini model releases.**
 * > `temperature`, `top_p`, and `top_k` are deprecated and ignored. In future model
 * > generations, supplying these parameters returns an **HTTP 400** error.
 *
 * Two things make this awkward, and both are why it is expressed as a comparison instead of
 * a set of ids. First, the boundary runs THROUGH the 3.5 generation: 3.5 Flash-Lite is named
 * and 3.5 Flash is not, so a major-version test cannot express it. Second, "all future
 * releases" is open-ended, and this app fetches its model list **live** — a build that is
 * correct today would otherwise acquire a hard failure on the day Google ships the next
 * model, for every user with the toggle on, with nothing in the app to explain it.
 *
 * So an unrecognised or unversioned id resolves to **false**. Guessing that way round costs
 * a user a control that does nothing anyway; guessing the other way round costs them every
 * run. `-latest` aliases land here too, correctly: they follow the model line forwards.
 */
const SAMPLING_DEPRECATED_FROM = { major: 3, minor: 5 }

/**
 * The only ids AT the boundary version that are known to be outside the deprecation.
 *
 * An allowlist rather than "everything at 3.5 that is not Flash-Lite", because those are not
 * the same statement and the difference is reachable. Google names Gemini 3.5 Flash-Lite;
 * Gemini 3.5 **Flash** is simply absent from the list, which is the only reason it is exempt.
 * Nothing is said about any other 3.5 model — `gemini-3.5-pro` exists in this app's own
 * `SUSPICIOUS_MODEL_IDS` and a stored profile can still hold it, and a live fetch can return a
 * 3.5 family that did not exist when this was written. Those are unknowns, and the rule for an
 * unknown is stated above: withhold.
 *
 * So the exemption is spelled out id by id. Adding one is a deliberate act that should carry
 * evidence that Google left it out; the cost of being wrong here is every run failing, while
 * the cost of an id missing from this list is a control that does nothing anyway.
 */
const SAMPLING_EXEMPT_AT_BOUNDARY = ['gemini-3.5-flash']

/**
 * Version taken from the canonical Gemini id grammar, or null when the whole id is
 * unrecognised.
 *
 * Sampling is withheld for anything unrecognised, so this must not pick a `major.minor`
 * out of an otherwise unknown name (`gemini-experimental-2.5-flash` is not a 2.5 model
 * we have classified). The optional `models/` prefix is the API's own spelling of the
 * same id, not a different one. Thinking/transcription still use substring matching —
 * that is the engine's grammar, and this function is not it.
 */
function modelVersion(model: string): { major: number; minor: number } | null {
  const m = model.match(/^(?:models\/)?gemini-(\d+)\.(\d+)(?:-[a-z0-9]+)*$/)
  return m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) } : null
}

function acceptsSampling(model: string, isGemini: boolean): boolean {
  if (!isGemini) return false
  const v = modelVersion(model)
  if (!v) return false
  const cut = SAMPLING_DEPRECATED_FROM
  // Everything BEFORE the boundary is unaffected whatever its family — the deprecation is
  // written as "starting with", so no family-level judgement is needed down here.
  if (v.major !== cut.major) return v.major < cut.major
  // Compared as numbers, not as text, so a future 3.10 sorts AFTER 3.6 rather than beside 3.1.
  if (v.minor !== cut.minor) return v.minor < cut.minor
  // Exactly at the boundary, and only here, the answer is per-model. The API's own `models/`
  // prefix is tolerated because that is the same model, not a different one.
  return SAMPLING_EXEMPT_AT_BOUNDARY.includes(model.replace(/^models\//, ''))
}

/**
 * Timestamp grids, by the path that produces them (`ARCHITECTURE_TARGET.md` §6.2).
 *
 * A dedicated transcription model MEASURES its offsets: 82 of 82 words on a 100 ms grid
 * (`probe_gemini_3_5_transcribe.md` §7.1; 1 830 of 1 830 again in gate_ledger.md §5.17). A generic
 * model is ASKED for them, and whole seconds is the finest it has been shown to honour: asked for
 * milliseconds at the product's 300 s operating point, its digits landed on no single grid and were
 * no more accurate than its whole seconds — once drifting 9 s. Sub-second digits there would look
 * precise and not be (§5.17). Anything else has no grid anyone has measured.
 */
const DEDICATED_TIMESTAMP_GRANULARITY_MS = 100
const GENERIC_TIMESTAMP_GRANULARITY_MS = 1000

type PerModelFacts = 'supportsTranscription' | 'acceptsSamplingParams' | 'structuredOutput' | 'timestampGranularityMs'

const NO_THINKING: Omit<ModelCapabilities, PerModelFacts> = {
  thinking: 'none',
  canDisableThinking: false,
  thinkingBudgetMin: 0,
  thinkingBudgetMax: 0,
  acceptedThinkingLevels: []
}

/**
 * Google's per-model `thinking_level` sets, without `default`.
 *
 * Transcribed 2026-08-29 from:
 *   https://ai.google.dev/gemini-api/docs/generate-content/thinking
 *   https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking
 *   https://firebase.google.com/docs/ai-logic/thinking
 *
 * `low` and `high` are the only two every level-model in that table supports. An id
 * that is not recognised here falls back to those two (plus `default`), never to the
 * full set — offering `minimal` on a guess is how REP-28 happened.
 *
 * Re-read those pages when Google ships a model; the fallback is what keeps a stale
 * row from becoming a 400.
 */
const ALL_LEVELS: Exclude<ThinkingLevelId, 'default'>[] = ['minimal', 'low', 'medium', 'high']

function documentedThinkingLevels(model: string): Exclude<ThinkingLevelId, 'default'>[] | null {
  // Image models are named ids, not a substring family. `image` + `flash` would otherwise
  // hand every future `*-flash-image` Minimal, and `image` + `pro` would hand every
  // `*-pro-image` High-only — both skip the unknown fallback. Suffixes after `-image`
  // (`-preview`, dated builds) are the same model; the `models/` prefix is too.
  //
  // Gemini 3 Pro Image: HIGH only.
  if (/(?:^|\/)gemini-3(?:\.0)?-pro-image(?:-|$)/.test(model)) {
    return ['high']
  }
  // Gemini 3.1 Flash Image / Flash-Lite Image: MINIMAL + HIGH.
  if (/(?:^|\/)gemini-3\.1-flash(?:-lite)?-image(?:-|$)/.test(model)) {
    return ['minimal', 'high']
  }
  // Any other image id is unknown. Return before the text-model rules so
  // `gemini-3.5-flash-image` cannot inherit 3.5 Flash's full set via substring.
  if (model.includes('image')) {
    return null
  }
  // Gemini 3.7 Flash: LOW, MEDIUM, HIGH. MINIMAL is a documented 400. No "pro" in the id.
  if (model.includes('3.7') && model.includes('flash') && !model.includes('lite')) {
    return ['low', 'medium', 'high']
  }
  // Gemini 3.1 Pro: LOW, MEDIUM, HIGH.
  if (model.includes('3.1') && model.includes('pro')) {
    return ['low', 'medium', 'high']
  }
  // Gemini 3 Pro / 3.0 Pro (not 3.1+, not image): LOW and HIGH only. MEDIUM 400s.
  if (/(?:^|\/)gemini-3(?:\.0)?-pro(?:-|$)/.test(model)) {
    return ['low', 'high']
  }
  // Families Google lists as accepting all four discrete levels. 3.5 Flash-Lite and
  // 3.1 Flash-Lite are in that table; 3.6 Flash-Lite and 3 Flash-Lite are not, so they
  // must not inherit the full set via a substring match.
  if (
    (model.includes('3.6-flash') && !model.includes('lite')) ||
    model.includes('3.5-flash') ||
    model.includes('3.1-flash') ||
    (/(?:^|\/)gemini-3(?:\.0)?-flash(?:-|$)/.test(model) && !model.includes('lite'))
  ) {
    return ALL_LEVELS
  }
  return null
}

function levelChoicesFor(model: string): ThinkingLevelId[] {
  const documented = documentedThinkingLevels(model)
  const discrete = documented ?? ['low', 'high']
  return ['default', ...discrete]
}

export function modelCapabilities(id: string): ModelCapabilities {
  const model = (id || '').toLowerCase()
  const isGemini = model.includes('gemini')
  const is20 = model.includes('2.0')
  const is25 = model.includes('2.5')
  // Checked last, exactly like the engine, so "gemini-2.5-...-03-25" stays a 2.5 model.
  const is3x = !is20 && !is25 && model.includes('3')
  const isPro = model.includes('pro')
  const isTranscribe = model.includes('transcribe')

  const supportsTranscription = isGemini && (is25 || is3x)
  const acceptsSamplingParams = acceptsSampling(model, isGemini)
  const structuredOutput = isGemini && !isTranscribe
  // The 100 ms grid was measured on `generateContent`; a `-live` id is bidi-only and was not.
  const timestampGranularityMs = isTranscribe
    ? isGemini && !model.includes('live')
      ? DEDICATED_TIMESTAMP_GRANULARITY_MS
      : null
    : supportsTranscription
      ? GENERIC_TIMESTAMP_GRANULARITY_MS
      : null
  const shared = { supportsTranscription, acceptsSamplingParams, structuredOutput, timestampGranularityMs }

  // Dedicated transcription models reject ThinkingConfig. Classifying them as 3.x
  // (the engine's grammar) would send `--thinking-level` and 400. Keep
  // supportsTranscription true so the Transcribe page does not refuse them.
  if (isTranscribe) {
    return { ...NO_THINKING, ...shared }
  }

  if (!isGemini || is20) {
    return { ...NO_THINKING, ...shared }
  }

  if (is25) {
    return {
      thinking: 'budget',
      canDisableThinking: false,
      // Engine range includes 0 for non-Pro, but cli.py `if args.thinking_budget:` drops it.
      thinkingBudgetMin: isPro ? 128 : 1,
      thinkingBudgetMax: isPro ? 32768 : 24576,
      acceptedThinkingLevels: [],
      ...shared
    }
  }

  if (is3x) {
    return {
      thinking: 'level',
      canDisableThinking: false,
      thinkingBudgetMin: 0,
      thinkingBudgetMax: 0,
      acceptedThinkingLevels: levelChoicesFor(model),
      ...shared
    }
  }

  return { ...NO_THINKING, ...shared }
}

/**
 * The sampling values this model would be given if nobody had chosen any.
 *
 * A preview, not a recommendation: while the custom-parameters toggle is off none of this is
 * sent, and each model runs on Google's own tuning. It exists so the fields show something
 * plausible for the selected generation, and so "reset to this model's defaults" has
 * something to reset TO — which is what the old unconditional overwrite was really for.
 *
 * For a 3.x model these numbers ARE the model's own defaults, so "customising" to them sends
 * values that merely restate what it would have done anyway. Said out loud so nobody later
 * "improves" them into something that quietly changes behaviour.
 */
export function samplingDefaults(id: string): { temperature: number; topP: number } {
  const model = (id || '').toLowerCase()
  const is3x = !model.includes('2.0') && !model.includes('2.5') && model.includes('3')
  return is3x ? { temperature: 1.0, topP: 0.95 } : { temperature: 0.3, topP: 0.8 }
}

/**
 * Persist the shared sampling toggle OFF only when the selected model itself becomes
 * one that accepts sampling.
 *
 * The stored flag is shared with Transcribe. Do not clear it merely because the *current*
 * model rejects sampling — an override may still accept, and `generationParamArgs`
 * withholds flags per run model (SOL-69). Do clear it on rejecting → accepting, or a
 * refresh that swaps the id would expose stored ON again without the user turning the
 * control back on (SF-7 / SOL-71).
 */
export function shouldPersistSamplingToggleOff(
  previousModel: string,
  nextModel: string,
  customGenerationParams: boolean
): boolean {
  return (
    customGenerationParams &&
    !modelCapabilities(previousModel).acceptsSamplingParams &&
    modelCapabilities(nextModel).acceptsSamplingParams
  )
}

/**
 * The thinking level the engine will actually apply, after this app's own coercions.
 *
 * `default` (and a leftover stored `disabled`) means omit the flag — Google's documented
 * behaviour when no thinking level is specified. An unsupported discrete level is replaced
 * by one this model accepts, so the Settings warning never claims a setting that would 400.
 */
export function effectiveThinkingLevel(id: string, level: string): string {
  const caps = modelCapabilities(id)
  if (caps.thinking !== 'level') return level
  if (level === 'default' || level === 'disabled') return 'default'
  if (caps.acceptedThinkingLevels.includes(level as ThinkingLevelId)) return level
  if (caps.acceptedThinkingLevels.includes('low')) return 'low'
  const discrete = caps.acceptedThinkingLevels.find((v) => v !== 'default')
  return discrete ?? 'default'
}

// ── the request configuration (implementation_plan.md Step 1.3) ──────────────────────────────

/** Which native request is being configured. */
export type RequestKind = 'translate' | 'transcribe'

/** The Gemini wire spelling of a thinking level. */
export type ThinkingWireLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'

/** The settings a request is configured from — the same values the CLI flags are built from. */
export interface RequestConfigInput {
  kind: RequestKind
  model: string
  thinkingLevel: string
  thinkingBudget: number
  customGenerationParams: boolean
  temperature: number
  topP: number
  topK: number | null
  /** The stored tier. `standard`, empty and absent are all the provider default. */
  serviceTier?: string
}

/** A configured value the request does not carry, and why. Numbers and tier words only. */
export interface WithheldSetting {
  field: 'temperature' | 'topP' | 'topK' | 'thinkingBudget' | 'serviceTier'
  value: number | string
  reason: 'zero' | 'model-rejects-sampling' | 'transcribe-ignores-sampling' | 'dedicated-transcription-model' | 'unknown-tier'
}

export interface ModelRequestConfig {
  thinking?: { level?: ThinkingWireLevel; budget?: number; includeThoughts: true }
  temperature?: number
  topP?: number
  topK?: number
  serviceTier?: 'flex' | 'priority'
  withheld: WithheldSetting[]
}

const WIRE_LEVEL: Record<Exclude<ThinkingLevelId, 'default'>, ThinkingWireLevel> = {
  minimal: 'MINIMAL',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH'
}

const SENT_TIERS: ReadonlySet<string> = new Set(['flex', 'priority'])

/**
 * The thinking/sampling/tier part of one native request, from the rules above and nothing else.
 *
 * Exactly what the shipping engine puts on the wire for the flags `thinkingArgs` and
 * `generationParamArgs` would have emitted (`pythonBridge.ts:294-372`) — gated per model against the
 * engine's own config builders (`main.py:207-328`). Four things follow from that and are not choices:
 *
 * - `includeThoughts: true` rides with every thinking config. The engine runs with `thinking = True`
 *   (`main.py:103`; this app never passes `--no-thinking`) and sends
 *   `ThinkingConfig(include_thoughts=self.thinking, …)` wherever it attaches one (`:260-268`, `:319-327`).
 * - Transcription carries no sampling. `cli.py:321-326` stores the flags and `_get_transcribe_config`
 *   never reads them, so they have never reached the API; sending them now would change every
 *   transcription made with the shared toggle on.
 * - A zero is withheld, never sent: `cli.py` tests every one of these with plain truthiness.
 * - `standard` is the default tier and is not sent, matching `buildTranslateArgs`; Transcription
 *   now sends the selected tier too (AR2-2, `codebase_map.md` §23.2).
 *
 * Two deliberate differences. Transcription sends the tier, which its argv never carried (above).
 * And a dedicated transcription id gets no thinking config and no sampling on either path: the
 * engine's grammar files it under "3" and attaches one, and the API refuses it ("Thinking is not
 * enabled for this model") — D5-18, REP-28, measured in gate_ledger.md §5.17.
 */
export function modelRequestConfig(input: RequestConfigInput): ModelRequestConfig {
  const model = (input.model || '').toLowerCase()
  const caps = modelCapabilities(input.model)
  const withheld: WithheldSetting[] = []
  const out: ModelRequestConfig = { withheld }

  const isTranscribeModel = model.includes('transcribe')
  // The engine's own `thinking_compatible` test (`main.py:209-211`, `:273-275`), not modelCaps'.
  const engineAttachesThinking = model.includes('gemini') && !model.includes('2.0')
  if (engineAttachesThinking && !isTranscribeModel) {
    const thinking: NonNullable<ModelRequestConfig['thinking']> = { includeThoughts: true }
    if (caps.thinking === 'level') {
      const effective = effectiveThinkingLevel(input.model, input.thinkingLevel)
      if (effective !== 'default') thinking.level = WIRE_LEVEL[effective as Exclude<ThinkingLevelId, 'default'>]
    } else if (caps.thinking === 'budget') {
      const budget = input.thinkingBudget
      const clamped = Math.min(caps.thinkingBudgetMax, Math.max(caps.thinkingBudgetMin, budget))
      if ((!budget && caps.thinkingBudgetMin < 128) || !clamped) {
        withheld.push({ field: 'thinkingBudget', value: budget, reason: 'zero' })
      } else {
        thinking.budget = clamped
      }
    }
    out.thinking = thinking
  }

  if (input.customGenerationParams) {
    const sampling: Array<['temperature' | 'topP' | 'topK', number | null]> = [
      ['temperature', input.temperature],
      ['topP', input.topP],
      ['topK', input.topK]
    ]
    // The dedicated-model test is by name, not through `acceptsSamplingParams`: that refuses
    // `gemini-3.5-transcribe` only because 3.5 is the deprecation boundary, and a `3.4-transcribe`
    // would pass it (D5-18).
    const blanket: WithheldSetting['reason'] | null = isTranscribeModel
      ? 'dedicated-transcription-model'
      : input.kind === 'transcribe'
        ? 'transcribe-ignores-sampling'
        : !caps.acceptsSamplingParams
          ? 'model-rejects-sampling'
          : null
    for (const [field, value] of sampling) {
      if (value == null) continue
      if (blanket) withheld.push({ field, value, reason: blanket })
      else if (!value) withheld.push({ field, value, reason: 'zero' })
      else out[field] = value
    }
  }

  const tier = (input.serviceTier ?? '').trim()
  if (SENT_TIERS.has(tier)) out.serviceTier = tier as 'flex' | 'priority'
  else if (tier && tier !== 'standard') withheld.push({ field: 'serviceTier', value: tier, reason: 'unknown-tier' })

  return out
}
