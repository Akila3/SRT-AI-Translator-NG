# Recovery from unusable replies and content refusals

**Decision in one paragraph.** When a batch's reply cannot be used, what happens next depends on what
went wrong. An unreadable reply is resent unchanged, and three errors in a row stop the run. A reply
with lines missing is resent once, then the batch is split in halves. A content refusal is either
resent once (`OTHER`, or no reason given) or split at once (`PROHIBITED_CONTENT`). Splitting continues
until each line is translated or is down to a single line that still fails. That line is **kept in the
source language**, named in the run panel and counted before Save, and it is **never** sent as context
to a later request. Safety thresholds are relaxed to `BLOCK_NONE`, as the old engine did, with a
one-time `OFF` fallback.

**Status:** current. **Evidence scope:** refusal behaviour was probed on Gemini 3.7 Flash
(transcription requests) and confirmed live on Gemini 3.5 Flash-Lite (translation), English to Hebrew
and Hebrew audio. The transcription probes reproduced only `OTHER`. A later controlled translation
campaign (September 29, section 6.1) reproduced `PROHIBITED_CONTENT` in 2 of 10 streamed sends of one
passage and 0 of 10 non-streamed sends of the same passage. The native engine then met
`PROHIBITED_CONTENT` live twice, on that same passage.

**How to read this file.** Section 1 is what the code does. Section 2 is the starting point in 1.1.0.
Section 3 is the timeline. Sections 4 to 9 are the tests and design reviews, in order. Section 10 is
the decision and why, section 11 what the build and live runs showed, and sections 12 to 15 the
limits, recommendations, code map and label index.

---

## 1. What the app does today

### 1.1 The ladder

| What came back | First step | Next |
|---|---|---|
| **Unreadable reply** (not JSON, or not a list) | Resend the same request after 5 seconds | Keep resending; the third error in a row stops the run with the partial kept. **Never split, never kept** |
| **Missing lines** (a list, but at least one requested line has no single usable entry) | Resend once (counts as one of the three errors) | Split the batch in halves, keeping the lines the reply did answer |
| **Content refusal, `OTHER` or no reason** | Resend once, unchanged (not counted as an error) | Split in halves |
| **Content refusal, `PROHIBITED_CONTENT`** | Split in halves at once | — |
| **Quota, overload, network** | Wait, switch key or resend (see `retry.ts` and [`free-tier-protection.md`](free-tier-protection.md)) | The same limit of three errors in a row |

A committed batch resets the error count to zero. A reply that names a line that was not asked for,
or that has an item whose line number cannot be read, keeps **nothing** in hand: such a reply may be
renumbered (lines 1–4 returned for 0–3), and keeping its "matching" entries would put text on the
wrong line.

### 1.2 The recovery tree

- The failed batch's open lines are halved, left half first, and each half is asked as its own
  request. A half that fails is halved again. A single line is asked alone and kept only if it still
  fails.
- **Bounded:** at most `ceil(log2(batch size))` levels deep and at most **2 × batch size** extra
  requests. Past either bound, the open lines are kept with reason `BUDGET_FLOOR`.
- Each request in the tree builds its own Cross-Batch Context window from its own first line, over
  lines committed before the tree plus lines accepted earlier in the same tree
  ([`cross-batch-context.md`](cross-batch-context.md) section 1.4).
- Lines recovered inside the tree are held privately and **committed together** when the tree ends.
  The partial file and the saved progress never show a half-recovered batch.
- `recover.ts` owns only the recursion. It does not know what a block is or what the reasons mean; the
  caller passes in how to ask, how many requests are allowed and how to record a kept line.

### 1.3 A kept line

- It keeps its own index, its own start and end time, and its source-language text. It is never
  dropped, never empty and never a placeholder.
- It carries a reason: `CONTENT_BLOCKED`, `REASON_ABSENT` (the API refused with no usable reason),
  `UNPARSEABLE_REPLY` (kept in the type for completeness; the current Translate path never produces
  it, because an unreadable reply is resent, not split) or `BUDGET_FLOOR`.
- The run panel names every kept line by number and reason at the end of its tree, the end of the run
  and on Stop. A notice beside Save says how many lines are kept before a destination is chosen. The
  saved progress record marks the line as kept, so Continue restores it as kept.
