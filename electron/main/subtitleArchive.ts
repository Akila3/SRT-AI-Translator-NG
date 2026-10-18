/**
 * Downloaded subtitle bodies and archives, read inside a fixed envelope (implementation_plan.md §10.5, §14.8).
 * AUTHORED-BY: opus-5.5-high
 *
 * The one owner of bounded extraction for OpenSubtitles and Wizdom; neither provider unpacks anything itself.
 * Nothing here writes to disk: an entry's name is metadata, never a path, so no name can place a file anywhere.
 * A name that would escape a folder, an absolute or drive or UNC or device name, a link, an encrypted entry, a
 * nested archive, an unknown compression method or a size past the envelope refuses the whole archive.
 *
 * The envelope is frozen for this release (§14.8): 8 MiB body, 128 entries, 1 MiB candidate member, 16 MiB
 * uncompressed total, no nesting. Declared sizes refuse early and are never trusted: the observed output of every
 * inflate is capped by the same numbers. Content is not judged by extension; the caller parses a candidate as SRT.
 */
import zlib from 'zlib'
import { parseCues, type Cue } from '../engine/srt'
import { decodeSubtitleBuffer, inspectSubtitleBytes } from '../engine/subtitleInput'
import type { SubtitleEncoding } from '../shared/types'

const MiB = 1024 * 1024

export const SUBTITLE_ENVELOPE = Object.freeze({ bodyBytes: 8 * MiB, entries: 128, memberBytes: MiB, totalBytes: 16 * MiB })

/** Why a body or archive was refused. Closed; no body bytes or names travel with it. */
export type ArchiveRefusal =
  | 'body'
  | 'entries'
  | 'member'
  | 'total'
  | 'nested'
  | 'encrypted'
  | 'link'
  | 'path'
  | 'method'
  | 'format'
  | 'unsupported'
  | 'html'
  | 'json'
  | 'noSubtitle'

export interface ArchiveMember {
  /** 1-based position among the archive's candidate subtitles. */
  readonly ordinal: number
  /** A generated name, never derived from the entry name. */
  readonly safeName: string
  /** The entry's own name, for display only. Never a path. */
  readonly originalName: string
  readonly bytes: Buffer
}

export type ArchiveRead =
  | { readonly ok: true; readonly members: readonly ArchiveMember[]; readonly entries: number }
  | { readonly ok: false; readonly reason: ArchiveRefusal; readonly observedBytes: number; readonly limit: number | null }

const refuse = (reason: ArchiveRefusal, observedBytes = 0, limit: number | null = null): ArchiveRead => ({ ok: false, reason, observedBytes, limit })

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i
const ARCHIVE_NAME = /\.(?:zip|zipx|rar|7z|gz|tgz|tar|bz2|xz|cab|lzh|arj)$/i
const ARCHIVE_MAGIC: readonly Buffer[] = [
  Buffer.from('PK\x03\x04', 'latin1'),
  Buffer.from('PK\x05\x06', 'latin1'),
  Buffer.from('Rar!', 'latin1'),
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  Buffer.from([0x1f, 0x8b]),
  Buffer.from('BZh', 'latin1'),
  Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
]

function startsWithAny(buf: Buffer, magics: readonly Buffer[]): boolean {
  return magics.some((m) => buf.length >= m.length && buf.subarray(0, m.length).equals(m))
}

/**
 * True when an entry name, read with either separator, could name anything outside the folder it is unpacked
 * into, or a Windows device (§10.5): `..` segments, a leading `/` or `\`, a drive letter (`C:` or `C:\`), a UNC
 * or `\\?\` prefix, a reserved device name as any segment, or a control character. Any other colon is allowed:
 * real Wizdom archives name entries like `:.The.Matrix.1999….srt`, and no name is ever used as a path.
 */
export function hostileEntryName(name: string): boolean {
  if (!name || /[\u0000-\u001f]/.test(name)) return true
  const n = name.replace(/\\/g, '/')
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return true
  for (const seg of n.split('/')) {
    if (seg === '..') return true
    const base = seg.split('.')[0].replace(/[ .]+$/, '')
    if (RESERVED_DEVICE.test(base)) return true
  }
  return false
}

/** A candidate subtitle member: a file entry named `.srt` (the caller still has to parse it as SRT). */
function isCandidate(name: string): boolean {
  return /\.srt$/i.test(name)
}

interface CentralEntry {
  name: string
  flags: number
  method: number
  crc: number
  compressed: number
  size: number
  localOffset: number
  madeBySystem: number
  externalAttr: number
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) return i
  return -1
}

/**
 * The candidate subtitles inside a ZIP body. Refuses the whole archive on the first problem; never partial.
 */
