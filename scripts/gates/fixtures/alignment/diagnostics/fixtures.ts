/**
 * Bundle M diagnostic fixtures (implementation_plan.md §16.0.6, §16.0.7 M-I). The typed boundary Bundle M
 * adds to the Align channels, and the labels whose absence proves a diagnostic carries no subtitle text.
 * Cues are synthetic; nothing private enters git.
 *
 * AUTHORED-BY: opus-5.5-high
 */

/** Exactly two request channels and two preload members (§16.0.2 `ipc.ts` row); no event, no request field. */
export const R9_ALIGN = Object.freeze({
  channels: Object.freeze(['align:export-diagnostic', 'align:open-diagnostic']),
  preload: Object.freeze(['alignExportDiagnostic', 'alignOpenDiagnostic'])
})

/** Text the fixtures' cues carry. A diagnostic holds none of it. */
export const FIXTURE_TEXT = Object.freeze(['Line', 'Track line', 'Other', 'Words', 'Spoken', 'Reference line', 'Changed line'])
