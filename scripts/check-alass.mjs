/**
 * Verifies the ALASS 2.0.0 component unit: vendored source, report fork, dependency inventory,
 * report schema and the generated executable.
 *
 *   node scripts/check-alass.mjs                     source, inventory, licences, unit, schema, binary, report identity
 *   node scripts/check-alass.mjs --package           what packaging needs, without a Rust toolchain:
 *                                                    source, unit manifest and licences, schema, binary
 *   node scripts/check-alass.mjs --write-inventory   regenerate dependency-inventory.json from Cargo.lock
 *   node scripts/check-alass.mjs --write-licences    regenerate licenses/alass/2.0.0 from Cargo.lock and the toolchain
 *   node scripts/check-alass.mjs --write-manifest    regenerate licenses/alass/2.0.0/UNIT-MANIFEST.json
 *   node scripts/check-alass.mjs --rebuild           also rebuild into scratch; the hash must be identical
 *   node scripts/check-alass.mjs --parity            also run the E63 benchmark; 102/102 rows must match
 *        [--parity-ffmpeg <dir>]                     ...with ffmpeg.exe/ffprobe.exe from <dir>
 *   node scripts/check-alass.mjs --clean-machine <zip>
 *                                                    SIMULATED clean machine: unpack a release ZIP into a new
 *                                                    folder, verify the unit, run ALASS from it with only Windows
 *                                                    folders on PATH and list every module it loads
 *   [--upstream-zip <path>]  pristine alass-v2.0.0 source archive (default .secrets/ALASS/selfbuild/...)
 *
 * Exit 0 only when nothing failed. A check that cannot run here prints SKIP and says why.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(repo, 'vendor', 'alass', '2.0.0')
const source = path.join(vendor, 'source')
const installed = path.join(repo, 'resources', 'bin', 'alass', '2.0.0', 'alass.exe')
const licenceDir = path.join(repo, 'licenses', 'alass', '2.0.0')
const unit = createRequire(import.meta.url)('./electron-builder-verify.cjs')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : fallback
}
const cleanMachineZip = option('--clean-machine', null)
const packageOnly = flag('--package') || cleanMachineZip !== null
const upstreamZip = option('--upstream-zip', path.join(repo, '.secrets', 'ALASS', 'selfbuild', 'alass-v2.0.0-source.zip'))
const UPSTREAM_ROOT = 'alass-2.0.0'
const GPL3_SHA256 = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
const PARITY_ROWS = 102

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const shaFile = (p) => sha(fs.readFileSync(p))
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ng-check-alass-${tag}-`))
const walk = (root) => {
  const out = []
  const go = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) go(p)
      else out.push(path.relative(root, p).split(path.sep).join('/'))
    }
  }
  go(root)
  return out.sort()
}
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
/** Only Windows' own folders: the sidecar must not lean on a developer's PATH. */
const bareEnv = () => ({ SystemRoot: systemRoot, PATH: `${systemRoot}\\System32;${systemRoot}`, TEMP: os.tmpdir(), TMP: os.tmpdir() })

let passed = 0
let failed = 0
let skipped = 0
const pass = (name) => {
  passed++
  console.log(`  PASS  ${name}`)
}
const fail = (name, detail) => {
  failed++
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
}
const skip = (name, why) => {
  skipped++
  console.log(`  SKIP  ${name} — ${why}`)
}
const check = (name, ok, detail) => (ok ? pass(name) : fail(name, detail))

const receipt = readJson(path.join(vendor, 'build-receipt.json'))
const inventoryPath = path.join(vendor, 'source-inventory.json')
const inventory = readJson(inventoryPath)

// ── Source and fork ────────────────────────────────────────────────────────────────────────────
console.log('\nsource')
{
  const onDisk = walk(source)
  const listed = inventory.files.map((f) => f.path).sort()
  check('the vendored tree holds exactly the inventoried files', JSON.stringify(onDisk) === JSON.stringify(listed), `on disk ${onDisk.length}, listed ${listed.length}`)
  const wrong = inventory.files.filter((f) => !fs.existsSync(path.join(source, f.path)) || shaFile(path.join(source, f.path)) !== f.sha256).map((f) => f.path)
  check('every vendored file hashes to its inventory entry', wrong.length === 0, wrong.join(', '))
  const modified = inventory.files.filter((f) => f.modified).map((f) => f.path)
  check('only alass-cli/src/main.rs differs from upstream', JSON.stringify(modified) === JSON.stringify(['alass-cli/src/main.rs']) && inventory.files.every((f) => f.modified === (f.sha256 !== f.upstreamSha256)), modified.join(', '))
  check('report-fork.patch is the inventoried patch', shaFile(path.join(vendor, 'report-fork.patch')) === inventory.modification.patchSha256)
  check('source-inventory.json and Cargo.lock are the ones the build receipt names', shaFile(inventoryPath) === receipt.inputs.sourceInventorySha256 && shaFile(path.join(source, 'Cargo.lock')) === receipt.inputs.cargoLockSha256)
  const licence = fs.readFileSync(path.join(source, 'LICENSE'))
  check('LICENSE is the unmodified GPLv3 text', sha(licence) === GPL3_SHA256 && /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/.test(licence.toString('utf8')))
  const head = fs.readFileSync(path.join(source, 'alass-cli', 'src', 'main.rs'), 'utf8').split('\n').slice(0, 12).join('\n')
  check('the modified file keeps the upstream copyright and carries a dated modification notice', /Copyright \(C\) 2017 kaegi/.test(head) && /MODIFIED \d{4}-\d{2}-\d{2} /.test(head))
  const attrs = fs.readFileSync(path.join(vendor, '.gitattributes'), 'utf8')
  check('the vendor tree is exempt from end-of-line conversion', /^\* -text$/m.test(attrs))
}

