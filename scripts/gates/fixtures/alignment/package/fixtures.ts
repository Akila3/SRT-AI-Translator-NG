/**
 * R13.8 fixtures: the ALASS release unit as packaging lays it out.
 *
 * `stageApp` builds the Windows extra-resource/extra-file layout of an unpacked app by reading
 * package.json's own `build` copy rules, so a changed rule changes what the gates see. Files over
 * `LINK_OVER` bytes (FFmpeg, FFprobe) are hard-linked rather than copied and are never edited;
 * every damage helper replaces a file instead of writing into it, so a link can never reach the
 * repository's copy. The real electron-builder run and the simulated clean machine are receipts in
 * gate_ledger.md §5g.8, not gates: they need a full packaging run.
 */
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'

export interface ArchiveEntry {
  Path: string
}

export interface PackContext {
  electronPlatformName: string
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}

export interface AlassPackHooks {
  beforePack(context: PackContext, run?: () => void): Promise<void>
  afterPack(context: PackContext, repoRoot?: string): Promise<void>
  afterAllArtifactBuild(result: { artifactPaths: string[] }, repoRoot?: string): Promise<void>
}

export interface PackVerify {
  ALASS_UNIT: { version: string; exe: string; source: string; licences: string; manifest: string; roots: string[] }
  alass: AlassPackHooks
  expectedAlassUnit(repoRoot?: string): { component: string; version: string; files: { path: string; sha256: string; bytes: number }[] }
  alassManifestText(repoRoot?: string): string
  currentAlassManifest(repoRoot?: string): string
  verifyAlassUnit(appRoot: string, manifestText: string): { files: number }
  verifyAlassArchive(archive: string, manifestText: string): { files: number }
  verifyPackedArchive(archive: string): { media: { binary: string; path: string; bytes: number }[]; files: number }
  verifyNoAlassBinary(binDir: string): void
  listArchiveFiles(archive: string): ArchiveEntry[]
  path7za(): string
}

export const REPO = process.cwd()

export function loadVerify(): PackVerify {
  return createRequire(path.join(REPO, 'package.json'))('./scripts/electron-builder-verify.cjs') as PackVerify
}

/** Root `LICENSE` as it stands at R13.8: the MIT text, unchanged by the sidecar. */
export const ROOT_LICENSE_SHA256 = '80c9d572ec1a41cf16b19d5d750207e548ddccf5c1b61189eabf0778708d7454'

const LINK_OVER = 8 * 1024 * 1024

export const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

interface CopyRule {
  from: string
  to?: string
  filter?: string[]
}

export interface BuildRules {
  extraResources: CopyRule[]
  winExtraResources: CopyRule[]
  extraFiles: CopyRule[]
  macExtraResources?: CopyRule[]
  linuxExtraResources?: CopyRule[]
}

export function buildRules(): BuildRules {
  const b = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).build
  return {
    extraResources: b.extraResources ?? [],
    winExtraResources: b.win?.extraResources ?? [],
    extraFiles: b.extraFiles ?? [],
    macExtraResources: b.mac?.extraResources,
    linuxExtraResources: b.linux?.extraResources
  }
}

/** The subset of electron-builder's file patterns these rules use: `*`, `**`, and a leading `!`. */
function globRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function selected(rel: string, filter: string[] | undefined): boolean {
  if (!filter?.length) return true
  let take = false
  for (const f of filter) {
    if (f.startsWith('!')) {
      if (globRe(f.slice(1)).test(rel)) take = false
    } else if (globRe(f).test(rel)) take = true
  }
  return take
}

function walk(root: string): string[] {
  const out: string[] = []
  const go = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) go(p)
      else out.push(path.relative(root, p).split(path.sep).join('/'))
    }
  }
  go(root)
  return out.sort()
}

function place(src: string, dst: string, big: 'link' | 'skip'): void {
  const size = fs.statSync(src).size
  if (size > LINK_OVER && big === 'skip') return
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  if (size > LINK_OVER) {
    try {
      fs.linkSync(src, dst)
      return
    } catch {
      /* another volume: copy */
    }
  }
  fs.copyFileSync(src, dst)
}

