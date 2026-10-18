/**
 * Stage C for the dedicated transcription path (implementation_plan.md Bundle I §17.7, I.9): optional
 * requests that rewrite cue text and nothing else. AUTHORED-BY: opus-5.5-high
 *
 * A word-for-word transcript keeps every filler and stutter, and the mode that would clean them
 * (`SMART`) is refused whenever timestamps are asked for (`genai.d.ts:853`). This sends `{index, text}`
 * per cue, `POLISH_BATCH_CUES` at a time and one request after another, to the polishing model and
 * takes back texts only: start and end never leave Stage B, so no answer can move a subtitle.
 *
 * A model asked to tidy a run of sentence fragments re-cuts them: it moves words into the next
 * subtitle, merges two, or slides every text one slot along (gate_ledger.md §5p.13). Each answer is
 * therefore judged against its own subtitle (`guardPolishedBatch`); one that no longer matches keeps
 * Stage B's text, and a batch whose order has slipped keeps all of it. A transcription model has no
 * text task, so with one as the polishing model nothing is sent and the reason is said.
 */
import type { RunError, Usage } from '../shared/engineEvents'
import type { ModelRequestConfig } from '../shared/modelCaps'
import { isDedicatedTranscribeModel } from '../shared/transcribeSettings'
import type { GenerationProvider, ProviderRequest } from './providers/types'
import { responseLimitBytes } from './providers/responseLimit'
import { createKeyRotation } from './keys'
import { withRetry, type AttemptGate, type RetryBudget, type RetryClock, type RetryPolicy } from './retry'
import { STAGE_B_RULES } from './cues'

/** Names the response schema in a receipt. */
export const POLISH_RESPONSE_SCHEMA_ID = 'stage-c-index-text'

/** Cues per request. 50 was the best of 25, 50, 100 and the whole list on three full recordings (gate_ledger.md §5p.13). */
export const POLISH_BATCH_CUES = 50

/** A batch with more refused answers than this share has lost its order; all of it keeps Stage B's text. */
export const POLISH_SLIPPED_SHARE = 0.2

export const POLISH_INSTRUCTION = [
  'You are editing subtitles that were transcribed word for word from speech.',
  'Each subtitle is shown on screen only while its own words are spoken, so its words must stay in it.',
  'The input is a JSON array of objects, each with an "index" and a "text". Return a JSON array with every index exactly once, in the same order, each with a cleaned "text" made from that same subtitle\u2019s own words:',
  '- Remove filler sounds, stutters and words repeated by accident.',
  '- Correct punctuation, capitalisation, obvious slips of grammar and words that were clearly misheard.',
  '- Keep the language, the wording, the meaning and every name as they are. Do not translate, summarise, censor, explain or add anything.',
  '- Never move a word into another subtitle, and never merge or split subtitles. A subtitle may begin or end in the middle of a sentence; leave it so.',
  '- If a subtitle is only filler sounds, return its text unchanged.',
  '- If a text needs no change, return it unchanged.'
].join('\n')

function polishResponseSchema(): unknown {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: { index: { type: 'string' }, text: { type: 'string' } },
      required: ['index', 'text']
    }
  }
}

/** The items sent for `texts`: position `i` as the string index, the shape a translation batch sends. */
export function indexedItems(texts: readonly string[]): { index: string; text: string }[] {
  return texts.map((text, i) => ({ index: String(i), text }))
}

/** One Stage C request: these cues' texts, by position in the batch, and nothing that carries time. */
export function polishRequest(model: string, texts: readonly string[], config: ModelRequestConfig, language?: string): ProviderRequest {
  return {
    model,
    systemInstruction: language ? `${POLISH_INSTRUCTION}\nThe subtitles are in ${language}.` : POLISH_INSTRUCTION,
    parts: [{ text: JSON.stringify(indexedItems(texts)) }],
    responseMimeType: 'application/json',
    responseJsonSchema: polishResponseSchema(),
    ...(config.thinking ? { thinking: { ...config.thinking } } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.topP !== undefined ? { topP: config.topP } : {}),
    ...(config.topK !== undefined ? { topK: config.topK } : {}),
    ...(config.serviceTier ? { serviceTier: config.serviceTier } : {})
  }
}

