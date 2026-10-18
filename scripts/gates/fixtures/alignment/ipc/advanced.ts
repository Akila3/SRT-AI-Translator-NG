/**
 * Advanced (piecewise) service fixtures (implementation_plan.md §17 R13.5). `fake-alass-outputs.mjs`
 * stands in for `alass.exe` and writes a chosen output timeline — following the reference, scrambled,
 * with a line's text changed or a line dropped — always with exit 0 and a perfect-looking report, so the
 * gates can show that NG's own A–I check over the output, never ALASS's own account, decides. Cues are
 * synthetic ("Line N"); nothing private enters git.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { SpawnLog } from '../process/fixtures'

export const FAKE_ALASS_OUTPUTS = path.join(process.cwd(), 'scripts', 'gates', 'fixtures', 'alignment', 'ipc', 'fake-alass-outputs.mjs')

export type OutputBehaviour = 'follow' | 'alter-text' | 'drop-cue' | 'scramble' | 'hang' | 'exit3' | 'pipe-holder'

/** A spawn that runs the fake with `behaviour` in place of the executable it was given, logging each call. */
export function outputsSpawn(behaviour: OutputBehaviour, log: SpawnLog[] = []): (exe: string, args: readonly string[], opts: SpawnOptions) => ChildProcess {
  return (exe, args, opts) => {
    const child = spawn(process.execPath, [FAKE_ALASS_OUTPUTS, behaviour, ...args], opts)
    log.push({ exe, args: [...args], cwd: String(opts.cwd), env: { ...(opts.env as Record<string, string | undefined>) }, child })
    return child
  }
}

export function outputsTrust(): { exePath: string; sha256: string; versionLine: string } {
  return { exePath: FAKE_ALASS_OUTPUTS, sha256: createHash('sha256').update(fs.readFileSync(FAKE_ALASS_OUTPUTS)).digest('hex'), versionLine: 'alass-cli 2.0.0' }
}

/**
 * The typed Align boundary baseline C shipped (§17.5 C.2), recorded before R13.5 extended it: four
 * request channels, one progress event, five preload members. R13.5 adds exactly one of each kind.
 */
export const LANDED_ALIGN = Object.freeze({
  channels: Object.freeze(['align:analyze', 'align:cancel', 'align:preview', 'align:apply']),
  event: 'align:progress',
  preload: Object.freeze(['alignAnalyze', 'alignCancel', 'alignPreview', 'alignApply', 'onAlignProgress']),
  request: Object.freeze(['generation', 'sourcePath', 'reference', 'transcriptionToken'])
})

export const R135_ALIGN = Object.freeze({ channel: 'align:advanced-status', preload: 'alignAdvancedStatus', request: 'mode' })
