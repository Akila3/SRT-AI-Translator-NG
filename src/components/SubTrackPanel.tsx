import React, { useState } from 'react'
import type { SubtitleTrack } from '../../electron/shared/types'
import { langLabel } from '../data/languages'
import { extractedTrackName } from '../lib/outputName'

type ExtractResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * The button, or what this track is doing instead of offering one.
 *
 * Defined at module level rather than inside the panel: a component declared in a render body
 * is a new type on every render, so React would unmount and remount it — and the click that
 * starts an extraction is exactly the moment the panel re-renders, which would drop focus from
 * the button the user just pressed.
 */
function ExtractButton({
  track,
  extracting,
  pct,
  blocked,
  onExtract
}: {
  track: SubtitleTrack
  extracting: boolean
  /** How far this row's extraction has got, or null before the first report / unknown length. */
  pct: number | null
  blocked: boolean
  onExtract: () => void
}): React.JSX.Element {
  if (extracting) {
    // A percentage where there was previously only a word. ffmpeg walks the whole container
    // to find one track's packets, so on a large film "Extracting…" alone sat there long
    // enough to be read as a hang (REP-11).
    return (
      <span className="whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
        Extracting…{pct !== null && ` ${pct}%`}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onExtract}
      // Only one at a time: each opens a save dialog, and two competing dialogs would be
      // impossible to tell apart once they returned.
      disabled={blocked}
      className="whitespace-nowrap rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
    >
      Extract {track.isImage ? '.sup' : '.srt'}
    </button>
  )
}