console.log('\nupstream')
if (!fs.existsSync(upstreamZip)) {
  skip('pristine archive comparison', `no archive at ${path.relative(repo, upstreamZip)}`)
} else {
  check('the pristine archive is the recorded v2.0.0 release', shaFile(upstreamZip) === inventory.upstream.archiveSha256)
  const dir = scratch('upstream')
  try {
    const tar = spawnSync(path.join(systemRoot, 'System32', 'tar.exe'), ['-xf', upstreamZip, '-C', dir], { encoding: 'utf8' })
    const root = path.join(dir, UPSTREAM_ROOT)
    if (tar.status !== 0 || !fs.existsSync(root)) {
      fail('the pristine archive extracts', tar.stderr)
    } else {
      const files = walk(root)
      check('the archive holds the same file set as the vendored tree', JSON.stringify(files) === JSON.stringify(inventory.files.map((f) => f.path).sort()))
      const differs = inventory.files.filter((f) => !fs.existsSync(path.join(root, f.path)) || shaFile(path.join(root, f.path)) !== f.upstreamSha256).map((f) => f.path)
      check('every upstream hash in the inventory is the archive\u2019s', differs.length === 0, differs.join(', '))
      const apply = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', path.join(vendor, 'report-fork.patch')], { cwd: root, encoding: 'utf8' })
      const rebuilt = walk(root).filter((f) => shaFile(path.join(root, f)) !== shaFile(path.join(source, f)))
      check('upstream + report-fork.patch reproduces the vendored tree byte for byte', apply.status === 0 && rebuilt.length === 0, apply.stderr || rebuilt.join(', '))
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── Dependency inventory ───────────────────────────────────────────────────────────────────────
console.log('\ndependencies')
const cargoMetadata = () => {
  const r = spawnSync('rustup', ['run', receipt.toolchain.rustupToolchain, 'cargo', 'metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', path.join(source, 'Cargo.toml')], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.status !== 0) return { error: (r.error?.message ?? '') + (r.stderr ?? '').slice(-400) }
  return { m: JSON.parse(r.stdout) }
}
const dependencyInventory = (meta = cargoMetadata()) => {
  if (meta.error) return meta
  const { m } = meta
  const nodes = new Map(m.resolve.nodes.map((n) => [n.id, n]))
  const linked = new Set()
  const stack = [m.packages.find((p) => p.name === 'alass-cli').id]
  while (stack.length) {
    const id = stack.pop()
    if (linked.has(id)) continue
    linked.add(id)
    for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg)
  }
  const packages = m.packages
    .map((p) => ({ name: p.name, version: p.version, license: p.license ?? null, licenseFile: p.license_file ?? null, repository: p.repository ?? null, source: p.source ?? null, linked: linked.has(p.id) }))
    .sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)))
  const out = {
    generatedBy: 'node scripts/check-alass.mjs --write-inventory (cargo metadata --locked --offline --format-version 1)',
    cargoLockSha256: shaFile(path.join(source, 'Cargo.lock')),
    linkedMeans: 'reachable from alass-cli through normal (not dev, not build-script) dependency edges, for any target',
    packageCount: packages.length,
    linkedCount: packages.filter((p) => p.linked).length,
    packages
  }
  return { text: JSON.stringify(out, null, 2) + '\n', out, linked, m }
}
const meta = packageOnly ? null : cargoMetadata()
if (packageOnly) {
  skip('the dependency inventory regenerates from Cargo.lock', '--package does not need the Rust toolchain; the unit manifest pins the inventory by hash')
} else {
  const target = path.join(vendor, 'dependency-inventory.json')
  const gen = dependencyInventory(meta)
  if (gen.error) {
    fail('the dependency inventory regenerates from Cargo.lock', gen.error)
  } else if (flag('--write-inventory')) {
    fs.writeFileSync(target, gen.text)
    pass(`wrote dependency-inventory.json (${gen.out.packageCount} packages, ${gen.out.linkedCount} linked)`)
  } else {
    check('dependency-inventory.json is exactly what Cargo.lock generates', fs.existsSync(target) && fs.readFileSync(target, 'utf8') === gen.text)
    const unlicensed = gen.out.packages.filter((p) => p.linked && !p.license && !p.licenseFile).map((p) => `${p.name} ${p.version}`)
    check('every linked package declares a licence', unlicensed.length === 0, unlicensed.join(', '))
    const gpl = gen.out.packages.filter((p) => /GPL/.test(p.license ?? '')).map((p) => p.name).sort()
    check('GPL-3.0 is declared by exactly the two ALASS packages', JSON.stringify(gpl) === JSON.stringify(['alass-cli', 'alass-core']), gpl.join(', '))
  }
}

