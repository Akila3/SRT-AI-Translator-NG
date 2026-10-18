import React, { useEffect, useRef, useState } from 'react'
import { Button, Select, TextInput, Pill, Label, Divider } from './ui'
import { openExternalLink } from '../lib/openExternal'
import { buildTmdbContext, createRequestGeneration } from '../lib/contextDescription'
import type { TmdbResult, TmdbDetails } from '../../electron/shared/types'

function yearRange(d: TmdbDetails): string {
  if (!d.yearStart) return ''
  if (d.yearEnd && d.yearEnd !== d.yearStart) return `${d.yearStart}\u2013${d.yearEnd}`
  return d.yearStart
}

function metaLine(d: TmdbDetails): string {
  const parts = [d.typeLabel.trim(), yearRange(d)].filter(Boolean)
  if (d.seasons > 0) parts.push(`${d.seasons} season${d.seasons > 1 ? 's' : ''}`)
  return parts.join(' \u00b7 ')
}

const tmdbUrl = (mediaType: 'movie' | 'tv', id: string): string =>
  `https://www.themoviedb.org/${mediaType}/${id}`
const imdbUrl = (id: string): string => `https://www.imdb.com/title/${id}/`

const CONTEXT_FIELD =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500'

// The tester-approved helper copy (D7-7). The shared Tooltip keeps each line break, so every bullet is
// its own paragraph.
export const TMDB_SEARCH_TIP =
  'Use TMDB to automatically add useful context for the selected movie or series before translation.\n\n' +
  '• Adds the title, year, genre, and character names with genders.\n\n' +
  '• Helps keep character names consistent.\n\n' +
  '• Helps the model choose correct masculine or feminine wording in gendered languages.\n\n' +
  '• TMDB is optional; you can skip it and translate normally.'

export const TMDB_CONTEXT_TIP =
  'Context generated for the selected TMDB title.\n\n' +
  '• Includes the title, year, genre, and character names with genders.\n\n' +
  '• Helps preserve character names and gendered wording.\n\n' +
  '• You can edit this text freely.\n\n' +
  '• Selecting or reselecting a TMDB title replaces only this section; your Custom Context / Prompt is never changed.'

export const TRANSLATE_CUSTOM_CONTEXT_TIP =
  'Use this optional field to add context or instructions about names, terminology, tone, or other preferences. It is not required for translation. TMDB searches never replace this section.\n\n' +
  '• The app already sends everything required.\n\n' +
  '• The field can remain empty.\n\n' +
  '• Its content is only additional guidance.\n\n' +
  '• It supplements rather than replaces built-in instructions.'

