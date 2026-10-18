/**
 * The Translate page's two context fields, and the one `description` they become at Start
 * (Feature 7, `feature_decisions.md` D7-3…D7-5).
 *
 * TMDB Context and Custom Context / Prompt are separate UI values so that a TMDB lookup can never
 * overwrite what the user wrote. The engine still has exactly one context channel
 * (`TranslateArgs.description` → `-d`), so the two are joined here, at the moment a run is
 * assembled, and nowhere else. React-free: the gates call these directly.
 */
import type { TmdbResult, TmdbDetails } from '../../electron/shared/types'

/** The generated TMDB text, worded exactly as 1.1.0's single description field was filled. */
export function buildTmdbContext(result: TmdbResult, detail: TmdbDetails): string {
  const castStr = detail.cast
    .filter((m) => m.character)
    .map((m) => `${m.character} (${m.gender.toLowerCase()})`)
    .join(', ')
  const kind = result.type === 'TV Show' ? 'TV series' : 'Film'
  return `${kind}: ${detail.title || result.title} (${detail.yearStart || result.year}).${
    detail.genres ? ' Genre: ' + detail.genres + '.' : ''
  }${castStr ? ' Characters: ' + castStr + '.' : ''}`
}

/**
 * The run's `description`: each non-empty section under its label, TMDB first, separated by one blank
 * line. A section that is empty or only whitespace is left out with its label; `''` when both are.
 * Only the outer whitespace of a section is trimmed — its lines, bullets and Unicode are kept as typed.
 */
export function combineDescriptionSections(tmdbContext: string, customContext: string): string {
  const sections: string[] = []
  const tmdb = tmdbContext.trim()
  const custom = customContext.trim()
  if (tmdb) sections.push(`TMDB context:\n${tmdb}`)
  if (custom) sections.push(`Custom context / prompt:\n${custom}`)
  return sections.join('\n\n')
}

/**
 * Latest-request-wins for an async UI lookup. `begin()` starts a request and returns its token;
 * `invalidate()` makes every outstanding token stale. A completion may touch state only while
 * `isCurrent(token)` — a superseded, cleared or unmounted request's success, failure and `finally`
 * are then all no-ops, even when they arrive after a newer request has failed.
 */
export interface RequestGeneration {
  current(): number
  begin(): number
  invalidate(): void
  isCurrent(token: number): boolean
}

export function createRequestGeneration(): RequestGeneration {
  let generation = 0
  return {
    current: () => generation,
    begin: () => {
      generation += 1
      return generation
    },
    invalidate: () => {
      generation += 1
    },
    isCurrent: (token) => token === generation
  }
}
