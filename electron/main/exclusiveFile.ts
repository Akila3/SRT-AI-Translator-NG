import fs from 'fs'

/**
 * Create a file without ever destroying one that is already there.
 *
 * Two paths in this app write to names DERIVED from a name the user chose, rather than to the name
 * itself: a transcription's console log sits beside the subtitle destination, and every translation
 * sidecar is copied beside the saved subtitle. The save dialog obtains overwrite consent for the
 * subtitle and for nothing else, so both paths could silently replace a file the user still wanted
 * — a console log from the previous run being the obvious casualty (validator findings SOL-08,
 * SOL-12).
 *
 * `'wx'` and `COPYFILE_EXCL` are what make this safe rather than merely careful: both fail when the
 * target exists instead of truncating it, so there is no gap between the check and the write in
 * which something else could create the file.
 */

/**
 * How many `-2`, `-3`, … names are tried before falling back to a unique token.
 *
 * The numbered form is for humans — `episode-2.console.log` beside `episode.console.log` reads as
 * the obvious thing — and stepping through it forever would be a lot of `openSync` calls for a
 * directory somebody has clearly stopped tidying. Past this point correctness matters more than a
 * tidy name, which is why the fallback cannot run out (SOL-13).
 */
const NUMBERED_ATTEMPTS = 20

let uniqueSeq = 0

/**
 * The nth candidate name, given a preferred one and the suffix that must be preserved.
 *
 * The suffix is passed in rather than derived, because these are COMPOUND: `path.extname()` reduces
 * `.console.log` to `.log` and `.tokens.json` to `.json`, and inserting the counter in the wrong
 * place would produce `episode.console-2.log` — a name that no longer ends in `.console.log` and is
 * therefore invisible to `findConsoleLog()` and to the sidecar suffix table.
 *
 * `n === 1` is the preferred name unchanged, so the ordinary case is untouched.
 *
 * `separator` is `-` for sidecars (`episode-2.console.log`). A transcription partial steps with `.`
 * (`episode.partial.2.srt`, implementation_plan.md §4.1a rule 5): its counter sits inside the
 * compound name, so it is stepped with `suffix` `.srt` on the preferred `episode.partial.srt`.
 */
export function nthCandidate(preferred: string, suffix: string, n: number, separator = '-'): string {
  if (n <= 1) return preferred
  const stem = preferred.endsWith(suffix) ? preferred.slice(0, -suffix.length) : preferred
  if (n <= NUMBERED_ATTEMPTS) return `${stem}${separator}${n}${suffix}`
  // Unbounded, and unique within this process: a name nobody has to read is better than no file.
  uniqueSeq += 1
  return `${stem}${separator}${Date.now().toString(36)}${uniqueSeq}${suffix}`
}

/**
 * How many candidates to try before giving up entirely.
 *
 * Only reached when every attempt fails for a reason OTHER than the name being taken — a read-only
 * directory, say — in which case a few tries have already established that stepping the name will
 * not help.
 */
const MAX_ATTEMPTS = NUMBERED_ATTEMPTS + 5

/**
 * Open a new file for writing, stepping the name until one is free.
 *
 * Returns null only when the directory itself will not accept a file, which is not a name problem
 * and not something more attempts can fix.
 */
export function openExclusive(
  preferred: string,
  suffix: string
): { fd: number; path: string } | null {
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const candidate = nthCandidate(preferred, suffix, n)
    try {
      return { fd: fs.openSync(candidate, 'wx'), path: candidate }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null
    }
  }
  return null
}

/**
 * Copy a file to a name that is free, and say where it went.
 *
 * The returned path is the point: the caller cannot assume the destination it asked for, so
 * anything that later names the file — the panel telling the user what was written beside their
 * subtitle — has to be told rather than derive it.
 */
export function copyExclusive(src: string, preferred: string, suffix: string): string | null {
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const candidate = nthCandidate(preferred, suffix, n)
    // Remembered so a failed copy does not delete a stranger's file. COPYFILE_EXCL should
    // report EEXIST when the name is taken, but Windows can surface EPERM on a locked dest
    // instead; unlinking then would be SOL-22's partial cleanup eating the wrong bytes.
    let existed = false
    try {
      existed = fs.existsSync(candidate)
    } catch {
      existed = false
    }
    try {
      fs.copyFileSync(src, candidate, fs.constants.COPYFILE_EXCL)
      return candidate
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      if (!existed) {
        try {
          fs.unlinkSync(candidate)
        } catch {
          /* partial we created, or never created */
        }
      }
      return null
    }
  }
  return null
}

/**
 * Move an existing file to a free stepped name, without destroying anything.
 *
 * Kept as a tested primitive (G11e). The save handler no longer calls it: Transcribe uses the
 * same dialog as a destination picker, so a rename-on-existing-path mutated files nobody had
 * agreed to move (SOL-17), and even on a real save the dialog named only the subtitle (SOL-12).
 * Leftover canonicals are now reported, not renamed.
 *
 * The empty `'wx'` create is what makes this exclusive on POSIX, where `rename` would otherwise
 * replace the destination silently. Windows already refuses to rename onto an existing name.
 */
export function displaceExclusive(preferred: string, suffix: string): string | null {
  try {
    if (!fs.existsSync(preferred)) return null
  } catch {
    return null
  }
  for (let n = 2; n <= MAX_ATTEMPTS; n++) {
    const candidate = nthCandidate(preferred, suffix, n)
    try {
      const fd = fs.openSync(candidate, 'wx')
      fs.closeSync(fd)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      return null
    }
    try {
      fs.renameSync(preferred, candidate)
      return candidate
    } catch {
      try {
        fs.unlinkSync(candidate)
      } catch {
        /* the placeholder is empty and not the user's file */
      }
    }
  }
  return null
}

/** Write new content to a name that is free, for the one sidecar that is rewritten not copied. */
export function writeExclusive(
  content: string,
  preferred: string,
  suffix: string
): string | null {
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const candidate = nthCandidate(preferred, suffix, n)
    let fd: number | undefined
    let created = false
    try {
      fd = fs.openSync(candidate, 'wx')
      created = true
      fs.writeFileSync(fd, content, 'utf-8')
    } catch (e) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          /* still need to drop a partial */
        }
        fd = undefined
      }
      if (created) {
        try {
          fs.unlinkSync(candidate)
        } catch {
          /* best effort — leftoverCanonicals must not see our failed create as an older file */
        }
      }
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      return null
    }
    try {
      if (fd !== undefined) fs.closeSync(fd)
    } catch {
      /* content is on disk */
    }
    return candidate
  }
  return null
}
