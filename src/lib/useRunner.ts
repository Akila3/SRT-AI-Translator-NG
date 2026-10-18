import { useEffect, useRef, useState, useCallback } from 'react'
import type {
  AdviceState,
  BudgetSnapshot,
  PreservedLine,
  RunError,
  RunEvent,
  RunKind,
  RunOutcome,
  RunPhase,
  RunWarning,
  UnitState,
  Usage
} from '../../electron/shared/engineEvents'
import { blockAdvice } from '../../electron/shared/runCopy'
import { appendLogLine, type LogRow, type RetryState, type RunStatus } from './logView'

export type { RunStatus, LogRow, RetryState }

export interface TokenTally {
  prompt: number
  thoughts: number
  output: number
  total: number
}

export interface RunnerState {
  status: RunStatus
  /**
   * The log as the panel shows it: repeated blocks folded into a counter, the middle capped.
   * See `logView.ts` — the folding is a display transform over the run's `log` events; progress,
   * tokens and status arrive as their own events, so a collapsed block still updates them.
   */
  log: LogRow[]
  progress: number
  tokens: TokenTally | null
  /** The latest cumulative usage's estimate in USD; null when none could be stated (Step 3.1). */
  costEstimate: number | null
  currentLine: number
  totalLines: number
  statusText: string
  outputPath: string
  /**
   * An incomplete subtitle a failed or stopped run left behind (§4.1a rule 4); '' when there is none.
   * Never the finished output: a completed run does not report one, and nothing treats it as `outputPath`.
   */
  partialPath: string
  /**
   * A native run whose stopped or failed ending left checkpointed work for Continue (Phase 3). The page
   * says so instead of "Nothing was saved"; it never offers that work for Save or opening.
   */
  resumable: boolean
  /**
   * Bundle G: the cues the run's file keeps in their source language, by number, with why. Empty when
   * there are none. The page says how many beside Save, before any save completes.
   */
  preserved: PreservedLine[]
  logPaths: string[]
  /**
   * Advisory notes, never blocking. The output's own (`filler`, `timing`) arrive with the ending and
   * are shown beside Save; the source's `fragment` note arrives as soon as the run says it.
   */
  warnings: RunWarning[]
  /** Why the run failed, once it has; null for any other ending. */
  error: RunError | null
  /** The batch the engine is currently retrying, while it is still retrying it. */
  retry: RetryState | null
  exitCode: number | null
  /** Where the run is (BR-6): a page can tell "preparing" from "no progress yet". */
  phase: RunPhase | null
  /**
   * The latest one-based unit pair the engine reported (Bundle F D8-8): the Batch cell's source,
   * because a repartitioned run no longer matches the saved Batch Size. 0 / null before the first unit.
   */
  currentUnit: number
  totalUnits: number | null
  /** The last cumulative usage as reported, for the shared usage card's buckets. */
  usage: Usage | null
  /** The latest typed pacing state. Only `FreeTierNotice` reads it; `ready` means nothing is binding. */
  budget: BudgetSnapshot | null
  /** Translate's latest request-size advice; `unavailable` is fail-open and never shown as a problem. */
  advice: RunAdvice | null
}

export interface RunAdvice {
  state: AdviceState
  requestedBatchSize: number
  effectiveBatchSize?: number
  message: string
}

const INITIAL: RunnerState = {
  status: 'idle',
  log: [],
  progress: 0,
  tokens: null,
  costEstimate: null,
  currentLine: 0,
  totalLines: 0,
  statusText: '',
  outputPath: '',
  partialPath: '',
  resumable: false,
  preserved: [],
  logPaths: [],
  warnings: [],
  error: null,
  retry: null,
  exitCode: null,
  phase: null,
  currentUnit: 0,
  totalUnits: null,
  usage: null,
  budget: null,
  advice: null
}

/**
 * One run as the reducer tracks it. `state` is what the pages read; the rest is the fence that
 * keeps a run's events from reaching another run's panel (SOL-01) and a settled run from moving.
 */
