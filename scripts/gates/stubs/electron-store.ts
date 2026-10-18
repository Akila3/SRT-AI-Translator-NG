/**
 * In-memory `electron-store` stand-in for the gate suite.
 *
 * Mirrors the three behaviours the app depends on: defaults are returned for absent keys,
 * `set` accepts either a key/value pair or a whole object, and `store` returns the merged
 * state. Nothing is written to disk, so a gate run cannot touch a real profile.
 */
import os from 'os'
import path from 'path'

export default class Store<T extends Record<string, unknown>> {
  private data: Record<string, unknown>
  public readonly path: string

  constructor(opts: { defaults: T }) {
    this.data = { ...(opts.defaults as Record<string, unknown>) }
    this.path = path.join(os.tmpdir(), 'srt-gate-config.json')
  }

  get store(): T {
    return this.data as T
  }

  get(key: string): unknown {
    return this.data[key]
  }

  set(key: string | Record<string, unknown>, value?: unknown): void {
    if (typeof key === 'object') Object.assign(this.data, key)
    else this.data[key] = value
  }

  /** Test-only helper: replace the whole state, as if a different profile were loaded. */
  __replace(next: Record<string, unknown>): void {
    this.data = { ...next }
  }
}
