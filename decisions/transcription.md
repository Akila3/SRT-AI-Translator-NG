# Transcription (audio and video to SRT)

**Decision in one paragraph.** Transcription runs in one of two paths, chosen by the resolved model. A **general** Gemini 2.5 or 3.x model keeps the shipping engine’s JSON schema and instruction (including a language-lock sentence that stops foreign words appearing as Latin transliteration). **`gemini-3.5-transcribe`** uses a separate **Stage A** request: inline audio, `wordTimestamp: true`, and exactly one bare `languageCodes` entry the user confirms in a modal after optional spread sampling detection. Both paths cut the prepared audio into **300-second** parts (same count as gst 3.7.0), measure loudness on that file, and **refuse to ship** answers that are grossly too short, wordless over loud stretches, or mis-timed; they **recover** refusals and coverage failures by halving (30-second floor, four levels, one unchanged retry on a generic refusal first). The dedicated path adds a cache nonce (resend once, then refuse the span), builds cues from 100 ms words (**Stage B**), and may run optional **Stage C** text polishing (default **ON**) with a general text model. Rate and quota pressure **never** shrink audio parts; that rule is shared with translation ([`free-tier-protection.md`](free-tier-protection.md)). Content refusals use the ladder in [`content-block-recovery.md`](content-block-recovery.md). Continue and checkpoint behaviour are in [`continue-and-retry.md`](continue-and-retry.md).

**Status:** current. **Evidence scope:** **180** live Developer API generation calls across **ten** probe rounds in September 2026 (plus one model-list request), gate receipts (Phase 1 transcription, Bundle I, Step 1.9 **ab19** corpus), one **≥18 k-token** implicit-cache live pair (Round 16), the **three-recording** Stage C campaign (October 2026, section 15.2), coverage calibration on maintainer-accepted transcripts (section 15.1), and packaged-app runs where noted. Most quality comparisons used **Hebrew**, **English**, and **Japanese** material at feature length or multi-minute slices; multilingual code-switching was tested on controlled 60-second bilingual clips, not full films.

**How to read this file.** Section 1 is what the code does today. Section 2 is gst 3.7.0 / SRT AI Translator 1.1.0. Section 3 is the timeline. Sections 4–14 walk the probe campaign in order, including **withdrawn** conclusions and why they were withdrawn. Section 15 is the shipped dedicated workflow (Bundle I), including coverage calibration (15.1), the Stage C measurement campaign (15.2), and the empty-transcript notice (15.3). Section 16 is the **ab19** native-vs-CLI transcription comparison. Section 17 notes **ab29** (translation, not transcribe). Sections 18–23 are decisions, build evidence, limits, recommendations, code map, and labels.

---

## Models used in testing

Two kinds of model appear here. The **dedicated** `gemini-3.5-transcribe` accepts no thinking or
sampling settings, so none were sent. The **general** models were sent a thinking level.

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Round 1, request surface (4) | `gemini-3.5-transcribe` | Not sent | Word timestamps, clips of 60 s or less | Free | 16 calls | Sep 10 |
| Round 2, silent omission (5) | `gemini-3.5-transcribe` | Not sent | 12 to 35 minute windows | Paid (the Free key hit 429; Rounds 2 to 9 used Paid) | 14 calls | Sep 10 |
| Rounds 3 and 4, boundary, cache, dedicated vs general (6, 7) | `gemini-3.5-transcribe`; Round 4 adds `gemini-3.7-flash` | Not sent / gst's default thinking | Flash arms used gst's instruction, schema and `BLOCK_NONE` | Paid | 18 calls for the two rounds together | Sep 10 |
| Round 5, cause and `languageCodes` (8) | `gemini-3.7-flash` and `gemini-3.5-transcribe` | Flash Low and Medium arms / not sent | Identical Hebrew audio (3 and 6 minute windows) | Paid | 31 calls | Sep 10–11 |
| Round 6, provenance, detection and N8 (9) | `gemini-3.7-flash` and `gemini-3.5-transcribe` | Low / not sent | Detection asked as a text question | Paid | 24 calls | Sep 11 |
| Round 7, where to sample (10) | `gemini-3.7-flash` | Low | Temperature 0, six 10 s samples vs one 60 s clip | Paid | 33 calls (the 12-arm probe ran twice, plus 9) | Sep 11 |
| Round 8, one language per request (11) | `gemini-3.5-transcribe` and `gemini-3.7-flash` | Not sent / Low | 60 s bilingual clip; Flash with the language-lock clause | Paid | 14 calls | Sep 11 |
| Round 9, wording and native script (12) | `gemini-3.7-flash` | Low | gst's exact transcription workflow | Paid | 8 calls | Sep 11–12 |
| Round 10, refusals and retries (13) | `gemini-3.7-flash` and `gemini-3.5-transcribe` | Low / not sent | `BLOCK_NONE`, streaming arms | Free, then Paid | 16 calls | Sep 12 |
| Implicit cache handler, live (14) | `gemini-3.5-transcribe` | Not sent | Repeats with and without a leading nonce, 12.5-minute Hebrew slice | Paid | Paired repeats | Oct 14 |
| Stage C polishing campaign (15.2) | `gemini-3.5-flash-lite` and `gemini-3.7-flash` | Low, Low | Batches of 25 to 100, then the guard replay | Free and Paid per file; Flash 3.7 on Paid | 3 whole recordings | Oct 14 |
| Engine A/B, ab19 (16) | `gemini-3.7-flash` | Low | Sampling withheld on the wire by both engines | Paid | 3 recordings, both engines, one gst repeat | Oct 5–6 |

Call counts for Rounds 1 to 10 come from a recount of the saved responses: **180** generation calls
in all, including 6 fixture-preparation calls between Rounds 1 and 2 that belong to no round. The one
`ListModels` request in Round 1 is separate and is not counted in any figure here. Some notes kept
during the probing had tallied rounds by hand and disagreed with the recount for Rounds 3, 4 and 7;
the recount is the one used here.

The coverage calibration (15.1) and the preparation progress probe (19.1) call no model.

**Would a different model change the results?** Yes, and this record is the clearest case, because two
models measured on the same audio behaved differently.
- **Dedicated model only** (`gemini-3.5-transcribe`): silent omission without `languageCodes` (N6),
  the cache serving a degraded transcript (N7) and one language per request (N9). A future dedicated
  model may not share them; the safeguards stay until that is measured.
