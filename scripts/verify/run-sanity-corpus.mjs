/**
 * Bundle and run the FP-2 corpus calibration sweep.
 *
 * `outputSanity.ts` is pure and imports nothing from Electron, so unlike the other probes this one
 * needs no stubs — the alias map is kept only so the harness stays uniform if that ever changes.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubs = path.join(here, '..', 'gates', 'stubs')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-sanity-build-'))
const outfile = path.join(outDir, 'sanityCorpus.mjs')

await build({
  entryPoints: [path.join(here, 'sanityCorpus.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  logLevel: 'warning',
  alias: {
    electron: path.join(stubs, 'electron.ts'),
    'electron-store': path.join(stubs, 'electron-store.ts')
  }
})

await import(pathToFileURL(outfile).href)
