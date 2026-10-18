import { app } from 'electron'
import path from 'path'
import fs from 'fs'

/**
 * The app's own scratch directory, `{userData}/temp`, and the startup sweep that keeps it bounded.
 * Nothing here touches a user's source or destination, a destination-adjacent Transcribe partial, or
 * the resume store (`{userData}/resume-v1`, a sibling of this directory, never inside it).
 */

export function tempOutputPath(suffix = '.srt'): string {
  const dir = tempDir()
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${Date.now()}${suffix}`)
}

function tempDir(): string {
  return path.join(app.getPath('userData'), 'temp')
}

/** Nothing in the scratch directory is worth keeping for longer than this. */
const TEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Delete last week's scratch files, once, at startup.
 *
 * A translation's staged output and its artifacts land in this directory and deliberately OUTLIVE
 * the run: they have to still be there when the user decides to save them — the Save dialog COPIES
 * rather than moves, and New only clears React state. Nothing else ever removes them, and a console
 * alone can approach nine megabytes, so ordinary use would grow this directory without limit and
 * leave translated subtitles sitting in it indefinitely (validator finding SOL-07).
 *
 * Startup and an age test, rather than deletion at the moment of saving: at startup nothing is on
 * screen, so there is no result to pull out from under the user, and age is the one signal that
 * cannot mistake a file the user is still looking at for rubbish. Files only, and confined to our own
 * scratch directory — never the user's chosen output folder, where transcription writes and where the
 * subtitle beside their video lives.
 */
export function sweepTempDir(now = Date.now(), ttlMs = TEMP_TTL_MS): number {
  const dir = tempDir()
  let removed = 0
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    // No scratch directory yet, which is the ordinary state of a fresh install.
    return 0
  }
  for (const name of entries) {
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || now - stat.mtimeMs < ttlMs) continue
      fs.unlinkSync(file)
      removed++
    } catch {
      /* best effort: a file we cannot inspect or delete is not worth failing startup over */
    }
  }
  return removed
}

/** Subtitle formats a Translate source may name; anything else is staged as `.srt`. */
const SUBTITLE_EXTS = ['.srt', '.ass']

/** Where a translation is staged until the user saves it. The staged name keeps the input's format. */
export function translateOutputPath(inputFile: string): string {
  const inExt = path.extname(inputFile).toLowerCase()
  return tempOutputPath(SUBTITLE_EXTS.includes(inExt) ? inExt : '.srt')
}
