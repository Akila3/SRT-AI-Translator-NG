# Cross-Batch Context: the previous lines sent with each request

**Decision in one paragraph.** With Cross-Batch Context ON, every translation request (except the
first of a file and the first after Continue) carries up to **5** of the **source-language** lines
just before its batch, as background only. Earlier translations are not sent. The setting is **ON for
new installs**; an existing NG profile from before the setting existed keeps the OFF it ran with. The count can be set from 4 to
10. Requests that carry the block also mark where the batch starts and how many lines must come back.

**Status:** current. **Evidence scope:** English to Hebrew, Gemini 3.5 Flash-Lite at Low thinking,
one human judge. Other languages and models were not tested.

**How to read this file.** Section 1 says what the code does today. Section 2 is the SRT AI Translator 1.1.0 starting
point. Sections 3 to 9 are the research, in the order it happened, including two answers that were
reached and then withdrawn; the withdrawn ones are kept because the reasons they failed are the most
useful part. Section 10 is the final decision, section 11 what building it uncovered, and sections 12
to 15 the open questions, recommendations, code map and label index.

Test material is described by type only. Titles are not named and no subtitle text from them appears
here (see [`README.md`](README.md)).

---

## Models used in testing

Every live test in this record ran on **one model and one thinking level**, translating English to
Hebrew.

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Round 1 Campaigns A and C (4.3) | `gemini-3.5-flash-lite` | Low | Provider-default temperature | Not recorded | 160 and 260 calls | Sep 22 |
| Round 1 Campaign B (4.3) | `gemini-3.5-flash-lite` | Low | Temperature 0 | Not recorded | 260 calls | Sep 22 |
| Round 1 token counts, Campaign E (4.5) | `gemini-3.5-flash-lite` `countTokens` | Not applicable | Counting only, no generation | Not recorded | 300 counts | Sep 22 |
| Round 2 corrected campaign (5) | `gemini-3.5-flash-lite` | Low | Provider-default temperature, 100-line batches | Free, then Paid | About 2,000 calls (1,447 generations, 552 counts) | Sep 27 |
| Round 2 strict re-run (5.4) | `gemini-3.5-flash-lite` | Low | 100-line batches, strict script check | Not recorded | 36 trials | Sep 28 |
| Round 3a boundary labelling (6.1) | Two model reviewers from different vendors; model ids not recorded | Not recorded | Labelling only, no translation calls | — | 15 boundaries | Sep 28–29 |
| Round 3a harness runs that failed (6.4) | `gemini-3.5-flash-lite` | Low | Research harness, strict check | Free | First run stopped after 53 calls | Sep 29 |
| Round 3b screen (7) | `gemini-3.5-flash-lite` | Low | Provider-default temperature, 100-line batches, no streaming | Free, then Paid | 1,129 calls | Sep 30 |
| Content-block probe beside the screen (7, and [`content-block-recovery.md`](content-block-recovery.md) 6.1) | `gemini-3.5-flash-lite` | Low | Streaming on and off at a 300-line batch | Free | 78 sends | Sep 29 |
| Round 3c confirmation, S5 vs S8 (8) | `gemini-3.5-flash-lite` | Low | Same protocol as Round 3b | Free | 487 calls, 150 trials | Sep 30 |
| Live tests of the built feature (11) | `gemini-3.5-flash-lite` | Low | The app's own prompt and request, Batch Size 1, 3 and 100 | Paid (one run on Free) | Dozens of runs, including 23 per wording for the index-list question (11.4) | Oct 12–14 |

**Would a different model change the results?** The **quality** findings are model behaviour:
- how much a model gains from previous lines;
- whether it carries context lines into its reply;
- the gender and fluency differences between S5 and S8.

They were measured only on `gemini-3.5-flash-lite` at Low. A stronger model or a higher thinking level
might use a larger window well, or need less context, so the choice of 5 lines could shift; that was not
measured. Round 1 showed the ranking was not sensitive to temperature (temperature 0 and the provider
default gave the same result), but nothing compared models. The **token-cost** and **coverage**
results (how many tokens each window adds, how much dialogue it spans) depend on the request text,
not on how the model behaves. The fixes in section 11 (markers, a resend without context, sending the
count) were found on this model and may matter more or less on another.

## 1. What the app does today

### 1.1 The request

A request with context has this shape (the dialogue is invented for illustration):

```text
PREVIOUS SOURCE CONTEXT (continuity only; do not translate or output):
[{"index":"215","text":"Where did she go?"},{"index":"216","text":"Out. She took the car."}, ...]
CURRENT INPUT:
[{"index":"220","text":"..."}, ... the batch ...]
```

The system instruction gains two sentences, only when the block is present:

- *"Previous source context, when supplied, exists only to preserve discourse, terminology, names,
  speaker/addressee continuity and story state across the batch boundary; translate only the current
  items and never output the previous source context."*
- *"Return exactly N objects, one per current input item, with indices X to Y only."* (for one line:
  *"Return exactly 1 object, one per current input item, with index X only."*)

With Context OFF, or when no line qualifies, the request is **byte-for-byte** the request the app would
send with the feature switched off: no heading, no label, no extra sentences.

### 1.2 Which lines go in the block

- **A fixed window.** The N positions immediately before the request's first line, where N is the
  run's Previous Context Cues value (snapshotted when the run starts).
- **Only lines already accepted.** A position is used only if its translation has been checked and
  committed. Lines still in flight, lines in the current batch and lines kept untranslated after a
  refusal are left out.
- **No backfill.** A position that is left out is not replaced by an older line. Reaching further back
  could pull in a line that was kept untranslated after a content refusal, and sending that text again
  could make the next request refuse too (see [`content-block-recovery.md`](content-block-recovery.md)
  section 2).