export function readSubtitleArchive(body: Buffer): ArchiveRead {
  const L = SUBTITLE_ENVELOPE
  if (body.length > L.bodyBytes) return refuse('body', body.length, L.bodyBytes)
  try {
    const eocd = findEndOfCentralDirectory(body)
    if (eocd < 0) return refuse('format')
    const disk = body.readUInt16LE(eocd + 4)
    const cdDisk = body.readUInt16LE(eocd + 6)
    const onDisk = body.readUInt16LE(eocd + 8)
    const total = body.readUInt16LE(eocd + 10)
    const cdSize = body.readUInt32LE(eocd + 12)
    const cdOffset = body.readUInt32LE(eocd + 16)
    if (eocd >= 20 && body.readUInt32LE(eocd - 20) === 0x07064b50) return refuse('format')
    if (disk !== 0 || cdDisk !== 0 || onDisk !== total || total === 0xffff || cdOffset === 0xffffffff) return refuse('format')
    if (total > L.entries) return refuse('entries', total, L.entries)
    if (cdOffset + cdSize > eocd) return refuse('format')

    const entries: CentralEntry[] = []
    let p = cdOffset
    let declaredTotal = 0
    while (p < cdOffset + cdSize) {
      if (entries.length >= L.entries) return refuse('entries', entries.length + 1, L.entries)
      if (p + 46 > body.length || body.readUInt32LE(p) !== 0x02014b50) return refuse('format')
      const madeBy = body.readUInt16LE(p + 4)
      const flags = body.readUInt16LE(p + 8)
      const method = body.readUInt16LE(p + 10)
      const crc = body.readUInt32LE(p + 16)
      const compressed = body.readUInt32LE(p + 20)
      const size = body.readUInt32LE(p + 24)
      const nameLen = body.readUInt16LE(p + 28)
      const extraLen = body.readUInt16LE(p + 30)
      const commentLen = body.readUInt16LE(p + 32)
      const externalAttr = body.readUInt32LE(p + 38)
      const localOffset = body.readUInt32LE(p + 42)
      if (p + 46 + nameLen > body.length) return refuse('format')
      if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) return refuse('format')
      const rawName = body.subarray(p + 46, p + 46 + nameLen)
      const name = flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1')
      entries.push({ name, flags, method, crc, compressed, size, localOffset, madeBySystem: madeBy >>> 8, externalAttr })
      declaredTotal += size
      p += 46 + nameLen + extraLen + commentLen
    }
    if (entries.length !== total) return refuse('format')

    for (const e of entries) {
      if (hostileEntryName(e.name)) return refuse('path')
      if (e.flags & 0x1 || e.flags & 0x40) return refuse('encrypted')
      const mode = e.externalAttr >>> 16
      if (e.madeBySystem === 3 && (mode & 0o170000) === 0o120000) return refuse('link')
      if ((e.externalAttr & 0x400) !== 0) return refuse('link')
      if (ARCHIVE_NAME.test(e.name)) return refuse('nested')
      if (!e.name.endsWith('/') && isCandidate(e.name) && e.size > L.memberBytes) return refuse('member', e.size, L.memberBytes)
    }
    if (declaredTotal > L.totalBytes) return refuse('total', declaredTotal, L.totalBytes)

    const members: ArchiveMember[] = []
    let observedTotal = 0
    for (const e of entries) {
      if (e.name.endsWith('/') || !isCandidate(e.name)) continue
      if (e.method !== 0 && e.method !== 8) return refuse('method')
      const lp = e.localOffset
      if (lp + 30 > body.length || body.readUInt32LE(lp) !== 0x04034b50) return refuse('format')
      const start = lp + 30 + body.readUInt16LE(lp + 26) + body.readUInt16LE(lp + 28)
      if (start + e.compressed > cdOffset) return refuse('format')
      const raw = body.subarray(start, start + e.compressed)
      const room = L.totalBytes - observedTotal
      const cap = Math.min(L.memberBytes, room)
      let data: Buffer
      if (e.method === 0) {
        data = raw
        if (data.length > cap) return refuse(cap === L.memberBytes ? 'member' : 'total', observedTotal + data.length, cap === L.memberBytes ? L.memberBytes : L.totalBytes)
      } else {
        try {
          data = zlib.inflateRawSync(raw, { maxOutputLength: cap + 1 })
        } catch (err) {
          const tooBig = (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError
          if (!tooBig) return refuse('format')
          return refuse(cap === L.memberBytes ? 'member' : 'total', observedTotal + cap + 1, cap === L.memberBytes ? L.memberBytes : L.totalBytes)
        }
        if (data.length > cap) {
          return refuse(cap === L.memberBytes ? 'member' : 'total', observedTotal + data.length, cap === L.memberBytes ? L.memberBytes : L.totalBytes)
        }
      }
      if (data.length !== e.size || crc32(data) !== e.crc) return refuse('format')
      observedTotal += data.length
      if (startsWithAny(data, ARCHIVE_MAGIC)) return refuse('nested')
      members.push({ ordinal: members.length + 1, safeName: `member-${members.length + 1}.srt`, originalName: e.name, bytes: Buffer.from(data) })
    }
    if (!members.length) return refuse('noSubtitle')
    return { ok: true, members, entries: entries.length }
  } catch {
    return refuse('format')
  }
}

