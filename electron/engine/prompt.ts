/**
 * The instruction the model is given, and for translation the whole request (implementation_plan.md
 * Steps 1.5 and 2.4). AUTHORED-BY: opus-5.5-high
 *
 * Translation is below its own heading. Transcription: the shipping engine's `get_transcribe_instruction`
 * (`helpers.py:118-224`, byte-identical across 3.7.0 and 3.8.3 — DECISIONS.md D0) carried section for
 * section, plus the one rule it never had.
 *
 * `TranscribePage.tsx` promises a subtitle "in the original spoken language", and the engine's
 * instruction covers persona, JSON shape, timing, line length and speaker hyphens but never says
 * *transcribe, do not translate*. Nothing was being disobeyed; there was no rule — which is how a
 * Japanese track came back with five cues of Russian (F9, register H1 approach 1). The rule goes in
 * the instruction proper. ⚠ Never in the user-context section, which the instruction itself says
 * "do not override core rules".
 *
 * ⚠ The rule must not name a language and must not carry a language code (CARRY_FORWARD.md
 * "the transcription language rule must not name a language"). Transcription has no source
 * language — nobody knows what the audio is until it is transcribed — and a named lock is actively
 * wrong on bilingual audio. The gate enforces this against `languages.ts`.
 *
 * Not here: the dedicated `*-transcribe` model, which rejects a system instruction outright and
 * whose request-shape contract is Bundle I's.
 */
import type { Cue } from './srt'
import { requestedLines } from './translationState'
import type { ProviderPart, ProviderRequest, ProviderRequestReceipt, ProviderTurn } from './providers/types'
import { DEFAULT_BATCH_CONTEXT_LINES, MAX_BATCH_CONTEXT_LINES, MIN_BATCH_CONTEXT_LINES, type TranslateArgs } from '../shared/types'
import { canonicalLanguage, gstLanguageName } from '../shared/languages'
import type { OracleStrength } from '../shared/genderReference'
import { modelCapabilities, modelRequestConfig } from '../shared/modelCaps'

/** The fidelity rule, in the tester's wording (CARRY_FORWARD.md, register H1 approach 1). */
export const TRANSCRIPTION_FIDELITY_RULE =
  'Transcribe the speech verbatim in the language actually spoken. Do not translate it into any other language. If the speaker switches language, follow the speech.'

export interface TranscribeInstructionOptions {
  model: string
  /** The user's description, as 1.1.0 passes it with `-d` (`pythonBridge.ts:625`). */
  description?: string
  /** gst's `thinking`. 1.1.0 never passes `--no-thinking`, so it is always true there. */
  thinking?: boolean
}

/** gst's own test for whether a model takes a reasoning protocol (`main.py:273-275`). */
function thinkingCompatible(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes('gemini') && !m.includes('2.0')
}

/**
 * The transcription system instruction: gst's sections in gst's order and words, with a Language
 * section after the goal. Sections are numbered as gst numbers them, so the user-context and
 * reasoning sections keep their relative place.
 */
export function transcribeInstruction(opts: TranscribeInstructionOptions): string {
  const parts: string[] = []
  let n = 0

  parts.push(
    '# INSTRUCTION: Transcribe Audio to Subtitles\n\n' +
      'You are an expert AI transcriber specializing in broadcast-quality subtitles. Your goal is to transcribe audio into a timed JSON array of subtitle objects.'
  )

  n += 1
  parts.push(`
## ${n}. Language
- **Fidelity**: ${TRANSCRIPTION_FIDELITY_RULE}`)

  n += 1
  parts.push(`
## ${n}. Output Structure
The output must be a JSON array. Each object must contain \`text\`, \`time_start\`, and \`time_end\`.
\`\`\`json
{
  "text": "This is the first line of the subtitle.\\nThis is the second line.",
  "time_start": "00:06",
  "time_end": "00:09"
}
\`\`\``)

  n += 1
  parts.push(`
## ${n}. Core Formatting Rules
- **Timing**: Subtitles must be between **1-5 seconds** in duration.
- **Content**: Max **42 characters** per line, max **2 lines** per subtitle (use \`\\n\`).
- **Line Breaking**: Break lines logically (e.g., after punctuation, before conjunctions). Do not separate closely related words (e.g., article and noun).
- **Omit Non-Verbal Sounds**: Do not transcribe sounds like \`[coughs]\` or \`[laughs]\`. Use italics for song lyrics as described below.`)

  n += 1
  parts.push(`
## ${n}. Dialogue and Continuity
- **Multiple Speakers**: Use a hyphen: \`- Are you coming?\\n- In a minute.\`
- **Interruptions**: Use two hyphens: \`- What are you--\\n- Be quiet!\`
- **Significant Pauses (2+ sec)**: End the subtitle with an ellipsis (\`...\`).`)

  n += 1
  parts.push(`
## ${n}. Text and Number Formatting
- **Numbers**: Spell out numbers zero through ten; use digits for 11 and up. Always spell out a number that begins a sentence.
- **Dates & Times**: Transcribe as spoken but omit "the" and "of" (e.g., \`March 6th\`). Use numerals for specific times (\`9:30 a.m.\`).
- **Quotes**: Use double quotes (\`"\`) for dialogue and single quotes (\`'\`) for quotes within quotes. Punctuation goes *inside* the closing quote.`)

  n += 1
  parts.push(`
## ${n}. Italics and Songs
Use \`<i></i>\` tags **only** for:
- Narration, off-screen voices, or inner thoughts.
- Dialogue from electronic media (phones, TVs).
- Sung lyrics.
- Titles of books, movies, etc.
- Unfamiliar foreign words.
- Clear vocal emphasis (\`It <i>was</i> you.\`).

For songs, italicize lyrics and wrap the subtitle with music notes: \`\u266A <i>lyrics go here</i> \u266A\`.`)

  const description = opts.description?.trim()
  if (description) {
    n += 1
    parts.push(`
## ${n}. Additional User-Provided Context
Use this context to improve transcription accuracy. These notes do not override core rules.
- ${description}
`)
  }

  if (thinkingCompatible(opts.model)) {
    n += 1
    const reasoning =
      opts.thinking === false
        ? '**Respond directly**: Generate the JSON output immediately without providing a step-by-step reasoning process.'
        : '**Think step-by-step**: Before generating the final JSON, reason through your choices to ensure all rules are strictly followed.'
    parts.push(`
## ${n}. Reasoning Protocol
${reasoning}`)
  }

  return parts.join('\n---\n').trim()
}

// ── translation (implementation_plan.md Step 2.4) ─────────────────────────────────────────────

