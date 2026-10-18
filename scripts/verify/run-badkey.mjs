/**
 * Bundle and run the REP-2 bad-key probe.
 *
 * Same mechanism as the other runners: the probe imports the real main-process modules with only
 * `electron` and `electron-store` aliased to the gate stubs, so the job lifecycle, the argv and
 * the engine resolution under test are the shipped ones.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubs = path.join(here, '..', 'gates', 'stubs')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-badkey-build-'))
const outfile = path.join(outDir, 'badkey.mjs')

await build({
  entryPoints: [path.join(here, 'badkey.ts')],
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
