/**
 * The run's artifact session (implementation_plan.md §2.1b), first form.
 *
 * One owner for everything a run leaves on disk. `runner.ts` opens exactly one session immediately
 * after it reserves the slot and before any guard, preflight, preparation or spawn work, routes every
 * event through it once before IPC, and calls `finalize()` before delivering `finished`. Providers and
 * renderers never open run artifacts.
 *
 * It owns the `.console.log` for every run, keeping 1.1.0's console byte-for-byte: exclusive
 * creation that steps over an occupied name, synchronous source writes, the 8 MiB head / 512 KiB tail
 * / 64 KiB line ceiling and its marker, the `[run ended: …]` line, and close-before-offer.
 *
 * THE RUN RECORD (Step 4.6). `.run.jsonl` beside the console, for every run this session opens: one
 * line per event, `{"schemaVersion":1,"sequence":N,"recordedAt":"<ISO UTC>","event":{…}}`, sequence
 * one-based and contiguous, one run id, `started` first and the enriched `finished` last. Each event
 * passes the run-record allow-list and `redact()` (`redact.ts`), each string is cut at 64 KiB with the
 * console's marker, and each list is bounded by the units the run admitted. Rows are written whole,
 * one at a time, and synced every few rows and again before close, so a crash can lose only the row in
 * flight. It is additive: the console stays what a page's **Show it** opens.
 *
 * NATIVE TRANSLATE'S OPTIONAL REPORTS (Step 2.8). On the CLI, gst writes `.progress.log`,
 * `.thoughts.log` and `.tokens.json` itself and this session only owns the console. A native
 * Translate run has no gst, so the session writes them, each only when its preference was on at
 * reservation and only once the run is past its guards (a guard ending offers the console alone, as
 * the CLI's does). All three sit on the run's own temporary output stem and reach the user through
 * the same compound-suffix, no-overwrite Save. Each is claimed exclusively and then only ever
 * replaced whole — a flushed sibling, then one rename — so the file on disk at any instant is a
 * complete snapshot (gst rewrites both logs whole, `logger.py:504-583`, codebase_map.md §15.2).
 * A report whose name cannot be claimed, or whose last write failed, is not offered and costs one
 * `artifact` warning; an earlier snapshot stays readable on disk.
 *
 * THE TOKEN REPORT FOR BOTH KINDS (Bundle F, §12.10). The same writer also serves a native Transcribe
 * run: its destination is chosen before Start, so the report is claimed beside it
 * (`<output stem>.tokens.json`) at the terminal event, completed, failed or stopped, and only once at
 * least one provider request was sent. Both kinds add a `native` section after gst's keys: request and
 * retry counts, billed-but-unusable tokens, waits by reason, Quota Group switches, Paid fallback, a daily
 * stop, the per-model and per-group buckets, re-cut partitions and, for Transcribe, audio seconds. Counts,
 * indices and labels only, never content; the whole text passes `redact()` like every report.
 *
 * The console is a projection of the run's own events: everything the engine tells the user is a
 * `log` line, so the console and the panel say the same things.
 *
 * Every byte written passes `redact()` first (§10.4). Writes are fail-soft: a console that cannot be
 * opened, written or closed disables only this projection, is never offered, and surfaces exactly one
 * `artifact` warning on the terminal event. The run's outcome stays authoritative.
 */
import fs from 'fs'
import {
  clampText,
  createConsoleLog,
  consoleLogPathFor,
  CONSOLE_LOG_SUFFIX,
  DEFAULT_CONSOLE_LOG_LIMITS,
  RUN_RECORD_SUFFIX,
  runRecordPathFor,
  type ConsoleLog,
  type ConsoleLogLimits
} from '../shared/consoleLog'
import { openExclusive } from '../main/exclusiveFile'
import type {
  BudgetMetric,
  RunConfigurationSummary,
  RunEvent,
  RunKind,
  RunWarning
} from '../shared/engineEvents'
import { CONSOLE_LINE_SHAPE, createRedactor, redact, runRecordEvent } from './redact'

