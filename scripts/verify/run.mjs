/**
 * Bundle and run the live verification probes.
 *
 * Same approach as `scripts/gates/run.mjs`: the probes import the real main-process
 * modules so the argv they send to the engine is the argv the app sends, with only
 * `electron` and `electron-store` aliased to the gate stubs. A probe that built its own
 * command line would prove nothing about the shipped app.
 *
 * Unlike the gates, this spends real API quota — see `live.ts` for the cost note.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubs = path.join(here, '..', 'gates', 'stubs')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-verify-build-'))
const outfile = path.join(outDir, 'live.mjs')

await build({
  entryPoints: [path.join(here, 'live.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  logLevel: 'warning',
  // Bundled CommonJS dependencies (google-auth-library, under @google/genai) require Node built-ins
  // at run time; an ESM bundle has no `require` of its own.
  banner: { js: "import { createRequire as __probeCreateRequire } from 'module'; const require = __probeCreateRequire(import.meta.url);" },
  alias: {
    electron: path.join(stubs, 'electron.ts'),
    'electron-store': path.join(stubs, 'electron-store.ts')
  }
})

await import(pathToFileURL(outfile).href)