- **Blank lines are skipped**, as they were in the tested prompt.
- **Source text only, with its line number.** No translation, no model turn.

### 1.3 When the block is not sent

| Situation | Block? | Why |
|---|---|---|
| First request of a file | No | Nothing comes before it |
| First request after Continue | No; it carries the resume pair instead (50 lines of source plus accepted translation) | The two are mutually exclusive; the request builder refuses both together |
| A batch whose request with a block got an unusable reply | No, for every later attempt of that batch and its recovery tree | An identical resend repeated the same failure (section 11.3) |
| The next batch after that | Yes, again | The fallback is per batch |
| Context OFF | No | — |

### 1.4 Inside recovery and retries

- **Recovery tree** (a batch split into halves after repeated failure): each piece builds its own
  window from its own first line, over lines committed before the tree plus lines accepted earlier in
  the same tree. Kept lines stay out.
- **The user's retry of a failed section:** with context ON, each piece builds its own window over
  what is accepted when that piece is built, so a later piece sees an earlier piece's lines. The user
  may switch context OFF for the retry; it is never forced ON.

### 1.5 Settings, upgrade and saved progress

- Settings shows the toggle with the copy in section 10.3, and a **Previous Context Cues** dropdown
  (4–10) only while the toggle is ON. Hiding the dropdown never clears its value.
- **New profile:** ON, 5. **Existing NG profile that never stored the setting** (written by a build
  from before this feature): it ran with OFF, so migration `M8` writes OFF for it once, preserving its
  behaviour. A stored ON or OFF is left alone. The count is never written by the migration; a missing
  or invalid count reads as 5. NG keeps its settings in its own folder and does not import a SRT AI Translator 1.1.0
  profile, so `M8` concerns NG profiles only.
- A saved progress record stores the count. A record written before this feature existed continues
  only with Context OFF.

---

## 2. The starting point: what SRT AI Translator 1.1.0 did

- **Default OFF.** The Settings toggle always showed, with copy saying ON sends the whole previous
  batch.
- **ON sent everything.** gst 3.7.0 carried the **entire previous request** (up to 100 source lines)
  as a user turn and the **model's raw previous reply** as a model turn. At a 100-line batch that is
  about three times the input of a request without context (measured in section 4.5: about 6,360
  prompt tokens against 2,030).
- **No count control.** All or nothing.
- **A separate resume context** (default 50 lines) rebuilt from the saved file when a run resumed.
  That still exists in NG and is not part of this feature.

Two problems with the SRT AI Translator 1.1.0 shape motivated the work: the cost, and the fact that the model turn was
whatever the model last said, so one bad reply could be carried into the next request.

---

## 3. Timeline

| Round | Dates (2026) | Question | Outcome |
|---|---|---|---|
| 1. Original study | Sep 22 | How many lines, and what should they contain? | Paired source + translation, 8 lines, default OFF. **Withdrawn Sep 27** |
| 2. Corrected campaign | Sep 27 | Same, using only model-written history | Source-only 5, default OFF. **Withdrawn Sep 28** |
| 2b. Script defect | Sep 28 | Why is there Arabic in the Hebrew output? | 914 bad lines found; strict check added; nothing selected |
| 3a. Test design | Sep 28–29 | Can a test actually decide this? | New corpus, blind protocol, harness hardening, three failed runs |
| 3b. Screen | Sep 30 | Which counts are worth confirming? | Finalists 5 and 8 |
| 3c. Confirmation | Sep 30 | 5 or 8? With or without a register instruction? | 5, without the instruction |
| Decision | Sep 30 – Oct 1 | Default and upgrade behaviour | ON for new profiles, 5; existing NG profiles keep their setting |
| Build | Oct 12–14 | Does the product request work at the real operating point? | Minimum 4; batch-start markers; resend without context |

---

## 4. Round 1: the original study (later withdrawn)

### 4.1 What other implementations do

| Implementation | Shape | Default count | Notes |
|---|---|---|---|
| gst 3.7.0 (shipped in SRT AI Translator 1.1.0) | Whole previous request + raw model reply | Whole batch | All or nothing |
| gst 3.8.3 (newer upstream) | Rebuilt source + translation arrays, one bounded `context_size` | Bounded | The desired window shape, but not shipped in SRT AI Translator 1.1.0 |
| A Kodi subtitle add-on | Plain previous **source** lines, numbers and times removed, in a labelled block | 5, hidden setting | Precomputed, so chunks can run in parallel; split children use their own boundary; a top-up of scattered missing lines gets no context |
| A Stremio subtitle add-on | Up to N previous **source** entries | 8, range 1–10, off by default | Its UI copy still claimed it sent translations; the code no longer did |

Neither add-on publishes evidence for its default, so "Kodi uses 5" or "Stremio uses 8" was not taken
as a reason.

### 4.2 Published research

- ACL SRW 2025, *Translating Movie Subtitles by Large Language Models using
  Movie-meta Information*: previous lines N = 2 to 5 on OpenSubtitles with several models; N = 4 was
  the best balance for most language pairs. <https://aclanthology.org/2025.acl-srw.22/>
- Findings of EMNLP 2025, *Exploring Context Strategies in LLMs for Discourse-Aware
  Machine Translation*: source plus the model's earlier output improved discourse; across k = 3 to 11,
  quality rose to about 7 and then flattened or fell. <https://aclanthology.org/2025.findings-emnlp.1324/>
- TACL 2024, *Lost in the Middle*: long-context models do not use every position equally;
  adding context does not guarantee the relevant clue is used. <https://aclanthology.org/2024.tacl-1.9/>

