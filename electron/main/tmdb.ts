import type { TmdbResult, CastMember, TmdbDetails } from '../shared/types'

const BASE = 'https://api.themoviedb.org/3'
const IMG = 'https://image.tmdb.org/t/p/w185'

function genderLabel(g: number | undefined): string {
  if (g === 1) return 'Female'
  if (g === 2) return 'Male'
  return 'Unknown'
}

function mapResult(r: any, mediaType: 'movie' | 'tv'): TmdbResult {
  const title = mediaType === 'tv' ? r.name : r.title
  const date = mediaType === 'tv' ? r.first_air_date : r.release_date
  return {
    id: String(r.id),
    title: title ?? 'Untitled',
    type: mediaType === 'tv' ? 'TV Show' : 'Movie',
    year: date ? String(date).slice(0, 4) : '—',
    poster: r.poster_path ? `${IMG}${r.poster_path}` : null,
    mediaType
  }
}

/** Look up a title by IMDb ID (tt…) via the /find endpoint. */
async function findByImdb(apiKey: string, imdbId: string): Promise<TmdbResult[]> {
  const url = `${BASE}/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(
    apiKey
  )}&external_source=imdb_id`
  const res = await fetch(url)
  if (!res.ok) return []
  const data = (await res.json()) as { movie_results?: any[]; tv_results?: any[] }
  return [
    ...(data.movie_results ?? []).map((r) => mapResult(r, 'movie')),
    ...(data.tv_results ?? []).map((r) => mapResult(r, 'tv'))
  ]
}

/** Look up a title directly by its TMDB numeric ID. */
async function findByTmdbId(
  apiKey: string,
  id: string,
  type: 'all' | 'movie' | 'tv'
): Promise<TmdbResult[]> {
  const kinds: ('movie' | 'tv')[] = type === 'all' ? ['movie', 'tv'] : [type]
  const out: TmdbResult[] = []
  await Promise.all(
    kinds.map(async (kind) => {
      const res = await fetch(`${BASE}/${kind}/${encodeURIComponent(id)}?api_key=${encodeURIComponent(apiKey)}`)
      if (res.ok) out.push(mapResult(await res.json(), kind))
    })
  )
  return out
}

export async function tmdbSearch(
  apiKey: string,
  query: string,
  type: 'all' | 'movie' | 'tv'
): Promise<TmdbResult[]> {
  const q = query.trim()
  if (/^tt\d+$/i.test(q)) return findByImdb(apiKey, q.toLowerCase())
  if (/^\d+$/.test(q)) return findByTmdbId(apiKey, q, type)

  const endpoint = type === 'all' ? 'multi' : type
  const url = `${BASE}/search/${endpoint}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(q)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`)
  const data = (await res.json()) as { results?: any[] }
  const results = data.results ?? []
  return results
    .filter((r) => r.media_type !== 'person')
    .map((r): TmdbResult => {
      const mediaType: 'movie' | 'tv' = r.media_type === 'tv' || type === 'tv' ? 'tv' : 'movie'
      return mapResult(r, mediaType)
    })
}

export async function tmdbCast(
  apiKey: string,
  tmdbId: string,
  mediaType: 'movie' | 'tv'
): Promise<TmdbDetails> {
  const detailsUrl = `${BASE}/${mediaType}/${tmdbId}?api_key=${encodeURIComponent(
    apiKey
  )}&append_to_response=external_ids`
  const creditsUrl = `${BASE}/${mediaType}/${tmdbId}/credits?api_key=${encodeURIComponent(apiKey)}`

  const [detailsRes, creditsRes] = await Promise.all([fetch(detailsUrl), fetch(creditsUrl)])
  if (!creditsRes.ok) throw new Error(`TMDB credits failed: ${creditsRes.status}`)

  const details = detailsRes.ok ? ((await detailsRes.json()) as any) : {}
  const credits = (await creditsRes.json()) as { cast?: any[] }

  const title = (mediaType === 'tv' ? details.name : details.title) ?? ''
  const genreList: string[] = (details.genres ?? []).map((g: { name: string }) => g.name)
  const genres = genreList.join(', ')

  const imdbId: string = details.imdb_id ?? details.external_ids?.imdb_id ?? ''
  const seasons: number = mediaType === 'tv' ? details.number_of_seasons ?? 0 : 0

  const startDate = mediaType === 'tv' ? details.first_air_date : details.release_date
  const endDate = mediaType === 'tv' ? details.last_air_date : details.release_date
  const yearStart = startDate ? String(startDate).slice(0, 4) : ''
  const yearEnd = endDate ? String(endDate).slice(0, 4) : ''

  const typeWord = mediaType === 'tv' ? 'TV' : 'Movie'
  const typeLabel = [typeWord, ...genreList.slice(0, 2)].join(' ')

  const cast = (credits.cast ?? []).slice(0, 12).map(
    (c): CastMember => ({
      name: c.name ?? '',
      character: c.character ?? '',
      gender: genderLabel(c.gender)
    })
  )
  return {
    cast,
    title,
    genres,
    genreList,
    typeLabel,
    imdbId,
    tmdbId,
    seasons,
    yearStart,
    yearEnd,
    mediaType
  }
}