export interface RunnerModel {
  state: RunnerState
  /** The run this model listens for; another run's events are ignored entirely. */
  runId: string
  kind: RunKind | null
  started: boolean
  settled: boolean
  /** Events that arrived for this run after its `finished` (§2.2a): dropped, and counted. */
  dropped: number
  /** The last `error` while active; `finished.error` replaces it at the end (§2.1a). */
  lastError: RunError | null
  /** Latest run-owned unit count, from `started.totalUnits` then each `unit.total`. */
  unitTotal: number | null
  /**
   * Set once a line total or an audio position has been seen. From then progress comes from those
   * alone; before it, progress falls back to completed units (Step 0.6).
   */
  measured: boolean
}

export function initialRunnerModel(runId: string): RunnerModel {
  return {
    state: { ...INITIAL, status: 'running' },
    runId,
    kind: null,
    started: false,
    settled: false,
    dropped: 0,
    lastError: null,
    unitTotal: null,
    measured: false
  }
}

/**
 * The wording 1.1.0's status card used for each unit state. A retry keeps whatever it said last;
 * 1.1.0 had no words for a failed unit (the CLI adapter never reports one), so neither does this.
 */
const UNIT_STATUS: Record<UnitState, string | null> = {
  sending: 'Sending batch…',
  validating: 'Validating tokens…',
  received: 'Translating…',
  retrying: null,
  failed: null
}

/** The status-card words for a run's ending; 1.1.0's `terminalState`, keyed by outcome. */
const OUTCOME_VIEW: Record<RunOutcome, { status: RunStatus; statusText: string }> = {
  completed: { status: 'done', statusText: 'Completed' },
  stopped: { status: 'stopped', statusText: 'Stopped' },
  failed: { status: 'error', statusText: 'Failed' }
}

function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor(100 * (done / total))) : 0
}

/** The token grid's numbers; streamed tallies and the final snapshot are both cumulative. */
function tallyOf(usage: Usage): TokenTally {
  return {
    prompt: usage.promptTokens,
    thoughts: usage.thoughtTokens,
    output: usage.outputTokens,
    total: usage.totalTokens
  }
}

/** The engine's own estimate, carried only when it could be stated; never computed here. */
function costOf(usage: Usage): number | null {
  const c = usage.costEstimate
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : null
}

function appendLines(log: LogRow[], text: string): LogRow[] {
  return text.split('\n').reduce((rows, line) => (line ? appendLogLine(rows, line) : rows), log)
}

/**
 * Fold one engine event into the run.
 *
 * Exported and pure so a sequence can be replayed in the gates (NG3) exactly as the hook applies it.
 */
