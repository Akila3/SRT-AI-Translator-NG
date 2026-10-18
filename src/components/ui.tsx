import React, { useEffect, useLayoutEffect, useState, useRef } from 'react'
import type { LogRow, RetryState } from '../lib/logView'
import { valueOnBlur, valueWhileTyping } from '../lib/numberField'
import { COST_UNAVAILABLE_COPY, PRICING_CURRENCY, PRICING_UPDATED, formatCostUsd } from '../../electron/shared/pricing'
import type { Usage } from '../../electron/shared/engineEvents'
import { TokenUsageCard } from './TokenUsageCard'
import { openExternalLink } from '../lib/openExternal'

// ─── Tooltip ("?") ───────────────────────────────────────────────────────────
/** Widths an open tip may take, narrowest first: the first whose text fits the window's height is kept. */
export const TIP_WIDTHS = [320, 448, 576, 720, 880]
const TIP_MARGIN = 8

/** The next wider width for a tip taller than the window, when that width still fits the window; else null. */
export function widerTipWidth(width: number, height: number, vw: number, vh: number): number | null {
  if (height <= vh - 2 * TIP_MARGIN) return null
  const next = TIP_WIDTHS.find((w) => w > width)
  return next !== undefined && next <= vw - 2 * TIP_MARGIN ? next : null
}

/**
 * Where an open tip sits, in window coordinates: touching the "?" on its right (its left when there is no room),
 * level with it, moved only as far as needed to stay inside the window.
 */
export function tipPlacement(
  anchor: { left: number; top: number; right: number },
  box: { width: number; height: number },
  vw: number,
  vh: number
): { left: number; top: number } {
  let left = anchor.right
  if (left + box.width > vw - TIP_MARGIN) left = anchor.left - box.width
  left = Math.max(TIP_MARGIN, Math.min(left, vw - TIP_MARGIN - box.width))
  return { left, top: Math.max(TIP_MARGIN, Math.min(anchor.top, vh - TIP_MARGIN - box.height)) }
}

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * An open tip is `position: fixed`, placed in window coordinates: an absolute box that ran past the page's edge
 * grew its scroll area, the scrollbar moved the "?" from under the pointer, the tip closed, the scrollbar went,
 * and the cycle flickered. A fixed box adds nothing to any scroll area, yet stays in its page's DOM: it hides
 * with its page and keeps the tab order (no ancestor may set transform/filter, which would re-anchor it). It is
 * measured hidden, widened while taller than the window, then placed.
 */
function useFloatingTip(open: boolean): {
  anchor: React.RefObject<HTMLElement>
  panel: React.RefObject<HTMLSpanElement>
  style: React.CSSProperties | undefined
} {
  const anchor = useRef<HTMLElement>(null)
  const panel = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(TIP_WIDTHS[0])
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  useClientLayoutEffect(() => {
    if (!open) {
      setPlace(null)
      setWidth(TIP_WIDTHS[0])
      return
    }
    const measure = (): void => {
      const a = anchor.current?.getBoundingClientRect()
      const p = panel.current?.getBoundingClientRect()
      if (!a || !p) return
      const wider = widerTipWidth(p.width, p.height, window.innerWidth, window.innerHeight)
      if (wider !== null) setWidth(wider)
      else setPlace(tipPlacement(a, p, window.innerWidth, window.innerHeight))
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, width])
  const style: React.CSSProperties | undefined = open
    ? { width: Math.min(width, window.innerWidth - 2 * TIP_MARGIN), left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? 'visible' : 'hidden' }
    : undefined
  return { anchor, panel, style }
}

export function Tooltip({ tip }: { tip: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const float = useFloatingTip(open)
  return (
    <span className="relative inline-flex items-center">
      <span
        ref={float.anchor as React.RefObject<HTMLSpanElement>}
        className="ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold text-gray-500 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        ?
      </span>
      {open && (
        <span ref={float.panel} className="fixed z-50" style={{ ...float.style, pointerEvents: 'none' }}>
          <span
            className="block whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            style={{ pointerEvents: 'none' }}
          >
            {tip}
          </span>
        </span>
      )}
    </span>
  )
}

export function Label({
  children,
  tip
}: {
  children: React.ReactNode
  tip?: string
}): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-center text-[11px] font-semibold tracking-wide text-gray-500 dark:text-gray-400">
      <span className="uppercase">{children}</span>
      {tip && <Tooltip tip={tip} />}
    </div>
  )
}