/** Scripts written without spaces between words, compared by character pairs instead of words. */
const UNSPACED = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\u0e00-\u0e7f\u0e80-\u0eff\u1000-\u109f\u1780-\u17ff]/u
/** What may not begin a line in an unspaced script: a combining mark, a closing mark, a small kana. */
const NO_LINE_START = /[\p{M}、。，．！？!?）)」』】〉》〕｝ー…・ゃゅょっぁぃぅぇぉゎァィゥェォッャュョヮヵヶ々]/u
/** What may not end one: an opening mark. */
const NO_LINE_END = /[（(「『【〈《〔｛]/u

/**
 * A polished text laid out under Stage B's own line rules, or null when it does not fit them. The
 * model's line break is a suggestion; the layout is Stage B's arithmetic — one line when it fits,
 * otherwise the two-line break that makes the longer line shortest. A line may break at a space, or
 * between two characters of a script written without spaces; a single word with neither is its own
 * line, as in Stage B.
 */
export function relayPolished(text: string): string | null {
  const words = text.split(/\s+/u).filter((w) => w !== '')
  if (words.length === 0) return null
  // Joined as Stage B joins words: no space between two characters of an unspaced script.
  let flat = ''
  for (const w of words) flat = flat === '' ? w : UNSPACED.test(flat.slice(-1)) && UNSPACED.test(w.charAt(0)) ? flat + w : `${flat} ${w}`
  const chars = Array.from(flat)
  if (chars.length <= STAGE_B_RULES.lineChars) return flat
  let best: string | null = null
  let bestLongest = Infinity
  let breaks = 0
  for (let k = 1; k < chars.length; k++) {
    const atSpace = chars[k] === ' '
    if (!atSpace && !(UNSPACED.test(chars[k - 1]) && UNSPACED.test(chars[k]) && !NO_LINE_START.test(chars[k]) && !NO_LINE_END.test(chars[k - 1]))) continue
    breaks++
    const top = chars.slice(0, k)
    const bottom = chars.slice(atSpace ? k + 1 : k)
    const longest = Math.max(top.length, bottom.length)
    if (longest <= STAGE_B_RULES.lineChars && longest < bestLongest) {
      best = `${top.join('')}\n${bottom.join('')}`
      bestLongest = longest
    }
  }
  return best ?? (breaks === 0 ? flat : null)
}
/** Nearer subtitles on each side an answer is compared with: a slide can run more than one slot. */
const NEIGHBOURS = 3
/** Least likeness to its own subtitle an answer may keep (character-pair Dice, 0–1). */
const OWN_LIKENESS = 0.5
/** Least share of its own letters an answer may keep, counted after repeated words are collapsed. */
const KEPT_LETTERS = 0.5

function normal(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/gu, ' ').trim()
}

function tokens(text: string): string[] {
  const n = normal(text)
  if (!UNSPACED.test(n)) return n.split(' ').filter((w) => w !== '')
  const chars = Array.from(n.replace(/ /g, ''))
  return chars.slice(1).map((c, i) => chars[i] + c)
}

