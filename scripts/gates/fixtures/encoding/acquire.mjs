/**
 * Acquire the private D14.1 legacy-encoding corpus (implementation_plan.md §14.2 D14.1, feature_decisions.md §17.5).
 *
 * Provenance is established outside the decoder under test, from two independent sources per file:
 *  - OpenSubtitles.org serves the file as uploaded and labels its encoding (`SubEncoding`) and language;
 *  - OpenSubtitles.com serves the SAME subtitle (matched on `legacy_subtitle_id` = .org `IDSubtitle`)
 *    already converted to UTF-8 by the site — the expected Unicode text.
 *
 * Subtitle bytes are written only under `.secrets/encoding-corpus/` (git-ignored, tester decision 2026-10-06:
 * no subtitle text in git). `manifest.json` beside this script holds hashes, sizes, ids and labels only.
 *
 * Usage: node --use-system-ca scripts/gates/fixtures/encoding/acquire.mjs
 * Credentials are read from `.secrets/gemini-key.txt` (labelled lines) and are never printed.
 * Each .com download spends one of the account's daily downloads; the script stops at `COM_BUDGET`.
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')
const secretDir = path.join(repo, '.secrets', 'encoding-corpus')
const manifestPath = path.join(here, 'manifest.json')
const COM_BUDGET = 45

const FILMS = [
  '0381681', '0111161', '0068646', '0109830', '0137523', '0120338', '0133093', '0110912', '0167260',
  '0120815', '0114369', '0102926', '0118799', '0172495', '0209144', '0120689', '0112573', '0099685',
  '0107290', '0088763', '0103064', '0080684', '0076759', '0071562', '0060196', '0108052', '0073486',
  '0047478', '0317248', '0245429', '0253474', '0338013', '0361748', '0482571', '0407887', '0434409'
]

/** Codepage → the languages to draw from (.org id, .com code). Order spreads one codepage over its languages. */
const TARGETS = [
  { cp: 'CP1255', count: 5, langs: [['heb', 'he']] },
  { cp: 'CP1256', count: 5, langs: [['ara', 'ar'], ['ara', 'ar'], ['per', 'fa'], ['ara', 'ar'], ['ara', 'ar']] },
  { cp: 'CP1251', count: 5, langs: [['rus', 'ru'], ['bul', 'bg'], ['ukr', 'uk'], ['rus', 'ru'], ['scc', 'sr'], ['mac', 'mk'], ['bul', 'bg']] },
  { cp: 'CP1250', count: 5, langs: [['pol', 'pl'], ['cze', 'cs'], ['hun', 'hu'], ['hrv', 'hr'], ['rum', 'ro'], ['slv', 'sl'], ['slo', 'sk'], ['pol', 'pl']] },
  { cp: 'CP1252', count: 5, langs: [['fre', 'fr'], ['spa', 'es'], ['ger', 'de'], ['ita', 'it'], ['por', 'pt-PT'], ['dut', 'nl'], ['swe', 'sv']] },
  { cp: 'CP1253', count: 5, langs: [['ell', 'el']] },
  { cp: 'CP1254', count: 5, langs: [['tur', 'tr']] }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function credentials() {
  const lines = fs.readFileSync(path.join(repo, '.secrets', 'gemini-key.txt'), 'utf8').split(/\r?\n/)
  const val = (re) => {
    const l = lines.find((x) => re.test(x))
    return l ? l.split(/[:=]/).slice(1).join(':').trim() : ''
  }
  return { apiKey: val(/^\s*API KEY\s*[:=]/i), user: val(/^\s*User\s*[:=]/i), pwd: val(/^\s*PWD\s*[:=]/i) }
}

const ORG = 'https://rest.opensubtitles.org/search'
const COM = 'https://api.opensubtitles.com/api/v1'
const UA = 'GST NG v0.1'

async function orgSearch(imdb, lang) {
  const res = await fetch(`${ORG}/imdbid-${imdb}/sublanguageid-${lang}`, { headers: { 'X-User-Agent': 'TemporaryUserAgent' } })
  if (!res.ok) return []
  const j = await res.json().catch(() => [])
  return Array.isArray(j) ? j : []
}

async function main() {
  fs.mkdirSync(secretDir, { recursive: true })
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: [] }
  const have = new Set(manifest.files.map((f) => f.orgIdSubtitle))
  const { apiKey, user, pwd } = credentials()
  const h = { 'Api-Key': apiKey, 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }
  const login = await fetch(`${COM}/login`, { method: 'POST', headers: h, body: JSON.stringify({ username: user, password: pwd }) })
  const lj = await login.json()
  if (!lj.token) throw new Error(`.com login failed: HTTP ${login.status}`)
  const auth = { ...h, Authorization: `Bearer ${lj.token}` }
  let comSpent = 0

  for (const t of TARGETS) {
    let got = manifest.files.filter((f) => f.siteEncoding === t.cp).length
    const usedFilms = new Set(manifest.files.filter((f) => f.siteEncoding === t.cp).map((f) => f.imdb))
    let li = got
    for (const imdb of FILMS) {
      if (got >= t.count || comSpent >= COM_BUDGET) break
      if (usedFilms.has(imdb)) continue
      const [orgLang, comLang] = t.langs[li % t.langs.length]
      await sleep(1200)
      const hits = (await orgSearch(imdb, orgLang)).filter(
        (s) => s.SubEncoding === t.cp && s.SubFormat === 'srt' && s.SubSumCD === '1' && !have.has(s.IDSubtitle)
      )
      if (hits.length === 0) continue
      await sleep(1200)
      const cs = await fetch(`${COM}/subtitles?imdb_id=${Number(imdb)}&languages=${comLang}`, { headers: auth })
      const cj = await cs.json().catch(() => ({ data: [] }))
      const byLegacy = new Map((cj.data || []).map((d) => [String(d.attributes.legacy_subtitle_id), d]))
      const pick = hits.find((s) => byLegacy.get(String(s.IDSubtitle))?.attributes.files?.length === 1)
      if (!pick) continue
      const com = byLegacy.get(String(pick.IDSubtitle))

      const gz = Buffer.from(await (await fetch(pick.SubDownloadLink, { headers: { 'X-User-Agent': 'TemporaryUserAgent' } })).arrayBuffer())
      const orig = zlib.gunzipSync(gz)
      let utf8Valid = true
      try { new TextDecoder('utf-8', { fatal: true }).decode(orig) } catch { utf8Valid = false }
      if (utf8Valid) continue

      await sleep(1200)
      const d = await fetch(`${COM}/download`, { method: 'POST', headers: auth, body: JSON.stringify({ file_id: com.attributes.files[0].file_id }) })
      const dj = await d.json().catch(() => ({}))
      comSpent++
      if (!dj.link) { console.log(`com download refused: HTTP ${d.status}`); break }
      const ref = Buffer.from(await (await fetch(dj.link)).arrayBuffer())

      const id = `${t.cp.toLowerCase()}-${pick.IDSubtitle}`
      fs.writeFileSync(path.join(secretDir, `${id}.orig.srt`), orig)
      fs.writeFileSync(path.join(secretDir, `${id}.com-utf8.srt`), ref)
      manifest.files.push({
        id,
        siteEncoding: t.cp,
        siteLanguage: pick.SubLanguageID,
        siteLanguageIso639: pick.ISO639,
        imdb,
        orgIdSubtitle: pick.IDSubtitle,
        orgIdSubtitleFile: pick.IDSubtitleFile,
        comFileId: com.attributes.files[0].file_id,
        origBytes: orig.length,
        origSha256: sha256(orig),
        refBytes: ref.length,
        refSha256: sha256(ref),
        acquired: new Date().toISOString().slice(0, 10)
      })
      have.add(pick.IDSubtitle)
      usedFilms.add(imdb)
      got++
      li++
      console.log(`${id} ${pick.SubLanguageID} orig=${orig.length} ref=${ref.length} remaining=${dj.remaining}`)
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    }
    console.log(`${t.cp}: ${got}/${t.count}`)
  }
  console.log(`com downloads spent this run: ${comSpent}`)
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
