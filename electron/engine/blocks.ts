/**
 * Content-block classification (implementation_plan.md Step 2.3, capability A1). AUTHORED-BY: opus-5.5-high
 *
 * The one classifier: Phase 2 reports its answer in the typed failure, Phase 3 turns it into copy and
 * Bundle G into a recovery strategy, and neither may build another. gst 3.7.0 cannot make this
 * distinction because it keeps `promptFeedback` in a local (`reference_1.1.0/parked_FP-9_
 * prohibited_content.md:145-152`, upstream #133); owning the call exposes it.
 *
 * It reads the reply's complete structural envelope — every key the body carried, with control words
 * such as `blockReason` and `finishReason` kept (`providers/gemini.ts` `structuralEnvelope`) — rather
 * than a projection, because the field that answers is not always the one expected: a blocked reply
 * can carry `promptFeedback.blockReason` and no `candidates` at all. Nothing here retries, splits or
 * preserves.
 */
import type { ContentBlockClass, ProviderReply, StructuralEnvelope } from './providers/types'

type Obj = { [key: string]: StructuralEnvelope }

const SEARCH_DEPTH_CAP = 16

function isObj(v: StructuralEnvelope | undefined): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function word(v: StructuralEnvelope | undefined): string {
  return typeof v === 'string' ? v.trim().toUpperCase() : ''
}

/** A `blockReason`/`block_reason` key anywhere in the body, depth-first in key order. */
function anyBlockReason(node: StructuralEnvelope | undefined, depth = 0): string {
  if (depth >= SEARCH_DEPTH_CAP || node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = anyBlockReason(item, depth + 1)
      if (found) return found
    }
    return ''
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.replace(/_/g, '').toLowerCase() === 'blockreason' && word(v)) return word(v)
    const found = anyBlockReason(v, depth + 1)
    if (found) return found
  }
  return ''
}

function named(w: string): Exclude<ContentBlockClass, 'NONE'> {
  if (w === 'PROHIBITED_CONTENT') return 'PROHIBITED_CONTENT'
  if (w === 'OTHER') return 'OTHER'
  return 'UNKNOWN'
}

/** The word a content block is named by, in `classifyBlock`'s order; `''` when it names none; null when not a block. */
function blockWord(reply: ProviderReply): string | null {
  const result = reply.result
  if (result.ok || result.kind !== 'blocked') return null
  const env = reply.envelope
  if (isObj(env)) {
    const feedback = env.promptFeedback
    if (isObj(feedback) && word(feedback.blockReason)) return word(feedback.blockReason)
    const candidates = env.candidates
    if (!Array.isArray(candidates) || candidates.length === 0) return anyBlockReason(env) || word(result.reason)
    const first = candidates[0]
    if (isObj(first) && word(first.finishReason)) return word(first.finishReason)
  }
  return word(result.reason)
}

/**
 * AR-FINAL-2's third shape, for Bundle G's recovery ladder (§17.8R PR-2): a content block, its class,
 * and whether the reply named any word for it at all (`named` false is E18a's reason-absent block).
 */
export interface AnnouncedBlock {
  readonly shape: 'AnnouncedBlock'
  readonly block: Exclude<ContentBlockClass, 'NONE'>
  readonly named: boolean
}

/** The reply as an `AnnouncedBlock`, or null when it is not a content block. */
export function announcedBlock(reply: ProviderReply): AnnouncedBlock | null {
  const w = blockWord(reply)
  if (w === null) return null
  return Object.freeze({ shape: 'AnnouncedBlock', block: named(w), named: w !== '' })
}

/**
 * Total over every `ProviderReply`. A reply that is not a content block (`ok`, quota, auth,
 * network, malformed and the rest) is `NONE`. A content block is named from the envelope in the
 * order the provider classified it (`gemini.ts` `parseGenerateContentBody`): the prompt's
 * `promptFeedback.blockReason`; else, when candidates are absent or empty, any `blockReason` the body
 * carries; else the first candidate's `finishReason`; else the word the provider kept. A block that
 * names neither `PROHIBITED_CONTENT` nor `OTHER` — `SAFETY`, `BLOCKLIST`, a word the envelope had to
 * omit, or no word at all — is `UNKNOWN`, never guessed into one of the two.
 */
export function classifyBlock(reply: ProviderReply): ContentBlockClass {
  const w = blockWord(reply)
  return w === null ? 'NONE' : named(w)
}