// ── Licences shipped with the unit ─────────────────────────────────────────────────────────────
/**
 * The MinGW-w64 runtime's start-up and string code is linked into alass.exe, and its licence asks for
 * this notice in binary distributions. Neither the recorded toolchain nor WinLibs ships the file, so it
 * is kept verbatim from upstream v14.0.0 (the WinLibs runtime; a superset of the v11–v13 text) and
 * pinned by hash.
 */
const MINGW_RUNTIME_NOTICE = Object.freeze({
  path: 'mingw-w64/COPYING.MinGW-w64-runtime.txt',
  sha256: '1db8da07b436c68833c0673ffee3d9fcb2526047f3820b81661865dfedc79a1f',
  from: 'https://raw.githubusercontent.com/mingw-w64/mingw-w64/v14.0.0/COPYING.MinGW-w64-runtime/COPYING.MinGW-w64-runtime.txt'
})
/** Kept by hand (the README and the MinGW-w64 notice) and the manifest; every other file in licenses/alass/2.0.0 is generated here. */
const LICENCE_HAND_WRITTEN = ['README.txt', 'UNIT-MANIFEST.json', MINGW_RUNTIME_NOTICE.path]
const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|patents|authors|unlicense)([-._].*)?$/i
/** Not compiled into the executable. */
const LICENCE_SKIP_DIRS = new Set(['tests', 'testdata', 'benches', 'examples', 'target', '.git'])
/** Licences that ask for no notice, so a package declaring only these needs no text. */
const NO_NOTICE = { 'CC0-1.0': 'a public-domain dedication (CC0 1.0) that asks for no notice; https://creativecommons.org/publicdomain/zero/1.0/legalcode' }
/** Rust's standard library and the GCC runtime are compiled into alass.exe; their notices come from the recorded toolchain. */
const TOOLCHAIN_NOTICES = [
  ['share/doc/rust/COPYRIGHT-library.html', 'rust-toolchain/COPYRIGHT-library.html'],
  ['share/doc/COPYING.RUNTIME', 'rust-toolchain/COPYING.RUNTIME'],
  ['share/doc/COPYING3', 'rust-toolchain/COPYING3'],
  ['share/doc/README.txt', 'rust-toolchain/README.txt']
]
const licenceFilesOf = (dir) => {
  const out = []
  const go = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!LICENCE_SKIP_DIRS.has(e.name)) go(p)
      } else if (LICENCE_FILE.test(e.name)) out.push(path.relative(dir, p).split(path.sep).join('/'))
    }
  }
  go(dir)
  return out.sort()
}
/** Both lockfile layouts: v1 keeps checksums in `[metadata]`, later versions on each `[[package]]`. */
const lockChecksums = () => {
  const out = new Map()
  const lock = fs.readFileSync(path.join(source, 'Cargo.lock'), 'utf8')
  for (const m of lock.matchAll(/^"checksum (\S+) (\S+) \([^)]*\)" = "([0-9a-f]{64})"$/gm)) out.set(`${m[1]} ${m[2]}`, m[3])
  for (const block of lock.split(/\r?\n\[\[package\]\]\r?\n/)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1]
    const version = /^version = "([^"]+)"/m.exec(block)?.[1]
    const checksum = /^checksum = "([0-9a-f]{64})"/m.exec(block)?.[1]
    if (name && version && checksum) out.set(`${name} ${version}`, checksum)
  }
  return out
}
const licenceIds = (expr) => (expr ?? '').split(/\s*(?:\/|\bOR\b|\bAND\b|\bWITH\b|[()])\s*/).map((s) => s.trim()).filter(Boolean)
const toolchainSysroot = () => {
  const r = spawnSync('rustup', ['run', receipt.toolchain.rustupToolchain, 'rustc', '--print', 'sysroot'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
/** Every generated file of licenses/alass/2.0.0, as relative path → bytes. */
const generateLicences = (gen) => {
  const sysroot = toolchainSysroot()
  if (!sysroot) return { error: 'rustup cannot print the recorded toolchain\u2019s sysroot' }
  const out = new Map()
  out.set('GPL-3.0.txt', fs.readFileSync(path.join(source, 'LICENSE')))
  for (const [from, to] of TOOLCHAIN_NOTICES) {
    const p = path.join(sysroot, ...from.split('/'))
    if (!fs.existsSync(p)) return { error: `the toolchain has no ${from}` }
    out.set(to, fs.readFileSync(p))
  }
  const sums = lockChecksums()
  const standard = new Map()
  const linkedPackages = gen.m.packages.filter((p) => gen.linked.has(p.id)).sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)))
  const rule = '='.repeat(100)
  const parts = [
    'ALASS 2.0.0 \u2014 licences of the Rust packages compiled into alass.exe',
    '',
    'Generated by `node scripts/check-alass.mjs --write-licences` from the Cargo.lock shipped in',
    `corresponding-source/source/Cargo.lock (SHA-256 ${shaFile(path.join(source, 'Cargo.lock'))}). Do not edit by hand.`,
    '',
    `${linkedPackages.length} packages are reachable from alass-cli through normal dependency edges, for any target.`,
    'Each published package\u2019s exact source is on crates.io at the version shown; the SHA-256 is the one',
    'Cargo.lock pins, so a downloaded crate can be checked against it. The two ALASS packages are this',
    'release\u2019s own source, shipped beside the executable.',
    ''
  ]
  for (const p of linkedPackages) {
    const dir = path.dirname(p.manifest_path)
    const own = p.source === null
    const files = own ? [] : licenceFilesOf(dir)
    /** A nested file covers bundled third-party code (libbacktrace, libfvad), not the package itself. */
    const ownText = files.some((f) => !f.includes('/'))
    if (!own && !ownText) {
      for (const id of licenceIds(p.license)) {
        if (NO_NOTICE[id]) continue
        const text = path.join(sysroot, 'share', 'doc', 'rust', 'licenses', `${id}.txt`)
        if (!fs.existsSync(text)) return { error: `${p.name} ${p.version} publishes no licence file and there is no standard text for ${id}` }
        standard.set(id, fs.readFileSync(text, 'utf8'))
      }
    }
    parts.push(
      rule,
      `${p.name} ${p.version}`,
      `  Declared licence : ${p.license ?? `(file) ${p.license_file}`}`,
      `  Authors          : ${(p.authors ?? []).join('; ') || '(none declared)'}`,
      own ? '  Source           : this release \u2014 corresponding-source/source/' + path.basename(dir) : `  Source           : https://crates.io/crates/${p.name}/${p.version}`,
      ...(own ? [] : [`  Cargo.lock SHA-256: ${sums.get(`${p.name} ${p.version}`) ?? '(none)'}`]),
      `  Licence files    : ${
        own
          ? 'GPL-3.0.txt in this folder (the workspace LICENSE)'
          : (files.length ? files.join(', ') : 'none') +
            (ownText ? '' : ` \u2014 the package publishes no licence file of its own; see \u201cStandard licence texts\u201d at the end`) +
            (!ownText && licenceIds(p.license).some((id) => NO_NOTICE[id]) ? ` (${licenceIds(p.license).filter((id) => NO_NOTICE[id]).map((id) => `${id}: ${NO_NOTICE[id]}`).join('; ')})` : '')
      }`,
      rule
    )
    for (const f of files) parts.push(`--- ${f} ---`, fs.readFileSync(path.join(dir, ...f.split('/')), 'utf8').replace(/\s+$/, ''), '')
    parts.push('')
  }
  if (standard.size) {
    parts.push(rule, 'Standard licence texts', '  For the packages above that publish no licence file, from the recorded Rust toolchain\u2019s share/doc/rust/licenses.', rule)
    for (const [id, text] of [...standard].sort()) parts.push(`--- ${id} ---`, text.replace(/\s+$/, ''), '')
  }
  out.set('rust-dependencies.txt', Buffer.from(parts.join('\n') + '\n', 'utf8'))
  return { files: out }
}
const licenceFolderGenerated = () => (fs.existsSync(licenceDir) ? walk(licenceDir).filter((p) => !LICENCE_HAND_WRITTEN.includes(p)) : [])
console.log('\nlicences')
if (packageOnly) {
  skip('the licence folder regenerates from Cargo.lock and the toolchain', '--package does not need the Rust toolchain; the unit manifest pins every licence file by hash')
} else {
  const gen = dependencyInventory(meta)
  const lic = gen.error ? gen : generateLicences(gen)
  if (lic.error) {
    fail('the licence folder regenerates from Cargo.lock and the toolchain', lic.error)
  } else if (flag('--write-licences')) {
    for (const rel of licenceFolderGenerated()) if (!lic.files.has(rel)) fs.rmSync(path.join(licenceDir, rel))
    for (const [rel, bytes] of lic.files) {
      fs.mkdirSync(path.dirname(path.join(licenceDir, rel)), { recursive: true })
      fs.writeFileSync(path.join(licenceDir, rel), bytes)
    }
    pass(`wrote ${lic.files.size} generated files into licenses/alass/2.0.0`)
  } else {
    const onDisk = licenceFolderGenerated().sort()
    const want = [...lic.files.keys()].sort()
    check('licenses/alass/2.0.0 holds exactly the generated files plus README.txt and UNIT-MANIFEST.json', JSON.stringify(onDisk) === JSON.stringify(want), `on disk [${onDisk.join(', ')}], generated [${want.join(', ')}]`)
    const stale = want.filter((rel) => !fs.existsSync(path.join(licenceDir, rel)) || !fs.readFileSync(path.join(licenceDir, rel)).equals(lic.files.get(rel)))
    check('every generated licence file is exactly what Cargo.lock and the recorded toolchain produce', stale.length === 0, stale.join(', '))
  }
}

