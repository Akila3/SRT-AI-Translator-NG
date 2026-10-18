import fs from 'fs'
import type { SubtitleEncoding, SubtitleReceipt, SubtitleRefusalCode, TranslateArgs } from '../shared/types'
import { LEGACY_ENCODINGS, decodeSubtitleBuffer, inspectSubtitleBytes, readVerifiedSubtitle } from '../engine/subtitleInput'

export type TranslateSourceRefusal = SubtitleRefusalCode | 'unconfirmed' | 'receipt-invalid' | 'sibling-write-failed'

export type TranslateSource =
  | { ok: true; buffer: Buffer; text: string; receipt: SubtitleReceipt }
  | { ok: false; code: TranslateSourceRefusal; error: string }

const RECEIPT_ENCODINGS: readonly SubtitleEncoding[] = ['utf-8', 'utf-8-bom', 'utf-16le-bom', 'utf-16be-bom', ...LEGACY_ENCODINGS]

/** The receipt crosses IPC from the renderer, so its shape is checked rather than trusted. */
function isSubtitleReceipt(r: unknown): r is SubtitleReceipt {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return (
    typeof o.path === 'string' &&
    o.path.length > 0 &&
    Number.isSafeInteger(o.byteLength) &&
    (o.byteLength as number) >= 0 &&
    typeof o.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(o.sha256) &&
    RECEIPT_ENCODINGS.includes(o.encoding as SubtitleEncoding)
  )
}

/**
 * Start's one read of the Translate source (implementation_plan.md §14.2 D14.1,
 * feature_decisions.md §17.5 item 8). Nothing after this reads the user's file again: the engine
 * parses `text` directly.
 *
 * With the page's receipt: read once, re-hash, refuse a path or digest mismatch, decode as inspected.
 * Without one: inspect these same bytes, and refuse whatever the page would have had to confirm, so a
 * caller cannot skip the confirmation by leaving the receipt out.
 */
export function readTranslateSource(a: Pick<TranslateArgs, 'inputFile' | 'sourceLang' | 'sourceReceipt'>): TranslateSource {
  if (a.sourceReceipt !== undefined) {
    if (!isSubtitleReceipt(a.sourceReceipt)) {
      return {
        ok: false,
        code: 'receipt-invalid',
        error: 'The subtitle file could not be matched to the one that was loaded. Load it again and retry. Nothing was sent.'
      }
    }
    return readVerifiedSubtitle(a.inputFile, a.sourceReceipt)
  }
  let canonical: string
  let buffer: Buffer
  try {
    canonical = fs.realpathSync(a.inputFile)
    buffer = fs.readFileSync(canonical)
  } catch (e) {
    return { ok: false, code: 'read-failed', error: `The subtitle file could not be read: ${(e as Error).message}` }
  }
  const hint = a.sourceLang && a.sourceLang !== 'auto' ? a.sourceLang : undefined
  const r = inspectSubtitleBytes(buffer, { path: canonical, ...(hint ? { hint } : {}) })
  if (!r.ok) return r
  if (!r.inspection.encodingCertain) {
    return {
      ok: false,
      code: 'unconfirmed',
      error:
        "This subtitle file is not UTF-8 and its encoding could not be decided with confidence. Load it on the " +
        "Translate page and confirm the file's language. The file was left untouched."
    }
  }
  return { ok: true, buffer, text: decodeSubtitleBuffer(buffer, r.inspection.receipt.encoding), receipt: r.inspection.receipt }
}
