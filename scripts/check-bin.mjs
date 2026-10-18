/**
 * Packaging preflight: refuse to build a release without the media binaries it must ship.
 *
 * `resources/bin/` is git-ignored, so a clean clone has none of them. Nothing downstream
 * notices: electron-builder happily produces a portable zip whose `extraResources` filter
 * matched zero files, and the packaged app then falls back to a bare `ffmpeg` on PATH, which
 * a portable user does not have. The failure surfaces to the end user as a track export or an
 * audio conversion that dies on spawn — a long way from the build that caused it.
 *
 * The names checked here are the EXACT ones the packaged runtime resolves, not the
 * `extraResources` globs. Those globs are deliberately looser (`ffmpeg*`), so a stray
 * `ffmpeg.old` satisfies the filter and ships, while `resolveTool()` (`ffmpeg.ts`) still looks
 * for `ffmpeg.exe` / `ffprobe.exe`. Checking the glob would reproduce the exact bug this script
 * exists to prevent.
 *
 * Only release packaging is gated. `npm run dev` deliberately falls back to an FFmpeg on PATH,
 * which is a supported development setup, so this must not run there.
 *
 * Usage: `node scripts/check-bin.mjs [--target=win32|darwin|linux] [--bin-dir=path]`
 * (defaults to the host platform and `resources/bin`. `--bin-dir` is what the
 * electron-builder afterPack hook uses to check the *copied* binaries, not the
 * source tree that extraResources read from.)
 */
import fs from 'fs'
import path from 'path'

/**
 * Which platform the RELEASE is for — not which platform is building it.
 *
 * `resolveTool()` picks its filenames from the platform the packaged app runs on, so the
 * preflight has to do the same. Reading `process.platform` here would make a Linux or macOS CI
 * host cross-building `--win` check for extensionless `ffmpeg` / `ffprobe`, pass, and ship a
 * Windows package with no `.exe` in it — the same class of false pass as matching the packaging
 * globs, one level further out.
 *
 * Unknown values are rejected rather than defaulted, because a silently wrong target is
 * exactly the failure this script exists to make loud.
 */
const VALID_TARGETS = ['win32', 'darwin', 'linux']

function parseTarget(argv) {
  const arg = argv.find((a) => a === '--target' || a.startsWith('--target='))
  if (!arg) return process.platform
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[argv.indexOf(arg) + 1]
  if (!VALID_TARGETS.includes(value)) {
    console.error(
      `\nRelease build blocked: unknown --target "${value ?? ''}".\n` +
        `  expected one of: ${VALID_TARGETS.join(', ')}\n`
    )
    process.exit(1)
  }
  return value
}

function parseBinDir(argv) {
  const arg = argv.find((a) => a === '--bin-dir' || a.startsWith('--bin-dir='))
  if (!arg) return path.resolve('resources/bin')
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[argv.indexOf(arg) + 1]
  if (!value) {
    console.error('\nRelease build blocked: --bin-dir requires a path.\n')
    process.exit(1)
  }
  return path.resolve(value)
}

const TARGET = parseTarget(process.argv.slice(2))
const BIN_DIR = parseBinDir(process.argv.slice(2))

// Mirrors `const EXE` in ffmpeg.ts.
const EXE = TARGET === 'win32' ? '.exe' : ''

const REQUIRED = [
  { name: `ffmpeg${EXE}`, why: 'audio/video decoding and track extraction', fix: `copy ffmpeg${EXE} into resources/bin` },
  { name: `ffprobe${EXE}`, why: 'subtitle-track probing and media duration', fix: `copy ffprobe${EXE} into resources/bin` }
]

const problems = []

for (const req of REQUIRED) {
  const full = path.join(BIN_DIR, req.name)
  let stat
  try {
    stat = fs.statSync(full)
  } catch {
    problems.push({ ...req, detail: 'missing' })
    continue
  }
  // A directory or a zero-byte placeholder satisfies "exists" but not "is runnable",
  // and both have shown up in practice from interrupted copies and antivirus quarantine.
  if (!stat.isFile()) problems.push({ ...req, detail: 'not a regular file' })
  else if (stat.size === 0) problems.push({ ...req, detail: 'empty (0 bytes)' })
}

if (problems.length) {
  console.error(
    `\nRelease build blocked: ${BIN_DIR} does not contain the binaries a ${TARGET} package resolves.\n`
  )
  for (const p of problems) {
    console.error(`  - ${p.name}  ${p.detail}  (${p.why})\n      fix: ${p.fix}`)
  }
  console.error(
    '\nThese are not tracked in git, so a fresh clone never has them. The packaging filter\n' +
      'in package.json matches "ffmpeg*" / "ffprobe*", which is looser than what the app\n' +
      'actually looks for — so a build can succeed and still fail at runtime on every spawn.\n'
  )
  process.exit(1)
}

for (const req of REQUIRED) {
  const size = fs.statSync(path.join(BIN_DIR, req.name)).size
  console.log(`  ok  ${req.name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}
console.log(`Release preflight passed: all binaries required by a ${TARGET} package are present.\n`)
