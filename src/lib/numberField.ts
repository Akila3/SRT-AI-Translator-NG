/**
 * When a partly-typed number becomes a value, and what it settles on afterwards.
 *
 * Split out of `NumberInput` for the same reason as `logView.ts`: these are pure rules whose
 * failure mode is a field the user cannot type into, and the gate runner has no renderer, so
 * they have to be reachable without one. The component keeps the focus and the draft text;
 * everything here is a decision about a string.
 *
 * The defect these rules replace (REP-4) was one line: the old field clamped on every
 * keystroke. Typing `0.85` into a box whose minimum is `0.05` was therefore impossible — the
 * leading `0` is below the minimum and was rewritten to `0.05` under the caret. Arrow keys
 * worked only because the browser never produces an intermediate value.
 *
 * The rule that replaces it: **while the field has focus, a keystroke may only ever commit a
 * value that is already valid — never correct one.** Correction happens once, on the way
 * out, where it cannot interrupt anybody.
 */

export interface NumberFieldRules {
  min: number
  max: number
  /** A step below 1 marks the field as decimal; anything else is an integer field. */
  step?: number
  /** Whether clearing the box means "no value" (Top-K) rather than "not allowed". */
  allowEmpty?: boolean
}

function isDecimal(rules: NumberFieldRules): boolean {
  return rules.step != null && rules.step < 1
}

/**
 * Read the box as a number, or null when it does not hold one.
 *
 * Rounded to the field's own granularity, so a decimal field cannot store 0.30000000000000004
 * and an integer field cannot store 2.5. Integers round rather than truncate: someone who
 * typed `2.6` into a whole-number field meant 3 more than they meant 2.
 */
function parseValue(raw: string, rules: NumberFieldRules): number | null {
  const text = raw.trim()
  if (text === '') return null
  const n = Number(text)
  if (!Number.isFinite(n)) return null
  return isDecimal(rules) ? Math.round(n * 100) / 100 : Math.round(n)
}

/**
 * The value a keystroke should commit, or null to leave the text alone for now.
 *
 * Committing only in-range values is what makes typing work. `0`, `0.` and `0.0` on the way
 * to `0.05` are all held back rather than corrected, so the caret never jumps and no
 * character is eaten; the moment the text reads as something the field could hold, it is
 * committed, so a value typed and then saved without ever leaving the field still counts.
 *
 * Null also covers an empty box, deliberately: mid-edit is the wrong moment to decide that
 * someone meant "no value", and blur is the right one.
 */
export function valueWhileTyping(raw: string, rules: NumberFieldRules): number | null {
  const n = parseValue(raw, rules)
  if (n === null) return null
  return n >= rules.min && n <= rules.max ? n : null
}

/**
 * What the field settles on when it loses focus.
 *
 * Out-of-range text is clamped here and only here. Text that is not a number at all — and an
 * empty box in a field that requires a value — restores what was there before rather than
 * inventing a minimum: the old code wrote `min` on an empty box, which turned "I cleared this
 * to retype it, then clicked away" into a silent edit of a setting the user never chose.
 */
export function valueOnBlur(
  raw: string,
  rules: NumberFieldRules,
  current: number | null
): number | null {
  const n = parseValue(raw, rules)
  if (n === null) {
    const cleared = raw.trim() === ''
    if (cleared && rules.allowEmpty) return null
    return current
  }
  return Math.min(rules.max, Math.max(rules.min, n))
}