export type FinishedEvent = Extract<RunEvent, { type: 'finished' }>

/** The four persisted log/report preferences, as they stood when the slot was reserved. */
export interface RunArtifactPreferences {
  showTokenStats: boolean
  writeTokenReport: boolean
  progressLog: boolean
  thoughtsLog: boolean
}

export interface RunArtifactSnapshot {
  runId: string
  kind: RunKind
  /** The run's output (Translate: its staging temp; Transcribe: the chosen destination). */
  outputPath: string
  /** Every configured secret value at reservation: all Gemini slots, the TMDB key, the run's keys. */
  secrets: readonly string[]
  preferences: RunArtifactPreferences
  /**
   * Console-only: the effective description actually sent. Kept for the native console's parity
   * with today's masked `-d`; never enters `RunEvent`, IPC or JSONL.
   */
  description?: string
}

/** Fault seams for the gates; production uses the real filesystem. */
export interface RunArtifactIo {
  open(preferred: string): { fd: number; path: string } | null
  write(fd: number, chunk: string): void
  close(fd: number): void
  /** Create a report's file empty and exclusively, stepping over an occupied name; null if none is free. */
  claim(preferred: string, suffix: string): string | null
  /** Replace a claimed report's whole content: written and flushed beside it, then renamed over it. */
  replace(file: string, content: string): void
  /** The run record: created exclusively, stepping over an occupied name; null if none is free. */
  openRecord(preferred: string): { fd: number; path: string } | null
  /** Append one whole row. */
  appendRecord(fd: number, row: string): void
  /** Flush what has been appended to the disk. */
  syncRecord(fd: number): void
  closeRecord(fd: number): void
}

/**
 * Waits before each retry of a refused rename. Windows refuses about 2% of rapid renames over a fresh
 * file in `%TEMP%` with `EPERM` while a scanner holds it; these cleared 8 000 of 8 000 in a stress run
 * (at most 75 ms needed). Synchronous because a report is written on the event path, so the sum is
 * the most a run can stall on one write.
 */
export const REPORT_RENAME_RETRY_DELAYS_MS: readonly number[] = [5, 10, 20, 40, 80]
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const retryPause = new Int32Array(new SharedArrayBuffer(4))

/** `rename(from, to)`, retried on a transient refusal; anything else, or the last refusal, throws. */
export function renameOver(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = fs.renameSync,
  pause: (ms: number) => void = (ms) => void Atomics.wait(retryPause, 0, 0, ms)
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt >= REPORT_RENAME_RETRY_DELAYS_MS.length) throw err
      pause(REPORT_RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

const realIo: RunArtifactIo = {
  open: (preferred) => openExclusive(preferred, CONSOLE_LOG_SUFFIX),
  write: (fd, chunk) => {
    fs.writeSync(fd, chunk)
  },
  close: (fd) => fs.closeSync(fd),
  claim: (preferred, suffix) => {
    const opened = openExclusive(preferred, suffix)
    if (!opened) return null
    fs.closeSync(opened.fd)
    return opened.path
  },
  replace: (file, content) => {
    const staged = `${file}.${process.pid}.tmp`
    try {
      const fd = fs.openSync(staged, 'w')
      try {
        fs.writeFileSync(fd, content)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      renameOver(staged, file)
    } catch (err) {
      try {
        fs.unlinkSync(staged)
      } catch {
        /* never created, or already renamed */
      }
      throw err
    }
  },
  openRecord: (preferred) => openExclusive(preferred, RUN_RECORD_SUFFIX),
  appendRecord: (fd, row) => {
    const bytes = Buffer.from(row, 'utf8')
    let written = 0
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written)
  },
  syncRecord: (fd) => fs.fsyncSync(fd),
  closeRecord: (fd) => fs.closeSync(fd)
}

export const RUN_RECORD_SCHEMA_VERSION = 1
/** Any one persisted string, cut on a character boundary with the console's marker. */
export const RUN_RECORD_STRING_BYTES = DEFAULT_CONSOLE_LOG_LIMITS.lineBytes
/** A list in a row keeps at most this many entries plus four per unit the run admitted. */
export const RUN_RECORD_RUN_LEVEL_ITEMS = 32
export const RUN_RECORD_ITEMS_PER_UNIT = 4
/** A non-terminal row past this size ends the record unoffered; the console's own ceiling. */
export const RUN_RECORD_BUDGET_BYTES = DEFAULT_CONSOLE_LOG_LIMITS.headBytes + DEFAULT_CONSOLE_LOG_LIMITS.tailBytes
/** The record is synced after this many rows or this long since the last sync, and before close. */
export const RUN_RECORD_SYNC_ROWS = 32
export const RUN_RECORD_SYNC_MS = 2000

/** Strings clamped, lists cut to `maxItems`, recursively. */
function boundRecordValue(value: unknown, maxItems: number): unknown {
  if (typeof value === 'string') return clampText(value, RUN_RECORD_STRING_BYTES)
  if (Array.isArray(value)) return value.slice(0, maxItems).map((v) => boundRecordValue(v, maxItems))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, boundRecordValue(v, maxItems)]))
  }
  return value
}