// ─── Button ──────────────────────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export function Button({
  children,
  variant = 'primary',
  className = '',
  ...rest
}: {
  variant?: ButtonVariant
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-brand text-white hover:bg-brand-hover',
    secondary:
      'border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600',
    ghost: 'text-brand hover:bg-blue-50 dark:hover:bg-blue-950/40',
    danger: 'bg-red-600 text-white hover:bg-red-700'
  }
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  )
}

// ─── Tooltip with a link ─────────────────────────────────────────────────────
/** A clickable link at the end of a tip. HTTPS only, through the main-process allowlist. */
export interface TipLink {
  url: string
  label: string
}

/**
 * The "?" for a tip that ends in a link. Its panel must take the pointer for the link to be clickable, so it stays
 * open while the pointer is over the "?" or the panel (one hover region), and a click on the "?" pins it for
 * keyboard and touch. Focus leaving the region (the "?" and its link) closes it. The plain `Tooltip` above stays
 * hover-only.
 */
export function LinkTooltip({ tip, link }: { tip: string; link: TipLink }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const float = useFloatingTip(open)
  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={float.anchor as React.RefObject<HTMLButtonElement>}
        type="button"
        aria-label="Help"
        aria-expanded={open}
        className="ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold text-gray-500 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <span
          ref={float.panel}
          className="fixed z-50 whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-3 text-xs font-normal normal-case leading-relaxed tracking-normal text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          style={float.style}
        >
          {tip}
          {'\n\n'}
          <button
            type="button"
            className="font-semibold text-brand underline hover:text-brand-hover dark:text-blue-300"
            onClick={() => {
              void openExternalLink(link.url).then(setErr)
            }}
          >
            {link.label}
          </button>
          {err ? <span className="ml-1 text-red-600 dark:text-red-400">{err}</span> : null}
        </span>
      )}
    </span>
  )
}

/** `Label` with a `LinkTooltip`. */
export function LinkLabel({ children, tip, link }: { children: React.ReactNode; tip: string; link: TipLink }): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-center text-[11px] font-semibold tracking-wide text-gray-500 dark:text-gray-400">
      <span className="uppercase">{children}</span>
      <LinkTooltip tip={tip} link={link} />
    </div>
  )
}

// ─── Text input ────────────────────────────────────────────────────────────
export function TextInput({
  className = '',
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={`rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-brand focus:ring-1 focus:ring-brand disabled:bg-gray-100 disabled:text-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 ${className}`}
      {...rest}
    />
  )
}