- **Both tested models:** invention on near-silent audio (N8). The dedicated model returned an
  invented greeting in whichever language was pinned, and `gemini-3.7-flash` invented a line of
  dialogue on the same kind of audio. The refusal rule in section 15.1 is therefore not specific to
  one model.
- **General path:** refusal visibility, the multilingual result and the detection results were
  measured on `gemini-3.7-flash` at Low.
- **Polishing:** Stage C quality, the batch size of 50 and what the guard refuses were measured only on
  `gemini-3.5-flash-lite` and `gemini-3.7-flash` at Low. The polishing model defaults to the
  translation model, which can be one that was never measured.
- **Model-independent:** the coverage arithmetic, the Stage B layout and the guard's rules are code.
  How often each one fires depends on the model's output.

## 1. What the app does today

### 1.1 Model choice and defaults

There is **no separate “Transcribe default model”** stored on the Transcribe tab until the user turns **Override model on this page** on. With the override **off**, the run uses **Settings → Model & Generation** (model, thinking level, thinking budget). With the override **on**, the tab’s fields apply, seeded from Settings the first time the toggle is enabled.

| Setting | Default / behaviour | Why |
|---|---|---|
| Translation model in Settings | **`gemini-3.1-flash-lite`** when nothing else is resolved from the live model list (`store.ts` seed; live refresh may supersede) | Alias-free seed; not proof the model runs until fetched |
| Transcribe override | **OFF** (`transcribeOverride: false`) | Parity with SRT AI Translator 1.1.0: one control, two positions (D5-16) |
| Which path runs | General if the resolved model is 2.5/3.x **without** a dedicated transcribe id; **dedicated** if the id contains `transcribe` and passes capability checks | The two model families need different request shapes (section 7) |
| Chunk length | **300 s** (`TRANSCRIBE_CHUNK_SECONDS`, `transcribe.ts:85`) | gst 3.7.0 default (`main.py:94`); last chunk ends at true duration (enhancement) |
| Dedicated `languageCodes` | **Required** — one bare subtag from the source-language modal | Omitting it caused ~92% loss on measured Hebrew windows (D5-10, N6) |
| Language detection | **Six** samples × **10 s** at **10 / 25 / 40 / 55 / 70 / 85 %** of runtime, one call to the **Settings translation model** | Naive first minute scored **2/3** vs spread **3/3** at same cost (D5-13); abstains on `zxx`, disagreement, or failure |
| Stage C polishing | **`transcribePolish: true`** (`DEFAULT_TRANSCRIBE_POLISH` in `types.ts:18`) | Only when the **transcribe** model is dedicated; general models grey the toggle |
| Polishing model | **Same as translation model** unless `transcribePolishModel` is set | Measured: 3.7-flash made more corrections than 3.5-flash-lite; either keeps mismatched edits (`transcribeSettings.ts` tips) |
| Polishing batch size | **50** cues per request (`POLISH_BATCH_CUES`, `polish.ts:29`) | Best latency/correction trade-off of 25 / 50 / 100 / whole list on three full recordings, with a per-cue guard (section 15.2) |
| Thinking / sampling on dedicated | **Not sent** (400 if sent) | API rejects; UI greys controls (D5-18) |
| Timestamp grid | **1000 ms** generic, **100 ms** dedicated (`modelCaps.ts` A47) | Measured on Developer API |
| Recovery | **1** retry before split on generic **`OTHER`**; **0** on `PROHIBITED_CONTENT`; **0** retry on silent loss; floor **30 s**, depth **4** (`TRANSCRIBE_RECOVERY_POLICY`, `transcribe.ts:92`) | Refusal non-deterministic: 1 of 5 identical retries completed (section 13); successful silent loss byte-identical on repeat (F-A16) |
| Implicit cache (dedicated) | Leading **`Request uniqueness token: …`** nonce; cached reply → one resend → span refused | N7; token **not** proven to defeat cache at ≥18 k tokens (section 14) |
| Free-tier pacing | Shared budget; **no** audio shrink on 429 | [`free-tier-protection.md`](free-tier-protection.md) §1.8 |

### 1.2 General (Flash) path

- **Request:** system instruction from `transcribeInstruction()` (includes fidelity / language-lock text), JSON schema with `text`, `time_start`, `time_end`, whole-second grid, safety at `BLOCK_NONE`, thinking/sampling per Settings projection (`nativeAdapter.ts` generic branch, `prompt.ts`).
- **No** `languageCodes`, **no** detection modal.
- **Cues:** parsed from JSON; coverage and recovery run on cue times; no Stage B word merge unless not using word path.
- **Polishing:** unavailable (model already returns shaped lines).

### 1.3 Dedicated (`gemini-3.5-transcribe`) path

- **Request:** audio inline + `audioTranscription: { wordTimestamp: true, languageCodes: [code] }` only (`transcribeDedicated.ts:48–56`). No system instruction, schema, thinking, sampling, or custom description (description is billed and ignored if sent).
- **Start gate:** modal for spoken language (`SourceLanguageModal.tsx`); detection pre-fills or abstains empty.
- **Words → cues:** one cue per word, then `buildCues()` with gap rules (`cues.ts` STAGE_B_RULES); refused/cache spans become explicit gaps.
- **Stage C:** optional `polishCueTexts()` rewrites text only; failures keep Stage B text (`polish.ts`).
- **Warnings after save:** low-speech invented-text notice, script-mix scan, quiet-text spans (`transcribe.ts` end of run, `outputSanity.ts`). If the run completes and the file is saved successfully but the **serialized** transcript is empty (`transcript.trim() === ''` after `formatSrt`), one amber **notice** is emitted (`EMPTY_TRANSCRIPT_SIGNAL` in `engineEvents.ts`) — not when save fails, and **not** from the in-memory cue count, because `formatSrt` drops cues whose text is blank or whitespace-only (section 15.3).

### 1.4 How a refused part is split

Transcription recovery **splits audio at the quietest moment** near the middle of a refused span (`quietestMoment`, `recover.ts`). Parts do not overlap in audio. When a split falls at a fractional second, the next part's opening lines are made to follow the previous committed line; the committed part is never rewritten. That rule came from a live run where one line ran 0.65 s into the next part ([`content-block-recovery.md`](content-block-recovery.md) section 11). The **30 s** floor and **four** bisection levels cap extra audio at the run’s own length (`AudioRecoveryBudget`, `transcribe.ts:103–118`). Upstream gst **#135**-style “shrink chunk after errors” is **not** ported for rate/quota; only **coverage/refusal bisection** shrinks audio (Bundle I / Step 1.8a).

