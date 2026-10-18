/**
 * The engine boundary (implementation_plan.md §2.2). One run in, a typed event stream out.
 *
 * There is deliberately no `stop()` or `isRunning()` here. `runner.ts` owns the slot and acts on
 * the adapter instance it captured at Start (§2.2a, BR-15).
 */
import type { RunEvent } from '../shared/engineEvents'
import type { RunId, TranslateArgs, TranscribeArgs } from '../shared/types'

export type Emit = (event: RunEvent) => void

export interface StartedRun {
  outputPath: string
  /** Sidecars known at start time; `finished` carries the complete list. */
  logPaths: string[]
}

export interface SettingsRevisionSource {
  current(): number
  subscribe(listener: (revision: number) => void): () => void
}

export interface RunContext {
  runId: RunId
  epoch: number
  signal: AbortSignal
  settingsRevisions: SettingsRevisionSource
}

export interface EngineAdapter {
  translate(args: TranslateArgs, ctx: RunContext, emit: Emit): Promise<StartedRun>
  transcribe(args: TranscribeArgs, ctx: RunContext, emit: Emit): Promise<StartedRun>
}