// ── The release unit ───────────────────────────────────────────────────────────────────────────
console.log('\nunit')
{
  if (flag('--write-manifest')) {
    fs.writeFileSync(path.join(repo, unit.ALASS_UNIT.manifest), unit.alassManifestText(repo))
    pass(`wrote ${unit.ALASS_UNIT.manifest}`)
  }
  let manifest = null
  try {
    manifest = JSON.parse(unit.currentAlassManifest(repo))
    pass('UNIT-MANIFEST.json is exactly what the repository generates')
  } catch (e) {
    fail('UNIT-MANIFEST.json is exactly what the repository generates', e.message)
  }
  const gplCopy = path.join(licenceDir, 'GPL-3.0.txt')
  check('licenses/alass/2.0.0/GPL-3.0.txt is the unmodified GPLv3 text', fs.existsSync(gplCopy) && shaFile(gplCopy) === GPL3_SHA256)
  const mingwCopy = path.join(licenceDir, ...MINGW_RUNTIME_NOTICE.path.split('/'))
  check(`licenses/alass/2.0.0/${MINGW_RUNTIME_NOTICE.path} is the unmodified MinGW-w64 v14.0.0 runtime notice`, fs.existsSync(mingwCopy) && shaFile(mingwCopy) === MINGW_RUNTIME_NOTICE.sha256, MINGW_RUNTIME_NOTICE.from)
  const readme = path.join(licenceDir, 'README.txt')
  const text = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : ''
  check('the licence README names ALASS 2.0.0, kaegi, the modification and where the source is', /ALASS/.test(text) && /2\.0\.0/.test(text) && /kaegi/.test(text) && /modified/i.test(text) && text.includes('corresponding-source'))
  if (manifest) {
    const exe = manifest.files.find((f) => f.path === unit.ALASS_UNIT.exe)
    check('the manifest\u2019s executable is the receipt\u2019s', exe?.sha256 === receipt.executable.sha256 && exe?.bytes === receipt.executable.bytes)
    const want = [
      `${unit.ALASS_UNIT.source}/report-schema-v1.json`,
      `${unit.ALASS_UNIT.source}/build-receipt.json`,
      `${unit.ALASS_UNIT.source}/MODIFICATIONS.md`,
      `${unit.ALASS_UNIT.source}/report-fork.patch`,
      `${unit.ALASS_UNIT.source}/source/Cargo.lock`,
      `${unit.ALASS_UNIT.source}/source/LICENSE`,
      `${unit.ALASS_UNIT.licences}/GPL-3.0.txt`,
      `${unit.ALASS_UNIT.licences}/rust-dependencies.txt`,
      `${unit.ALASS_UNIT.licences}/${MINGW_RUNTIME_NOTICE.path}`,
      `${unit.ALASS_UNIT.licences}/README.txt`
    ]
    const missing = want.filter((p) => !manifest.files.some((f) => f.path === p))
    check('the unit carries the schema, receipt, modification notice, patch, lockfile, GPL text, dependency licences and the MinGW-w64 notice', missing.length === 0, missing.join(', '))
  }
}