/** Lay out what a Windows build puts beside the app, by package.json's own rules. */
export function stageApp(appRoot: string, opts: { big?: 'link' | 'skip' } = {}): string {
  const big = opts.big ?? 'link'
  const rules = buildRules()
  const apply = (rule: CopyRule, base: string): void => {
    const from = path.join(REPO, rule.from)
    const to = path.join(base, rule.to ?? rule.from)
    if (fs.statSync(from).isFile()) {
      place(from, to, big)
      return
    }
    for (const rel of walk(from)) if (selected(rel, rule.filter)) place(path.join(from, rel), path.join(to, rel), big)
  }
  for (const r of [...rules.extraResources, ...rules.winExtraResources]) apply(r, path.join(appRoot, 'resources'))
  for (const r of rules.extraFiles) apply(r, appRoot)
  return appRoot
}

/** Replace a file's bytes without writing through a hard link. */
export function replaceFile(file: string, bytes: Buffer | string): void {
  fs.rmSync(file, { force: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}

export function flipByte(file: string, at = 4096): void {
  const b = Buffer.from(fs.readFileSync(file))
  b[at] ^= 0xff
  replaceFile(file, b)
}

/** SHA-256 of every file under a folder, by relative path: a whole-tree fingerprint. */
export function treeHash(root: string): string {
  const h = createHash('sha256')
  for (const rel of walk(root)) h.update(rel).update('\0').update(sha(path.join(root, rel))).update('\n')
  return h.digest('hex')
}

/** Zip a staged app folder the way a portable release is zipped: its contents at the archive root. */
export function zipApp(appRoot: string, zipPath: string, z7: string): number {
  const r = spawnSync(z7, ['a', '-tzip', '-mx=1', zipPath, '.\\*'], { cwd: appRoot, encoding: 'utf8', windowsHide: true })
  return r.status ?? -1
}

export const winContext = (appOutDir: string): PackContext => ({ electronPlatformName: 'win32', appOutDir, packager: { appInfo: { productFilename: 'App' } } })
export const linuxContext = (appOutDir: string): PackContext => ({ electronPlatformName: 'linux', appOutDir, packager: { appInfo: { productFilename: 'App' } } })

/** Each kind of damaged unit packaging must refuse, with the words its refusal must contain. */
export type Damage = { name: string; apply(appRoot: string, unit: PackVerify['ALASS_UNIT']): void; says: RegExp }

export const DAMAGES: Damage[] = [
  { name: 'another build of alass.exe', apply: (a, u) => flipByte(path.join(a, u.exe)), says: /alass\.exe differs from the unit manifest/ },
  { name: 'a changed source file', apply: (a, u) => replaceFile(path.join(a, u.source, 'source', 'alass-core', 'src', 'lib.rs'), '// changed\n'), says: /source\/alass-core\/src\/lib\.rs differs/ },
  { name: 'a missing source file', apply: (a, u) => fs.rmSync(path.join(a, u.source, 'source', 'Cargo.lock')), says: /source\/Cargo\.lock is missing/ },
  { name: 'an extra file in the unit', apply: (a, u) => replaceFile(path.join(a, u.source, 'notes.txt'), 'x'), says: /corresponding-source\/notes\.txt is not part of this release/ },
  { name: 'a second ALASS version beside it', apply: (a, u) => replaceFile(path.join(a, 'resources', 'bin', 'alass', '1.9.0', 'alass.exe'), fs.readFileSync(path.join(a, u.exe))), says: /alass\/1\.9\.0\/alass\.exe is not part of this release/ },
  { name: 'a missing dependency licence', apply: (a, u) => fs.rmSync(path.join(a, u.licences, 'rust-dependencies.txt')), says: /rust-dependencies\.txt is missing/ },
  { name: 'another version\u2019s report schema', apply: (a, u) => replaceFile(path.join(a, u.source, 'report-schema-v1.json'), '{"$id":"v2"}\n'), says: /report-schema-v1\.json differs/ },
  { name: 'a changed unit manifest', apply: (a, u) => replaceFile(path.join(a, u.manifest), fs.readFileSync(path.join(a, u.manifest), 'utf8').replace('"fileCount"', '"fileCount2"')), says: /UNIT-MANIFEST\.json is missing or is not this release/ },
  { name: 'a stray ALASS executable elsewhere', apply: (a, u) => replaceFile(path.join(a, 'resources', 'alass.exe'), fs.readFileSync(path.join(a, u.exe))), says: /an ALASS executable outside the unit: resources\/alass\.exe/ },
  { name: 'a missing GPL text', apply: (a, u) => fs.rmSync(path.join(a, u.licences, 'GPL-3.0.txt')), says: /GPL-3\.0\.txt is missing/ }
]
