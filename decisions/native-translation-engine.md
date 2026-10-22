# Native translation engine: batches, the reply check, commits and defaults

**Decision in one paragraph.** NG translates with its own TypeScript engine instead of the Python
command-line translator 1.1.0 ran. It sends the same prompt, in batches of up to 100 lines (and under
300 seconds of audio when translating with media), with 1.1.0's generation defaults. It is stricter
than the old engine in three places: a reply must return **exactly** the requested lines, broken JSON
is refused rather than repaired, and a batch is committed whole or not at all. Before the old engine
was removed, the two were run side by side on 11 episodes, and the native engine matched it on
structure, prompt size and blind-reviewed quality.

**Status:** current. **Evidence scope:** English to Hebrew, Gemini 3.5 Flash-Lite at Low thinking, one
human judge for quality. The structural rules do not depend on language or model.

**How to read this file.** Section 1 is what the code does today. Section 2 is the old engine it
replaced. Section 3 is the timeline. Section 4 covers the build-time checks, section 5 the side-by-side
comparison, section 6 what it found, section 7 the decisions and why, and sections 8 to 11 the limits,
recommendations, code map and label index.

Two names recur. **1.1.0** is *SRT AI Translation UI* 1.1.0, the earlier desktop app. **gst** is the
engine it ran, *gemini-srt-translator* 3.7.0. "Parity" means kept because 1.1.0 did it and nothing
measured a better choice.

---

## 1. What the app does today

### 1.1 Defaults

| Setting | Default | Origin |
|---|---|---|
| Batch Size | 100 lines | 1.1.0 |
| Audio per batch (Translate with media) | under 300 seconds | gst `audio_chunk_size` |
| Thinking level / budget | Low / 512 | 1.1.0 |
| Custom generation parameters | OFF (temperature 1.0, top-P 0.95, top-K unset; not sent while OFF) | 1.1.0 |
| Service tier | Standard | 1.1.0 |

They live in `electron/main/store.ts` (`defaults`). Cross-Batch Context, Continue and the
free-tier settings have their own records.

### 1.2 Batching

- Lines are sent `Batch Size` at a time, in order.
- With audio, a line joins a batch only while the batch's audio, measured in whole seconds from the
  first line's start to the latest end of any line in it, stays under 300 seconds. A single line
  longer than the cap is sent alone.
- Each batch's audio is cut to cover the whole of its last line, so the model hears every line it is
  asked to translate.

### 1.3 The reply check

A reply is accepted only if it is strict JSON in the requested shape and its line numbers are exactly
the requested ones: each once, none missing, none repeated, none extra, no empty or whitespace-only
text against a non-empty source line, and no text that contains a timing line. Timing is never read
from a reply; every line keeps its source timing. The raw list is checked **before** anything is stored.

### 1.4 Commits and files

- A batch's translations join the result only when the whole batch passes.
- After every commit the **partial** file is rewritten whole: every source line, translated where a
  batch has committed and in the source language elsewhere. It is written to a temporary file, flushed
  and renamed over the old one, so at any instant it is a complete subtitle.
- The destination is written last, only when every line is done and a final read-back confirms the
  same line count and timings as the source.
- A reply that arrives after Stop is never committed.

### 1.5 The prompt and the System Prompt Override

- With no override, the system instruction is gst's translation instruction, character for character.
  A check compares it with gst's own function output for every branch (thinking on or off, with or
  without media, with or without a description).
- **A non-empty System Prompt Override is added, never substituted.** It goes after every built-in
  rule as its own Translation Guidance section and removes none of them (`electron/engine/prompt.ts`,
  `translateInstruction`). The reply is still checked against the app's own reply format, and the
  description and reasoning rules are unchanged.
- **Why additive (October 18).** Until then an override **replaced** two built-in rules: Preserve
  Formatting and, with media, the gender-from-audio rules. A user who typed a short style note could
  therefore lose formatting preservation without knowing. Making it additive means an override can only
  add guidance; if it contradicts a built-in rule, both are sent.
- **Consequence for paused work.** The change altered what a request contains, so new runs record
  prompt contract `translate-prompt/v3`, and an older paused job with a non-blank override cannot
  continue. See [`continue-and-retry.md`](continue-and-retry.md) section 4.1 for the rule and the
  regression that required it.

### 1.6 Responsiveness while preparing

1.1.0 ran the engine as a packaged Python subprocess, and a verification run (the "buffering" control)
proved that its progress lines reached the app while it worked rather than in one burst at the end.
That control went with the subprocess, but the requirement it guarded (progress you can see, and a
Stop that works before any request is sent) remains. The same verification run now checks the native
engine's media preparation on a synthetic 10-minute fixture; it is recorded in
[`transcription.md`](transcription.md) section 19.1: ten FFmpeg progress updates spread across
preparation, and a stop at the first request so nothing reached the provider.