export const PROGRESS_LOG_SUFFIX = '.progress.log'
export const THOUGHTS_LOG_SUFFIX = '.thoughts.log'
export const TOKEN_REPORT_SUFFIX = '.tokens.json'

/** gst's section rule in `.thoughts.log` (`logger.py:570,576`). */
const THOUGHTS_RULE = '='.repeat(80)

/** A report on the run's output stem, e.g. `<temp stem>.progress.log`. */
function reportPathFor(outputPath: string, suffix: string): string {
  return `${outputPath.replace(/\.[^.]+$/, '')}${suffix}`
}

/** The four Logs choices as the run froze them, in the Settings panel's order. */
function logsOf(c: RunConfigurationSummary): string {
  const on = [
    c.showTokenStats ? 'token stats' : '',
    c.writeTokenReport ? 'token report' : '',
    c.progressLog ? 'progress log' : '',
    c.thoughtsLog ? 'thoughts log' : ''
  ].filter(Boolean)
  return on.length ? on.join(', ') : 'none'
}

/** gst's `datetime.now().isoformat()`, local time, to the millisecond JavaScript has. */
function localTimestamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export interface ThoughtSummary {
  unit: number
  attempt: number
  text: string
}

export interface RunArtifactSession {
  readonly snapshot: Readonly<RunArtifactSnapshot>
  /** The console's path while it is healthy; null when it could not be opened or has failed. */
  consolePath(): string | null
  /** One non-terminal event, exactly once, before renderer delivery. */
  record(event: RunEvent): void
  /** Explicitly labelled provider thought summaries; inert unless Translate's `thoughtsLog` is on. */
  recordThoughtSummary(summary: ThoughtSummary): void
  /** The started event's configuration, captured for the run's own projections. */
  readonly config: () => RunConfigurationSummary | null
  /**
   * Complete the run: write the ending, close, add surviving paths and any `artifact` warning, and
   * return the one enriched terminal event. A second call is a counted no-op returning the same event.
   */
  finalize(base: FinishedEvent): FinishedEvent
  /** Shutdown with no terminal event coming: close what is open, offer nothing. */
  abort(): void
  readonly stats: { recorded: number; thoughtSummaries: number; finalizeCalls: number; duplicateFinalize: number; recordRows: number }
}

type ConsoleFault = 'open' | 'write' | 'close'
/** The record alone can also run out of room: a record missing rows is never offered as whole. */
type RecordFault = ConsoleFault | 'budget'

const FAULT_COPY: Record<RecordFault, string> = {
  open: 'could not be created',
  write: 'could not be written in full',
  close: 'could not be closed',
  budget: 'grew past its size limit'
}

/**
 * One optional report: claimed once, then replaced whole. Only the LAST write decides whether it is
 * offered — an earlier refresh that failed is repaired by a later one that succeeds.
 */
interface Report {
  readonly name: string
  readonly suffix: string
  path: string | null
  fault: 'open' | 'write' | null
}