export interface TranslateInstructionOptions {
  /** The target's prompt name (`gstLanguageName`): "Hebrew", "Brazilian Portuguese". */
  language: string
  /** gst's `thinking`. 1.1.0 never passes `--no-thinking`, so it is always true there. */
  thinking: boolean
  /** gst's `thinking_compatible` (`main.py:209-211`). */
  thinkingCompatible: boolean
  /** A media file is attached to every batch (gst's `audio_file`). */
  audio: boolean
  /** The description as 1.1.0 sends it with `-d`, source-language prefix included. */
  description?: string
  /** The Settings System Prompt Override (N14), added after the built-in rules. Blank or absent adds nothing. */
  guidanceOverride?: string
}

const AUDIO_ITEM_FIELDS = '"time_start": "01:56",\n    "time_end": "02:00",'

/**
 * The translation system instruction.
 *
 * Without an override it is gst's `get_translate_instruction` (`helpers.py:10-110`, byte-identical
 * across 3.7.0 and 3.8.3 — DECISIONS.md D0), character for character; the gate compares it with that
 * function's own output for every branch.
 *
 * A non-empty override is added as its own Translation Guidance section after every built-in rule and
 * removes none of them (tester 2026-10-18, superseding D14-3's replacement of the formatting and
 * gender-from-audio rules). The reply is still validated against the app's envelope
 * (`validateTranslationBatch.ts`). The description stays additive and the reasoning protocol follows
 * the thinking setting, as without an override.
 */
export function translateInstruction(opts: TranslateInstructionOptions): string {
  const language = opts.language
  const override = opts.guidanceOverride?.trim() ?? ''
  const parts: string[] = []
  let n = 1

  parts.push(
    `# INSTRUCTION: Translate Subtitles to ${language}\n\n` +
      'You are an expert AI linguist specializing in subtitle translation. Your goal is to translate the `text` field of each item into ' +
      `**${language}**.`
  )

  n += 1
  const structure = `
\`\`\`json
[
  {
    "index": "1",
    "text": "This is the first subtitle line.\\nThis is the second line.",
${opts.audio ? '    ' + AUDIO_ITEM_FIELDS : '...'}
  }
]
\`\`\``
  parts.push(`## ${n}. Data Structure\nYou will receive and must return a list of items with this exact structure:\n${structure}`)

  n += 1
  const preserveFormatting = '- **Preserve Formatting**: Keep all existing formatting, including HTML tags (`<i>`, `<b>`) and line breaks (`\\n`).\n'
  parts.push(`
## ${n}. Core Translation Rules
- **Translate Text Only**: Only translate the value of the \`text\` field.
${preserveFormatting}- **Handle Empty Text**: If a \`text\` field is empty or contains only whitespace, keep it unchanged.
- **Maintain Integrity**:
  - Number of items in the output must match the input.
  - **Do NOT** alter any fields other than \`text\`.
  - **Do NOT** add, remove, or reorder any items on the list.
  - **Do NOT** merge text between different items. Original and translation must match.
`)

  if (opts.audio) {
    n += 1
    parts.push(`
## ${n}. Advanced Rules: Grammatical Gender from Audio
If the text is ambiguous, use the provided audio to infer the correct grammatical gender and formality.
- **Analyze Speaker's Voice**: Use the \`time_start\` and \`time_end\` (\`MM:SS\` format) to listen to the speaker.
  - If the speaker sounds **male**, use masculine grammatical forms.
  - If the speaker sounds **female**, use feminine forms.
  - **Example (French):** "I am tired." -> \`Je suis fatigu\u00e9\` (male) vs. \`Je suis fatigu\u00e9e\` (female).
- **Analyze Context**: If necessary, listen to the audio before or after the current segment to determine who is being addressed and apply the correct gender and pluralization.
  - **Example (Spanish):** "You are tired." -> \`Ustedes est\u00e1n cansados\` (male/mixed) vs. \`Ustedes est\u00e1n cansadas\` (female).
`)
  }

  if (override) {
    n += 1
    parts.push(`
## ${n}. Translation Guidance
The user's own instructions for this translation. Follow them wherever they do not conflict with the rules above.
${override}
`)
  }

  if (opts.description) {
    n += 1
    parts.push(`
## ${n}. Additional User-Provided Context
Use this context to improve translation accuracy. These notes do not override core rules.
- ${opts.description}
`)
  }

  if (opts.thinkingCompatible) {
    n += 1
    const reasoning = opts.thinking
      ? '**Think step-by-step**: Before generating the final JSON, reason through your choices to ensure all rules are strictly followed.'
      : '**Respond directly**: Generate the JSON output immediately without providing a step-by-step reasoning process.'
    parts.push(`
## ${n}. Reasoning Protocol
${reasoning}`)
  }

  return parts.join('\n---\n').trim()
}

/** Names the response schema in a receipt; the schema itself is gst's `get_translate_response_schema`. */
export const TRANSLATION_RESPONSE_SCHEMA_ID = 'gst-translate-index-text'

/** `helpers.py:253-267`: an array of objects with required string `index` and `text`. */
function translationResponseSchema(): unknown {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: { index: { type: 'string' }, text: { type: 'string' } },
      required: ['index', 'text']
    }
  }
}

/**
 * Everything a Translate run's requests are built from, fixed once at start from the run's
 * `TranslateArgs` and frozen. Nothing after this reads Settings or the args again.
 */
export interface TranslationSnapshot {
  readonly model: string
  /** The registry value (`pt-BR`). */
  readonly targetLanguage: string
  /** The prompt name (`Brazilian Portuguese`). */
  readonly targetName: string
  /** The registry value, or `null` for Auto Detect. */
  readonly sourceLanguage: string | null
  /** As sent: 1.1.0's `-d`, with the source language folded in. `''` when there is none. */
  readonly description: string
  /** Trimmed override, `''` when blank. */
  readonly guidanceOverride: string
  readonly batchContext: boolean
  /** Previous Context Cues (D15-1R): how many earlier source lines the block may carry. */
  readonly batchContextLines: number
  /** A media file is attached to every batch. */
  readonly media: boolean
  readonly structuredOutput: boolean
  readonly instruction: string
  readonly generation: Readonly<Pick<ProviderRequest, 'temperature' | 'topP' | 'topK' | 'serviceTier'>> & {
    readonly thinking?: Readonly<NonNullable<ProviderRequest['thinking']>>
  }
}

/**
 * The run snapshot. The description is 1.1.0's: trimmed, and a chosen source language becomes a
 * leading `Source language: <name>.` because gst has no source flag (`pythonBridge.ts:495-501`).
 * Generation fields are `modelRequestConfig`'s, as for Transcribe.
 */
