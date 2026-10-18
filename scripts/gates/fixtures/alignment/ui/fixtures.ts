/**
 * Align tab view fixtures (C.3). Synthetic, author-written: shaped like what `alignService` returns, so the
 * cards can be rendered for every verdict and every refusal reason without a run.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import type { AlignAnalysis, AlignEvidence, AlignPreviewRow } from '../../../../../electron/shared/types'

type Result = Extract<AlignAnalysis, { status: 'result' }>
type Refused = Extract<AlignAnalysis, { status: 'refused' }>

export const REFUSAL_REASONS: Refused['reason'][] = [
  'malformed',
  'insufficient',
  'wrong_title',
  'weak_correspondence',
  'invariant_failure',
  'invalid_request',
  'source_unreadable',
  'reference_unreadable',
  'reference_not_text',
  'no_text_reference',
  'media_unreadable',
  'audio_unusable',
  'transcription_failed',
  'offer_expired',
  'busy',
  'analysis_failed',
  'embedded_track_conflict'
]

export function uiEvidence(over: Partial<AlignEvidence> = {}): AlignEvidence {
  return {
    reference: 'Subtitle file',
    sourceCues: 120,
    referenceCues: 118,
    sourceDialogue: 120,
    referenceDialogue: 118,
    coveragePct: 92.5,
    retainedPct: 97.3,
    pairs: 111,
    retained: 108,
    vote: 0.81,
    overlap: 0.77,
    scale: 25 / (24000 / 1001),
    offsetMs: 2340,
    residualAbsMedianMs: 41,
    residualAbsP95Ms: 160,
    issues: [],
    attempts: [{ reference: 'Subtitle file', verdict: 'accept', reason: 'ok' }],
    ...over
  }
}

export const UI_ROWS: AlignPreviewRow[] = [
  { index: 1, startMs: 1_000, endMs: 2_500, newStartMs: 3_383, newEndMs: 4_946, text: 'First line' },
  { index: 2, startMs: 3_723_004, endMs: 3_725_000, newStartMs: 3_881_545, newEndMs: 3_883_626, text: 'Second line\nwith two rows' },
  { index: 3, startMs: 4_000_000, endMs: 4_001_000, newStartMs: 4_170_000, newEndMs: 4_171_043, text: 'Third' }
]

export function uiResult(verdict: 'accept' | 'check', over: Partial<AlignEvidence> = {}): Result {
  return {
    status: 'result',
    generation: 7,
    resultId: 'a'.repeat(64),
    verdict,
    reason: verdict === 'accept' ? 'ok' : 'partial_coverage',
    evidence: uiEvidence(verdict === 'check' ? { coveragePct: 84.5, ...over } : over),
    preview: { total: 10, from: 0, rows: UI_ROWS }
  }
}

export function uiRefusal(reason: Refused['reason'], evidence: AlignEvidence | null = null): Refused {
  return { status: 'refused', generation: 7, verdict: 'refuse', reason, message: `Measured explanation for ${reason}.`, evidence }
}