export function reduceRunEvent(m: RunnerModel, e: RunEvent): RunnerModel {
  if (e.runId !== m.runId) return m
  if (m.settled) return { ...m, dropped: m.dropped + 1 }
  const s = m.state

  switch (e.type) {
    case 'started':
      if (m.started) return { ...m, dropped: m.dropped + 1 }
      return {
        ...m,
        kind: e.kind,
        started: true,
        unitTotal: e.totalUnits ?? m.unitTotal,
        measured: m.measured || (e.totalLines ?? 0) > 0,
        state: {
          ...s,
          phase: 'starting',
          totalLines: e.totalLines ?? s.totalLines,
          totalUnits: e.totalUnits ?? s.totalUnits
        }
      }
    case 'phase':
      return {
        ...m,
        state: {
          ...s,
          phase: e.phase,
          // gst's one-off "Starting translation of N lines..." is what moves a translation to work.
          statusText: e.phase === 'working' && m.kind === 'translate' ? 'Starting…' : s.statusText
        }
      }
    case 'unit': {
      // Transcription's "Processing" bar never changed 1.1.0's status text; only translation's did.
      const words = e.state === 'received' && m.kind !== 'translate' ? null : UNIT_STATUS[e.state]
      // A unit on its second or later attempt is a batch being retried, whatever step it is at.
      const retry = e.lineRange && (e.attempt ?? 1) > 1 ? { from: e.lineRange.from, to: e.lineRange.to } : null
      const unitTotal = e.total ?? m.unitTotal
      let progress = s.progress
      if (e.audioSeconds) {
        progress = percent(e.audioSeconds.done, e.audioSeconds.total)
      } else if (!m.measured && unitTotal) {
        // A unit being sent is not a unit done: only the ones before it count.
        progress = Math.max(s.progress, percent(e.index - 1, unitTotal))
      }
      return {
        ...m,
        unitTotal,
        measured: m.measured || !!e.audioSeconds,
        state: {
          ...s,
          statusText: words ?? s.statusText,
          retry,
          progress,
          currentUnit: e.index,
          totalUnits: unitTotal
        }
      }
    }
    case 'budget':
      return { ...m, state: { ...s, budget: e.budget } }
    case 'advice':
      return {
        ...m,
        state: {
          ...s,
          advice: {
            state: e.state,
            requestedBatchSize: e.requestedBatchSize,
            ...(e.effectiveBatchSize !== undefined ? { effectiveBatchSize: e.effectiveBatchSize } : {}),
            message: e.message
          }
        }
      }
    case 'lines': {
      // A total learnt earlier (at `started`, or from an earlier `lines`) still counts when this event omits it.
      const totalLines = e.total ?? s.totalLines
      const counted = totalLines > 0
      const progress = counted ? percent(e.done, totalLines) : s.progress
      return { ...m, measured: m.measured || counted, state: { ...s, currentLine: e.done, totalLines, progress } }
    }
    case 'usage':
      return { ...m, state: { ...s, tokens: tallyOf(e.usage), costEstimate: costOf(e.usage), usage: e.usage } }
    case 'log':
      return { ...m, state: { ...s, log: appendLogLine(s.log, e.text) } }
    case 'warning':
      return { ...m, state: { ...s, warnings: [...s.warnings, e.warning] } }
    case 'error':
      // A refusal that never reserved the slot has no `log` lines; its sentence is what the panel showed.
      return {
        ...m,
        lastError: e.error,
        state: m.started ? s : { ...s, log: appendLines(s.log, e.error.message) }
      }
    case 'finished': {
      const end = OUTCOME_VIEW[e.outcome]
      const refusalUnsaid = !m.started && m.lastError === null && e.error
      return {
        ...m,
        settled: true,
        lastError: e.error ?? null,
        state: {
          ...s,
          log: refusalUnsaid && e.error ? appendLines(s.log, e.error.message) : s.log,
          status: end.status,
          statusText: end.statusText,
          progress: end.status === 'done' ? 100 : s.progress,
          // The final cumulative snapshot replaces the grid; it is never added to it (§2.1 property 2).
          tokens: e.usage ? tallyOf(e.usage) : s.tokens,
          costEstimate: e.usage ? costOf(e.usage) : s.costEstimate,
          usage: e.usage ?? s.usage,
          // The durable snapshot wins; a run that never paced has none and keeps whatever it last said.
          budget: e.budget ?? s.budget,
          outputPath: e.outputPath,
          partialPath: e.outcome === 'completed' ? '' : (e.partialPath ?? ''),
          resumable: e.outcome !== 'completed' && e.resumable === true,
          preserved: (e.preserved ?? []).map((p) => ({ ...p })),
          logPaths: [...e.logPaths],
          warnings: [...e.warnings],
          error: e.error ?? null,
          exitCode: e.exitCode
        }
      }
    }
    default:
      return m
  }
}

/**
 * The sentence a page shows for a failed run in place of the generic exit-code line, or null.
 *
 * Only a key, quota or network problem has its own sentence, plus — on Translate, the only kind
 * that checks the count — a short line count. Every other failure points the user at the log.
 */
export function failureSentence(state: RunnerState, page: RunKind): string | null {
  if (state.status !== 'error' || !state.error) return null
  switch (state.error.kind) {
    case 'auth':
    case 'forbidden':
    case 'quota':
    case 'network':
      return state.error.message
    case 'countMismatch':
      return page === 'translate' ? state.error.message : null
    case 'blocked':
      // Only a cause `blocks.ts` typed has advice (Step 3.2); any other block keeps the generic line.
      return blockAdvice(page, state.error)
    default:
      return null
  }
}

/**
 * How long arriving events are gathered before one state update is committed.
 *
 * Each commit re-renders the whole log panel, so the cost is per COMMIT, not per event;
 * without this, an event rate sets the render rate. Short enough to be imperceptible — a
 * lone line, such as each of the engine's extraction steps, still lands within a frame or
 * two — and long enough that a sustained ~25 line/s retry storm cannot drive rendering.
 */