- **No reason makes a kept line eligible as context.** `contextEligible` is a single function that
  returns `false` for every reason and for anything it does not recognise.

### 1.4 Safety settings

Every request sets the four adjustable harm categories (harassment, hate speech, sexually explicit,
dangerous content) to `BLOCK_NONE`. If Google rejects that setting for a model with a 400 that names a
safety setting or threshold, the request is sent once more with the categories at `OFF`. That resend
is not counted as an error, and the model uses `OFF` for the rest of the app session. A second
rejection is an ordinary stop.

### 1.5 Transcription

The same idea applies to transcription, with two differences that follow from what is being
recovered. The unit is a stretch of audio, not a list of lines, and an unrecovered stretch becomes an
**explicit, named gap**, because there is no source text to keep. Splitting stops at 30 seconds,
4 levels deep, and the extra audio is capped at the run's own length. A `PROHIBITED_CONTENT` refusal
is halved at once; other refusals get one unchanged retry first.

---

## 2. The starting point: what 1.1.0 did

- **gst stopped the whole run on any content block.** It raised an interrupt on itself, saved the
  partial file and exited. Nothing was retried and nothing was split.
- **gst could not tell the user why.** The block reason lived in a local variable inside gst and never
  reached the app. With streaming on, a refusal surfaced as `Expected N lines, got 0`, which looked
  like a count error. The known workaround was to turn streaming off, which made the block report
  honestly but still ended the run.
- **gst's reply check was weaker** (see [`native-translation-engine.md`](native-translation-engine.md)
  section 2), and it repaired broken JSON with a library rather than refusing it.
- **gst resent a bad reply unchanged** after 5 seconds, up to three errors in a row. This is the
  behaviour NG kept for unreadable replies.
- A recovery feature for refusals had been planned for 1.1.0 and parked, because the engine hid the
  signal it needed. One of the maintainer's 1.1.0 test notes already said the same refusal also
  appears on the transcription path, and that "any fix should cover both paths rather than one".

---

## 3. Timeline

| When (2026) | What | Outcome |
|---|---|---|
| Sep 10–12 | Transcription probing (about 180 live calls in ten rounds), for a different feature | Captured real refusals, their exact response shape, and how they behave on retry, on split and with safety settings |
| Sep 11 | Recovery design reviewed against an open-source research pipeline the maintainer suggested | Its split-on-missing-lines idea adopted; its "skip the line" rule rejected |
| Sep 12 | Maintainer widens scope | Both paths (translate and transcribe), both reasons (`OTHER` and `PROHIBITED_CONTENT`) |
| Sep 12 | Streaming question put to the maintainer | Keep no-streaming; rely on retry and split |
| Sep 12–13 | Five design-review rounds on what a kept line may put in the next request | Kept lines are never context, for any reason |
| Sep 29 | Controlled translation campaign on the episode where 1.1.0 had been blocked (section 6.1) | `PROHIBITED_CONTENT` reproduced 2 of 10 when streamed, 0 of 10 when not; an earlier "not reproduced" result superseded |
| Oct 6 | Native engine compared with the old engine on 11 episodes | 4 bad replies in 34 runs; the native engine stopped on its one, the old engine recovered its three with a resend |
| Oct 10 | Resend built; first live `PROHIBITED_CONTENT` on the native engine | One resend for bad replies; the block was not resent and the section was offered for retry |
| Oct 15 | Ladder details set | A first missing-lines reply gets one resend before any split |
| Oct 16 | Recovery tree built and run live | 300 refused lines, all 300 recovered; a transcription refusal recovered by halves |

---

## 4. The refusal probes (September 10–12)

These probes were run for the transcription feature, but they produced every measured fact about
refusals that this feature rests on. Requests were 3- to 12-minute stretches of a Hebrew-language
recording the maintainer supplied, sent to Gemini 3.7 Flash. Every probe kept the **whole** response
body, including its list of keys. That rule came from an earlier mistake: a script that kept only a few
fields printed `undefined` for a refused request, and three rounds of notes recorded "the API gives no
signal", when the response in fact said `{"promptFeedback":{"blockReason":"OTHER"}}` and had no
`candidates` key at all.

