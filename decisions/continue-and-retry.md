# Continue, Start over and the failed-section retry

**Decision in one paragraph.** When a translation or transcription stops part-way (Stop, an error, a
crash, a quota stop), its progress is saved in a checkpoint the app owns. Starting the same job again
offers exactly two choices: **Continue** with the settings the run started with, or **Start over** with
the current settings. Nothing continues automatically. When a Translate batch failed, Continue first
offers a retry of **exactly that section**, where the user may pick another model, a smaller piece
size or context OFF, for that retry only. The first request after Continue carries up to 50 previous
lines as a source-and-translation pair, as the old engine did.

**Status:** current. **Evidence scope:** checks for every write step and fault; a packaged-app smoke
test across a restart; live Stop and Continue on one Translate episode and one transcription; a live
content refusal that produced a retry offer. The retry dialog itself was exercised by checks, not live.

**How to read this file.** Section 1 is what the code does. Section 2 is SRT AI Translator 1.1.0. Section 3 is the
timeline. Sections 4 to 6 are the design decisions with the options considered. Sections 7 to 9 are the
checks, the live runs and the defects an independent review found. Sections 10 to 13 are the limits,
recommendations, code map and label index.

---

## Models used in testing

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Packaged app, Stop → restart → Continue (8.1) | `gemini-3.5-flash-lite` | Low | Hebrew target, batch 5, context off | Free | 30 synthetic lines, 6 batches | Oct 10 |
| Translate Stop → Continue (8.2) | `gemini-3.5-flash-lite` | Low | Batch 100, Standard tier | Free | 487 lines | Oct 10 |
| Transcribe Stop → Continue (8.2) | `gemini-3.7-flash` | Low | 5-minute parts | Free, then Paid after the Free key was overloaded | 28 minutes, 6 parts | Oct 10 |
| Content refusal → retry offer (8.2) | `gemini-3.5-flash-lite` | Low | Batch 300, context off | Free | 737 lines, 2 requests | Oct 10 |
| Later builds: restart Continue and UI Continue (8.3) | `gemini-3.5-flash-lite` | Low | Free first, Paid fallback on | Free | 60 lines; 737 lines | Oct 15–16 |

**Would a different model change the results?** Not for what this record decides. The checkpoint format,
the two-file commit, the prompt-contract barrier, the settings frozen for Continue, and the section retry
are code, and the build checks prove them without any model. The live runs show the flow working end
to end on these two models. What a model does mid-run (an overload, a refusal) only decides **where** a
run stops, not how it resumes.

## 1. What the app does today

### 1.1 The checkpoint

- Each paused job has its own folder under the app's data folder, `resume-v1/<random id>/`, holding a
  write-once job entry, `checkpoint.json` and, for Translate, the working partial and the finished file.
  A transcription partial sits beside its chosen destination as `<name>.partial.srt`.
- The checkpoint records: the run kind; a fingerprint (SHA-256 and length) of **every** input that can
  change the output; a frozen copy of every setting that affects the request (model, languages,
  thinking, generation parameters, tier, batch size, context settings, prompt, FFmpeg build); the
  working file's fingerprint; and, line by line (Translate) or span by span (Transcribe), what is done
  and how it was produced (`accepted` or `kept`). **Credential fields are never stored**: the record
  holds no key slot, and Continue uses the keys configured at the time.
- **Context and prompt text are stored verbatim**, because Continue must send exactly what the original
  run sent. So a secret pasted into TMDB Context, Custom Context, the Transcribe context or the System
  Prompt Override is written into the checkpoint in plain text. Measured with a fake key: four copies
  in a Translate checkpoint, one in a Transcribe checkpoint. The screen, console and logs show such a
  key as `***`, but that redaction applies to display and diagnostics only; the checkpoint is neither
  redacted nor encrypted (API keys in Settings are not encrypted at rest either). This was known before
  release and accepted as is (section 10, Limits).
- **The record names the prompt contract it was built under**, and Continue (and the failed-section
  retry, which goes through the same check) accepts only a contract this build reproduces exactly.
  New runs record `translate-prompt/v3`. A `translate-prompt/v2` record continues only when its stored
  System Prompt Override is blank or whitespace-only; otherwise the offer shows *"The original run
  configuration is no longer supported."* and the record and partial file are left untouched. `v1`
  records are refused. Section 4.1 explains why.
