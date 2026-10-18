/**
 * Align tab view fixtures for Advanced (R13.6). Synthetic, author-written: shaped like what `alignService`
 * returns for a piecewise run and for a Global different-cut refusal, so the cards render without a run.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import { ALIGNMENT_CONTRACT_VERSION, type AlignmentEvidence, type AlignmentMode, type AlignmentMovement, type AlignmentResult } from '../../../../../electron/shared/alignment'
import type { AlignAdvancedDiagnostics, AlignAdvancedStatus, AlignAnalysis } from '../../../../../electron/shared/types'
import { UI_ROWS, uiEvidence } from './fixtures'

type Result = Extract<AlignAnalysis, { status: 'result' }>
type Refused = Extract<AlignAnalysis, { status: 'refused' }>

export const UI_MOVEMENTS: AlignmentMovement[] = [
  { index: 1, fromMs: 1_000, toMs: 3_383, deltaMs: 2_383 },
  { index: 31, fromMs: 1_200_000, toMs: 1_202_383, deltaMs: 2_383 },
  { index: 61, fromMs: 2_400_000, toMs: 2_374_617, deltaMs: -25_383 },
  { index: 91, fromMs: 3_600_000, toMs: 3_574_617, deltaMs: -25_383 },
  { index: 120, fromMs: 4_800_000, toMs: 4_774_617, deltaMs: -25_383 }
]

export const UI_ADVANCED: AlignAdvancedDiagnostics = { engine: 'alass-cli 2.0.0', shiftGroups: 2, score: 1234.5, fpsRatio: '1' }

/** Every reason main can give for Advanced being unavailable, each with its own sentence. */
export const UI_UNAVAILABLE: Array<Extract<AlignAdvancedStatus, { available: false }>> = [
  { available: false, reason: 'absent', message: 'Advanced is not available: ALASS is not installed. Global alignment still works.' },
  { available: false, reason: 'untrusted', message: 'Advanced is not available: ALASS is not the exact bundled build. Global alignment still works.' },
  { available: false, reason: 'wrong_version', message: 'Advanced is not available: ALASS reports the wrong version. Global alignment still works.' },
  { available: false, reason: 'not_runnable', message: 'Advanced is not available: ALASS could not be started. Global alignment still works.' },
  { available: false, reason: 'busy', message: 'Advanced is busy: an earlier ALASS run is still stopping. Global alignment still works.' }
]

function contractEvidence(coveragePct: number): AlignmentEvidence {
  return {
    sourceCues: 120,
    referenceCues: 118,
    sourceDialogue: 120,
    referenceDialogue: 118,
    pairs: 111,
    retained: 108,
    retainedPct: 97.3,
    coveragePct,
    residualMedianMs: 3,
    residualAbsMedianMs: 41,
    residualAbsP95Ms: 160,
    local: null,
    drift: null,
    identity: null,
    invariants: { ok: true, issues: [] }
  }
}

export function uiPiecewiseResult(verdict: 'accept' | 'check'): Result {
  const coveragePct = verdict === 'check' ? 72.5 : 92.5
  return {
    status: 'result',
    generation: 9,
    resultId: 'b'.repeat(64),
    verdict,
    reason: verdict === 'accept' ? 'ok' : 'partial_coverage',
    evidence: uiEvidence({ coveragePct, scale: 1, offsetMs: 0 }),
    preview: { total: 10, from: 0, rows: UI_ROWS },
    mode: 'piecewise',
    alignment: {
      version: ALIGNMENT_CONTRACT_VERSION,
      mode: 'piecewise',
      candidateSource: 'alass-candidate',
      referenceKind: 'subtitle',
      evidence: contractEvidence(coveragePct),
      verdict,
      reason: verdict === 'accept' ? 'ok' : 'partial_coverage',
      transform: null,
      movements: UI_MOVEMENTS
    },
    advanced: UI_ADVANCED
  }
}

/** A Global result whose contract carries the representative moves. */
export function uiGlobalResult(): Result {
  return {
    status: 'result',
    generation: 9,
    resultId: 'c'.repeat(64),
    verdict: 'accept',
    reason: 'ok',
    evidence: uiEvidence(),
    preview: { total: 10, from: 0, rows: UI_ROWS },
    mode: 'global',
    alignment: {
      version: ALIGNMENT_CONTRACT_VERSION,
      mode: 'global',
      candidateSource: 'ng-global',
      referenceKind: 'subtitle',
      evidence: contractEvidence(92.5),
      verdict: 'accept',
      reason: 'ok',
      transform: { scale: 25 / (24000 / 1001), offsetMs: 2340 },
      movements: UI_MOVEMENTS.slice(0, 2)
    }
  }
}

export function uiRefusalIn(mode: AlignmentMode, reason: AlignmentResult['reason'] & Refused['reason']): Refused {
  return {
    status: 'refused',
    generation: 9,
    verdict: 'refuse',
    reason,
    message: `Measured explanation for ${mode} ${reason}.`,
    evidence: uiEvidence({ coveragePct: 48 }),
    mode,
    alignment: {
      version: ALIGNMENT_CONTRACT_VERSION,
      mode,
      candidateSource: mode === 'piecewise' ? 'alass-candidate' : 'ng-global',
      referenceKind: 'subtitle',
      evidence: contractEvidence(48),
      verdict: 'refuse',
      reason: reason as Exclude<AlignmentResult['reason'], 'ok' | 'partial_coverage'>
    },
    ...(mode === 'piecewise' ? { advanced: UI_ADVANCED } : {})
  }
}
