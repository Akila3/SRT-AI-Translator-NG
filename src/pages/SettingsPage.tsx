import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import {
  Label,
  TextInput,
  NumberInput,
  Select,
  Toggle,
  ToggleRow,
  Tooltip,
  Button,
  Divider,
  Pill,
  LinkLabel
} from '../components/ui'
import {
  countKeyStates,
  keyHeadline,
  keyStateOf,
  uncheckedNote
} from '../lib/keyStatus'
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../data/languages'
import { thinkingLevelsForModel, SERVICE_TIERS, paidQuotaTooltip, RATE_LIMITS_URL } from '../data/freeTier'
import { openExternalLink } from '../lib/openExternal'
import {
  activeKeySlots,
  forgetSlotEvidence,
  keyRoles,
  orderKeySlots,
  reindexEvidenceAfterRemoval,
  type KeyRole,
  type KeySlot
} from '../../electron/shared/keyOrder'
import {
  effectiveThinkingLevel,
  modelCapabilities,
  samplingDefaults,
  shouldPersistSamplingToggleOff
} from '../../electron/shared/modelCaps'
import { dedicatedThinkingReason, resolveTranscribeSettings } from '../../electron/shared/transcribeSettings'
import {
  DEFAULT_QUOTA_GROUP_ID,
  quotaGroupRuntimeView,
  usableManualCapacity,
  validReservePercent,
  type QuotaGroupMutation
} from '../../electron/shared/quotaGroups'
import {
  DEFAULT_RESUME_CONTEXT_SIZE,
  MAX_BATCH_CONTEXT_LINES,
  MIN_BATCH_CONTEXT_LINES,
  type AppSettings,
  type FfmpegPathValidation,
  type ManualQuotaValues,
  type ModelInfo,
  type OsCheckResult,
  type RtlMethod
} from '../../electron/shared/types'

const PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing'

/** Shown beside Custom Generation Parameters while the selected model still accepts them. */
export const SAMPLING_TOGGLE_DESC =
  "Override the model's own temperature / top-p / top-k defaults"

/**
 * Shown while the control is greyed. Neutral, not amber: the switch cannot appear ON for a
 * model that rejects sampling (hazard 137), and the reason belongs in `desc`.
 */
export const SAMPLING_UNAVAILABLE_DESC =
  'Not available for this model — Google deprecated temperature, top-p and top-k from Gemini 3.6 Flash and 3.5 Flash-Lite onwards. Steer it with the Description field instead.'

export function samplingToggleDesc(model: string): string {
  return modelCapabilities(model).acceptsSamplingParams ? SAMPLING_TOGGLE_DESC : SAMPLING_UNAVAILABLE_DESC
}

/** Visual ON only when the stored intent applies to this Settings model. */
export function samplingToggleChecked(customGenerationParams: boolean, model: string): boolean {
  return customGenerationParams && modelCapabilities(model).acceptsSamplingParams
}

/**
 * Logs section copy (LOG.1 / DLOG-6). Keys and defaults are unchanged.
 * Feature 8 (D8-14) rewrote the two token controls' help to name both run kinds; the other two stay Translate only.
 */
export const LOGS_CONSOLE_NOTE =
  'The complete console log (.console.log) is attempted once a run reserves its slot, including when later preparation or starting the engine fails. It has no off switch. A model the app refuses, or a second job started while one is already running, never reserves a slot and has no console file.'

export const SHOW_TOKEN_USAGE_DESC = 'Show prompt, thoughts, output and total for Translate and Transcribe runs'
export const SHOW_TOKEN_USAGE_TIP =
  'Show prompt, thought, output, and total token counts during and after Translate or Transcribe runs when the provider reports them. On by default. Turning this off hides only the token-usage grid. The status card stays.'

export const WRITE_TOKEN_REPORT_DESC = 'Save a .tokens.json usage report beside the subtitle, for Translate and Transcribe'
export const WRITE_TOKEN_REPORT_TIP =
  'Write a .tokens.json usage report for a Translate or Transcribe run after at least one provider attempt. Translate stages the report with the run and places it next to the subtitle when you save. Transcribe already has its destination, so it writes beside that selected output when the run finishes, fails, or is stopped. Off by default.'

export const PROGRESS_LOG_DESC = 'Write a .progress.log diagnostic beside the translated subtitle'
export const PROGRESS_LOG_TIP =
  'Translate only. A progress diagnostic for a person to read (.progress.log). It is placed next to your subtitle when you save it, not while the run is going. It is not resume state: the app does not read this file to continue an interrupted job. Transcription does not write it. Off by default.'

export const THOUGHTS_LOG_DESC = "Save the model's thought summaries to a .thoughts.log beside the translated subtitle"
export const THOUGHTS_LOG_TIP =
  'Translate only. Writes .thoughts.log next to your subtitle when you save it. The file holds thought summaries the model provided. It is not a record of hidden reasoning. It may be empty, very large, or contain subtitle text. Transcription does not write it. Off by default.'

/** Output section, RTL formatting (D12-14). The ids are stable; only these labels are shown, in this order. */
export const RTL_FORMATTING_LABEL = 'RTL subtitle formatting'
export const RTL_FORMATTING_DESC = 'Prepare saved right-to-left subtitles for media players.'
export const RTL_FORMATTING_TIP =
  'Formats the saved/display subtitle copy for right-to-left playback. Source, analysis, gender, alignment, context, cache and repair text stay unchanged. Turning this off hides the method selector and exports logical text. Your selected method is remembered.'
export const RTL_METHOD_LABEL = 'RTL display method'
export const RTL_METHOD_OPTIONS: { value: RtlMethod; label: string }[] = [
  { value: 'hybrid', label: 'Smart RTL (Recommended)' },
  { value: 'kodi_rtl_base', label: 'Hebrew Compatibility' },
  { value: 'gst_compatibility', label: 'Classic RTL' },
  { value: 'kodi_reverse', label: 'Basic-Player RTL' },
  { value: 'kodi_legacy', label: 'Old Subtitle Repair' }
]
export const RTL_METHOD_TIP = [
  'Choose how saved RTL subtitles are prepared for your player.',
  'Smart RTL (Recommended) — Start here. Formats each applicable line, preserves styles, and supports Hebrew, Arabic, Persian, Pashto and Urdu.',
  'Hebrew Compatibility — Try this second when Hebrew looks wrong with Smart RTL. It uses the safe Hebrew line-based method for players that display Smart RTL incorrectly.',
  'Classic RTL — Reproduces the previous v1.1.0 whole-cue behavior. Use it when subtitles made by the previous app displayed better on your player.',
  'Basic-Player RTL — Emergency Hebrew fallback for a player that ignores normal RTL direction controls. It physically changes punctuation and can remove punctuation marks, so use it only after the first three methods fail.',
  'Old Subtitle Repair — Only for old Hebrew subtitles already saved with reversed or moved punctuation. It is normally wrong for newly generated subtitles.',
  'How to choose: start with Smart RTL; for a Hebrew display problem try Hebrew Compatibility; for previous-version behavior try Classic RTL; if the player ignores direction controls try Basic-Player RTL; use Old Subtitle Repair only for an old damaged file.'
].join('\n\n')

/** The toggle always; the method label, its help and the selector only while formatting is On. */
export function RtlOutputControls({ settings, set }: SectionProps): React.JSX.Element {
  const enabled = settings.rtlEnabled !== false
  return (
    <>
      <ToggleRow
        label={RTL_FORMATTING_LABEL}
        desc={RTL_FORMATTING_DESC}
        tip={RTL_FORMATTING_TIP}
        checked={enabled}
        onChange={(v) => set('rtlEnabled', v)}
      />
      {enabled && (
        <div>
          <Label tip={RTL_METHOD_TIP}>{RTL_METHOD_LABEL}</Label>
          <Select value={settings.rtlMethod} onChange={(v) => set('rtlMethod', v as RtlMethod)} options={RTL_METHOD_OPTIONS} className="w-full" />
        </div>
      )}
    </>
  )
}

/** Translation section, Cross-Batch Context (D15-2R). */
export const BATCH_CONTEXT_LABEL = 'Cross-Batch Context'
export const BATCH_CONTEXT_DESC =
  'Send the previous few original lines with each request, so the AI knows what is happening in the scene. Default: ON.'
export const BATCH_CONTEXT_TIP = [
  'ON (default): every request after the first also carries up to the number of previous original-language lines set by Previous Context Cues, as background only. They are not translated again and not written to the output. Earlier translations are not sent.',
  'OFF: each batch is translated on its own, at the lowest cost.',
  'Cost: the background lines are billed as fresh input on every request — with the default 5, about five extra lines of original text per request. The exact amount depends on language and line length.'
].join('\n\n')
export const BATCH_CONTEXT_LINES_LABEL = 'Previous Context Cues'
export const BATCH_CONTEXT_LINES_TIP = [
  'Default: 5 cues. In our tests (Gemini Flash-Lite 3.5, Low thinking, English to Hebrew), 5 previous lines did better than 8 in a blind review, and did better than sending no earlier lines in a smaller one. Other languages and models were not tested.',
  'Normally leave this at 5. Try fewer if your subtitles change scenes very quickly; try more only if long conversations clearly need older lines. The earlier lines are sent again as billed input. One cue is one subtitle item, even if its text wraps onto more than one line.'
].join('\n\n')
export const BATCH_CONTEXT_LINES_OPTIONS: { value: string; label: string }[] = Array.from(
  { length: MAX_BATCH_CONTEXT_LINES - MIN_BATCH_CONTEXT_LINES + 1 },
  (_, i) => String(MIN_BATCH_CONTEXT_LINES + i)
).map((v) => ({ value: v, label: v }))