These support a short local window, but different models, languages and prompts mean they cannot set
NG's default.

### 4.3 Test inventory

| Campaign | What | Size |
|---|---|---|
| A. Controlled | 5 synthetic fixtures: a female clue 1, 5 and 8 lines back; a recent male clue after an older conflicting female scene; an invented Hebrew term accepted 5 lines back (which source-only context cannot know) | 160 calls, 640 scored decisions |
| B. Natural, temperature 0 | 10 context-sensitive lines from 10 English/Hebrew title pairs (5 needing a female form, 5 male); correct gender taken from independent human Hebrew subtitles | 260 calls |
| C. Natural, app defaults | Same 10 cases with temperature unset, as the app sends it | 260 calls |
| D. Timing | Every rolling window in 15 English subtitle files (11,045 lines) | — |
| E. Tokens | One midpoint boundary per title pair, 100-line batch | 300 token counts |

Arms: no context; paired 1, 3, 5, 6, 7, 8, 9, 10, 20 lines; source-only 5 and 8.

### 4.4 Quality results

**Controlled (Campaign A)**

| Arm | Correct | Rate |
|---|---:|---:|
| None | 12 / 60 | 20.0% |
| Paired 1 | 7 / 20 | 35.0% |
| Paired 3 | 6 / 20 | 30.0% |
| Paired 5 | 43 / 60 | 71.7% |
| Paired 6 | 42 / 60 | 70.0% |
| Paired 7 | 31 / 60 | 51.7% |
| **Paired 8** | **52 / 60** | **86.7%** |
| Paired 9 | 48 / 60 | 80.0% |
| Paired 10 | 22 / 60 | 36.7% |
| Paired 20 | 22 / 60 | 36.7% |
| Source-only 5 | 30 / 60 | 50.0% |
| Source-only 8 | 40 / 60 | 66.7% |

The striking negative: with 10 lines, the clue 8 lines back and the accepted invented term were both
**inside** the window, and the model used neither in 12 of 12 decisions each. With 8 lines it kept the
clue 10 of 12 times and the term 12 of 12. More context was not monotonically better.

**Natural (Campaigns C and B)**

| Arm | App defaults | Temperature 0 |
|---|---:|---:|
| None | 7 / 30 (23.3%) | 10 / 30 (33.3%) |
| Paired 5 | 16 / 30 (53.3%) | 14 / 30 (46.7%) |
| Paired 6 | 16 / 30 (53.3%) | 15 / 30 (50.0%) |
| Paired 7 | 16 / 30 (53.3%) | 19 / 30 (63.3%) |
| **Paired 8** | **21 / 30 (70.0%)** | **21 / 30 (70.0%)** |
| Paired 9 | 18 / 30 (60.0%) | 18 / 30 (60.0%) |
| **Paired 10** | **22 / 30 (73.3%)** | **23 / 30 (76.7%)** |
| Paired 20 | 18 / 30 (60.0%) | 20 / 30 (66.7%) |
| Source-only 5 | 5 / 10 (50.0%) | 5 / 10 (50.0%) |
| Source-only 8 | 4 / 10 (40.0%) | 3 / 10 (30.0%) |

Ten beat eight by one or two answers out of 30; eight was exactly 70% under both settings.

### 4.5 Token cost at a 100-line batch (Campaign E)

| Arm | Mean prompt tokens | Added |
|---|---:|---:|
| None | 2,032 | — |
| Source-only 5 | 2,154 | +122 |
| Source-only 8 | 2,213 | +181 |
| Source-only 10 | 2,251 | +219 |
| Paired 5 | 2,256 | +224 |
| Paired 8 | 2,385 | +353 |
| Paired 10 | 2,468 | +436 |
| Full source-only 100 | 4,047 | +2,015 |
| Full paired 100 (the SRT AI Translator 1.1.0 shape) | 6,361 | +4,329 |

Any bounded window removes over 90% of SRT AI Translator 1.1.0's repeated context. Between 8 and 10 lines, price is not
a deciding factor.

### 4.6 How much dialogue a window covers (Campaign D)

| Lines | Median span | 90th percentile | Crosses a 5 s gap | Crosses a 10 s gap |
|---:|---:|---:|---:|---:|
| 5 | 14.4 s | 26.4 s | 23.7% | 12.5% |
| 8 | 24.0 s | 45.6 s | 33.0% | 18.3% |
| 10 | 30.5 s | 58.2 s | 38.3% | 21.7% |
| 100 | 336 s | 582 s | 89.7% | 73.8% |

A silent gap is only a proxy for a scene change, but the trend is the point: the SRT AI Translator 1.1.0 window almost
always reaches back across scenes.

### 4.7 Round 1 conclusion, and why it was withdrawn

The study recommended **8 paired lines** (source plus accepted translation), range 1–10, with the
global default left OFF as in SRT AI Translator 1.1.0. Paired beat source-only in every comparison, and 8 beat 10 on
reliability.

**Then a flaw was found in the test input.** In Campaigns B and C the "previous translations" in the
prompts were **human-written subtitles**, and in Campaign A they were written by the test script. The
product can only ever send the **model's own earlier output**. So the paired results measured an
upper bound the app cannot reach: clean, consistent history that the model never has to live with
when its own earlier choices are imperfect. The results could explain a mechanism but could not choose
a production default. The decision was withdrawn.

**Lesson.** Every input a test supplies by hand is something the product must produce on its own. The
history was supplied by hand, and it was the one thing the decision depended on.

---

## 5. Round 2: the corrected campaign (later withdrawn)