### 4.1 What a refusal looks like

On the non-streaming path, every refusal had the same shape: `promptFeedback.blockReason` present and
the `candidates` key **absent**. Not one refusal arrived as a candidate with `finishReason: SAFETY`;
that value was never seen in any capture. The dedicated transcription model behaved differently: on 4
of 4 attempts, including the exact stretch Flash refused, it returned `promptFeedback: null`, finished
with `STOP` and transcribed the stretch completely (349 words). So a recovery that waited for a block
signal would see nothing on that path. A recovery triggered by missing output sees both cases.

### 4.2 Does splitting help, and why

A 12-minute stretch (33:00–45:00) was refused. Splitting recovered the later 6 minutes (101 lines),
then a further 3 minutes (48 lines), converging on a 3-minute stretch. That 3-minute stretch was then
refused on **5 of 6** attempts, while the stretch next to it was **never** refused.

**Conclusion:** splitting works by **isolating** a local trigger, not by diluting it. The trigger
survived being cut from 12 minutes to 3. A batch refused because of one line will isolate that line.

### 4.3 Is a refusal repeatable

Five byte-identical requests for the refused 3-minute stretch: **4 refused, 1 complete** (37 lines,
the whole stretch). A stretch the maintainer's own earlier run had been refused on came back clean on
**2 of 2** later attempts.

**Conclusion:** `OTHER` is not deterministic. Google's own block text for it says it "can occasionally
trigger by mistake". One unchanged retry has roughly a one-in-five chance of a complete answer, for the
cost of one request. Each refused attempt was billed about 5,166 input tokens on a 3-minute stretch.

### 4.4 Does the cache serve the refusal

Four of the five repeats carried a cache hit (3,167 cached tokens), **and so did the one that
succeeded**. Had the success not happened, three refusals with cache hits would have read as "the cache
serves the refusal, so retrying is useless", a cause inferred from a pattern. **Conclusion:** the retry
does not need to be made different from the original to have a chance.

### 4.5 Do relaxed safety settings prevent it

A controlled pair: the same stretch, model and instruction, once with the four categories at
`BLOCK_NONE` and once with no safety settings at all. Both: `blockReason: "OTHER"`, no candidates,
zero lines. **Identical.** All 12 Flash requests in that round sent `BLOCK_NONE` and every one was
accepted (HTTP 200), so the setting itself is not rejected.

**Conclusion:** `BLOCK_NONE` does nothing for `OTHER` or `PROHIBITED_CONTENT`, which are outside the
adjustable categories. It is kept because it stops ordinary profanity, violence and adult dialogue in
those four categories from being blocked, which is the common case for subtitles and what gst did.
The research pipeline's own comments say the same: policy-level blocks "are often non-overridable", so
splitting "remains the reliable backstop". Two independent sources agree.

### 4.6 What streaming would have saved

With streaming, on the refused stretch, the model **sent real, correctly timed lines before the block
arrived** in the second-to-last chunk and invalidated them:

| Attempt | Chunks | Block arrived at | Lines already sent | Stretch covered |
|---|---|---|---|---|
| 1 | 17 | chunk 16 | 9 | 15.6% |
| 2 | 86 | chunk 85 | 43 | 75.0% |

The same stretch without streaming returned no candidates and no text, five times. This matched an
observation from the maintainer's 1.1.0 runs.

---

## 5. Design: what to adopt from the reference pipeline (September 11–12)

The maintainer pointed to an open-source research translation pipeline that already split refused
batches. Its code was read in full before deciding.

| Its behaviour | Decision | Why |
|---|---|---|
| Splits on **missing lines**, never reads the block reason | **Adopted** | One trigger covers a refusal and a reply that came back short. NG's exact reply check already computes the missing set, so the trigger costs nothing |
| Recomputes context **for each half** from that half's own first line | **Adopted** | A naive split gives the second half the context of the parent's start: complete, valid output with the wrong antecedents, which no count check can catch |
| Stops at one line; depth `ceil(log2 B)`, at most `2B` requests | **Adopted** | A bounded cost even when every line is refused |
| Relaxes safety settings, falling back to `OFF`, never crashing | **Adopted as an optimisation only** | Section 4.5 |
| **Skips** a line still refused at one line | **Rejected** | Its output was one record per line, so a gap was harmless. A subtitle file is not: a missing index either fails the count check or, if renumbered around, produces a file that reads as complete when it is not |
| Treats an unreadable reply as an empty result, which triggers a full split | **Rejected** | Splitting cannot make output parseable. It would spend up to `2B` requests, recover nothing and keep every line, and tell the user about refused content when the truth was a garbled reply |