/** The toggle always; the cue count only while it is ON. Turning it OFF never writes the count. */
export function BatchContextControls({ settings, set }: SectionProps): React.JSX.Element {
  return (
    <>
      <ToggleRow
        label={BATCH_CONTEXT_LABEL}
        desc={BATCH_CONTEXT_DESC}
        tip={BATCH_CONTEXT_TIP}
        checked={settings.batchContext}
        onChange={(v) => set('batchContext', v)}
      />
      {settings.batchContext && (
        <div className="mt-3">
          <Label tip={BATCH_CONTEXT_LINES_TIP}>{BATCH_CONTEXT_LINES_LABEL}</Label>
          <Select
            value={String(settings.batchContextLines)}
            onChange={(v) => set('batchContextLines', Number(v))}
            options={BATCH_CONTEXT_LINES_OPTIONS}
            className="w-28"
          />
        </div>
      )}
    </>
  )
}

/**
 * One settings write for a model change (SF-7 trap 2).
 *
 * The stored toggle is shared with Transcribe. Do not persist OFF merely because the *global*
 * model rejects sampling — an override may still accept, and `generationParamArgs` already
 * withholds flags per run model (SOL-69). Persist OFF only when leaving a rejecting model
 * for an accepting one (`shouldPersistSamplingToggleOff`), so the control does not switch
 * itself back on. Main-process refresh uses the same helper (SOL-71).
 *
 * Temperature / top-p refresh only while the user already had the toggle off. A capability
 * hide, or the delayed persist-off on return, must not wipe typed values (SOL-70 / REP-5).
 */
export function settingsPatchOnModelChange(
  settings: Pick<AppSettings, 'customGenerationParams' | 'model'>,
  model: string
): Partial<AppSettings> {
  const patch: Partial<AppSettings> = { model }
  const customOn = settings.customGenerationParams
  if (shouldPersistSamplingToggleOff(settings.model, model, customOn)) {
    patch.customGenerationParams = false
  }
  if (customOn) return patch
  const d = samplingDefaults(model)
  patch.temperature = d.temperature
  patch.topP = d.topP
  return patch
}

function ExternalLink({
  url,
  className,
  title,
  children
}: {
  url: string
  className?: string
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [err, setErr] = useState('')
  return (
    <>
      <button
        type="button"
        className={className}
        title={title}
        onClick={() => {
          void openExternalLink(url).then(setErr)
        }}
      >
        {children}
      </button>
      {err ? <span className="ml-1 text-red-600 dark:text-red-400">{err}</span> : null}
    </>
  )
}

/**
 * Slot descriptors for the configured keys, in the shape `shared/keyOrder` ranks.
 * Indices only — no key material leaves this module.
 */
function keySlotsOf(settings: AppSettings): KeySlot[] {
  return (settings.apiKeys ?? [])
    .map((k, i) => ({ index: i, present: !!(k ?? '').trim() }))
    .filter((s) => s.present)
    .map(({ index }) => ({
      index,
      valid: settings.apiKeyValid?.[index] ?? null,
      tier: settings.apiKeyTiers?.[index] ?? 'free'
    }))
}

/**
 * The highest-ranked key and its tier.
 *
 * Derived from the ranking rather than from slot 0, because a known-invalid first key is skipped
 * and the next key leads. Reading slot 0 here would let Settings report "Free" while runs lead
 * with a Paid key, or the reverse.
 */
function effectivePrimary(settings: AppSettings): { slot: number | null; paid: boolean } {
  const primary = orderKeySlots(keySlotsOf(settings))[0]
  if (primary == null) return { slot: null, paid: false }
  return { slot: primary, paid: (settings.apiKeyTiers?.[primary] ?? 'free') === 'paid' }
}

/**
 * Feature 8 D8-11's ranking copy, adapted to the native-only app at the tester's direction
 * (2026-10-15): there is no CLI to receive key flags any more, so those sentences are gone and the
 * two-key rules that remain (run-start model check, Fetch Models completeness, auto-selection) are
 * named as they work. Nothing here may say a lower-priority key is unused during a run.
 */
const KEYS_TIP =
  "Your Gemini API keys from Google AI Studio, in priority order. Known-invalid keys are skipped. Runs may evaluate every ranked key that supports the selected model; keys in one Quota Group share one budget, and a lower-priority key may be used when it provides the earliest eligible route. Priority labels describe order, not exclusive use. Set each key's Free or Paid tier yourself because Google's API does not report it. A Paid highest-ranked key is a normal Paid route; using Paid as fallback from a Free route requires the separate default-off Allow paid fallback setting. Use the eye icon to reveal a key. Get a key at aistudio.google.com/apikey."

const FETCH_MODELS_TIP =
  "Checks every saved API key separately and retrieves the models each key can use. The Model list combines those results and records per-key availability. Routing skips a key known not to support the selected model and may continue through other ranked keys. The run-start model check, Fetch Models completeness check, and model auto-selection still use the first two ranked keys for Translate and the first for Transcribe. Set tier and Quota Group yourself; Google's API reports neither."

const TIER_SUMMARY_TIP =
  "Tier of the first non-invalid key in the current ranking. A Paid value is the normal Paid-primary route. Routing still checks the selected model on each key before dispatch; set tiers yourself because Google's API does not report them."

function Eye(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOff(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68" />
      <path d="M6.6 6.6A13.5 13.5 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 5.4-1.6" />
      <path d="M3 3l18 18" />
    </svg>
  )
}

function KeyStatus({
  refreshing,
  state,
  error,
  hasKey
}: {
  refreshing: boolean
  state: boolean | null
  error: string
  hasKey: boolean
}): React.JSX.Element {
  let content: React.ReactNode = null
  let title = ''
  if (refreshing && hasKey) {
    content = <span className="text-gray-400">…</span>
    title = 'Checking…'
  } else if (state === true) {
    content = <span className="text-green-600 dark:text-green-400">✓</span>
    title = 'Valid key'
  } else if (state === false) {
    content = <span className="text-red-500 dark:text-red-400">✗</span>
    title = error || 'Invalid key'
  } else if (hasKey && error) {
    // Asked, and learned nothing — offline, out of quota, or an error we do not recognise.
    // A ✗ here is what MAN-4 was: an accusation the evidence did not support.
    content = <span className="text-amber-500 dark:text-amber-400">?</span>
    title = `Could not be checked. ${error}`
  }
  return (
    <span className="flex h-9 w-5 flex-shrink-0 items-center justify-center text-sm font-bold" title={title}>
      {content}
    </span>
  )
}

const NAV = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'languages', label: 'Default Languages' },
  { id: 'api-keys', label: 'Gemini API Keys' },
  { id: 'free-tier', label: 'Free-Tier Protection' },
  { id: 'model', label: 'Model & Generation' },
  { id: 'service', label: 'Service' },
  { id: 'tmdb', label: 'TMDB' },
  { id: 'subtitle-sources', label: 'Subtitle Sources' },
  { id: 'output', label: 'Output' },
  { id: 'logs', label: 'Logs' },
  { id: 'advanced', label: 'Advanced' }
]

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto (match system)' }
]

export default function SettingsPage(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patch)
  const reload = useStore((s) => s.load)
  const [sec, setSec] = useState('languages')
  // Owned here, not in SectionApiKeys: navigating to Model unmounts that section and used
  // to drop the in-flight lock while checkApiKeys was still running (SOL-38).
  const [refreshing, setRefreshing] = useState(false)
  const [modelCount, setModelCount] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const refreshGen = useRef(0)
  const refreshInFlight = useRef(false)

  if (!settings) return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading settings…</div>
  const current = settings

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    void patch({ [key]: value } as Partial<AppSettings>)
  }

  async function refreshKeys(): Promise<void> {
    const keys = current.apiKeys.length ? current.apiKeys : ['']
    if (refreshInFlight.current || !keys.some((k) => k.trim())) return
    const gen = ++refreshGen.current
    refreshInFlight.current = true
    setRefreshing(true)
    setModelCount(null)
    setNotice('')
    try {
      const res = await window.api.checkApiKeys(keys)
      if (gen !== refreshGen.current) return
      // The main process has already persisted validity, the model cache and any model
      // change the Step 4a rules made. Re-read rather than writing the same values back:
      // a second write here would race the rules and could resurrect the old selection.
      await reload()
      if (gen !== refreshGen.current) return
      // Report a count only for a refresh that was actually persisted. An incomplete
      // refresh keeps the previous list, so quoting the number it happened to return
      // would claim a fetch succeeded when the picker did not change. A DISCARDED result
      // is the same situation arrived at differently: the fetch may have been complete,
      // but it described keys that are no longer the ones on screen.
      const persisted =
        !res.discarded &&
        (res.refreshOutcome === 'allComplete' || res.refreshOutcome === 'activeComplete')
      setModelCount(persisted ? res.models.length : null)
      setNotice(res.notice)
    } finally {
      if (gen === refreshGen.current) {
        refreshInFlight.current = false
        setRefreshing(false)
      }
    }
  }

  return (
    <div className="flex gap-6">
      <nav className="w-52 flex-shrink-0">
        <h1 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
        <ul className="space-y-0.5">
          {NAV.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => setSec(n.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  sec === n.id
                    ? 'bg-gray-100 font-semibold text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                    : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                {n.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 flex-1 pt-1">
        {sec === 'appearance' && <SectionAppearance settings={settings} set={set} />}
        {sec === 'languages' && <SectionLanguages settings={settings} set={set} />}
        {sec === 'api-keys' && (
          <SectionApiKeys
            settings={settings}
            set={set}
            refreshing={refreshing}
            modelCount={modelCount}
            notice={notice}
            onRefresh={refreshKeys}
            onCountReset={() => setModelCount(null)}
          />
        )}
        {sec === 'free-tier' && <SectionFreeTier settings={settings} set={set} />}
        {sec === 'model' && <SectionModel settings={settings} set={set} patch={patch} />}
        {sec === 'service' && <SectionService settings={settings} set={set} />}
        {sec === 'tmdb' && <SectionTmdb settings={settings} set={set} />}
        {sec === 'subtitle-sources' && <SectionSubtitleSources settings={settings} set={set} />}
        {sec === 'output' && <SectionOutput settings={settings} set={set} />}
        {sec === 'logs' && <SectionLogs settings={settings} set={set} />}
        {sec === 'advanced' && <SectionAdvanced settings={settings} set={set} patch={patch} />}
      </div>
    </div>
  )
}

export interface SectionProps {
  settings: AppSettings
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-5 text-lg font-bold text-gray-900 dark:text-gray-100">{children}</div>
}

function SectionAppearance({ settings, set }: SectionProps): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Appearance</SectionTitle>
      <div>
        <Label tip="Choose the app's colour theme. Light and Dark force that theme; Auto follows your operating system's appearance setting and switches automatically when the OS does.">
          Theme
        </Label>
        <Select
          value={settings.theme}
          onChange={(v) => set('theme', v)}
          options={THEME_OPTIONS}
          className="w-72"
        />
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          Applies instantly across the whole app.
        </p>
      </div>
    </div>
  )
}