export function translationSnapshot(args: TranslateArgs): TranslationSnapshot {
  const targetName = gstLanguageName(args.targetLang)
  if (!targetName) throw new TypeError('A translation needs a target language.')
  const source = args.sourceLang && args.sourceLang !== 'auto' ? args.sourceLang : ''
  const sourceName = source ? gstLanguageName(source) : ''
  let description = args.description?.trim() ?? ''
  if (sourceName) description = `Source language: ${sourceName}.${description ? ' ' + description : ''}`
  const guidanceOverride = args.systemPrompt?.trim() ?? ''
  const media = Boolean(args.audioFile)
  const rc = modelRequestConfig({
    kind: 'translate',
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    thinkingBudget: args.thinkingBudget,
    customGenerationParams: args.customGenerationParams,
    temperature: args.temperature,
    topP: args.topP,
    topK: args.topK,
    serviceTier: args.serviceTier
  })
  const generation: TranslationSnapshot['generation'] = Object.freeze({
    ...(rc.thinking ? { thinking: Object.freeze({ ...rc.thinking }) } : {}),
    ...(rc.temperature !== undefined ? { temperature: rc.temperature } : {}),
    ...(rc.topP !== undefined ? { topP: rc.topP } : {}),
    ...(rc.topK !== undefined ? { topK: rc.topK } : {}),
    ...(rc.serviceTier ? { serviceTier: rc.serviceTier } : {})
  })
  return Object.freeze({
    model: args.model,
    targetLanguage: canonicalLanguage(args.targetLang) || args.targetLang,
    targetName,
    sourceLanguage: source ? canonicalLanguage(source) || source : null,
    description,
    guidanceOverride,
    batchContext: args.batchContext,
    batchContextLines: snapshotContextLines(args.batchContextLines),
    media,
    structuredOutput: modelCapabilities(args.model).structuredOutput,
    instruction: translateInstruction({
      language: targetName,
      thinking: true,
      thinkingCompatible: thinkingCompatible(args.model),
      audio: media,
      ...(description ? { description } : {}),
      ...(guidanceOverride ? { guidanceOverride } : {})
    }),
    generation
  })
}

/** Args that predate the count read as the default; anything else outside 4–10 is refused, never repaired here. */
function snapshotContextLines(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_CONTEXT_LINES
  if (!Number.isSafeInteger(value) || value < MIN_BATCH_CONTEXT_LINES || value > MAX_BATCH_CONTEXT_LINES) {
    throw new TypeError(`Previous Context Cues is a whole number from ${MIN_BATCH_CONTEXT_LINES} to ${MAX_BATCH_CONTEXT_LINES}.`)
  }
  return value
}

/** Committed cues and their accepted translations: the first Continue's pair (F15-P4, D6-9). */
export interface TranslationContext {
  /** The pair's cues, in source order. */
  readonly cues: readonly Cue[]
  /**
   * `TranslationState.acceptedTranslations`, by cue number: the only text the model turn may carry
   * (D6-9 assertion 2). Every context cue must be in it.
   */
  readonly accepted: ReadonlyMap<number, string>
}

/** One previous source line as the Cross-Batch Context block carries it (D15-3R): wire index, source text. */
export interface SourceContextLine {
  readonly index: string
  readonly text: string
}

/** The block's heading line, byte for byte as tested (`v3-core.mjs:946-951`). */
export const SOURCE_CONTEXT_HEADING = 'PREVIOUS SOURCE CONTEXT (continuity only; do not translate or output):'

/** Appended to the system instruction only when a request carries a non-empty block (D15-3R item 2). */
export const SOURCE_CONTEXT_INSTRUCTION =
  'Previous source context, when supplied, exists only to preserve discourse, terminology, names, speaker/addressee continuity and story state across the batch boundary; translate only the current items and never output the previous source context.'

/**
 * With a block, the part between it and the batch (`v3-core.mjs:1005`). Without it, at Batch Size 100,
 * Flash-Lite 3.5 answered with only the batch's last lines (gate_ledger.md §5o.7, tester TD15-4).
 */
export const CURRENT_INPUT_LABEL = 'CURRENT INPUT:'

/**
 * With a block, appended to the system instruction after `SOURCE_CONTEXT_INSTRUCTION`. It states the
 * count and the first and last index rather than v3's full list (`v3-core.mjs:879`), which cost about
 * 440 prompt tokens more per request at Batch Size 100 with no reliability gain measured (tester
 * TD15-4, gate_ledger.md §5o.8). `indices` is one batch's wire indices, which are contiguous.
 */
export function currentIndicesInstruction(indices: readonly string[]): string {
  const first = indices[0]
  const last = indices[indices.length - 1]
  return indices.length === 1
    ? `Return exactly 1 object, one per current input item, with index ${first} only.`
    : `Return exactly ${indices.length} objects, one per current input item, with indices ${first} to ${last} only.`
}

/**
 * The previous source lines for a request whose first cue is at 0-based `startPosition` (D15-3R/D15-4R):
 * the fixed window `[max(0, start - lines), start)`, keeping a position only when it is in
 * `committedAccepted` — the 0-based positions whose translations were committed-accepted before this
 * request was built — and its source is not blank. Nothing replaces an excluded position. Reads no
 * Settings, provider, translation text or target language.
 */
export function selectSourceBatchContext(
  sourceCues: readonly Cue[],
  startPosition: number,
  lines: number,
  committedAccepted: ReadonlySet<number>
): SourceContextLine[] {
  if (!Number.isSafeInteger(startPosition) || startPosition < 0 || startPosition >= sourceCues.length) {
    throw new TypeError('A request starts at a cue of its source.')
  }
  if (!Number.isSafeInteger(lines) || lines < MIN_BATCH_CONTEXT_LINES || lines > MAX_BATCH_CONTEXT_LINES) {
    throw new TypeError(`Previous Context Cues is a whole number from ${MIN_BATCH_CONTEXT_LINES} to ${MAX_BATCH_CONTEXT_LINES}.`)
  }
  const out: SourceContextLine[] = []
  for (let p = Math.max(0, startPosition - lines); p < startPosition; p++) {
    const text = sourceCues[p].text
    if (committedAccepted.has(p) && text.trim()) out.push(Object.freeze({ index: String(p), text }))
  }
  return out
}

/** The D15-3R block for the selected lines, or `null` when there are none (no block at all). */
export function formatSourceContextBlock(lines: readonly SourceContextLine[]): string | null {
  if (!lines.length) return null
  return `${SOURCE_CONTEXT_HEADING}\n${JSON.stringify(lines.map((l) => ({ index: l.index, text: l.text })))}`
}