- A commit is a recoverable two-file transaction: write the proposed state as *pending*, replace the
  partial, then mark it *committed*. After a crash in between, the partial is re-read and hashed: the
  old fingerprint rolls back, the new one finalises, anything else refuses and touches nothing. So at
  any instant the pair is either the old complete state or the new one.
- Reading is bounded (32 MiB, 16 inputs, 1,000,000 rows) and strict: unknown keys, duplicates,
  overlaps, wrong counts or wrong fingerprints refuse the record. A leftover partial file alone never
  authorises Continue.

### 1.2 The choice

- Pressing Start with a complete selection first inspects saved work. The job is identified by
  Translate: kind + source fingerprint + target language. Transcribe: kind + media fingerprint +
  destination. While the whole file is being hashed, the page shows *Checking for unfinished work*.
- A valid offer shows one dialog with **Continue** and **Start over**. An offer that cannot continue
  shows Continue disabled with the reason; Start over stays available.
- **Continue** uses the frozen settings with the **current** API keys. Everything is re-checked inside
  the run slot immediately before anything is sent.
- **Start over** first marks the old job invalid, then deletes only working files whose fingerprint
  still matches what the app wrote. A file changed outside the app is kept and reported.
- A fresh start is refused while the same job has live saved work and no Start over was chosen.
- **New** on the page only clears the page. It never deletes saved work.

### 1.3 Context on the first continued request

The first request after Continue carries a two-turn pair: up to **Resume Context Size** (default
**50**, range 0–500) of the immediately preceding lines, their source as one turn and their
**accepted** translations as the other. Kept lines are left out of both turns. That request carries no
Cross-Batch Context block. Later requests follow Cross-Batch Context as usual
([`cross-batch-context.md`](cross-batch-context.md)).

### 1.4 The failed-section retry (Translate only)

- When a batch failed and ended the run, the checkpoint records that section and its cause. Continue
  then opens the retry dialog. Cancel returns to the offer; a plain Continue is refused until the
  section is covered.
- The dialog's defaults are the original model, batch size and context choice. The user may choose
  another model with structured output, a piece size from 1 up to the original batch size, or context
  OFF. **Context is never forced ON.** Nothing here changes Settings.
- The section is cut into fixed pieces of the chosen size, sent in order. Each accepted piece is
  committed before the next. The first failure stops the retry, and the uncovered remainder is offered
  again. Once the section is covered, the run pauses and offers ordinary Continue; it does not run the
  rest of the file.
- With context ON, each piece builds its own context window over what is accepted when it is built, so
  a later piece sees the lines an earlier piece just translated. If the failed request was the first
  after Continue, every piece keeps that request's resume pair instead.

### 1.5 Cleanup

Startup removes completed or invalidated job folders and unreferenced scratch older than 7 days.
**A paused job is never removed by age.** A damaged or unrecognised record is moved to a quarantine
folder; paths named inside a damaged record are never deleted.

---

## 2. The starting point: what SRT AI Translator 1.1.0 did

- gst kept its own machine resume file (`<input>.progress`) beside the input and deleted it on
  success. The app always passed exactly one of `--resume` (with a starting line) or `--no-resume`, so
  gst's interactive prompt could not appear.
- **Neither page discovered unfinished work or offered Continue or Start over.** Transcribe had no
  resume at all.
- Settings had **Resume Context Size**, 0–500, default 50: on a resumed run, gst rebuilt up to that
  many previous source and translated lines from disk as a two-turn pair.
- Translate's working output lived in the app's temp folder, which startup swept after 7 days.
- gst stopped the run on a content block, so there was never a failed section to retry.

---

## 3. Timeline

| When (2026) | What |
|---|---|
| Late Sep | Design decisions set (sections 4 to 6) |
| Oct 10 | Built: checkpoint, Translate Continue/Start over, section retry, Transcribe Continue/Start over. Packaged smoke test and live runs. Independent code review, two rounds |
| Oct 13 | Retry context changed to a per-piece window; the checkpoint now records the Cross-Batch Context count |
| Oct 15–16 | Live Continue across a restart in the packaged app (twice, in two later builds) |
| Oct 18 | System Prompt Override made additive; prompt contract v3 and the v2 compatibility rule added after review found the regression (section 4.1) |

---

## 4. Design: the checkpoint