function SectionLanguages({ settings, set }: SectionProps): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Default Languages</SectionTitle>
      <div>
        <Label tip="The default source language pre-filled on the Translate and Transcribe pages when the app starts. 'Auto Detect' works reliably for most common languages and is the recommended default.">
          Default Source Language
        </Label>
        <Select
          value={settings.sourceLang}
          onChange={(v) => set('sourceLang', v)}
          options={SOURCE_LANGUAGES}
          className="w-72"
        />
      </div>
      <div>
        <Label tip="The default target language pre-filled on the Translate page. Leave empty to force yourself to choose each time. Whatever you set here loads automatically on startup.">
          Default Target Language
        </Label>
        <Select
          value={settings.targetLang || ''}
          onChange={(v) => set('targetLang', v)}
          options={[{ value: '', label: '— none —' }, ...TARGET_LANGUAGES]}
          className="w-72"
        />
      </div>
    </div>
  )
}

const ROLE_LABEL: Record<KeyRole, string> = {
  primary: 'Priority 1',
  fallback: 'Priority 2',
  reserve: 'Priority 3+'
}

function RoleBadge({ role }: { role: KeyRole | undefined }): React.JSX.Element | null {
  if (!role) return null
  const tone =
    role === 'primary'
      ? 'bg-brand/10 text-brand'
      : role === 'fallback'
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
        : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
  return (
    <span
      className={`w-24 flex-shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-semibold ${tone}`}
      title={
        role === 'reserve'
          ? 'Lower-priority key. Runs may use it when it supports the selected model and provides an eligible route.'
          : role === 'fallback'
            ? 'Second key in the current validity-and-order ranking. Runs may use it when it is eligible.'
            : 'First key in the current validity-and-order ranking. Runs evaluate it first when it supports the selected model.'
      }
    >
      {ROLE_LABEL[role]}
    </span>
  )
}

interface SectionApiKeysProps extends SectionProps {
  refreshing: boolean
  modelCount: number | null
  notice: string
  onRefresh: () => Promise<void>
  onCountReset: () => void
}