### 5.1 What changed

The generator could read only English sources and the campaign's own accepted outputs. A paired
prompt was rejected unless every byte of its history came from an earlier accepted reply in the same
campaign. Human Hebrew was read only by the scorer, after generation.

Operating point: Flash-Lite 3.5, Low thinking, default temperature, **100-line batches** (the product
default), two attempts before splitting.

### 5.2 Size

- 24 new scene boundaries across 13 titles, every arm: no context, source-only 1–10, paired 1–10,
  plus source-only 100 and paired 100 (552 rows).
- A confirmation pass of the seven leaders with two extra randomized sends each (336 rows), a
  holdout on the original ten cases, propagation checks, a full-title check and split checks.
- About 2,000 API calls in total.

### 5.3 Results

| Arm | Confirmed case-level result | Mean prompt tokens (same 24 requests) |
|---|---:|---:|
| **Source-only 5** | **75.0%** | 2,180 (+122) |
| No context | 66.7% | 2,058 |
| Paired 4 (best paired) | 62.5% | 2,238 (+180) |
| Source-only 100 | — | 4,041 (+1,983) |
| Paired 100 | — | 6,373 (+4,314) |

- **Paired model-written history did not reproduce the human-history advantage.** It came in
  12.5 points below source-only 5.
- Source-only 5 was 8.3 points above no context, under the 10-point bar set in advance for turning the
  feature on for everyone, so the provisional answer was **source-only 5 when enabled, default OFF**.
- On a full 736-line title, all five tested arms returned exactly 736 lines. Source-only 5 used 17
  requests and 88 s, against 9 requests and 61–69 s for no context and for paired 4, so it hit more
  retries on that title.

### 5.4 Why it was withdrawn: wrong-alphabet letters

During the first blind review, the maintainer noticed **Arabic letters inside Hebrew lines**. An
audit of every accepted output found **914 lines** with letters from the wrong alphabet: 792 Arabic,
84 Cyrillic, 42 CJK, 2 Greek. The request captures proved none of this came from the prompts: the
model produced it. The campaign's reply check had required *some* Hebrew in each line but did not
forbid other scripts, so these lines had counted as accepted, and the scores were built on them.

The check was made strict (every dialogue letter Hebrew; names transliterated; Arabic, Persian,
Latin, Cyrillic, Greek and CJK letters rejected and sent to retry or split). A strict re-run of the
three leading arms on 12 boundaries accepted 36 of 36 trials. In 20 full blind comparisons:

- no context beat source-only 5 by 5 to 3, with 3 ties;
- paired 4 beat source-only 5 by 6 to 2, with 1 tie;
- several of the maintainer's comments pointed at ordinary run-to-run variation in fluency, not at a
  context effect.

So source-only 5 was **not** confirmed, paired 4 was not selected either (only three arms had been
re-run), and the conclusion was that the test was not able to decide yet.

**Lessons.** A check that passes the defect it should catch is not a check. And a blind review on a
handful of comparisons can flip with a few judgments, so the next design had to say in advance how
many comparisons would count as a result.

---

## 6. Round 3a: designing a test that could decide

### 6.1 The corpus

- 15 English-language titles (feature films and TV episodes of different genres), one boundary each.
- Each boundary was classified as **continuing a scene** or **crossing into a new scene** by two AI
  reviewers from different vendors, independently. Only unanimous, high-confidence labels were kept:
  **10 continuation, 5 scene-break**, none ambiguous. A timestamp gap could support a scene-break label
  but could not prove one.
- Scene breaks were scored separately, because previous lines can hurt there (leftovers from the old
  scene), and a count must not win on continuations while damaging scene changes.

### 6.2 The blind protocol, fixed before any output existed

- Each comparison shows the **first 12 lines** of the batch in full, from both arms, with the English
  source and the human Hebrew reference, sides randomized.
- The judge answers two questions: which is better (A, B, tie), and does either side carry something
  from the previous scene.
- A count becomes a finalist only with **100% structural acceptance**, a **continuation net of at least
  +2** against no context, and a cleared scene check. At most two finalists. A one-send screen never
  sets a default; a confirmation round must follow.
- An incomplete review selects nothing.

### 6.3 How strong can such a screen be?

The design was checked against its own power before running. With 4 comparisons per count and a
threshold of net +2 (and about 20% ties), a count with **no real effect passes about 22%** of the time,
and with six counts tested, the chance that **some** no-effect count passes is about **77%**. A screen
of this size can **nominate**, not prove. That is why a separate confirmation (section 8) was planned
with more comparisons per question: at net ≥ +5 of 16, the false-positive rate is about 10%, with
55–88% detection of a moderate-to-strong effect.

### 6.4 Three runs that failed, and what they taught

These failures were in the test harness, not the app, but each one changed how the app treats
similar cases.

1. **A wrong-alphabet line the model would not fix.** The first run stopped on trial 8 after 53 calls.
   Recursive splitting had isolated two single lines, and the model returned **the same wrong letters
   on every attempt**: two Arabic letters glued onto a Hebrew word, and a Korean plus a Cyrillic
   letter inside a transliterated place name. Retrying and splitting can isolate this kind of error but
   cannot repair a one-line leaf. A guarded repair was added: a fixed table that maps look-alike
   wrong-alphabet letters to Hebrew where the mapping is certain (modelled on the Kodi add-on's
   wrong-alphabet repair), and one targeted repair request for the rest.
2. **Lost evidence from a duplicate launch.** One launch started **two runner processes 3 ms apart**.
   They wrote over each other's checkpoints: receipts showed 141 calls, checkpoints kept 125 and the
   spend ledger recorded 108. No partial result was admissible. The harness gained a single-writer
   lease, write-once files (hard links, no copy fallback) and a reconciled spend journal.