---

## 2. What SRT AI Translator 1.1.0 did (gst 3.7.0 baseline)

From gst **`main.py:1519–1977`** (cited in `transcribe.ts:1–11`):

| Behaviour | SRT AI Translator 1.1.0 / gst |
|---|---|
| Chunk size | **300 s** default; app never passed another size |
| Loop end | **`int(audio_length)`** — fractional last second skipped |
| Output | Single write at end (no per-chunk partial in app) |
| Request | **`system_instruction`**, **`response_schema`**, **`application/json`** required cues with **`MM:SS`** times (`helpers.py:270–285`) |
| Transcription model | User-selected Gemini; **not** the dedicated `gemini-3.5-transcribe` API shape |
| Content block | **Stop entire run**; block reason hidden from UI |
| Retry | Resend bad JSON up to three times (5 s gap) |
| Free pacing | Fixed 30 s gap (Pro + free key), etc. |

NG keeps **300 s** chunk **count**, adds **partial flush per chunk**, **coverage/recovery**, **native refusal signal** for Flash, and the **optional dedicated model path**.

---

## 3. Timeline

| When (2026) | What | Outcome |
|---|---|---|
| Sep 10 | Feature 5 first designed from Google's documentation, then **16** live calls the same day | Five doc claims wrong; dedicated API surface captured |
| Sep 10 | Round 2: **14** calls, **9** with 12–35 min audio | **N6** silent omission; “30 min doc limit” falsified |
| Sep 10 | Round 3 (Rounds 3 and 4: **18** calls together) | “Duration drives loss” **withdrawn**; slice boundary + **N7** cache |
| Sep 10 | Round 4 | Flash vs dedicated head-to-head |
| Sep 10–11 | Round 5: **31** calls | **`languageCodes`** cause; **`promptFeedback`** on Flash; **D5-8** withdrawn |
| Sep 11 | Round 6: **24** calls | Fixture label falsified; **N8** fabrication; detection **4/4** |
| Sep 11 | Round 7: **33** calls (a 12-arm probe run twice, plus 9) | Spread sampling **3/3** vs naive **2/3**; naive **`zxx`** not `"fr"` (E23) |
| Sep 11 | Round 8: **14** calls | **One language per request** (N9); Flash keeps two on test clip |
| Sep 11–12 | Round 9: **8** calls | Wording favours Flash; native-script prompt **not** adopted (D5-15) |
| Sep 12 | Round 10: **16** calls | Refusal retry **1/5**; dedicated no block signal |
| Sep 16–17 | Free-tier / Bundle I design | Rate never shrinks chunks |
| Oct 5–6 | **ab19** Step 1.9 A/B (3 files × native vs CLI), part of Round 3 (native transcription) | English blind **PASS**; Hebrew CLI failed block loop |
| Oct 6 | **ab29** corpus | **Translation** native vs CLI (Step 2.9), not transcribe |
| Oct 14–15 | Round 16 (Bundle I) built | Dedicated path, detection, polish, cache handler |
| Oct 14 | Stage C batch-size campaign | Three full recordings (1 451 / 472 / 378 Stage B cues); batch **50** + per-cue guard shipped (section 15.2) |

---

## 4. Round 1 — request surface (16 calls, ≤60 s)

**Setup.** Free-tier key; **16** transcription calls on short clips, plus one separate **`ListModels`** request; scripts projected few response fields (corrected later in round 5).

**Results (selected).**

| Finding | Result |
|---|---|
| Dedicated id | `gemini-3.5-transcribe` (+ preview variants) |
| `wordTimestamp: true` | Required for words; without it, 200 with text but no timings |
| `SMART` + timestamps | Rejected together |
| Short clips | Plausible transcripts; **coverage of long audio not tested** |
| Wrong fixtures | “Speech” file **−60 dB** — empty 200; **3 min “quiet speech”** was pre-speech silence |

**Withdrawn later.** “Portuguese 30 s clip” and “auto language works unprompted” — round 6 proved the clip was **Hebrew silence** and the label was model invention (section 9.1).

**Conclusion.** API shape documented; **operating point** for loss not yet measured.

---

## 5. Round 2 — silent omission (**N6**, 14 calls, 9 long)

**Setup.** **12–35 minute** requests on Hebrew lecture and Japanese extracts; paid key after free **429**.

**Results (table abbreviated).**

| Case | Duration | Tail / loss | Notes |
|---|---|---|---|
| Hebrew 12 min | 720 s | **~100%** words to 719.9 s | Control with speech from **t≈178 s** |
| Japanese windows | 1500–2100 s | **10–77%** tail missing | **200 STOP**, full billing, **no error field** |
| 60 s re-cut of dropped span | 60 s | **99%** coverage | Row 8 — same span as failed 12 min |

**Analysis (round 2, partially withdrawn).**

- **Withdrawn:** “Losses scale with duration” — round 3 showed **30 min complete** vs **12 min 97% lost** same file.
- **Withdrawn:** “Silence explains loss” — cross-call proof on same timestamps (rows 4, 6, 7).
- **Survives:** Long requests **can** return partial output with **no API signal** on dedicated model; short requests **not proven unsafe**, but **asymmetric risk** justified chunking + gates.

**Conclusion.** **N6** opened; interior coverage required, not tail-only (row 5 “thinning”).

---

## 6. Round 3 — boundary and cache (18 calls with Round 4)

**Controlled pairs (same recording).**

| Arm | Result |
|---|---|
| 30 min Hebrew dense | **3235 words**, 1 empty bucket / 60 |
| Adjacent 12 min | **26 words**, ~97% buckets empty |
| Same 12 min, **+5 s** slice start | **1422 words** recovered |

**Second mechanism — N7 (implicit cache).**

| Repeat | Cached tokens | Words |
|---|---|---|
| First 30 min | 0 | 3235 |
| Identical ~18 min later | **~93%** | **515** |

**Conclusion.** Boundary and cache are real levers; **D5-8** (shift boundary as repair) adopted here but **withdrawn in round 5**. Plain retry on **successful** partial output is **byte-identical** (F-A16).

---

## 7. Round 4 — dedicated vs `gemini-3.7-flash` (18 calls with Round 3)