function SectionApiKeys({
  settings,
  set,
  refreshing,
  modelCount,
  notice,
  onRefresh,
  onCountReset
}: SectionApiKeysProps): React.JSX.Element {
  const updatedAt = useStore((s) => s.modelsUpdatedAt)
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})
  // Which slots could not be checked is no longer local state: it is read from the same
  // persisted verdict the ✗/? marks use, so the summary cannot disagree with the marks — which
  // is precisely how MAN-4's two contradictory sentences came to be shown side by side.
  const keys = settings.apiKeys.length ? settings.apiKeys : ['']
  const tiers = keys.map((_, i) => settings.apiKeyTiers?.[i] ?? 'free')
  const valids = keys.map((_, i) => settings.apiKeyValid?.[i] ?? null)
  const errs = keys.map((_, i) => settings.apiKeyError?.[i] ?? '')

  // Same ranking the main process routes runs by, so the labels below cannot
  // disagree with what a run actually does. Operates on slot indices only — no key
  // material leaves this component.
  const slots: KeySlot[] = keySlotsOf(settings)
  const roles = keyRoles(slots)
  // Every ranked key a run may route through (D8-11), not the two-key active set.
  const ranked = orderKeySlots(slots)
  const groupView = quotaGroupRuntimeView(settings)
  const mutateGroups = useStore((s) => s.mutateQuotaGroup)

  function toggleReveal(i: number): void {
    setRevealed((r) => ({ ...r, [i]: !r[i] }))
  }

  function updateKey(i: number, val: string): void {
    if (keys[i] === val) return
    const next = [...keys]
    next[i] = val
    set('apiKeys', next)
    // Editing a key invalidates only that key's previously checked status.
    const nv = [...valids]
    nv[i] = null
    set('apiKeyValid', nv)
    const ne = [...errs]
    ne[i] = ''
    set('apiKeyError', ne)
    // ...and everything slot i previously proved about model availability, because that
    // evidence came from a different key. Left alone, the pre-spawn guard would keep
    // treating it as positive proof for a key it has never seen.
    set('cachedModels', forgetSlotEvidence(settings.cachedModels ?? [], i))
    onCountReset()
  }
  function setTier(i: number, val: string): void {
    const next = [...tiers]
    next[i] = val
    set('apiKeyTiers', next)
  }
  function addKey(): void {
    if (keys.length >= 5) return
    set('apiKeys', [...keys, ''])
    set('apiKeyTiers', [...tiers, 'free'])
    set('apiKeyValid', [...valids, null])
    set('apiKeyError', [...errs, ''])
  }
  function removeKey(i: number): void {
    const drop = <T,>(arr: T[], fallback: T): T[] => {
      const r = arr.filter((_, idx) => idx !== i)
      return r.length ? r : [fallback]
    }
    set('apiKeys', drop(keys, ''))
    set('apiKeyTiers', drop(tiers, 'free'))
    set('apiKeyValid', drop(valids, null))
    set('apiKeyError', drop(errs, ''))
    // Removing a slot renumbers every slot above it, so stored availability evidence has
    // to follow the keys it came from or it starts describing the wrong ones.
    set('cachedModels', reindexEvidenceAfterRemoval(settings.cachedModels ?? [], i))
    setRevealed((r) => {
      const next: Record<number, boolean> = {}
      for (const key of Object.keys(r)) {
        const idx = Number(key)
        if (idx === i || !r[idx]) continue
        next[idx > i ? idx - 1 : idx] = true
      }
      return next
    })
  }

  // Counting moved into `src/lib/keyStatus.ts`, where it can be gated: every one of MAN-4's
  // three faults was a sentence, and a sentence is exactly what a type checker cannot judge.
  // `false` now means the API refused the key; `null` means we did not find out.
  const states = keys.map((k, i) => keyStateOf(!!k.trim(), valids[i]))
  const counts = countKeyStates(states)
  const headline = keyHeadline(counts, modelCount)
  const uncheckedSlots = states
    .map((s, i) => (s === 'unchecked' && errs[i] ? i : -1))
    .filter((i) => i >= 0)
  // `notice` is part of this: it is the only place a discarded check can announce itself, and
  // that message must not be invisible to the one user guaranteed to need it — someone whose
  // keys have no verdict yet, which is exactly when nothing else here has anything to say.
  const reportedAny = counts.valid > 0 || counts.rejected > 0 || uncheckedSlots.length > 0 || !!notice
  // Read from the ranking, not from slot 0: an invalid first key is skipped at spawn time
  // and the promoted key's tier is what decides `--paid-quota`.
  const { slot: primarySlot, paid: primaryPaid } = effectivePrimary(settings)
  const tierLabel = primaryPaid ? 'Paid' : 'Free'

  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Gemini API Keys</SectionTitle>
      <div>
        <Label tip={KEYS_TIP}>API Keys (up to 5)</Label>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
          Keys are ranked by the last check (valid first, unchecked next, invalid skipped) and then
          by their order here. Runs may use any ranked key that supports the selected model. Keys in
          one Quota Group share one budget, and a lower-priority key may be used when it provides the
          earliest eligible route. Priority labels describe order, not a promise that only those keys
          run.
        </p>
        <div className="space-y-2">
          {keys.map((k, i) => (
            <div key={i}>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <TextInput
                  type={revealed[i] ? 'text' : 'password'}
                  value={k}
                  placeholder={`API key ${i + 1}`}
                  onChange={(e) => updateKey(i, e.target.value)}
                  // Locked for the length of the check, because everything the check produces
                  // is addressed by slot number and none of it carries the key it came from:
                  // change a key mid-flight and its predecessor's verdict, error and model
                  // evidence land on the new one. The main process discards such a result as
                  // well; this is what stops the user losing a minute's checking to it.
                  disabled={refreshing}
                  title={refreshing ? 'Locked while your keys are being checked.' : undefined}
                  className="w-full pr-9"
                />
                <button
                  type="button"
                  onClick={() => toggleReveal(i)}
                  title={revealed[i] ? 'Hide key' : 'Show key'}
                  className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-600 dark:hover:text-gray-200"
                >
                  {revealed[i] ? <EyeOff /> : <Eye />}
                </button>
              </div>
              <KeyStatus refreshing={refreshing} state={valids[i]} error={errs[i]} hasKey={!!keys[i].trim()} />
              <RoleBadge role={roles.get(i)} />
              <Select
                value={tiers[i]}
                onChange={(v) => setTier(i, v)}
                options={[
                  { value: 'free', label: 'Free' },
                  { value: 'paid', label: 'Paid' }
                ]}
                className="w-24"
              />
              {keys.length > 1 && (
                <button
                  onClick={() => removeKey(i)}
                  // Removing is the sharpest edge of the same race: it renumbers every slot
                  // above it, so an in-flight result would land wholesale on the wrong keys.
                  disabled={refreshing}
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
                  title={refreshing ? 'Locked while your keys are being checked.' : 'Remove key'}
                >
                  ✕
                </button>
              )}
            </div>
            {/*
              Advanced, and only where it means something: a Free key, once a second Quota Group
              exists. A Paid key keeps its stored group for a later change back to Free. Not locked
              during a check — like the tier, it neither replaces nor renumbers a slot.
            */}
            {tiers[i] !== 'paid' && groupView.groups.length > 1 && (
              <div className="mt-1 flex items-center gap-2 pl-1 text-xs text-gray-500 dark:text-gray-400">
                <span>Quota Group</span>
                <Select
                  value={groupView.resolvedKeyGroupIds[i] ?? DEFAULT_QUOTA_GROUP_ID}
                  onChange={(v) => void mutateGroups({ type: 'assignKey', keySlot: i, groupId: v })}
                  options={groupView.groups.map((g) => ({ value: g.id, label: g.displayLabel }))}
                  className="w-48"
                />
              </div>
            )}
            </div>
          ))}
        </div>
        {keys.length < 5 && (
          <button
            onClick={addKey}
            disabled={refreshing}
            className="mt-2 text-sm font-medium text-brand hover:underline disabled:opacity-40 disabled:hover:no-underline"
            title={refreshing ? 'Locked while your keys are being checked.' : undefined}
          >
            + Add another key
          </button>
        )}
      </div>

      <Divider />

      <div>
        <Label tip={FETCH_MODELS_TIP}>
          Fetch Models &amp; Check API Keys
        </Label>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => void onRefresh()} disabled={refreshing || !keys.some((k) => k.trim())}>
            {refreshing ? 'Checking…' : 'Fetch Models & Check API Keys'}
          </Button>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              primaryPaid
                ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
            }`}
            title={TIER_SUMMARY_TIP}
          >
            {primarySlot == null
              ? 'Highest-ranked key tier: —'
              : `Highest-ranked key tier (Key ${primarySlot + 1}): ${tierLabel}`}
          </span>
          <ExternalLink
            url={RATE_LIMITS_URL}
            className="text-xs font-medium text-brand hover:underline"
            title="Google's live rate-limit table — the authoritative source. Any figure shown in this app is a rounded approximation and can go out of date."
          >
            View current rate limits ↗
          </ExternalLink>
          {updatedAt && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Last updated: {new Date(updatedAt).toLocaleString()}
            </span>
          )}
        </div>

        {reportedAny && (
          <div className="mt-2 space-y-0.5 text-xs">
            <p
              className={
                headline.tone === 'good'
                  ? 'font-medium text-green-700 dark:text-green-400'
                  : headline.tone === 'bad'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-amber-600 dark:text-amber-400'
              }
            >
              {headline.text}
            </p>
            {counts.rejected > 0 && (
              <p className="text-amber-600 dark:text-amber-400">
                {counts.rejected} key{counts.rejected > 1 ? 's' : ''} rejected by the API
                (marked ✗ — hover for details).
              </p>
            )}
            {valids[0] === false && counts.valid > 0 && (
              <p className="text-brand">
                Your first key is invalid — translations will automatically use your first valid
                key instead.
              </p>
            )}
            {uncheckedSlots.length > 0 && (
              <p className="text-amber-600 dark:text-amber-400">
                {uncheckedNote(uncheckedSlots, ranked)}
              </p>
            )}
            {notice && <p className="text-brand">{notice}</p>}
            {ranked.length > 0 && (
              <p className="text-gray-500 dark:text-gray-400">
                {ranked.length === 1
                  ? `Runs will use key ${ranked[0] + 1}.`
                  : `Runs may use keys ${ranked.slice(0, -1).map((i) => i + 1).join(', ')} and ${ranked[ranked.length - 1] + 1}, in this order.`}
              </p>
            )}
          </div>
        )}

        {!keys.some((k) => k.trim()) && (
          <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">Enter an API key above to enable this.</p>
        )}
      </div>
    </div>
  )
}

// ─── Free-Tier Protection (Bundle F, implementation_plan.md §12.9) ─────────────────────────────

const PROTECTION_TIP =
  "Paces requests sent with Free keys so a run waits instead of being refused by Google. The app keeps a private record of the requests it sends (never their content) and, before each one, checks the limits it knows for that key's Quota Group and model: requests per minute (RPM), input tokens per minute (TPM) and requests per day (RPD). It only knows about requests this app sent while this was on — AI Studio, other apps and other computers are invisible to it — so it cannot promise that Google will have capacity left. Paid keys are never paced. Turning this off sends without waiting; a refusal from Google is still handled and still steers the run away from that group for as long as Google says."
const MANUAL_TIP =
  'Use the limits shown for your project in AI Studio (aistudio.google.com/usage → Rate limits). Limits differ by model and by project, so they are entered per Quota Group and per model. A blank field means unknown. While this is on, a value you enter beats anything the app learned from Google; turning it off keeps every value but stops using them. Automatic Free-Tier Protection must be on for these values to pace anything.'
const RESERVE_TIP =
  'Headroom left unused on the values you entered, for requests the app cannot see (AI Studio, other apps). The usable figure is the entered value less this percentage, rounded down. 0 uses the full value. It applies only to manual values, never to limits learned from Google.'
const PAID_FALLBACK_TIP =
  'Lets a run continue on a Paid key when the Free keys cannot go on: after Google refuses a Free key for quota or rate limits, when every Free Quota Group has used up today\u2019s requests, or when Google says the model is overloaded on a Free key. On an overload the request goes to the Paid key at once instead of pausing 60 seconds, and the next request tries the Free key again first. A short wait for a per-minute limit is still waited out on the Free key, so pacing alone never moves a run to Paid. Paid requests can cost money, so this stays off until you turn it on, and the run says so before its first Paid request. A Paid key ranked first is always a normal Paid run and does not need this.'
const GROUPS_TIP =
  "A Quota Group is a set of keys that share one budget. Google counts Free-tier limits per Google Cloud project, not per key, so keys made in the same project belong in the same group: switching between them gives no extra requests. Put a key from a different project in its own group and the run may use it while another group waits. Google's API does not report a key's project, so you set this yourself. Group A always exists."
const LEARNED_TIP =
  "Limits Google stated when it refused a request, with the date it said so. Read-only; the app uses them when no manual value applies. Clearing them removes only these rows for that group and model — never your manual values or the app's record of requests sent."
const METRIC_LABEL: Record<'rpm' | 'tpm' | 'rpd', { short: string; tip: string }> = {
  rpm: { short: 'RPM', tip: 'Requests per minute: how many requests this group may send to this model in any 60 seconds. Copied from AI Studio.' },
  tpm: { short: 'Input TPM', tip: 'Input tokens per minute: how much text and audio this group may send to this model in any 60 seconds. Copied from AI Studio.' },
  rpd: { short: 'RPD', tip: "Requests per day: how many requests this group may send to this model before Google's daily reset (midnight Pacific time). Copied from AI Studio." }
}

/** The models the manual editor shows: the Settings model and, only when it differs, the effective Transcribe model. */
function currentQuotaModels(settings: AppSettings): string[] {
  const translate = (settings.model || '').trim()
  const transcribe = resolveTranscribeSettings(settings).model.trim()
  return [translate, transcribe].filter((m, i, all) => m && all.indexOf(m) === i)
}

function SectionFreeTier({ settings, set }: SectionProps): React.JSX.Element {
  const mutate = useStore((s) => s.mutateQuotaGroup)
  const [message, setMessage] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [renaming, setRenaming] = useState<Record<string, string>>({})
  const view = quotaGroupRuntimeView(settings)
  const protection = settings.automaticFreeTierProtection !== false
  const manual = protection && settings.manualQuotaLimitsEnabled === true
  const reserve = validReservePercent(settings.manualQuotaReservePercent) ? settings.manualQuotaReservePercent : 10
  const models = currentQuotaModels(settings)
  const learned = Array.isArray(settings.learnedQuotaEvidence) ? settings.learnedQuotaEvidence : []

  async function run(m: QuotaGroupMutation): Promise<boolean> {
    const r = await mutate(m)
    setMessage(r.ok ? '' : r.message)
    return r.ok
  }

  function setReserve(v: number | null): void {
    if (v === null || !validReservePercent(v)) return
    const blocked = view.groups.some((g) =>
      Object.values(g.manualByModel ?? {}).some((vals) => (['rpm', 'tpm', 'rpd'] as const).some((k) => vals?.[k] !== undefined && usableManualCapacity(vals[k] as number, v) === null))
    )
    if (blocked) {
      setMessage(`A ${v}% reserve would leave less than 1 on a value you entered. Raise that value or use a smaller reserve.`)
      return
    }
    setMessage('')
    set('manualQuotaReservePercent', v)
  }

  function setLimit(groupId: string, model: string, metric: 'rpm' | 'tpm' | 'rpd', v: number | null): void {
    const before = view.groups.find((g) => g.id === groupId)?.manualByModel?.[model] ?? {}
    const values: ManualQuotaValues = { ...before }
    if (v === null) delete values[metric]
    else values[metric] = v
    void run({ type: 'setManualLimits', groupId, model, values })
  }

  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Free-Tier Protection</SectionTitle>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Client-local protection for Free keys: the app paces the requests it sends itself, recorded while this is on. It
        cannot see requests from AI Studio or other apps, or ones sent while it was off, so it does not promise that
        Google has capacity left.
      </p>
      <ToggleRow
        label="Automatic Free-Tier Protection"
        desc="Wait before a Free-key request would go over a known limit."
        tip={PROTECTION_TIP}
        checked={protection}
        onChange={(v) => set('automaticFreeTierProtection', v)}
      />
      <ToggleRow
        label="Allow paid fallback"
        desc="Off by default. Continues on a Paid key when Google refuses the Free keys, they have used today’s requests, or the model is overloaded on them. Paid requests can cost money."
        tip={PAID_FALLBACK_TIP}
        checked={settings.allowPaidFallback === true}
        onChange={(v) => set('allowPaidFallback', v)}
      />
      <ToggleRow
        label="Use manual AI Studio limits"
        desc={protection ? 'Pace Free keys with limits you copy from AI Studio.' : 'Turn on Automatic Free-Tier Protection to use manual limits.'}
        tip={MANUAL_TIP}
        checked={settings.manualQuotaLimitsEnabled === true}
        disabled={!protection}
        onChange={(v) => set('manualQuotaLimitsEnabled', v)}
      />

      {manual && (
        <div>
          <Label tip={RESERVE_TIP}>Safety reserve (%)</Label>
          <NumberInput value={reserve} onChange={setReserve} min={0} max={99} step={1} className="w-24" />
        </div>
      )}

      <Divider />

      <div>
        <Label tip={GROUPS_TIP}>Quota Groups</Label>
        <div className="space-y-2">
          {view.groups.map((g) => {
            const assigned = view.resolvedKeyGroupIds.map((id, slot) => (id === g.id ? slot + 1 : 0)).filter((n) => n > 0)
            const draft = renaming[g.id]
            return (
              <div key={g.id} className="rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700">
                <div className="flex flex-wrap items-center gap-2">
                  {draft === undefined ? (
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{g.displayLabel}</span>
                  ) : (
                    <TextInput value={draft} onChange={(e) => setRenaming((r) => ({ ...r, [g.id]: e.target.value }))} className="w-48" />
                  )}
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {assigned.length ? `Key${assigned.length > 1 ? 's' : ''} ${assigned.join(', ')}` : 'No keys'}
                  </span>
                  {g.repairRequired && <span className="text-xs text-amber-600 dark:text-amber-400">Needs a unique name</span>}
                  <span className="ml-auto flex gap-2">
                    {draft === undefined ? (
                      <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => setRenaming((r) => ({ ...r, [g.id]: g.label }))}>
                        Rename
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="text-xs font-medium text-brand hover:underline"
                          onClick={() =>
                            void run({ type: 'rename', groupId: g.id, label: draft }).then((ok) => {
                              if (ok) setRenaming(({ [g.id]: _done, ...rest }) => rest)
                            })
                          }
                        >
                          Save
                        </button>
                        <button type="button" className="text-xs text-gray-500 hover:underline" onClick={() => setRenaming(({ [g.id]: _drop, ...rest }) => rest)}>
                          Cancel
                        </button>
                      </>
                    )}
                    {g.id !== DEFAULT_QUOTA_GROUP_ID && assigned.length === 0 && (
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline dark:text-red-400"
                        onClick={() => {
                          if (window.confirm(`Delete the Quota Group \u201c${g.displayLabel}\u201d? Its manual limits and learned limits are removed with it.`)) {
                            void run({ type: 'delete', groupId: g.id })
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                </div>

                {models.map((model) => {
                    const saved = g.manualByModel?.[model] ?? {}
                    const rows = learned.filter((r) => r.groupId === g.id && r.model === model)
                    if (!manual && rows.length === 0) return null
                    return (
                      <div key={model} className="mt-2 border-t border-gray-100 pt-2 dark:border-gray-700">
                        <div className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">{model}</div>
                        {manual && (
                          <div className="flex flex-wrap gap-3">
                            {(['rpm', 'tpm', 'rpd'] as const).map((metric) => {
                              const v = saved[metric]
                              const usable = v !== undefined ? usableManualCapacity(v, reserve) : null
                              return (
                                <div key={metric}>
                                  <Label tip={METRIC_LABEL[metric].tip}>{METRIC_LABEL[metric].short}</Label>
                                  <NumberInput
                                    value={v ?? null}
                                    allowEmpty
                                    placeholder="Unknown"
                                    onChange={(n) => setLimit(g.id, model, metric, n)}
                                    min={1}
                                    max={1_000_000_000}
                                    step={1}
                                    className="w-28"
                                  />
                                  <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                                    {usable !== null ? `Uses ${usable.toLocaleString()}` : 'Unknown'}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                        {rows.length > 0 && (
                          <div className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                            <span className="inline-flex items-center font-medium">
                              Learned from Google
                              <Tooltip tip={LEARNED_TIP} />
                            </span>
                            <ul>
                              {rows.map((r, i) => (
                                <li key={i}>
                                  {r.metric === 'rpm' || r.metric === 'tpm' || r.metric === 'rpd' ? METRIC_LABEL[r.metric].short : 'Other limit'}
                                  {r.limit !== undefined ? `: ${r.limit.toLocaleString()}` : ''} · {new Date(r.observedAt).toLocaleString()}
                                </li>
                              ))}
                            </ul>
                            <button
                              type="button"
                              className="mt-0.5 text-brand hover:underline"
                              onClick={() => {
                                if (window.confirm(`Clear learned evidence for ${g.displayLabel} / ${model}? Manual values and the request record are kept.`)) {
                                  void run({ type: 'clearLearned', groupId: g.id, model })
                                }
                              }}
                            >
                              Clear learned evidence for {g.displayLabel} / {model}
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
              </div>
            )
          })}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <TextInput value={newLabel} placeholder="New group name" onChange={(e) => setNewLabel(e.target.value)} className="w-48" />
          <Button
            variant="secondary"
            disabled={!newLabel.trim()}
            onClick={() =>
              void run({ type: 'create', label: newLabel }).then((ok) => {
                if (ok) setNewLabel('')
              })
            }
          >
            Add group
          </Button>
        </div>
        {message && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{message}</p>}
      </div>
    </div>
  )
}

function SectionModel({
  settings,
  set,
  patch
}: SectionProps & { patch: (p: Partial<AppSettings>) => Promise<void> }): React.JSX.Element {
  // Trap 3: this is the GLOBAL model. A transcribe override that rejects sampling while
  // Settings' model still accepts it leaves the toggle live; generationParamArgs withholds
  // the flags on the run. Do not widen SF-7 to chase that.
  const caps = modelCapabilities(settings.model)
  const noThinkingReason = dedicatedThinkingReason(settings.model)
  const cached = settings.cachedModels
  const verifiedAny = cached.some((m) => m.source === 'live')
  const selected = cached.find((m) => m.id === settings.model)

  // The active set is the pair the run-start model check uses, so "available on every
  // active key" is the honest bar for an unqualified entry.
  const activeSlots = activeKeySlots(
    settings.apiKeys
      .map((k, i) => ({
        index: i,
        valid: settings.apiKeyValid?.[i] ?? null,
        tier: settings.apiKeyTiers?.[i] ?? 'free',
        present: !!k.trim()
      }))
      .filter((s) => s.present)
      .map(({ index, valid, tier }) => ({ index, valid, tier }))
  )
  const availableOnAllActive = (m: ModelInfo): boolean =>
    m.source === 'live' && activeSlots.every((slot) => m.availableOn.includes(slot))

  const models = cached.map((m) => ({
    value: m.id,
    label:
      m.source !== 'live'
        ? `${m.label} (unverified)`
        : availableOnAllActive(m)
          ? m.label
          : `${m.label} (some keys only)`
  }))
  // The stored id may not be in the list yet (never fetched, or fetched on another
  // profile). A Select whose value is absent from its options renders BLANK, which reads
  // as "no model selected" — so keep it visible as an explicit entry.
  if (settings.model && !cached.some((m) => m.id === settings.model)) {
    models.unshift({ value: settings.model, label: `${settings.model} (not in fetched list)` })
  }

  const defaults = samplingDefaults(settings.model)
  // Two independent reasons the fields can be inert, and they are not interchangeable: the
  // toggle is the user's choice, while the capability is Google's. The second one wins, and
  // says so in words — a greyed-out field with no explanation reads as a fault.
  const samplingLive = settings.customGenerationParams && caps.acceptsSamplingParams

  function handleModel(v: string): void {
    void patch(settingsPatchOnModelChange(settings, v))
  }

  return (
    <div className="space-y-5">
      <SectionTitle>Model &amp; Generation</SectionTitle>

      <div>
        <Label tip="The Gemini model used for translation and transcription. The list comes from your own API keys, so newly released models appear automatically once you press 'Fetch Models & Check API Keys'. Guidance: a flash-lite model is fastest and cheapest and is what the app defaults to (it moves to the newest flash-lite by itself); flash trades speed for quality; pro is the most capable and by far the slowest and most expensive. Preview models are offered but never selected automatically.">
          Model
        </Label>
        <Select value={settings.model} onChange={handleModel} options={models} className="w-80" />
        <div className="mt-1.5 space-y-1 text-xs">
          <p className="text-gray-500 dark:text-gray-400">
            Cost varies enormously by tier — a pro model can cost more than ten times a
            flash-lite one for the same file, and a newer model is not automatically
            cheaper.{' '}
            <ExternalLink url={PRICING_URL} className="font-medium text-brand hover:underline">
              Current pricing ↗
            </ExternalLink>
          </p>
          {!verifiedAny && (
            <p className="text-amber-600 dark:text-amber-400">
              These models have not been verified against your API key yet — open Gemini API
              Keys and press “Fetch Models &amp; Check API Keys”.
            </p>
          )}
          {settings.modelNeedsVerification && (
            <p className="text-amber-600 dark:text-amber-400">
              Your saved model has not been confirmed against your key yet. It has been kept
              as-is; fetch models to verify it.
            </p>
          )}
          {verifiedAny && selected && !availableOnAllActive(selected) && (
            <p className="text-amber-600 dark:text-amber-400">
              This model was not reported by every key a run may use. If the engine switches
              to the fallback key mid-run, it may fail.
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 items-start gap-x-10 gap-y-5">
        <div>
          <Label tip="Number of subtitle lines sent to Gemini in a single API request. Default: 100. Lower values give the model less context per request — translation may feel choppy across scenes. Higher values give more context and consistency but use more tokens. Only lower this if you hit token limit errors.">
            Batch Size
          </Label>
          <NumberInput
            value={settings.batchSize}
            min={1}
            max={1000}
            onChange={(v) => set('batchSize', v ?? 100)}
            className="w-28"
          />
        </div>
        <div>
          <BatchContextControls settings={settings} set={set} />
        </div>
      </div>

      <Divider />

      <div className="grid grid-cols-2 items-start gap-x-10 gap-y-5">
        {/* Left: thinking */}
        <div className="space-y-5">
          <div>
            <Label tip="Gemini 3.x only. How much internal reasoning the model does before output. Default sends no thinking-level flag, so the model uses Google's own default for that id (not the same level on every model). Minimal is the lowest discrete setting and is not accepted by every model — unsupported values are omitted from the list. Thinking cannot be switched off on 3.x. For 2.5 models use Thinking Budget instead.">
              Thinking Level
            </Label>
            {caps.thinking === 'level' ? (
              <>
                <Select
                  value={settings.thinkingLevel}
                  onChange={(v) => set('thinkingLevel', v)}
                  options={thinkingLevelsForModel(caps.acceptedThinkingLevels, settings.thinkingLevel)}
                  className="w-52"
                />
                {effectiveThinkingLevel(settings.model, settings.thinkingLevel) !==
                  settings.thinkingLevel && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    This model does not support “{settings.thinkingLevel}” — it will run at “
                    {effectiveThinkingLevel(settings.model, settings.thinkingLevel)}”.
                  </p>
                )}
              </>
            ) : (
              <>
                <Select value="" onChange={() => {}} disabled options={[{ value: '', label: noThinkingReason ? 'Not used by this model' : '3.x models only' }]} className="w-52" />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{noThinkingReason ?? 'Select a Gemini 3.x model to enable.'}</p>
              </>
            )}
          </div>
          <div>
            <Label tip="Gemini 2.5 only. Maximum tokens the model may use for internal reasoning. Default shown: 512. Gemini 2.5 Pro cannot disable thinking: its range is 128 – 32,768. Non-Pro 2.5 starts at 1, not 0 — Google documents 0 as a disable, but the engine silently discards a zero budget, so this app will not offer it. To send no thinking parameter at all, pick a Gemini 3.x model and set Thinking Level to Default. For 3.x models use Thinking Level instead.">
              Thinking Budget
            </Label>
            {caps.thinking === 'budget' ? (
              <>
                <NumberInput
                  value={settings.thinkingBudget}
                  min={caps.thinkingBudgetMin}
                  max={caps.thinkingBudgetMax}
                  onChange={(v) => set('thinkingBudget', v ?? 512)}
                  className="w-28"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Range for this model: {caps.thinkingBudgetMin} – {caps.thinkingBudgetMax.toLocaleString()}
                  {caps.thinkingBudgetMin >= 128
                    ? ' (cannot be disabled).'
                    : '. 0 cannot be delivered — the engine discards it. On 3.x, Thinking Level → Default sends nothing.'}
                </p>
              </>
            ) : (
              <>
                <TextInput disabled value="—" className="w-28" />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{noThinkingReason ?? 'Select a Gemini 2.5 model to enable.'}</p>
              </>
            )}
          </div>
        </div>

        {/* Right: sampling */}
        <div className="space-y-5">
          <ToggleRow
            label="Custom Generation Parameters"
            desc={samplingToggleDesc(settings.model)}
            checked={samplingToggleChecked(settings.customGenerationParams, settings.model)}
            onChange={(v) => set('customGenerationParams', v)}
            disabled={!caps.acceptsSamplingParams}
            tip={
              'OFF (default, recommended): temperature, top-p and top-k are not sent at all, so each model uses the values Google tuned for it. This is what you want unless you have a specific reason.\n\n' +
              'ON: the three values below are sent with every request. They apply to ALL models, including ones released after these defaults were chosen — a value that suits one generation can degrade another.\n\n' +
              'Not every model accepts them. Google deprecated all three from Gemini 3.6 Flash and Gemini 3.5 Flash-Lite onwards, and newer models reject a request that carries them, so for those models they are never sent and the fields are greyed out no matter how this is set.\n\n' +
              'Note: a value of exactly 0 cannot be sent (the engine treats it as "not set"), which is why the minimums below are above zero.'
            }
          />
          <div className={samplingLive ? '' : 'pointer-events-none opacity-50'}>
            <div className="space-y-5">
              <div>
                <Label tip="Controls randomness (creativity). Lower = more literal. Higher = more natural-sounding. Range: 0.05 – 2.0. Lower it if translations feel too creative; raise it if too robotic. Exactly 0 cannot be sent — the engine would ignore it and silently use the model default.">
                  Temperature
                </Label>
                <NumberInput
                  value={settings.temperature}
                  min={0.05}
                  max={2}
                  step={0.05}
                  disabled={!samplingLive}
                  onChange={(v) => set('temperature', v ?? defaults.temperature)}
                  className="w-28"
                />
              </div>
              <div>
                <Label tip="Nucleus sampling — limits token candidates to the top P% by probability. Range: 0.05 – 1.0. Works with Temperature. Exactly 0 cannot be sent — the engine would ignore it and silently use the model default.">
                  Top-P
                </Label>
                <NumberInput
                  value={settings.topP}
                  min={0.05}
                  max={1}
                  step={0.05}
                  disabled={!samplingLive}
                  onChange={(v) => set('topP', v ?? defaults.topP)}
                  className="w-28"
                />
              </div>
              <div>
                <Label tip="Limits candidate tokens considered at each step. Range: 1 – 100. Leave empty to use the model's built-in default. Rarely needs changing for subtitle translation.">
                  Top-K
                </Label>
                <NumberInput
                  value={settings.topK}
                  min={1}
                  max={100}
                  allowEmpty
                  disabled={!samplingLive}
                  onChange={(v) => set('topK', v)}
                  placeholder="— model default —"
                  className="w-40"
                />
              </div>
              {/*
                What the model change used to do by force. Temperature and Top-P are no longer
                overwritten while the toggle is on, so this is how the per-generation values
                stay reachable — deliberately, and without discarding anything.
              */}
              <div>
                <Button
                  variant="secondary"
                  disabled={!samplingLive}
                  onClick={() => {
                    set('temperature', defaults.temperature)
                    set('topP', defaults.topP)
                  }}
                >
                  Reset to this model’s defaults ({defaults.temperature} / {defaults.topP})
                </Button>
                {/* Only once the user has taken control — advice, not an obstacle. */}
                {samplingLive && caps.thinking === 'level' && (
                  <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                    Gemini 3.x models are tuned to run at their own defaults, which are these
                    numbers — so overriding them mostly restates what the model would do anyway.
                    Lowering the temperature on a 3.x model is known to degrade output and can
                    make it loop.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionService({ settings, set }: SectionProps): React.JSX.Element {
  const modelLabel =
    settings.cachedModels.find((m) => m.id === settings.model)?.label ?? settings.model
  const { slot: primarySlot, paid } = effectivePrimary(settings)
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Service</SectionTitle>
      <div>
        <Label tip="The Google AI Studio request tier. Standard (default): available to all accounts, best for regular use. Flex: lower-priority queue, cheaper for large batches — may be slower at peak times. Priority: highest-priority, minimal latency — requires a paid plan. Standard works well for most subtitle jobs.">
          Service Tier
        </Label>
        <Select value={settings.serviceTier} onChange={(v) => set('serviceTier', v)} options={SERVICE_TIERS} className="w-52" />
      </div>
      <div>
        <Label tip={paidQuotaTooltip(settings.model, modelLabel)}>Paid Quota</Label>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              paid
                ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
            }`}
          >
            {paid ? 'ON — free-tier rate limiting disabled' : 'OFF — free-tier rate limiting applied'}
          </span>
        </div>
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          {primarySlot == null
            ? 'Add an API key to see which tier a run will use.'
            : `Follows the tier set on Key ${primarySlot + 1}, the highest-ranked key. `}
          {primarySlot != null && (
            <>
              Change it in{' '}
              <strong>Gemini API Keys</strong>. It is shown here rather than toggled, because each
              key carries its own tier — a separate switch could only ever disagree with the keys.
            </>
          )}
        </p>
      </div>
    </div>
  )
}