3. **The check was wrong, not the model.** An offline replay of 251 captured replies showed that both
   stops of the second run were false alarms:
   - an acronym copied unchanged from the English line was rejected as "Latin letters" (58 such exact
     copies against 16 real Latin fragments in the replay);
   - two italic passages merged into one, because Hebrew word order moves a word across the gap.
     That is a faithful translation, and the check rejected it (8 valid merges against 55 cases of
     italics really dropped).

   Worse, any one unrecoverable trial stopped the whole campaign, and the failures formed a long tail
   (Arabic, Latin, Georgian, Thai, Myanmar, Cyrillic, Korean, Kannada, Katakana, markup, counts,
   indices, empty lines). The estimated chance of a full run finishing was about **0.003%**.

   Fixes: an exact Latin copy from the same source line is allowed; an unrecoverable line is **kept in
   the source language** and the trial continues, exactly as the app does (with a cap of 14 kept lines
   per campaign and 3 per trial before the run stops).

The matrix was also narrowed on the maintainer's instruction: 1 and 3 lines were dropped, 5 to 10
kept.

---

## 7. Round 3b: the screen

### 7.1 Matrix

- **Arms:** no context (N0); source-only 5, 6, 7, 8, 9, 10 (S5–S10); source-only 100 (S100); and
  **P100**, the SRT AI Translator 1.1.0 shape (the previous request and the model's raw reply as two turns, from a real
  predecessor request per boundary).
- 15 boundaries × 2 repeats = **30 trials per arm, 270 trials**, plus 15 predecessor requests for P100
  and 18 forced-split trials (each arm forced through three levels of splitting on one title, to prove
  the context survives recovery).
- 45 blind comparisons, including **5 placebo pairs** (no context against itself, two different runs)
  to measure the judge's own noise.
- One unattended overnight run under a supervisor with bounded automatic restart. About 1,130 API
  calls.
- **Content refusals were planned for, not assumed away.** The same day, a controlled probe on one of
  the study's source episodes reproduced `PROHIBITED_CONTENT` in 2 of 10 streamed sends of one batch
  and 0 of 10 non-streamed sends, after an earlier 44-send run had found none
  ([`content-block-recovery.md`](content-block-recovery.md) section 6.1). The study does not stream, so
  refusals were expected to be rare. Even so, a refused reply was given its own class with its own
  limit, which does not stop the run, and a refusal never counted against an arm's structural result.
  Otherwise a refusal could have been scored as a context failure.

### 7.2 Structural results

| Arm | Trials | Sends | Trials needing a split | Lines kept untranslated |
|---|---:|---:|---:|---:|
| N0 | 30 | 123 | 14 | 0 |
| **S5** | 30 | **75** | 8 | 0 |
| S6 | 30 | 106 | 9 | 1 |
| S7 | 30 | 126 | 9 | 2 |
| S8 | 30 | 102 | 11 | 0 |
| S9 | 30 | 123 | 15 | 0 |
| S10 | 30 | 105 | 9 | 1 |
| S100 | 30 | 60 | 4 | 0 |
| P100 | 30 | 101 | 8 | 2 |

- 262 trials accepted fully, 6 accepted with one kept line, 2 not run (one P100 boundary never got an
  accepted predecessor reply after 36 requests, so there was nothing to carry). No content blocks.
- All 18 forced-split trials were accepted.
- Observation, not a measured cause: S5 needed the fewest sends and splits of the bounded windows, and
  the same pattern appeared in the confirmation (section 8.2).

### 7.3 Blind review

Continuation comparisons against no context (wins–losses–ties) and structural acceptance:

| Arm | vs N0 | Structural | Outcome |
|---|---|---:|---|
| **S5** | **3–0–1** | 1.000 | **Finalist** |
| **S8** | **3–0–1** | 1.000 | **Finalist** |
| S9 | 2–0–2 | 1.000 | Eligible, third (cap of 2) |
| S10 | 3–1–0 | 0.967 | Not eligible (one kept line) |
| S7 | 2–2–0 | 0.933 | Not eligible |
| S6 | 1–2–1 | 0.967 | Not eligible |
| S100 | 2–1–1 | 1.000 | Reference only |
| P100 | 3–1–0 | 0.867 | Reference only |

- **Scene checks:** every one cleared. No comparison was judged to carry leftovers from the previous
  scene.
- **Placebo:** 3 of 5 identical-arm pairs were judged non-ties, below the threshold of 4 set in advance
  for "judge noise too high". It is still a reminder that a single comparison means little.
- **Automatic score (chrF, advisory only):** no arm beyond the noise floor overall. On scene breaks
  only, S5 (+0.042) and S7 (+0.043) were beyond noise in the positive direction.
- **Why the judge chose.** Each answer recorded its deciding factor. Of 23 wins for a context arm,
  **7 were decided by grammatical gender**, 4 by general quality, 3 by both, 9 not stated. Of 9 wins for
  no context, **0 were gender** and 6 were general quality. Read as a correlation from one judge:
  **previous lines fix gender; no context wins only on naturalness.** The maintainer also noted the
  context side often read more formal, which is why the confirmation tested a register instruction.
- **A flaw in the reference.** Where the human subtitle split a sentence across two lines, the
  reference shown was only the best-overlapping fragment. The review display was fixed during
  judging; the automatic score was not, which adds noise equally to every arm.
