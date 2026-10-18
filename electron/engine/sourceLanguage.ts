/**
 * The spoken language, detected before a dedicated transcription (D5-13; implementation_plan.md
 * §17.7, I.3). AUTHORED-BY: opus-5.5-high
 *
 * A dedicated transcription model keeps one language per request and silently drops the rest, so it
 * is sent exactly one code, the one the user confirms (D5-17). This module only proposes that code.
 *
 *  - The detector hears six 10-second samples taken at 10/25/40/55/70/85 % of the running time,
 *    joined into one clip, in one call. A film's head is very often speechless; the same detector
 *    given the first minute of the tester's Hebrew lecture answered `zxx` (probe §9e.3: naive 2/3,
 *    spread 3/3 at the same cost).
 *  - The model is the Settings translation model, with the prompt the probe measured. A dedicated
 *    transcription id has no text task, so with one there is no detection and the modal asks.
 *  - Anything but one recognised code — `zxx`, two codes, prose, an unknown code, a failed call — is
 *    an abstention, and the modal opens empty and required. Nothing is re-sampled and nothing guessed.
 */
import { canonicalLanguage } from '../shared/languages'
import type { ModelRequestConfig } from '../shared/modelCaps'
import { isDedicatedTranscribeModel } from '../shared/transcribeSettings'
import type { GenerationProvider, ProviderRequest } from './providers/types'
import { responseLimitBytes } from './providers/responseLimit'

export const DETECTION_SAMPLE_COUNT = 6
export const DETECTION_SAMPLE_SECONDS = 10

/** The detector prompt of probe 29/30 (`.secrets/f5-probe/probe-29.mjs:133`), word for word. */
export const DETECTION_INSTRUCTION =
  'Identify the language actually spoken in this audio. Reply with only its BCP-47 language code, for example "en" or "he" or "ja". ' +
  'If there is no intelligible speech at all — only music, silence or noise — reply with exactly "zxx". No other words.'

/** Older or alternative spellings of a registry language's primary subtag. */
const PRIMARY_ALIASES: Readonly<Record<string, string>> = { iw: 'he', in: 'id', nb: 'no', nn: 'no', fil: 'tl' }

const TAG = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/

export type AbstainReason = 'zxx' | 'disagreement' | 'unrecognised' | 'failed' | 'unavailable'

export type DetectorAnswer = { kind: 'detected'; code: string } | { kind: 'abstained'; reason: Extract<AbstainReason, 'zxx' | 'disagreement' | 'unrecognised'> }

/**
 * The detector's reply as one bare registry code, or why it is not one. The whole reply must be
 * codes: a sentence is not read for words that happen to look like one (`is` is Icelandic).
 */
export function readDetectorAnswer(text: string): DetectorAnswer {
  const cleaned = text.trim().replace(/^[`"'“”‘’\s]+|[`"'“”‘’.\s]+$/g, '')
  if (!cleaned) return { kind: 'abstained', reason: 'unrecognised' }
  const tokens = cleaned.split(/\s*[,;/|]\s*|\s+(?:or|and)\s+|\s+/).filter(Boolean)
  if (!tokens.every((t) => TAG.test(t))) return { kind: 'abstained', reason: 'unrecognised' }
  const primaries = [...new Set(tokens.map((t) => t.split(/[-_]/)[0].toLowerCase()))]
  if (primaries.includes('zxx')) return primaries.length === 1 ? { kind: 'abstained', reason: 'zxx' } : { kind: 'abstained', reason: 'disagreement' }
  if (primaries.length > 1) return { kind: 'abstained', reason: 'disagreement' }
  const primary = PRIMARY_ALIASES[primaries[0]] ?? primaries[0]
  const code = canonicalLanguage(primary)
  return code === primary ? { kind: 'detected', code } : { kind: 'abstained', reason: 'unrecognised' }
}

export type SourceLanguageDetection = { kind: 'detected'; code: string } | { kind: 'abstained'; reason: AbstainReason }

/** The detection request: the clip, then the instruction, in one user turn. */
export function detectionRequest(model: string, clip: { data: Buffer; mimeType: string }, config: ModelRequestConfig): ProviderRequest {
  return {
    model,
    parts: [{ inlineData: { mimeType: clip.mimeType, data: clip.data.toString('base64') } }, { text: DETECTION_INSTRUCTION }],
    ...(config.thinking ? { thinking: { ...config.thinking } } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.topP !== undefined ? { topP: config.topP } : {}),
    ...(config.topK !== undefined ? { topK: config.topK } : {}),
    ...(config.serviceTier ? { serviceTier: config.serviceTier } : {})
  }
}

export type DetectionClip = { ok: true; data: Buffer; mimeType: string } | { ok: false }

export interface DetectSourceLanguageOptions {
  /** The Settings translation model and the configuration a translation request would carry. */
  model: string
  config: ModelRequestConfig
  provider: GenerationProvider
  apiKey: string
  keyIndex: number
  /** Cuts the spread clip: `count` samples of `seconds` each (production: `ffmpeg.ts` `spreadSample`). */
  sample: (count: number, seconds: number, signal: AbortSignal) => Promise<DetectionClip>
  signal: AbortSignal
  timeoutMs?: number
}

/** One detection: never more than one clip and one request; any failure is an abstention. */
export async function detectSourceLanguage(opts: DetectSourceLanguageOptions): Promise<SourceLanguageDetection> {
  if (!opts.model || isDedicatedTranscribeModel(opts.model)) return { kind: 'abstained', reason: 'unavailable' }
  if (!opts.apiKey || opts.signal.aborted) return { kind: 'abstained', reason: 'failed' }
  let clip: DetectionClip
  try {
    clip = await opts.sample(DETECTION_SAMPLE_COUNT, DETECTION_SAMPLE_SECONDS, opts.signal)
  } catch {
    return { kind: 'abstained', reason: 'failed' }
  }
  if (!clip.ok || opts.signal.aborted) return { kind: 'abstained', reason: 'failed' }
  try {
    const reply = await opts.provider.generate(detectionRequest(opts.model, clip, opts.config), {
      apiKey: opts.apiKey,
      keyIndex: opts.keyIndex,
      signal: opts.signal,
      responseLimitBytes: responseLimitBytes({ outputTokenLimit: null }),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})
    })
    if (!reply.result.ok) return { kind: 'abstained', reason: 'failed' }
    return readDetectorAnswer(reply.result.text)
  } catch {
    return { kind: 'abstained', reason: 'failed' }
  }
}
