/**
 * Capture Kodi's own `align_one` answers for the alignment fixtures (the Kodi source
 * lives in git-ignored `Source Codes/`, so its output is captured into a tracked receipt that the
 * gates compare `electron/engine/align.ts` against).
 *
 *   node scripts/gates/fixtures/alignment/global/capture-kodi-oracle.mjs
 *
 * Needs Python 3 and `Source Codes/service.subtitles.kodipovilai/Older versions/0.2.528/`. Writes
 * `kodi-oracle-receipt.json` beside this file. Run it only when a fixture is added; a fixture whose
 * SubRip text changed no longer matches its receipt digest and the gate says so.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import { build } from 'esbuild'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../../..')
const kodiRel = 'Source Codes/service.subtitles.kodipovilai/Older versions/0.2.528/resources/lib/arabic_gender.py'
const kodiPath = path.join(root, ...kodiRel.split('/'))
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-capture-'))
const entry = path.join(outDir, 'entry.ts')
fs.writeFileSync(
  entry,
  `export * from ${JSON.stringify(path.join(here, 'fixtures.ts'))}\n` +
    `export { serializeCues } from ${JSON.stringify(path.join(root, 'electron', 'engine', 'srt.ts'))}\n`
)
const outfile = path.join(outDir, 'entry.mjs')
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'warning' })
const mod = await import(pathToFileURL(outfile).href)
const fixtures = [...mod.oracleFixtures(), ...(mod.independentFixtures ? mod.independentFixtures() : [])]
const items = fixtures.map((f) => ({
  name: f.name,
  source: mod.serializeCues(f.source, '\n'),
  reference: mod.serializeCues(f.reference, '\n')
}))

const PY = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('arabic_gender', sys.argv[1])
ag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ag)
items = json.loads(sys.stdin.read())
out = {'scales': ag._SCALES, 'python': sys.version.split()[0], 'fixtures': []}
for it in items:
    src, ref = it['source'], it['reference']
    blocks = src.strip().split('\n\n')
    mapping, diag = ag.align_one(src, blocks, ref)
    en = [c for c in ag._parse(src) if ag._is_dialogue(c['text'])]
    ar = [c for c in ag._parse(ref) if ag._is_dialogue(c['text'])]
    row = {'name': it['name'], 'en': len(en), 'ar': len(ar), 'diag': diag, 'hinted': bool(mapping)}
    if len(en) >= 8 and len(ar) >= 8:
        a, b, vote = ag._estimate_map(en, ar)
        row.update({'scale': a, 'offsetMs': b, 'vote': vote, 'overlap': ag._overlap_rate(en, ar, a, b)})
    pairs = sorted((mapping or {}).items())
    row['hintCount'] = len(pairs)
    row['hintsCanonical'] = json.dumps(pairs, ensure_ascii=False, separators=(',', ':'))
    out['fixtures'].append(row)
print(json.dumps(out))
`
const py = spawnSync('python', ['-c', PY, kodiPath], {
  input: JSON.stringify(items),
  encoding: 'utf8',
  maxBuffer: 1 << 28,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
})
if (py.status !== 0) {
  console.error(py.stderr)
  process.exit(1)
}
const kodi = JSON.parse(py.stdout)
const receipt = {
  capturedBy: 'scripts/gates/fixtures/alignment/global/capture-kodi-oracle.mjs',
  kodi: { version: '0.2.528', path: kodiRel, sha256: sha256(fs.readFileSync(kodiPath)), python: kodi.python },
  scales: kodi.scales,
  fixtures: kodi.fixtures.map((row, i) => {
    const { hintsCanonical, ...rest } = row
    return {
      ...rest,
      sourceSha256: sha256(items[i].source),
      referenceSha256: sha256(items[i].reference),
      hintsSha256: sha256(hintsCanonical)
    }
  })
}
fs.writeFileSync(path.join(here, 'kodi-oracle-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
fs.rmSync(outDir, { recursive: true, force: true })
console.log(`captured ${receipt.fixtures.length} fixtures against Kodi ${receipt.kodi.version} (${receipt.kodi.sha256.slice(0, 12)}…)`)