- **About P100.** 26 of 30 fully accepted: 2 not run, 2 with one kept line, 0 failed. That rate is in
  the same range as S6, S7 and S10, so it does **not** show that the SRT AI Translator 1.1.0 shape is structurally worse.
  It was never compared head to head with S5.

---

## 8. Round 3c: the confirmation

### 8.1 Matrix

S5 and S8, each with and without **R**, a sentence asking for natural spoken register including
slang (with an explicit rule never to write Latin letters). Plus no context as the baseline. 5 arms ×
15 boundaries × 2 repeats = **150 trials**, 45 blind comparisons including placebo pairs. All 487
calls ran on the free tier.

### 8.2 Results

| Arm | Sends per trial |
|---|---:|
| N0 | 3.30 |
| **S5** | **2.20** |
| S8 | 3.57 |
| S5 + R | 4.07 |
| S8 + R | 3.10 |

All 150 trials accepted, nothing kept untranslated, no content blocks.

| Question | Result |
|---|---|
| **S5 vs S8** (base prompt) | **6–1–1, net +5.** The strongest single result of the study |
| S5+R vs S8+R | 4–1–3, net +3 |
| S5+R vs S5 | 3–3 |
| S8+R vs S8 | 2–2, 2 ties |
| S5+R vs N0 | 4–0–2 |
| S8+R vs N0 | 4–0–2 |
| Scene leftovers | None in all 45 |
| Placebo | 3 of 5 non-ties, all on side B (below the noise threshold; a slight side-B lean noted) |
| Deciding factors | General quality 19, gender 8, both 6, tie 12 |
| chrF (advisory) | All arms within the 0.047 noise floor |

**The register report**, revealed only after judging: with R, English swear words were rendered as
Hebrew transliterations far more often (15 and 16 of 48 lines against 1 to 4 of 48 without R), milder
slang barely changed, no arm copied a single English word in Latin letters, but **consistency within a
trial fell** (the same word rendered the same way in 6–7 of 18 cases with R against 12–13 without).

### 8.3 The choice

The frozen scoring rule picked **S5 with R**, but only by its tie-break: R had a net of zero against
S5, and the rule leaned toward R on a tie. The maintainer chose **S5 without R**:

> "I think 5 without R as we don't know how it would effect other target languages. we might need to
> add in the tool's settings the style of translation the user can pick and set. like natural, more
> formal, adult, etc. but that for a later stage I suppose."

The R sentence was written for Hebrew, and nothing measured it elsewhere. A user-selectable
translation style is recorded as a future idea.

A defect in the confirmation's own measuring script was found afterwards: its "copied English word"
count treated formatting tags (`<i>`, `{\an8}`) as English words. Recounted without tags, the totals
were 3 (with R) against 4 (without); the conclusion did not change.

---

## 9. What the research supports, and what it does not

**Supported:**

- A short window of previous **source** lines helps grammatical gender in English to Hebrew, the most
  common reason the judge preferred a context arm.
- 5 lines beat 8 in the confirmation (net +5 of 8 decided comparisons).
- No scene leftovers were observed in any comparison involving 5 lines (screen and confirmation).
- 5 lines costs about 120 extra prompt tokens on a 100-line batch, against about 4,300 for SRT AI Translator 1.1.0's ON
  setting.
- Paired history built from the model's own output did not beat source-only once human-written
  history was removed from the test.

**Not supported, or not measured:**

- 5 lines against SRT AI Translator 1.1.0's ON setting, head to head. P100 was in the screen but never compared
  directly with S5.
- Any target language other than Hebrew, any model other than Flash-Lite 3.5 at Low thinking, or a
  second judge.
- 1 to 4 lines in the final rounds (section 11.1 covers what building the feature found).
- The quality rounds used a research prompt. The product prompt shares only the context block; the
  product's own request was then tested for structure and reliability (section 11), not for quality.
- The screen is a nomination by design (section 6.3). The confirmation is the evidence for 5 over 8.

---

## 10. The decision

### 10.1 Count and representation

Source-only, **5** lines, adjustable. Reason: S5 over S8 in the confirmation, S5 over no context in
the screen, no observed scene leftovers, low cost, and no model turn, so one bad reply cannot be carried
forward as "history".

### 10.2 Default ON, and the upgrade rule

The maintainer asked for 5 lines, **ON by default**, which changes a SRT AI Translator 1.1.0 default. That change was
explicitly sanctioned. At first he chose to switch existing OFF profiles to ON on upgrade; before the
decision was final he reversed that:

> "So instead of switching it on when user upgrades, keep the current user settings. but new install,
> default is ON."

The app tells the two apart by whether the settings file existed before the first launch: a new
install has none. An existing NG profile that never stored the setting ran with OFF (Context was OFF
by default before this decision, as in SRT AI Translator 1.1.0), so OFF is written for it once; a stored value is never
touched (migration `M8`). NG does not read SRT AI Translator 1.1.0's settings folder, so this rule protects NG profiles
from earlier builds, not SRT AI Translator 1.1.0 installations.

### 10.3 The Settings copy

Toggle: *"Send the previous few original lines with each request, so the AI knows what is happening
in the scene. Default: ON."*

Help for the count:

> **Default: 5 cues.** In our tests (Gemini Flash-Lite 3.5, Low thinking, English to Hebrew), 5
> previous lines did better than 8 in a blind review, and did better than sending no earlier lines in
> a smaller one. Other languages and models were not tested.
>
> Normally leave this at 5. Try fewer if your subtitles change scenes very quickly; try more only if
> long conversations clearly need older lines. The earlier lines are sent again as billed input. One
> cue is one subtitle item, even if its text wraps onto more than one line.

The copy names its own limits on purpose.

---

## 11. Building it: what live tests of the product found

