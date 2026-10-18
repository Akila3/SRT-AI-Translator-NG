import type { SubtitleTrack } from '../../electron/shared/types'

/**
 * What this app proposes to call a file it writes next to the user's media.
 *
 * There is one convention — `<source file's name>_<what it is>.<ext>` — and until now it
 * existed twice: the translated-subtitle save built it by hand, while track extraction
 * invented its own scheme (`subtitle_he.sup`). The second only looked right because
 * extraction was reachable for exactly one track, the one whose language equalled the target,
 * where "the target language" and "this track's language" are equal by definition. Opening
 * extraction to every track (REP-8) is precisely what turns that shortcut into a wrong
 * filename, so the two must land together — hence one helper rather than a second copy.
 *
 * Nothing here risks data. The save dialog always shows the proposed name and the OS prompts
 * before overwriting; this is about proposing something sensible.
 */

/** The file's own name, with its directory and its extension removed. */
export function fileStem(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  return name.replace(/\.[^.]+$/, '')
}

/** `<stem>_<suffix><ext>`, falling back to a neutral stem when there is no source path. */
export function companionName(sourcePath: string, suffix: string, ext: string): string {
  return `${fileStem(sourcePath) || 'subtitle'}_${suffix}${ext}`
}

/**
 * What distinguishes this track from the others in the same file.
 *
 * The language, normally. Two cases need more:
 *
 * - **An untagged track** would otherwise produce a name ending `_.sup`. The panel already
 *   shows `—` for these, so the index is the only thing that identifies it.
 * - **Two tracks sharing a language AND a type** — two English PGS streams, full and SDH,
 *   which Blu-ray remuxes commonly carry — would propose the same name. Only that narrow
 *   case needs the index: a text track and an image track never collide, because the
 *   extension already separates `movie_en.srt` from `movie_en.sup`.
 *
 * The first such track keeps the plain name and later ones carry their index, so the ordinary
 * single-track-per-language file is unaffected.
 */
function trackSuffix(track: SubtitleTrack, tracks: readonly SubtitleTrack[]): string {
  if (!track.lang) return `track${track.index}`
  const alike = tracks.filter((t) => t.lang === track.lang && t.isImage === track.isImage)
  const isFirst = alike.length === 0 || alike[0].index === track.index
  return isFirst ? track.lang : `${track.lang}_${track.index}`
}

/**
 * The proposed filename for an extracted subtitle track.
 *
 * The language comes from the **track**, never from the target language: that substitution is
 * exactly the latent bug REP-8 predicted, where an English PGS stream would be saved as
 * `movie_he.sup` for no better reason than Hebrew being what the user was translating into.
 */
export function extractedTrackName(
  videoFile: string,
  track: SubtitleTrack,
  tracks: readonly SubtitleTrack[]
): string {
  return companionName(videoFile, trackSuffix(track, tracks), track.isImage ? '.sup' : '.srt')
}