**Setup.** GST-faithful prompt (**2189** chars), schema, safety; same audio for F1/F2/T arms.

**Coverage.**

| Clip type | Dedicated | Flash (GST workflow) |
|---|---|---|
| Known-good 12 min | 100% | 100% |
| Known-bad Japanese 12 min | **157 words, 68.9%** | **88 cues, 99%** |
| Known-bad Hebrew 12 min | **26 words** | **0 cues** ( **`OTHER`**, unread until round 5) |

**Timing.** Flash: **5698/5698** timestamps on whole seconds; dedicated: **100 ms** grid. Median drift **0.01–0.34 s/min** (quantisation-dominated).

**Cost (12 min, tokens only).** Dedicated **~18 k** vs Flash **~29 k** (thinking on in GST default).

**Language-lock clause (Flash).** Removed Latin tokens in Hebrew test; **six** transliterated Russian words in stock arm → **zero** with clause.

**Conclusion.** Dedicated wins **precision and token count**, not **reliability**; **both need coverage gate**. Product keeps **both paths**.

---

## 8. Round 5 — cause and method fix (31 calls)

### 8.1 Method

Scripts before probe **18** dropped `promptFeedback`. Flash “empty success” was **`blockReason: OTHER`**, no `candidates` — see [`content-block-recovery.md`](content-block-recovery.md) §4.

### 8.2 `languageCodes` triple (identical 3 min Hebrew, uncached)

| Config | Chars / outcome |
|---|---|
| `{wordTimestamp}` only | **140** (~8% of Flash) |
| `{wordTimestamp, mode: VERBATIM}` | **140** (control) |
| `{wordTimestamp, languageCodes: ['he-IL']}` | **1909** (~102% of Flash) |

Six-minute window: **21 → 688 words**, zero interior gaps.

### 8.3 D5-8 withdrawn

**+5 s** slice still **`OTHER`** on Flash — shift did not remove offending span.

### 8.4 Dedicated vs Flash on policy audio

Dedicated: **200 STOP**, **26 words**, no `promptFeedback`. Flash: **`OTHER`**.

**Conclusion.** **D5-10** mandatory; recovery tree for generic refusals; dedicated uses **coverage** triggers primarily.

---

## 9. Round 6 — fixture provenance and **N8** (24 calls)

### 9.1 Label collapse

Near-silence normalised clip: model returned Portuguese phrase; **byte-identical** to first **30 s** of maintainer’s **Hebrew lecture** (speech from **~3 min**). Round 1 label was **hallucination**, not ground truth.

### 9.2 Detection where speech exists

| Detector | Score (3 files) |
|---|---|
| Hand-cut speech regions | **4/4** |
| Naive first 60 s | **2/3** (miss = **`zxx`**, not wrong language — **E23**) |

### 9.3 **N8** fabrication (3 min quiet Hebrew)

| Pin | Output kind |
|---|---|
| No code | Short Hebrew greeting (invented) |
| Portuguese list | Portuguese greeting |
| Japanese | Japanese greeting |

All **`STOP`**, billed **~4.5–5.2 k** tokens / 3 min. **D5-12:** gross disproportion refusal + user warning on low-speech files; **not** full fabrication detector.

---

## 10. Round 7 — where to sample (33 calls)

**Question.** Opening of many films is pre-speech; naive clip misleads detection.

**Design.** **Six × 10 s** at **10/25/40/55/70/85 %**, concatenated, **one** detection call — same duration and cost as naive **60 s**.

| Selection | Hebrew lecture | English documentary | Japanese recording |
|---|---|---|---|
| Naive 0–60 s | **`zxx`** | correct | correct |
| Spread 6×10 s | correct | correct | correct |

**Score.** Naive **2/3**, spread **3/3** (both detector prompt designs tied on spread).

**Conclusion.** **D5-13** spread sampling shipped; abstain → empty required modal.

---

## 11. Round 8 — one language per request (14 calls)

**Eight configs, same 60 s bilingual clip.**

| Model | Behaviour |
|---|---|
| `gemini-3.5-transcribe` | **One** language; rest **silent drop** (list order, SMART, no code, text “instruction” part billed **66** tokens, **ignored**) |
| `gemini-3.7-flash` + lock clause | **Both** languages (~**96%** word agreement vs reference on test) |

**Conclusion.** **N9** capability limit; **D5-14** UI must state one-language trade-off **and** cheaper / finer timing upside; multilingual work → general path.

---

## 12. Round 9 — wording and native script (8 calls)

**Wording.** Side-by-side favoured **Flash** for readable Hebrew lines (fillers removed in prompt path).

**Native script clause (Pashto test).** Only long explicit writing-system list moved script **39%** Arabic vs **0%** without; quality of language **unreliable**.

**Conclusion.** **D5-15:** do **not** add global native-script clause; Stage C handles readability for dedicated path.

---

## 13. Round 10 — refusals and retries (16 calls)

| Arm | Finding |
|---|---|
| Dedicated hard span | **No** `promptFeedback`; language pin rescues **other** spans |
| Flash **`OTHER`** ×5 identical | **1/5** complete (37 cues) |
| `PROHIBITED_CONTENT` | Still not reproduced in probes |
| `BLOCK_NONE` vs none | **Identical** refusal on **`OTHER`** |

**Conclusion.** **`retriesBeforeSplit: 1`** for generic **`OTHER`**; **`0`** for **`PROHIBITED_CONTENT`**; coverage-only entry for dedicated silent loss. Full ladder: [`content-block-recovery.md`](content-block-recovery.md).

---

## 14. Implicit cache handler (live, Round 16)

**Setup.** **12.5 min** Hebrew slice, **`gemini-3.5-transcribe`**, paid key; pairs with and without the nonce.

| Arm | Cached tokens | Words |
|---|---|---|
| Repeat immediately, no nonce | **~14 090** (~75%) | 1287 (complete this time) |
| Repeat with fresh nonce after prior | Still **~14 107** cached on 2nd hit | 1287 |

**Analysis.** Nonce **did not** prevent cache at this size; **2/2** back-to-back hits, **0/4** after ≥30 s gap. Handler: resend once → refuse span (matches N7 risk).

---

## 15. Shipped dedicated workflow (Bundle I summary)