/**
 * A number field that can be typed into as well as nudged.
 *
 * It used to clamp on every keystroke, which made `0.85` unreachable in a field whose
 * minimum is `0.05` — the leading `0` was rewritten under the caret (REP-4). The rules for
 * what a keystroke commits live in `numberField.ts`; what is left here is the part that
 * needs a DOM.
 *
 * **The draft is what makes it work, and it has to be rendered verbatim — including empty.**
 * A `type="number"` input reports an empty string for any half-typed value it cannot parse,
 * `0.` being the one that matters. Holding that empty string in state and rendering it is
 * what stops React writing the old value back over the text: the input's own `value` is
 * already `''` in that state, so the two agree and React leaves the DOM alone, and the `.`
 * the user just typed stays on screen. Rendering the last good value instead — the obvious
 * thing — deletes the character as it is typed, which is the original bug wearing a hat.
 *
 * Because nothing is corrected mid-word any more, the native spinners are safe to show
 * again; they were hidden only to keep the per-keystroke clamp from fighting them.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  allowEmpty = false,
  disabled,
  placeholder,
  className = ''
}: {
  value: number | null
  onChange: (v: number | null) => void
  min: number
  max: number
  step?: number
  allowEmpty?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
}): React.JSX.Element {
  // The text as typed, while the field has focus. Null means "show the committed value".
  const [draft, setDraft] = useState<string | null>(null)
  const rules = { min, max, step, allowEmpty }

  const commit = (el: HTMLInputElement): void => {
    setDraft(null)
    // `badInput` is the difference between an empty box and an unfinished one: both read as
    // '' here, but only the first means the user cleared it.
    if (el.validity?.badInput) return
    const settled = valueOnBlur(el.value, rules, value)
    if (settled !== value) onChange(settled)
  }

  return (
    <TextInput
      type="number"
      className={className}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      value={draft ?? (value === null ? '' : String(value))}
      onChange={(e) => {
        setDraft(e.target.value)
        const typed = valueWhileTyping(e.target.value, rules)
        if (typed !== null) onChange(typed)
      }}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        // Enter settles the field without waiting for focus to move, so a value typed and
        // confirmed with the keyboard is corrected at the same moment as a clicked-away one.
        if (e.key === 'Enter') commit(e.currentTarget)
      }}
    />
  )
}

// ─── Select ────────────────────────────────────────────────────────────────
export function Select({
  value,
  onChange,
  options,
  className = '',
  disabled
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  className?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:bg-gray-100 disabled:text-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

// ─── Toggle ───────────────────────────────────────────────────────────────
export function Toggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-brand' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

export function ToggleRow({
  label,
  desc,
  checked,
  onChange,
  tip,
  disabled
}: {
  label: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
  tip?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 py-1">
      <div className="pt-0.5">
        <Toggle checked={checked} onChange={onChange} disabled={disabled} />
      </div>
      <div className="flex-1">
        <div className="flex items-center text-sm font-medium text-gray-800 dark:text-gray-200">
          {label}
          {tip && <Tooltip tip={tip} />}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{desc}</div>
      </div>
    </div>
  )
}

// ─── Card / Box ──────────────────────────────────────────────────────────────
export function Box({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={`rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 ${className}`}>{children}</div>
  )
}

export function BoxTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-4 text-[15px] font-semibold text-gray-900 dark:text-gray-100">{children}</div>
}

export function Divider(): React.JSX.Element {
  return <div className="my-1 h-px w-full bg-gray-200 dark:bg-gray-700" />
}

export function Pill({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-brand dark:bg-blue-950/50 dark:text-blue-300">
      {children}
    </span>
  )
}

// ─── File picker ─────────────────────────────────────────────────────────────
export function FilePicker({
  value,
  onPick,
  onClear,
  placeholder
}: {
  value: string
  onPick: () => void
  onClear?: () => void
  placeholder: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <TextInput readOnly value={value} placeholder={placeholder} className="flex-1" />
      <Button variant="secondary" onClick={onPick}>
        Browse
      </Button>
      {value && onClear && (
        <button
          title="Clear"
          onClick={onClear}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ─── Progress bar ────────────────────────────────────────────────────────────
/**
 * `indeterminate` is for work that is genuinely happening but cannot be measured — the
 * engine's own ffmpeg calls report nothing until they finish, and a bar frozen at 0% is
 * indistinguishable from a hung app, which is precisely what REP-11 was reported as. It
 * moves to say "alive", and says nothing about how far along it is, which is the truth.
 */
export function ProgressBar({
  pct,
  indeterminate = false
}: {
  pct: number
  indeterminate?: boolean
}): React.JSX.Element {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
      {indeterminate ? (
        <div className="progress-sweep h-full w-1/3 rounded-full bg-brand" />
      ) : (
        <div
          className="h-full rounded-full bg-brand transition-all duration-300"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      )}
    </div>
  )
}

// ─── Elapsed clock ───────────────────────────────────────────────────────────
/** `m:ss`, or `h:mm:ss` once it has been running long enough to need the hours. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/**
 * A clock that counts up from a moment.
 *
 * The one thing an app can always honestly say about work it cannot measure is how long it
 * has been going. It ticks once a second, and only while mounted — it is rendered only
 * during the work it describes, so there is no interval left running afterwards.
 */
