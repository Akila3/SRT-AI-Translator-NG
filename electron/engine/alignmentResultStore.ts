/**
 * The Align tab's one live outcome (Bundle M, implementation_plan.md §16.0.5).
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * Pure: no Electron, no file system. It holds the renderer-minted generation's high-water mark and at most
 * one snapshot — the latest generation's final outcome — with its optional applicable candidate and its
 * optional text-free diagnostic. Preview and Apply find a candidate only by `{ generation, resultId }`; a
 * refusal's snapshot has no candidate, so nothing can preview or apply it. A newer generation, a cancel
 * and a dispose drop the whole snapshot; a successful Apply consumes the candidate only, so the diagnostic
 * of what was applied stays exportable. There is no cache and no record of consumed ids: an identical
 * later analysis gets the same id and is a new entry that can be consumed once.
 */
import { createHash } from 'crypto'

/** Where the outcome was decided: before A–I, by one A–I call, by arbitration between tracks, or writing the copy. */
export type SnapshotStage = 'input' | 'ai' | 'arbitration' | 'write'

/** What an applicable candidate's id is computed from. Never the generation. */
export interface CandidateDigests {
  sourceSha: string
  referenceShas: string[]
  candidateSha: string
  verdict: 'accept' | 'check'
  reason: 'ok' | 'partial_coverage'
  scale: number | null
  offsetMs: number | null
}

export interface StoredCandidate<P> {
  resultId: string
  /** The exact bytes Apply writes. Held in memory only. */
  bytes: Buffer
  digests: CandidateDigests
  /** The service's own fields (paths, preview rows); the store never reads them. */
  payload: P
}

export interface AlignmentSnapshot<D, P> {
  generation: number
  stage: SnapshotStage
  diagnostic: D | null
  candidate: StoredCandidate<P> | null
}

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** `sha256` of the canonical JSON `{ v, sourceSha, referenceShas, candidateSha, verdict, reason, scale, offsetMs }`, keys in that order. */
export function alignmentResultId(d: CandidateDigests): string {
  return sha256Hex(
    JSON.stringify({
      v: 1,
      sourceSha: d.sourceSha,
      referenceShas: [...d.referenceShas],
      candidateSha: d.candidateSha,
      verdict: d.verdict,
      reason: d.reason,
      scale: d.scale,
      offsetMs: d.offsetMs
    })
  )
}

/** A candidate for `bytes`, its id derived from its digests. */
export function makeCandidate<P>(bytes: Buffer, digests: Omit<CandidateDigests, 'candidateSha'>, payload: P): StoredCandidate<P> {
  const full: CandidateDigests = { ...digests, referenceShas: [...digests.referenceShas], candidateSha: sha256Hex(bytes) }
  return { resultId: alignmentResultId(full), bytes, digests: full, payload }
}

export type VerifyOutcome = 'ok' | 'source_changed' | 'changed'

export class AlignmentResultStore<D, P> {
  private last = 0
  private snap: AlignmentSnapshot<D, P> | null = null

  /** The landed high-water rule: only a generation above every earlier one runs; it drops the old snapshot. */
  admit(generation: number): boolean {
    if (!(generation > this.last)) return false
    this.last = generation
    this.snap = null
    return true
  }

  latest(): number {
    return this.last
  }

  live(generation: number): boolean {
    return generation === this.last
  }

  /** Record the live generation's final outcome; an outcome for an older generation is not kept. */
  put(snapshot: AlignmentSnapshot<D, P>): boolean {
    if (!this.live(snapshot.generation)) return false
    this.snap = snapshot
    return true
  }

  snapshot(generation: number): AlignmentSnapshot<D, P> | null {
    return this.snap && this.snap.generation === generation && this.live(generation) ? this.snap : null
  }

  /** The applicable candidate for exactly this generation and id, or null. */
  candidate(generation: unknown, resultId: unknown): StoredCandidate<P> | null {
    const s = typeof generation === 'number' ? this.snapshot(generation) : null
    return s?.candidate && typeof resultId === 'string' && s.candidate.resultId === resultId ? s.candidate : null
  }

  /** A successful Apply: the candidate is gone, the rest of the snapshot stays. */
  consume(candidate: StoredCandidate<P>): void {
    if (this.snap?.candidate === candidate) this.snap = { ...this.snap, candidate: null }
  }

  /** Drop the snapshot: all of it, or only when it belongs to `generation`. */
  drop(generation?: number): void {
    if (generation === undefined || this.snap?.generation === generation) this.snap = null
  }

  /**
   * At Apply, before anything is written: the source must still be the bytes analysed, and the candidate's
   * bytes and id must still be what its digests say. Any mismatch drops the snapshot.
   */
  verify(candidate: StoredCandidate<P>, sourceBytes: Buffer): VerifyOutcome {
    let outcome: VerifyOutcome = 'ok'
    if (sha256Hex(sourceBytes) !== candidate.digests.sourceSha) outcome = 'source_changed'
    else if (sha256Hex(candidate.bytes) !== candidate.digests.candidateSha || alignmentResultId(candidate.digests) !== candidate.resultId) outcome = 'changed'
    if (outcome !== 'ok' && this.snap?.candidate === candidate) this.snap = null
    return outcome
  }
}