/** What a request inside a batch's recovery tree builds its block from (§17.8R PR-1). */
export interface TreeContextInput {
  readonly source: readonly Cue[]
  /** 0-based position of the request's own first cue. */
  readonly startPosition: number
  readonly lines: number
  /** 0-based positions committed-accepted before this request was built. */
  readonly committedAccepted: ReadonlySet<number>
  /** Cue numbers staged as accepted earlier in this tree (`RecoveryTree.stagedAccepted`): status only. */
  readonly stagedAccepted: ReadonlySet<number>
  /**
   * D6-9's context-isolation capability: a property of the recursion node, inherited by every
   * descendant, under which the node's requests carry no block. It exists for a preserved cue whose
   * source is carried, and none is (`contextEligible` is false for every reason), so no caller sets it.
   */
  readonly isolated: boolean
}

/**
 * Bundle G (§17.8R PR-1, D6-9): a recovery request's previous source lines. The same fixed window
 * `[s − W, s)` from the request's OWN first cue, over committed ∪ staged-accepted positions. A tree's
 * staged translations, a raw reply and the output are never read, and a preserved cue (every
 * reason), a missing or in-flight cue and a blank source stay out, with no backfill.
 */
export function treeSourceContext(input: TreeContextInput): SourceContextLine[] {
  if (input.isolated) return []
  const eligible = new Set(input.committedAccepted)
  for (const cue of input.stagedAccepted) eligible.add(cue - 1)
  return selectSourceBatchContext(input.source, input.startPosition, input.lines, eligible)
}

// ── Bundle H: the gender-reference block, section (3) (feature_decisions.md §2.1–§2.2) ─────────────────
//
// Port source: the Kodi add-on 0.2.533 `prompt.py` (`build_gender_block` :271-322, `_arabic_block_text`
// :330-369, `_GENDER_SIGNALS` :214-248, `_FIDELITY_CLAUSE` :252-268, `LANG_NAME` :8-17) and its per-request
// assembly `translate.py:4001-4034`. The Hebrew-target strings are verbatim. NG-authored rows are marked.

/** `prompt.py:8-17`. */
const ORACLE_LANG_NAME: Readonly<Record<string, string>> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', ru: 'Russian', ar: 'Arabic',
  tr: 'Turkish', pl: 'Polish', nl: 'Dutch', el: 'Greek', fa: 'Persian', hi: 'Hindi', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', cs: 'Czech', ro: 'Romanian', sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', hu: 'Hungarian',
  uk: 'Ukrainian', bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', th: 'Thai', id: 'Indonesian', vi: 'Vietnamese', he: 'Hebrew',
  sk: 'Slovak', ur: 'Urdu'
}

/**
 * How each REFERENCE language marks gender. `prompt.py:214-248` verbatim, plus three NG-authored rows: `de`
 * (W-de-5, feature_decisions.md §3.4: articles / adjective agreement / er-sie), and `he` / `ar`, which a
 * non-Hebrew target needs because the add-on gives those two dedicated Hebrew-output blocks instead (§2.2).
 */
export const GENDER_SIGNALS: Readonly<Record<string, string>> = Object.freeze({
  es: 'adjectives and participles end in -o (masc) / -a (fem); pronouns and articles (el/ella, este/esta) mark referent gender',
  fr: 'adjectives and past participles agree in gender (fatigué/fatiguée, il/elle); "tu es ...e" endings mark the ADDRESSEE as feminine',
  ru: 'past-tense verbs mark the SPEAKER/subject gender (сказал/сказала, устал/устала); adjectives agree in gender',
  it: 'adjectives and participles end in -o (masc) / -a (fem) (stanco/stanca, sei sicuro/sicura); lui/lei mark referents',
  pt: 'adjectives and participles end in -o (masc) / -a (fem) (cansado/cansada, obrigado/obrigada); ele/ela mark referents',
  pl: 'past-tense verbs mark gender (zrobiłem/zrobiłam for the speaker, zrobiłeś/zrobiłaś for the addressee); adjectives agree',
  uk: 'past-tense verbs mark the speaker/subject gender (сказав/сказала); adjectives agree in gender',
  hi: 'verbs inflect for gender (karta/karti hoon marks the SPEAKER, karte/karti ho the ADDRESSEE); adjectives in -a/-i agree',
  cs: 'past-tense verbs mark gender (řekl/řekla, byl jsi/byla jsi for the addressee); adjectives agree',
  ro: 'adjectives and participles agree in gender (obosit/obosită, sigur/sigură); el/ea mark referents',
  el: 'articles, adjectives and participles mark gender (κουρασμένος/κουρασμένη, αυτός/αυτή)',
  bg: 'past-tense verbs mark gender (казал/казала, уморен/уморена); adjectives agree',
  sr: 'past participles mark gender (rekao/rekla, umoran/umorna for speaker and addressee); adjectives agree',
  hr: 'past participles mark gender (rekao/rekla, umoran/umorna for speaker and addressee); adjectives agree',
  sk: 'past-tense verbs mark gender (povedal/povedala, bol si/bola si for the addressee); adjectives agree',
  ur: 'verbs inflect for gender (karta/karti hoon marks the SPEAKER, karte/karti ho the ADDRESSEE); adjectives agree',
  nl: 'pronouns (hij/zij, hem/haar) mark referent gender',
  // NG-authored (W-de-5).
  de: 'articles and adjective endings agree with the noun’s gender (der/die, ein müder Mann / eine müde Frau); er/sie and ihn/sie mark referents',
  // NG-authored: Hebrew and Arabic read as references for a non-Hebrew target.
  he: 'second-person pronouns and verbs mark the ADDRESSEE (אתה/את, תעשה/תעשי), and present-tense verbs and adjectives mark the speaker and referents (עייף/עייפה)',
  ar: 'second-person pronouns and endings mark the ADDRESSEE (أنتَ/أنتِ, ـكَ/ـكِ, present verbs in ـين, imperatives in ـي), and adjectives mark the speaker (متأكد/متأكدة)'
})

/**
 * How to WRITE gender in each non-Hebrew target (§2.2's second table; NG-authored). A target that has a
 * `_GENDER_SIGNALS` row reuses that sentence; Arabic uses the Arabic side of `_arabic_block_text` with its
 * Hebrew arrows dropped. No row contains a Hebrew form or "natural Hebrew".
 */
export const OUTPUT_MORPHOLOGY: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(['es', 'fr', 'ru', 'it', 'pt', 'pl', 'uk', 'hi', 'cs', 'ro', 'el', 'bg', 'sr', 'hr', 'sk', 'ur', 'nl'].map((k) => [k, GENDER_SIGNALS[k]])),
  ar: 'feminine addressee: أنتِ, a ـكِ ending, a present verb ending ـين, a feminine imperative ending ـي; masculine addressee: أنتَ, a ـكَ ending, a present verb without ـين, a masculine imperative; a feminine speaker takes feminine 1st-person adjectives (متأكدة)'
})