function pairs(text: string): Map<string, number> {
  const chars = Array.from(` ${normal(text)} `)
  const m = new Map<string, number>()
  for (let i = 0; i + 1 < chars.length; i++) {
    const g = chars[i] + chars[i + 1]
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

function likeness(a: string, b: string): number {
  const A = pairs(a)
  const B = pairs(b)
  let shared = 0
  let total = 0
  for (const [g, n] of A) {
    shared += Math.min(n, B.get(g) ?? 0)
    total += n
  }
  for (const n of B.values()) total += n
  return total === 0 ? 1 : (2 * shared) / total
}

/** The items of `a` left after taking away one of each item of `b`. */
function without(a: readonly string[], b: readonly string[]): string[] {
  const pool = new Map<string, number>()
  for (const w of b) pool.set(w, (pool.get(w) ?? 0) + 1)
  return a.filter((w) => {
    const n = pool.get(w) ?? 0
    if (n > 0) pool.set(w, n - 1)
    return n === 0
  })
}

function letters(text: string): number {
  return Array.from(normal(text).replace(/ /g, '')).length
}

export type PolishRefusal = 'missing' | 'repeated' | 'empty' | 'nearer' | 'unlike' | 'cut' | 'borrowed' | 'moved'

export type GuardedBatch =
  | { ok: true; texts: string[]; refused: PolishRefusal[] }
  | { ok: false; kind: 'malformed' | 'slipped' }

/**
 * Which answers in one reply may replace their subtitle. `texts[i]` is the answer for cue `i`, or
 * the sent text when that answer is refused; `refused` lists one reason per refused cue. An answer is
 * refused when it is missing, repeated or empty, when another subtitle within `NEIGHBOURS` is more like
 * it than its own, when it keeps too little of its own subtitle, or when it gained words a neighbour
 * sent (both are refused when the neighbour lost them). More refusals than `POLISH_SLIPPED_SHARE` of the
 * batch, counting invented indices, is a slipped order and nothing is used.
 */
export function guardPolishedBatch(sent: readonly string[], replyText: string): GuardedBatch {
  let parsed: unknown
  try {
    parsed = JSON.parse(replyText)
  } catch {
    return { ok: false, kind: 'malformed' }
  }
  if (!Array.isArray(parsed)) return { ok: false, kind: 'malformed' }
  const answer = new Array<string | undefined>(sent.length).fill(undefined)
  const why = new Array<PolishRefusal | null>(sent.length).fill(null)
  let invented = 0
  for (const item of parsed as unknown[]) {
    const index = (item as { index?: unknown } | null)?.index
    const text = (item as { text?: unknown } | null)?.text
    const i = typeof index === 'string' && /^(0|[1-9]\d*)$/.test(index) ? Number(index) : -1
    if (i < 0 || i >= sent.length || typeof text !== 'string') {
      invented++
      continue
    }
    if (answer[i] !== undefined) why[i] = 'repeated'
    answer[i] = text
  }
  for (let i = 0; i < sent.length; i++) {
    const a = answer[i]
    if (why[i]) continue
    if (a === undefined) why[i] = 'missing'
    else if (a.trim() === '' && sent[i].trim() !== '') why[i] = 'empty'
    else if (a !== sent[i] && normal(a) !== normal(sent[i])) {
      const own = likeness(a, sent[i])
      let other = 0
      for (let j = Math.max(0, i - NEIGHBOURS); j <= Math.min(sent.length - 1, i + NEIGHBOURS); j++) {
        if (j !== i) other = Math.max(other, likeness(a, sent[j]))
      }
      const collapsed = normal(sent[i])
        .split(' ')
        .filter((w, k, all) => k === 0 || w !== all[k - 1])
        .join(' ')
      const gained = without(tokens(a), tokens(sent[i]))
      const beside = [...tokens(sent[i - 1] ?? ''), ...tokens(sent[i + 1] ?? '')]
      if (other > own) why[i] = 'nearer'
      else if (own < OWN_LIKENESS) why[i] = 'unlike'
      else if (letters(a) < KEPT_LETTERS * letters(collapsed)) why[i] = 'cut'
      else if (gained.filter((w) => beside.includes(w)).length >= 2) why[i] = 'borrowed'
    }
  }
  // Words that crossed a boundary. With the neighbour refused they would show twice, so the gainer is
  // refused; with the neighbour used they would vanish if the gainer were refused alone, so both are.
  for (let i = 0; i + 1 < sent.length; i++) {
    for (const [a, b] of [
      [i, i + 1],
      [i + 1, i]
    ] as const) {
      const text = answer[a]
      if (text === undefined || text === sent[a]) continue
      const gained = without(tokens(text), tokens(sent[a]))
      if (gained.length === 0) continue
      const lost = why[b] ? tokens(sent[b]) : without(tokens(sent[b]), tokens(answer[b] ?? ''))
      if (gained.filter((w) => lost.includes(w)).length >= (UNSPACED.test(sent[a]) ? 2 : 1)) {
        if (!why[a]) why[a] = 'moved'
        if (!why[b]) why[b] = 'moved'
      }
    }
  }
  const refused = why.filter((w): w is PolishRefusal => w !== null)
  if (refused.length + invented > POLISH_SLIPPED_SHARE * sent.length) return { ok: false, kind: 'slipped' }
  return { ok: true, texts: sent.map((s, i) => (why[i] ? s : (answer[i] ?? s))), refused }
}

export type PolishOutcome =
  | {
      kind: 'polished'
      texts: string[]
      changed: number
      /** Cues whose answer was refused or whose whole batch was unusable; they keep Stage B's text. */
      unmatched: number
      /** Cues in batches the model refused to answer (a content block); they keep Stage B's text. */
      blocked?: number
      /** Set when a request failed for good after some batches landed; the rest were not sent. */
      stopped?: string
      usage?: Usage
      /** Requests actually sent, retries included. */
      attempts?: number
      /** Of those, the resends of a batch after its first send. */
      retries?: number
    }
  | { kind: 'kept'; reason: string; usage?: Usage; attempts?: number; retries?: number }
  /** The run's request record could not be written. Not optional polishing's to absorb: the run ends. */
  | { kind: 'failed'; error: RunError; usage?: Usage; attempts?: number; retries?: number }

export interface PolishOptions {
  provider: GenerationProvider
  /** The polishing model: the Transcribe tab's choice, or the Settings translation model. Never the transcription model. */
  model: string
  config: ModelRequestConfig
  /** Stage B's cue texts, in cue order. */
  texts: readonly string[]
  /** The confirmed language's name, so the model keeps to it. */
  language?: string
  keys: readonly string[]
  slots: readonly number[]
  budget: RetryBudget
  retry?: { policy?: Partial<RetryPolicy>; clock?: RetryClock }
  say: (text: string) => void
  signal: AbortSignal
  /** The run's Stage C request gate (`createRequestGate`, stage `polish`): routing, pacing and the reservation against this model. */
  gate?: AttemptGate
}

const KEPT = 'The subtitles keep the transcription\u2019s own wording.'

function unusableReply(kind: 'malformed' | 'slipped' | 'blocked', blockReason?: string): string {
  if (kind === 'malformed') return 'its answer was not a usable list of subtitles'
  if (kind === 'blocked') return `the model refused to edit the subtitles${blockReason ? ` (${blockReason})` : ''}`
  return 'its answers did not keep each subtitle\u2019s own words in place'
}

function sumUsage(parts: readonly Usage[]): Usage | undefined {
  if (parts.length === 0) return undefined
  return parts.reduce<Usage>(
    (t, u) => ({
      promptTokens: t.promptTokens + u.promptTokens,
      thoughtTokens: t.thoughtTokens + u.thoughtTokens,
      outputTokens: t.outputTokens + u.outputTokens,
      totalTokens: t.totalTokens + u.totalTokens
    }),
    { promptTokens: 0, thoughtTokens: 0, outputTokens: 0, totalTokens: 0 }
  )
}

/** Why Stage C cannot run on `model`, or null when it can. */
export function polishUnavailableReason(model: string): string | null {
  if (!model.trim()) return `Polishing was not applied: no polishing model is set. ${KEPT}`
  if (isDedicatedTranscribeModel(model)) {
    return `Polishing was not applied: the polishing model, "${model.trim()}", is a transcription model and cannot edit text. ${KEPT}`
  }
  return null
}

/**
 * One request per batch, in order, each through `retry.ts` for waits and resends of a transient
 * failure. An answer is judged, never resent: a batch that cannot be used, or that the model refused
 * for its content, keeps Stage B's text and the next is sent. Any other request that fails for good
 * stops the rest, since the next would fail the same way, keeping what already landed.
 */
export async function polishCueTexts(opts: PolishOptions): Promise<PolishOutcome> {
  const unavailable = polishUnavailableReason(opts.model)
  if (unavailable) return { kind: 'kept', reason: unavailable }
  if (opts.texts.length === 0) return { kind: 'polished', texts: [], changed: 0, unmatched: 0 }
  const limitBytes = responseLimitBytes({ outputTokenLimit: null })
  const keys = createKeyRotation(opts.slots)
  const spent: Usage[] = []
  let wasted = 0
  const texts = [...opts.texts]
  let changed = 0
  let unmatched = 0
  let blocked = 0
  let used = 0
  let lastUnusable: 'malformed' | 'slipped' = 'malformed'
  let lastBlockReason: string | undefined
  let stopped: string | undefined
  let attempts = 0
  let retries = 0
  const sentCount = () => ({ ...(attempts > 0 ? { attempts } : {}), ...(retries > 0 ? { retries } : {}) })
  const usageSoFar = (): Usage | undefined => {
    const total = sumUsage(spent)
    return total && wasted > 0 ? { ...total, billedButUnusableTokens: wasted } : total
  }
  for (let from = 0; from < opts.texts.length; from += POLISH_BATCH_CUES) {
    const sent = opts.texts.slice(from, from + POLISH_BATCH_CUES)
    const request = polishRequest(opts.model, sent, opts.config, opts.language)
    const outcome = await withRetry<GuardedBatch>({
      keys,
      budget: opts.budget,
      signal: opts.signal,
      ...(opts.retry?.policy ? { policy: opts.retry.policy } : {}),
      ...(opts.retry?.clock ? { clock: opts.retry.clock } : {}),
      ...(opts.gate ? { gate: opts.gate } : {}),
      onRetry: (notice) => opts.say(`Polishing: ${notice.message}`),
      attempt: async ({ keySlot, signal, timeoutMs }) => {
        const reply = await opts.provider.generate(request, {
          apiKey: opts.keys[keySlot] ?? '',
          keyIndex: keySlot,
          signal,
          responseLimitBytes: limitBytes,
          timeoutMs
        })
        if (!reply.result.ok) return { ok: false as const, failure: reply.result, usage: reply.usage }
        return { ok: true as const, value: guardPolishedBatch(sent, reply.result.text), usage: reply.usage }
      }
    })
    attempts += outcome.attempts
    retries += Math.max(0, outcome.attempts - 1)
    const batchUsage = sumUsage(outcome.usage)
    if (batchUsage) spent.push(batchUsage)
    // A batch the model answered, usable or not, or refused for its content, is settled: the errors
    // before it are no longer "in a row" (`RetryBudget.accept`, as a committed part does in Stage A).
    if (!outcome.ok && outcome.reason === 'caller' && outcome.error?.kind === 'blocked') {
      lastBlockReason = outcome.error.blockReason
      blocked += sent.length
      wasted += batchUsage?.totalTokens ?? 0
      opts.budget.accept()
      continue
    }
    if (!outcome.ok && outcome.storage && outcome.error) {
      wasted += outcome.discarded?.totalTokens ?? 0
      const usage = usageSoFar()
      return { kind: 'failed', error: outcome.error, ...(usage ? { usage } : {}), ...sentCount() }
    }
    if (!outcome.ok) {
      const error: RunError | undefined = outcome.error
      const why = outcome.reason === 'cancelled' || !error ? 'the run was stopped' : error.message.replace(/\.$/, '')
      if (outcome.reason === 'cancelled' || used === 0) {
        const usage = usageSoFar()
        return { kind: 'kept', reason: `Polishing was not applied: ${why}. ${KEPT}`, ...(usage ? { usage } : {}), ...sentCount() }
      }
      stopped = why
      break
    }
    opts.budget.accept()
    if (!outcome.value.ok) {
      lastUnusable = outcome.value.kind
      unmatched += sent.length
      wasted += batchUsage?.totalTokens ?? 0
      continue
    }
    used++
    unmatched += outcome.value.refused.length
    outcome.value.texts.forEach((answer, i) => {
      const before = sent[i]
      if (answer === before) return
      const laid = relayPolished(answer)
      if (laid === null || laid === before) return
      texts[from + i] = laid
      changed++
    })
  }
  const usage = usageSoFar()
  if (used === 0) {
    const kind = blocked === opts.texts.length ? 'blocked' : lastUnusable
    return { kind: 'kept', reason: `Polishing was not applied: ${unusableReply(kind, lastBlockReason)}. ${KEPT}`, ...(usage ? { usage } : {}), ...sentCount() }
  }
  return { kind: 'polished', texts, changed, unmatched, ...(blocked > 0 ? { blocked } : {}), ...(stopped ? { stopped } : {}), ...(usage ? { usage } : {}), ...sentCount() }
}