// ── Report schema v1 ───────────────────────────────────────────────────────────────────────────
/** The keywords report-schema-v1.json uses, and nothing else; an unknown keyword is an error. */
const KNOWN = new Set(['$schema', '$id', 'title', 'description', '$defs', '$ref', 'oneOf', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minimum', 'exclusiveMinimum', 'maxItems'])
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
const validate = (root, s, v, at = '$') => {
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) return [`${at}: schema keyword ${k} is not supported`]
  if (s.$ref) return validate(root, root.$defs[s.$ref.replace('#/$defs/', '')], v, at)
  if (s.oneOf) {
    const ok = s.oneOf.filter((b) => validate(root, b, v, at).length === 0).length
    return ok === 1 ? [] : [`${at}: matches ${ok} of ${s.oneOf.length} shapes`]
  }
  const errs = []
  if (s.type) {
    const t = typeOf(v)
    const allowed = [].concat(s.type)
    if (!allowed.includes(t) && !(t === 'integer' && allowed.includes('number'))) return [`${at}: ${t} is not ${allowed.join('|')}`]
  }
  if ('const' in s && JSON.stringify(v) !== JSON.stringify(s.const)) errs.push(`${at}: not ${JSON.stringify(s.const)}`)
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${at}: ${JSON.stringify(v)} not in enum`)
  if (typeof v === 'number') {
    if ('minimum' in s && v < s.minimum) errs.push(`${at}: below ${s.minimum}`)
    if ('exclusiveMinimum' in s && v <= s.exclusiveMinimum) errs.push(`${at}: not above ${s.exclusiveMinimum}`)
  }
  if (Array.isArray(v)) {
    if ('maxItems' in s && v.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`)
    if (s.items) v.forEach((x, i) => errs.push(...validate(root, s.items, x, `${at}[${i}]`)))
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of s.required ?? []) if (!(r in v)) errs.push(`${at}: missing ${r}`)
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) errs.push(...validate(root, s.properties[k], x, `${at}.${k}`))
      else if (s.additionalProperties === false) errs.push(`${at}: unexpected ${k}`)
    }
  }
  return errs
}
const schema = readJson(path.join(vendor, 'report-schema-v1.json'))
console.log('\nschema')
{
  const good = { schema_version: 1, candidate_only: true, engine: { name: 'alass-cli', version: '2.0.0' }, mode: 'piecewise', parameters: { fps_guessing: true, interval_ms: 1, speed_optimization: 1, split_penalty: 7 }, fps: { ratio_label: '1', scaling_factor: 1 }, score: 0.5, reference_cue_count: 2, input_cue_count: 2, shift_groups: [{ cue_count: 2, delta_ms: -3000, first_start_ms: 0, last_start_ms: 10 }], warnings: [] }
  const vad = { schema_version: 1, candidate_only: true, engine: { name: 'alass-cli', version: '2.0.0' }, mode: 'vad_export', reference_span_count: 3, score: null, fps: null, shift_groups: [], warnings: [] }
  const bad = [
    { ...good, verdict: 'accept' },
    { ...good, candidate_only: false },
    { ...good, schema_version: 2 },
    { ...good, mode: 'vad_export' },
    { ...good, warnings: ['some free text'] },
    { ...good, fps: { ratio_label: '30/25', scaling_factor: 1.2 } },
    { ...good, shift_groups: [{ cue_count: 0, delta_ms: 0, first_start_ms: 0, last_start_ms: 0 }] },
    { ...vad, shift_groups: [{ cue_count: 1, delta_ms: 0, first_start_ms: 0, last_start_ms: 0 }] }
  ]
  check('the schema accepts both shapes the fork writes', validate(schema, schema, good).length === 0 && validate(schema, schema, vad).length === 0)
  const leaked = bad.filter((b) => validate(schema, schema, b).length === 0)
  check('the schema rejects a verdict, a non-candidate, another version, a mixed shape, free-text warnings, an unknown fps and an empty group', leaked.length === 0, JSON.stringify(leaked))
}

