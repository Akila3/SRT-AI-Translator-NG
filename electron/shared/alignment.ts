/**
 * The alignment result contract main and renderer share (implementation_plan.md §9.4b, Registry-13).
 * AUTHORED-BY: opus-5.5-high
 *
 * Versioned and discriminated. The only NG verdicts are `accept`, `check` and `refuse`; only NG's own
 * `independent-align` analysis produces one. `candidate` names an ALASS output nobody has judged yet:
 * it is a lifecycle label and never stands in for a verdict, and no external report can express a
 * verdict or preview eligibility. Evidence is numbers and text-free codes only.
 */

export const ALIGNMENT_CONTRACT_VERSION = 1 as const

export const ALIGNMENT_VERDICTS = Object.freeze(['accept', 'check', 'refuse'] as const)
export type AlignmentVerdict = (typeof ALIGNMENT_VERDICTS)[number]

/** §9.4b Bundle B item 9, exactly. `partial_coverage` is the reason of an otherwise-valid 60–<85% `check`. */
export const ALIGNMENT_REASONS = Object.freeze([
  'ok',
  'partial_coverage',
  'malformed',
  'insufficient',
  'wrong_title',
  'weak_correspondence',
  'likely_different_cut',
  'invariant_failure'
] as const)
export type AlignmentReason = (typeof ALIGNMENT_REASONS)[number]
export type AlignmentUsableReason = 'ok' | 'partial_coverage'
export type AlignmentRefusalReason = Exclude<AlignmentReason, AlignmentUsableReason>

/**
 * Bundle M §16.0.4: the stop that several embedded tracks can reach and no single A–I call can. Kept apart
 * from `ALIGNMENT_REASONS`, which is one A–I verdict's taxonomy, so such a refusal carries no contract.
 */
export const ARBITRATION_REASONS = Object.freeze(['embedded_track_conflict'] as const)
export type ArbitrationReason = (typeof ARBITRATION_REASONS)[number]

/** Global is NG's one map; piecewise is the explicit Advanced (ALASS) action. */
export type AlignmentMode = 'global' | 'piecewise'

/** Whose timeline is being judged. An `alass-candidate` is judged by NG exactly like NG's own map. */
export type AlignmentCandidateSource = 'ng-global' | 'alass-candidate'

/** What it was judged against. */
export type AlignmentReferenceKind = 'subtitle' | 'embedded' | 'audio' | 'transcription'

export type AlignmentLocalPattern =
  | 'stable_local_offset'
  | 'likely_fps_or_scale_drift'
  | 'likely_different_cut'
  | 'mixed_local_anomaly'
  | 'insufficient_local_evidence'

export interface AlignmentLocalEvidence {
  pattern: AlignmentLocalPattern
  piecewiseSteps: boolean
  linearDrift: boolean
  driftR2: number | null
  stepEvents: number
  supportedWindows: number
  unsupportedWindows: number
  strongestWindowVote: number
}

export interface AlignmentDriftEvidence {
  firstThirdOffsetMs: number | null
  lastThirdOffsetMs: number | null
  driftMs: number | null
  warning: boolean
}

export interface AlignmentIdentityEvidence {
  coveragePct: number
  medianDeltaMs: number | null
  alreadyAligned: boolean
  keptIdentity: boolean
}

export interface AlignmentInvariantEvidence {
  ok: boolean
  issues: string[]
}

/** `t_ref = scale·t_src + offsetMs`. A piecewise candidate has no single map, so it carries none. */
export interface AlignmentTransform {
  scale: number
  offsetMs: number
}

/** A representative cue's move, text-free: the preview rows carry the user's own lines separately. */
export interface AlignmentMovement {
  index: number
  fromMs: number
  toMs: number
  deltaMs: number
}

export interface AlignmentEvidence {
  sourceCues: number
  referenceCues: number
  sourceDialogue: number
  referenceDialogue: number
  pairs: number | null
  retained: number | null
  retainedPct: number | null
  coveragePct: number | null
  residualMedianMs: number | null
  residualAbsMedianMs: number | null
  residualAbsP95Ms: number | null
  local: AlignmentLocalEvidence | null
  drift: AlignmentDriftEvidence | null
  identity: AlignmentIdentityEvidence | null
  invariants: AlignmentInvariantEvidence | null
}

interface AlignmentResultBase {
  version: typeof ALIGNMENT_CONTRACT_VERSION
  mode: AlignmentMode
  candidateSource: AlignmentCandidateSource
  referenceKind: AlignmentReferenceKind
  evidence: AlignmentEvidence
}

export type AlignmentResult =
  | (AlignmentResultBase & {
      verdict: 'accept' | 'check'
      reason: AlignmentUsableReason
      transform: AlignmentTransform | null
      movements: AlignmentMovement[]
    })
  | (AlignmentResultBase & { verdict: 'refuse'; reason: AlignmentRefusalReason })

export function isAlignmentVerdict(value: unknown): value is AlignmentVerdict {
  return typeof value === 'string' && (ALIGNMENT_VERDICTS as readonly string[]).includes(value)
}

export function isAlignmentReason(value: unknown): value is AlignmentReason {
  return typeof value === 'string' && (ALIGNMENT_REASONS as readonly string[]).includes(value)
}

/** Preview and Apply follow the verdict alone: `accept` and `check` may, `refuse` may not. */
export function previewEligible(result: Pick<AlignmentResult, 'verdict'>): boolean {
  return result.verdict === 'accept' || result.verdict === 'check'
}

/** A global refusal that may offer **Try piecewise** — still a refusal, and never an Apply. */
export function offersPiecewise(result: Pick<AlignmentResult, 'mode' | 'verdict' | 'reason'>): boolean {
  return result.mode === 'global' && result.verdict === 'refuse' && result.reason === 'likely_different_cut'
}
