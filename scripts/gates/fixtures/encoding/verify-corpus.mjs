/**
 * D14.1 real-corpus receipt (implementation_plan.md §14.2; feature_decisions.md §17.5 items 2–3, 5–6).
 *
 * Runs the shipped `electron/engine/subtitleInput.ts` against the private corpus that `acquire.mjs`
 * fetched into `.secrets/encoding-corpus/` and compares it with expectations that did NOT come from the
 * decoder under test:
 *  - encoding and language: OpenSubtitles.org's own labels (`siteEncoding`, `siteLanguageIso639`);
 *  - expected Unicode: OpenSubtitles.com's UTF-8 conversion of the same subtitle.
 *
 * Two measured differences between the two site copies are accounted for, never silently:
 *  - .org injects advertising cues into downloads that the .com copy lacks; they are matched by the
 *    site's own ad text and counted;
 *  - .com converts with the ISO-8859 sibling of the Windows code page, which drops or replaces the
 *    characters Windows assigns to 0x80–0x9F (`œ`, `’`, `…`) and, for Greek, 0xA1/0xA2 (`΅`, `Ά`). Lines
 *    differing only in those characters are counted as `isoOnly`; any other difference fails.
 *
 * The bytes are private (tester decision 2026-10-06); this script prints no subtitle text unless a file
 * fails, and then only the first differing line.
 *
 * Usage: node scripts/gates/fixtures/encoding/verify-corpus.mjs   (exit 1 on any failure)
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')
const corpus = path.join(repo, '.secrets', 'encoding-corpus')
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'))
if (!fs.existsSync(corpus)) {
  console.log(`private corpus not present at ${corpus} — run acquire.mjs first`)
  process.exit(2)
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-enc-verify-'))
const outfile = path.join(outDir, 'subtitleInput.mjs')
await build({
  entryPoints: [path.join(repo, 'electron', 'engine', 'subtitleInput.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  logLevel: 'warning'
})
const si = await import(pathToFileURL(outfile).href)

let iconv = null
try {
  iconv = createRequire(path.join(repo, 'package.json'))('iconv-lite')
} catch {
  /* comparison candidate only; absence is reported */
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const AD = /osdb\.link|opensubtitles\.(org|com)|getray\.app|tryray\.app|url%/i
/** A hint naming a language of another code page: it must not pull the decode away from the real one. */
const WRONG_HINT = { 'windows-1255': 'ar', 'windows-1256': 'he', 'windows-1251': 'pl', 'windows-1250': 'ru', 'windows-1252': 'tr', 'windows-1253': 'ru', 'windows-1254': 'de' }

function blocks(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean)
}
/** Dialogue lines in order, ad blocks dropped, cue numbers dropped (the .com copy renumbers after ads). */
function dialogue(text) {
  let ads = 0
  const lines = []
  /** Lines after a malformed in-block timing line: the .com conversion may drop them. */
  const afterMalformed = new Set()
  for (const b of blocks(text)) {
    if (AD.test(b)) {
      ads++
      continue
    }
    let broken = false
    for (const l of b.split('\n')) {
      if (/^\d+$/.test(l.trim())) continue
      const line = l.replace(/\s+$/, '')
      if (broken) afterMalformed.add(line)
      if (!line.includes('-->') && TIMING_LIKE.test(line)) broken = true
      lines.push(line)
    }
  }
  return { lines, ads, afterMalformed }
}
function isoDivergent(cp) {
  const set = new Set()
  const bytes = []
  for (let b = 0x80; b <= 0x9f; b++) bytes.push(b)
  if (cp === 'windows-1253') bytes.push(0xa1, 0xa2)
  const win = new TextDecoder(cp).decode(Buffer.from(bytes))
  for (const ch of win) set.add(ch)
  for (let c = 0x80; c <= 0x9f; c++) set.add(String.fromCharCode(c))
  for (const ch of '\u2018\u2019\u00b4\u0385') set.add(ch)
  return set
}
const TIMING_LIKE = /\d{1,2}:\d{2}[:;]\d{2}[,.]\d/

