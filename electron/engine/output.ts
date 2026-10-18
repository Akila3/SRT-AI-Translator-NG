/**
 * The run's subtitle on disk: the partial lifecycle and the one same-directory replacement
 * primitive (implementation_plan.md §4.1a). AUTHORED-BY: opus-5.5-high
 *
 * Native transcription writes as it goes (register A2), which makes it the first NG path that can
 * leave a partial behind. `CARRY_FORWARD.md` §4 forbids presenting one as complete, so:
 *
 *  1. Incremental writes go to `<name>.partial.srt` beside the destination. The destination itself
 *     does not exist until the run succeeds — its absence is the signal that nothing completed.
 *  2. Every flush is atomic: the whole snapshot goes to a per-run scratch file in the same
 *     directory, is fsync'd, and is renamed over the partial. The partial is never open for writing,
 *     so at any instant it is the previous complete snapshot or the new one. A rename that a scanner
 *     or a player blocks (`EPERM`/`EBUSY`) is retried briefly; if it still fails both files are kept
 *     and the run carries on — failing forward costs the newest chunk, the other way costs all.
 *  3. Promotion is success-only: a final flush, then an atomic replace of the destination with the
 *     run's epoch checked immediately before it. Old-or-new, never a half-written copy, and no
 *     copy-overwrite fallback.
 *  4. On failure or stop the partial stays under its partial name and `finished.partialPath` names
 *     it — set only once a complete snapshot has been fsync'd and renamed into place. A complete
 *     snapshot whose rename kept failing is taken back out of the run's scratch the moment the rename
 *     fails and is never reopened (the next flush writes a fresh scratch), so no ending — failure,
 *     Stop or shutdown — and no later torn write destroys it (§4.1a rule 2: never delete the scratch
 *     to clean up after a failed replace). It is removed only once a newer complete snapshot lands or
 *     is kept instead. With no partial landed, `partialPath` names it.
 *  5. The partial name is claimed with an exclusive create on the first flush. A name already taken
 *     — a previous run's retained partial — is stepped around (`.partial.2.srt`, …), never
 *     overwritten. A completed run removes only its own partial, by promoting it.
 *  7. A partial is never read back here. Nothing in this module opens one for reading, and a partial
 *     on disk is not resume state by itself: only `main/resumeStore.ts` reads one back, and only
 *     against a checkpoint whose recorded digest it must match (Phase 3, AR3-5).
 *
 * The scratch file lives in the destination directory because a rename is atomic only within one
 * filesystem. It is registered with the run's scratch lifetime (runner.ts invariant 1).
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { nthCandidate } from '../main/exclusiveFile'

export const PARTIAL_SUFFIX = '.partial.srt'

/** Partial names tried before giving up; past the numbered ones `nthCandidate` cannot run out. */
const CLAIM_ATTEMPTS = 25

/** Brief: a scanner lets go in milliseconds, and a run must not hang on a player that never will. */
export const REPLACE_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800]

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** The filesystem calls this module makes. Injectable so the fault gates can fail each one. */
export interface OutputIo {
  open(file: string, flags: 'wx' | 'w'): number
  write(fd: number, text: string): void
  fsync(fd: number): void
  close(fd: number): void
  rename(from: string, to: string): void
  unlink(file: string): void
  sleep(ms: number): Promise<void>
}

export const NODE_OUTPUT_IO: OutputIo = {
  open: (file, flags) => fs.openSync(file, flags),
  write: (fd, text) => fs.writeFileSync(fd, text, 'utf-8'),
  fsync: (fd) => fs.fsyncSync(fd),
  close: (fd) => fs.closeSync(fd),
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (file) => fs.unlinkSync(file),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/** `<dir>/<name>.partial.srt` for a destination `<dir>/<name>.<ext>`. */
export function partialPathFor(dest: string): string {
  const parsed = path.parse(dest)
  return path.join(parsed.dir, `${parsed.name}${PARTIAL_SUFFIX}`)
}

/** The nth partial name: the canonical one, then `<name>.partial.2.srt`, `.3.srt`, … */
export function partialCandidate(dest: string, n: number): string {
  return nthCandidate(partialPathFor(dest), '.srt', n, '.')
}

function codeOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code
}