export function TmdbSearch({
  tmdbContext,
  onTmdbContextChange,
  customContext,
  onCustomContextChange,
  onTitleChange
}: {
  tmdbContext: string
  onTmdbContextChange: (value: string) => void
  customContext: string
  onCustomContextChange: (value: string) => void
  /** The selected title's IMDb id and kind (§3.2: the gender reference searches by it); null on Clear. */
  onTitleChange?: (title: { imdbId: string; mediaType: 'movie' | 'tv' } | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<'all' | 'movie' | 'tv'>('all')
  const [results, setResults] = useState<TmdbResult[]>([])
  const [suggestions, setSuggestions] = useState<TmdbResult[]>([])
  const [showSuggest, setShowSuggest] = useState(false)
  const [selected, setSelected] = useState<TmdbResult | null>(null)
  const [detail, setDetail] = useState<TmdbDetails | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  /** Launch failures from TMDB/IMDb badges — not search/detail errors (SOL-28). */
  const [linkError, setLinkError] = useState('')
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // One gate per kind of request, stable for the component's life. A completion may touch state only
  // while its token is current, so a superseded, cleared or unmounted request does nothing (D7-4).
  const [searchGate] = useState(createRequestGeneration)
  const [detailGate] = useState(createRequestGeneration)

  // New SRT / New remount this component; an old lookup's closure must not reach the parent after that.
  useEffect(
    () => () => {
      searchGate.invalidate()
      detailGate.invalidate()
    },
    [searchGate, detailGate]
  )

  // Debounced autocomplete as the user types.
  useEffect(() => {
    if (selected) return
    const q = query.trim()
    if (q.length < 2) {
      setSuggestions([])
      return
    }
    const pickToken = detailGate.current()
    const t = setTimeout(async () => {
      try {
        const res = await window.api.tmdbSearch(q, type)
        if (!detailGate.isCurrent(pickToken)) return
        setSuggestions(res.slice(0, 8))
        setShowSuggest(true)
      } catch {
        if (!detailGate.isCurrent(pickToken)) return
        setSuggestions([])
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query, type, selected, detailGate])

  async function search(): Promise<void> {
    if (!query.trim()) return
    const token = searchGate.begin()
    const pickToken = detailGate.current()
    const current = (): boolean => searchGate.isCurrent(token) && detailGate.isCurrent(pickToken)
    setSearchLoading(true)
    setError('')
    setLinkError('')
    setResults([])
    setShowSuggest(false)
    try {
      const res = await window.api.tmdbSearch(query.trim(), type)
      if (!current()) return
      setResults(res.slice(0, 12))
      if (res.length === 0) setError('No results found.')
    } catch {
      if (!current()) return
      setError('TMDB search failed. Check your API key in Settings.')
    } finally {
      if (current()) setSearchLoading(false)
    }
  }

  /**
   * Nothing is selected until the details arrive: the title, its details and the new TMDB text are
   * committed together, by the current pick only. Until then the search stays on screen, disabled,
   * with Clear TMDB as the way out.
   */
  async function pick(r: TmdbResult): Promise<void> {
    const token = detailGate.begin()
    searchGate.invalidate()
    setSearchLoading(false)
    setShowSuggest(false)
    setDetailLoading(true)
    setError('')
    setLinkError('')
    try {
      const d = await window.api.tmdbCast(r.id, r.mediaType)
      if (!detailGate.isCurrent(token)) return
      setSelected(r)
      setDetail(d)
      setResults([])
      setSuggestions([])
      onTmdbContextChange(buildTmdbContext(r, d))
      onTitleChange?.(d.imdbId ? { imdbId: d.imdbId, mediaType: r.mediaType } : null)
    } catch {
      if (!detailGate.isCurrent(token)) return
      setError('Failed to fetch details.')
    } finally {
      if (detailGate.isCurrent(token)) setDetailLoading(false)
    }
  }

  /** Clear TMDB: the title and everything TMDB put on the page. The user's Custom Context stays. */
  function clearTmdb(): void {
    detailGate.invalidate()
    searchGate.invalidate()
    setSearchLoading(false)
    setDetailLoading(false)
    setSelected(null)
    setDetail(null)
    setQuery('')
    setResults([])
    setSuggestions([])
    setShowSuggest(false)
    setLinkError('')
    onTmdbContextChange('')
    onTitleChange?.(null)
  }

  const headerYear = detail?.yearStart || selected?.year
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="mb-3 flex w-full items-center gap-2 text-left"
      >
        <span className="text-gray-400 dark:text-gray-500">{open ? '\u25be' : '\u25b8'}</span>
        <span className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">TMDB Context</span>
        {selected && (
          <span className="ml-auto">
            <Pill>
              {selected.title}
              {headerYear ? ` (${headerYear})` : ''}
            </Pill>
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3">
          {!selected && (
            <div className="flex items-end gap-2">
              <div className="relative flex-1">
                <Label tip={TMDB_SEARCH_TIP}>Search by Name, IMDb ID, or TMDB ID</Label>
                <TextInput
                  value={query}
                  disabled={detailLoading}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setShowSuggest(true)
                  }}
                  onFocus={() => suggestions.length > 0 && setShowSuggest(true)}
                  onBlur={() => {
                    blurTimer.current = setTimeout(() => setShowSuggest(false), 150)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (showSuggest && suggestions.length > 0) pick(suggestions[0])
                      else search()
                    } else if (e.key === 'Escape') {
                      setShowSuggest(false)
                    }
                  }}
                  placeholder="e.g. Breaking Bad · tt0903747 · 1396"
                  className="w-full"
                />
                {showSuggest && suggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
                    {suggestions.map((s) => (
                      <button
                        key={s.id + s.mediaType}
                        disabled={detailLoading}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          if (detailLoading) return
                          if (blurTimer.current) clearTimeout(blurTimer.current)
                          pick(s)
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-blue-900/30"
                      >
                        <Poster src={s.poster} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{s.title}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {s.type} · {s.year}
                          </div>
                        </div>
                        <span className="text-[10px] text-gray-400 dark:text-gray-500">#{s.id}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Select
                value={type}
                disabled={detailLoading}
                onChange={(v) => setType(v as 'all' | 'movie' | 'tv')}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'movie', label: 'Movie' },
                  { value: 'tv', label: 'TV Show' }
                ]}
                className="w-32"
              />
              <Button onClick={search} disabled={searchLoading || detailLoading}>
                {searchLoading ? '…' : 'Search'}
              </Button>
            </div>
          )}

          {!selected && detailLoading && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500 dark:text-gray-400">Loading TMDB details…</span>
              <button onClick={clearTmdb} className="text-sm font-medium text-brand hover:underline">
                Clear TMDB
              </button>
            </div>
          )}

          {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
          {linkError && <p className="text-xs text-red-500 dark:text-red-400">{linkError}</p>}

          {/* Full results list (from the Search button) */}
          {!selected && results.length > 0 && (
            <div className="divide-y divide-gray-200 overflow-hidden rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {results.map((r) => (
                <button
                  key={r.id + r.mediaType}
                  disabled={detailLoading}
                  onClick={() => pick(r)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-blue-900/30"
                >
                  <Poster src={r.poster} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{r.title}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {r.type} · {r.year}
                    </div>
                    <div className="mt-1">
                      <Badge href={tmdbUrl(r.mediaType, r.id)} onLink={setLinkError}>
                        TMDB #{r.id}
                      </Badge>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Selected rich card (matches reference) */}
          {selected && (
            <div className="flex items-start gap-3 rounded-md border border-gray-200 px-3 py-3 dark:border-gray-700">
              <Poster src={selected.poster} large />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{selected.title}</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {detail ? metaLine(detail) : `${selected.type} · ${selected.year}`}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge
                    href={tmdbUrl(detail?.mediaType ?? selected.mediaType, detail?.tmdbId || selected.id)}
                    onLink={setLinkError}
                  >
                    TMDB #{detail?.tmdbId || selected.id}
                  </Badge>
                  {detail?.imdbId && (
                    <Badge href={imdbUrl(detail.imdbId)} onLink={setLinkError}>
                      IMDb {detail.imdbId}
                    </Badge>
                  )}
                </div>
              </div>
              <button
                onClick={clearTmdb}
                className="flex-shrink-0 text-sm font-medium text-brand hover:underline"
              >
                Clear TMDB
              </button>
            </div>
          )}

          {/* Cast (drives the generated description) */}
          {selected && detail && detail.cast.length > 0 && (
            <div className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Cast</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
                {detail.cast.map((m, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="truncate text-gray-700 dark:text-gray-300">{m.character || m.name}</span>
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
                        m.gender === 'Female'
                          ? 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300'
                          : m.gender === 'Male'
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                            : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {m.gender}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Shown only with a selected title: TMDB's own text, editable, replaced by the next lookup */}
          {selected && (
            <>
              <div>
                <Label tip={TMDB_CONTEXT_TIP}>TMDB Context</Label>
                <textarea
                  value={tmdbContext}
                  onChange={(e) => onTmdbContextChange(e.target.value)}
                  rows={3}
                  className={CONTEXT_FIELD}
                />
              </div>
              <Divider />
            </>
          )}

          <div>
            <Label tip={TRANSLATE_CUSTOM_CONTEXT_TIP}>Custom Context / Prompt (Optional)</Label>
            <textarea
              value={customContext}
              onChange={(e) => onCustomContextChange(e.target.value)}
              rows={3}
              placeholder="Optional context to guide the translation…"
              className={CONTEXT_FIELD}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function Poster({ src, large }: { src: string | null; large?: boolean }): React.JSX.Element {
  const size = large ? 'h-16 w-11' : 'h-12 w-8'
  if (src) {
    return <img src={src} alt="" className={`${size} flex-shrink-0 rounded object-cover`} />
  }
  return (
    <div
      className={`${size} flex flex-shrink-0 items-center justify-center rounded bg-gray-100 text-[9px] font-medium text-gray-400 dark:bg-gray-700 dark:text-gray-500`}
    >
      IMG
    </div>
  )
}

function Badge({
  children,
  href,
  onLink
}: {
  children: React.ReactNode
  href?: string
  onLink?: (msg: string) => void
}): React.JSX.Element {
  const cls =
    'rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  if (href) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void openExternalLink(href).then((err) => {
            onLink?.(err)
          })
        }}
        className={`${cls} hover:bg-gray-200 hover:text-brand hover:underline dark:hover:bg-gray-600`}
      >
        {children}
      </a>
    )
  }
  return <span className={cls}>{children}</span>
}
