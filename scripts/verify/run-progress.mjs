/**
 * Bundle and run the REP-11 ffmpeg-progress probe.
 *
 * Same mechanism as `run.mjs` and `run-buffering.mjs`: the probe imports the real
 * main-process ffmpeg module with only `electron` and `electron-store` aliased to the gate
 * stubs, so the argv and tool resolution under test are the shipped ones.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubs = path.join(here, '..', 'gates', 'stubs')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-progress-build-'))
const outfile = path.join(outDir, 'progress.mjs')

await build({
  entryPoints: [path.join(here, 'progress.ts')],
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