export function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])
  return <>{formatElapsed(now - since)}</>
}

// ─── "This is taking a while, and here is proof it is alive" ──────────────────
/**
 * One line of reassurance plus a bar, for work that takes minutes and used to say nothing.
 *
 * `pct` is null when the duration is unknown, and then the elapsed clock carries the whole
 * message. That fallback is not a rare edge: the engine's internal extraction cannot report
 * progress at all, so for transcription it is the normal case.
 */
export function Working({
  label,
  pct,
  since,
  note
}: {
  label: string
  pct: number | null
  since: number
  note?: string
}): React.JSX.Element {
  return (
    <div className="space-y-1.5 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/40">
      <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <Spinner />
        <span>{label}</span>
        <span className="ml-auto font-mono text-xs text-gray-500 dark:text-gray-400">
          {pct !== null && `${pct}% · `}
          <Elapsed since={since} />
        </span>
      </div>
      <ProgressBar pct={pct ?? 0} indeterminate={pct === null} />
      {note && <p className="text-xs text-gray-500 dark:text-gray-400">{note}</p>}
    </div>
  )
}

// ─── Spinner ─────────────────────────────────────────────────────────────────
export function Spinner(): React.JSX.Element {
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-brand dark:border-gray-600 dark:border-t-brand" />
  )
}

// ─── Live status card (structured translation progress) ───────────────────────
interface StatusCardProps {
  running: boolean
  statusText: string
  currentLine: number
  totalLines: number
  batchSize: number
  tokens: { prompt: number; thoughts: number; output: number; total: number } | null
  showTokens: boolean
  model: string
  /** A native run's estimate (Step 3.1); absent for a run that does not price its usage. */
  cost?: { estimate: number | null } | null
  /** Request and retry totals for the usage card, when the run states them. */
  usage?: Usage | null
  /**
   * The Batch cell's source (§12.9): undefined = the legacy calculation from `batchSize`; null = no
   * Batch fact yet; a value = this exact current/total pair, which survives a D8-8 repartition.
   */
  batchProgress?: StatusCardBatchProgress | null
}

export interface StatusCardBatchProgress {
  current: number
  total: number
}

/**
 * The run's dated cost estimate. Null when the exact model and service tier have no captured price;
 * then it says so rather than guessing. Shown only where token usage is shown.
 */
export function CostEstimate({ estimate }: { estimate: number | null }): React.JSX.Element {
  return (
    <div>
      <div className="mb-0.5 text-[10px] text-gray-400 dark:text-gray-500">Estimated cost</div>
      {estimate === null ? (
        <div className="text-xs text-gray-500 dark:text-gray-400">{COST_UNAVAILABLE_COPY}</div>
      ) : (
        <div className="text-[15px] font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {formatCostUsd(estimate)} {PRICING_CURRENCY}{' '}
          <span className="text-[10px] font-normal text-gray-400 dark:text-gray-500">estimate · rates updated {PRICING_UPDATED}</span>
        </div>
      )}
    </div>
  )
}

function StatCell({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }): React.JSX.Element {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{label}</div>
      <div className={`flex items-center gap-1.5 text-sm font-medium ${accent ? 'text-brand' : 'text-gray-800 dark:text-gray-100'}`}>
        {value}
      </div>
    </div>
  )
}

