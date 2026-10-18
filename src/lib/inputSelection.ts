import type { SubtitleTrack } from '../../electron/shared/types'

/**
 * What an accepted source pick decides, for the Translate video and the Transcribe media fields.
 *
 * Browse and drop both end in one page callback, so these are the only rules either route can
 * reach. They are pure so the transitions can be exercised without React; the pages still own
 * every piece of state and apply what these return.
 */

/** English first, otherwise the first text track; none when the video has only image tracks. */
export function defaultTrackIndex(tracks: readonly SubtitleTrack[]): number | null {
  const text = tracks.filter((x) => !x.isImage)
  if (text.length === 0) return null
  const eng = text.find((x) => x.lang === 'en')
  return (eng ?? text[0]).index
}

/**
 * The Transcribe output a source implies: `<source-stem>.srt`, but only while no output is set.
 * Null means leave the output alone — an output the user already has survives a source change.
 */
export function derivedOutputFor(mediaFile: string, outputFile: string): string | null {
  if (!mediaFile || outputFile) return null
  return mediaFile.replace(/\.[^.]+$/, '') + '.srt'
}

/** The page's own setters, called in this order by one video pick. */
export interface VideoPickSteps {
  /** Show the new path and the scanning clock; forget the previous video's tracks and choice. */
  begin(path: string): void
  /** The probe finished for the video still selected. */
  apply(tracks: SubtitleTrack[]): void
  /** The scan is over for the video still selected, whether the probe succeeded or threw. */
  settle(): void
}

/**
 * One accepted video, epoch-fenced. A later pick or Clear bumps `epoch`, so a slow probe of the
 * earlier video can neither overwrite the newer tracks nor end the newer scan's clock.
 */
export async function selectVideoSource(
  path: string,
  epoch: { current: number },
  probe: (path: string) => Promise<SubtitleTrack[]>,
  steps: VideoPickSteps
): Promise<void> {
  const mine = ++epoch.current
  steps.begin(path)
  try {
    const tracks = await probe(path)
    if (mine !== epoch.current) return
    steps.apply(tracks)
  } finally {
    if (mine === epoch.current) steps.settle()
  }
}
