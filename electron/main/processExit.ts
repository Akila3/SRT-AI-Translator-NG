import { spawn, type ChildProcess } from 'child_process'

/**
 * Waiting until a child is actually GONE, as opposed to until we asked it to go.
 *
 * The distinction is the whole of validator finding SOL-02, and it is easy to get wrong because
 * every API in this area reports the REQUEST. `taskkill` is spawned and forgotten; Node's
 * `AbortSignal` support emits `error` when it kills the child, not when the child dies; a
 * `SIGTERM` returns as soon as it is delivered. Each of those is a perfectly good moment to stop
 * waiting for output and a completely wrong moment to release the single job slot — because a slot
 * released while its process is alive is what lets a second engine start against the same key.
 *
 * **Everything that can KILL is bound to a ChildProcess, never to a bare pid.** That is validator
 * finding SOL-14, and it is the sharpest edge in this file: a pid is a reusable integer, so a poll
 * that outlives its child can watch the number, see it occupied again, and force-kill a completely
 * unrelated process — someone else's build, editor or database. `modelsList` already documented that
 * hazard for its own timer; the first version of this helper reintroduced it centrally. A
 * `ChildProcess` cannot be confused: `exitCode`/`signalCode` and the `close` event are statements
 * about THAT child and nothing else.
 */

/**
 * Is that pid still out there? Signal 0 runs the checks without delivering anything.
 *
 * Read-only, and deliberately still pid-based: its only caller is the survivor check after a partial
 * `taskkill`, where a pid parsed out of diagnostic text is all there is. Reuse can make this answer
 * "alive" about the wrong process, and that direction is safe — it keeps a job slot held, which is
 * cautious. Nothing is ever killed on the strength of it.
 */
export function pidIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // A process we are not allowed to signal is PRESENT, which is the answer that matters here.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Has this child's lifecycle definitively ended?
 *
 * Node sets one of these the moment it reaps the child, so it is authoritative and — unlike a pid
 * check — cannot be confused by reuse. It answers for the TRACKED process only; whether a descendant
 * survived is a different question that needs process-tree ownership (see REP-21).
 */
export function hasExited(child: ChildProcess): boolean {
  // `!= null` is deliberate: Node initialises both to `null` and writes a value when it reaps.
  // `!== null` treated a missing property as a reap (`undefined !== null`), so a test stub that
  // never declared `exitCode` looked dead and SOL-19's `livePid` refused to signal it.
  return child.exitCode != null || child.signalCode != null
}

/**
 * The pid we may still signal, or `undefined` if that number is no longer ours.
 *
 * Node sets `exitCode`/`signalCode` when it reaps the child. `close` can arrive later, while
 * stdio drains or a descendant still holds the pipes. The job stays until `close`, so Stop can
 * still run in that gap — and the OS may already have reused the pid (SOL-19). A caller that
 * needs a number for `taskkill` or `kill(-pgid)` must take it from here, not from `child.pid`.
 */
export function livePid(child: ChildProcess): number | undefined {
  if (child.pid === undefined || hasExited(child)) return undefined
  return child.pid
}

/** Kill a child and everything under it, as forcefully as the platform allows. */
export function forceKillTree(child: ChildProcess, kill?: (child: ChildProcess) => void): void {
  const pid = livePid(child)
  // Refusing to signal a reaped child is the entire point of taking a ChildProcess: its pid may
  // already belong to something else.
  if (pid === undefined) return
  // Gates inject this so "we did not signal" is an observed count, not an inference from the
  // pid being gone (SOL-44). Production callers omit it; the default path is unchanged.
  if (kill) {
    kill(child)
    return
  }
  try {
    if (process.platform === 'win32') {
      // Detached from our own error handling on purpose: an unhandled `error` on a child nobody
      // kept is an uncaught exception, and a `taskkill` that cannot start must not take the
      // application down while it is trying to clean up.
      spawn('taskkill', ['/pid', String(pid), '/f', '/t']).on('error', () => {})
    } else {
      // The whole group, for the reason `killJob()` documents: the pid we hold may be a bootloader.
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    /* best effort — the caller's exit check is what decides whether it worked */
  }
}

export interface WaitOptions {
  /** How long to wait before escalating to a forced kill. */
  graceMs?: number
  /** How many times to escalate before reporting the process as a survivor. */
  attempts?: number
  /** Substituted by the gates so escalation can be counted instead of performed. */
  kill?: (child: ChildProcess) => void
}

/**
 * Resolve once this child has exited, escalating to a forced tree kill if it has not.
 *
 * Resolves `true` when the child's exit is confirmed and `false` when it is still there after every
 * attempt. **`false` is not a failure to handle later — it is the answer**, and a caller that owns a
 * job slot must keep holding it.
 *
 * `close` is the witness, and subscribing to it is what makes this safe as well as prompt: the
 * moment it fires, every pending poll and every pending escalation is cancelled, so nothing can act
 * on the pid afterwards (SOL-14). The polling exists only for the case where `close` will never come
 * because the kill did not work.
 *
 * Bounded in total, because the alternative is an application that cannot be closed and a Stop
 * button that never returns.
 */
export function waitForChildExit(
  child: ChildProcess | null | undefined,
  opts: WaitOptions = {}
): Promise<boolean> {
  if (!child) return Promise.resolve(true)
  if (hasExited(child)) return Promise.resolve(true)
  const graceMs = opts.graceMs ?? 3_000
  const attempts = opts.attempts ?? 2
  const kill = opts.kill ?? forceKillTree
  return new Promise<boolean>((resolve) => {
    let settled = false
    let attempt = 0
    let deadline = Date.now() + graceMs
    const finishWith = (gone: boolean): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      child.removeListener('close', onClose)
      resolve(gone)
    }
    const onClose = (): void => finishWith(true)
    const poll = setInterval(() => {
      if (hasExited(child)) {
        finishWith(true)
        return
      }
      if (Date.now() < deadline) return
      attempt += 1
      if (attempt >= attempts) {
        finishWith(false)
        return
      }
      // Still there and out of patience: ask harder, then start the clock again.
      kill(child)
      deadline = Date.now() + graceMs
    }, 100)
    // Deliberately NOT `unref`'d. An unreferenced timer does not hold the event loop open, so in any
    // context that is not already being kept alive — a gate, a probe, a script — the loop can drain
    // and this promise then never settles at all, taking its `await` with it. The total wait is
    // bounded by `attempts * graceMs`, so holding the loop is measured in seconds, and a caller
    // blocked forever is the worse failure by far.
    child.once('close', onClose)
  })
}