| Decision | Options considered | Why this one |
|---|---|---|
| An app-owned folder per job, outside the 7-day temp sweep | Keep the partial in the temp folder, as SRT AI Translator 1.1.0 did | A paused job must not vanish after a week |
| Fingerprint **every** input, by full hash | Path, size and modification time; a sample of the file | A path or a date can match a different file. A sampled hash can miss an edit. Continuing onto a changed source would silently misalign the output |
| Freeze every request-affecting setting | Use current Settings on Continue | A file translated half with one model or prompt and half with another is a mixed result nobody asked for |
| Two-file commit with roll-back or roll-forward | Write the partial, then the pointer | Design check "what is on disk at a random instant": the pointer and the file can disagree after a crash, and the next Continue would skip or repeat lines |
| Strict, bounded reading | Accept what parses | A corrupt or crafted record must never authorise sending work or deleting files |
| Never store key fields in the checkpoint | — | Keys do not affect the output, so they are not part of a job's identity. Text the user typed into a context or prompt box is a different matter: it does affect the output, so it is stored verbatim, including anything secret pasted into it (section 1.1) |
| Record the prompt contract and refuse one this build cannot reproduce | Accept any older record | A paused job promises that Continue sends what the original run would have sent. A record whose request would now be built differently would silently finish the file under different instructions |

### 4.1 The prompt-contract barrier (October 18)

Late in release preparation the System Prompt Override changed meaning. Before, a non-empty override
**replaced** two built-in rules (Preserve Formatting and, with media, the gender-from-audio rules).
Since October 18 it is **added** after every built-in rule as its own Translation Guidance section and
removes nothing ([`native-translation-engine.md`](native-translation-engine.md) section 1.5).