function SectionTmdb({ settings, set }: SectionProps): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>TMDB</SectionTitle>
      <div>
        <Label tip="The Movie Database (TMDB) API key, used to look up movie/TV metadata and cast genders for better translation context. A shared public key is pre-filled and works out of the box. Replace it with your own (free at themoviedb.org) for higher rate limits.">
          TMDB API Key
        </Label>
        <TextInput value={settings.tmdbApiKey} onChange={(e) => set('tmdbApiKey', e.target.value)} className="w-full" />
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          A shared public key is pre-filled. <Pill>optional</Pill> use your own for higher limits.
        </p>
      </div>
    </div>
  )
}

/** Settings → Subtitle Sources (Bundle H, feature_decisions.md §3.1b). NG-new: 1.1.0 has no provider controls (H-P4). */
export const OS_CONSUMERS_URL = 'https://www.opensubtitles.com/en/consumers'
export const OS_TOGGLE_LABEL = 'OpenSubtitles'
export const OS_TOGGLE_DESC = 'Search and automatic download of a gender reference subtitle'
export const OS_TOGGLE_TIP =
  'Lets the Translate tab search OpenSubtitles.com for a human subtitle of the same title, and download one automatically as the gender reference. It works with no API key and no login: the app then uses the shared pool of community keys, the same method the Kodi add-on uses. Turn this off and the app never contacts OpenSubtitles. On by default.'