---

## 2. The starting point: what gst did

| Area | gst 3.7.0 | Why it mattered |
|---|---|---|
| Reply check | Each returned line number had to **belong to** the batch | `[1, 2, 2, 4]` for lines 1–4 passed: line 2 written twice, line 3 left in English, in a file that looked complete |
| Broken JSON | Repaired with the `json_repair` library, nested lists flattened | A repaired reply is a guess about what the model meant. A truncated list that the library closes is exactly a short reply |
| Writing | Line by line as it validated | A reply that failed half-way left its first half applied |
| Empty text | Only `""` was refused | A whitespace-only line was written as an empty subtitle |
| Bad reply | Resent unchanged after 5 s; three errors in a row stopped the run | Kept (see [`content-block-recovery.md`](content-block-recovery.md)) |
| Content block | Stopped the run | Replaced by the recovery ladder |
| Audio batch | The cap had exceptions (a line that overran it stayed in when it filled the batch or ended the file) | Removed: the cap holds for every batch |

---

## 3. Timeline

| When (2026) | What |
|---|---|
| Oct 6 | Native engine built: reply check, prompt, batch loop, retries, artifacts, each with its own checks |
| Oct 6 | 11-episode side-by-side comparison with the old engine (section 5); maintainer's blind verdict |
| Oct 10 | The resend for bad replies added, closing the one gap the comparison found |
| Oct 12 | Old engine and its Python runtime removed |
| Oct 18 | System Prompt Override made additive; prompt contract v3 (section 1.5) |

---

## 4. Build-time checks

Each piece was written with checks that fail on the defect they exist for, and each check was itself
tested by deliberately breaking the code ("mutations") and confirming the check failed.