Independent review then found a regression: a job paused before the change, with an override, would
have continued under the new meaning, so the second half of its file would be translated with
instructions the first half never had. Accepting every older record would have hidden exactly the
mixed result the frozen settings exist to prevent. Refusing every older record would have thrown away
paused work that is unaffected. With no override, the old and new instructions are byte-identical
(a check pins both to gst's instruction), so those jobs are safe to continue.

| Record | Override stored | Result |
|---|---|---|
| `translate-prompt/v3` | any | Continues |
| `translate-prompt/v2` | blank or whitespace only | Continues |
| `translate-prompt/v2` | non-blank | Refused; record and partial byte-identical after the check |
| `translate-prompt/v1` | — | Refused (only pre-release test builds wrote it) |

Checks cover each row, and the refusal is judged inside the run slot before anything is built, for
both Continue and the failed-section retry. The contract number describes reproducible request
behaviour; it is not the app's version number.

---

## 5. Design: the choice

| Decision | Options considered | Why this one |
|---|---|---|
| Always ask; two actions only | Continue automatically; a "resume from line" field; a third action | Continue reuses the original settings, so changing a setting between runs must not silently continue with old ones or silently mix new ones. The user decides, and a line field invites off-by-one misalignment |
| Continue with frozen settings and current keys | Freeze keys too | A key may have been rotated or exhausted since. Keys do not change the output |
| One live job per source+target (Translate) or media+destination (Transcribe) | One per file | Different targets and different destinations are independent; each may stay paused |
| Start over deletes only files that still match | Delete the folder | A file the user edited or replaced is never destroyed |
| A paused job has no age limit | Expire after 7 days like temp files | Losing hours of paid work to a timer is worse than a folder on disk |
| First continued request carries the 50-line pair | Send nothing; send the Cross-Batch Context block | Parity: gst's `resume_context_size` default, which SRT AI Translator 1.1.0 used. A resumed run has no recent request of its own to orient the model. The pair holds only accepted output, and both turns hold exactly the same line numbers, because a translation turn with something the model did not produce teaches it a wrong answer |

---

## 6. Design: the section retry

| Decision | Options considered | Why this one |
|---|---|---|
| Retry exactly the failed section | Restart the file; retry from the failed line onward | One failure should not cost the rest of the file or force a global settings change |
| User-chosen fixed piece size, at most the original batch size | Automatic shrinking | Fixed pieces are predictable and visible. Automatic shrinking is the recovery tree's job ([`content-block-recovery.md`](content-block-recovery.md)) and quota pressure never shrinks batches ([`free-tier-protection.md`](free-tier-protection.md)) |
| Another model allowed, for the retry only | Only the same model | A model that refuses a passage may not be the right one for it. Settings stay untouched |
| Context may be switched OFF, never ON | Free choice | Removing context is a way to rule it out as the cause. Adding it would send a request shape the failed request did not have |
| Stop at the first failure; pause after coverage | Carry on through the rest of the file | The user asked for a retry of one section, not a new run |
| Each piece builds its own context window (changed Oct 13) | Every piece reuses the failed request's window (the original design) | A later piece then sees the lines an earlier piece just translated, which is strictly more information. A same-size retry still repeats the parent's block |

---

## 7. Checks

| Area | Checks | Notable cases |
|---|---|---|
| Checkpoint core | 33 (`P3 3.3`) | A commit made to fail or crash at **each of its 15 write steps**, each leaving the old or the new complete state. Moving the partial write before the pending record made exactly that check fail |
| Translate Continue / Start over | 32 (`P3 3.4`) | Continue after a restart; fresh start refused while work is saved; the first-Continue pair; a request carrying the pair is byte-identical to the old request when the pair is absent |
| Section retry | 19 (`P3 3.5`) | Pieces recorded in order; a failed piece leaves exactly the uncovered remainder; a covered section pauses again |
| Transcribe Continue / Start over | 30 (`P3-G6`) | Continue after part k; one run slot shared with Translate |
| After review | +8 | Section 9 |

---

## 8. Live runs

### 8.1 Packaged app, across a restart (October 10)

The packaged Windows app, a private profile, driven through its own page API. A synthetic 30-line
English subtitle, Gemini 3.5 Flash-Lite at Low, Hebrew, batches of 5, context off:

| Step | Result |
|---|---|
| Inspect before any run | Nothing offered |
| Run, Stop on the first committed batch | Stopped, resumable (batch 2 was in flight at Stop) |
| Inspect | Valid, 5 of 30 done, Continue offered |
| Quit and restart the app | The same job still valid at 5 |
| Continue | Batches 2–6 sent (2 had never committed); completed; 30 lines, every timing equal to the source, all in Hebrew |
| Inspect after completion | Nothing offered |
| Transcribe Continue with an unknown offer | Refused: *"This resume offer is no longer current… Nothing was sent."* |
| Quit | No file in the private profile or temp folder contained the key |

The maintainer's own app profile was listed and hashed before and after: 106 files, no difference.

The first attempt polled every 200 ms and pressed Stop too late; the run had finished and nothing was
offered. The driver was changed to press Stop from the page's own event, with smaller batches.

### 8.2 Live runs on real material (October 10)

| Run | Material | Result |
|---|---|---|
| Translate Stop → Continue | An English TV episode, 487 lines, batch 100 | Stopped after 2 batches, offered at 200 of 487. Continue sent batches 3–5 once each and completed: 487 lines, every timing equal to the source, none empty, nothing offered after |
| Transcribe Stop → Continue | A 28-minute documentary audio track, 6 parts | Stopped after 2 parts (142 lines), destination not yet created. **First Continue:** part 3 met *"The model is overloaded"* three times and failed, still resumable, partial unchanged. **Second Continue (paid key):** parts 3–6 once each, completed with 436 lines, the first 142 unchanged |
| A content refusal | An English TV episode, 737 lines, batch 300 | Lines 301–600 refused; the run ended resumable with that section offered for retry (model, maximum piece size 300, context off) |

Cost shown by the runs (US dollars, standard tier): Translate 0.019 + 0.026; Transcribe 0.043 (free)
+ 0.083 (paid).

### 8.3 Later builds

- **October 15**, packaged app, both keys stored: Translate and Transcribe each stopped mid-run, the app
  restarted, both were offered, and a Translate Continue completed 60 of 60 lines with its own report.
- **October 16**, packaged app with real clicks: a 737-line episode stopped at line 600; Continue said
  *"Continuing after line 600 of 737."* and completed; saved 737 lines.

---

## 9. Defects found by independent code review (October 10)

The first review returned nine findings and the re-review one more. Seven were code defects and were
fixed with new checks; one was shown with evidence not to be a defect, and the reviewer agreed; the other two were a
missed test-timing record and a display-only note.

| Finding | Fix |
|---|---|
| Finishing a job never re-checked the destination, so a file created there while paused could be overwritten | The destination is checked before the pending record and before every replace attempt; a change refuses with both files untouched |
| Finishing renamed whatever was at the partial path without comparing it to the recorded fingerprint | The partial must match the committed fingerprint exactly |
| A retry piece whose commit failed was followed by "carrying on" with the next piece, built from a record that had not advanced | A failed piece commit ends the retry before anything else is sent |
| A failure to record the failed section was ignored | Reported, and the saved work is left as before |
| A recorded model missing from a stale model list blocked Continue | A warning instead; fresh starts still use the guard |
| A transcription fallback saved even when writing its invalidation failed | The record and destination are kept and the run fails |
| After a failed commit, cleanup could delete the complete translation it had just staged | The staged file is kept under its own name and named in the panel |
| **Rejected:** Start should be clickable for a model that cannot transcribe, to reach saved work | That greyed state is a SRT AI Translator 1.1.0 rule, and saved work is reachable by choosing any capable model, after which Continue uses the recorded one |

---

## 10. Limits

- The retry dialog, Start over (including a file changed outside the app) and a destination changed
  while paused were exercised by checks only, not live.
- A kept line restored through Continue was not reached live; the provider did not refuse that run.
- Live runs used English sources, a Hebrew target and two models at Low thinking.
- **Secrets in typed text reach the checkpoint.** A key pasted into a context box or the System Prompt
  Override is stored in plain text in `checkpoint.json` (section 1.1). Redacting it would break
  Continue, which must resend the text exactly, and substituting the current key on Continue would
  change what is sent if the key was edited or removed. A safe design needs its own work; for 1.0.0
  the behaviour was accepted as is. Do not paste keys into those boxes.
- The prompt-contract refusal (section 4.1) was exercised by checks, not by a live paused job from an
  older build.

## 11. Recommendations

- Keep "what is on disk at a random instant" as the test for any change to commit order. The fault
  matrix of 15 write steps is the check that guards it.
- Treat any automatic continuation as a regression: the explicit choice exists because Continue uses
  frozen settings.
- If Resume Context Size is ever reconsidered, measure it the way Cross-Batch Context was measured.
  The 50 is parity, not a measured optimum.

## 12. Code and checks

| What | Where | Checks |
|---|---|---|
| Checkpoint schema, commit, inspect, cleanup | `electron/main/resumeStore.ts`, `electron/engine/progress.ts`, `electron/engine/output.ts` | `P3 3.3` |
| Translate Continue, resume pair | `electron/engine/run.ts`, `electron/engine/batching.ts` (`resumePair`, `acceptedPair`) | `P3 3.4` |
| Section retry | `electron/engine/batching.ts` (`retryPieces`), `electron/engine/run.ts`, `src/components/FailedBatchRetry.tsx` | `P3 3.5` |
| Transcribe Continue | `electron/engine/transcribe.ts`, `electron/main/resumeStore.ts` | `P3-G6` |
| The dialog | `src/components/ResumeChoice.tsx` | `P3 3.4` |
| Resume Context Size default | `electron/shared/types.ts` (`DEFAULT_RESUME_CONTEXT_SIZE`) | — |

## 13. Label index

| Label | Meaning | Section |
|---|---|---|
| `AR3-5` | Checkpoint schema, identity and durability | 1.1, 4 |
| `AR3-6` | Continue / Start over as an explicit choice | 1.2, 5 |
| `AR3-7` | Retry of exactly the failed section | 1.4, 6 |
| `AR3-8` | Cleanup, retention and random-instant rules | 1.5, 4 |
| `F15-P4` | The first-Continue pair of Resume Context Size lines | 1.3 |
| `D15-6` | Resume stays a separate feature from Cross-Batch Context | 1.3 |
| `PR-3` | Continue restores only verified progress; kept lines stay kept | 1.1 |
| `TD15-1` | Each retry piece builds its own context window | 6 |
| `TD15-2` | The checkpoint records the Cross-Batch Context count | 3 |
| `R10-01` … `R10-10` | The review findings | 9 |
| `PR-5` | Records under an older prompt contract cannot continue | 1.1, 4.1 |
| `RR-V01` | The v2 record with an override; the compatibility rule | 4.1 |
| `R12-01` | A key pasted into a context box reaches checkpoint bytes | 1.1, 10 |
| `N14` | The System Prompt Override, now additive | 4.1 |
