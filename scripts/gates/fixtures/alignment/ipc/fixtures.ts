/**
 * Align IPC fixtures (implementation_plan.md §17.5 C.2). Files on disk for the main-process service:
 * the global timelines from `../global/fixtures.ts` written as SubRip in each source encoding, plus
 * hand-written malformed and image-subtitle files. Every line is author-written; no subtitle text
 * enters git (handoff.md §24).
 *
 * AUTHORED-BY: opus-5.5-high
 */
import fs from 'fs'
import path from 'path'
import { serializeCues, type Cue } from '../../../../../electron/engine/srt'
import { independentFixtures, type AlignmentFixture } from '../global/fixtures'

export function fixture(name: string): AlignmentFixture {
  const found = independentFixtures().find((f) => f.name === name)
  if (!found) throw new Error(`no alignment fixture named ${name}`)
  return found
}

/**
 * windows-1255 from the code page's fixed Hebrew block (U+05D0–U+05EA ↔ 0xE0–0xFA) and ASCII, so the
 * fixture's bytes do not come from the encoder under test.
 */
export function windows1255(text: string): Buffer {
  const out = Buffer.alloc(text.length)
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c < 0x80) out[i] = c
    else if (c >= 0x05d0 && c <= 0x05ea) out[i] = 0xe0 + (c - 0x05d0)
    else throw new Error(`windows1255 fixture: U+${c.toString(16)} is outside the fixture's table`)
  }
  return out
}

/** Author-written Hebrew dialogue, varied so language detection scores it clearly. */
const HEBREW = [
  'אני לא יודע מה קרה כאן',
  'מה אתה עושה פה עכשיו',
  'זה לא מה שחשבתי',
  'אתה בטוח שזה הדרך',
  'אנחנו צריכים ללכת מהר',
  'היא אמרה שהיא תבוא מחר',
  'אין לי מושג על מה אתה מדבר',
  'תן לי רגע לחשוב על זה'
]

export function inHebrew(cues: readonly Cue[]): Cue[] {
  return cues.map((c, i) => ({ ...c, text: `${HEBREW[i % HEBREW.length]} ${i + 1}` }))
}

export type FixtureEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le-bom' | 'windows-1255'

/** The bytes of `cues` as SubRip in `encoding` with `eol`. */
export function srtBytes(cues: readonly Cue[], encoding: FixtureEncoding, eol: string): Buffer {
  const text = serializeCues(cues, eol)
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(text, 'utf8')
    case 'utf-8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf-16le-bom':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'windows-1255':
      return windows1255(text)
  }
}

export function writeFile(dir: string, name: string, data: Buffer | string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, data)
  return p
}

/** A zero-duration cue at 3 and a backward start at 6, in otherwise ordinary SubRip (E68's two shapes). */
export function malformedSource(): string {
  const rows: string[] = []
  const times = [
    ['00:00:10,000', '00:00:12,000'],
    ['00:00:15,000', '00:00:17,000'],
    ['00:00:20,000', '00:00:20,000'],
    ['00:00:25,000', '00:00:27,000'],
    ['00:00:30,000', '00:00:32,000'],
    ['00:00:08,000', '00:00:09,000'],
    ['00:00:40,000', '00:00:42,000'],
    ['00:00:45,000', '00:00:47,000'],
    ['00:00:50,000', '00:00:52,000']
  ]
  times.forEach(([a, b], i) => rows.push(`${i + 1}\r\n${a} --> ${b}\r\nMalformed line ${i + 1} is spoken here.\r\n`))
  return rows.join('\r\n')
}

/** Text above the first cue: `parseCues` refuses it as a preface at line 1. */
export function prefacedSource(): string {
  return `Translated by nobody\r\n\r\n1\r\n00:00:01,000 --> 00:00:02,000\r\nPreface line one.\r\n`
}

/** A PGS stream's opening bytes: the magic, then a presentation-segment header. */
export function pgsBytes(): Buffer {
  return Buffer.from([0x50, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x13])
}