function messageOf(e: unknown): string {
  const code = codeOf(e)
  const text = e instanceof Error ? e.message : String(e)
  return code && !text.includes(code) ? `${code}: ${text}` : text
}

export type ReplaceResult =
  | { ok: true; attempts: number }
  | { ok: false; reason: 'superseded' | 'refused' | 'failed'; code?: string; message: string; attempts: number }

/**
 * Atomically replace `to` with `from`, both in one directory.
 *
 * Old-or-new: `rename` replaces an existing destination in one step (`MoveFileEx` with
 * `MOVEFILE_REPLACE_EXISTING` on Windows), so a reader sees the old file or the complete new one.
 * A transient refusal is retried on `REPLACE_RETRY_DELAYS_MS`; anything else, or exhausting them, is
 * a failure that leaves both files exactly as they were. There is deliberately no copy fallback — a
 * copy over the destination is the half-written state this exists to rule out. `isCurrent` is
 * checked immediately before every attempt (§2.2a): a run that has ended must not commit. `verify`
 * runs right after it, retries included: a message refuses the replacement and leaves both files.
 */
export async function replaceFile(
  from: string,
  to: string,
  opts: { io?: Partial<OutputIo>; isCurrent?: () => boolean; verify?: () => string | null } = {}
): Promise<ReplaceResult> {
  const io = { ...NODE_OUTPUT_IO, ...opts.io }
  for (let attempt = 1; ; attempt++) {
    if (opts.isCurrent && !opts.isCurrent()) {
      return { ok: false, reason: 'superseded', message: 'The run ended before its output was committed.', attempts: attempt - 1 }
    }
    const refusal = opts.verify ? opts.verify() : null
    if (refusal !== null) return { ok: false, reason: 'refused', message: refusal, attempts: attempt - 1 }
    try {
      io.rename(from, to)
      return { ok: true, attempts: attempt }
    } catch (e) {
      const code = codeOf(e)
      const delay = REPLACE_RETRY_DELAYS_MS[attempt - 1]
      if (code && TRANSIENT_RENAME_CODES.has(code) && delay !== undefined) {
        await io.sleep(delay)
        continue
      }
      return { ok: false, reason: 'failed', ...(code ? { code } : {}), message: messageOf(e), attempts: attempt }
    }
  }
}

export type FlushStage = 'claim' | 'open' | 'write' | 'fsync' | 'rename'

export type FlushResult = { ok: true; path: string } | { ok: false; stage: FlushStage; message: string }

export type PromoteResult =
  | { ok: true; path: string }
  | { ok: false; stage: FlushStage | 'superseded' | 'replace'; message: string }

export interface PartialOutputOptions {
  io?: Partial<OutputIo>
  /** Adds a file to the run's scratch, deleted when the job ends (runner.ts invariant 1). */
  registerScratch: (file: string) => void
  /** Takes a file back out of the run's scratch: it holds a transcript and must outlive the job. */
  releaseScratch: (file: string) => void
  /**
   * The partial's one name, claimed exclusively and never stepped around: a resumable generation's
   * own `translate.partial.srt` (AR3-5). Without it the name is `<dest>.partial[.N].srt`.
   */
  fixedPath?: string
  /**
   * A partial this run continues: already claimed and holding a verified snapshot (Phase 3 Continue).
   * It is never re-claimed, and its next snapshot replaces it atomically like any other.
   */
  adopt?: string
}

export type StageResult = { ok: true; scratch: string } | { ok: false; stage: FlushStage; message: string }

export type AtomicWriteResult = { ok: true } | { ok: false; stage: FlushStage | 'superseded'; message: string }