/** `_ORACLE_HINT_TARGETS` (§2.1): Hebrew, and every target with an output-morphology row. */
export const ORACLE_HINT_TARGETS: readonly string[] = Object.freeze(['he', ...Object.keys(OUTPUT_MORPHOLOGY)])

/** `translate.py:49-51`: per-line Arabic carrying one of these is not sent (tester, Round 19: port the skip). */
export const AR_EXPLICIT_MARKERS: readonly string[] = Object.freeze(['اغتص', 'غتصب', 'اغتُص', 'تعذيب', 'عذّب', 'عذب', 'عاهر', 'الاغتصاب'])

/** `prompt.py:252-268`, verbatim; Hebrew-output copy. */
const FIDELITY_CLAUSE = (ref: string): string =>
  'FIDELITY (critical -- read carefully): translate the SOURCE text ' +
  `itself, completely and in natural Hebrew. The ${ref} reference is ONLY a ` +
  'gender oracle. Take from it the gender and NOTHING else -- not wording, ' +
  'not phrasing, not length, not meaning. Specifically:\n' +
  '  * Translate EVERY source word and detail. Do not drop, shorten, ' +
  'merge or summarise -- keep fillers ("uh", "well", "look"), repetitions ' +
  '("I don\'t... I don\'t..."), intensifiers and profanity ("fucking"), ' +
  'and small words like "out", "in there", "back", "just".\n' +
  `  * The ${ref} human translation is often SHORTER or looser than the ` +
  "source -- IGNORE that. Match the source, not the reference's brevity.\n" +
  '  * Proper nouns, place names, slang and idioms come from the SOURCE ' +
  'meaning -- NEVER transliterate the reference. Render slang/idioms ' +
  'naturally from the source.\n' +
  '  * If the reference paraphrases, omits, or differs from the source in ' +
  'ANY way, follow the SOURCE and ignore the reference difference.\n'

/** `_arabic_block_text` (`prompt.py:330-369`), verbatim: the field-validated 27% → 90%+ wording (§2.2). */
function arabicBlockText(body: string): string {
  return (
    'ARABIC GENDER REFERENCE -- HARD CONSTRAINT, NOT A HINT.\n' +
    'For some entries below, the line from a PROFESSIONAL HUMAN Arabic ' +
    'translation of the SAME scene is given. Arabic, like Hebrew, ' +
    'explicitly marks the gender of the ADDRESSEE and the SPEAKER. For each ' +
    'such entry you MUST make the Hebrew agree in gender with its Arabic. ' +
    'Do NOT default to masculine -- read the markers and match them:\n' +
    '- ADDRESSEE FEMININE when the Arabic has أنتِ , a ـكِ ending, a present ' +
    'verb ending ـين (تحاولين/تفعلين), or a feminine imperative ending ـي ' +
    '(اسمعي، دعيني، أغلقي، ابتعدي) -> Hebrew feminine: את / תקשיבי / תני.\n' +
    '- ADDRESSEE MASCULINE when the Arabic has أنتَ , a ـكَ ending, a present ' +
    'verb without ـين (تعرف/تحاول), or a masculine imperative (اسمع، دع، ' +
    'أغلق، ابتعد) -> Hebrew masculine: אתה / תקשיב / תן.\n' +
    '- SPEAKER FEMININE when the Arabic 1st-person adjective is feminine ' +
    '(محظوظة، ناضجة، متأكدة) -> Hebrew feminine 1st person (אני בטוחה).\n' +
    '- Entry not listed / Arabic gender-neutral -> use the cast block + ' +
    'context instead.\n' +
    'FIDELITY (critical -- read carefully): translate the ENGLISH text ' +
    'itself, completely and in natural Hebrew. The Arabic is ONLY a gender ' +
    'oracle. Take from it the gender and NOTHING else -- not wording, not ' +
    'phrasing, not length, not meaning. Specifically:\n' +
    '  * Translate EVERY English word and detail. Do not drop, shorten, ' +
    'merge or summarise -- keep fillers ("uh", "well", "look"), repetitions ' +
    '("I don\'t... I don\'t..."), intensifiers and profanity ("fucking"), ' +
    'and small words like "out", "in there", "back", "just".\n' +
    '  * The Arabic human translation is often SHORTER or looser than the ' +
    "English -- IGNORE that. Match the English, not the Arabic's brevity.\n" +
    '  * Proper nouns, place names, slang and idioms come from the ENGLISH ' +
    'meaning -- e.g. "Colony House" -> "בית המושבה" (translate it; NEVER ' +
    'transliterate the Arabic). Render slang/idioms naturally from English.\n' +
    '  * If the Arabic paraphrases, omits, or differs from the English in ' +
    'ANY way, follow the ENGLISH and ignore the Arabic difference.\n' +
    'Per-entry Arabic (entry_number: arabic_line):\n' +
    body +
    '\n\n'
  )
}

/** The dedicated Hebrew-reference block (`prompt.py:287-302`), verbatim. */
function hebrewBlockText(body: string): string {
  return (
    'HEBREW GENDER REFERENCE -- GENDER EVIDENCE, SUBJECT TO SOURCE FIDELITY.\n' +
    'For some entries below, the line from a PROFESSIONAL HUMAN Hebrew ' +
    'translation of the SAME scene is given (it comes from a different ' +
    'video cut, so its wording may be aligned imperfectly). Hebrew ' +
    'marks gender everywhere; for each such entry when consistent with explicit source evidence, make your ' +
    'Hebrew agree in SPEAKER / ADDRESSEE / REFERENT gender with the ' +
    'reference line (אתה/את, masculine/feminine verbs and adjectives). ' +
    'Do NOT default to masculine -- read the reference and match it.\n' +
    '- Entry not listed / reference gender-neutral -> use the cast ' +
    'block + context instead.\n' +
    FIDELITY_CLAUSE('Hebrew') +
    'Per-entry Hebrew reference (entry_number: hebrew_line):\n' +
    body +
    '\n\n' +
    'SOURCE PRIORITY: If the source explicitly establishes gender or relationship (for example daughter versus son), it overrides a contradictory reference. Never change daughter into son or another source fact to match the reference. Use reference gender when the source does not settle it. Apply this separately to speaker, listener and referent; do not guess a new speaker from adjacency.\n\n'
  )
}