---

## 6. Design: the block reason chooses the first step (September 12)

The maintainer asked for both reasons to be covered: *"usually those are the same reason of some
violation words or sentences, but different nature then violence and swear words."* Detection already
covered both, because the trigger never reads the reason. What remained was what to try first.

| | `OTHER` | `PROHIBITED_CONTENT` |
|---|---|---|
| What it is | Google's non-configurable filter, which "can occasionally trigger by mistake" | A policy decision, far more likely to repeat on the same text |
| Measured | 1 complete in 5 identical retries; 2 of 2 clean on a stretch refused earlier | Not reproduced in the transcription probes (later reproduced on translation, section 6.1) |
| **First step** | **Resend once, then split** | **Split at once** |

**The honest gap at the time:** every refusal NG had measured was `OTHER`. The `PROHIBITED_CONTENT`
column rested on the documented nature of that block and on what the maintainer had read in the API
console during a 1.1.0 run. It was a strategy chosen from a documented property, not from a
measurement. Section 6.1 and section 11 record what was measured later.

### 6.1 Later measurement: a controlled translation campaign (September 29)

**Why.** The maintainer had seen `PROHIBITED_CONTENT` in a 1.1.0 run on an English TV episode
(737 lines), at Batch Size 300, on lines 301–600. Before the context study (see
[`cross-batch-context.md`](cross-batch-context.md)) ran on similar material, the question was whether
that block could be reproduced, and under which conditions.

**Setup.** Gemini 3.5 Flash-Lite at Low thinking, free key, safety at `BLOCK_NONE`, the study's own
request shape (not 1.1.0's prompt; the model 1.1.0 used that day was not recorded). Two episodes of
the same series (series A), the 737-line episode being the one 1.1.0 had been blocked on.

| Run | What was sent | Sends | Blocked |
|---|---|---|---|
| 1 | Both episodes, 100-line batches, two passes, no streaming | 32 | 0 |
| 2 | 300-line batches, streaming off and on | 12 | 0 |
| 3–5 | The whole 737-line episode at 300 lines per batch, repeated, streaming off and on | 34 | 2 |

Runs 1 and 2 alone gave **44 of 44** sends finishing normally, and were first recorded as "not
reproduced". **That conclusion was withdrawn** once more streamed repeats of the same batch were made.

**Result, combining runs 2 to 5:**

| Batch | Streamed | Not streamed |
|---|---|---|
| Lines 301–600 | **2 of 10 blocked** | 0 of 10 blocked |
| Lines 1–300 and 601–737 | 0 of 12 blocked, either way | |
| Lines 301–450 and 451–600 (150-line halves), streamed | both passed | |
| Lines 301–600 with the previous 300 source lines as context | 0 of 4 blocked | |

Both blocks were **response-side**: `finishReason: PROHIBITED_CONTENT` with partial output, and no
`promptFeedback`. The two blocked streams stopped at different points, after 79 items and after
170 items.

**Analysis.**
- The streamed and non-streamed sends are a controlled pair: the same request body, only the endpoint
  differs. But 2 of 10 against 0 of 10 is too small a sample to establish that streaming causes the
  block. It is recorded as a correlation, not a mechanism.
- The different stopping points mean the block is not tied to one fixed line. A test cannot rely on a
  chosen excerpt to fire it.
- Both 150-line halves passed, which was the first sign that halving could get past this reason.
- A side result: at 300 lines per batch only 3 of 12 replies passed the study's reply check (two of
  them count or index failures), against 22 of 32 at 100 lines.

**Conclusion.** `PROHIBITED_CONTENT` is real on this passage, intermittent, and in this sample seen only
when streaming. 1.1.0 streams by default, which fits the maintainer's original sighting. NG does not
stream (section 7), so the block should be rarer, but not impossible: section 11 records the native
engine meeting it twice on the same passage without streaming. Splitting at once, rather than
resending, is consistent with all of this.