export const OS_KEY_TIP = [
  'Optional. An OpenSubtitles.com API key identifies the app to the service. Leave it empty to use the shared pool of community keys, which needs no sign-up but is shared with other users, so it can be busy or used up for the day.',
  'Your own key is free: sign in on OpenSubtitles.com, open the API consumers page, create a consumer and paste its API key here.',
  'API key or login? The key only lets the app talk to the service. A username and password add your own account, and downloads are then counted against your account’s daily allowance instead of the key’s. You can fill in either, both or neither.'
].join('\n\n')
export const OS_KEY_LINK_LABEL = 'Create an API key on OpenSubtitles.com'
export const OS_USERNAME_TIP =
  'Optional. Your OpenSubtitles.com account. With a login, downloads are counted against your own account’s daily allowance (larger for VIP members) rather than the key’s. It works with your own API key or with the shared pool keys. A refused login is never retried automatically, because repeated failures lock the account.'
export const OS_PASSWORD_TIP =
  'Your OpenSubtitles.com password. It is stored in plain text in this app’s settings file on this computer, like the other keys in Settings, and sent only to OpenSubtitles.'
export const OS_CHECK_TIP =
  'Tests your API key — or the shared key pool when none is entered — and, when a username and password are entered, logs in once, reads your remaining downloads and logs out. It downloads nothing.'
