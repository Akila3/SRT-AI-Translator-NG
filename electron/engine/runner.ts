/**
 * The one job the app runs at a time, and everything that ends it (implementation_plan.md Step 1.1,
 * §2.1b, §2.2a). AUTHORED-BY: opus-5.5-high
 *
 * Moved out of `pythonBridge` at Step 1.1, because two adapters cannot share a lock that lives
 * inside one of them. The six lifecycle invariants travel with it unchanged:
 *
 *  1. `finishJob()` is the only terminal path; idempotent, it fires the callback exactly once,
 *     releases the slot and deletes scratch.
 *  2. `killJob()` is the only killer, and the kill is a TREE kill.
 *  3. Every caller sets `endReason` BEFORE killing: `close` fires asynchronously and reads it.
 *  4. Nothing may throw out of a start, or the slot is held for the life of the process.
 *  5. Every refused start still emits a terminal event. Only the outer model guard and a busy slot
 *     omit `started` and artifacts.
 *  6. A failed `taskkill` has a listener — an unheard `error` is the end of the application — and
 *     either failure is followed by asking the child directly (signal 0; `EPERM` counts as alive).
 *
 * And the ownership the native engine needs (§2.2a): the runner captures the adapter instance and an
 * `AbortController` at start, and every run gets a monotonic epoch. A run's events pass through its artifact session once, before IPC; its
 * `finished` is finalised before delivery, and anything after it is dropped and counted.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import path from 'path'
import { forceKillTree, hasExited, livePid, waitForChildExit } from '../main/processExit'
import type { RunEvent, RunKind } from '../shared/engineEvents'
import type { FfmpegProgress, TerminalReason, TranscribeArgs, TranslateArgs } from '../shared/types'
import type { EngineAdapter, Emit, RunContext, SettingsRevisionSource, StartedRun } from './adapter'
import { translationSnapshot } from './prompt'
import { openRunArtifacts, type RunArtifactIo, type RunArtifactPreferences, type RunArtifactSession, type ThoughtSummary } from './runArtifacts'

/** What a job reports through. The bridge's `SpawnHandlers` is this shape. */
export interface RunHandlers {
  onOutput: (stream: 'stdout' | 'stderr', line: string) => void
  /**
   * `logPaths` is optional and additional: the console is no longer the bridge's to report — the
   * artifact session adds it to `finished` — but a caller that declares it stays valid.
   */
  onDone: (code: number | null, outputPath: string, reason?: TerminalReason, logPaths?: string[]) => void
  /**
   * How far the job's ffmpeg preparation has got. Optional: it is a second channel, not a second
   * meaning for the first, so every caller — including the probes, which have no window — stays
   * valid by simply not listening.
   */
  onProgress?: (p: FfmpegProgress) => void
}

/**
 * The slot is reserved for the whole lifetime of a job, not just the life of a spawned process:
 * transcription prepares (key check, conversion) before anything is spawned, and during that window
 * a process-shaped lock would report idle — Stop would find nothing to kill and a second job could
 * start and later be refused with no terminal event.
 */
export interface Job {
  /** A spawned child the run owns. The native engine spawns none, so in the product it stays null. */
  proc: ChildProcessWithoutNullStreams | null
  /** Aborts an in-flight preparation step. Null when nothing is being prepared. */
  prep: AbortController | null
  /**
   * Set when the APP ends the run rather than the engine, and carried through to the renderer so it
   * can say what happened. Non-null also means "this job has been told to stop".
   */
  endReason: TerminalReason | null
  /** Temp files this job created and owns. Deleted when it ends, whatever the outcome. */
  scratch: string[]
  /**
   * A preparation child this job started — the key preflight or an audio conversion. Set the moment
   * that process exists: shutdown and a second Stop need a ChildProcess, not a reusable pid (SOL-16).
   */
  prepChild: ChildProcess | null
  finished: boolean
  /** The handlers every later message goes through; they tee into the run's console. */
  handlers: RunHandlers
  outputPath: string
  /** The run's generation. A callback carrying an older one is a run that has already ended. */
  readonly epoch: number
  /**
   * The run's artifact session. Deliberately NOT scratch: scratch is deleted when the job ends and
   * the console exists to outlive it. Null for a reservation no runner-started run owns.
   */
  readonly artifacts: RunArtifactSession | null
}