---

## 7. Design: should streaming come back to save the partial lines (September 12)

Section 4.6 showed that the no-streaming rule (a reduction from 1.1.0 the maintainer had already
accepted) could throw away up to 75% of a stretch the model had already produced. That had never been
weighed: the original decision weighed honest reporting, not salvage.

It was put to the maintainer with a recommendation to **keep** no-streaming, for four reasons:

1. In 1.1.0, streaming was exactly where a refusal got disguised as a count mismatch.
2. Streaming brings back that control-flow hazard.
3. 43 partial lines are worth less than the 37 **complete** ones a single retry produced.
4. The maintainer's own workaround for a blocked translation in 1.1.0 was to turn streaming off.

**Decision: keep no-streaming; retry once, then split.** The record sets a trigger to reopen it: if
real runs ever keep materially more lines than the ~20% rate the decision was taken on, the question
goes back to the maintainer.

---

## 8. Design: what a kept line may put in the next request (September 12–13)

This took five review rounds. The question looked simple, and each answer created a new defect. The
progression is the useful part.

| Round | Proposal | Defect found |
|---|---|---|
| 1 | Send the kept line in the previous-translation turn as if translated | **Fake history:** the request tells the model that the source text *is* the translation |
| 2 | Leave it out of the translation turn only, keep it in the source turn | **Fake omission:** a source turn of N lines beside a translation turn of N−1 is exactly the "missing lines" failure, presented as a correct answer |
| 3 | Remove it from both turns; carry its source text in an unnumbered background block | **Spreading refusal:** a refused line's text *is* the text the filter rejected. Every later request whose window covered it would carry it. Splitting shrinks the batch, not the window, so every half is refused again, each new kept line joins the window, and one refused line can leave a long run of the file untranslated while every check still passes |
| 4 | Carry it only for reasons that are "not content": an unreadable reply or a spent budget | Both of those causes are unknown. An unreadable reply may be a refusal rendered oddly, and a budget runs out *because* the line kept being refused |
| 5 | **No reason is eligible.** A kept line appears in no part of any later request | — |

Two further rules came out of the same reviews:

- **The previous-translation turn may contain only output the model produced and the reply check
  accepted**, and its line numbers must exactly match the source turn's. (NG later stopped sending
  previous translations at all; see [`cross-batch-context.md`](cross-batch-context.md).)
- **Check the raw reply before storing it.** Storing entries in a map keyed by line number silently
  erases duplicates, so `[1, 2, 2, 4]` for lines 1–4 would have produced a perfect-looking set with
  one line's text overwritten and another missing.

**The cost:** the context window is one line shorter for each kept line nearby. A 5-sample probe
could not have proven that carrying a refused line is safe, because the same refusal recovered 1 time
in 5. Hence a fail-safe default rather than a measured exception.

---

## 9. The trigger for a resend: the native-vs-old-engine comparison (October 6)

Before this feature existed, the native engine stopped on the first bad reply. The 11-episode
comparison ([`native-translation-engine.md`](native-translation-engine.md) section 5) measured how
often that mattered:

- The old engine resent a batch in **3 of 22** runs (`Expected 100 lines, got 99.` twice and
  `got 79.` once). One resend fixed each.
- The native engine met **1** bad reply in 12 runs (lines returned twice) and stopped, keeping the
  partial.
- **4 bad replies in 34 runs:** about one run in eight would have stopped where 1.1.0 finished.

The maintainer had the resend built before the old engine was removed. It follows gst exactly:
resend unchanged after 5 seconds, one shared count of errors in a row (transport errors included),
stop at 3, reset on a commit, never resend a block.

---

## 10. The decision, and why each part is the way it is