| Piece | Checks | What breaking it showed |
|---|---|---|
| Reply check | 55 (`VT22`) | With the duplicate and missing checks disabled (gst's shape), no bad reply got through, because the count check still refused all of them. Two layers, each sufficient |
| Prompt | 61 (`PT24`) | The instruction is **byte-identical** to gst's for all 32 combinations tested (two target languages × thinking on/off × thinking-compatible model × audio × description). The expected bytes were produced by running gst's own prompt code, not NG's |
| Batch loop and partial | 54 (`BL25`) | A partial holding only committed lines, a late reply committed after Stop, a stuck context pointer, the destination written on failure, and an audio cap off by one second: each was caught |
| Retries and keys | 43 (`RK26`) | The error count not resetting on a commit, a key rotation per batch, a block not typed, tokens of a retried batch counted twice: each was caught |

**A Windows finding along the way.** A stress run of the write-flush-rename pattern (40 files × 100
replacements, twice) saw **59 and 78 of 4,000** renames refused transiently by Windows. With short
retries (5, 10, 20, 40 and 80 ms) the same run saw **0 of 8,000**. Every whole-file replace in the
engine now retries those error codes.

---

## 5. The side-by-side comparison (October 6)

### 5.1 Setup

- **Material:** 11 English TV episodes from 8 series (drama, comedy, science fiction, thriller, spy and
  newsroom drama), 487 to 933 lines each, **7,760 lines** in total. Each source was pinned by name and
  line count; the maintainer's human Hebrew subtitles served as a reference only.
- **Arms:** the native engine, the old engine, and **the old engine again**. The third arm measures how
  much the old engine differs from *itself* run to run, which is the yardstick for any native-vs-old
  difference.
- **Path:** both engines through the shipped run entry point, wired exactly as the Translate button
  wires them, differing only in which engine was selected. Each arm read its own copy of the source.
  Results were saved through the same code Save uses.
- **Settings:** Gemini 3.5 Flash-Lite, Low thinking, target Hebrew, and otherwise the stored defaults
  (Batch Size 100, Cross-Batch Context OFF, standard tier). Free key for all 34 runs. No run leaked the
  key into any output or log.

### 5.2 Structure: 33 of 33 completed outputs pass

Every completed output (11 × three arms) was checked by a separate strict reader, not NG's own: valid
UTF-8, no replacement characters, no malformed block, line count equal to the source, every index and
every start and end time equal to the source, no empty line. All 33 passed. All four sidecar reports
were offered and saved under the right names.

### 5.3 Per-episode numbers

| Episode | Lines | Seconds (native / old / old again) | Native requests | Tokens (native / old / old again) | Same prompt tokens? | Identical lines native↔old / old↔old |
|---|---:|---|---:|---|---|---|
| A1 | 736 | 75 / 101 / 81 | 8 | 44,738 / 50,753 / 44,909 | No: old engine resent a batch | 56.0% / 59.2% |
| A2 | 737 | 74 / 81 / 80 | 8 | 44,932 / 44,410 / 44,864 | Yes | 55.2% / 53.5% |
| B | 807 | 90 / 240 / 87 | 9 | 49,963 / 49,157 / 49,450 | Yes | 49.3% / 47.1% |
| C | 487 | 47 / 54 / 52 | 5 | 28,009 / 27,681 / 27,900 | Yes | 58.1% / 58.9% |
| D | 578 | 59 / 62 / 62 | 6 | 35,041 / 34,434 / 34,724 | Yes | 60.2% / 58.1% |
| E1 | 749 | 91 / 107 / 85 | 8 | 48,063 / 52,713 / 48,038 | No: old engine resent a batch | 52.5% / 47.9% |
| E2 | 692 | 75 / 80 / 77 | 7 | 44,342 / 43,928 / 44,084 | Yes | 48.4% / 52.9% |
| F | 579 | 60 / 68 / 73 | 6 | 36,324 / 36,330 / 36,554 | Yes | 53.5% / 51.6% |
| G1 | 933 | 198 / 109 / 107 | 10 | 60,425 / 60,037 / 60,272 | Yes | 52.4% / 51.9% |
| G2 | 571 | 60 / 67 / 67 | 6 | 36,204 / 35,865 / 36,030 | Yes | 49.4% / 47.1% |
| H | 891 | 91 / 116 / 101 | 9 | 55,820 / 61,529 / 56,137 | No: old engine resent a batch | 50.6% / 48.1% |

Episodes with the same letter are from the same series.

### 5.4 Analysis

- **Same prompt.** On the 8 episodes where neither engine resent anything, the prompt token counts
  were equal. The 3 that differ are exactly the 3 old-engine runs that resent a batch. The native
  engine sends gst's prompt for the same batches.
- **Same variation.** Identical lines native↔old: **52.9%** (4,108 of 7,760). Old↔old: **52.0%**
  (4,039 of 7,760). The model rewords about half the lines on any run; native-to-old agreement is
  comparable to the old engine's agreement with itself (one pair each, so not a measured spread).
- **Same untranslated lines.** One episode had 9 lines left as they were by both engines, all bare
  numbers. None elsewhere.
- **Time.** The native engine was faster on 10 of 11. On G1 it took 198 s against about
  108 s, with 10 requests and no logged wait or retry: slower replies from the service, not a retry.
- **Direction marks.** The old engine wrapped right-to-left lines in Unicode embedding marks (7,748 of
  7,760); the native engine did not. That difference was planned and is handled by the separate RTL
  output feature.

### 5.5 Blind quality review

- **Sample:** 2 stretches of 8 consecutive lines per episode, 22 stretches, 176 lines. Which stretches,
  and which side was "A", were derived from a hash of the settings and of all 22 outputs, so neither
  could be chosen after seeing the results. The mapping was sealed with a hash before review.
- **Blinding:** direction marks were removed from both sides of the review copies, because their
  presence would have revealed the engine.
- **Verdict (maintainer, given before the mapping was opened):** **18 of 22 stretches the same.** In
  the four that differed: two had a stray Arabic letter on the old engine's side, one had a stray
  English letter on the native side plus a gender choice the maintainer preferred on the old side, and
  one had two lines the maintainer judged better on the old side ("could be an LLM fluke").
  **Two lean each way; no side is systematically better.** The maintainer passed the comparison.

---

## 6. What the comparison found

### 6.1 The native engine stopped where the old engine recovered

The first native run of episode H **failed** after 21 seconds: lines 160 and 172 were returned twice
in batch 2. The reply check refused it, and, as designed at the time, the run ended with the partial
kept (batch 1 translated, the rest in English, every timing correct). A second run completed.

The old engine resent a batch in **3 of 22** runs (`Expected 100 lines, got 99.` twice, `got 79.`
once), and one resend fixed each. **4 bad replies in 34 runs**: about one native run in eight would
have stopped where 1.1.0 finished. That is a regression even though no check failed, so the maintainer
had a gst-identical resend added before the old engine was removed. The design is in
[`content-block-recovery.md`](content-block-recovery.md) section 9.

### 6.2 Letters from the wrong alphabet are a model property

The review's stray letters led to a whole-file scan of all 33 outputs:

| Lines with… (of 7,760 per arm) | Native | Old | Old again |
|---|---:|---:|---:|
| Arabic letters | 55 | 71 | 64 |
| Cyrillic, Greek, CJK or Hangul letters | 9 | 5 | 7 |
| A Latin letter fused inside a Hebrew word | 9 | 7 | 4 |

All three arms produced lines with wrong-alphabet letters, so the slip is a property of the model on
this setting, not something the native engine introduced. Native had fewer Arabic-affected lines than
either old-engine run, and more of the other two categories than either. With one native run and two
old-engine runs, this does **not** show the engines are equivalent, and it does not isolate an engine
effect in either direction. (An earlier reading took these numbers as "native inside the old
engine's run-to-run spread on every row". That is wrong: native is outside the two old-engine values
on every row.) 1.1.0 did not detect the slip at all: its output scan has no script check. It became a
separate feature, a wrong-alphabet repair for Hebrew output
([`wrong-alphabet-repair.md`](wrong-alphabet-repair.md)).

---

## 7. Decisions and why

| Decision | Why | What would change it |
|---|---|---|
| Batch Size 100 | 1.1.0's default. No size was measured better. It is also the size at which two Cross-Batch Context failures appeared that smaller sizes hid ([`cross-batch-context.md`](cross-batch-context.md) section 11) | A measured reliability or quality difference at another size, for the default model |
| Audio under 300 s, with no exceptions | gst's cap. gst let an overrunning line stay in some batches; NG applies the cap to every batch and sends an overlong line alone. Line text, count and order are unaffected; only where an audio batch ends differs | Evidence that longer audio per request improves results without loss |
| Exact reply check | Section 2: membership alone let duplicates and gaps through. In every unexpected reply seen while building later features (collapsed replies, echoed context, invented lines), this check refused it before anything was written | Only a different output contract |
| Check the raw list before storing | A map keyed by line number erases duplicates, so `[1, 2, 2, 4]` would look complete | — |
| Strict JSON, no repair | A repaired reply is text the model did not send. The response schema makes valid JSON the normal case; a bad reply is resent, not guessed at | Evidence of a repair that can be checked against the request |
| Whole-batch commit, destination last | At any instant the disk holds a consistent partial or the finished file. gst wrote line by line | — |
| Generation defaults from 1.1.0 | Parity. Nothing measured a better default; the Cross-Batch Context studies ran at Low thinking | A measured difference on the default model |

---

## 8. Limits

- One language pair, one model and one judge for the quality review. Structural results generalise;
  quality results are for English to Hebrew on Gemini 3.5 Flash-Lite at Low.
- The review sampled 176 of 7,760 lines, and the maintainer compared lines only where the two sides
  differed.
- A transcription comparison of the two engines was also run; it belongs in the transcription record.

## 9. Recommendations

- Keep a third arm (the same engine twice) in any future engine or model comparison. Without it, the
  model's own variation reads as a difference between the things being compared.
- Choose review samples from a hash of the outputs and seal the mapping before judging.
- Keep the whole-file letter scan in mind for right-to-left targets: the sampled review saw three
  stray letters, the scan found 55–71 lines per arm.

## 10. Code and checks

| What | Where | Checks |
|---|---|---|
| Batches and audio spans | `electron/engine/batching.ts` (`planBatches`, `batchMediaSpan`, `TRANSLATE_AUDIO_CHUNK_SECONDS`) | `BL25` |
| Reply check | `electron/engine/validateTranslationBatch.ts` (`validateExactPermutation`, `validateReply`) | `VT22`, `R18 G.2` |
| Accepted lines | `electron/engine/translationState.ts` | `VT22` |
| Prompt | `electron/engine/prompt.ts` (`translateInstruction`, `translationRequest`) | `PT24` |
| Run loop, commit, partial | `electron/engine/run.ts`, `electron/engine/output.ts` | `BL25`, `RK26` |
| Defaults | `electron/main/store.ts` (`defaults`) | — |

## 11. Label index

| Label | Meaning | Section |
|---|---|---|
| `Step 2.2` | The exact reply check | 1.3, 7 |
| `Step 2.4` | The native prompt (byte parity with gst) | 4 |
| `Step 2.5` | Batches, whole-batch commit, the partial file | 1.2, 1.4 |
| `Step 2.6` | Retries and key rotation | 4 |
| `Step 2.9` | The 11-episode comparison | 5, 6 |
| `D1` | The resend added after the comparison | 6.1 |
| `A134` | Whitespace-only text refused | 1.3 |
| `A136` | Strict JSON, no repair | 2, 7 |
| `A137` | Stage the whole batch or nothing | 1.4 |
| `A160`, `A161` | The audio cap without exceptions; the audio span | 1.2, 7 |
| `A199` | Retrying a transient Windows rename refusal | 4 |
| `AR-FINAL-2` | The two failure shapes: missing lines and unreadable reply | 1.3 |