export function StatusCard({
  running,
  statusText,
  currentLine,
  totalLines,
  batchSize,
  tokens,
  showTokens,
  model,
  cost,
  usage,
  batchProgress
}: StatusCardProps): React.JSX.Element {
  const pct = totalLines > 0 ? Math.round((currentLine / totalLines) * 100) : 0
  const legacyTotal = totalLines > 0 && batchSize > 0 ? Math.ceil(totalLines / batchSize) : 0
  const batchPair =
    batchProgress === undefined
      ? legacyTotal > 0
        ? { current: Math.min(legacyTotal, Math.floor(currentLine / batchSize) + 1), total: legacyTotal }
        : null
      : batchProgress
  const totalBatches = batchPair?.total ?? 0
  const currentBatch = batchPair?.current ?? 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/40">
        <StatCell label="Lines translated" value={totalLines > 0 ? `${currentLine} / ${totalLines}` : `${currentLine}`} />
        <StatCell label="Progress" value={`${pct}%`} />
        {totalBatches > 0 && <StatCell label="Batch" value={`${currentBatch} / ${totalBatches}`} />}
        <StatCell
          label="Status"
          accent={running}
          value={
            <>
              {statusText || (running ? 'Working…' : '—')}
              {running && <Spinner />}
            </>
          }
        />
      </div>

      {showTokens && tokens && <TokenUsageCard tokens={tokens} model={model} cost={cost} usage={usage} />}
    </div>
  )
}

// ─── Log panel ───────────────────────────────────────────────────────────────

/**
 * How close to the bottom still counts as "following the newest line".
 *
 * A couple of rows of slack, so a wrapped line or a sub-pixel scroll position does not silently
 * stop the panel following — the default behaviour everyone expects.
 */
const FOLLOW_SLACK_PX = 24

export function LogPanel({ rows }: { rows: LogRow[] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Whether the view was at the bottom when the last line arrived. A ref, not state: it must
  // not cause a render of its own, and it is read inside the effect that follows the log.
  const following = useRef(true)

  React.useEffect(() => {
    const el = ref.current
    // A new run starts at the bottom of an empty panel, so it follows again even if the user
    // had scrolled up during the previous one.
    if (rows.length === 0) following.current = true
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [rows])

  // Auto-scrolling used to be unconditional, which made the panel unreadable during a run: at
  // 25 lines a second the user was thrown back to the bottom before they could read anything,
  // let alone select it. Following is now something the user can leave and come back to simply
  // by scrolling, and the default is unchanged.
  const onScroll = (): void => {
    const el = ref.current
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="thin-scroll max-h-48 overflow-y-auto rounded-md bg-gray-900 p-3 font-mono text-[11px] leading-relaxed text-gray-100"
    >
      {rows.length === 0 ? (
        <div className="text-gray-500">Waiting to start…</div>
      ) : (
        rows.map((row) =>
          row.kind === 'gap' ? (
            <div key={row.seq} className="log-row py-1 text-gray-500">
              ··· {row.hiddenLines.toLocaleString()} earlier lines hidden ···
            </div>
          ) : (
            row.lines.map((l, i) => (
              <div key={`${row.seq}:${i}`} className="log-row whitespace-pre-wrap">
                {l}
                {/*
                  On the block's FIRST line, so it reads as "this block, drawn N times" — the
                  count belongs to the block, and hanging it off the last line would look like a
                  claim about that line alone.
                */}
                {row.count > 1 && i === 0 && (
                  <span className="ml-2 rounded bg-gray-700 px-1.5 py-px text-[10px] font-semibold text-amber-300">
                    × {row.count.toLocaleString()}
                  </span>
                )}
              </div>
            ))
          )
        )
      )}
    </div>
  )
}

/**
 * Says the engine is re-attempting a batch, which is otherwise invisible.
 *
 * The engine retries a failed batch with no ceiling of its own — a measured run repeated one
 * batch more than 250 times — and its own counter can sit at "1/3" throughout, so a run that is
 * getting nowhere looks exactly like one that is working. This stops nothing and claims no
 * count (see `readRetryState`): it states which batch is being re-attempted, and disappears the
 * moment the run moves past it, so the user can decide whether to keep waiting.
 */
export function RetryNotice({ retry }: { retry: RetryState }): React.JSX.Element {
  return (
    <p className="text-sm text-amber-700 dark:text-amber-400">
      The engine is re-attempting lines {retry.from.toLocaleString()}–{retry.to.toLocaleString()}. It
      keeps trying until it succeeds, so this can take a while — press Stop if you would rather not
      wait.
    </p>
  )
}
