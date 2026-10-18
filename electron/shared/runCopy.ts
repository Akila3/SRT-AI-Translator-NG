/**
 * Sentences the run pages show, kept apart from the machinery that once produced them.
 *
 * These lived in `stallBudget.ts` beside the CLI watchdog. They are shipped UI copy, not watcher
 * internals, and the watchdog retired with the CLI at Step 4.5 (BR-10) — so they live here, where
 * retiring it could not take them along.
 */
import type { BlockClass, PreservationReason, PreservedLine, RunError } from './engineEvents'

/** Why Bundle G kept a line in its source language, as the run panel and the Translate page say it. */
export const KEPT_BECAUSE: Record<PreservationReason, string> = {
  CONTENT_BLOCKED: 'the model refused it',
  REASON_ABSENT: 'no translation came back',
  UNPARSEABLE_REPLY: 'its reply could not be read',
  BUDGET_FLOOR: 'the recovery limit was reached'
}

/** Every kept line by number, with why: "line 3 (the model refused it), line 7 (…)". */
export function keptLinesText(lines: readonly PreservedLine[]): string {
  return lines.map((p) => `line ${p.index} (${p.reason ? KEPT_BECAUSE[p.reason] : 'kept by an earlier run'})`).join(', ')
}

/**
 * Shared factual claim for a transcription that was stopped or stalled (SF-4 / REP-37).
 *
 * Engine 3.7.0 buffers then writes the `.srt` once. A user Stop (live `taskkill /F /T`) or a
 * tier-2 stall therefore leaves no usable file. That claim is NOT safe on a generic engine
 * failure: transcribe() writes `output_file` before progress-file / log / extracted-audio
 * cleanup, so a later `os.remove` can exit nonzero after a complete `.srt` is already there
 * (SOL-68). TranscribePage uses `transcribeFailedDetail()` for that path.
 */
export const NOTHING_WAS_WRITTEN = 'nothing was written'

/** Stopped copy on TranscribePage. Same claim as tier 2's tail, plus "must start over". */
export function transcribeUnsavedDetail(): string {
  return 'Nothing was written. The transcription must start over.'
}

/**
 * A failed or stopped run that left an incomplete subtitle (§4.1a rule 4). Says where, and that it
 * is not the finished transcription: it holds only the parts done before the run ended.
 */
export function transcribeIncompleteDetail(file: string): string {
  return `An incomplete subtitle was kept: ${file}. It holds only what was transcribed before the run ended; it is not the finished transcription.`
}

/**
 * A native transcription that ended with a valid resumable partial (AR3-6, Step 3.6). These replace the
 * must-start-over and incomplete-file sentences only then; the CLI and an ending with no resumable
 * partial keep the sentences above.
 */
export const TRANSCRIBE_RESUMABLE_COPY = {
  stopped:
    'The transcription stopped before completion. The retained partial is incomplete and may be misaligned. Start again with the same media and output path to Continue or Start over.',
  error:
    'The transcription did not finish. The retained partial is incomplete and may be misaligned. Start again with the same media and output path to Continue or Start over.'
} as const

export function transcribeResumableDetail(ending: 'stopped' | 'error'): string {
  return TRANSCRIBE_RESUMABLE_COPY[ending]
}

/**
 * What to do about a content block, by run kind and the typed cause (AR3-2, Step 3.2). Transcribe's
 * copy never mentions Translate's retry, and neither promises a Continue: a valid checkpoint offers
 * that separately. A block `blocks.ts` did not name is null, so it keeps the generic wording.
 */
export const BLOCK_ADVICE: Record<'translate' | 'transcribe', Record<BlockClass, string>> = {
  translate: {
    PROHIBITED_CONTENT:
      'The model provider blocked this subtitle section as prohibited content. Nothing from the failed section was added. Try the run again later or choose another model. If it keeps failing, review the source text in that range.',
    OTHER:
      'The model provider blocked this subtitle section for another safety reason. Nothing from the failed section was added. Try the run again later or choose another model.'
  },
  transcribe: {
    PROHIBITED_CONTENT:
      'The model provider blocked this audio section as prohibited content. Nothing from the failed section was added. Try transcription again later or choose another model before starting again.',
    OTHER:
      'The model provider blocked this audio section for another safety reason. Nothing from the failed section was added. Try transcription again later or choose another model before starting again.'
  }
}

export function isBlockClass(reason: unknown): reason is BlockClass {
  return reason === 'PROHIBITED_CONTENT' || reason === 'OTHER'
}

export function blockAdvice(kind: 'translate' | 'transcribe', error: Pick<RunError, 'kind' | 'blockReason'> | null | undefined): string | null {
  if (!error || error.kind !== 'blocked' || !isBlockClass(error.blockReason)) return null
  return BLOCK_ADVICE[kind][error.blockReason]
}

/**
 * Generic transcribe failure. Must not deny a post-save cleanup error that left a complete file.
 */
export function transcribeFailedDetail(): string {
  return (
    'Check the output path before starting over. If a file is already there, it may be complete.'
  )
}
