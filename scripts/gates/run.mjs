/**
 * Bundle and run the gate suite.
 *
 * The gates import real main-process modules, which pull in `electron` and
 * `electron-store`. Rather than reimplementing those modules under test — which would let
 * a gate pass against logic the app does not actually use — the two runtime dependencies
 * are aliased to small stubs and everything else is the shipped code.
 *
 * esbuild is already present as a Vite dependency, so this adds no new package.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-gate-build-'))
const outfile = path.join(outDir, 'gates.mjs')

await build({
  entryPoints: [path.join(here, 'gates.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  logLevel: 'warning',
  // Bundled CommonJS dependencies (google-auth-library, under @google/genai) require Node built-ins
  // at run time; an ESM bundle has no `require` of its own.
  banner: { js: "import { createRequire as __gateCreateRequire } from 'module'; const require = __gateCreateRequire(import.meta.url);" },
  alias: {
    electron: path.join(here, 'stubs', 'electron.ts'),
    'electron-store': path.join(here, 'stubs', 'electron-store.ts')
  }
})

await import(pathToFileURL(outfile).href)