### 11.1 One line of context makes the model translate the context

The first live test of the product used a synthetic dialogue at Batch Size 3. With **one** line in
the block, the model often translated that line instead of the batch:

| Window | Runs | Result |
|---|---|---|
| 1 line | 5 | 4 ended failed, 1 finished on its third attempt; 14 of 17 one-line-block requests were answered with the context line alone, numbered 1 |
| 2, 3, 5, 10 lines | one each, plus one free-tier run at 5 | All completed; every reply carried the batch's own lines |

The reply check refused every wrong reply, so nothing wrong was written, but a run at 1 line usually
failed. **The maintainer set the range to 4–10.** After the change, two runs at 4 lines (Batch Size 3)
and one at Batch Size 1 all completed.

A follow-up test emptied two lines so that a legal 4- or 5-line window held only one eligible line.
The same failure appeared, so a rule "send no block with fewer than 2 eligible lines" was built, and
controls showed the normal 5-line window and Context OFF were clean. That rule was removed again a day
later when the markers in 11.2 fixed the cause.

### 11.2 At the real batch size, the request collapsed

Every test so far had used Batch Size 3. Run at the default of **100**, on four titles (two feature
films, two TV episodes), the product request as first built failed badly:

| Batch Size 100 | Runs ended failed | Replies not exact | Of which collapsed (under 10% of lines) |
|---|---|---|---|
| **Product as first built**, windows 4/5/8/10 | **8 of 8** | 26 of 36 | 26 |
| Plus `CURRENT INPUT:` and an index sentence (as in the research prompt) | 0 of 8 | 3 of 74 | 0 |
| Kodi-style plain, unnumbered context lines | 1 of 8 | 3 of 66 | 3 |
| Context OFF | 0 of 6 | 2 of 53 | 0 |

The collapsed replies held 1 to 5 items: usually the batch's **last** lines, correctly translated under
their own numbers; sometimes one invented next line; once, the five context lines. Every product run
failed on its second or third request, because the identical resend collapsed again and three errors
in a row end a run. **At the default settings, new installs would have had failing runs.**

The cause was visible by comparison: the research prompt had two separators the product had not
ported, a `CURRENT INPUT:` label and a sentence listing the indices to return. The product's own
instruction says it will receive "a list of items", and the context block is a list of exactly that
shape, separated only by its heading.

At Batch Size 3 with the block trimmed to one line, the product request failed 3 of 3 runs while the
research shape had 0 bad replies in 60; with a 4-line block both were clean. So the one-line problem
in 11.1 was the same cause, made visible at a small size.

**Mean prompt cost of the separators:** about +520 tokens against the Kodi-style block on the same
windows, mostly the list of 100 indices.

### 11.3 The fix: markers plus a resend without context

Before choosing, two more designs were read:

- A Stremio add-on puts context in a separate field, renumbers each batch from 1, and on failure
  re-asks for missing lines without context, then fills gaps with warning placeholders.
- Another Kodi add-on prefixes context lines `C000:` and batch lines `L000:`, labels the batch, and
  halves the chunk on failure.

Placeholders, per-batch renumbering and automatic halving were not adopted: they conflict with the
exact reply check, the rule that a line is never replaced by a placeholder, and the rule that batch
size shrinks only when a request is too large for the model.

**Built:** the `CURRENT INPUT:` label, the index sentence, and, after any unusable reply to a request
with a block, that batch's resends go **without** the block (same error count, same wait, same
three-errors stop; the next batch carries its block again).

**Results** (four titles, first 500 lines, Batch Size 100):

| Run | Outcome | Block requests | Bad replies |
|---|---|---:|---:|
| Four titles at 5 lines | 4 of 4 completed | 16 | 0 |
| One title at 4 lines | completed | 4 | 0 |
| One title at 10 lines | completed | 4 | 0 |
| Batch Size 3, block trimmed to 1 line | completed | 9 | 0 |
| **Markers removed** (safeguard test), two titles | both completed | 6 | 6 collapsed, each recovered by the no-block resend |

At the defaults, 24 of 24 block requests were answered exactly, and one-line blocks worked.

### 11.4 Full index list or just the count?

The cheaper sentence states only the count and the first and last index. It was tested against the
full list on the original four titles, eleven more (feature films and TV episodes), and a controlled
repeat of the two batches that failed most often:

| Wording | Block requests | Wrong first reply | Context echoed | Runs stopped |
|---|---:|---:|---:|---:|
| Count and range | 107 | 5 | 0 | 2 of 23 |
| Full list | 110 | 8 | 0 | 0 of 23 |

- Every wrong reply was a line missing or duplicated, **never a context echo**.
- The same batches also failed **without any block**: one batch came back with 50 of 100 lines under
  both wordings and with no context. That is a model limit at Batch Size 100, not a context effect.
- Both stopped runs were on one batch whose first reply was wrong 3 of 4 times under either wording;
  its later attempts were the no-block resend, which is identical for both.
- The count saves about **440 prompt tokens per request**, about 7% of a request's total.

No reliability difference was shown, so **the count wording was adopted**. On the final build, at
Batch Size 100: 5 of 5 runs completed, and 2 of 31 block requests came back one line short, both
recovered by the no-block resend. At Batch Size 1, 14 of 14 requests with a one-line block were exact.

### 11.5 Two changes to neighbouring features

- **Retry pieces build their own window.** The plan had said every piece of a user's section retry
  would reuse the failed request's context. The built behaviour gives each piece its own window over
  what is accepted when the piece is built. The maintainer accepted it: a later piece sees freshly
  translated neighbours, which is strictly more information.
