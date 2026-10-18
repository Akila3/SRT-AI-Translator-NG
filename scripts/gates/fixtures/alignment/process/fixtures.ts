/**
 * ALASS process-matrix fixtures (implementation_plan.md §17 R13.4). `fake-alass.mjs` stands in for the
 * executable so every ending — timeout, cancel, a surviving grandchild, oversized streams and files,
 * a bad or mismatched report — is a real child process with real pipes, exit codes and tree kills.
 * Cues are synthetic ("Line N"); nothing private enters git.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Cue } from '../../../../../electron/engine/srt'

export const FAKE_ALASS = path.join(process.cwd(), 'scripts', 'gates', 'fixtures', 'alignment', 'process', 'fake-alass.mjs')

export type FakeBehaviour =
  | 'ok'
  | 'record'
  | 'exit3'
  | 'hang'
  | 'grandchild'
  | 'spam-stdout'
  | 'spam-stderr'
  | 'big-output'
  | 'big-report'
  | 'no-output'
  | 'no-report'
  | 'bad-report'
  | 'other-mode'
  | 'other-penalty'
  | 'other-count'
  | 'vad-report'
  | 'output-dir'
  | 'wrong-version'
  | 'version-fails'
  | 'hang-align'
  | 'align-other-ref'
  | 'vad-empty'
  | 'vad-silent-text'
  | 'vad-short'
  | 'vad-bytes'
  | 'vad-not-vad'

/** Every spawn the adapter asked for, as it asked: executable, arguments, working folder and environment. */
export interface SpawnLog {
  exe: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  child: ChildProcess
}

/**
 * A spawn that runs the fake with `behaviour` in place of the executable it was given; the version
 * check gets the same behaviour, so `wrong-version` and `version-fails` act there.
 */
export function fakeSpawn(behaviour: FakeBehaviour, recordDir: string, log: SpawnLog[] = []): (exe: string, args: readonly string[], opts: SpawnOptions) => ChildProcess {
  return (exe, args, opts) => {
    const child = spawn(process.execPath, [FAKE_ALASS, behaviour, recordDir, ...args], opts)
    log.push({ exe, args: [...args], cwd: String(opts.cwd), env: { ...(opts.env as Record<string, string | undefined>) }, child })
    return child
  }
}

/** A trust record for the fake: its own path and hash, and the version line it prints. */
export function fakeTrust(): { exePath: string; sha256: string; versionLine: string } {
  return { exePath: FAKE_ALASS, sha256: createHash('sha256').update(fs.readFileSync(FAKE_ALASS)).digest('hex'), versionLine: 'alass-cli 2.0.0' }
}

export function lines(n: number, offsetMs = 0): Cue[] {
  return Array.from({ length: n }, (_, i) => {
    const s = 2000 + i * 4000 + ((i * 37) % 900) + offsetMs
    return { index: i + 1, startMs: s, endMs: s + 1500 + ((i * 53) % 1200), text: `Line ${i + 1}` }
  })
}

/** A folder name that would break a shell or an option parser if anything quoted it wrongly. */
export const HOSTILE_DIR_NAME = "a & b ^ ' ; -- %PATH% $HOME `x` שלום -n"

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Every entry under `dir`, relative, sorted. */
export function listTree(dir: string): string[] {
  const out: string[] = []
  const go = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      out.push(path.relative(dir, p))
      if (e.isDirectory()) go(p)
    }
  }
  go(dir)
  return out.sort()
}