const FLUSH_MS = 100

/**
 * A name for one run, unique for the life of the window.
 *
 * `crypto.randomUUID` is present in Electron's renderer, but a counter and a timestamp are enough
 * for something that only has to be distinct from the other runs of this session, and this cannot
 * fail in a context where the crypto API is unavailable.
 */
let runSeq = 0
function mintRunId(): string {
  runSeq += 1
  return `r${Date.now().toString(36)}-${runSeq}`
}

export function useRunner(): {
  state: RunnerState
  start: (launch: (runId: string) => Promise<string>) => Promise<void>
  stop: () => Promise<void>
  reset: () => void
  runId: () => string | null
} {
  const [state, setState] = useState<RunnerState>(INITIAL)
  const cleanup = useRef<Array<() => void>>([])
  const pending = useRef<RunEvent[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushPending = useRef<(() => void) | null>(null)
  /**
   * The run this hook is currently listening for, with its fence.
   *
   * Read inside the event handler rather than captured, so it is always the CURRENT run: both
   * pages stay mounted and both listen on the same channel, so without this a finished
   * translation would absorb a later transcription's ending — taking its `outputPath` and
   * `logPaths` with it, which is what Save then copies (SOL-01).
   */
  const model = useRef<RunnerModel | null>(null)
  /**
   * Taken before any listener teardown so a second Start cannot orphan the first run (SOL-39).
   * Cleared when the run ends, the launch throws, or the user hits New.
   */
  const armed = useRef(false)

  useEffect(() => {
    return () => cleanup.current.forEach((fn) => fn())
  }, [])

  const reset = useCallback(() => {
    pending.current = []
    model.current = null
    armed.current = false
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setState(INITIAL)
  }, [])

  const start = useCallback(async (launch: (id: string) => Promise<string>) => {
    if (armed.current) return
    armed.current = true
    cleanup.current.forEach((fn) => fn())
    cleanup.current = []
    const id = mintRunId()
    model.current = initialRunnerModel(id)
    setState(model.current.state)

    const flush = (): void => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
      if (pending.current.length === 0) return
      const batch = pending.current
      pending.current = []
      const current = model.current
      if (!current || current.runId !== id) return
      const next = batch.reduce(reduceRunEvent, current)
      model.current = next
      if (next.state !== current.state) setState(next.state)
    }
    flushPending.current = flush

    const offEvent = window.api.onEngineEvent((event) => {
      // Not ours: another page's run, or a run this hook has already let go of.
      if (model.current === null || event.runId !== model.current.runId) return
      pending.current.push(event)
      if (event.type === 'finished') {
        // Nothing else can end this run now. The last lines of a run are usually the interesting
        // ones, so they are committed with the ending rather than left to a timer that unmounting
        // could cancel. A Stop ends the job through the same event, so this covers it too.
        armed.current = false
        flush()
        return
      }
      if (timer.current === null) timer.current = setTimeout(flush, FLUSH_MS)
    })

    cleanup.current = [
      offEvent,
      () => {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = null
        pending.current = []
        flushPending.current = null
      }
    ]

    try {
      await launch(id)
    } catch (e) {
      // The launch itself failed. Retiring the run here stops a later run's events being matched
      // against one that never began.
      flush()
      model.current = null
      armed.current = false
      setState((s) => ({ ...s, status: 'error', log: appendLogLine(s.log, String(e)) }))
    }
  }, [])

  const stop = useCallback(async () => {
    await window.api.stop()
    flushPending.current?.()
    // Deliberately does NOT set a terminal status. Every stop ends the job in the main process,
    // which reports it as a user stop on the same `finished` event every other ending uses — so
    // the panel says "Stopped" because the app knows it was stopped, not because the renderer
    // guessed from a non-zero exit code it cannot tell apart from a crash.
    const m = model.current
    if (!m || m.settled || m.state.status !== 'running') return
    model.current = { ...m, state: { ...m.state, statusText: 'Stopping…' } }
    setState(model.current.state)
  }, [])

  /** The run this hook follows now — the one `state` describes; null before a Start and after New. */
  const runId = useCallback((): string | null => model.current?.runId ?? null, [])

  return { state, start, stop, reset, runId }
}