| Stage | Role |
|---|---|
| **Detection** | `detectSourceLanguage` + `spreadSample` (`sourceLanguage.ts`, `ffmpeg.ts`) |
| **Modal** | Last gate before Start (`SourceLanguageModal.tsx`, D5-17) |
| **Stage A** | `dedicatedTranscribeChunk` → words |
| **Coverage** | 30 s interior loudness buckets + tail/order/beyond (`coverage.ts`, D5-7; section 15.1) |
| **Recovery** | `recoverUnit` bisection (`recover.ts`, D5-11) |
| **Stage B** | `mergeByOffset` + `buildCues` under `STAGE_B_RULES` (`offsets.ts`, `cues.ts`) |
| **Stage C** | `polishCueTexts` in batches of 50 with per-cue guard (`polish.ts`, default ON; section 15.2) |

**gst #135 shape.** Adaptive **audio** recovery = **bisection on non-quota failures**, not smaller scheduled chunks; **429/quota** → wait/switch ([`free-tier-protection.md`](free-tier-protection.md)).

### 15.1 Coverage calibration (D5-7)

**What it is.** Coverage is an **interior loudness heuristic** on the prepared audio the model heard: 30 s buckets (`COVERAGE_BUCKET_SECONDS`), a run-relative loud threshold, and checks that no **loud** bucket is wordless, that words reach the last loud bucket, and that cue times are ordered and inside the span. It is **not** a speech detector, **not** a percentage-of-runtime speech test, and **not** satisfied by tail coverage alone.

**Relative loudness (why not a fixed dB floor).** Recordings differ widely: across the five calibration files below, the quiet floor (10th percentile) ranged from −79 to −37 dBFS and the loud level (95th percentile) from −23 to −14 dBFS. A fixed threshold therefore mis-classifies quiet speech on one file and music on another; the first rule tried (a fixed gap from the floor, "set A") left 23 wordless loud buckets on the sparse-dialogue control. Pinning the threshold at −60 dBFS fails four build checks. The shipped rule (`loudnessOf` in `coverage.ts`) sets the threshold to the maximum of: 12 dB below the run's 95th percentile, 10 dB above its 10th percentile (clamped so it stays at least 3 dB below the 95th percentile), and −60 dBFS. A bucket is **loud** when at least **20%** of its seconds exceed that threshold (`LOUD_BUCKET_SHARE`).

**Calibration on maintainer-accepted transcripts (counts only, no dialogue quoted).** A research script compared each file's envelope to its accepted SRT AI Translator 1.1.0 transcript:

| Material | p10 / p95 (dBFS) | Wordless loud 30 s buckets (fixed floor → **relative rule**) | Notes |
|---|---|---|---|
| Japanese sparse-dialogue control | −39.1 / −23.2 | 23 → **2** | Loud throughout after ~24 min (music/effects); dialogue thin in the tail |
| Second Japanese sample | −37.5 / −19.9 | → **6** | |
| Third Japanese sample | −36.6 / −20.3 | → **3** | |
| English talk | −41.4 / −14.2 | → **0** | |
| Hebrew lecture | −78.7 / −16.8 | → **0** | Speechless ~3 min head never crosses loud threshold |

On the real sparse-dialogue control the relative rule cut wordless loud buckets from **23 to 2**. Separately, a **synthetic 720-second build-check fixture** shows why **tail-only** logic is unsafe: it reaches **99.9% tail coverage** while **23 of 24** buckets carry no text, and the checks **fail** it explicitly (CV18 exit fixture 2). The two "23"s are different measurements.

**Gross disproportion (D5-12).** The refusal fires only when **all** of these hold (`grossDisproportion` in `coverage.ts`): the answer has **some** text (an empty answer is dropped audio and goes to the coverage re-ask instead), the unit has at least **60 loud seconds** (`DISPROPORTION_MIN_LOUD_SECONDS`), and the answer has fewer than **0.15** counted letters per loud second (`DISPROPORTION_MAX_LETTERS_PER_LOUD_SECOND`). "Letters" are letters and digits in any script; spaces and punctuation do not count. The threshold sits between two measurements: the thinnest accepted SRT AI Translator 1.1.0 chunk had **0.70** letters per loud second, and the N8 invention had **14 characters, 11 of them counted letters, over 112 loud seconds**, so **≈ 0.098** counted letters per second (the design note and a code comment quote 14 / 112 ≈ 0.125, which counts every character; either way it falls below 0.15). Units with under 60 loud seconds and longer inventions are **not** refused by this check (section 20); a build check asserts that a long invention over the same noise passes it, so nobody reads more into the refusal than it does.

**Stage B layout rules (`STAGE_B_RULES` in `cues.ts`).**

| Parameter | Value | Basis |
|---|---|---|
| Gap before a new cue | **0.4 s** | Measured on probed 60 s dedicated audio (~12 word boundaries → ~13 cues) |
| Cue duration | **1–5 s** | Subtitle readability layout (not re-measured per release) |
| Lines × characters | **2 × 42** | Standard two-line subtitle layout |
| Minimum duration floor | **0.1 s** | One step of the 100 ms word grid when the 1 s minimum cannot fit |

Stage B re-layout after Stage C (`relayPolished` in `polish.ts`) uses the same arithmetic; the model does not own line breaks (section 15.2).

### 15.2 Stage C polishing campaign (three recordings)

**Evidence scope.** Whole **Stage B** transcripts from **three** recordings only — Hebrew lecture (**1 451** cues), English talk (**472**), Japanese (**378**); their Stage A wall times are in table 5 below — each produced by the production dedicated adapter with maintainer-chosen language pins. Stage C was exercised through the product's `polishRequest` in a research script (not published). **No** universal semantic validation across genres or languages was run; conclusions apply to this corpus and the shipped guard mechanics.

**Setup.** Compare **whole-list**, **100-, 50-, and 25-cue** batches; models **gemini-3.5-flash-lite** and **gemini-3.7-flash** (LOW thinking on both); today's instruction before the hardened text. **Strict check:** each batch reply must pass an **exact index permutation** rule: every requested index appears exactly once, with no extra index; replies are then mapped back into the requested order by index (returned order is not required). Batches counted as `passed / sent` in the table below.

**1. Batch size × model (strict permutation check).**