// ── Executable ─────────────────────────────────────────────────────────────────────────────────
console.log('\nexecutable')
const srt = (cues) => cues.map((c, i) => `${i + 1}\n${stamp(c.s)} --> ${stamp(c.e)}\nLine ${i + 1}\n`).join('\n')
const stamp = (ms) => {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}
const runAlass = (exe, args, cwd) => spawnSync(exe, args, { cwd, env: bareEnv(), encoding: 'utf8', timeout: 120000, windowsHide: true })
if (!fs.existsSync(installed)) {
  fail('resources/bin/alass/2.0.0/alass.exe exists', 'run scripts/build-alass.ps1')
} else {
  const hash = shaFile(installed)
  check('the installed executable is the receipt\u2019s', hash === receipt.executable.sha256 && fs.statSync(installed).size === receipt.executable.bytes, hash)
  const v = runAlass(installed, ['--version'], os.tmpdir())
  check('with only Windows folders on PATH it starts and reports alass-cli 2.0.0', v.status === 0 && v.stdout.trim() === receipt.executable.versionLine, `${v.status} ${v.stdout}${v.stderr}`)

  const dir = scratch('report')
  try {
    const ref = Array.from({ length: 150 }, (_, i) => ({ s: 2000 + i * 4000 + ((i * 37) % 900), e: 2000 + i * 4000 + ((i * 37) % 900) + 1500 + ((i * 53) % 1200) }))
    const inc = ref.map((c) => ({ s: c.s + 3000, e: c.e + 3000 }))
    fs.writeFileSync(path.join(dir, 'ref.srt'), srt(ref))
    fs.writeFileSync(path.join(dir, 'inc.srt'), srt(inc))
    const fixed = ['--split-penalty', '7', '--speed-optimization', '1', '--interval', '1']
    for (const mode of ['piecewise', 'no_split']) {
      const extra = mode === 'no_split' ? ['--no-split'] : []
      const plain = runAlass(installed, ['ref.srt', 'inc.srt', `plain-${mode}.srt`, ...fixed, ...extra], dir)
      const rep = runAlass(installed, ['ref.srt', 'inc.srt', `report-${mode}.srt`, ...fixed, ...extra, '--json-report', `report-${mode}.json`], dir)
      const a = path.join(dir, `plain-${mode}.srt`)
      const b = path.join(dir, `report-${mode}.srt`)
      check(`${mode}: --json-report leaves the output subtitle byte-identical`, plain.status === 0 && rep.status === 0 && fs.existsSync(a) && fs.existsSync(b) && shaFile(a) === shaFile(b), `${plain.status}/${rep.status} ${rep.stderr}`)
      check(`${mode}: without --json-report no report file appears`, !fs.existsSync(path.join(dir, `plain-${mode}.json`)) && fs.readdirSync(dir).filter((f) => f.endsWith('.json')).every((f) => f.startsWith('report-')))
      let report = null
      try {
        report = readJson(path.join(dir, `report-${mode}.json`))
      } catch {}
      const errs = report ? validate(schema, schema, report) : ['no report']
      check(`${mode}: the report validates against schema v1`, errs.length === 0, errs.join('; '))
      check(
        `${mode}: the report states the run — mode, fixed parameters, counts, and one −3000 ms group covering every cue`,
        report?.mode === mode &&
          JSON.stringify(report?.parameters) === JSON.stringify({ fps_guessing: true, interval_ms: 1, speed_optimization: 1, split_penalty: 7 }) &&
          report.input_cue_count === 150 &&
          report.reference_cue_count === 150 &&
          report.shift_groups.reduce((n, g) => n + g.cue_count, 0) === 150 &&
          report.shift_groups.length === 1 &&
          report.shift_groups[0].delta_ms === -3000,
        JSON.stringify(report)?.slice(0, 400)
      )
    }
    const vad = runAlass(installed, ['ref.srt', '_', 'spans.srt', '--json-report', 'report-vad.json'], dir)
    let report = null
    try {
      report = readJson(path.join(dir, 'report-vad.json'))
    } catch {}
    const spans = fs.existsSync(path.join(dir, 'spans.srt')) ? fs.readFileSync(path.join(dir, 'spans.srt'), 'utf8').split(/\r?\n\r?\n/).filter((b) => b.includes('-->')).length : -1
    check('vad_export: the report validates and counts the spans it wrote', vad.status === 0 && report && validate(schema, schema, report).length === 0 && report.mode === 'vad_export' && report.reference_span_count === spans && spans > 0, `${vad.status} spans ${spans} ${JSON.stringify(report)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── Rebuild identity ───────────────────────────────────────────────────────────────────────────
if (flag('--rebuild')) {
  console.log('\nrebuild')
  const out = scratch('rebuild')
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'build-alass.ps1'), '-OutDir', out], { encoding: 'utf8', maxBuffer: 1 << 26 })
    const exe = path.join(out, 'alass.exe')
    check('a fresh build from the vendored source in a new folder is byte-identical to the installed executable', r.status === 0 && fs.existsSync(exe) && fs.existsSync(installed) && shaFile(exe) === shaFile(installed), (r.stdout + r.stderr).slice(-600))
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}

// ── E63 parity ─────────────────────────────────────────────────────────────────────────────────
if (flag('--parity')) {
  console.log('\nparity')
  const baseline = path.join(repo, '.secrets', 'ALASS', 'benchmark', 'results.json')
  if (!fs.existsSync(baseline)) {
    fail('E63 parity', 'the private benchmark baseline is not on this machine')
  } else {
    const ffdir = option('--parity-ffmpeg', null)
    const work = path.join(repo, '.secrets', 'ALASS', `ng-parity-${ffdir ? 'ffmpeg-' + path.basename(ffdir) : 'official'}-${Date.now()}`)
    const env = { ...process.env, ALASS_EXE: installed, ALASS_BENCH_WORK: work, PYTHONIOENCODING: 'utf-8' }
    if (ffdir) Object.assign(env, { FFMPEG: path.join(ffdir, 'ffmpeg.exe'), FFPROBE: path.join(ffdir, 'ffprobe.exe') })
    const r = spawnSync('python', [path.join(repo, '.cursor', 'tools', 'alass_benchmark.py'), '--parity-baseline', baseline], { cwd: repo, env, encoding: 'utf8', maxBuffer: 1 << 28 })
    let pr = null
    try {
      pr = readJson(path.join(work, 'parity_receipt.json'))
    } catch {}
    console.log(`        work folder ${path.relative(repo, work)}${ffdir ? `; ffmpeg from ${ffdir}` : '; official-bundle ffmpeg'}`)
    check(
      `E63 parity: ${PARITY_ROWS}/${PARITY_ROWS} rows match the baseline and every repeat is byte-identical`,
      r.status === 0 && pr?.pass === true && pr.baseline_alass_rows === PARITY_ROWS && pr.candidate_alass_rows === PARITY_ROWS && pr.mismatches.length === 0 && pr.candidate_repeatability_all_byte_identical === true,
      pr ? JSON.stringify({ rows: [pr.baseline_alass_rows, pr.candidate_alass_rows], mismatches: pr.mismatches.slice(0, 5), repeat: pr.candidate_repeatability_all_byte_identical }) : (r.stdout + r.stderr).slice(-600)
    )
  }
}

// ── Simulated clean machine ────────────────────────────────────────────────────────────────────
/**
 * Starts one program with an emptied environment (only Windows folders on PATH) and records every
 * module the process has loaded, sampled until it exits. The sampler is PowerShell because Node cannot
 * list another process's modules.
 */
const SAMPLER = `
$ErrorActionPreference = 'Stop'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:NG_EXE; $psi.Arguments = $env:NG_ARGS; $psi.WorkingDirectory = $env:NG_CWD
$psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$keep = [ordered]@{ SystemRoot = $env:SystemRoot; PATH = "$env:SystemRoot\\System32;$env:SystemRoot"; TEMP = $env:NG_TEMP; TMP = $env:NG_TEMP }
if ($env:NG_FF) { $keep.ALASS_FFMPEG_PATH = $env:NG_FF; $keep.ALASS_FFPROBE_PATH = $env:NG_FP }
$psi.EnvironmentVariables.Clear(); foreach ($k in $keep.Keys) { $psi.EnvironmentVariables[$k] = $keep[$k] }
$p = [System.Diagnostics.Process]::Start($psi)
$o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
$mods = @{}; $samples = 0
while (-not $p.HasExited) {
  try { $p.Refresh(); foreach ($m in $p.Modules) { $mods[$m.FileName.ToLowerInvariant()] = 1 }; $samples++ } catch {}
  Start-Sleep -Milliseconds 10
}
$p.WaitForExit()
[pscustomobject]@{ exit = $p.ExitCode; samples = $samples; modules = @($mods.Keys | Sort-Object); env = @($keep.Keys) } | ConvertTo-Json -Compress
`
const quoteArg = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
const sampled = (exe, args, cwd, tools) => {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', SAMPLER], {
    encoding: 'utf8',
    maxBuffer: 1 << 24,
    timeout: 600000,
    env: { ...process.env, NG_EXE: exe, NG_ARGS: args.map(quoteArg).join(' '), NG_CWD: cwd, NG_TEMP: cwd, NG_FF: tools?.ffmpeg ?? '', NG_FP: tools?.ffprobe ?? '' }
  })
  try {
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop())
  } catch {
    return { exit: -1, samples: 0, modules: [], error: (r.stderr || r.stdout || '').slice(-400) }
  }
}
if (cleanMachineZip) {
  console.log('\nclean machine \u2014 SIMULATED (a fresh folder on this computer, not a separate computer)')
  const out = { simulation: true, means: 'fresh folder; the program runs with an emptied environment whose PATH is only the Windows folders; modules sampled while it runs', zip: path.basename(cleanMachineZip), zipSha256: shaFile(cleanMachineZip), systemRoot }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-clean-machine-'))
  try {
    const x = spawnSync(unit.path7za(), ['x', '-y', `-o${root}`, cleanMachineZip], { encoding: 'utf8', maxBuffer: 1 << 26 })
    check('the release ZIP unpacks into a new, empty folder', x.status === 0, x.stderr)
    const app = path.join(root, unit.alassArchivePrefix(unit.listArchiveFiles(cleanMachineZip)))
    try {
      out.unitFiles = unit.verifyAlassUnit(app, unit.currentAlassManifest(repo)).files
      pass(`the unpacked copy holds the complete unit (${out.unitFiles} files), each byte-identical to the manifest`)
    } catch (e) {
      fail('the unpacked copy holds the complete unit', e.message)
    }
    const exe = path.join(app, ...unit.ALASS_UNIT.exe.split('/'))
    const bin = path.join(app, 'resources', 'bin')
    const tools = { ffmpeg: path.join(bin, 'ffmpeg.exe'), ffprobe: path.join(bin, 'ffprobe.exe') }
    const work = fs.mkdtempSync(path.join(root, 'work-'))
    const v = runAlass(exe, ['--version'], work)
    check('the unpacked alass.exe starts with only Windows folders on PATH and reports alass-cli 2.0.0', v.status === 0 && v.stdout.trim() === receipt.executable.versionLine, `${v.status} ${v.stdout}${v.stderr}`)

    const ref = Array.from({ length: 150 }, (_, i) => ({ s: 2000 + i * 4000 + ((i * 37) % 900), e: 2000 + i * 4000 + ((i * 37) % 900) + 1500 + ((i * 53) % 1200) }))
    fs.writeFileSync(path.join(work, 'ref.srt'), srt(ref))
    fs.writeFileSync(path.join(work, 'inc.srt'), srt(ref.map((c) => ({ s: c.s + 3000, e: c.e + 3000 }))))
    const align = sampled(exe, ['ref.srt', 'inc.srt', 'out.srt', '--split-penalty', '7', '--speed-optimization', '1', '--interval', '1', '--json-report', 'out.json'], work)
    let rep = null
    try {
      rep = readJson(path.join(work, 'out.json'))
    } catch {}
    check('standalone: it aligns a subtitle pair from the unpacked folder (one \u22123000 ms group, 150 cues)', align.exit === 0 && rep?.shift_groups?.length === 1 && rep.shift_groups[0].delta_ms === -3000 && rep.input_cue_count === 150, JSON.stringify({ exit: align.exit, error: align.error, groups: rep?.shift_groups }))

    const media = path.join(work, 'media.wav')
    const g = spawnSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=1200:c=pink:a=0.25', '-ac', '1', '-ar', '16000', media], { env: bareEnv(), encoding: 'utf8' })
    const vad = sampled(exe, [media, '_', 'speech.srt', '--json-report', 'speech.json'], work, tools)
    let vrep = null
    try {
      vrep = readJson(path.join(work, 'speech.json'))
    } catch {}
    check('standalone: it reads a 20-minute recording through the unpacked FFmpeg pair and exports its speech spans', g.status === 0 && vad.exit === 0 && vrep?.mode === 'vad_export' && Number.isInteger(vrep.reference_span_count), JSON.stringify({ ffmpeg: g.status, exit: vad.exit, error: vad.error, report: vrep }))

    const exeLower = exe.toLowerCase()
    const sysPrefix = `${systemRoot.toLowerCase()}\\`
    const modules = [...new Set([...align.modules, ...vad.modules])].sort()
    const foreign = modules.filter((m) => m !== exeLower && !m.startsWith(sysPrefix))
    out.samples = { align: align.samples, vad: vad.samples }
    out.childEnvironment = vad.env
    out.modules = modules.map((m) => (m === exeLower ? '<unpacked>\\resources\\bin\\alass\\2.0.0\\alass.exe' : m))
    check(`while running it loaded only Windows' own modules (${modules.length - 1} from ${systemRoot}, sampled ${align.samples}+${vad.samples} times)`, align.samples > 0 && vad.samples > 0 && modules.includes(exeLower) && foreign.length === 0, foreign.join(', ') || JSON.stringify(out.samples))
  } catch (e) {
    fail('the simulated clean-machine run completes', e.message)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  out.removedAfterwards = !fs.existsSync(root)
  console.log(`\nRECEIPT ${JSON.stringify(out)}`)
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed ? 1 : 0)
