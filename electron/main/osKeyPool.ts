/**
 * The shared OpenSubtitles key pool, used the way the Kodi add-on uses it (feature_decisions.md §3.1c item 3).
 * AUTHORED-BY: opus-5.5-high
 *
 * With no key of the user's own, every OpenSubtitles request carries a key from this pool. The list is the
 * add-on's public one (`[{OS_API_KEY_NAME, OS_API_KEY_VALUE}]`), refreshed from its URL at most once a day; the
 * embedded copy below is the fallback when the refresh fails or has not run. Each download tries the keys in a
 * fresh random order, at most `POOL_ATTEMPTS` of them (Kodi `opensubtitles.py:133-240`).
 *
 * These are third-party keys, copied from that public list; the add-on publishes them for exactly this use.
 * The values are generated from the list captured 2026-10-16 (33 keys); nothing else in the app names a key.
 */

export const POOL_URL = 'https://morantheking.github.io/Kodi-POV-IL/repository/other/DarkSubs_OpenSubtitles/darksubs_opensubtitles_api.json'
export const POOL_REFRESH_MS = 24 * 60 * 60 * 1000
export const POOL_ATTEMPTS = 8
/** The list is a few kilobytes; anything far larger is not it. */
export const POOL_LIST_MAX_BYTES = 256 * 1024

const KEY_SHAPE = /^[A-Za-z0-9]{16,64}$/

// prettier-ignore
export const EMBEDDED_POOL: readonly string[] = Object.freeze([
  'HNUEpidhxT8ebYNFl6CYJZvuRQltv8Dp', 'P1Z0LLSXKCKYs4VoLyrYcjyKYmoS7mBP', 'eFfHuQ3GfBkYBvPzAsmf6SCHTfK0ekly',
  'kqfYpRUvAOhpWQzTWXCakLEIAAVMVbUf', 'iBDQeMlQNq8V83KJKRJkpkTX77LH2abx', 'HTLl09UPDMm1Ak2mwtQxS00aFqufhtSL',
  'Nc0lsetKRI2uTX6KJeVBRada78qbHUoo', 'S7OKbsQRQZjeVhcBKXbcvtzxewVNrhVD', 'RApkWTsN4vZLNZXhLYu5smrxat8nRJJ9',
  '9sLY6pRtxhb1CL4WdavyP002hVDTHiP0', 'j2JGBn4HnAPvAbnHeynrj6ZbL8tbbwt7', 'W92nAk5ObPbdzI5bbaGA1LSAHUbfsvNN',
  'Q4PrnthOmMKbiifG8WuylicM7W0vfhzb', 'mN4deDVpO3ZFpTypJCpQVfGKPZxuO1o1', 'tsfHUKxehfHH7Oc9sKHnewCm9LFc0Kyg',
  'k6EDd2Fl6S8n4Zl6GO98uVgdfv9frSoZ', 'NkHQCpNFexJjvPCrTVgz1kFcuWkuETsZ', 'VT4RiDg0EjFMvnUBjjS7oyg9tVFrPVp6',
  '4STAiQfChW8sC7sK1m2AGHIBArly1eIK', 'aJZ7VEbk9fobNlfFhAsVolPO6DgDnUzg', 'dqKmFxG1cDfkg0ZaKYnnDksGGR4muPK4',
  'erhcYyyy9xAs37gEVdC3UPB5aAQKSs4o', '5uGHVx9S1kWMxbBDjJcAO0Wggl2JktC3', 'pHYoqrpcMJR7aBTJCFgjRhX6AKYMnXrS',
  'WtwP1PSBNUwcsQ1C9JAZ0v6hWRSV6WmL', 'nMJRdlXQihqIk02KPNnPsgjGuOw4VclR', 'xtY1QLtYNFr7kzARLL53EVz3Ih6PFRkE',
  'jtvgKfdiJua7uUT1vQ58wKwGIvE1CoNf', '2MSsrjjGA4oNQE44HwaJqBcMyyg7eEC4', '5FI7s9i4mpuqMnFCGWETelBGHQ7k7GfA',
  '5miaPV25DuZl2vxHr9O5rspUvVxQ2mdL', 'amE8rdeaOMG9APehDHP4BY5rKemmSRyH', '9zLFxopSdKQyFYrTz50A7SGzZY7qD9UY'
])

/** The key values of a fetched list, deduplicated in list order; `null` when nothing in it has a key's shape. */
export function parsePoolList(json: unknown): string[] | null {
  if (!Array.isArray(json)) return null
  const out: string[] = []
  for (const entry of json) {
    const value = entry && typeof entry === 'object' ? (entry as { OS_API_KEY_VALUE?: unknown }).OS_API_KEY_VALUE : undefined
    const key = typeof value === 'string' ? value.trim() : ''
    if (KEY_SHAPE.test(key) && !out.includes(key)) out.push(key)
  }
  return out.length ? out : null
}

/** Fisher–Yates over a copy. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface KeyPoolOptions {
  /** Fetch and parse the list body; resolves to the parsed JSON or rejects. */
  fetchList: () => Promise<unknown>
  now?: () => number
  random?: () => number
}

/** The pool for this app session: the embedded copy until a refresh succeeds, refreshed at most once a day. */
export class KeyPool {
  private keys: readonly string[] = EMBEDDED_POOL
  private triedAt = Number.NEGATIVE_INFINITY
  private refreshing: Promise<void> | null = null
  private readonly now: () => number
  private readonly random: () => number

  constructor(private readonly options: KeyPoolOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  /** Where the keys in use came from. */
  source: 'embedded' | 'refreshed' = 'embedded'

  /** At most one refresh per day, attempted or not; a failed refresh keeps what was in use. */
  async refresh(): Promise<void> {
    if (this.now() - this.triedAt < POOL_REFRESH_MS) return
    if (this.refreshing) return this.refreshing
    this.triedAt = this.now()
    this.refreshing = (async () => {
      try {
        const parsed = parsePoolList(await this.options.fetchList())
        if (parsed) {
          this.keys = Object.freeze(parsed)
          this.source = 'refreshed'
        }
      } catch {
        /* the embedded or last good list stays in use */
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /** A fresh random order of at most `POOL_ATTEMPTS` keys, for one request. */
  async attemptOrder(): Promise<string[]> {
    await this.refresh()
    return shuffled(this.keys, this.random).slice(0, POOL_ATTEMPTS)
  }

  /** Every key currently in use, for the redaction sweep. */
  all(): readonly string[] {
    return this.keys
  }
}