| Recording | Model | Whole | 100 | 50 | 25 |
|---|---|---|---|---|---|
| Hebrew | Flash-Lite 3.5 | 0/1, 0/1 | 11/15, 7/15 | 20/30, 22/30 | 34/59, 39/59 |
| English | Flash-Lite 3.5 | 1/1, 1/1 | 4/5, 4/5 | 6–7/10 | 17–18/19 |
| Hebrew | Flash 3.7 | — | 12/15 | 24/30 | — |
| English | Flash 3.7 | — | 3/5 | 7/10 | — |
| Japanese | Flash-Lite / Flash 3.7 | — | — | 5/8 / 6/8 | — |

(Fractions like `11/15` are passing batches / batches sent; two values are two repetitions. Hebrew Flash-Lite as one whole-list request failed both attempts. The English whole-list request "passed" twice, but one repetition returned every text unchanged and the other changed 107 cues with no per-cue check at all.)

**2. Why count equality is insufficient.** Models did not only "drop" indices — they **re-cut prose**: merged a fragment into a neighbour, **slid texts one slot** for a run of cues, shortened a cue, or invented indices. Flash 3.7 often returned **empty** filler-only cues. Batches that **passed** the strict permutation check still contained answers the **per-cue guard** later refuses (for example, 30 answers inside passing Hebrew Flash 3.7 batches of 100, and 30 inside passing Flash-Lite batches of 50, plus one English Flash 3.7 batch that slid whole texts). **Polishing must not move words between timed cues** — each subtitle is on screen only while its own words are spoken (`POLISH_INSTRUCTION` in `polish.ts`).