export const OS_NOTHING_ENTERED_NOTE = 'Nothing entered: automatic download still works through the shared key pool.'
export const WIZDOM_TOGGLE_LABEL = 'Wizdom'
export const WIZDOM_TOGGLE_DESC = 'Hebrew subtitles, for a reference you pick yourself'
export const WIZDOM_TOGGLE_TIP =
  'Wizdom (wizdom.xyz) offers Hebrew subtitles and needs no account. It is used only when you pick a file from it on the Translate tab; automatic download never uses it. Off by default.'
export const WIZDOM_WARNING =
  'Wizdom includes unmarked AI / machine-translated Hebrew and cannot be relied on for gender correction. A Wizdom file is never used for the gender hint or the gender repair.'

function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }): React.JSX.Element {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <TextInput
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="flex-1"
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
        title={shown ? 'Hide' : 'Show'}
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </div>
  )
}

function checkTone(state: string): string {
  if (state === 'accepted' || state === 'ok') return 'text-green-700 dark:text-green-400'
  if (state === 'notEntered') return 'text-gray-500 dark:text-gray-400'
  if (state === 'notAccepted' || state === 'rejected') return 'text-red-600 dark:text-red-400'
  return 'text-amber-600 dark:text-amber-400'
}

export function SectionSubtitleSources({ settings, set }: SectionProps): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<OsCheckResult | null>(null)
  const [checkError, setCheckError] = useState('')
  const nothingEntered = !settings.openSubtitlesApiKey.trim() && !settings.openSubtitlesUsername.trim() && !settings.openSubtitlesPassword
  async function check(): Promise<void> {
    if (checking) return
    setChecking(true)
    setResult(null)
    setCheckError('')
    try {
      setResult(await window.api.openSubtitlesCheck())
    } catch {
      setCheckError('The check could not be run.')
    } finally {
      setChecking(false)
    }
  }
  const editCredential = (key: 'openSubtitlesApiKey' | 'openSubtitlesUsername' | 'openSubtitlesPassword', v: string): void => {
    setResult(null)
    set(key, v)
  }
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Subtitle Sources</SectionTitle>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Where the Translate tab looks for a human subtitle of the same title, used as the gender reference.
      </p>
      <ToggleRow
        label={OS_TOGGLE_LABEL}
        desc={OS_TOGGLE_DESC}
        checked={settings.subtitleSourceOpenSubtitles}
        onChange={(v) => set('subtitleSourceOpenSubtitles', v)}
        tip={OS_TOGGLE_TIP}
      />
      <div>
        <LinkLabel tip={OS_KEY_TIP} link={{ url: OS_CONSUMERS_URL, label: OS_KEY_LINK_LABEL }}>
          OpenSubtitles API Key
        </LinkLabel>
        <SecretInput value={settings.openSubtitlesApiKey} onChange={(v) => editCredential('openSubtitlesApiKey', v)} placeholder="— use the shared key pool —" />
      </div>
      <div>
        <Label tip={OS_USERNAME_TIP}>OpenSubtitles Username</Label>
        <TextInput
          value={settings.openSubtitlesUsername}
          onChange={(e) => editCredential('openSubtitlesUsername', e.target.value)}
          placeholder="— no login —"
          autoComplete="off"
          spellCheck={false}
          className="w-full"
        />
      </div>
      <div>
        <Label tip={OS_PASSWORD_TIP}>OpenSubtitles Password</Label>
        <SecretInput value={settings.openSubtitlesPassword} onChange={(v) => editCredential('openSubtitlesPassword', v)} placeholder="— no login —" />
      </div>
      <div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => void check()} disabled={checking}>
            {checking ? 'Checking…' : 'Check'}
          </Button>
          <Tooltip tip={OS_CHECK_TIP} />
        </div>
        {nothingEntered && !result && <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{OS_NOTHING_ENTERED_NOTE}</p>}
        {result && (
          <div className="mt-2 space-y-1 text-xs" role="status">
            <p className={checkTone(result.key.state)}>{result.key.message}</p>
            <p className={checkTone(result.login.state)}>{result.login.message}</p>
          </div>
        )}
        {checkError && (
          <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
            {checkError}
          </p>
        )}
      </div>
      <Divider />
      <ToggleRow
        label={WIZDOM_TOGGLE_LABEL}
        desc={WIZDOM_TOGGLE_DESC}
        checked={settings.subtitleSourceWizdom}
        onChange={(v) => set('subtitleSourceWizdom', v)}
        tip={WIZDOM_TOGGLE_TIP}
      />
      {settings.subtitleSourceWizdom && (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          {WIZDOM_WARNING}
        </div>
      )}
    </div>
  )
}

function SectionOutput({ settings, set }: SectionProps): React.JSX.Element {
  async function pickFolder(): Promise<void> {
    const dir = await window.api.openFolder()
    if (dir) set('outputFolder', dir)
  }
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Output</SectionTitle>
      <div>
        <Label tip="Default folder where translated subtitles are saved. If left empty, the Save dialog opens at the source file's directory instead. You can always change the location at save time.">
          Default Output Folder
        </Label>
        <div className="flex items-center gap-2">
          <TextInput readOnly value={settings.outputFolder} placeholder="— source file's folder —" className="flex-1" />
          <Button variant="secondary" onClick={pickFolder}>
            Browse
          </Button>
          {settings.outputFolder && (
              <button onClick={() => set('outputFolder', '')} className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700" title="Clear">
              ✕
            </button>
          )}
        </div>
      </div>
      <RtlOutputControls settings={settings} set={set} />
    </div>
  )
}

function SectionLogs({ settings, set }: SectionProps): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-5">
      <SectionTitle>Logs</SectionTitle>
      <p className="text-xs text-gray-500 dark:text-gray-400">{LOGS_CONSOLE_NOTE}</p>
      <ToggleRow
        label="Show Token Usage"
        desc={SHOW_TOKEN_USAGE_DESC}
        checked={settings.showTokenStats}
        onChange={(v) => set('showTokenStats', v)}
        tip={SHOW_TOKEN_USAGE_TIP}
      />
      <ToggleRow
        label="Write Token Report"
        desc={WRITE_TOKEN_REPORT_DESC}
        checked={settings.writeTokenReport}
        onChange={(v) => set('writeTokenReport', v)}
        tip={WRITE_TOKEN_REPORT_TIP}
      />
      <ToggleRow
        label="Progress Log"
        desc={PROGRESS_LOG_DESC}
        checked={settings.progressLog}
        onChange={(v) => set('progressLog', v)}
        tip={PROGRESS_LOG_TIP}
      />
      <ToggleRow
        label="Thoughts Log"
        desc={THOUGHTS_LOG_DESC}
        checked={settings.thoughtsLog}
        onChange={(v) => set('thoughtsLog', v)}
        tip={THOUGHTS_LOG_TIP}
      />
    </div>
  )
}

/** What Advanced shows while a picked FFmpeg override is checked and then stored. */
export interface FfmpegPickView {
  /** `checking`: Browse is off and Clear cancels. `saving`: both are off until the one store write settles. */
  busy: 'checking' | 'saving' | null
  error: string
}

export const FFMPEG_PICK_IDLE: FfmpegPickView = { busy: null, error: '' }
export const FFMPEG_CHECK_FAILED = 'The selected FFmpeg could not be checked. Nothing was changed.'
export const FFMPEG_SAVE_FAILED = 'The FFmpeg setting could not be saved.'
export const FFMPEG_FILTERS: Electron.FileFilter[] = [{ name: 'Executable', extensions: ['exe', '*'] }]

export interface FfmpegPick {
  browse(): Promise<void>
  clear(): Promise<void>
  mount(): void
  unmount(): void
}

/**
 * Browse → check → store for the FFmpeg override, with one pending boundary. Every pick, every Clear and
 * the section's unmount start a new operation, and only the current one may store or show anything: a
 * late check can neither overwrite a Clear nor store after the section has gone. A store write that has
 * already started is never cancelled; it only stops updating a section that is no longer there.
 */
