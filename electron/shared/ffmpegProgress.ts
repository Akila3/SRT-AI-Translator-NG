/**
 * Reading how far ffmpeg has got, from the only report it will give us.
 *
 * `-progress pipe:1` makes ffmpeg print a small block of `key=value` lines every half second
 * or so, ending in `progress=continue` — or `progress=end` on the last one. That is the whole
 * contract, and it is a good one: it is machine-readable, it is stable across versions, and it
 * goes to stdout, which none of our invocations use for anything else (every one of them
 * writes its result to a file).
 *
 * This module is pure and Electron-free for the same reason as `outputSanity.ts`: the failure
 * mode of a progress bar is a *wrong number*, which is worse than no number, and a wrong number
 * is only catchable by a test. The parts that need a process live in `main/ffmpeg.ts`.
 *
 * What this deliberately does not do is guess. An input with no known duration produces `null`
 * rather than an invented percentage, and the caller shows elapsed time instead — REP-11's
 * complaint was silence, and a fabricated bar would answer it with a lie.
 */

/** What one chunk of `-progress` output said. */
export interface ProgressChunk {
  /** Seconds of media processed, or null when the chunk carried no usable timestamp. */
  outTimeSec: number | null
  /** ffmpeg reported `progress=end`, i.e. it has finished writing. */
  ended: boolean
}

/**
 * `HH:MM:SS.micros` as seconds.
 *
 * ffmpeg writes `N/A` before it has decoded anything, which is not a time and must not be
 * read as zero: zero is a legitimate position and would show a 0% bar for a file that has
 * not started, which is indistinguishable from a stall.
 */
export function parseTimestamp(raw: string): number | null {
  const text = raw.trim()
  if (!text || text.toUpperCase() === 'N/A') return null
  const m = text.match(/^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/)
  if (!m) return null
  const hours = parseInt(m[1], 10)
  const minutes = parseInt(m[2], 10)
  const seconds = parseFloat(m[3])
  if (!Number.isFinite(seconds)) return null
  return hours * 3600 + minutes * 60 + seconds
}

/**
 * The latest position reported in a chunk of `-progress` output.
 *
 * A single stdout read can contain several blocks — the process writes faster than we read —
 * so the *last* timestamp is the current one and the earlier ones are already stale. Both
 * spellings are accepted because ffmpeg emits both, and `out_time_us` is the safer of the two:
 * its sibling `out_time_ms` has carried microseconds rather than milliseconds for years, a bug
 * preserved for compatibility, so that key is ignored here rather than trusted and divided.
 */
export function readProgressChunk(text: string): ProgressChunk {
  let outTimeSec: number | null = null
  let ended = false
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'out_time') {
      const t = parseTimestamp(value)
      if (t !== null) outTimeSec = t
    } else if (key === 'out_time_us') {
      const us = Number(value)
      if (Number.isFinite(us) && us >= 0) outTimeSec = us / 1_000_000
    } else if (key === 'progress' && value === 'end') {
      ended = true
    }
  }
  return { outTimeSec, ended }
}

/**
 * The duration ffprobe reported, in seconds.
 *
 * Tolerant on purpose: this is only ever used to turn a position into a percentage, and a
 * container that will not say how long it is should cost the user a percentage, never an
 * error. Streams and some MKV remuxes genuinely answer `N/A`.
 */
export function durationFromProbe(stdout: string): number | null {
  const text = stdout.trim()
  if (!text || /^N\/A$/im.test(text)) return null
  const m = text.match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const seconds = parseFloat(m[0])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/**
 * How far through, as a whole percentage — or null when that cannot be known.
 *
 * Capped at 99 while the process is alive. A bar that reads 100% and keeps working is the
 * exact complaint this phase exists to fix, and ffmpeg routinely reports a position at or
 * past the nominal duration near the end. The caller emits the completion itself, when the
 * process has actually exited.
 */
export function percentOf(outTimeSec: number, durationSec: number | null): number | null {
  if (durationSec === null || durationSec <= 0) return null
  if (!Number.isFinite(outTimeSec) || outTimeSec < 0) return null
  return Math.max(0, Math.min(99, Math.floor((outTimeSec / durationSec) * 100)))
}