- **Saved progress changed.** The plan said resume was untouched, but the count must be stored to
  continue a run faithfully, so the progress record format was bumped. An older record continues only
  with Context OFF.

---

## 12. Known limits and open questions

- **Languages and models.** Every quality result is English to Hebrew on Flash-Lite 3.5 at Low.
  Structural results (markers, fallback) were also only tested on that model.
- **No head-to-head with SRT AI Translator 1.1.0's ON.** The new default is much cheaper and cannot carry a bad reply
  forward, but it is not proven to translate better than SRT AI Translator 1.1.0's ON setting.
- **The minimum of 4 is now cautious.** It was set before the markers existed; with them, one-line
  blocks were exact in every run tested. Lowering it needs a wider test at Batch Size 100.
- **Some batches fail at Batch Size 100 regardless of context.** Lines dropped from long batches are
  a separate problem (automatic recovery and batch sizing).
- **A hand-edited non-boolean value** for the toggle reads as ON; only the count is sanitised.
- **Interaction with automatic batch resizing:** the block's extra tokens are counted with the
  request, but no test measured how often they tip a request over a model's input limit.

---

## 13. Recommendations for anyone revisiting this

- **Re-test when the default model or target language changes.** The count was chosen for one model
  and one language. A small blind comparison (S5 against no context and S8) on the new pair is the
  minimum.
- **Keep the markers and the no-block resend together.** Removing the markers brought the collapse
  back in 6 of 6 block requests; the resend is what made those runs survive.
- **Test at Batch Size 100.** Two of the failures in section 11 were invisible at small sizes.
- **Do not judge on fewer than about 16 decided comparisons per question** if the result is meant to
  set a default; 4 comparisons can only nominate (section 6.3).
- **Make the reply check strict for the target script** in any quality test. Round 2 was scored on 914
  lines the product would have repaired or refused.
- **Never put human-written translations where the product would put model output.** Round 1 was
  undone by exactly that.
- **A translation style setting** (natural, formal, adult) is the open idea from the confirmation; the
  measured R sentence shows the trade-off (more natural slang, less consistency) for Hebrew only.

---

## 14. Code and checks

| What | Where |
|---|---|
| Count constants (5, 4, 10) | `electron/shared/types.ts`: `DEFAULT_BATCH_CONTEXT_LINES`, `MIN_BATCH_CONTEXT_LINES`, `MAX_BATCH_CONTEXT_LINES` |
| Window selection | `electron/engine/prompt.ts`: `selectSourceBatchContext`, `treeSourceContext` |
| Heading, instruction, label, count sentence | `electron/engine/prompt.ts`: `SOURCE_CONTEXT_HEADING`, `SOURCE_CONTEXT_INSTRUCTION`, `CURRENT_INPUT_LABEL`, `currentIndicesInstruction` |
| Request assembly | `electron/engine/prompt.ts`: `translationRequest` |
| When a request carries a block; resend without it | `electron/engine/run.ts`: `carries`, `withBlock`, `blockDropped`, `resendAfter` |
| Default and upgrade | `electron/main/store.ts` (`batchContext: true`), `electron/main/migrations.ts` (`M8`, `sanitizeBatchContextLines`) |
| Settings UI and copy | `src/pages/SettingsPage.tsx` |
| Saved progress | `electron/engine/progress.ts`, `electron/main/resumeStore.ts` |

Checks in `scripts/gates/gates.ts`: `R15 L.1` (defaults, upgrade, range), `R15 L.2` (selector),
`R15 L.3a` (request shape, OFF byte-identity), `R15 L.3b` (run behaviour), `R15 L.3c` (resend without
block), `R15 L.4` (Settings), `R18 G.3` (context inside the recovery tree).

---

## 15. Label index

| Label in code comments | Meaning | Section |
|---|---|---|
| `F3` | The original feature idea: context across batches | 2 |
| `E100` | Round 1 result (paired 8), withdrawn | 4 |
| `E135` | Round 1 withdrawn: human-written history in prompts | 4.7 |
| `E136` | Round 2 result (source-only 5, OFF) | 5 |
| `E137` | Wrong-alphabet defect; Round 2 withdrawn | 5.4 |
| `E138`–`E153` | Round 3 test design, harness failures and fixes | 6 |
| `E154` | The screen | 7 |
| `E155` | The confirmation | 8 |
| `E156` | The final decision and upgrade rule | 10 |
| `D15-1` … `D15-12` | Round 1 decisions (historical) | 4.7 |
| `D15-1R` | Default and count (ON for new installs, 5, 4–10) | 10.1, 10.2 |
| `D15-2R` | Why 5, and the help copy | 10.3 |
| `D15-3R` | Source-only block, exact heading, no model turn | 1.1 |
| `D15-4R`, `D15-5R` | Eligibility: committed, accepted, non-blank; no backfill; recovery and retries | 1.2, 1.4 |
| `F15-N1` … `F15-N4`, `F15-P1` … `F15-P6` | Parity notes: NG behaviour and the SRT AI Translator 1.1.0 behaviour it replaces | 1, 2 |
| `M8` | The upgrade migration | 10.2 |
| `TD15-1` | Retry pieces build their own window | 11.5 |
| `TD15-2` | Progress record stores the count | 11.5 |
| `TD15-3` | Range 4–10 | 11.1 |
| `TD15-4` | Batch-100 collapse, markers, count wording, no-block resend | 11.2–11.4 |
| `R15-02` | The removed "at least 2 lines" rule | 11.1 |
| `v3-core.mjs` | The research prompt used in Round 3 | 6–8 |
| `D6-9`, `N13` | Why a kept or unaccepted line is never context | 1.2 |