| Rule | Reason |
|---|---|
| Unreadable reply: resend, never split | Section 5: splitting cannot fix a serialisation fault, and its cost is maximal |
| Missing lines: resend once, then split | Maintainer's answer (Oct 15). Most short replies are one-off (section 9: one resend fixed all three); a second shortfall on the same batch is worth isolating |
| `OTHER` / no reason: one unchanged resend, then split | Section 4.3: about 1 in 5 identical retries is complete. Section 4.4: no need to vary the request |
| `PROHIBITED_CONTENT`: split at once | Section 6: likely to repeat; a resend would usually be wasted |
| The resend of a block is not counted as an error | Otherwise a block after two network errors would stop the run instead of recovering |
| The reason chooses the first step, never whether to recover | A refusal with no reason is still recovered |
| Keep, never skip | Section 5 |
| Kept lines never become context | Section 8 |
| Tree committed whole | Nothing outside the tree sees a half-recovered batch |
| `BLOCK_NONE` with one `OFF` fallback | gst parity for the four adjustable categories; section 4.5 says it is not a refusal fix |
| No streaming | Section 7, maintainer's decision |

---

## 11. What the build and the live runs showed

### 11.1 Checks

Each design rule has a check that fails if it is broken (`R18 G.1` to `R18 G.9a`). Six real refusal
bodies captured during the probes are stored as fixtures (`scripts/gates/fixtures/bundle-g/
responses.json`); they are transcription requests and carry no text. Synthetic bodies, labelled as
synthetic in the file, cover `PROHIBITED_CONTENT`, a refusal with no reason, a short reply and a
non-JSON body. End to end, with a captured `OTHER` refusing every request that holds line 3 of 8
(batches of 4), the request order is `1-4, 1-4 (resend), 1-2, 3-4, 3, 4, 5-8`, line 3 is kept with
`CONTENT_BLOCKED` and every other line is translated.

### 11.2 First live `PROHIBITED_CONTENT` (October 10)

An English TV episode (737 lines) at Batch Size 300, context off, on the native engine before the tree
existed. Lines 301–600 were refused with `PROHIBITED_CONTENT`. The batch was sent **once** (two
requests in total, no resend), the block was named once in the log, and the run ended with lines
301–600 offered for a section retry. This confirmed the "do not resend a policy block" half of the
rule.

### 11.3 The tree, live (October 16)

The packaged app, real clicks, the same 737-line episode, Batch Size 300, Gemini 3.5 Flash-Lite at Low,
free key:

- Lines 1–300 and 601–737 translated first time.
- Lines 301–600: the first reply left out line 600 (missing lines, one resend, "Error 1/3"); the resend
  was refused with `PROHIBITED_CONTENT`, which opened the tree **at once**, with no unchanged resend;
  both 150-line halves were translated.
- Six requests for that batch (four ordinary, two recovery), 25,332 tokens billed but unusable.
- Saved: 737 lines, every time equal to the source.

**Recovery rate:** one tree, 300 lines, 300 recovered, **0 kept**. One run is one data point, not a
rate; it is far from the ~20% figure that would reopen the streaming decision.

**The second sighting matters.** The native engine was refused with `PROHIBITED_CONTENT` on the same
passage of the same episode on two different days, without streaming, and halving it recovered every
line. Together with the 150-line halves that passed in section 6.1, this is the NG evidence that
splitting works on that reason too, not only on `OTHER`.

### 11.4 Transcription, live (October 16)

A 71-minute Hebrew recording, 15 parts of 5 minutes, paid key:

- **Gemini 3.7 Flash:** part 5 was refused `OTHER`, asked again unchanged once, refused again, then
  halved; both halves came back. 4,881 seconds of audio sent for 4,281 usable. The recovery cut part 5
  at a fractional second, and one line ran 0.65 seconds into the next part; that was fixed by making
  the next part's opening lines follow the previous committed line, without rewriting the committed
  part.
- **Dedicated transcription model:** four full runs, **zero refusals**. Its refusal handling stays
  covered by checks only.

### 11.5 What was not seen live

- The unchanged resend of an `OTHER` block on **translation**: no `OTHER` translation refusal occurred.
- A kept line restored through Continue: the provider did not refuse that run.
- The `OFF` fallback: no refusal of `BLOCK_NONE` has been captured, so the pattern that recognises one
  is written from Google's documented error format and is marked as unverified in the code.

---

## 12. Limits

- **Small live sample.** One translation tree and one transcription split. The recovery rate is
  unknown in general.
- **`PROHIBITED_CONTENT` on resend is still not measured.** It is not known how often an unchanged
  resend would have succeeded; the "split at once" rule saves that request on the assumption that it
  usually would not.