/** The generic Hebrew-target block for any other reference with a signals row (`prompt.py:303-322`), verbatim. */
function genericHebrewBlockText(lang: string, body: string): string {
  const name = ORACLE_LANG_NAME[lang] ?? lang.toUpperCase()
  return (
    `${name.toUpperCase()} GENDER REFERENCE -- HARD CONSTRAINT, NOT A HINT.\n` +
    `For some entries below, the line from a PROFESSIONAL HUMAN ${name} ` +
    `translation of the SAME scene is given. In ${name}, ${GENDER_SIGNALS[lang]}. For each such ` +
    'entry you MUST make the Hebrew agree in gender with the reference: ' +
    `identify from the ${name} line whether the SPEAKER, the ADDRESSEE or a ` +
    'REFERENT is masculine or feminine, and pick the matching Hebrew ' +
    'forms (אתה/את, masculine/feminine verbs and adjectives). Do NOT ' +
    'default to masculine -- read the markers and match them.\n' +
    '- Entry not listed / reference gender-neutral -> use the cast ' +
    'block + context instead.\n' +
    FIDELITY_CLAUSE(name) +
    `Per-entry ${name} reference (entry_number: reference_line):\n` +
    body +
    '\n\n'
  )
}

/**
 * A non-Hebrew target (§2.2 assembly, NG-authored): the generic block's structure with the output written in
 * the target's own forms (`OUTPUT_MORPHOLOGY[tgt]`), the reference read by `GENDER_SIGNALS[ref]`, and the
 * fidelity clause parameterised by both names — never the Hebrew-output copy.
 */
function otherTargetBlockText(target: string, lang: string, body: string): string {
  const out = ORACLE_LANG_NAME[target] ?? target.toUpperCase()
  const ref = ORACLE_LANG_NAME[lang] ?? lang.toUpperCase()
  return (
    `${ref.toUpperCase()} GENDER REFERENCE -- HARD CONSTRAINT, NOT A HINT.\n` +
    `For some entries below, the line from a PROFESSIONAL HUMAN ${ref} ` +
    `translation of the SAME scene is given. In ${ref}, ${GENDER_SIGNALS[lang]}. For each such ` +
    `entry you MUST make the ${out} agree in gender with the reference: ` +
    `identify from the ${ref} line whether the SPEAKER, the ADDRESSEE or a ` +
    `REFERENT is masculine or feminine, and pick the matching ${out} ` +
    `forms (in ${out}, ${OUTPUT_MORPHOLOGY[target]}). Do NOT ` +
    'default to masculine -- read the markers and match them.\n' +
    '- Entry not listed / reference gender-neutral -> use the cast ' +
    'block + context instead.\n' +
    'FIDELITY (critical -- read carefully): translate the SOURCE text ' +
    `itself, completely and in natural ${out}. The ${ref} reference is ONLY a ` +
    'gender oracle. Take from it the gender and NOTHING else -- not wording, ' +
    'not phrasing, not length, not meaning. Specifically:\n' +
    '  * Translate EVERY source word and detail. Do not drop, shorten, ' +
    'merge or summarise -- keep fillers ("uh", "well", "look"), repetitions ' +
    '("I don\'t... I don\'t..."), intensifiers and profanity ("fucking"), ' +
    'and small words like "out", "in there", "back", "just".\n' +
    `  * The ${ref} human translation is often SHORTER or looser than the ` +
    "source -- IGNORE that. Match the source, not the reference's brevity.\n" +
    '  * Proper nouns, place names, slang and idioms come from the SOURCE ' +
    'meaning -- NEVER transliterate the reference. Render slang/idioms ' +
    'naturally from the source.\n' +
    '  * If the reference paraphrases, omits, or differs from the source in ' +
    'ANY way, follow the SOURCE and ignore the reference difference.\n' +
    `Per-entry ${ref} reference (entry_number: reference_line):\n` +
    body +
    '\n\n'
  )
}

/** The two strengths (§2.2). Hint changes exactly two phrases and nothing else. */
export type { OracleStrength }

export function hintWording(block: string): string {
  return block.replace('HARD CONSTRAINT, NOT A HINT', 'HINT').replace('you MUST make', 'prefer to make, when the reference marks gender unambiguously')
}

/**
 * The default strength (§2.2, E48): Hard for a Hebrew target, except a German reference, which is Hint unless
 * this run's Hard-German confirmation is on; Hint for any other target.
 */
export function defaultOracleStrength(targetLanguage: string, referenceLanguage: string, hardGermanConfirmed: boolean): OracleStrength {
  if (baseLanguage(targetLanguage) !== 'he') return 'hint'
  if (baseLanguage(referenceLanguage) === 'de') return hardGermanConfirmed ? 'hard' : 'hint'
  return 'hard'
}

function baseLanguage(value: string): string {
  return value.trim().split(/[-_]/)[0].toLowerCase()
}

/** A run's aligned reference: cue number → the reference line aligned to it, in one language, at one strength. */
export interface OracleInput {
  /** The reference file's language (`ar`, `he`, `es`, … `de`). */
  readonly language: string
  readonly strength: OracleStrength
  /** NG `Cue.index` → aligned reference text. The whole run's map; each request takes only its own cues. */
  readonly lines: ReadonlyMap<number, string>
}

/**
 * Section (3) for one request, or `null` when it has nothing to say: no entry for these cues (after blank and
 * Arabic-marker lines are dropped), a target with no assembly row, or a reference language with no wording for
 * that target. Rows are keyed by the request's own wire index, so they line up with the batch JSON.
 */
export function oracleBlock(target: string, oracle: OracleInput, cues: readonly Cue[]): string | null {
  const tgt = baseLanguage(target)
  const ref = baseLanguage(oracle.language)
  const wire = new Map(requestedLines(cues).map((l, i) => [cues[i].index, l.index]))
  const rows: string[] = []
  for (const cue of cues) {
    const text = oracle.lines.get(cue.index)
    if (!text || !text.trim()) continue
    if (ref === 'ar' && AR_EXPLICIT_MARKERS.some((m) => text.includes(m))) continue
    rows.push(`${wire.get(cue.index)}: ${text}`)
  }
  if (!rows.length) return null
  const body = rows.join('\n')
  let block: string | null
  if (tgt === 'he') block = ref === 'ar' ? arabicBlockText(body) : ref === 'he' ? hebrewBlockText(body) : GENDER_SIGNALS[ref] ? genericHebrewBlockText(ref, body) : null
  else block = OUTPUT_MORPHOLOGY[tgt] && GENDER_SIGNALS[ref] ? otherTargetBlockText(tgt, ref, body) : null
  if (!block) return null
  return oracle.strength === 'hint' ? hintWording(block) : block
}

