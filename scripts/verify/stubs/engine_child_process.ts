/**
 * A scripted engine, in place of the real one, for the console-log probe.
 *
 * Aliased over `child_process` when the probe is bundled, so `startTranslate`,
 * `startTranscribe`, `run()`, `killJob()` and `finish()` are the shipped implementations and only
 * the process on the far end of the pipe is ours. That is the point: what this probe has to
 * establish is that the file receives what the run produced and is closed on every ending, and
 * neither is observable if the engine is real — a real `gst` needs a key, spends quota, and
 * cannot be made to emit ten megabytes on demand or to fail at a chosen instant.
 *
 * `taskkill` is intercepted rather than executed. `killJob()` reaches for it on Windows because a
 * frozen PyInstaller build is a bootloader whose real interpreter is a child, and letting a probe
 * hand a synthetic pid to a real `taskkill /f /t` is how a test suite ends someone's editor. The
 * interception is also the assertion: the probe reads back the argv and checks it named this
 * child's pid, so the tree kill is proven rather than merely not-crashed.
 */
import * as real from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export * from 'node:child_process'

/** Deliberately not a pid this machine could own; nothing outside this file ever sees it. */
export const FAKE_PID = 999_000_111

export interface ScriptedEngine {
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  /** Finish the run the way the engine would: close both pipes, then report an exit code. */
  end(code: number | null): void
  /**
   * Emit `error` alone — the shape Node documents but rarely produces on demand.
   *
   * Worth having because the two are not the same event in disguise: a spawn that failed emits
   * error and then close, but a KILL that failed emits error while the child is still alive, so
   * no close is ever coming. The second is the one that used to hold the job slot forever.
   */
  fail(message: string): void
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined = FAKE_PID

  kill(): boolean {
    // Reached only on non-Windows, where `killJob()` signals the process directly.
    if (killThrows) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    setImmediate(() => this.emit('close', null))
    return true
  }

  fail(message: string): void {
    this.emit('error', new Error(message))
  }

  end(code: number | null): void {
    // `close` is emitted only once BOTH pipes have drained, which is what a real child does and
    // what `run()` depends on: it flushes its partial-line buffers in the `close` handler, so a
    // `close` that overtook the data would silently drop the end of the run — the exact thing
    // this probe exists to detect.
    let pending = 2
    const settle = (): void => {
      if (--pending === 0) this.emit('close', code)
    }
    this.stdout.on('end', settle)
    this.stderr.on('end', settle)
    this.stdout.end()
    this.stderr.end()
  }
}

/** Nothing sets this; it keeps the non-Windows `kill()` path defined rather than a ReferenceError. */
const killThrows = false

let script: ((engine: ScriptedEngine) => void) | null = null
let current: FakeChild | null = null
let killArgv: string[] | null = null
let nextPid: number | undefined = FAKE_PID
let killFailure: KillFailure = null

/**
 * How the next termination attempt fails.
 *
 * All three exist because they are three different code paths in the app and only one of them is
 * the one a naive test reaches for. `spawn()` almost never throws — it reports a command that
 * cannot run through an asynchronous **`error` event**, and a command that ran and refused through
 * a **non-zero exit**. A stub that only throws proves the app handles the case that barely happens.
 */
export type KillFailure = 'throw' | 'error' | 'exit' | null

/** Install the behaviour of the next spawned "engine". */
export function __useScriptedEngine(fn: (engine: ScriptedEngine) => void): void {
  script = fn
  killArgv = null
}

/**
 * Lend the next engine a REAL process id.
 *
 * Needed because the app now asks the operating system whether a child survived a failed kill, and
 * that question can only be answered honestly about a process that exists. A scenario about "the
 * engine is still running" written with an invented pid tests the opposite case.
 */
export function __useEnginePid(pid: number | undefined): void {
  nextPid = pid
}

/** Make the next termination attempt fail, in one of the three ways it can. */
export function __failNextKill(mode: KillFailure): void {
  killFailure = mode
}

/** The argv of the `taskkill` the app reached for, or null if it never did. */
export function __killArgv(): string[] | null {
  return killArgv
}

export function spawn(
  command: string,
  args?: readonly string[],
  options?: real.SpawnOptions
): real.ChildProcess {
  if (command === 'taskkill') {
    killArgv = (args ?? []).map(String)
    // Windows reaches the failed-kill path through the tree kill rather than through `kill()`,
    // so this is where an unkillable process has to be simulated on the platform that ships.
    if (killFailure === 'throw') throw Object.assign(new Error('spawn taskkill EPERM'), { code: 'EPERM' })
    const killer = new FakeChild()
    if (killFailure === 'error') {
      // A command that cannot be started at all. Emitted asynchronously, exactly as Node does —
      // and fatal to the whole process if the caller never attached a listener.
      setImmediate(() =>
        killer.emit('error', Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' }))
      )
    } else if (killFailure === 'exit') {
      // The ordinary Windows refusal: it ran, it declined, it said why on stderr.
      setImmediate(() => {
        killer.stderr.write(
          'ERROR: The process with PID 4242 (child process of PID 41) could not be terminated.\r\n' +
            'Reason: Access is denied.\r\n'
        )
        killer.stderr.end()
        killer.emit('close', 1)
      })
    } else {
      const victim = current
      // A real tree kill ends the child, and the child's `close` is what releases the job slot.
      if (victim) setImmediate(() => victim.emit('close', null))
      setImmediate(() => killer.emit('close', 0))
    }
    return killer as unknown as real.ChildProcess
  }
  if (!script) return real.spawn(command, args as string[], options as real.SpawnOptions)

  const child = new FakeChild()
  child.pid = nextPid
  current = child
  // After the caller has attached its stream handlers, never before: `run()` subscribes
  // synchronously on the line following the spawn.
  setImmediate(() => script?.(child as unknown as ScriptedEngine))
  return child as unknown as real.ChildProcess
}

export default { ...real, spawn }