/**
 * Write `text` to `target` old-or-new: a fresh scratch beside it, written, fsync'd and closed, then
 * `replaceFile` over it. A torn scratch is removed; a complete one whose replace failed is left where
 * it is (§4.1a rule 2) and never reopened. The checkpoint's writer (AR3-5); one primitive, not two.
 */
export async function writeTextAtomic(
  target: string,
  text: string,
  opts: { io?: Partial<OutputIo>; isCurrent?: () => boolean } = {}
): Promise<AtomicWriteResult> {
  const io = { ...NODE_OUTPUT_IO, ...opts.io }
  const scratch = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`
  let fd: number
  try {
    fd = io.open(scratch, 'wx')
  } catch (e) {
    return { ok: false, stage: 'open', message: messageOf(e) }
  }
  const torn = (stage: FlushStage, e: unknown, closeFirst: boolean): AtomicWriteResult => {
    if (closeFirst) {
      try {
        io.close(fd)
      } catch {
        /* the target is untouched either way */
      }
    }
    try {
      io.unlink(scratch)
    } catch {
      /* a torn scratch holds nothing the target needs */
    }
    return { ok: false, stage, message: messageOf(e) }
  }
  try {
    io.write(fd, text)
  } catch (e) {
    return torn('write', e, true)
  }
  try {
    io.fsync(fd)
  } catch (e) {
    return torn('fsync', e, true)
  }
  try {
    io.close(fd)
  } catch (e) {
    return torn('write', e, false)
  }
  const replaced = await replaceFile(scratch, target, { io, ...(opts.isCurrent ? { isCurrent: opts.isCurrent } : {}) })
  if (!replaced.ok) return { ok: false, stage: replaced.reason === 'superseded' ? 'superseded' : 'rename', message: replaced.message }
  return { ok: true }
}

/** What is at a path at one instant: absent, or its identity, size, write time and — when readable — content digest. */
export type FileBaseline =
  | { exists: false }
  | { exists: true; dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; sha256: string | null }

/**
 * `file` as it stands now; `bytes`, when given, are what the caller has just read from it. Null when not
 * even its attributes can be read. A file that cannot be read has no digest, and a baseline without one
 * never matches anything: it cannot show that the file is unchanged.
 */
export function fileBaseline(file: string, bytes?: Buffer): FileBaseline | null {
  let st: fs.BigIntStats
  try {
    st = fs.statSync(file, { bigint: true })
  } catch (e) {
    return codeOf(e) === 'ENOENT' ? { exists: false } : null
  }
  let content = bytes
  if (content === undefined) {
    try {
      content = fs.readFileSync(file)
    } catch {
      content = undefined
    }
  }
  const sha256 = content === undefined ? null : crypto.createHash('sha256').update(content).digest('hex')
  return { exists: true, dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, sha256 }
}

/** The same file, unchanged: same identity, size, write time and digest. A missing digest is never a match. */
export function sameBaseline(a: FileBaseline, b: FileBaseline): boolean {
  if (!a.exists || !b.exists) return a.exists === b.exists
  return (
    a.sha256 !== null &&
    a.sha256 === b.sha256 &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs
  )
}

/**
 * A `verify` for `replaceFile`: refuses, before every attempt, once `file` is no longer what `baseline`
 * recorded — changed, replaced, removed, or created where nothing was. A retry wait must never let a
 * prepared copy overwrite bytes that arrived after it was prepared.
 */
export function unchangedSince(file: string, baseline: FileBaseline): () => string | null {
  return () => {
    const now = fileBaseline(file)
    if (now !== null && sameBaseline(baseline, now)) return null
    const name = path.basename(file)
    if (now === null) return `"${name}" could not be checked before it was replaced, so it was left as it is.`
    if (!baseline.exists) return `"${name}" was created by another program while it was waiting to be written, so it was left as it is.`
    if (!now.exists) return `"${name}" was removed by another program while it was waiting to be replaced, so nothing was written.`
    if (baseline.sha256 === null || now.sha256 === null) return `"${name}" could not be read to check it before it was replaced, so it was left as it is.`
    return `"${name}" was changed by another program while it was waiting to be replaced, so it was left as it is.`
  }
}

/** Bundle D's derivative sibling (D12-15): `<dest>.rtl-tmp`, stepped as `<dest>.2.rtl-tmp`, … */
export const RTL_TMP_SUFFIX = '.rtl-tmp'

/** The nth derivative sibling name beside `dest`; past the numbered ones `nthCandidate` cannot run out. */
export function rtlTmpCandidate(dest: string, n: number): string {
  return nthCandidate(`${dest}${RTL_TMP_SUFFIX}`, RTL_TMP_SUFFIX, n, '.')
}

export type DerivativeStage = 'claim' | 'write' | 'fsync' | 'superseded' | 'replace'

export type DerivativeResult =
  | { ok: true; path: string; attempts: number }
  | { ok: false; stage: DerivativeStage; message: string; code?: string; retainedScratch?: string }

export interface DerivativeOptions {
  io?: Partial<OutputIo>
  /** The run's epoch, checked immediately before every replace attempt (§2.2a). */
  isCurrent?: () => boolean
  /** `replaceFile`'s: a message refuses the replacement, `dest` untouched (a native release's baseline check). */
  verify?: () => string | null
  /** Adds the sibling to the run's scratch (runner.ts invariant 1); a Save or CLI caller has none. */
  registerScratch?: (file: string) => void
  /** Takes it back out once it is gone: renamed into `dest`, or deleted after a failure. */
  releaseScratch?: (file: string) => void
}

/**
 * Put `text` at `dest` old-or-new through a sibling only this call owns (Bundle D, D12-15).
 *
 * The sibling is claimed with an exclusive create and stepped around any name already taken — never
 * overwritten — then written whole, fsync'd and closed, and `replaceFile` puts it over `dest` with the
 * transient-refusal retry and the epoch check before every attempt. The canonical source (an engine
 * temp, a GST destination already read, a native partial) is never touched here, so after any failure
 * `dest` is exactly as it was, or still absent, and the sibling is disposable: it is deleted
 * best-effort, and when even that fails its path comes back on `retainedScratch` for the caller to
 * report (and stays in the run's scratch, if registered). Windows refuses a rename onto a destination
 * another program holds open, so that case ends refused with the destination whole. There is no
 * copy-overwrite fallback.
 */
export async function writeDerivative(dest: string, text: string, opts: DerivativeOptions = {}): Promise<DerivativeResult> {
  const io = { ...NODE_OUTPUT_IO, ...opts.io }
  let sibling: string | null = null
  let fd = 0
  for (let n = 1; n <= CLAIM_ATTEMPTS && sibling === null; n++) {
    const candidate = rtlTmpCandidate(dest, n)
    try {
      fd = io.open(candidate, 'wx')
      sibling = candidate
    } catch (e) {
      const code = codeOf(e)
      if (code !== 'EEXIST') return { ok: false, stage: 'claim', message: messageOf(e), ...(code ? { code } : {}) }
    }
  }
  if (sibling === null) {
    return { ok: false, stage: 'claim', message: `Could not create a temporary file beside "${path.basename(dest)}".` }
  }
  const owned = sibling
  opts.registerScratch?.(owned)
  const discard = (stage: DerivativeStage, message: string, code: string | undefined, closeFirst: boolean): DerivativeResult => {
    if (closeFirst) {
      try {
        io.close(fd)
      } catch {
        /* the destination is untouched either way */
      }
    }
    const failed = { ok: false as const, stage, message, ...(code ? { code } : {}) }
    try {
      io.unlink(owned)
    } catch {
      return { ...failed, retainedScratch: owned }
    }
    opts.releaseScratch?.(owned)
    return failed
  }
  try {
    io.write(fd, text)
  } catch (e) {
    return discard('write', messageOf(e), codeOf(e), true)
  }
  try {
    io.fsync(fd)
  } catch (e) {
    return discard('fsync', messageOf(e), codeOf(e), true)
  }
  try {
    io.close(fd)
  } catch (e) {
    return discard('write', messageOf(e), codeOf(e), false)
  }
  const replaced = await replaceFile(owned, dest, {
    io,
    ...(opts.isCurrent ? { isCurrent: opts.isCurrent } : {}),
    ...(opts.verify ? { verify: opts.verify } : {})
  })
  if (!replaced.ok) return discard(replaced.reason === 'superseded' ? 'superseded' : 'replace', replaced.message, replaced.code, false)
  opts.releaseScratch?.(owned)
  return { ok: true, path: dest, attempts: replaced.attempts }
}

/** One run's partial: claimed once, flushed atomically, then promoted or retained. */
export class PartialOutput {
  private readonly io: OutputIo
  private claimed: string | null = null
  /** True once a complete snapshot has been renamed into `claimed`. */
  private landed = false
  private scratch: string | null = null
  /** True while the scratch is in the run's scratch list, i.e. deleted when the job ends. */
  private scratchRegistered = false
  /** What the scratch file holds right now: nothing, a torn write, or a complete fsync'd snapshot. */
  private scratchHolds: 'nothing' | 'torn' | 'complete' = 'nothing'
  /**
   * A complete snapshot, newer than the partial, that could not be renamed over it. Out of the run's
   * scratch and never reopened, so neither an ending nor a later torn write can destroy it; removed
   * only once a newer complete snapshot has landed or been kept in its place.
   */
  private stranded: string | null = null
  /**
   * Bundle D: the destination's bytes when they are not the partial's — the RTL copy of its canonical
   * text. The partial keeps the canonical text; null promotes the partial itself.
   */
  private derivative: string | null = null

  constructor(
    readonly dest: string,
    private readonly opts: PartialOutputOptions
  ) {
    this.io = { ...NODE_OUTPUT_IO, ...opts.io }
    if (opts.adopt) {
      this.claimed = opts.adopt
      this.landed = true
    }
  }

  /** The claimed partial name, landed or not; null before the first flush claims one. */
  get claimedPath(): string | null {
    return this.claimed
  }

  /** The partial this run wrote — only once a complete snapshot is in it. */
  get partialPath(): string | undefined {
    return this.landed && this.claimed ? this.claimed : undefined
  }

  /** A complete snapshot left under its scratch name because its rename kept failing; it is kept. */
  get strandedSnapshot(): string | undefined {
    return this.stranded ?? undefined
  }

  /** Drop a stranded snapshot that a newer complete one has superseded. */
  private supersedeStranded(): void {
    if (!this.stranded) return
    try {
      this.io.unlink(this.stranded)
    } catch {
      /* a stale extra copy; leaving it loses nothing */
    }
    this.stranded = null
  }

  private claim(): string | null {
    if (this.opts.fixedPath) {
      try {
        this.io.close(this.io.open(this.opts.fixedPath, 'wx'))
        return this.opts.fixedPath
      } catch {
        return null
      }
    }
    for (let n = 1; n <= CLAIM_ATTEMPTS; n++) {
      const candidate = partialCandidate(this.dest, n)
      try {
        this.io.close(this.io.open(candidate, 'wx'))
        return candidate
      } catch (e) {
        if (codeOf(e) !== 'EEXIST') return null
      }
    }
    return null
  }

  /** Write the whole current snapshot and rename it over the partial (rule 2). */
  async flush(text: string): Promise<FlushResult> {
    const staged = await this.stage(text)
    if (!staged.ok) return staged
    return this.land()
  }

  /**
   * The first half of a flush: claim the partial if needed, then write the whole snapshot to the
   * scratch and fsync it. The partial is untouched until `land`. A resumable run records its intent
   * between the two (AR3-5 step 2), so a crash leaves the old snapshot or the new one, never neither.
   */
  async stage(text: string): Promise<StageResult> {
    if (!this.claimed) {
      const claimed = this.claim()
      if (!claimed) {
        return { ok: false, stage: 'claim', message: `Could not create a partial file beside "${path.basename(this.dest)}".` }
      }
      this.claimed = claimed
    }
    if (!this.scratch) this.scratch = `${this.claimed}.${crypto.randomBytes(4).toString('hex')}.tmp`
    const scratch = this.scratch
    let fd: number
    try {
      fd = this.io.open(scratch, this.scratchHolds === 'nothing' ? 'wx' : 'w')
    } catch (e) {
      return { ok: false, stage: 'open', message: messageOf(e) }
    }
    if (!this.scratchRegistered) {
      this.opts.registerScratch(scratch)
      this.scratchRegistered = true
    }
    this.scratchHolds = 'torn'
    const abandon = (stage: FlushStage, e: unknown): StageResult => {
      try {
        this.io.close(fd)
      } catch {
        /* the partial is untouched either way */
      }
      return { ok: false, stage, message: messageOf(e) }
    }
    try {
      this.io.write(fd, text)
    } catch (e) {
      return abandon('write', e)
    }
    try {
      this.io.fsync(fd)
    } catch (e) {
      return abandon('fsync', e)
    }
    try {
      this.io.close(fd)
    } catch (e) {
      return { ok: false, stage: 'write', message: messageOf(e) }
    }
    this.scratchHolds = 'complete'
    return { ok: true, scratch }
  }

  /**
   * A complete staged snapshot whose checkpointed commit failed before it landed: taken out of the run's
   * scratch and left under its own name, never landed, so the partial stays the one the record names.
   * Null when nothing complete is staged (a torn write stays scratch and is deleted with the job).
   */
  keepStaged(): string | null {
    const scratch = this.scratch
    if (!scratch || this.scratchHolds !== 'complete') return null
    this.opts.releaseScratch(scratch)
    this.scratch = null
    this.scratchRegistered = false
    this.scratchHolds = 'nothing'
    return scratch
  }

  /** The second half: rename the staged snapshot over the partial (rule 2). */
  async land(): Promise<FlushResult> {
    const scratch = this.scratch
    if (!scratch || !this.claimed || this.scratchHolds !== 'complete') {
      return { ok: false, stage: 'rename', message: 'No complete snapshot is staged.' }
    }
    const replaced = await replaceFile(scratch, this.claimed, { io: this.io })
    if (!replaced.ok) {
      // §4.1a rule 2: never delete the scratch after a failed replace. It leaves the run's scratch,
      // and the next flush writes a fresh one, so a torn rewrite cannot overwrite it either.
      this.opts.releaseScratch(scratch)
      this.supersedeStranded()
      this.stranded = scratch
      this.scratch = null
      this.scratchRegistered = false
      this.scratchHolds = 'nothing'
      return { ok: false, stage: 'rename', message: replaced.message }
    }
    this.scratchHolds = 'nothing'
    this.landed = true
    this.supersedeStranded()
    return { ok: true, path: this.claimed }
  }

  /**
   * Success only (rule 3): a final flush, then replace the destination — epoch checked immediately
   * before. On any failure the partial stays where it is and `partialPath` still names it.
   */
  async promote(text: string, isCurrent: () => boolean, verify?: () => string | null): Promise<PromoteResult> {
    const flushed = await this.flush(text)
    if (!flushed.ok) return flushed
    return this.promoteLanded(isCurrent, verify)
  }

  /**
   * Replace the destination with the partial already landed, epoch checked immediately before. A
   * resumable run lands its final snapshot and records the promotion intent before calling this
   * (AR3-5 `pendingPromotion`). `verify` is `replaceFile`'s, checked before every attempt.
   */
  async promoteLanded(isCurrent: () => boolean, verify?: () => string | null): Promise<PromoteResult> {
    if (!this.landed || !this.claimed) return { ok: false, stage: 'replace', message: 'No complete snapshot has landed.' }
    if (this.derivative !== null) return this.promoteDerivative(this.derivative, isCurrent, verify)
    const replaced = await replaceFile(this.claimed, this.dest, { io: this.io, isCurrent, ...(verify ? { verify } : {}) })
    if (!replaced.ok) {
      return replaced.reason === 'superseded'
        ? { ok: false, stage: 'superseded', message: replaced.message }
        : { ok: false, stage: 'replace', message: replaced.message }
    }
    this.claimed = null
    this.landed = false
    return { ok: true, path: this.dest }
  }

  /** Promote `text` instead of the partial's own bytes (Bundle D); null goes back to the partial itself. */
  setDerivative(text: string | null): void {
    this.derivative = text
  }

  /**
   * D12-15's native branch: the derivative is written to `dest` through its own sibling, and only once
   * it has replaced `dest` is the canonical partial removed. Any failure before that leaves the partial
   * landed — `partialPath` still names it — and `dest` as it was. A partial that cannot be removed
   * afterwards holds only the canonical text of a transcript that has been saved, so it is left.
   */
  private async promoteDerivative(text: string, isCurrent: () => boolean, verify?: () => string | null): Promise<PromoteResult> {
    const written = await writeDerivative(this.dest, text, {
      io: this.io,
      isCurrent,
      ...(verify ? { verify } : {}),
      registerScratch: this.opts.registerScratch,
      releaseScratch: this.opts.releaseScratch
    })
    if (!written.ok) {
      const kept = written.retainedScratch ? ` A temporary copy is left as "${path.basename(written.retainedScratch)}".` : ''
      return written.stage === 'superseded'
        ? { ok: false, stage: 'superseded', message: written.message + kept }
        : { ok: false, stage: 'replace', message: written.message + kept }
    }
    try {
      this.io.unlink(this.claimed as string)
    } catch {
      /* canonical bytes of a saved transcript; leaving them loses nothing */
    }
    this.claimed = null
    this.landed = false
    return { ok: true, path: this.dest }
  }

  /**
   * What a failed or stopped run leaves behind (rule 4). A complete snapshot still waiting in the
   * scratch file gets one more chance to land; if it cannot, it stays where it is (`strandedSnapshot`).
   * A claim that never received a snapshot is this run's own empty placeholder and holds nothing, so
   * it is removed; a partial with content never is. Returns the partial, or — when none landed — the
   * stranded snapshot, which is then the only copy of the transcript.
   */
  async retain(): Promise<string | undefined> {
    if (this.claimed && this.stranded) {
      const replaced = await replaceFile(this.stranded, this.claimed, { io: this.io })
      if (replaced.ok) {
        this.stranded = null
        this.landed = true
      }
    }
    if (this.claimed && !this.landed) {
      try {
        this.io.unlink(this.claimed)
      } catch {
        /* an empty file we created; leaving it costs nothing */
      }
      this.claimed = null
    }
    return this.partialPath ?? this.strandedSnapshot
  }

  /**
   * What a checkpointed run leaves behind (Phase 3, Transcribe). Only this run's own empty claim is
   * removed. A stranded snapshot is not landed: the partial must stay the snapshot the checkpoint
   * records, so the stranded copy stays where it is under its own name and is returned when no partial
   * landed. Continue re-sends the part it holds.
   */
  async retainRecorded(): Promise<string | undefined> {
    if (this.claimed && !this.landed) {
      try {
        this.io.unlink(this.claimed)
      } catch {
        /* an empty file we created; leaving it costs nothing */
      }
      this.claimed = null
    }
    return this.partialPath ?? this.strandedSnapshot
  }
}