- **The fifth adjustable category, civic integrity, is not sent**, matching gst's four.
- **One model per path** was probed for refusals.

## 13. Recommendations

- Keep the whole response body on every failure. Every useful fact here came from a field a projecting
  script would have dropped.
- If a future change wants to carry a kept line's text as context, it must first measure, on the
  captured refusing text, that a request carrying it is accepted; and it must ship a context-isolation
  retry in the same change. The code keeps a seam for that retry (`treeSourceContext` with
  `isolated`), unused today.
- Track how many lines real runs keep. A rate near 20% is the agreed signal to reopen the streaming
  decision.
- Do not read a single successful split as proof that splitting always helps. Section 4.3 shows how
  non-deterministic a single attempt is.

## 14. Code and checks

| What | Where | Checks |
|---|---|---|
| The ladder | `electron/engine/run.ts` (after the batch's own request, and `openTree`) | `R18 G.6` |
| The recursion | `electron/engine/recover.ts` (`recoverCues`) | `R18 G.5` |
| Reply shapes | `electron/engine/validateTranslationBatch.ts` (`ReplyShape`, `replyTrigger`) | `R18 G.2` |
| Block reason | `electron/engine/blocks.ts` (`classifyBlock`, `announcedBlock`) | `BK23`, `R18 G.2` |
| Kept lines and the tree | `electron/engine/translationState.ts` (`contextEligible`, `openTree`, `commitTree`) | `R18 G.1`, `R18 G.7` |
| Context inside the tree | `electron/engine/prompt.ts` (`treeSourceContext`) | `R18 G.3` |
| Safety posture | `electron/engine/providers/gemini.ts` (`geminiSafetySettings`), `electron/engine/retry.ts` | `R18 G.4` |
| Resend and the error count | `electron/engine/run.ts`, `electron/engine/retry.ts` | `RK26`, `P3-D1` |
| Transcription refusals | `electron/engine/transcribe.ts` (`refusalRetries`) | `CV18`, `R18 G.8` |
| Captured response fixtures | `scripts/gates/fixtures/bundle-g/responses.json` | `R18 G.9` |

## 15. Label index

| Label | Meaning | Section |
|---|---|---|
| `FP-9` | The parked 1.1.0 recovery feature this replaces | 2 |
| `D1` | Resend an unusable reply unchanged, gst's way, on one error count | 9, 10 |
| `D4` | No in-batch streaming (a sanctioned reduction from 1.1.0) | 7 |
| `D6-1` | The trigger is missing lines, not a block signal | 5 |
| `D6-2` | Context recomputed for each half | 5 |
| `D6-3` | One line, `ceil(log2 B)` depth, `2B` requests | 5 |
| `D6-4` | Relaxed safety settings are an optimisation only | 4.5 |
| `D6-5` | Keep a refused line, never skip it | 5 |
| `D6-6` | An unreadable reply is not a block | 5 |
| `D6-7` | One feature, two paths (translate and transcribe), two kept-output rules | 1.5 |
| `D6-8` | The reason chooses the first step | 6 |
| `D6-9` | What a kept line may put in the next request | 8 |
| `N11` | The partial lines streaming would have saved | 4.6, 7 |
| `N12`, `N13` | Fake history; the spreading refusal | 8 |
| `AS-43` | Does a halved batch refuse less often | 4.2 |
| `AS-44` | Is `BLOCK_NONE` still accepted | 4.5 |
| `AS-47` | Does a translation refusal look like a transcription one | 6.1, 11.2, 11.3 |
| `E154a`, `E154b` | The controlled translation campaign; `E154a`'s "not reproduced" superseded by `E154b` | 6.1 |
| `AS-48` | Is a retry worth its cost | 4.3 |
| `AS-49` | `PROHIBITED_CONTENT` gets no retry on transcription | 1.5 |
| `AR-FINAL-2` | Both refusal shapes supported: missing lines and announced block | 1.1 |
| `§17.8R`, `PR-1`, `PR-2` | The ladder and the tree | 1.1, 1.2 |
| `PR-3`, `PR-5` | Kept lines through output, the record and Continue | 1.3 |
| `PR-4` | The `OFF` safety fallback | 1.4 |
| `G1` | The known gap closed by the resend | 9 |
