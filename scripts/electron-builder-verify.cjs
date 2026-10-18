/**
 * Shared release-preflight for electron-builder hooks.
 *
 * npm script order is not a packaging invariant (SOL-42): `npx electron-builder --win`
 * never runs `check:bin`, and a binary removed or emptied after that script but before the
 * extraResources copy would still ship. These hooks are inside the packer. beforePack checks the
 * source tree; afterPack checks the *copied* FFmpeg and FFprobe in the unpacked app;
 * afterAllArtifactBuild inspects the ZIP/AppImage that is actually shipped, because afterPack
 * returns before that archive exists, and also refuses anything of the retired Python engine.
 *
 * The same three points guard the ALASS sidecar unit on Windows: beforePack runs
 * `check-alass.mjs --package` on the source tree, afterPack and afterAllArtifactBuild compare the
 * copied unit with `licenses/alass/2.0.0/UNIT-MANIFEST.json` file by file.
 */
const { spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..')

function targetOf(context) {
  const p = context.electronPlatformName
  if (p === 'win32' || p === 'windows') return 'win32'
  if (p === 'darwin' || p === 'mac') return 'darwin'
  if (p === 'linux') return 'linux'
  throw new Error(`Release pack blocked: unknown electron platform "${p}"`)
}

function runCheckBin(args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'check-bin.mjs'), ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error('Release pack blocked: check-bin.mjs refused')
  }
}

function packedBinDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const app = `${context.packager.appInfo.productFilename}.app`
    return path.join(context.appOutDir, app, 'Contents', 'Resources', 'bin')
  }
  return path.join(context.appOutDir, 'resources', 'bin')
}