const rows = []
let failures = 0
const perCp = {}
for (const f of manifest.files) {
  const cp = 'windows-' + f.siteEncoding.slice(2)
  const origPath = path.join(corpus, `${f.id}.orig.srt`)
  const refPath = path.join(corpus, `${f.id}.com-utf8.srt`)
  const orig = fs.readFileSync(origPath)
  const ref = fs.readFileSync(refPath)
  const errs = []
  if (sha(orig) !== f.origSha256) errs.push('orig sha256 ≠ manifest')
  if (sha(ref) !== f.refSha256) errs.push('ref sha256 ≠ manifest')

  const r = si.inspectSubtitleBytes(orig, { path: origPath })
  if (!r.ok) errs.push(`refused: ${r.code}`)
  const ins = r.ok ? r.inspection : null
  const expectLang = f.siteLanguageIso639 === 'pb' ? 'pt' : f.siteLanguageIso639
  if (ins && ins.receipt.encoding !== cp) errs.push(`encoding ${ins.receipt.encoding} ≠ ${cp}`)
  if (ins && ins.language !== expectLang) errs.push(`language ${ins.language} ≠ ${expectLang}`)

  const wrong = si.inspectSubtitleBytes(orig, { path: origPath, hint: WRONG_HINT[cp] })
  if (!wrong.ok || wrong.inspection.receipt.encoding !== cp || wrong.inspection.language !== (ins?.language ?? '')) {
    errs.push(`wrong hint ${WRONG_HINT[cp]} changed the result`)
  }

  let exact = 0
  let isoOnly = 0
  let malformedTiming = 0
  let adsOrig = 0
  let adsRef = 0
  let iconvAgrees = null
  if (ins) {
    const decoded = si.decodeSubtitleBuffer(orig, ins.receipt.encoding)
    if (iconv) iconvAgrees = iconv.decode(orig, cp) === decoded
    const d = dialogue(decoded)
    const e = dialogue(ref.toString('utf8'))
    adsOrig = d.ads
    adsRef = e.ads
    const div = isoDivergent(cp)
    const strip = (s) => [...s].filter((c) => !div.has(c)).join('').replace(/\s+/g, ' ').trim()
    // Timing lines are compared nowhere: .com re-times blocks whose .org timing is malformed. Dialogue
    // is compared as a multiset so a re-split malformed block cannot shift every later line.
    const speech = (ls) => ls.filter((l) => l.trim() && !l.includes('-->'))
    const dl = speech(d.lines)
    const el = speech(e.lines)
    const refExact = new Map()
    const refIso = new Map()
    const bump = (m, k, n) => m.set(k, (m.get(k) ?? 0) + n)
    for (const l of el) {
      bump(refExact, l, 1)
      bump(refIso, strip(l), 1)
    }
    const unmatched = []
    for (const l of dl) {
      if ((refExact.get(l) ?? 0) > 0) {
        bump(refExact, l, -1)
        bump(refIso, strip(l), -1)
        exact++
      } else unmatched.push(l)
    }
    for (const l of unmatched) {
      const k = strip(l)
      if ((refIso.get(k) ?? 0) > 0) {
        bump(refIso, k, -1)
        isoOnly++
      } else if (TIMING_LIKE.test(l) || d.afterMalformed.has(l)) malformedTiming++
      else {
        errs.push(`decoded line not in reference: ${JSON.stringify(l).slice(0, 80)}`)
        break
      }
    }
    const leftover = [...refIso.entries()].filter(([, n]) => n > 0)
    if (leftover.length) errs.push(`reference line not decoded: ${JSON.stringify(leftover[0][0]).slice(0, 80)}`)
  }
  if (sha(fs.readFileSync(origPath)) !== f.origSha256) errs.push('original modified')

  const ok = errs.length === 0
  if (!ok) failures++
  perCp[cp] = perCp[cp] ?? { files: 0, pass: 0 }
  perCp[cp].files++
  if (ok) perCp[cp].pass++
  rows.push({
    id: f.id,
    lang: expectLang,
    detected: ins ? `${ins.receipt.encoding}/${ins.language}` : '-',
    encCertain: ins?.encodingCertain ?? false,
    langCertain: ins?.languageCertain ?? false,
    exact,
    isoOnly,
    adsOrig,
    adsRef,
    malformedTiming,
    iconvAgrees,
    result: ok ? 'PASS' : 'FAIL: ' + errs.join('; ')
  })
}

for (const r of rows) {
  console.log(
    `${r.result.startsWith('PASS') ? 'PASS' : 'FAIL'} ${r.id.padEnd(22)} ${r.lang.padEnd(3)} detected=${r.detected.padEnd(16)} ` +
      `encCertain=${r.encCertain} langCertain=${r.langCertain} exact=${r.exact} isoOnly=${r.isoOnly} malformedTiming=${r.malformedTiming} ads=${r.adsOrig}/${r.adsRef} iconv=${r.iconvAgrees}` +
      (r.result.startsWith('PASS') ? '' : `\n     ${r.result}`)
  )
}
console.log('per code page:', JSON.stringify(perCp))
console.log(`iconv-lite present: ${iconv !== null}`)
console.log(`${rows.length - failures}/${rows.length} files PASS`)
fs.rmSync(outDir, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