/**
 * A downloaded subtitle body: a ZIP is read as an archive; plain text is one member under the member cap; any
 * other archive or compressed format (gzip, RAR, 7z, bzip2, xz) is refused — nothing nested is ever opened.
 * An HTML page (a challenge or an error) or a JSON body is classified before any parse, so a `200` carrying
 * one is never a subtitle.
 */
export function readSubtitleBody(body: Buffer, displayName = 'subtitle.srt'): ArchiveRead {
  const L = SUBTITLE_ENVELOPE
  if (body.length > L.bodyBytes) return refuse('body', body.length, L.bodyBytes)
  if (body.length >= 4 && (body.readUInt32LE(0) === 0x04034b50 || body.readUInt32LE(0) === 0x06054b50)) return readSubtitleArchive(body)
  if (startsWithAny(body, ARCHIVE_MAGIC)) return refuse('unsupported')
  const head = body.subarray(0, 512).toString('latin1').replace(/^(?:\xef\xbb\xbf|\s)+/, '')
  if (/^<(?:!doctype\s+html|html|head|body|\?xml)/i.test(head)) return refuse('html')
  if (/^[{[]/.test(head)) return refuse('json')
  if (body.length > L.memberBytes) return refuse('member', body.length, L.memberBytes)
  if (body.length === 0) return refuse('noSubtitle')
  return { ok: true, entries: 1, members: [{ ordinal: 1, safeName: 'member-1.srt', originalName: displayName, bytes: Buffer.from(body) }] }
}

export type CandidateRead =
  | {
      readonly ok: true
      readonly text: string
      readonly cues: readonly Cue[]
      readonly encoding: SubtitleEncoding
      readonly sha256: string
      /** What detection read, with the advertised language as its hint; '' when nothing scored. */
      readonly detected: string
      /** Detection was certain and the hint did not decide it (the hint was weighed and lost, or never close). */
      readonly detectedOverHint: boolean
    }
  | { readonly ok: false; readonly reason: 'content' }

/**
 * A candidate member judged by its content, never its name: decoded the way a picked file is (BOM, strict
 * UTF-8, then the language's legacy code pages) and parsed as SRT. No cues, or bytes that will not decode, is
 * `content`.
 */
export function readCandidate(member: ArchiveMember, language?: string): CandidateRead {
  const seen = inspectSubtitleBytes(member.bytes, { path: member.safeName, ...(language ? { hint: language } : {}) })
  if (!seen.ok) return { ok: false, reason: 'content' }
  const encoding = seen.inspection.receipt.encoding
  const text = decodeSubtitleBuffer(member.bytes, encoding)
  const parsed = parseCues(text)
  if (!parsed.ok || parsed.cues.length === 0) return { ok: false, reason: 'content' }
  const { language: detected, languageCertain, hintUsed } = seen.inspection
  return { ok: true, text, cues: parsed.cues, encoding, sha256: seen.inspection.receipt.sha256, detected, detectedOverHint: languageCertain && !hintUsed && detected !== '' }
}

const baseLanguage = (v: string): string => {
  const b = v.trim().toLowerCase().split(/[-_]/)[0]
  return b === 'iw' ? 'he' : b
}

/**
 * feature_decisions.md §3.3's guard against a mislabelled upload: the language a downloaded file is used as.
 * The advertised language stands unless detection is certain of a different one over it (regional variants are
 * one language); then the detected language, flagged `mislabelled`. Uncertain detection never overrides.
 */
export function candidateLanguage(read: Extract<CandidateRead, { ok: true }>, advertised: string | null): { language: string | null; mislabelled: boolean } {
  const listed = advertised ? baseLanguage(advertised) : null
  if (!read.detectedOverHint) return { language: listed, mislabelled: false }
  const seen = baseLanguage(read.detected)
  return listed !== null && seen !== listed ? { language: seen, mislabelled: true } : { language: listed ?? seen, mislabelled: false }
}

/** A body read under a byte cap: refused early by a declared length past it, and by the observed count always. */
export type BoundedBody = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly reason: 'body'; readonly observedBytes: number; readonly limit: number }

/**
 * Read a response body, counting bytes as they arrive. A `content-length` past `limit` refuses before reading;
 * a body that grows past it while streaming is cancelled at the first byte over. Throws only what the stream
 * throws (an abort included), so a caller's Stop ends the read.
 */
export async function readBoundedBody(
  response: { headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null },
  limit: number = SUBTITLE_ENVELOPE.bodyBytes
): Promise<BoundedBody> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, reason: 'body', observedBytes: declared, limit }
  }
  if (!response.body) return { ok: true, bytes: Buffer.alloc(0) }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let seen = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    seen += value.byteLength
    if (seen > limit) {
      await reader.cancel().catch(() => undefined)
      return { ok: false, reason: 'body', observedBytes: seen, limit }
    }
    chunks.push(Buffer.from(value))
  }
  return { ok: true, bytes: Buffer.concat(chunks, seen) }
}