/**
 * How an adapter tells the runner which run a set of handlers belongs to, so that reserving the slot
 * can open that run's artifact session and mint its one `started`. Symbol-keyed so it survives the
 * `{ ...handlers }` copies callers make to add a progress listener.
 */
export const RUN_BINDING: unique symbol = Symbol('srt.runBinding')

export interface RunBinding {
  readonly ctx: RunContext
  /** Called exactly once, by `reserveJob`, on the reserved path only. */
  started(outputPath: string): void
}

type Bound = { [RUN_BINDING]?: RunBinding }

export function bindRun<H extends object>(handlers: H, binding: RunBinding): H {
  Object.defineProperty(handlers, RUN_BINDING, { value: binding, enumerable: true })
  return handlers
}

interface RunRecord {
  readonly ctx: RunContext
  readonly kind: RunKind
  readonly adapter: EngineAdapter
  readonly controller: AbortController
  readonly deliver: Emit
  readonly snapshot: {
    secrets: readonly string[]
    preferences: RunArtifactPreferences
    description?: string
  }
  readonly artifactIo?: Partial<RunArtifactIo>
  artifacts: RunArtifactSession | null
  closed: boolean
}

const records = new WeakMap<RunContext, RunRecord>()
let job: Job | null = null
let epochCounter = 0
let droppedEvents = 0

/** Events that arrived after their run's `finished`, or carried another run's id. */
export function droppedEventCount(): number {
  return droppedEvents
}

export function currentEpoch(): number {
  return job?.epoch ?? 0
}

/** Windows can hold a file for a moment after the process that had it open has exited. */
const SCRATCH_RETRY_MS = 2_000

/** The filesystem calls scratch cleanup makes. Injectable so the gates can hold a file open. */
export interface ScratchIo {
  unlink(file: string): void
  /** Which file is at this name — the same name can hold a different file later. Null if none. */
  identity(file: string): string | null
  later(fn: () => void, ms: number): void
}