export function createFfmpegPick(deps: {
  openFile: () => Promise<string>
  validate: (path: string) => Promise<FfmpegPathValidation>
  patch: (p: Partial<AppSettings>) => Promise<void>
  show: (view: FfmpegPickView) => void
}): FfmpegPick {
  let epoch = 0
  let mounted = true
  let view = FFMPEG_PICK_IDLE
  const show = (v: FfmpegPickView): void => {
    view = v
    if (mounted) deps.show(v)
  }
  return {
    async browse() {
      if (view.busy !== null) return
      const mine = ++epoch
      const picked = await deps.openFile()
      if (!picked || mine !== epoch) return
      show({ busy: 'checking', error: '' })
      let result: FfmpegPathValidation
      try {
        result = await deps.validate(picked)
      } catch {
        result = { ok: false, reason: FFMPEG_CHECK_FAILED }
      }
      if (mine !== epoch) return
      if (!result.ok) {
        show({ busy: null, error: result.reason })
        return
      }
      show({ busy: 'saving', error: '' })
      try {
        await deps.patch({ ffmpegPath: picked })
        show(FFMPEG_PICK_IDLE)
      } catch {
        show({ busy: null, error: FFMPEG_SAVE_FAILED })
      }
    },
    async clear() {
      if (view.busy === 'saving') return
      const mine = ++epoch
      show({ busy: 'saving', error: '' })
      try {
        await deps.patch({ ffmpegPath: '' })
        if (mine === epoch) show(FFMPEG_PICK_IDLE)
      } catch {
        if (mine === epoch) show({ busy: null, error: FFMPEG_SAVE_FAILED })
      }
    },
    mount() {
      mounted = true
    },
    unmount() {
      ++epoch
      mounted = false
    }
  }
}

function useFfmpegPick(patch: (p: Partial<AppSettings>) => Promise<void>): [FfmpegPickView, FfmpegPick] {
  const [view, setView] = useState<FfmpegPickView>(FFMPEG_PICK_IDLE)
  const pick = useRef<FfmpegPick | null>(null)
  if (pick.current === null) {
    pick.current = createFfmpegPick({
      openFile: () => window.api.openFile(FFMPEG_FILTERS),
      validate: (p) => window.api.validateFfmpegPath(p),
      patch,
      show: setView
    })
  }
  useEffect(() => {
    const p = pick.current
    p?.mount()
    return () => p?.unmount()
  }, [])
  return [view, pick.current]
}

/** Feature 17 (D17-1…D17-7), copy exact from implementation_plan.md §9.9d. Four independent controls under one master switch. */
export const ADVANCED_HEBREW_TITLE = 'Advanced Hebrew correction'
export const ADVANCED_HEBREW_INTRO =
  'Experimental options for Hebrew translation. They start OFF and may improve grammatical gender, but they can also make wrong-person changes. Review the resulting subtitle.'
export const ADVANCED_HEBREW_TOGGLES: readonly {
  key: 'hebrewSpeakerRepair' | 'hebrewMethodB' | 'hebrewC1Spanish' | 'hebrewC1Portuguese'
  label: string
  desc: string
  tip?: string
}[] = [
  {
    key: 'hebrewSpeakerRepair',
    label: 'Experimental speaker-gender repair',
    desc: 'Uses a trusted human Hebrew reference to correct speaker-gender grammar. Testing found substantially more corrections than regressions, but it can assign mixed or quoted dialogue to the wrong speaker. Review the resulting subtitle.',
    tip: 'Recommended: keep OFF.\n\nIn live testing on six titles, 66 of its 67 changes were right, and the basic gender fixes the app makes anyway were all kept. Weak spots still seen:\n- A line where two people speak is left as translated, so a wrong speaker gender there is not fixed.\n- Running the same film twice can give different answers.\n- It sends one extra Gemini request when it has something to fix.\n\nTurn it on only if you will review the subtitle afterwards.'
  },
  {
    key: 'hebrewMethodB',
    label: 'Experimental unread-gender Method B',
    desc: 'Uses one extra Gemini classification request only when the deterministic reader cannot identify an axis. Its net gender-accuracy gain is not yet independently measured, and content refusal can make it abstain.',
    tip: 'Recommended: keep OFF.\n\nIt asks Gemini to guess genders the app cannot read itself. In live testing on six titles none of its own changes were wrong, but:\n- Used together with Speaker, one fixed line mixed masculine and feminine forms.\n- Running the same film twice can give different answers.\n- It costs up to two extra requests: one to guess and one to fix.\n\nTurn it on only if you will review the subtitle afterwards.'
  },
  {
    key: 'hebrewC1Spanish',
    label: 'Spanish reference rules',
    desc: 'Allows conservative Spanish reference/source patterns to add addressee-gender evidence. Live testing on six titles changed 3 cues with this switch alone, all correct; the wider false-positive rate is not yet measured.'
  },
  {
    key: 'hebrewC1Portuguese',
    label: 'Portuguese reference rules',
    desc: 'Allows conservative Portuguese reference/source patterns to add addressee-gender evidence. Live testing on six titles changed 1 cue with this switch alone, correctly; the wider false-positive rate is not yet measured.'
  }
]

export const ADVANCED_HEBREW_MASTER_TIP =
  'Shows the four experimental Hebrew options below. While this is off, a translation uses none of them, whatever they are set to, and your choices are kept for when you turn it back on.'

/** Tester 2026-10-18: one master switch; the four layers are shown, and used by a run, only while it is on. */
export function AdvancedHebrewCorrection({ settings, set }: SectionProps): React.JSX.Element {
  const on = settings.hebrewAdvanced === true
  return (
    <div className="space-y-2">
      <ToggleRow label={ADVANCED_HEBREW_TITLE} desc={ADVANCED_HEBREW_INTRO} tip={ADVANCED_HEBREW_MASTER_TIP} checked={on} onChange={(v) => set('hebrewAdvanced', v)} />
      {on && (
        <div className="ml-6 space-y-2 border-l border-gray-200 pl-4 dark:border-gray-700">
          {ADVANCED_HEBREW_TOGGLES.map((t) => (
            <ToggleRow key={t.key} label={t.label} desc={t.desc} tip={t.tip} checked={settings[t.key] === true} onChange={(v) => set(t.key, v)} />
          ))}
        </div>
      )}
    </div>
  )
}

function SectionAdvanced({
  settings,
  set,
  patch
}: SectionProps & { patch: (p: Partial<AppSettings>) => Promise<void> }): React.JSX.Element {
  const [ffmpeg, ffmpegPick] = useFfmpegPick(patch)
  return (
    <div className="max-w-2xl space-y-5">
      <SectionTitle>Advanced</SectionTitle>
      <div>
        <Label tip="The translation engine this app runs. It is read-only because it is not a setting: translation and transcription run inside the app itself, talking to Google Gemini directly. Quote it in any bug report.">
          Engine
        </Label>
        <TextInput readOnly value="Native Gemini engine (built in)" className="w-full" />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Runs happen inside this app; no separate translation-engine executable is launched.
        </p>
      </div>
      <div>
        <Label tip="Path to the FFmpeg executable. Only needed for video/audio features: the Transcribe tab, the Video File field, and the Audio File field on the Translate tab. Not required for plain subtitle translation.

Leave empty (recommended) to use the FFmpeg bundled inside this app — no separate install required. If for some reason the bundled copy is missing, it then falls back to FFmpeg on your system PATH. Only set a path here to override the bundled copy with your own FFmpeg build (e.g. one with extra codecs or hardware acceleration); when set, that path is used directly.

Choose the ffmpeg file itself (ffmpeg.exe on Windows), with ffprobe in the same folder. Anything else is refused and the current setting is kept.

Since engine 3.7.0, a missing FFmpeg no longer aborts operations that do not need it — fetching models and translating a subtitle file keep working, and only the audio/video features report the problem.">
          FFmpeg Path
        </Label>
        <div className="flex items-center gap-2">
          <TextInput readOnly value={settings.ffmpegPath} placeholder="— use bundled FFmpeg (no install needed) —" className="flex-1" />
          <Button variant="secondary" onClick={() => void ffmpegPick.browse()} disabled={ffmpeg.busy !== null}>
            Browse
          </Button>
          {(settings.ffmpegPath || ffmpeg.busy === 'checking') && (
            <button
              onClick={() => void ffmpegPick.clear()}
              disabled={ffmpeg.busy === 'saving'}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
              title="Clear"
            >
              ✕
            </button>
          )}
        </div>
        {ffmpeg.busy && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{ffmpeg.busy === 'checking' ? 'Checking the selected FFmpeg…' : 'Saving…'}</p>
        )}
        {ffmpeg.error && (
          <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
            {ffmpeg.error}
          </p>
        )}
      </div>
      <div>
        <Label tip="Optional instructions of your own about how to translate, for example &quot;use informal slang&quot; or &quot;keep brand names in English&quot;. They are added after the app's built-in instructions and replace none of them: the line format, keeping the same number of lines, keeping italics and line breaks, and gender from the speaker's voice all still apply, and where your text conflicts with them the built-in rules win. Custom Context on the Translate tab is for facts about the film; this is for style. Leave it empty to send only the built-in instructions.">
          System Prompt Override
        </Label>
        <textarea
          value={settings.systemPrompt}
          onChange={(e) => set('systemPrompt', e.target.value)}
          rows={3}
          placeholder="— use built-in default prompt —"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500"
        />
      </div>
      <AdvancedHebrewCorrection settings={settings} set={set} />
      <Divider />
      <div>
        <Label tip={`Lines of already-translated context replayed to the model when a job is RESUMED from a specific line. Default: ${DEFAULT_RESUME_CONTEXT_SIZE}. 0 sends no prior context. More context keeps names and tone consistent across the break, at the cost of extra input tokens on the first resumed batch.

This setting has NO effect on a normal run — it applies only when a translation is resumed part-way through.`}>
          Resume Context Size
        </Label>
        <NumberInput
          value={settings.resumeContextSize}
          min={0}
          max={500}
          onChange={(v) => set('resumeContextSize', v ?? DEFAULT_RESUME_CONTEXT_SIZE)}
          className="w-28"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Only takes effect when resuming an interrupted job.
        </p>
      </div>
    </div>
  )
}