/** Where the file went, or why it did not. Rendered under the row it belongs to. */
function ExtractResultLine({
  result,
  isImage
}: {
  result: ExtractResult | undefined
  isImage: boolean
}): React.JSX.Element | null {
  if (!result) return null
  if (!result.ok) {
    return (
      <div className="px-3 pb-2 text-xs text-red-600 dark:text-red-400">
        Extraction failed. Is FFmpeg installed?
        <pre className="mt-0.5 whitespace-pre-wrap text-gray-500 dark:text-gray-400">{result.error}</pre>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs">
      <span className="font-medium text-green-700 dark:text-green-400">✅ Saved → {result.path}</span>
      <button
        type="button"
        onClick={() => window.api.showItemInFolder(result.path)}
        className="text-brand hover:underline"
      >
        Show in folder
      </button>
      {isImage && (
        <span className="text-gray-500 dark:text-gray-400">
          .sup plays in VLC, Kodi, MPV, Plex, and MPC-HC.
        </span>
      )}
    </div>
  )
}

/**
 * The embedded subtitle tracks of the chosen video, and what can be done with each.
 *
 * Two different questions used to be answered by one control, which is how the panel came to
 * advertise something it gave no way to do (REP-8). They are now separate:
 *
 * - **Which track do you want to translate?** The radio. Still unavailable for image tracks,
 *   because a bitmap cannot be translated — that restriction is correct and stays.
 * - **Which track do you want out of this file?** Extraction. Available for **every** track,
 *   including image tracks and text tracks in languages nobody selected. It was previously
 *   offered only for a track whose language happened to equal the target language, which is
 *   why the reported file — English and Spanish PGS, translating into Hebrew — showed a
 *   promise of a `.sup` export and no button anywhere on the page.
 *
 * This component holds no state that should outlive the video it describes, and the parent
 * gives it `key={videoFile}` for exactly that reason (REP-9). Do not move the *selected*
 * track in here: remounting would then clear the user's choice on every file change.
 *
 * The one thing that *does* outlive it is the extraction itself — ffmpeg keeps running after
 * the panel that started it is gone — so the lock preventing a second one lives in the parent
 * and arrives as `busy`. Holding it here would have released it on every video change while
 * the process it guards was still writing (validator finding FP5-01).
 */
export function SubTrackPanel({
  videoFile,
  tracks,
  targetLang,
  selectedIndex,
  onSelect,
  busy,
  busyPct,
  onBusy
}: {
  videoFile: string
  tracks: SubtitleTrack[]
  targetLang: string
  selectedIndex: number | null
  onSelect: (index: number) => void
  /** An extraction is running somewhere — possibly one this panel did not start. */
  busy: boolean
  /**
   * How far that extraction has got, when it is an export and it has reported anything.
   * Owned by the parent for the same reason `busy` is: the progress channel is subscribed to
   * once, at a level that survives this panel being replaced mid-extraction.
   */
  busyPct: number | null
  onBusy: (running: boolean) => void
}): React.JSX.Element | null {
  // Which of THIS panel's rows is working, as opposed to whether anything is: the lock is the
  // parent's, and after a video change the row that holds it no longer exists. Keyed by track
  // index because an extraction belongs to the row that started it — a single panel-wide
  // status would report one track's failure against another's row.
  const [busyIndex, setBusyIndex] = useState<number | null>(null)
  const [results, setResults] = useState<Record<number, ExtractResult>>({})

  if (!videoFile) return null

  if (tracks.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">No subtitle tracks found in this file.</p>
    )
  }

  const textTracks = tracks.filter((t) => !t.isImage)
  const singleText = textTracks.length === 1 && tracks.length === 1
  const allPgs = tracks.every((t) => t.isImage)
  const matchTrack = targetLang ? tracks.find((t) => t.lang === targetLang) : undefined
  const matchIsImage = matchTrack?.isImage ?? false
  const tgtName = langLabel(targetLang)

  async function doExtract(track: SubtitleTrack): Promise<void> {
    setBusyIndex(track.index)
    // Taken in the parent, so it survives this panel being replaced by the next video's.
    onBusy(true)
    try {
      const res = await window.api.extractTrack({
        filePath: videoFile,
        subtitleIndex: track.index,
        isImage: track.isImage,
        // From the TRACK, not from the target language. See `outputName.ts`.
        defaultName: extractedTrackName(videoFile, track, tracks)
      })
      // A cancelled save dialog is not a result: leave the row exactly as it was — including
      // an earlier "Saved →" from this same track, which still names a file that still exists
      // (FP5-02). Nothing is cleared on the way in for that reason.
      if (res.canceled) return
      setResults((r) => ({
        ...r,
        [track.index]: res.ok
          ? { ok: true, path: res.path ?? '' }
          : { ok: false, error: res.error ?? 'Extraction failed' }
      }))
    } catch (e) {
      // A rejected invoke used to leave the panel reading "Extracting…" for the rest of the
      // session. Whatever went wrong, the row has to stop claiming it is still working.
      setResults((r) => ({ ...r, [track.index]: { ok: false, error: String(e) } }))
    } finally {
      // `setBusyIndex` is a no-op once this panel has been replaced; `onBusy` is the parent's
      // and is the one that must run, or the lock would never be released.
      setBusyIndex(null)
      onBusy(false)
    }
  }

  const action = (track: SubtitleTrack): React.JSX.Element => (
    <ExtractButton
      track={track}
      extracting={busyIndex === track.index}
      pct={busyIndex === track.index ? busyPct : null}
      blocked={busy}
      onExtract={() => void doExtract(track)}
    />
  )

  return (
    <div className="space-y-2.5">
      {allPgs && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3.5 py-2.5 dark:border-yellow-700/60 dark:bg-yellow-900/25">
          <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">
            ⚠ No SRT or ASS/SSA tracks found — cannot translate image-based (PGS) subtitles.
          </p>
          <p className="mt-0.5 text-sm text-yellow-800 dark:text-yellow-200">
            You can still extract any track below as a .sup file to play in VLC, Kodi, MPV, Plex,
            or MPC-HC.
          </p>
        </div>
      )}

      {singleText ? (
        <div className="overflow-hidden rounded-md border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="text-sm">✓</span>
            <span className="flex-1 text-sm text-gray-700 dark:text-gray-300">
              Auto-selected: Track {tracks[0].index} — {tracks[0].name} ({tracks[0].codec})
            </span>
            {/* One track is still a track: it can be extracted without being translated. */}
            {action(tracks[0])}
          </div>
          <ExtractResultLine result={results[tracks[0].index]} isImage={tracks[0].isImage} />
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
          {tracks.map((t, idx) => {
            const isSel = !t.isImage && selectedIndex === t.index
            const isMatch = targetLang && t.lang === targetLang
            return (
              <div
                key={idx}
                className={`${idx > 0 ? 'border-t border-gray-200 dark:border-gray-700' : ''} ${
                  isMatch
                    ? 'bg-amber-50 dark:bg-amber-900/25'
                    : isSel
                      ? 'bg-blue-50 dark:bg-blue-900/30'
                      : ''
                }`}
              >
                <div className="flex items-center gap-2.5 px-3 py-2">
                  {/*
                    The label wraps only the radio and its description. The extract button is a
                    sibling, not a child: a button inside a label is an interactive element
                    inside a control that forwards clicks, and extracting a track is not the
                    same act as choosing to translate it.
                  */}
                  <label
                    className={`flex flex-1 items-center gap-2.5 ${
                      t.isImage ? 'cursor-not-allowed' : 'cursor-pointer'
                    }`}
                  >
                    <input
                      type="radio"
                      name="subtrack"
                      disabled={t.isImage}
                      checked={isSel}
                      onChange={() => !t.isImage && onSelect(t.index)}
                      className="accent-brand"
                    />
                    <span
                      className={`min-w-[150px] text-sm ${
                        t.isImage ? 'text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-200'
                      }`}
                    >
                      {t.name}
                    </span>
                    <span className="min-w-[44px] text-xs uppercase text-gray-400 dark:text-gray-500">
                      {t.lang || '—'}
                    </span>
                    <span className="flex-1 text-xs text-gray-400 dark:text-gray-500">{t.codec}</span>
                    {t.isImage && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                        Image-based
                      </span>
                    )}
                    {isMatch && (
                      <span className="rounded bg-amber-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        Matches target lang
                      </span>
                    )}
                  </label>
                  {action(t)}
                </div>
                <ExtractResultLine result={results[t.index]} isImage={t.isImage} />
              </div>
            )
          })}
        </div>
      )}

      {/*
        The buttons are disabled and no row here explains why, because the extraction holding
        the lock was started from the video that was loaded before this one. Saying so beats a
        dead control with no stated cause — which is the defect REP-10 exists to record.
      */}
      {busy && busyIndex === null && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Finishing an extraction started from the previous video — these buttons unlock when it
          ends.
        </p>
      )}

      {matchTrack && (
        <div className="rounded-md border border-amber-400 bg-amber-50 px-3.5 py-3 dark:border-amber-700/60 dark:bg-amber-900/25">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            ⚠ A {tgtName} subtitle track already exists in this video file.
          </p>
          <p className="mt-1 text-sm text-amber-900 dark:text-amber-200">
            {matchIsImage
              ? `This is an image-based (PGS) track — it cannot be translated directly. Extract it as a .sup to use in VLC, Kodi, MPV, Plex, or MPC-HC, or translate a different text track into ${tgtName}.`
              : `Consider extracting and using the built-in ${tgtName} subtitles instead of re-translating. You can also continue to get a fresh AI translation.`}
          </p>
          {/*
            No button here any more. Extraction lives on the track's own row — highlighted, and
            badged "Matches target lang" — which is what makes the same action available for
            every other track too. One control per track, in one place.
          */}
          <p className="mt-1 text-sm text-amber-900 dark:text-amber-200">
            Use <span className="font-semibold">Extract {matchIsImage ? '.sup' : '.srt'}</span> on{' '}
            {singleText ? 'the track above' : 'the highlighted track above'}.
          </p>
        </div>
      )}
    </div>
  )
}