const NODE_SCRATCH_IO: ScratchIo = {
  unlink: (file) => fs.unlinkSync(file),
  identity: (file) => {
    try {
      const s = fs.statSync(file, { bigint: true })
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.birthtimeNs}`
    } catch {
      return null
    }
  },
  later: (fn, ms) => setTimeout(fn, ms).unref()
}

let scratchIo: ScratchIo = NODE_SCRATCH_IO

/** Gates only: replace the scratch filesystem calls; `null` restores the real ones. */
export function useScratchIo(io: Partial<ScratchIo> | null): void {
  scratchIo = io ? { ...NODE_SCRATCH_IO, ...io } : NODE_SCRATCH_IO
}

/** Counts every reservation, so a delayed cleanup can tell whether a later run has started. */
let reservations = 0

function deleteScratch(j: Job): void {
  const io = scratchIo
  for (const file of j.scratch) {
    try {
      io.unlink(file)
    } catch (e) {
      // Best effort: a temp file we cannot delete must not fail the job. A missing one (the engine
      // already removed it) needs nothing; one still held open gets one more try.
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') continue
      // The retry runs after the slot is free, so the name alone no longer proves the file is this
      // job's: a later run may be using it (gst reuses an `_extracted.mp3` it finds), or another file
      // may have taken its place. Delete only the same file, and only if no run has started since.
      const identity = io.identity(file)
      const generation = reservations
      if (identity === null) continue
      io.later(() => {
        if (reservations !== generation || job !== null || io.identity(file) !== identity) return
        try {
          io.unlink(file)
        } catch {
          /* still best effort */
        }
      }, SCRATCH_RETRY_MS)
      j.handlers.onOutput(
        'stderr',
        `Could not delete the temporary file "${path.basename(file)}" yet (${code}). It is tried once more in a ` +
          'few seconds unless another run has started by then; if it is still there afterwards, it is safe to delete.'
      )
    }
  }
  j.scratch = []
}

function settle(j: Job): void {
  j.finished = true
  if (job === j) job = null
  deleteScratch(j)
}

/**
 * Reserve the single job slot, or return null if one is already held.
 *
 * On success, and before anything else is said about the run: open its artifact session (when a
 * runner-started run owns these handlers), install the teeing handlers, and mint its `started`.
 * A busy refusal does none of that — it never reserved anything.
 */
export function reserveJob(handlers: RunHandlers, outputPath: string): Job | null {
  if (job) return null
  const binding = (handlers as Bound)[RUN_BINDING]
  const rec = binding ? records.get(binding.ctx) : undefined
  let artifacts: RunArtifactSession | null = null
  if (rec && !rec.closed) {
    try {
      artifacts = openRunArtifacts(
        {
          runId: rec.ctx.runId,
          kind: rec.kind,
          outputPath,
          secrets: rec.snapshot.secrets,
          preferences: rec.snapshot.preferences,
          ...(rec.snapshot.description !== undefined ? { description: rec.snapshot.description } : {})
        },
        rec.artifactIo ? { io: rec.artifactIo } : {}
      )
    } catch {
      artifacts = null
    }
    rec.artifacts = artifacts
  }
  const j: Job = {
    proc: null,
    prep: null,
    endReason: null,
    scratch: [],
    prepChild: null,
    finished: false,
    handlers,
    outputPath,
    epoch: binding ? binding.ctx.epoch : ++epochCounter,
    artifacts
  }
  j.handlers = {
    ...handlers,
    onDone: (code, out, reason, logPaths) => {
      if (j.finished) return
      settle(j)
      handlers.onDone(code, out, reason, logPaths)
    }
  }
  job = j
  reservations++
  binding?.started(outputPath)
  return j
}

/**
 * A provider's thought summary for the run that holds the slot (`.thoughts.log`, Step 2.8). Not an
 * event: thoughts never reach IPC, the panel or the console. Anything for another run, or for one
 * that has ended, is ignored.
 */
export function recordThoughtSummary(runId: string, summary: ThoughtSummary): void {
  const j = job
  if (!j || j.finished || !j.artifacts || j.artifacts.snapshot.runId !== runId) return
  j.artifacts.recordThoughtSummary(summary)
}

/**
 * The report preferences frozen for this run at Start — the same values its artifact session obeys —
 * or null for a context the runner did not start. A copy; never a Settings read.
 */
export function frozenPreferencesFor(ctx: RunContext): RunArtifactPreferences | null {
  const rec = records.get(ctx)
  return rec ? { ...rec.snapshot.preferences } : null
}

/**
 * A start that threw after reserving. The adapter still owes its caller one `finished`; this makes
 * sure the slot it took does not outlive the throw (invariant 4).
 */
export function releaseReservation(binding: RunBinding): void {
  const j = job
  if (!j || j.finished) return
  if ((j.handlers as Bound)[RUN_BINDING] !== binding) return
  settle(j)
}

/**
 * End a job exactly once: release the slot, remove its scratch files, emit the terminal event.
 * Idempotent, because several paths can race to end the same job (a Stop that kills the child, and
 * the child's own `close`). The run's ending line and the console close happen when that terminal
 * event reaches the artifact session — before it is delivered.
 */
export function finishJob(j: Job, code: number | null): void {
  if (j.finished) return
  j.handlers.onDone(code, j.outputPath, j.endReason ?? undefined)
}

export function stillHasPrepChild(j: Job): boolean {
  return !!j.prepChild && !hasExited(j.prepChild)
}

/**
 * Take ownership of a preparation process that outlived its kill.
 *
 * The job stays open while it lives: ending the run releases the single slot, and a slot released
 * while a process is alive is what puts two engines on one API key. The watcher is the child's own
 * `close` — not a pid poll, because a pid is reusable and a stranger can inherit it (SOL-16).
 */
export function ownOrphan(j: Job, child: ChildProcess | undefined): void {
  if (j.finished) return
  if (!child) {
    j.handlers.onOutput(
      'stderr',
      'A process from this run may still be going, but it did not leave a handle to wait on. ' +
        'This run stays open; end that process from Task Manager, or restart the app, before starting another.'
    )
    return
  }
  j.prepChild = child
  const onClose = (): void => {
    if (j.finished) return
    j.handlers.onOutput('stdout', 'The process that would not stop has exited; ending the run.')
    finishJob(j, -1)
  }
  child.once('close', onClose)
  // If the child has already been reaped in the gap, close is coming or has just fired; the listener
  // plus this tick covers both without polling a pid.
  if (hasExited(child)) {
    setImmediate(() => {
      if (!j.finished) onClose()
    })
  }
}

/**
 * Kill the job's child process, whoever asked.
 *
 * One code path for a user's Stop and for the app's own termination, because the two differ only in
 * the reason recorded — and a second copy would eventually diverge on the part that matters: the
 * tree kill. A frozen PyInstaller build is a bootloader that spawns the real interpreter as a child,
 * so killing the pid we hold leaves the engine running and still talking to the API.
 *
 * The caller sets `endReason` BEFORE calling this: `close` fires asynchronously and reads it.
 */
export function killJob(j: Job): void {
  const proc = j.proc
  if (!proc) {
    // A preparation process that outlived its kill is still work to interrupt. forceKillTree refuses
    // a reaped child, so a second Stop cannot hit whatever inherited the number (SOL-14).
    const prep = j.prepChild
    if (prep && !hasExited(prep)) {
      forceKillTree(prep)
      j.handlers.onOutput(
        'stderr',
        `Trying again to end the process that would not stop (pid ${prep.pid ?? 'unknown'}). ` +
          'This run stays open until it exits.'
      )
      return
    }
    // Nothing spawned yet. A preparation step in flight owns the terminal event; with none, end the
    // job here so the slot is not held by a job that has no work to interrupt.
    if (!j.prep) finishJob(j, -1)
    return
  }
  // `close` is what finishes the job; `exit` is what reaps the pid. Stop can still run between the
  // two, and a copied `proc.pid` is then a stranger (SOL-19).
  const pid = livePid(proc)
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      treeKill(j, proc)
    } else {
      // The GROUP, not the process: an ffmpeg the interpreter started is not covered by signalling
      // the tracked pid alone (SOL-10). The engine is spawned `detached` on POSIX so it leads a group.
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        proc.kill('SIGTERM')
      }
      // SIGTERM is a REQUEST. Escalation stays inside `waitForChildExit(proc)` → `forceKillTree`,
      // which SIGKILLs the group only while that ChildProcess has not been reaped (SOL-14, SOL-18).
      void waitForChildExit(proc, { graceMs: 3_000, attempts: 3 }).then((gone) => {
        if (!gone) failedTermination(j, 'the process group ignored both SIGTERM and SIGKILL')
      })
    }
  } catch {
    // A failed kill means the engine is still RUNNING; releasing the slot then is a second engine.
    // This branch only sees the rare synchronous-argument case — `treeKill()` owns the async ones.
    failedTermination(j, 'the termination could not be attempted')
  }
}

/**
 * Kill the engine's whole process tree on Windows — and find out whether that worked.
 *
 * A `taskkill` that cannot START reports it through an `error` event, and an `error` on a child with
 * no listener is an uncaught exception that takes the Electron main process down. A `taskkill` that
 * runs and FAILS ("Access is denied") reports it by exiting non-zero. Only failure is acted on; a
 * successful tree kill lets the engine's own `close` end the run.
 *
 * Takes the ChildProcess, not a number: SOL-19.
 */
function treeKill(j: Job, child: ChildProcess): void {
  const pid = livePid(child)
  if (pid === undefined) return
  const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'])
  // `/t` reports one line PER process it could not kill, and those lines are READ for their pids,
  // so the cap is generous (SOL-05, round 2).
  let why = ''
  killer.stderr?.on('data', (d: Buffer) => {
    if (why.length < 8_000) why += String(d)
  })
  killer.on('error', (e) => failedTermination(j, `taskkill could not run: ${e.message}`))
  killer.on('close', (code) => {
    if (code === 0) return
    const said = why
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
    failedTermination(j, `taskkill exited ${code}${said ? ` — ${said}` : ''}`, survivorsIn(why))
  })
}

/**
 * The pids `taskkill` said it could not kill. Both pids on each line are collected: either can be the
 * survivor, and checking one too many costs nothing while missing one is the defect (SOL-05).
 *
 *   ERROR: The process with PID 4711 (child process of PID 4096) could not be terminated.
 */
export function survivorsIn(taskkillStderr: string): number[] {
  const pids = new Set<number>()
  for (const m of taskkillStderr.matchAll(/PID[:\s]+(\d+)/gi)) {
    const pid = Number(m[1])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/**
 * A termination attempt failed. End the job only if the engine turns out to be gone anyway.
 *
 * The `finished` guard matters: these handlers fire asynchronously, and by then the slot may belong to
 * a DIFFERENT job. If nothing we can name is alive, the run is still NOT ended here — releasing the
 * slot on a guess is how a second engine starts (SOL-05, rounds 3–4). The engine's own `close`, delayed
 * by any descendant still holding its pipes, is what ends it.
 */
function failedTermination(j: Job, detail: string, alsoCheck: number[] = []): void {
  if (j.finished) return
  if (engineOutlivedItsKill(j, detail, alsoCheck)) return
  const warnAfterMs = 1_500
  const startedAt = Date.now()
  let warned = false
  const watch = setInterval(() => {
    if (j.finished) {
      clearInterval(watch)
      return
    }
    if (warned || Date.now() - startedAt < warnAfterMs) return
    warned = true
    j.handlers.onOutput(
      'stderr',
      `Termination reported a failure (${detail}) and no process we can identify is still running. ` +
        'This run stays open until the engine closes; if it appears to keep working, end it from Task Manager.'
    )
  }, 250)
  void watch
}

/**
 * Is that process still out there? Signal 0 runs the existence and permission checks without
 * delivering anything. EPERM counts as ALIVE: a process we are not allowed to signal is the worst
 * version of this, not an absent one.
 */
export function childIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A termination attempt failed — did the engine survive it? If it did, the job must NOT end: an
 * ending releases the single slot, and a second engine would then start against the same API while
 * the survivor keeps writing into the shared output channel.
 */
export function engineOutlivedItsKill(j: Job, detail = '', alsoCheck: number[] = []): boolean {
  const pid = j.proc?.pid
  const alive = [pid, ...alsoCheck].filter((p) => childIsAlive(p))
  if (alive.length === 0) return false
  const survivors = alive.join(', ')
  j.handlers.onOutput(
    'stderr',
    `${j.endReason ? 'The engine did not stop' : 'The engine is still running'} (pid ${survivors})` +
      `${detail ? ` — ${detail}` : ''}. ` +
      'This run stays open until it exits, because starting another one now would put two engines ' +
      'on the same API key. Press Stop again to retry, or end that process yourself.'
  )
  return true
}

function abortRunSignal(j: Job): void {
  const binding = (j.handlers as Bound)[RUN_BINDING]
  const rec = binding ? records.get(binding.ctx) : undefined
  if (rec && !rec.controller.signal.aborted) rec.controller.abort()
}

/**
 * End the current job because the USER asked to.
 *
 * `user` is set here and nowhere else: it is what makes the panel say "Stopped" instead of "Failed".
 * Acts on the job the runner holds — never on a re-derived adapter (§2.2a).
 */
export function stopCurrent(): void {
  const j = job
  if (!j) return
  j.endReason = 'user'
  abortRunSignal(j)
  // Cancel a conversion that has not finished. The awaiting start sees the reason and ends the job.
  j.prep?.abort()
  killJob(j)
}

export function isRunning(): boolean {
  return job !== null
}

/**
 * Wait for a job to reach its own ending, up to a deadline. The wait a PREPARATION step needs: there
 * is no child to watch, so the observable event is the job ending. Resolves `false` on the deadline.
 */
function waitForJobToFinish(j: Job, deadline: number): Promise<boolean> {
  if (j.finished) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const poll = setInterval(() => {
      if (j.finished) {
        clearInterval(poll)
        resolve(true)
        return
      }
      if (Date.now() < deadline) return
      clearInterval(poll)
      resolve(false)
    }, 100)
    void poll
  })
}

/**
 * End whatever is running because the APPLICATION is closing (SOL-04).
 *
 * Resolves when the job has ended, or when the grace period expires — bounded on purpose, because an
 * engine that will not die must not be able to stop the user closing the application. The deadline
 * escalates to a forced tree kill instead of expiring into a shrug. The reason is `guard`, not `user`:
 * nobody pressed Stop.
 */
export async function shutdownJob(graceMs = 4_000): Promise<void> {
  const j = job
  if (!j) return
  j.endReason = 'guard'
  abortRunSignal(j)
  j.prep?.abort()
  const engine = j.proc
  const prep = j.prepChild
  killJob(j)
  if (j.finished && !childIsAlive(engine?.pid) && !(prep && !hasExited(prep))) return

  const attemptGrace = Math.max(500, Math.floor(graceMs / 2))
  // The child is adopted at spawn, so shutdown can wait on a preparation child the same way it waits
  // on the engine (SOL-04, round 4).
  const target = engine ?? prep
  if (target) {
    const gone = await waitForChildExit(target, { graceMs: attemptGrace, attempts: 2 })
    if (!gone) {
      forceKillTree(target)
      const confirmed = await waitForChildExit(target, { graceMs: 500, attempts: 1 })
      if (!confirmed) {
        const note = `[shutdown] pid ${target.pid ?? 'unknown'} survived a forced kill and may still be running`
        console.log(note)
      }
    }
  } else {
    // The child has not been adopted yet — spawn has not returned. Wait long enough for the helper's
    // own escalation (preflight grace 5s × 2 attempts) plus a buffer, then take any child that appeared.
    const prepDeadline = Date.now() + Math.max(graceMs, 12_000)
    await waitForJobToFinish(j, prepDeadline)
    if (!j.finished && j.prepChild) {
      forceKillTree(j.prepChild)
      await waitForChildExit(j.prepChild, { graceMs: 500, attempts: 1 })
    }
  }
  // Scratch and the console are the terminal path's job everywhere else; this is the path where it
  // may never come. Deleting the temp media matters most: an abandoned conversion can be hundreds of MB.
  if (!j.finished) {
    deleteScratch(j)
    j.artifacts?.abort()
  }
}

// ── the start path ───────────────────────────────────────────────────────────────

interface RunRequestBase {
  runId: string
  /** The engine this run uses, made at Start; the app passes the native adapter. */
  adapter: () => EngineAdapter
  /** Where finalised events go: IPC in the app, a collector in the probes. */
  deliver: Emit
  /**
   * The outer guard's advisory, said before the run exists. It becomes the run's first `log`,
   * directly after `started`; a start refused before reservation carries it in its error instead.
   */
  notice?: string
  /** Every configured secret at Start: all Gemini slots, the TMDB key, the run's own keys. */
  secrets: readonly string[]
  preferences: RunArtifactPreferences
  /** Console-only effective description (§2.1b). */
  description?: string
  /** Must be the configured source when given (`configureRunnerRuntime`); any other is refused. */
  settingsRevisions?: SettingsRevisionSource
  /** Fault seams for the gates. */
  artifactIo?: Partial<RunArtifactIo>
}

export type StartRunRequest = RunRequestBase &
  ({ kind: 'translate'; args: TranslateArgs } | { kind: 'transcribe'; args: TranscribeArgs })

/** The process's runner facts, set once by the main process before any run handler exists (§12.4). */
let runtime: Readonly<{ settingsRevisions: SettingsRevisionSource }> | null = null

/**
 * Give every run the Settings revision source its waits wake on. Called once, before the run
 * handlers are registered; the same source again is a no-op, a different one is refused, and a
 * start before it is refused.
 */
export function configureRunnerRuntime(config: { settingsRevisions: SettingsRevisionSource }): void {
  if (runtime) {
    if (runtime.settingsRevisions === config.settingsRevisions) return
    throw new Error('The runner is already configured with a different Settings revision source.')
  }
  runtime = Object.freeze({ settingsRevisions: config.settingsRevisions })
}

function withNotice(notice: string | undefined, next: Emit): Emit {
  let pending = notice
  let reserved = false
  return (event) => {
    if (!reserved && pending) {
      if (event.type === 'error') {
        event = { ...event, error: { ...event.error, message: `${pending}\n${event.error.message}` } }
      } else if (event.type === 'finished' && event.error) {
        event = { ...event, error: { ...event.error, message: `${pending}\n${event.error.message}` } }
      }
    }
    next(event)
    if (event.type === 'started') {
      reserved = true
      if (pending) {
        next({ type: 'log', runId: event.runId, stream: 'stderr', text: pending })
        pending = undefined
      }
    }
  }
}

function routeThrough(rec: RunRecord): Emit {
  return (event: RunEvent) => {
    if (rec.closed || event.runId !== rec.ctx.runId) {
      droppedEvents++
      return
    }
    if (event.type === 'finished') {
      rec.closed = true
      let out = event
      if (rec.artifacts) {
        try {
          out = rec.artifacts.finalize(event)
        } catch {
          out = event
        }
      }
      rec.deliver(out)
      return
    }
    rec.artifacts?.record(event)
    rec.deliver(event)
  }
}

/**
 * The console-only description (§2.1b), standing where 1.1.0's masked `-d` stood: a Translate console
 * names the one its requests send, unless the caller gave one. A snapshot that cannot be built leaves
 * the console without it — the run reports that itself.
 */
function descriptionFor(req: StartRunRequest): { description?: string } {
  if (req.description !== undefined) return { description: req.description }
  if (req.kind !== 'translate') return {}
  try {
    const sent = translationSnapshot(req.args).description
    return sent ? { description: sent } : {}
  } catch {
    return {}
  }
}

/**
 * Start a run. The outer model guard has already passed; the adapter's start asks `reserveJob()` for
 * the slot, which is where the session opens and `started` is minted.
 */
export async function startRun(req: StartRunRequest): Promise<StartedRun> {
  if (!runtime) throw new Error('The runner was started before configureRunnerRuntime.')
  if (req.settingsRevisions !== undefined && req.settingsRevisions !== runtime.settingsRevisions) {
    throw new Error('A run cannot bring its own Settings revision source.')
  }
  const adapter = req.adapter()
  const controller = new AbortController()
  const ctx: RunContext = {
    runId: req.runId,
    epoch: ++epochCounter,
    signal: controller.signal,
    settingsRevisions: runtime.settingsRevisions
  }
  const rec: RunRecord = {
    ctx,
    kind: req.kind,
    adapter,
    controller,
    deliver: req.deliver,
    snapshot: {
      secrets: [...req.secrets],
      preferences: { ...req.preferences },
      ...descriptionFor(req)
    },
    ...(req.artifactIo ? { artifactIo: req.artifactIo } : {}),
    artifacts: null,
    closed: false
  }
  records.set(ctx, rec)
  const emit = withNotice(req.notice, routeThrough(rec))
  return req.kind === 'translate' ? adapter.translate(req.args, ctx, emit) : adapter.transcribe(req.args, ctx, emit)
}