function path7za() {
  // electron-builder already ships this; resolve from the repo so the hook does not
  // depend on whatever cwd the packer happens to have.
  return require(path.join(REPO_ROOT, 'node_modules', '7zip-bin')).path7za
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function listArchiveFiles(archive) {
  const listed = spawnSync(path7za(), ['l', '-slt', archive], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  if (listed.error) throw listed.error
  if (listed.status !== 0) {
    throw new Error(
      `Release pack blocked: cannot inspect ${path.basename(archive)} ` +
        `(${(listed.stderr || listed.stdout || '').trim() || `exit ${listed.status}`})`
    )
  }
  const files = []
  let current = {}
  const flush = () => {
    if (current.Path && current.Folder !== '+') files.push(current)
    current = {}
  }
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    const eq = line.indexOf(' = ')
    if (eq > 0) current[line.slice(0, eq)] = line.slice(eq + 3)
  }
  flush()
  const archiveName = path.basename(archive)
  return files.filter((f) => path.basename(f.Path.replace(/\\/g, '/')) !== archiveName)
}

/**
 * One runtime path per artifact. ORing Windows and macOS suffixes let a Windows
 * zip ship Contents/Resources/bin/ffmpeg.exe and still pass (SOL-51 remainder).
 *
 *   zip, Windows   → resources/bin/ffmpeg.exe, resources/bin/ffprobe.exe
 *   AppImage       → resources/bin/ffmpeg, resources/bin/ffprobe
 *   zip, macOS     → Contents/Resources/bin/ffmpeg, Contents/Resources/bin/ffprobe
 */
function requiredBinarySuffix(archive, binary) {
  const ext = path.extname(archive).toLowerCase()
  const windows = binary.toLowerCase().endsWith('.exe')
  if (ext === '.appimage') {
    if (windows) {
      throw new Error(`Release pack blocked: an AppImage cannot ship a Windows ${binary}`)
    }
    return `/resources/bin/${binary}`
  }
  if (ext === '.zip') {
    return windows ? `/resources/bin/${binary}` : `/Contents/Resources/bin/${binary}`
  }
  throw new Error(`Release pack blocked: cannot determine the runtime path for ${path.basename(archive)}`)
}

function matchesRuntimePath(entryPath, suffix) {
  const n = entryPath.replace(/\\/g, '/')
  const withSlash = n.startsWith('/') ? n : `/${n}`
  if (withSlash !== suffix && !withSlash.endsWith(suffix)) return false
  // `/Contents/Resources/bin/ffmpeg.exe` must not count as `/resources/bin/ffmpeg.exe`.
  if (suffix.includes('/resources/bin/') && /\/contents\/resources\/bin\//i.test(withSlash)) {
    return false
  }
  return true
}

function findBinaryEntry(files, binary, archive) {
  const suffix = requiredBinarySuffix(archive, binary)
  const matches = files.filter((f) => matchesRuntimePath(f.Path, suffix))
  if (matches.length === 0) {
    throw new Error(
      `Release pack blocked: ${binary} is not at ${suffix.slice(1)} in the packed archive`
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Release pack blocked: packed archive contains ${matches.length} copies of ${binary}`
    )
  }
  return matches[0]
}

/** The media binaries an archive must carry, named as its own platform's runtime resolves them. */
function mediaBinariesFor(archive, files) {
  const exe = isWindowsArchive(archive, files) ? '.exe' : ''
  return [`ffmpeg${exe}`, `ffprobe${exe}`]
}

/**
 * What a release may never carry again: the retired Python engine and everything its freeze
 * brought with it. The engine is native now, so any of these in an archive is a stale input that
 * reached the packer, and shipping it would put an unused, unpatched interpreter on users' disks.
 */
const RETIRED_PAYLOAD = Object.freeze([
  { what: 'a gst engine executable', test: /(^|\/)gst(\.exe)?$/i },
  { what: 'the engine freeze stamp', test: /(^|\/)gst\.buildstamp\.json$/i },
  { what: 'a Python runtime', test: /(^|\/)pythonw?(\d+(\.\d+)*)?(\.exe)?$/i },
  { what: 'a Python runtime library', test: /(^|\/)(lib)?python\d+(\.\d+)*(\.dll|\.dylib|\.so(\.[\d.]+)?)$/i },
  { what: 'compiled Python', test: /\.(pyc|pyd|pyz)$/i },
  { what: 'a frozen Python standard library', test: /(^|\/)base_library\.zip$/i },
  { what: 'a Python dependency payload', test: /(^|\/)(site-packages|__pycache__|_internal)\// }
])

function retiredPayloadIn(files) {
  for (const f of files) {
    const p = f.Path.replace(/\\/g, '/')
    const hit = RETIRED_PAYLOAD.find((r) => r.test.test(p))
    if (hit) return `${hit.what} (${p})`
  }
  return null
}

/**
 * Inspect the ZIP or AppImage that is actually shipped: exactly one non-empty FFmpeg and FFprobe,
 * each at the runtime path its platform resolves, and nothing of the retired Python engine.
 * Used by afterAllArtifactBuild, because afterPack returns before that archive exists.
 */
function verifyPackedArchive(archive) {
  const files = listArchiveFiles(archive)
  const media = mediaBinariesFor(archive, files).map((binary) => {
    const entry = findBinaryEntry(files, binary, archive)
    const bytes = Number(entry.Size)
    if (!Number.isFinite(bytes) || bytes <= 0) {
      throw new Error(`Release pack blocked: ${binary} in ${path.basename(archive)} is empty`)
    }
    return { binary, path: entry.Path.replace(/\\/g, '/'), bytes }
  })
  const retired = retiredPayloadIn(files)
  if (retired) {
    throw new Error(`Release pack blocked: ${path.basename(archive)} contains ${retired}`)
  }
  return { media, files: files.length }
}

// ── ALASS sidecar unit ─────────────────────────────────────────────────────────────────────────
/**
 * The executable, its report schema, its exact Corresponding Source and its licences ship as one
 * versioned unit (alass_sidecar_compliance.md §§5-6). Paths are relative to the unpacked app root.
 * Only Windows ships it: the executable is a Windows program.
 */
const ALASS_UNIT = Object.freeze({
  version: '2.0.0',
  exe: 'resources/bin/alass/2.0.0/alass.exe',
  source: 'resources/bin/alass/2.0.0/corresponding-source',
  licences: 'licenses/alass/2.0.0',
  manifest: 'licenses/alass/2.0.0/UNIT-MANIFEST.json',
  /** Everything under these belongs to the component; anything not in the manifest is foreign. */
  roots: ['resources/bin/alass', 'licenses/alass'],
  repo: {
    exe: 'resources/bin/alass/2.0.0/alass.exe',
    vendor: 'vendor/alass/2.0.0',
    licences: 'licenses/alass/2.0.0',
    /** The script that controls the build is part of the Corresponding Source. */
    buildScript: 'scripts/build-alass.ps1'
  },
  /** Repository housekeeping, not part of the shipped source. */
  vendorExcluded: ['.gitattributes']
})

function blocked(why) {
  return new Error(`Release pack blocked: ALASS unit — ${why}`)
}

function walkFiles(root) {
  const out = []
  const go = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) go(p)
      else out.push({ rel: path.relative(root, p).split(path.sep).join('/'), plain: e.isFile() })
    }
  }
  if (fs.existsSync(root)) go(root)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** The unit this repository would ship: each packed path, the repository file it comes from, and its hash. */
function expectedAlassUnit(repoRoot = REPO_ROOT) {
  const r = ALASS_UNIT.repo
  const entries = [
    { path: ALASS_UNIT.exe, from: r.exe },
    { path: `${ALASS_UNIT.source}/build-alass.ps1`, from: r.buildScript }
  ]
  for (const f of walkFiles(path.join(repoRoot, r.vendor))) {
    if (!ALASS_UNIT.vendorExcluded.includes(f.rel)) entries.push({ path: `${ALASS_UNIT.source}/${f.rel}`, from: `${r.vendor}/${f.rel}` })
  }
  const manifestName = path.posix.basename(ALASS_UNIT.manifest)
  for (const f of walkFiles(path.join(repoRoot, r.licences))) {
    if (f.rel !== manifestName) entries.push({ path: `${ALASS_UNIT.licences}/${f.rel}`, from: `${r.licences}/${f.rel}` })
  }
  const files = entries
    .map((e) => {
      const abs = path.join(repoRoot, e.from)
      if (!fs.existsSync(abs)) throw blocked(`${e.from} is missing from the repository`)
      return { path: e.path, sha256: sha256File(abs), bytes: fs.statSync(abs).size }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { component: 'alass-cli', version: ALASS_UNIT.version, files }
}

function alassManifestText(repoRoot = REPO_ROOT) {
  const unit = expectedAlassUnit(repoRoot)
  return (
    JSON.stringify(
      {
        generatedBy: 'node scripts/check-alass.mjs --write-manifest',
        component: unit.component,
        version: unit.version,
        means: 'every file of the ALASS unit, by path relative to the unpacked application, with its SHA-256; nothing else may exist under resources/bin/alass or licenses/alass, except this file',
        fileCount: unit.files.length,
        files: unit.files
      },
      null,
      2
    ) + '\n'
  )
}

/** The tracked manifest, after confirming it is exactly what the repository generates. */
function currentAlassManifest(repoRoot = REPO_ROOT) {
  const file = path.join(repoRoot, ALASS_UNIT.manifest)
  if (!fs.existsSync(file)) throw blocked(`${ALASS_UNIT.manifest} is missing; run node scripts/check-alass.mjs --write-manifest`)
  const text = fs.readFileSync(file, 'utf8')
  if (text !== alassManifestText(repoRoot)) throw blocked(`${ALASS_UNIT.manifest} is stale; run node scripts/check-alass.mjs --write-manifest`)
  return text
}

/**
 * The unit inside an unpacked app is complete, unmixed and this release's: every manifest file present
 * with its hash, nothing else under the component roots, no ALASS executable anywhere else, and the
 * packed receipt, source inventory and source agreeing with each other.
 */
function verifyAlassUnit(appRoot, manifestText) {
  const manifest = JSON.parse(manifestText)
  const packedManifest = path.join(appRoot, ALASS_UNIT.manifest)
  if (!fs.existsSync(packedManifest) || fs.readFileSync(packedManifest, 'utf8') !== manifestText) {
    throw blocked(`${ALASS_UNIT.manifest} is missing or is not this release's`)
  }
  const expected = new Map(manifest.files.map((f) => [f.path, f]))
  expected.set(ALASS_UNIT.manifest, null)
  const seen = new Set()
  for (const root of ALASS_UNIT.roots) {
    for (const f of walkFiles(path.join(appRoot, root))) {
      const rel = `${root}/${f.rel}`
      if (!expected.has(rel)) throw blocked(`${rel} is not part of this release's unit (a mixed or leftover component)`)
      if (!f.plain) throw blocked(`${rel} is not a plain file`)
      seen.add(rel)
    }
  }
  for (const f of manifest.files) {
    if (!seen.has(f.path)) throw blocked(`${f.path} is missing`)
    const abs = path.join(appRoot, f.path)
    if (fs.statSync(abs).size !== f.bytes || sha256File(abs) !== f.sha256) throw blocked(`${f.path} differs from the unit manifest`)
  }
  const strays = walkFiles(appRoot)
    .map((f) => f.rel)
    .filter((rel) => /(^|\/)alass[^/]*\.exe$/i.test(rel) && rel !== ALASS_UNIT.exe)
  if (strays.length) throw blocked(`an ALASS executable outside the unit: ${strays.join(', ')}`)

  const src = path.join(appRoot, ALASS_UNIT.source)
  const receipt = JSON.parse(fs.readFileSync(path.join(src, 'build-receipt.json'), 'utf8'))
  const exe = path.join(appRoot, ALASS_UNIT.exe)
  if (sha256File(exe) !== receipt.executable.sha256 || fs.statSync(exe).size !== receipt.executable.bytes) {
    throw blocked('alass.exe is not the build its packed receipt describes')
  }
  const inventoryFile = path.join(src, 'source-inventory.json')
  if (sha256File(inventoryFile) !== receipt.inputs.sourceInventorySha256) throw blocked('the packed source inventory is not the one the receipt names')
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'))
  const packedSource = walkFiles(path.join(src, 'source')).map((f) => f.rel)
  const listed = inventory.files.map((f) => f.path).sort()
  if (JSON.stringify(packedSource) !== JSON.stringify(listed)) throw blocked('the packed source tree is not exactly the inventoried files')
  for (const f of inventory.files) {
    if (sha256File(path.join(src, 'source', f.path)) !== f.sha256) throw blocked(`packed source ${f.path} differs from its inventory entry`)
  }
  if (sha256File(path.join(src, 'source', 'Cargo.lock')) !== receipt.inputs.cargoLockSha256) throw blocked('the packed Cargo.lock is not the one the receipt names')
  return { files: manifest.files.length + 1 }
}

/** A non-Windows build carries no ALASS executable at all. */
function verifyNoAlassBinary(binDir) {
  const found = walkFiles(binDir)
    .map((f) => f.rel)
    .filter((rel) => /^alass(\/|$)|(^|\/)alass[^/]*$/i.test(rel))
  if (found.length) throw blocked(`a non-Windows build contains ${found.join(', ')}`)
}

/** Which unpacked prefix of an archive is the app root, judged by where its one ALASS executable sits. */
function alassArchivePrefix(files) {
  const norm = files.map((f) => f.Path.replace(/\\/g, '/'))
  const exes = norm.filter((p) => /(^|\/)alass[^/]*\.exe$/i.test(p))
  const unitExe = exes.filter((p) => p === ALASS_UNIT.exe || p.endsWith(`/${ALASS_UNIT.exe}`))
  if (unitExe.length !== 1 || exes.length !== 1) {
    throw blocked(`the archive contains ${exes.length} ALASS executable(s), ${unitExe.length} at ${ALASS_UNIT.exe}`)
  }
  return unitExe[0].slice(0, unitExe[0].length - ALASS_UNIT.exe.length)
}

/** Unpack a Windows archive and verify the unit exactly as it will be extracted on a user's machine. */
function verifyAlassArchive(archive, manifestText) {
  const prefix = alassArchivePrefix(listArchiveFiles(archive))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-pack-alass-'))
  try {
    const extracted = spawnSync(path7za(), ['x', '-y', `-o${tmp}`, archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (extracted.error) throw extracted.error
    if (extracted.status !== 0) throw blocked(`could not extract ${path.basename(archive)}`)
    return verifyAlassUnit(path.join(tmp, prefix), manifestText)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function runCheckAlass() {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'check-alass.mjs'), '--package'], { stdio: 'inherit', cwd: REPO_ROOT })
  if (result.error) throw result.error
  if (result.status !== 0) throw blocked('check-alass.mjs --package refused')
}

const isWindowsArchive = (archive, files) =>
  /\.zip$/i.test(archive) && !files.some((f) => /(^|[\\/])Contents[\\/]Resources[\\/]/.test(f.Path))

const alass = {
  async beforePack(context, run = runCheckAlass) {
    if (targetOf(context) === 'win32') run()
  },
  async afterPack(context, repoRoot = REPO_ROOT) {
    if (targetOf(context) !== 'win32') return verifyNoAlassBinary(packedBinDir(context))
    const r = verifyAlassUnit(context.appOutDir, currentAlassManifest(repoRoot))
    console.log(`  ok  unpacked app holds the complete ALASS ${ALASS_UNIT.version} unit (${r.files} files)`)
  },
  async afterAllArtifactBuild(result, repoRoot = REPO_ROOT) {
    const archives = (result.artifactPaths || []).filter((p) => /\.(zip|appimage)$/i.test(p))
    for (const file of archives) {
      const files = listArchiveFiles(file)
      if (isWindowsArchive(file, files)) {
        const r = verifyAlassArchive(file, currentAlassManifest(repoRoot))
        console.log(`  ok  packed ${path.basename(file)} holds the complete ALASS ${ALASS_UNIT.version} unit (${r.files} files)`)
      } else {
        const found = files.filter((f) => /(^|[\\/])bin[\\/]alass([\\/]|$)/i.test(f.Path))
        if (found.length) throw blocked(`a non-Windows archive contains ${found[0].Path}`)
      }
    }
  }
}

exports.beforePack = async function beforePack(context) {
  runCheckBin([`--target=${targetOf(context)}`])
  await alass.beforePack(context)
}

exports.afterPack = async function afterPack(context) {
  const target = targetOf(context)
  runCheckBin([`--target=${target}`, `--bin-dir=${packedBinDir(context)}`])
  await alass.afterPack(context)
}

exports.afterAllArtifactBuild = async function afterAllArtifactBuild(result) {
  const archives = (result.artifactPaths || []).filter((p) => /\.(zip|appimage)$/i.test(p))
  for (const file of archives) {
    const r = verifyPackedArchive(file)
    console.log(`  ok  packed ${path.basename(file)}: ${r.media.map((m) => m.path).join(', ')}, no Python payload`)
  }
  await alass.afterAllArtifactBuild(result)
}

exports.verifyPackedArchive = verifyPackedArchive
exports.ALASS_UNIT = ALASS_UNIT
exports.alass = alass
exports.expectedAlassUnit = expectedAlassUnit
exports.alassManifestText = alassManifestText
exports.currentAlassManifest = currentAlassManifest
exports.verifyAlassUnit = verifyAlassUnit
exports.verifyAlassArchive = verifyAlassArchive
exports.verifyNoAlassBinary = verifyNoAlassBinary
exports.alassArchivePrefix = alassArchivePrefix
exports.listArchiveFiles = listArchiveFiles
exports.path7za = path7za
