/**
 * Bundle and run the FP-8 console-log probe.
 *
 * Same mechanism as the other runners, with one addition: `child_process` is aliased to a
 * scripted engine as well, so the job lifecycle under test is the shipped one while the process
 * it drives is ours to command. `electron` and `electron-store` come from the gate stubs.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubs = path.join(here, '..', 'gates', 'stubs')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-consolelog-build-'))
const outfile = path.join(outDir, 'consolelog.mjs')

await build({
  entryPoints: [path.join(here, 'consolelog.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  logLevel: 'warning',
  // Since Step 1.9 the probe reaches the native adapter, and `@google/genai`'s CommonJS
  // dependencies `require` Node built-ins — which an ESM bundle cannot do without this.
  banner: { js: "import { createRequire as __probeCreateRequire } from 'module'; const require = __probeCreateRequire(import.meta.url);" },
  alias: {
    electron: path.join(stubs, 'electron.ts'),
    'electron-store': path.join(stubs, 'electron-store.ts'),
    child_process: path.join(here, 'stubs', 'engine_child_process.ts')
  }
})

await import(pathToFileURL(outfile).href)