/** Where bundles attach request content. */
export interface TranslationInjections {
  /**
   * Bundle H: the run's aligned reference. The request builder slices it to the request's own cues (H-G,
   * §17.9a), so a call site can pass the whole run's map and no request ever carries another request's lines.
   */
  readonly oracle?: OracleInput | null
  /**
   * Bundle L: `selectSourceBatchContext`'s lines for this request. Sent only with Context ON; an empty
   * list sends nothing. Never with a context pair.
   */
  readonly sourceContext?: readonly SourceContextLine[]
}

export interface TranslationBatchInput {
  /** This batch's source cues, contiguous and in order. */
  readonly cues: readonly Cue[]
  /**
   * The only model turn a request can carry (Phase 3; tester waiver, gate_ledger.md §5j.0): the first
   * Continue's `resumeContextSize` pair, or that pair reused by its retry pieces. Sent whatever
   * `batchContext` says, and it may end before the cue right before this batch. Never with a block.
   */
  readonly resumeContext?: TranslationContext | null
  /** This batch's media slice; required exactly when the snapshot has media. */
  readonly audio?: { readonly mimeType: string; readonly data: string } | null
  readonly injections?: TranslationInjections
}

/** One built request and the content-free facts its receipt reports. */
export interface PreparedTranslationRequest {
  /** Deep-frozen; the object generation (and any token count) is given. */
  readonly request: ProviderRequest
  readonly targetLanguage: string
  readonly sourceLanguage: string | null
  readonly requestedIndices: readonly number[]
  readonly hasDescription: boolean
  readonly hasSystemPromptOverride: boolean
  readonly hasContextPair: boolean
  readonly hasOracleBlock: boolean
  readonly responseSchemaId: string
}

/** Python's `json.dumps(value, ensure_ascii=False)` for a list of flat string records, as gst sends it. */
function pyJsonDumps(items: ReadonlyArray<Readonly<Record<string, string>>>): string {
  const record = (o: Readonly<Record<string, string>>): string =>
    '{' + Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + '}'
  return '[' + items.map(record).join(', ') + ']'
}

/** `utils.py:160-168`: whole seconds from the batch start, `MM:SS`, with Python's floor `divmod`. */
function batchTime(ms: number, offsetSeconds: number): string {
  const total = Math.floor(ms / 1000) - offsetSeconds
  const minutes = Math.floor(total / 60)
  const seconds = total - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** gst's batch items (`main.py:828-842`): wire index, source text, and media times when attached. */
function wireItems(cues: readonly Cue[], media: boolean): Record<string, string>[] {
  const lines = requestedLines(cues)
  const offset = media && cues.length ? Math.floor(cues[0].startMs / 1000) : 0
  return lines.map((line, i) => {
    const item: Record<string, string> = { index: String(line.index), text: line.text }
    if (media) {
      item.time_start = batchTime(cues[i].startMs, offset)
      item.time_end = batchTime(cues[i].endMs, offset)
    }
    return item
  })
}

function contiguous(cues: readonly Cue[]): boolean {
  return cues.every((c, i) => i === 0 || c.index === cues[i - 1].index + 1)
}

function ascending(cues: readonly Cue[]): boolean {
  return cues.every((c, i) => i === 0 || c.index > cues[i - 1].index)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  }
  return value
}

/**
 * One batch's provider-ready request.
 *
 * The current user turn is gst's: the batch JSON, then this batch's media (`main.py:1188-1196`).
 *
 * With `injections.oracle`, the gender-reference block for this request's own cues comes first (section (3),
 * feature_decisions.md §2.2; H-G). The system instruction is untouched, and a request with no oracle entry
 * for its cues is byte-identical to one built without an oracle (H14).
 *
 * With Context ON and a non-empty `injections.sourceContext` (D15-3R), the D15-3R block and then
 * `CURRENT_INPUT_LABEL` come before the batch JSON, and `SOURCE_CONTEXT_INSTRUCTION` and
 * `currentIndicesInstruction` are appended to the system instruction (TD15-4). OFF, or an empty list,
 * leaves the request byte-identical to one built without it.
 *
 * A `resumeContext` is sent instead as one pair before the current turn (F15-P4): a `user` turn holding
 * those cues as they would be sent — text only, never media (F15-P6) — and a `model` turn holding their
 * ACCEPTED translations as `[{index, text}]`, the shape gst rebuilds a resumed pair in
 * (`main.py:748-762`). It is built from the accepted map and never from a raw reply, so it cannot carry
 * an unaccepted line (D6-9 (a)/(a2)), and it carries no thought signature: the text is not the text the
 * signature was issued for.
 */
export function translationRequest(snapshot: TranslationSnapshot, batch: TranslationBatchInput): PreparedTranslationRequest {
  const cues = batch.cues
  if (!cues.length) throw new TypeError('A translation request needs at least one cue.')
  if (!contiguous(cues)) throw new TypeError('A batch is a contiguous run of cues.')
  const audio = batch.audio ?? null
  if (snapshot.media !== Boolean(audio)) {
    throw new TypeError(snapshot.media ? 'This run attaches media to every batch.' : 'This run has no media to attach.')
  }
  const oracle = batch.injections?.oracle ? oracleBlock(snapshot.targetLanguage, batch.injections.oracle, cues) : null

  const sourceLines = snapshot.batchContext ? (batch.injections?.sourceContext ?? []) : []
  if (sourceLines.length) {
    if (batch.resumeContext?.cues.length) {
      throw new TypeError('A request carries previous source context or a context pair, not both.')
    }
    const start = cues[0].index - 1
    let last = start - snapshot.batchContextLines - 1
    for (const line of sourceLines) {
      const p = Number(line.index)
      if (!Number.isSafeInteger(p) || String(p) !== line.index || p < 0 || p <= last || p >= start) {
        throw new TypeError('Previous source context is ascending positions inside the window before this batch.')
      }
      if (!line.text.trim()) throw new TypeError('Previous source context carries no blank line.')
      last = p
    }
  }
  const block = formatSourceContextBlock(sourceLines)

  const items = wireItems(cues, snapshot.media)
  const parts: ProviderPart[] = []
  if (oracle) parts.push({ text: oracle })
  if (block) parts.push({ text: block }, { text: CURRENT_INPUT_LABEL })
  parts.push({ text: pyJsonDumps(items) })
  if (audio) parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.data } })

  const pinned = batch.resumeContext?.cues.length ? batch.resumeContext : null
  let history: ProviderTurn[] | undefined
  if (pinned) {
    const prior = pinned.cues
    // Strictly ascending, not contiguous: a cue preserved after a block is left out of both turns (PR-3).
    if (!ascending(prior) || prior[prior.length - 1].index >= cues[0].index) throw new TypeError('A resume context comes before its batch.')
    const accepted = prior.map((c) => {
      const text = pinned.accepted.get(c.index)
      if (text === undefined) throw new TypeError(`Context cue ${c.index} was not accepted.`)
      return { index: String(c.index - 1), text }
    })
    history = [
      { role: 'user', parts: [{ text: pyJsonDumps(wireItems(prior, snapshot.media)) }] },
      { role: 'model', parts: [{ text: pyJsonDumps(accepted) }] }
    ]
  }

  const request: ProviderRequest = {
    model: snapshot.model,
    systemInstruction: block
      ? `${snapshot.instruction}\n---\n${SOURCE_CONTEXT_INSTRUCTION}\n---\n${currentIndicesInstruction(items.map((i) => i.index))}`
      : snapshot.instruction,
    ...(history ? { history } : {}),
    parts,
    ...(snapshot.structuredOutput
      ? { responseMimeType: 'application/json', responseJsonSchema: translationResponseSchema() }
      : {}),
    ...(snapshot.generation.thinking ? { thinking: { ...snapshot.generation.thinking } } : {}),
    ...(snapshot.generation.temperature !== undefined ? { temperature: snapshot.generation.temperature } : {}),
    ...(snapshot.generation.topP !== undefined ? { topP: snapshot.generation.topP } : {}),
    ...(snapshot.generation.topK !== undefined ? { topK: snapshot.generation.topK } : {}),
    ...(snapshot.generation.serviceTier ? { serviceTier: snapshot.generation.serviceTier } : {})
  }

  return Object.freeze({
    request: deepFreeze(request),
    targetLanguage: snapshot.targetLanguage,
    sourceLanguage: snapshot.sourceLanguage,
    requestedIndices: Object.freeze(requestedLines(cues).map((l) => l.index)),
    hasDescription: snapshot.description !== '',
    hasSystemPromptOverride: snapshot.guidanceOverride !== '',
    hasContextPair: Boolean(history),
    hasOracleBlock: oracle !== null,
    responseSchemaId: snapshot.structuredOutput ? TRANSLATION_RESPONSE_SCHEMA_ID : 'none'
  })
}

