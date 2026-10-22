# Decision records

The code shows what SRT AI Translator NG does. These files explain **why**: why a default is ON or
OFF, why a number is 5 and not 8, why a rule that looks over-careful is there. Most of these choices
came from live tests against the Gemini API, blind side-by-side reviews of translated output, and
defects that were found and fixed. Without a record, the next person to read the code would have to
repeat that work, or would undo a rule without knowing what it protects.

There is one file per feature. Each sets out to carry the whole record: what was tested and how many
times, the results, the analysis of those results, the conclusions, the answers that were tried and
withdrawn, why each default is ON or OFF, and what is still unmeasured. Figures are taken from the
development records and checked against the code where the code can confirm them; where a figure was
not re-measured for the record, the record says so.

| File | Feature |
|---|---|
| [`cross-batch-context.md`](cross-batch-context.md) | The previous lines sent with each translation request: why source-only, why 5, why ON |
| [`native-translation-engine.md`](native-translation-engine.md) | Batches, the exact reply check, whole-batch commits, generation defaults, the 11-episode comparison with gst |
| [`content-block-recovery.md`](content-block-recovery.md) | Content refusals: resends, the recovery tree, lines kept untranslated, why safety stays at gst's settings |
| [`continue-and-retry.md`](continue-and-retry.md) | The checkpoint, Continue / Start over, and the failed-section retry |
| [`free-tier-protection.md`](free-tier-protection.md) | Pacing against Google's limits, Quota Groups, Paid fallback, and when a batch is made smaller |
| [`gender-reference.md`](gender-reference.md) | Hebrew gender repair from a second subtitle (Bundle H): the reference in the prompt, designated readers, the repair pass, why it is OFF |
| [`gender-extras.md`](gender-extras.md) | The three experimental gender layers, Speaker, Spanish/Portuguese C1 and Method B: what each measured and why each is OFF |
| [`reference-subtitle-download.md`](reference-subtitle-download.md) | Finding the reference subtitle: automatic OpenSubtitles download, the Wizdom manual picker, the key pool |
| [`subtitle-alignment.md`](subtitle-alignment.md) | The Align tab (Bundle C): the A–I Global fit, ALASS for piecewise timing, the threshold study, the media detector, embedded text tracks and how several tracks are arbitrated (Bundle M) |
| [`rtl-output.md`](rtl-output.md) | Right-to-left output: which wrapping method, why it is chosen per player, what was rendered and checked |
| [`transcription.md`](transcription.md) | Speech to subtitles: models, parts, language detection, coverage checks, polishing (Stage C), how a refused part is split, the empty-transcript notice |
| [`wrong-alphabet-repair.md`](wrong-alphabet-repair.md) | Repairing letters from the wrong alphabet in Hebrew output, at Save and by redo |
| [`encoding-intake.md`](encoding-intake.md) | Reading a subtitle file: encoding and language detection, the 35-file code-page corpus, refusing what cannot be read safely |
| [`logging-and-run-artifacts.md`](logging-and-run-artifacts.md) | The run console, machine event log, progress log, thoughts log and token report: why each is separate |
| [`submaker-evaluation.md`](submaker-evaluation.md) | The evaluation of an open-source Stremio subtitle add-on and what NG adopted from it, and what it did not |

## Names used in these records

- **SRT AI Translator NG** (or just "NG") is this product. Its first release is 1.0.0.
- **SRT AI Translator 1.1.0** is the earlier desktop app NG was built from. It is a separate product
  with its own version numbers, **not** a version of NG. Every mention of "1.1.0" in these records
  means that app.
- **gst** is *gemini-srt-translator*, the open-source command-line engine SRT AI Translator 1.1.0 ran
  (version 3.7.0). Version 3.8.3 is the later upstream release some ideas were ported from. NG no
  longer runs gst; its engine is native.

## Models used in testing

Every record has a **"Models used in testing"** section near the top. It lists each test that called a
Gemini model: the exact model id, the thinking level, the key tier (Free or Paid), the size of the test
and the date. Where a judge or reviewer model scored output, that is listed separately.

- **Thinking level** is the Gemini 3.x `thinkingLevel` setting (minimal, low, medium, high). Gemini
  2.5-series models use a token budget instead. "Not sent" means the request carried no thinking
  setting, so the model used its own default.
- **Most quality tests used one operating point:** `gemini-3.5-flash-lite` at thinking Low (the app's
  translation default), translating English to Hebrew. Transcription tests mostly used
  `gemini-3.7-flash` at Low and the dedicated `gemini-3.5-transcribe`.
- **Results that depend on model behaviour may differ on another model or thinking level.** Examples:
  how well a model follows a gender reference, how it uses context lines, how often it slips into the
  wrong alphabet, what it refuses, and how it polishes a transcript. Each record says which of its
  conclusions are model-dependent and which are pure code mechanics that no model choice changes.
  Where nobody measured another model, the record says so; read that as "unknown", not as "the same".

## How an entry is laid out

Each file follows the same order:

- **The decision in one paragraph**, its status (`current`, or `superseded` with a pointer), and the
  scope of the evidence.
- **Models used in testing**: which model, version and thinking level each test ran on, and which
  conclusions would need re-measuring on a different model.
- **What the app does today**, read from the code.
- **What SRT AI Translator 1.1.0 did**: the baseline every change is measured against.
- **A timeline** of when each thing was tested or decided.
- **The tests**: setup, how many runs, results tables, the analysis, and the conclusion of each.
- **The decisions**: each rule, why it was chosen, the alternatives rejected, and what evidence would
  reopen it.
- **Build checks and live runs**: what was proven in the shipped build, and what was not seen live.
- **Limits and recommendations.**
- **Code and checks**: where it lives, and the section of `scripts/gates/gates.ts` that enforces it.
- **A label index** for the short labels found in code comments.

## What these records do and do not say

- **The code and the check suite are the authority** for what the app does. If a record and the code
  disagree, the code is right and the record needs fixing.
- **Every test has a scope.** Most quality tests used one model setting and one language pair
  (English to Hebrew). Each entry says what was measured and what was not. Read "not measured" as
  "unknown", not as "fine".
- **Test material is described, not reproduced.** The test films and episodes were the maintainer's
  own copies, so they are described by type only (for example "a feature-length drama"), and no
  subtitle text from them appears here.
- **Short labels** such as `D15-1R`, `TD15-4` or `§17.8R` appear at the end of many code comments.
  They are decision and evidence identifiers from development. Each file here ends with an index that
  maps the labels it covers to the section that explains them.
- **Superseded results stay in.** Where a measurement or conclusion was later withdrawn or corrected,
  the record says so in place and gives the reason, so the history of a decision can be followed.