export function openRunArtifacts(
  snapshot: RunArtifactSnapshot,
  options: { io?: Partial<RunArtifactIo>; limits?: Partial<ConsoleLogLimits>; now?: () => number; recordBudgetBytes?: number } = {}
): RunArtifactSession {
  const io: RunArtifactIo = { ...realIo, ...options.io }
  const frozen: Readonly<RunArtifactSnapshot> = Object.freeze({
    ...snapshot,
    secrets: Object.freeze([...snapshot.secrets]),
    preferences: Object.freeze({ ...snapshot.preferences })
  })
  const redactor = createRedactor(frozen.secrets)
  const stats = { recorded: 0, thoughtSummaries: 0, finalizeCalls: 0, duplicateFinalize: 0, recordRows: 0 }

  let fault: ConsoleFault | null = null
  let fd: number | null = null
  let logPath: string | null = null
  let log: ConsoleLog | null = null
  let closed = false
  let startedConfig: RunConfigurationSummary | null = null
  let finalized: FinishedEvent | null = null

  const now = options.now ?? Date.now
  const openedAt = now()
  /** Native Translate is the only run whose optional reports this session writes (see the header). */
  const ownsReports = frozen.kind === 'translate'
  const prefs = frozen.preferences
  const progressReport: Report | null = ownsReports && prefs.progressLog ? { name: 'progress log', suffix: PROGRESS_LOG_SUFFIX, path: null, fault: null } : null
  const thoughtsReport: Report | null = ownsReports && prefs.thoughtsLog ? { name: 'thoughts log', suffix: THOUGHTS_LOG_SUFFIX, path: null, fault: null } : null
  /** Translate writes it once work began; Transcribe once a request was sent (see the header). */
  const tokenReport: Report | null = prefs.writeTokenReport ? { name: 'token report', suffix: TOKEN_REPORT_SUFFIX, path: null, fault: null } : null
  /** Set by the run's first `phase`: the adapter's guards have all passed and work has begun. */
  let working = false
  let progressLine = ''
  const diagnostics: string[] = []
  const seenDiagnostics = new Set<string>()
  const thoughtSections: string[] = []
  let linesDone = 0
  let linesTotal = 0
  /** Pacing as the run's budget events said it, for the token report: bounded by metric. */
  const waits = new Map<BudgetMetric, { count: number; ms: number }>()
  let waitingSince: { metric: BudgetMetric; at: number } | null = null
  const pacing = { groupSwitches: 0, paidFallback: false, dailyStop: false }
  const closeWait = (): void => {
    if (!waitingSince) return
    const w = waits.get(waitingSince.metric) ?? { count: 0, ms: 0 }
    w.count++
    w.ms += Math.max(0, now() - waitingSince.at)
    waits.set(waitingSince.metric, w)
    waitingSince = null
  }
  const notePacing = (event: RunEvent): void => {
    if (event.type !== 'budget') return
    closeWait()
    const b = event.budget
    if (b.state === 'waiting') waitingSince = { metric: b.metric, at: now() }
    else if (b.state === 'groupSwitch') pacing.groupSwitches++
    else if (b.state === 'paidFallback') pacing.paidFallback = true
    else if (b.state === 'dailyExhausted') pacing.dailyStop = true
  }

  const claim = (r: Report): void => {
    if (!frozen.outputPath) return
    try {
      r.path = io.claim(reportPathFor(frozen.outputPath, r.suffix), r.suffix)
    } catch {
      r.path = null
    }
    if (!r.path) r.fault = 'open'
  }
  const put = (r: Report | null, content: string): void => {
    if (!r?.path) return
    try {
      io.replace(r.path, redactor.text(content))
      r.fault = null
    } catch {
      r.fault = 'write'
    }
  }

  /** gst's progress log: the latest progress line, a blank line, every distinct diagnostic so far. */
  const progressText = (): string => `${progressLine}\n\n${diagnostics.map((d) => `${d}\n`).join('')}`
  const noteDiagnostic = (text: string): void => {
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t || seenDiagnostics.has(t)) continue
      seenDiagnostics.add(t)
      diagnostics.push(t)
    }
  }
  const linesPart = (): string =>
    linesTotal > 0 ? `${linesDone}/${linesTotal} lines (${Math.min(100, Math.floor((100 * linesDone) / linesTotal))}%)` : ''

  /** Native Translate's reports, from the run's own events. Returns true when the progress log moved. */
  const projectReports = (event: RunEvent): boolean => {
    if (event.type === 'phase' && !working) {
      working = true
      if (progressReport) claim(progressReport)
      if (thoughtsReport) claim(thoughtsReport)
    }
    if (!progressReport) return false
    switch (event.type) {
      case 'phase':
        progressLine = event.phase === 'preparing' ? 'Preparing…' : event.phase === 'working' ? 'Starting…' : event.phase === 'finishing' ? `Saving the translation… ${linesPart()}`.trim() : progressLine
        return true
      case 'lines':
        linesDone = event.done
        linesTotal = event.total ?? linesTotal
        progressLine = `Translating: ${linesPart()}`
        return true
      case 'unit': {
        if (!event.lineRange) return false
        const { from, to } = event.lineRange
        const attempt = (event.attempt ?? 1) > 1 ? `, attempt ${event.attempt}` : ''
        progressLine = `Translating: ${linesPart() || '0 lines'} · batch ${event.index} of ${event.total ?? '?'} (lines ${from}\u2013${to}): ${event.state}${attempt}`
        return true
      }
      case 'log':
        if (event.stream !== 'stderr') return false
        noteDiagnostic(event.text)
        return true
      case 'warning':
        noteDiagnostic(event.warning.message)
        return true
      case 'error':
        noteDiagnostic(event.error.message)
        return true
      default:
        return false
    }
  }

  /** What the native engine adds after gst's keys: counts, indices and labels only. */
  const nativeSection = (end: FinishedEvent): Record<string, unknown> => {
    const u = end.usage
    return {
      requests: u?.requestCount ?? 0,
      retries: u?.retryCount ?? 0,
      billed_but_unusable_tokens: u?.billedButUnusableTokens ?? 0,
      ...(frozen.kind === 'transcribe'
        ? { audio_seconds: { submitted: u?.audioSecondsSubmitted ?? 0, usable: u?.audioSecondsUsable ?? 0, re_requested: u?.reRequestedAudioSeconds ?? 0 } }
        : {}),
      waits: [...waits].map(([reason, w]) => ({ reason, count: w.count, seconds: Math.round(w.ms / 100) / 10 })),
      group_switches: pacing.groupSwitches,
      paid_fallback: pacing.paidFallback,
      daily_stop: pacing.dailyStop,
      buckets: (u?.buckets ?? []).map((b) => ({
        model: b.model,
        ...(b.quotaGroupLabel ? { quota_group: b.quotaGroupLabel } : {}),
        request_kind: b.requestKind,
        attempts: b.attempts,
        ...(b.estimatedInputTokens !== undefined ? { estimated_input_tokens: b.estimatedInputTokens } : {}),
        input_tokens: b.actualInputTokens ?? 0,
        output_tokens: b.outputTokens ?? 0,
        thought_tokens: b.thoughtTokens ?? 0,
        ...(b.billedButUnusableTokens ? { billed_but_unusable_tokens: b.billedButUnusableTokens } : {}),
        ...(b.retryReasons ? { failed_attempts_by_reason: { ...b.retryReasons } } : {})
      })),
      partitions: (u?.translationPartitions ?? []).map((p) => ({
        first_line: p.firstCueIndex,
        last_line: p.lastCueIndex,
        requested_lines: p.requestedLineCount,
        effective_lines: p.effectiveLineCount,
        reason: p.reason
      }))
    }
  }

  /** The token report in gst's shape (`gates.ts` G3b, REP-1's captured report), cost aside, then `native`. */
  const tokenReportText = (end: FinishedEvent): string => {
    const u = end.usage
    const c = startedConfig
    return JSON.stringify(
      {
        timestamp: localTimestamp(now()),
        mode: frozen.kind,
        model: c?.model ?? '',
        output_file: frozen.outputPath,
        duration_seconds: Math.round((now() - openedAt) / 10) / 100,
        tokens: { prompt: u?.promptTokens ?? 0, thoughts: u?.thoughtTokens ?? 0, output: u?.outputTokens ?? 0, total: u?.totalTokens ?? 0 },
        input_file: c?.inputPaths[0] ?? '',
        target_language: c?.targetLanguage ?? '',
        native: nativeSection(end)
      },
      null,
      2
    )
  }

  if (frozen.outputPath) {
    try {
      const opened = io.open(consoleLogPathFor(frozen.outputPath))
      if (opened) {
        fd = opened.fd
        logPath = opened.path
      } else {
        fault = 'open'
      }
    } catch {
      fault = 'open'
    }
  }
  if (fd !== null) {
    const handle = fd
    log = createConsoleLog(
      (chunk) => {
        if (fault) return
        try {
          io.write(handle, chunk)
        } catch {
          // A full disk or a revoked handle: stop trying rather than throw once per line into a path
          // that is only observing.
          fault = 'write'
        }
      },
      options.limits
    )
  }

  let recordFd: number | null = null
  let recordPath: string | null = null
  let recordFault: RecordFault | null = null
  let recordClosed = false
  let recordBytes = 0
  let rowsSinceSync = 0
  let lastSync = now()
  let admittedUnits = 0
  const recordBudget = options.recordBudgetBytes ?? RUN_RECORD_BUDGET_BYTES
  if (frozen.outputPath) {
    try {
      const opened = io.openRecord(runRecordPathFor(frozen.outputPath))
      if (opened) {
        recordFd = opened.fd
        recordPath = opened.path
      } else {
        recordFault = 'open'
      }
    } catch {
      recordFault = 'open'
    }
  }

  const noteUnits = (event: RunEvent): void => {
    if (event.type === 'started') admittedUnits = Math.max(admittedUnits, event.totalUnits ?? 0)
    if (event.type === 'unit') admittedUnits = Math.max(admittedUnits, event.index, event.total ?? 0)
  }

  /**
   * One row, whole. A non-terminal row past the budget stops the record: nothing more is written,
   * its path is withheld and one warning says why. Only the record stops; the run and its other
   * artifacts go on.
   */
  const appendRow = (event: RunEvent, terminal: boolean): void => {
    if (recordFd === null || recordFault || recordClosed) return
    const projected = runRecordEvent(event, redactor)
    if (!projected) return
    const maxItems = RUN_RECORD_RUN_LEVEL_ITEMS + RUN_RECORD_ITEMS_PER_UNIT * admittedUnits
    const row = `${JSON.stringify({
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      sequence: stats.recordRows + 1,
      recordedAt: new Date(now()).toISOString(),
      event: boundRecordValue(projected, maxItems)
    })}\n`
    const size = Buffer.byteLength(row, 'utf8')
    if (!terminal && recordBytes + size > recordBudget) {
      recordFault = 'budget'
      return
    }
    try {
      io.appendRecord(recordFd, row)
    } catch {
      recordFault = 'write'
      return
    }
    stats.recordRows++
    recordBytes += size
    rowsSinceSync++
    if (terminal || rowsSinceSync >= RUN_RECORD_SYNC_ROWS || now() - lastSync >= RUN_RECORD_SYNC_MS) {
      try {
        io.syncRecord(recordFd)
        rowsSinceSync = 0
        lastSync = now()
      } catch {
        recordFault = 'write'
      }
    }
  }

  const closeRecord = (): void => {
    if (recordClosed) return
    recordClosed = true
    if (recordFd === null) return
    try {
      io.closeRecord(recordFd)
    } catch {
      if (!recordFault) recordFault = 'close'
    }
  }

  const writeLine = (line: string): void => {
    if (closed || !log) return
    const safe = redact(line, CONSOLE_LINE_SHAPE, redactor)
    if (typeof safe === 'string') log.write(safe)
  }

  /**
   * The native console (Step 1.9): a projection of the run's own events. The started summary and the
   * console-only description stand where the CLI's masked command line stands; after that, exactly
   * the `log` lines the panel shows. Everything the native adapter tells the user is a `log` line, so
   * nothing the panel shows is missing here and nothing here was hidden from the panel.
   */
  const projectNative = (event: RunEvent): void => {
    if (event.type === 'log') {
      writeLine(event.text)
      return
    }
    if (event.type !== 'started') return
    const c = event.config
    const input = c.inputPaths[0] ?? ''
    writeLine(`[native engine] ${event.kind} "${input}" -> "${c.outputPath}"`)
    const facts = [
      `model ${c.model}`,
      c.thinkingLevel ? `thinking level ${c.thinkingLevel}` : c.thinkingBudget !== undefined ? `thinking budget ${c.thinkingBudget}` : 'no thinking setting',
      `service tier ${c.serviceTier ?? 'standard'}`,
      `${c.credentialSlotCount} API key${c.credentialSlotCount === 1 ? '' : 's'}`,
      ...(c.requestedChunkSeconds !== undefined ? [`parts of ${c.requestedChunkSeconds} s`] : []),
      ...(event.kind === 'translate' && c.targetLanguage ? [`into ${c.targetLanguage}`] : []),
      ...(event.kind === 'translate' && c.requestedBatchSize !== undefined ? [`batches of up to ${c.requestedBatchSize}`] : []),
      ...(c.sourceLanguage ? [`from ${c.sourceLanguage}`] : []),
      ...(c.generation?.temperature !== undefined ? [`temperature ${c.generation.temperature}`] : []),
      ...(c.generation?.topP !== undefined ? [`top-p ${c.generation.topP}`] : []),
      ...(c.generation?.topK !== undefined ? [`top-k ${c.generation.topK}`] : []),
      ...(event.kind === 'transcribe' ? [c.hasVideo ? 'audio from the video' : 'audio file'] : []),
      ...(event.kind === 'translate' && c.inputPaths[1] ? [`with audio "${c.inputPaths[1]}"`] : []),
      ...(event.kind === 'translate' && c.hasVideo ? ['with video'] : []),
      ...(c.hasSystemPrompt ? ['custom system prompt'] : []),
      `logs: ${logsOf(c)}`
    ]
    writeLine(facts.join(' · '))
    if (frozen.description?.trim()) writeLine(`description: ${frozen.description.trim()}`)
  }

  const closeConsole = (): void => {
    if (closed) return
    closed = true
    if (log) log.close()
    if (fd !== null) {
      try {
        io.close(fd)
      } catch {
        if (!fault) fault = 'close'
      }
    }
  }

  return {
    snapshot: frozen,
    consolePath: () => (fault || !logPath ? null : logPath),
    record(event) {
      if (finalized || event.type === 'finished') return
      stats.recorded++
      if (event.type === 'started' && !startedConfig) startedConfig = event.config
      projectNative(event)
      if (ownsReports && projectReports(event)) put(progressReport, progressText())
      notePacing(event)
      noteUnits(event)
      appendRow(event, false)
    },
    recordThoughtSummary(summary) {
      if (finalized) return
      if (frozen.kind !== 'translate' || !frozen.preferences.thoughtsLog) return
      if (typeof summary?.text !== 'string') return
      stats.thoughtSummaries++
      if (!thoughtsReport?.path) return
      // gst 3.7.0's section, byte for byte (`logger.py:569-578`); `retry` is the batch's resend index
      // (`main.py:1199-1210`), so a second attempt is `.1`. gst numbers a first try by its position in
      // the list, which a retry shifts; this uses the batch's own number.
      const heading = summary.attempt > 1 ? `Batch ${summary.unit}.${summary.attempt - 1} thoughts (retry):` : `Batch ${summary.unit} thoughts:`
      thoughtSections.push(`${THOUGHTS_RULE}\n\n${heading}\n\n${THOUGHTS_RULE}\n\n${summary.text}\n\n`)
      put(thoughtsReport, thoughtSections.join(''))
    },
    config: () => startedConfig,
    finalize(base) {
      stats.finalizeCalls++
      if (finalized) {
        stats.duplicateFinalize++
        return finalized
      }
      closeWait()
      // A Translate console says the run's total in gst's token-tally words, once, before its ending.
      const u = base.usage
      if (ownsReports && u) {
        writeLine(`Prompt Tokens: ${u.promptTokens} | Thoughts Tokens: ${u.thoughtTokens} | Output Tokens: ${u.outputTokens} | Total Tokens: ${u.totalTokens}`)
      }
      // How the run ended is the one fact the console never carries: the panel shows it as a status.
      // A run has no exit code, so it says its outcome instead.
      writeLine(`[run ended: ${base.outcome}${base.reason ? `, ended by the app: ${base.reason}` : ''}]`)
      // Closed BEFORE the terminal event, so whatever the renderer does next — offer a Save that copies
      // this file, or open its folder — is looking at a complete one.
      closeConsole()
      const offered = !fault && logPath ? logPath : null
      const warnings: RunWarning[] = [...base.warnings]

      // The reports' last word, written before the terminal event for the same reason. A guard ending
      // never began work and leaves none, as the CLI's offers none.
      const reports: string[] = []
      if (ownsReports && working) {
        if (progressReport) {
          const outcome = base.outcome === 'completed' ? 'Completed' : base.outcome === 'stopped' ? 'Stopped' : 'Failed'
          progressLine = `${outcome}${linesPart() ? `: ${linesPart()}` : ''}`
          if (base.error) noteDiagnostic(base.error.message)
          put(progressReport, progressText())
        }
        if (thoughtsReport && thoughtsReport.fault === 'write') put(thoughtsReport, thoughtSections.join(''))
        if (tokenReport) {
          claim(tokenReport)
          put(tokenReport, tokenReportText(base))
        }
      }
      // Transcribe's destination is already chosen: the report lands beside it on any ending that sent a request.
      if (frozen.kind === 'transcribe' && tokenReport && (base.usage?.requestCount ?? 0) > 0) {
        claim(tokenReport)
        put(tokenReport, tokenReportText(base))
      }
      if ((ownsReports && working) || frozen.kind === 'transcribe') {
        for (const r of [tokenReport, progressReport, thoughtsReport]) {
          if (!r) continue
          if (r.path && !r.fault) reports.push(r.path)
          else if (r.fault) {
            warnings.push({
              code: 'artifact',
              message: `This run's ${r.name} ${FAULT_COPY[r.fault]}, so it is not offered. The run's own result is unaffected.`
            })
          }
        }
      }
      if (fault) {
        warnings.push({
          code: 'artifact',
          message: `This run's console log ${FAULT_COPY[fault]}, so it is not offered. The run's own result is unaffected.`
        })
      }
      const paths = [...base.logPaths, ...reports.filter((p) => !base.logPaths.includes(p))]
      // The reports, then the record, then the console last, as before the record existed.
      const offeredWith = (record: string | null): string[] => {
        const withRecord = record && !paths.includes(record) ? [...paths, record] : paths
        return offered && !withRecord.includes(offered) ? [...withRecord, offered] : withRecord
      }
      // The record's last row is the ending as it will be delivered while the record is healthy;
      // synced and closed before the terminal event, and offered only if all of that held.
      if (recordPath && !recordFault) appendRow({ ...base, logPaths: offeredWith(recordPath), warnings }, true)
      closeRecord()
      const record = recordPath && !recordFault ? recordPath : null
      if (recordFault) {
        warnings.push({
          code: 'artifact',
          message: `This run's run record ${FAULT_COPY[recordFault]}, so it is not offered. The run's own result is unaffected.`
        })
      }
      finalized = {
        ...base,
        logPaths: offeredWith(record),
        warnings
      }
      return finalized
    },
    abort() {
      closeConsole()
      closeRecord()
    },
    stats
  }
}
