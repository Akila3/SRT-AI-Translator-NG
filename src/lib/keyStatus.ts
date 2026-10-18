/**
 * What the API-key panel is allowed to say about a key check.
 *
 * MAN-4 is a reporting defect, and it is here rather than in the component because the failure
 * was in the sentences themselves. With the network down the panel showed, at the same time:
 *
 *     ✗ No valid keys — check the key(s) marked ✗ above.
 *     3 keys invalid (marked ✗ — hover for details).
 *     Key 1, 2, 3 could not be checked — it is one of the two keys a run would use.
 *
 * Three faults in four lines: keys were called invalid when they were merely unreachable, two
 * lines contradicted each other, and the third was ungrammatical for a list and simply wrong
 * about key 3, which is a reserve. None of that is visible in a type checker and all of it is
 * trivially gateable, which is the entire argument for this module existing.
 *
 * The counting half now rests on a distinction the main process makes for us: `false` means the
 * API refused the credential, `null` means we did not find out. See `classifyFetchFailure`.
 */

/** What is known about one configured slot. */
export type KeyState =
  /** The API answered with a model list. */
  | 'valid'
  /** The API refused the credential. The only state that earns a ✗. */
  | 'rejected'
  /** Asked and learned nothing (offline, quota, timeout), or never asked at all. */
  | 'unchecked'
  /** No key typed in this slot. */
  | 'blank'

export function keyStateOf(hasKey: boolean, valid: boolean | null): KeyState {
  if (!hasKey) return 'blank'
  if (valid === true) return 'valid'
  if (valid === false) return 'rejected'
  return 'unchecked'
}

export interface KeyCounts {
  valid: number
  rejected: number
  unchecked: number
  /** Slots with a key in them, whatever their state. */
  present: number
}

export function countKeyStates(states: readonly KeyState[]): KeyCounts {
  const counts: KeyCounts = { valid: 0, rejected: 0, unchecked: 0, present: 0 }
  for (const s of states) {
    if (s === 'blank') continue
    counts.present++
    counts[s]++
  }
  return counts
}

/** "1", "1 and 2", "1, 2 and 3" — the list grammar the old sentence did not have. */
export function listKeyNumbers(slots: readonly number[]): string {
  const numbers = slots.map((i) => i + 1)
  if (numbers.length === 0) return ''
  if (numbers.length === 1) return String(numbers[0])
  return `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
}

export type Tone = 'good' | 'bad' | 'warn' | 'plain'

/**
 * The one sentence that summarises a check.
 *
 * The rule that fixes the contradiction: a run of keys that could not be checked is never
 * reported as a verdict on the keys. It is reported as a verdict on the check.
 */
export function keyHeadline(
  counts: KeyCounts,
  modelCount: number | null
): { text: string; tone: Tone } {
  if (counts.present === 0) return { text: '', tone: 'plain' }
  if (counts.valid > 0) {
    return {
      text:
        `✓ ${counts.valid} of ${counts.present} key${counts.present > 1 ? 's' : ''} valid` +
        (modelCount !== null ? ` — ${modelCount} models available.` : '.'),
      tone: 'good'
    }
  }
  if (counts.rejected === 0) {
    // Nothing was rejected, so nothing about the keys is known to be wrong. Saying "no valid
    // keys" here is what accused the user's credentials of a network fault. The reason is
    // deliberately not named: this bucket covers being offline, being out of quota and an
    // error we did not recognise, and each key's own ? mark carries the one that applies.
    return {
      text:
        (counts.present === 1
          ? 'This key could not be checked'
          : 'None of your keys could be checked') +
        ' — which says nothing about whether they work. Nothing was rejected, the model list ' +
        'below is unchanged, and each ? above says what happened to that key.',
      tone: 'warn'
    }
  }
  return { text: '✗ No valid keys — check the key(s) marked ✗ above.', tone: 'bad' }
}

/**
 * How the keys that could not be checked affect an actual run.
 *
 * Split by role, because "it is one of the two keys a run would use" was applied to every failed
 * slot including reserves — which overstates the problem for a reserve and, on a mixed list,
 * states it wrongly for both. Two short true sentences beat one that covers everything.
 */
export function uncheckedNote(unchecked: readonly number[], activeSlots: readonly number[]): string {
  if (unchecked.length === 0) return ''
  const active = unchecked.filter((i) => activeSlots.includes(i))
  const reserve = unchecked.filter((i) => !activeSlots.includes(i))

  const parts: string[] = []
  if (active.length > 0) {
    parts.push(
      active.length === 1
        ? `Key ${listKeyNumbers(active)} could not be checked, and a run would use it.`
        : `Keys ${listKeyNumbers(active)} could not be checked, and a run would use them.`
    )
  }
  if (reserve.length > 0) {
    parts.push(
      reserve.length === 1
        ? `Key ${listKeyNumbers(reserve)} could not be checked; it is a reserve, so runs are unaffected.`
        : `Keys ${listKeyNumbers(reserve)} could not be checked; they are reserves, so runs are unaffected.`
    )
  }
  return parts.join(' ')
}
