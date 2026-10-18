/**
 * Spawn-boundary instrumentation for the thinking probe.
 *
 * Aliased in place of `child_process` when the probe is bundled, so every command the real
 * main-process modules launch is recorded before it runs. This exists because the argv built
 * inside `startTranslate` is not returned to any caller: the only way to see what the IPC
 * path actually sends is to watch the spawn itself.
 *
 * Deliberately a build-time alias rather than a log statement inside `pythonBridge.ts` —
 * the product code stays untouched, which is a hard rule for the current investigation
 * phase, and there is nothing to remember to delete afterwards.
 */
import * as real from 'node:child_process'

export * from 'node:child_process'

/** Set by the probe so the key never reaches the log. */
let secret = ''
export function __setSpawnSecret(s: string): void {
  secret = s
}

/** Set by the probe so each spawn can be attributed to the scenario that caused it. */
let scenario = ''
export function __setSpawnScenario(s: string): void {
  scenario = s
}

const mask = (t: string): string => (secret ? t.split(secret).join('***KEY***') : t)

export function spawn(
  command: string,
  args?: readonly string[],
  options?: real.SpawnOptions
): real.ChildProcess {
  const argv = (args ?? []).map((a) => mask(String(a)))
  const thinkingFlags = argv.filter(
    (a, i) => a.startsWith('--thinking') || (i > 0 && argv[i - 1].startsWith('--thinking'))
  )
  console.error(
    `[spawn ${scenario}] ${command.split(/[\\/]/).pop()} ` +
      `thinking=[${thinkingFlags.join(' ')}] noThinking=${argv.includes('--no-thinking')}`
  )
  console.error(`  ${argv.join(' ')}`)
  return real.spawn(command, args as string[], options as real.SpawnOptions)
}

export default { ...real, spawn }