**3. Shipped instruction + guard (measured replay).** Hardened instruction (keep each cue's words inside it; filler-only unchanged; mishears may be corrected). Each answer is judged by `guardPolishedBatch` (`polish.ts`): refuse missing, repeated, or empty answers; refuse when a neighbour within **3** cues is more character-pair-like the answer than its own cue is (`OWN_LIKENESS` **0.5**); refuse when fewer than half its own letters remain (`KEPT_LETTERS` **0.5**); refuse **borrowed** words from neighbours; refuse **moved** words across boundaries (both cues refused when a neighbour would lose them). If refusals plus invented indices exceed **20%** of the batch (`POLISH_SLIPPED_SHARE`), the **whole batch** keeps Stage B text. Accepted edits are re-laid out with `relayPolished`. While implementing the guard's build checks, a **neighbour-word-loss** defect was found: refusing a cue that **borrowed** could leave the neighbour that **dropped** those words accepted, so words would appear in neither cue — the boundary pass now refuses that neighbour too.

**Real changes at batch 50, after Stage B re-layout** (changes shipped / cues refused / batches kept whole), replayed through the product's own guard, which was confirmed to use the measured instruction byte for byte:

| Recording (Stage B cues) | Before: one request, Flash-Lite | Flash-Lite 3.5, the fix | Flash 3.7, the fix |
|---|---|---|---|
| Hebrew (1 451) | 0 | 229 / 10 / 1 of 30 | **677 / 5 / 0 of 30** |
| English (472) | see note above | 71 / 4 / 0 of 10 | **151 / 2 / 0 of 10** |
| Japanese (378) | — | 36 / 7 / 0 of 8 | **66 / 2 / 0 of 8** |

Flash 3.7 at batch **100** with the fix: Hebrew **669 / 9 / 0 of 15**, English **136 / 4 / 0 of 5**, no better than 50, so **50** is fixed (`POLISH_BATCH_CUES`). With the new instruction the strict pass rate also rose (Hebrew Flash-Lite 28/30 and Flash 3.7 30/30 at 50, 15/15 at 100; English 9/10 for both at 50; Japanese 8/8 for both), but the guard, not the pass rate, is what decides.

**What the guard refused.** On Flash 3.7 the refusals read as harmless: punctuation-only changes beside an identical neighbour, two filler cues, one spelled number turned to digits; each cue simply kept its Stage B wording. On Flash-Lite it refused real damage: slid texts, merged neighbours and a replaced sentence; the one Hebrew batch kept whole was a slide.

**4. Rejected polish experiments.**

| Experiment | Result | Decision |
|---|---|---|
| Model-chosen line breaks | Of fitting two-line answers, the model's break was Stage B's own in 267 of 290 (English, Flash 3.7) and 204 of 218 (Hebrew); where they differed neither was consistently better (the model's first line ended at punctuation in 1 of 23 and 1 of 14, Stage B's in 2 and 3). When the old instruction asked for line breaks, Flash 3.7 Hebrew differed in 88 of 257 and also broke 91 texts that fit on one line. Flash-Lite and every Japanese answer returned single lines | **Not adopted** — Stage B two-line arithmetic stays |
| Dialogue `- ` hyphens | Japanese: **1** correct pair in 378; Hebrew: **3** wrong lone dashes; English: **0** | **Not adopted** — Stage B already splits at speaker pauses |

**5. Cost and latency (standard tier; output includes thinking).** Stage C at batch 50 vs Stage A on the same file (tokens in / out, processing wall time, approximate USD). The seconds are elapsed processing time, not recording length:

| Recording | Flash 3.7 Stage C | Flash-Lite 3.5 Stage C | Stage A `gemini-3.5-transcribe` |
|---|---|---|---|
| Hebrew | 37 205 / 34 544, **280 s**, ≈ $0.157 | 37 205 / 38 608, **112 s**, ≈ $0.108 | 112 800 / 19 047, **668 s**, ≈ $0.454 |
| English | 12 550 / 12 665, **96 s**, ≈ $0.057 | 12 550 / 14 424, **37 s**, ≈ $0.040 | 43 090 / 5 887, **444 s**, ≈ $0.157 |
| Japanese | 6 082 / 4 595, **47 s**, ≈ $0.022 | 6 082 / 6 534, **19 s**, ≈ $0.018 | 79 857 / 2 147, **333 s**, ≈ $0.185 |

Stage C is optional and uses the polishing model; default ON applies only on the dedicated path (section 1.1).

### 15.3 Empty saved transcript notice

A completed run can report a non-zero in-memory cue count while the promoted **`.srt`** is empty: `formatSrt` (`srt.ts`) skips cues with no non-whitespace text, and the parser can accept whitespace-only JSON cues that serialize to nothing. A release regression shipped an empty file under the green completion line because the UI looked at cue count instead of saved bytes. The shipped rule (`transcribe.ts` after successful `promote`): emit exactly one amber notice with `EMPTY_TRANSCRIPT_MESSAGE` only when `transcript.trim() === ''` **after** save succeeds; failed saves return earlier with no empty-transcript notice. Build checks cover an empty cue list, empty model text, whitespace-only cue text, and unchanged behaviour when save fails (CV18 **RR-V02** and Transcribe done-line gates).

---

## 16. Transcription engine A/B — **ab19** (Step 1.9)

**Corpus (3 media files).**

| Id | Duration | Language / layout | Role |
|---|---|---|---|
| `he` | **4281 s** (15 parts) | Hebrew; dialogue from **~3 min** | Longest; video; speechless opening |
| `en` | **1718 s** (6 parts) | English narration throughout | Blind rating file |
| `jp` | **2382 s** (8 parts) | Japanese; dialogue to **~24 min**, then sparse | Structural; Russian cue regression check |

**Settings (both arms).** `gemini-3.7-flash`, thinking **low**, sampling pinned off on wire; native adds fidelity sentence in instruction; **`SRT_ENGINE`** native vs CLI only difference.

**Key.** Paid key for all arms (free failed overload / quota on `en`).

**Counts.**

| | `en` native | `en` CLI | `en` CLI×2 | `jp` native | `jp` CLI | `he` native | `he` CLI |
|---|---:|---:|---:|---:|---:|---:|---|
| Outcome | ok | ok | ok | ok | ok | ok | **fail×2** |
| Cues | 432 | 439 | 435 | 140 | 128 | 1065 | — |
| Tokens | 71178 | 71095 | 70819 | 86173 | 75598 | 189210 | ~74k, no file |

**Hebrew CLI failure (F30).** Block at **30:00–35:00**, immediate retry loop until stall — **~74 k** tokens, no SRT. Native completed with recovery notices (uncovered stretch re-asked; script-mix warnings on two cues).

**Blind rating (`en`).** Maintainer: no meaningful difference; mapping **A=native, B=CLI** → rubric **PASS** (axes 1–2 same; timing negligible).

**Conclusion.** Native transcription **parity** on English/Japanese structure; **advantage** on Hebrew block segment where CLI stopped.

---

## 17. **ab29** (follow-up, not transcribe)

**ab29** is the **English → Hebrew translation** comparison on **11 episode subtitles**, native vs CLI (Step 2.9), not audio transcription; it is recorded in [`native-translation-engine.md`](native-translation-engine.md). **No ab29 audio transcription A/B** was run; transcription quality for release rests on **ab19**, the probes, and the Bundle I checks.

---

## 18. Decisions

### 18.1 Rules

| Rule | Why | Alternatives rejected |
|---|---|---|
| **Both** general and dedicated models | SRT AI Translator 1.1.0 already transcribes with Flash; Feature 5 **adds** dedicated workflow | “Pick one model family” (a question that was withdrawn once both were measured) |
| **300 s** chunks | gst parity; bounds refusal blast radius; **does not** prevent N6 alone | 30 min doc “limit” (falsified); duration-based safety (withdrawn) |
| **D5-10** one `languageCodes` | Fixes most dedicated silent loss | Omit field; multi-code list as policy (drops other languages) |
| **D5-13** spread detection | 3/3 vs 2/3 naive | First-minute only; re-sample on abstain |
| **D5-17** modal at Start | Catches Settings-only dedicated choice | Pre-filled field only |
| **Coverage + bisection** both paths | Flash and dedicated both fail partial runs; interior buckets + tail (section 15.1) | Trust `STOP`; tail-only check; fixed dB loud threshold |
| **Stage C guard** | Models slide/merge text across cues; count-equality checks let damage through (section 15.2) | Trust strict permutation only; no guard; whole-file polish requests at film scale |
| **Empty-transcript notice** | `formatSrt` can write zero cues while progress still holds whitespace cues (section 15.3) | Warn from in-memory cue count; skip notice when file is empty |
| **D5-12** gross disproportion | Stops worst N8 shipping | Bisect or retry (creates more invention) |
| **Cache nonce + refuse** | N7 data loss class | Accept cached text |
| **Stage C default ON** | Dedicated text is verbatim raw | SMART mode (incompatible with timestamps) |
| **No chunk shrink on 429** | Upstream #135 conflates quota with size | Copy gst combined reducer |

### 18.2 What would reopen a decision

- Dedicated model returns **`promptFeedback`** on refusals → recovery ladder could split earlier.
- Google documents **safe maximum audio duration** with proof → chunk size review.
- **`languageCodes`** optional with reliable multi-language output → modal/D5-10 scope change.
- Nonce or API flag **proven** to defeat cache at feature-length → relax cache refusal.
- Live **PROHIBITED_CONTENT** rate on transcribe → tune retry vs split defaults.

---

## 19. Build checks and live runs

| Evidence | Proven in gates | Seen live |
|---|---|---|
| Chunk plan 300 s | TX14, `transcribe.ts` | ab19 six-part English |
| Dedicated request shape | I.2 loopback | Round 16 |
| Spread offsets 10…85% | TX14, I.3 | Detection in app (ipc spreadSample) |
| Coverage relative threshold + interior buckets | CV18 (incl. 99.9% tail / empty interior fail) | ab19 native notices |
| Polish batch guard + batch 50 | I.9 | Three-recording Stage C campaign (section 15.2); not ab19 (Flash path) |
| Empty transcript after save | CV18 RR-V02, Transcribe done line | Release regression fix (section 15.3) |
| ab19 PASS English | Step 1.9 checks | Maintainer blind rating |
| Cache live ≥18 k | I.4, I.5 | Round 16 live pair, paid key only |
| Full film dedicated + polish | Partial | Three full files in 15.2; not a named public corpus |

### 19.1 Native preparation progress probe

SRT AI Translator 1.1.0 needed a check that the Python engine's output was not held back by subprocess buffering (a PyInstaller control in `run-buffering`). The native engine has no subprocess to buffer, so when the CLI engine was retired the check was repointed (`scripts/verify/buffering.ts`, check **NF**) at what still matters: **do preparation progress events reach the app as they happen?** The probe builds a synthetic 10-minute fixture with FFmpeg (black video and a 440 Hz tone, so no real media and no cost), runs it through the app's own preparation on the bundled FFmpeg, and uses a stand-in provider that stops the run at its first request, so nothing reaches the network. The measured run: **Preparing** at **10 ms**, **Working** at **9 055 ms**, **10** FFmpeg progress updates spread between **2 595 ms** and **9 055 ms**, then **Stopped** with nothing sent. The check fails if the events arrive bunched together, if either phase is missing, or if more than one request is attempted. It measures progress delivery and stopping, not transcription latency.

---

## 20. Limits

- **Multilingual films** on dedicated path: other languages **dropped**; only **60 s** bilingual clip measured.
- **N8 / D5-12:** long inventions may pass; low-speech **warning** only.
- **Loudness ≠ speech** (F-A14): coverage is heuristic; tail coverage alone never authorises acceptance (section 15.1).
- **Stage C quality:** guard is structural (words stay in cues), not a WER or meaning review; evidence is **three** full files (section 15.2).
- **Word error rate:** no human reference transcript for probes; ab19 compared engines, not ground truth text.
- **Models / keys:** most long probes used **one** paid project; free tier **429** changed round-2 key.
- The ab19 comparison ran while the old gst command-line engine still existed. That engine was retired in
  Phase 4; native is now the only engine, so the CLI column in section 16 is history, not an option.
- **Live `-live` transcribe ids** refused in app (`liveModelRefusal`).

---

## 21. Recommendations

1. For **multilingual** or code-switching media, use a **general** model with the language-lock instruction unless the user accepts single-language output.
2. For **maximum timing precision** (e.g. align workflows), prefer **dedicated** model; expect modal + review on low-speech sources.
3. Leave **polishing ON** for dedicated unless latency matters; pick **3.7-flash** polishing model when quality beats cost (`POLISH_MODEL_TIP`).
4. If spans are **refused from cache**, wait or retry later — nonce does not reliably bust cache at length.
5. Treat **429** with pacing settings, not smaller chunks ([`free-tier-protection.md`](free-tier-protection.md)).

---

## 22. Code and checks (`scripts/gates/gates.ts`)

| Topic | Location | Gate sections (examples) |
|---|---|---|
| Chunk 300 s, run loop | `electron/engine/transcribe.ts` | TX14, NA19 |
| Recovery policy | `transcribe.ts`, `recover.ts` | TX14, I.5, R18 G.8 |
| Coverage / D5-12 | `electron/engine/coverage.ts` | TX14, CV18 |
| Empty transcript notice | `electron/engine/transcribe.ts`, `electron/shared/engineEvents.ts` | CV18 RR-V02, Transcribe done line |
| Dedicated request | `electron/engine/transcribeDedicated.ts` | I.2, I.4, I.5 |
| Detection D5-13 | `electron/engine/sourceLanguage.ts`, `electron/main/ffmpeg.ts` | I.3, TX14 spread |
| Stage B cues | `electron/engine/cues.ts`, `offsets.ts` | I.1 |
| Stage C polish | `electron/engine/polish.ts` | I.9 |
| Settings / UI | `electron/shared/transcribeSettings.ts`, `TranscribePage.tsx`, `SourceLanguageModal.tsx` | G1e, I.6–I.8 |
| Native routing | `electron/engine/native/nativeAdapter.ts` | I.10, NA19 |
| Generic schema / grid | `electron/engine/providers/gemini.ts`, `prompt.ts` | TS16, RC13 |
| Defaults | `electron/main/store.ts`, `electron/shared/types.ts` | G1e, store migrations |
| Transcribe pacing | `electron/engine/requestAdvisor.ts` (not used for audio shrink) | R17 F6–F7 |

Related: [`content-block-recovery.md`](content-block-recovery.md) (refusal ladder), [`continue-and-retry.md`](continue-and-retry.md) (checkpoint), [`free-tier-protection.md`](free-tier-protection.md) (429/quota).

---

## 23. Label index

| Label | Meaning | Section |
|---|---|---|
| **N6** | Dedicated silent omission; mainly missing `languageCodes` | 5, 8 |
| **N7** | Implicit cache degraded transcript | 6, 14 |
| **N8** | Fabrication on low-information audio | 9 |
| **N9** | One language per dedicated request | 11 |
| **D5-6** | Chunk in minutes (300 s); not duration safety | 1, 18 |
| **D5-7** | Interior coverage gate (relative loudness; not tail-only) | 1, 15.1 |
| **D5-2** | Stage C default ON; polishing model picker; batch 50 | 1, 15.2 |
| **RR-V02** | Empty saved transcript amber notice | 1.3, 15.3, 19 |
| **EMPTY_TRANSCRIPT_SIGNAL** | Code comment / warning signal for empty file | 15.3 |
| **D5-8** | ~~Shift slice~~ **withdrawn** | 6, 8 |
| **D5-9** | Cache counted; nonce handler | 14, 15 |
| **D5-10** | Mandatory `languageCodes` | 8, 18 |
| **D5-11** | Bisection recovery | 1, 15 |
| **D5-12** | Gross disproportion refusal | 9, 18 |
| **D5-13** | Spread 6×10 s detection | 10, 15 |
| **D5-14** | Two paths’ language capabilities + UI trade text | 11, 18 |
| **D5-15** | Native-script clause not adopted | 12 |
| **D5-16** | Override toggle, not separate default | 1 |
| **D5-17** | Source-language modal at Start | 1, 15 |
| **D5-18** | No thinking/sampling on dedicated | 1 |
| **D6-8** | Refusal retry count before split | 13, 18 |
| **F-A16** | Identical resend on silent **success** useless | 6, 13 |
| **F-A16 scoped** | Refusal retry 1/5 | 13 |
| **E17a** | ~~Duration scales loss~~ **withdrawn** | 5, 6 |
| **E18b** | `languageCodes` mechanism | 8 |
| **E18c** | D5-8 withdrawn | 8 |
| **E19a** | Fixture label from model | 9 |
| **E20a** | 4/4 detection not selection step | 9, 10 |
| **E23** | Naive **`zxx`**, not wrong language | 9, 10 |
| **E21c / N9** | Single-language rescope D5-10 | 11 |
| **ab19** | Native vs CLI transcribe A/B | 16 |
| **AR-FINAL-3** | Cache nonce + refuse | 14, 15 |
| **Bundle I** | Dedicated Stages A–C | 15, 15.1–15.2 |
| **F-A14** | Loudness is not speech | 15.1, 20 |
| **#135** | Upstream shrink — **not** for quota on audio | 1, 15, 18 |
| **FP-9** | Refusal recovery; see content-block doc | 8, 13 |
| **F30** | CLI block loop on Hebrew ab19 | 16 |
| **F29** | 0.45 s overlap Hebrew native ab19 | 16 |