/**
 * Bundle H's one repair request (0.2.533 `translate.py:4481-4487`): the repair prompt alone — no system
 * instruction, no schema — on the run's model at temperature 0, with the run's top-p and thinking. Its
 * requested indices are the flagged cues' wire numbers, so the receipt names lines and never text.
 */
export function genderRepairRequest(snapshot: TranslationSnapshot, prompt: string, flagged: readonly number[]): PreparedTranslationRequest {
  return promptOnlyRequest(snapshot, prompt, flagged, null)
}

/**
 * Feature 17 Method B's one blind classification request: the repair request's shape (same model and run
 * settings, temperature 0, no system instruction or schema) with a JSON reply, as `gender_extras_research.py:705-706`.
 */
export function methodBClassifyRequest(snapshot: TranslationSnapshot, prompt: string, unread: readonly number[]): PreparedTranslationRequest {
  return promptOnlyRequest(snapshot, prompt, unread, 'application/json')
}

/** Round 19A A.7's other-alphabet repair: the gender repair request's shape, one plain SRT reply. */
export function strayAlphabetRequest(snapshot: TranslationSnapshot, prompt: string, affected: readonly number[]): PreparedTranslationRequest {
  return promptOnlyRequest(snapshot, prompt, affected, null)
}

function promptOnlyRequest(snapshot: TranslationSnapshot, prompt: string, flagged: readonly number[], responseMimeType: string | null): PreparedTranslationRequest {
  if (!prompt) throw new TypeError('A repair request needs a prompt.')
  const request: ProviderRequest = {
    model: snapshot.model,
    parts: [{ text: prompt }],
    ...(responseMimeType ? { responseMimeType } : {}),
    temperature: 0,
    ...(snapshot.generation.topP !== undefined ? { topP: snapshot.generation.topP } : {}),
    ...(snapshot.generation.thinking ? { thinking: { ...snapshot.generation.thinking } } : {}),
    ...(snapshot.generation.serviceTier ? { serviceTier: snapshot.generation.serviceTier } : {})
  }
  return Object.freeze({
    request: deepFreeze(request),
    targetLanguage: snapshot.targetLanguage,
    sourceLanguage: snapshot.sourceLanguage,
    requestedIndices: Object.freeze(flagged.map((i) => i - 1)),
    hasDescription: false,
    hasSystemPromptOverride: false,
    hasContextPair: false,
    hasOracleBlock: false,
    responseSchemaId: 'none'
  })
}

/** What only the dispatch knows: which slot and group, and the bounds the call runs under. */
export interface RequestDispatchFacts {
  effectiveSlot: number
  quotaGroupId: string | null
  timeoutMs: number
  responseLimitBytes: number
  outputTokenLimit: number | null
  /** The provider's fixed safety settings (`GEMINI_SAFETY_SETTINGS.length`). */
  safetySettingCount: number
}

const GENERATION_FIELDS: ReadonlyArray<[string, (r: ProviderRequest) => unknown]> = [
  ['maxOutputTokens', (r) => r.maxOutputTokens],
  ['temperature', (r) => r.temperature],
  ['topP', (r) => r.topP],
  ['topK', (r) => r.topK],
  ['thinking.level', (r) => r.thinking?.level],
  ['thinking.budget', (r) => r.thinking?.budget],
  ['thinking.includeThoughts', (r) => r.thinking?.includeThoughts],
  ['serviceTier', (r) => r.serviceTier]
]

/** The §14.3 receipt for one dispatch of a prepared request. Content-free by construction. */
export function providerRequestReceipt(prepared: PreparedTranslationRequest, call: RequestDispatchFacts): ProviderRequestReceipt {
  const r = prepared.request
  return {
    model: r.model,
    effectiveSlot: call.effectiveSlot,
    quotaGroupId: call.quotaGroupId,
    targetLanguage: prepared.targetLanguage,
    sourceLanguage: prepared.sourceLanguage,
    requestedIndices: [...prepared.requestedIndices],
    hasDescription: prepared.hasDescription,
    hasSystemPromptOverride: prepared.hasSystemPromptOverride,
    hasContextPair: prepared.hasContextPair,
    hasOracleBlock: prepared.hasOracleBlock,
    responseMimeType: r.responseMimeType ?? '',
    responseSchemaId: prepared.responseSchemaId,
    safetySettingCount: call.safetySettingCount,
    generationFields: GENERATION_FIELDS.filter(([, read]) => read(r) !== undefined).map(([name]) => name),
    outputTokenLimit: call.outputTokenLimit,
    timeoutMs: call.timeoutMs,
    responseLimitBytes: call.responseLimitBytes
  }
}
