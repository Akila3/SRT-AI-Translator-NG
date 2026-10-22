# Experimental gender layers (Speaker, C1, Method B)

**Decision in one paragraph.** After the base gender reference and compare-and-repair pass (see
[`gender-reference.md`](gender-reference.md)), Hebrew translation may optionally run three **experimental**
layers controlled in Settings. **Speaker** compares the translated line’s speaker morphology to a trusted
human **Hebrew** reference and may send a separate repair request for speaker flags. **Spanish/Portuguese C1**
adds conservative Romance addressee patterns on aligned helper text and on Spanish or Portuguese **source**
lines when that switch is on. **Method B** sends one blind Gemini classification over axes the deterministic
readers cannot read, then repairs only contradictions with the reference. All four switches (plus a master
**Advanced Hebrew correction** gate) **default OFF**; Speaker and Method B carry a “Recommended: keep OFF.”
tooltip because live and corpus measurement showed real benefit alongside wrong-person risk, non-determinism,
and (for Method B) incomplete or unstable classification on part of the test corpus. C1 stays OFF by default
because only a handful of correct changes were measured and the false-positive rate on natural dialogue is
still unknown.

**Status:** current. **Evidence scope:** frozen measurement design (2026-09-14); private research campaigns
v1 through v5d on up to eleven English→Hebrew workspace titles (layer calls on Gemini 3.1 Flash-Lite,
Medium thinking, in v1–v2, then Gemini 3.5 Flash-Lite, LOW thinking, temperature 0, from v3; fresh
batched Stage-1 of 50 cues in v5d; see "Models used in testing"); live packaged-app matrix on six titles (2026-10-16) and
re-measure after Round 19A fixes (2026-10-17). Independent video-grounded speaker truth covered 30 disputed
cues in the September campaign, not the full live matrix. Method B’s 123 accepted research events are
helper-axis agreement, not independently adjudicated semantic fixes.

**How to read this file.** Section 1 is what the code does today. Section 2 is SRT AI Translator 1.1.0. Section 3 is the
timeline. Sections 4–12 are the studies in order. Section 13 is the decision set. Section 14 separates gate
proof from live observation. Sections 15–17 are limits, recommendations, and the code map. Section 18 indexes
short labels in comments.

**Out of scope here (linked only):** the base gender reference, download, alignment, and wrong-alphabet repair —
[`gender-reference.md`](gender-reference.md), [`reference-subtitle-download.md`](reference-subtitle-download.md),
[`subtitle-alignment.md`](subtitle-alignment.md), [`wrong-alphabet-repair.md`](wrong-alphabet-repair.md).

---

## Models used in testing

Each test has two parts that can differ: the **first-pass translation** the layers were run on, and
the **layer calls** themselves (classifier and repair requests). The table lists them separately.

| Test (section) | First-pass translation the layers ran on | Layer calls: model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|---|
| Campaign v1, discarded (5) | An earlier research translation; its generation settings were not captured | `gemini-3.1-flash-lite` | Medium | Temperature 0, top-P 0.95, top-K 64 | Not recorded | 14 reserved calls (12 returned 503) | Sep 14–24 |
| Campaign v2 (6) | The same earlier research translation, settings not captured | Mostly `gemini-3.1-flash-lite` | Medium | Temperature 0, top-P 0.95, top-K 64; two repeats, no 503 retry | Not recorded | Small slices (5 to 25 cues) on 3 titles | Sep 14–24 |
| Campaign v3 (7) | The same earlier research translation, settings not captured | `gemini-3.5-flash-lite` | Low | Temperature 0, top-P 0.95, top-K 64, three repeats | Paid | Part of the 81 calls for v3 and v4c | Sep 24 |
| Campaign v4c (7.1) | **Fresh** first pass of one 471-cue drama episode, `gemini-3.5-flash-lite` Low | `gemini-3.5-flash-lite` | Low | As v3 | Paid | Part of the 81 calls for v3 and v4c | Sep 24 |
| Method B eleven-title follow-up, v5d (8) | **Fresh** first pass per title, `gemini-3.5-flash-lite` Low, batches of 50 | `gemini-3.5-flash-lite` | Low | Temperature 0; classifier batches of 250; three repeats | Paid | 316 calls, 7,759 cues, 11 titles | Sep 24 |
| Live matrix, Round 19 (10) | Made by the packaged app, `gemini-3.5-flash-lite` Low, no reference in the prompt | `gemini-3.5-flash-lite` | Low | The app's own layer requests | Free, then Paid | 10 new first-pass files plus one drama | Oct 16 |
| Re-measure after Round 19A (11) | The same first-pass bytes as Round 19 | `gemini-3.5-flash-lite` | Low | Speaker in its own request | Free, then Paid | 11 first-pass files | Oct 17 |
| Packaged Speaker A/B (14) | Identical first-pass bytes for both arms | `gemini-3.5-flash-lite` | Low | Speaker off vs on | Free first | One drama, 4 speaker fixes | Oct 16 |

For v1 to v3 the first pass came from an earlier research harness. Its saved files do not include the
requests that produced them, so the model and settings it was translated with are unknown. That is one
reason v4c and v5d generated fresh first passes on the measured model.

**Would a different model change the results?** Yes. Every layer here asks a model to judge or rewrite
gender, so each result is model behaviour:
- Speaker's identity fixes, and its repeatable wrong-speaker edits;
- the one stable Spanish C1 fix;
- Method B's classifier stability (about 78% per axis) and its content blocks.

The layer calls **moved** from `gemini-3.1-flash-lite` at Medium (v1 and v2) to `gemini-3.5-flash-lite`
at Low (v3 onwards), so v1 and v2 results do not carry over. v3 also ran on a first pass of unknown
origin; v4c, v5d and the live matrices are the results measured end to end on one model. Single live runs also vary from run to run on
the same model. The OFF defaults rest on these measurements; a different model would need the
enablement measurements in section 9 repeated before any default changes.

## 1. What the app does today

### 1.1 Where the layers sit

Translation finishes with **`genderFinish`** in `electron/engine/run.ts`: designated readers flag cues whose
Hebrew output contradicts the aligned reference (and, when C1 is on, Spanish or Portuguese text on the helper
or source), then **repair** runs, then optional **Method B**, then leaked speaker tags may be stripped from
the reference. Kept source-language lines are never touched.

| Step | Always (Hebrew target + eligible reference) | Speaker switch ON | C1 es/pt switch ON | Method B switch ON |
|---|---|---|---|---|
| Flag | Ported addressee reader (`addresses_female` / `addresses_male`) + chain-language helper readers | Also flag opposite **speaker** vs human **Hebrew** helper | Also flag opposite **addressee** vs conservative **es/pt** patterns (helper and/or source caller) | After repair: classify **unread** axes blind, flag contradictions with reference |
| Repair | One request, 24 000 JSON-character cap (H26) | **Two** requests when any flag is speaker: addressee-only cues first, then speaker cues (D19A-1) | Same repair path; C1 corrections veto with **`c1OutputAddressee`** (pronoun fallback, D19A-2) | One repair after classification; fail-soft on refusal, short labels, or parse errors |
| Extra Gemini calls | 0–1 repair | Up to **2** repair (+ classification not used) | 0–1 repair | Up to **2** (classify + repair) |

Method B’s classifier prompt lists cue index and Hebrew text only; it never sees helper text or desired gender
(`genderRepair.ts`, `run.ts` `methodBStep`).

### 1.2 Settings and defaults

Under **Settings → Advanced → Advanced Hebrew correction**:

| Control | Stored field | Default |
|---|---|---|
| Master: Advanced Hebrew correction | `hebrewAdvanced` | **OFF** |
| Experimental speaker-gender repair | `hebrewSpeakerRepair` | **OFF** |
| Experimental unread-gender Method B | `hebrewMethodB` | **OFF** |
| Spanish reference rules | `hebrewC1Spanish` | **OFF** |
| Portuguese reference rules | `hebrewC1Portuguese` | **OFF** |

Defaults are in `electron/main/store.ts`. Only a literal stored `true` enables a layer at runtime; anything
else reads as off (`TranslatePage.tsx` `advancedHebrewFlags`, migrations fail-closed).

While the **master** is off, a run uses **none** of the four layers regardless of their stored values; values
are kept for when the master is turned back on (`settingsHebrewFlags`, `ADVANCED_HEBREW_MASTER_TIP`).

**Translate** shows an amber card when any layer is on and the target is Hebrew: layers are **requested**,
not promised; eligibility is checked at run time (`AdvancedHebrewCard`). Non-Hebrew targets show **inactive**
and list nothing.

**Tooltips:** Speaker and Method B open with **“Recommended: keep OFF.”**, list weak spots from live
re-measurement, and end with a review instruction. C1 toggles have **no** “?” tooltip; their label text states
measured change counts and that the wider false-positive rate is not yet measured.

### 1.3 Eligibility (summary)

| Layer | Needs |
|---|---|
| Base repair | Hebrew target, hint-eligible aligned reference (human, not machine-translated Hebrew; Wizdom never drives correction) |
| Speaker | Above + **`speakerEligible`** helper (human Hebrew from OpenSubtitles not flagged MT, or disk Hebrew with “This is human Hebrew”) + opposite speaker reading on output |
| C1 Spanish | Switch on + (`helper` language es **or** certain Spanish **source** when Auto Detect or picker says es) |
| C1 Portuguese | Same for pt |
| Method B | Switch on + eligible helper + reference asserts gender on an axis the **output** reader left unread; speaker axis only if Speaker is also on |

If helper and source C1 callers disagree on addressee, the cue **abstains** (no flag). French and Italian C1
have **no** UI fields and no production flags.

### 1.4 Round 19A behaviours bundled with these layers

These ship on every Hebrew run and exist because of the same measurement round; they are not separate toggles:

- **D19A-1:** split repair when Speaker is on (`repairGenderByAxis` in `genderRepair.ts`).
- **D19A-2:** `c1OutputAddressee` — when C1 marks addressee and the ported addressee reader abstains, pronoun `את` / `אתה` may
  flag and veto (`genderReaders.ts`).
- **D19A-3:** one guarded **other-alphabet** redo before gender finish (`strayAlphabet.ts`).

A planned UI rule — grey C1 unless Method B is on — was **not** applied: after D19A-2, C1 alone changed four
cues correctly in live re-measure, so C1 remains independently usable.

---

## 2. What SRT AI Translator 1.1.0 did

SRT AI Translator 1.1.0 had no gender reference at all: gender reached the prompt only through TMDB cast genders in the
description and optional audio. It had no second pass that flags wrong Hebrew morphology, no
classification of unread lines, and no Speaker, C1 or Method B switches. The Kodi add-on implemented the
reference hints and the base repair, and NG ported that behaviour (see
[`gender-reference.md`](gender-reference.md) section 2). The three layers documented here are NG-only
optional extras on top.

---

## 3. Timeline

| When (2026) | What | Outcome |
|---|---|---|
| Sep 10–13 | Method B restored as experimental; C1 dictionaries fixed, flags default OFF; Speaker repair contract H19a/H19b | Design settled before measurement |
| Sep 14 | Frozen measurement recipe for Speaker, C1, Method B | A written runbook for the campaign, fixed before any run |
| Sep 14–24 | Private campaigns v1 (invalid) → v2 → v3 → v4c → v5d | Full numbers in the measurement report; labels E108–E110 |
| Sep 25 | Enablement contract D17-1…D17-7 (UI, persistence, honest copy) | Settled; flags stay OFF by default |
| Oct 16 | Live layer matrix on six titles; JSON repair parser fix; Speaker/Method B tooltips | Round 19 live matrix |
| Oct 17–18 | Round 19A: split repair, C1 pronoun reader, stray-alphabet redo; live re-measure; C1 label text | D19A-1…3; master switch `hebrewAdvanced` |
| Shipped build | Feature 17 gates F17.0–F17.3, H.2 Method B, R19A A.1–A.7 | `scripts/gates/gates.ts` |

---

## 4. Frozen measurement design (2026-09-14)

Each extra fires only on a **specific input shape**. Running the eleven-title **language-ranking** harness with
random language mixes does **not** score Speaker (needs human **Hebrew** helper), C1 (needs es/pt text in
helper or source), or Method B (needs unread axes after repair).

**Speaker:** Hebrew target + speaker-eligible Hebrew helper; score only cues where helper and Stage-1 output
disagree on speaker; report fixes, regressions, abstentions, cost — not whole-file accuracy.

**C1:** Two callers measured separately — (A) English source + es/pt helper, (B) translate **from** es/pt.
Arms: C1 OFF vs ON on **byte-identical** Stage-1 Hebrew. Precision over recall; committed must-not-match unit
fixtures are necessary but not sufficient for enablement.

**Method B:** Frozen trio on same titles and Stage-1 bytes: (1) prompt only, (2) prompt + B1 repair, (3) prompt
+ B1 + Method B. Classifier is **blind** (observed Hebrew only); compare to **independent** oracle assertion;
score the unread slice, not lines B1 already fixed.

**Test 0 / H18:** Addressee reader ported from the Kodi add-on (`addresses_female` / `addresses_male`) — `ואת` forms vs object `את` (not Speaker/C1/Method B).

---

## 5. Campaign v1 — invalid alignment (discarded)

| Item | Value |
|---|---|
| Runs | 14 reserved API slots |
| HTTP outcome | 2× 200, 12× 503 |
| Defect | Helper dialogue from adjacent cues leaked across alignment boundaries |

**Conclusion:** all v1 quality scores are **inadmissible**. v2 switched to Kodi `align_one` one helper line per
source cue.

---

## 6. Campaign v2 — corrected alignment (partial)

Operating point: research harness, largely `gemini-3.1-flash-lite`, medium thinking, two repeats, no 503 retry.

| Test | Title shape | Key numbers |
|---|---|---|
| Speaker | Feature-length romance **B**, opposite-speaker slice 25 cues | Arm B +15 / +16 helper agreements vs Arm A in two repeats |
| Speaker | Drama episode **F**, slice 5 cues | One repeat 5/5 vs 0/5; other repeat provider-unavailable |
| C1 | **B** + drama **S** | 10 assertions, **0** opposite readable conflicts → 0 flags |
| Method B | Layering bug | Arm C did not start from Speaker Arm B — Method B scores not admissible until v3 |

22 speaker flags were also dropped by a fixed JSON character cap on **B**, so the slice was incomplete.

---

## 7. Expanded campaign v3 / v4c — Flash-Lite 3.5 LOW

Primary point: **`gemini-3.5-flash-lite`**, LOW, temperature 0, three repeats, **503-only** identical-body
retry (81/81 logical calls returned 200 in v3–v4c; retry branch unused).

### 7.1 Speaker — helper agreement then identity labels

**v2-style helper agreement (romance B):** repeatable +15/+16 on 25-cue slice; still no video identity.

**v3 — 30 disputed cues with independent screenplay/transcript labels:**

| Slice | Result (three repeats) |
|---|---|
| Drama **F**, single-speaker | 0/4 → **4/4** correct |
| Drama **F**, one mixed-speaker cue | Changed every repeat (unsafe) |
| Romance **B**, single-speaker (21-cue set) | 2/21 → **12/21** |
| Romance **B**, already-correct cues | Two cues flipped to wrong gender repeatedly; one mixed-speaker cue changed every repeat |

**v4c — fresh Stage-1 for drama F at 3.5/LOW, end-to-end:** single-speaker truth 1/4 → 3/4, 4/4, 3/4 after
Speaker; mixed-speaker cue still changed every repeat.

**Count summary (identity slice):** 16 unique single-speaker cues improved vs two unique single-speaker
regressions plus two unique mixed-speaker unsafe changes; repeat-event totals 47 improvements vs five
single-speaker regressions and six mixed-speaker changes.

**Conclusion:** benefit is real and larger than harm **by count**, but wrong-speaker edits are **severe**; the
frozen gate requires zero severe regression on a safety slice before default ON. Speaker stays **OFF**.

### 7.2 C1 — Caller A/B and one stable Spanish fix

| Arm | Result |
|---|---|
| Caller A, historical Stage-1 | Up to 8 Spanish + 2 Portuguese assertions on **B**; OFF = ON (no opposite case) |
| Caller B, es/pt source translations | Completed; no opposite readable case |
| Fresh 3.5/LOW English **B** | **1** opposite among 8 Spanish assertions; cue repaired F→M in all three repeats, aligned with human Hebrew; 0 breaks on slice; Portuguese 2 assertions, 0 changes |

**Conclusion:** dictionaries behave conservatively in units (12/12 controls pass in research harness); natural
corpus shows **one** stable Spanish correction — promising, not enablement.

### 7.3 Method B — corrected layering (471-cue drama episode **F**)

| Title | Classifier completeness | Repair |
|---|---|---|
| Drama **F** (471 cues) | 471/471 all repeats | 2–3 accepted axes per repeat |
| Romance **B** | 1439–1440/1442 | Exact-count gate → **no** repair sent |

Labels varied run-to-run; longer title exposed omission under exact-count rule.

---

## 8. Eleven-title Method B follow-up (v5d)

**Setup:** eleven workspace English→Hebrew titles (**T1–T11** below), **7 759** source cues from frozen harness
English text union; fresh schema-constrained Stage-1 per title at 3.5 Flash-Lite LOW; **50-cue** translation
batches; **250-cue** classifier chunks; one frozen B1 addressee-only baseline per title (Speaker and C1 OFF);
three Method B repeats from identical baseline bytes; 503-only retry.

| Label | Genre (generic) | Method B: 3/3 complete classifier repeats |
|---|---|---|
| T1 | Drama series, ep. 1 | Yes |
| T2 | Sci-fi series, ep. 1 | Yes |
| T3 | Historical drama, ep. 1 | Yes |
| T4 | Workplace thriller, ep. 1 | Yes |
| T5 | Comedy series, ep. 4 | Yes |
| T6 | Mystery comedy, ep. 1 | Yes |
| T7 | Drama series, ep. 2 | No — content blocks every repeat |
| T8 | Spy drama, ep. 1 | No |
| T9 | Spy drama, ep. 2 | No |
| T10 | Mystery comedy, ep. 4 | No |
| T11 | Media workplace drama, ep. 2 | No |

Transport: **316** logical slots, **317** attempts (one 503 retried successfully). **18** classifier chunks
returned `PROHIBITED_CONTENT` with no candidate across failing titles.

### 8.1 Stability and volume (six completing titles)

| Metric | Value |
|---|---|
| Titles completing all three classifier runs | **6/11** |
| Titles with byte-identical full label sets across three runs | **0/6** (0/11 corpus-wide) |
| Individual returned axes stable | **6 420/8 234 (77.97%)** |
| Both axes stable per cue | **2 557/4 117 (62.11%)** |
| Unique proposed axes stable across repeats | **41/69 (59.42%)** |
| Unique accepted cues stable across repeats | **29/50 (58.00%)** |
| Proposed axis events → guarded accepts (all repeats) | **165 → 123** |

The **123** accepts move toward aligned human-Hebrew reader axes by construction; they are **not** independent
accuracy proof. The **29** stable accepts are the adjudication backlog, not shipped truth.

**Conclusion:** Method B stays **experimental/OFF** — five titles never complete classification under the
exact-count design; successful titles vary materially; content refusal recovery would be a **new** product
change, not silent enablement.

---

## 9. Enablement contract (2026-09-25)

The maintainer selected **offered** controls, not defaults ON:

- Speaker: independent experimental opt-in; measured benefit > harm on identity slice, but **not** default ON.
- One Settings group (later: master + four independent toggles); French/Italian C1 not exposed.
- Translate indicator; frozen snapshot at Start; exact risk strings (D17-6); no claiming 123 accepts or 29
  stable candidates as “fixes” without blind adjudication (D17-7).

---

## 10. Live matrix — Round 19 (2026-10-16)

**Method:** Packaged app produced Hebrew Stage-1 for ten new jobs plus an existing drama **F** Stage-1; layers
run on identical bytes through production `genderFinish` with real Gemini (Flash-Lite 3.5 LOW). Stage-1 had **no**
reference in prompt (harsher than production). Six English-source titles with human Hebrew references; es/pt
reference and source arms.

| Arm | Accepted changes | Correct | Wrong | Unclear |
|---|---|---|---|---|
| Base addressee repair | 19 | 19 | 0 | 0 |
| Speaker (delta) | 50 | 47 (+1 stray quote) | 1 | 1 |
| Method B alone | 20 | 19 | 1 | 0 |
| Speaker + Method B | 29 | 26 | 2 | 1 |
| **C1 alone** | **0** | — | — | — |
| C1 + Method B | 3 | 3 | 0 | 0 |

**Findings assigned to Round 19A:**

1. Speaker **crowded out** five base fixes on romance **B** (one 24 000-character request filled with speaker flags).
2. Two-axis prompt accepted **unrequested-axis** speaker edits (three cues).
3. Guard accepted mixed **אתה** + feminine verb (two cases).
4. Speaker reader misread another subject’s verb after `אני` (two cases).
5. Stray foreign letter / backslash passed guard.
6. **C1 alone changed nothing** — contradictions were `את` + adjective forms the Hebrew reader does not read.
7. Glued non-Hebrew fragments in Stage-1 (separate wrong-alphabet track).

Minor fix same day: JSON-shaped repair replies now parse when they wrap valid SRT entries.

---

## 11. Round 19A fixes and re-measure (2026-10-17)

| ID | Change | Why |
|---|---|---|
| **D19A-1** | Addressee repair first, speaker repair second request, each under 24 000 cap | Stops Speaker from dropping base fixes and reduces two-axis prompt bleed |
| **D19A-2** | `c1OutputAddressee` / pronoun veto for C1 flags | Three live contradictions were unread by the ported addressee reader; C1 alone had zero flags before |
| **D19A-3** | Automatic other-alphabet redo on Hebrew runs | ~half of glued foreign words need model redo, not letter tables |

**Live re-measure (same Stage-1 bytes, production path after fixes):**

| Arm | Changes | Correct | Wrong | Unclear | Prior Round 19 |
|---|---|---|---|---|---|
| Base | 42 | 41 | 1 | 0 | 19 / 19 / 0 / 0 |
| Speaker delta | 67 | 66 | 0 | 1 | 50 / 47+1 / 1 / 1 |
| Method B delta | 28 | 25 | 0 | 1 | 20 / 19 / 1 / 0 |
| Speaker + Method B | 92 | 87 | 2 | 3 | 29 / 26 / 2 / 1 |
| **C1 alone** | **4** | **4** | 0 | 0 | **0** |
| C1 + Method B | 4 | 4 | 0 | 0 | 3 / 3 / 0 / 0 |

Crowd-out **fixed** (base + speaker totals match per title). C1 alone now fixes romance **B** (two cues) and
drama **A** (one cue; both es and pt reference arms). **D19A-2 stop condition not met** — C1 is **not** greyed
behind Method B.

Remaining weak spots recorded in tooltips: two-speaker lines, run-to-run variation, one mixed-form line when
Speaker and Method B combine, up to two extra requests for Method B.

---

## 12. Test 0 / reader safety (gates + research)

| Check | Runs | Result |
|---|---|---|
| H18 addressee (`ואת` vs object `את`) | 5 frozen strings | F/F/F/NA/NA |
| H19b dual-anchor speaker mute | 9 frozen controls | Corrected reader passes; legacy `heb_gender` fails dual-anchor case |
| C1 unit must-not-fire + positives | 12 + 8 controls | All NA on negatives; M/F on positives |

These prove shape safety, not corpus accuracy uplift.

---

## 13. Decisions and why

### 13.1 Defaults

| Switch | Default | Why |
|---|---|---|
| `hebrewAdvanced` | OFF | Experimental group; nothing runs until user opts in |
| `hebrewSpeakerRepair` | OFF | Identity measurement: large single-speaker lift but repeatable wrong-speaker and mixed-dialogue edits; live 66/67 correct after fixes still not zero-risk |
| `hebrewMethodB` | OFF | v5d: 5/11 titles never complete; 0/6 byte-stable label sets; 77.97% axis stability; net accuracy gain **unmeasured** independently |
| `hebrewC1Spanish` | OFF | One stable v3 fix + three live Spanish cues; false-positive rate on natural dialogue **unknown** |
| `hebrewC1Portuguese` | OFF | One live cue correct; no broad corpus |

### 13.2 Why Speaker and Method B say “Recommended: keep OFF.”

The maintainer required the tooltips to state the **remaining** risk in plain language after Round 19A, not
only the general experimental warning. Speaker: wrong-person and two-speaker cases, non-determinism, extra request. Method B: no
proven net accuracy gain, content refusal abstention, non-determinism, up to classify + repair requests,
one documented mixed-form case with Speaker on.

C1 omits that tooltip because the decision is “small measured benefit, unknown FP rate — user may opt in with
review”, not “recommended off despite unclear upside”.

### 13.3 Alternatives rejected

| Rejected | Why |
|---|---|
| Default ON Speaker from helper-agreement lifts | Severity gate: wrong speaker rewrites who spoke; mixed dialogue not abstained reliably |
| Default ON Method B from 123 accepts | Circular with helper/reference; unstable labels; five titles fail exact-count |
| Auto-enable C1 from one Spanish fix | Enablement requires held-out titles and FP measurement on negatives |
| Grey C1 unless Method B (D19A-2 fallback) | Live re-measure: C1 alone fixed 4/4 after pronoun reader |
| One combined repair request with Speaker on | Crowds out base fixes on flag-heavy titles (Round 19) |
| Classifier-side split/recovery for Method B blocks | Not implemented because it would change the Method B classifier's recovery contract; that needs its own design and measurement |
| French/Italian C1 toggles | Not separately measured |

### 13.4 What would reopen a default

- **Speaker:** video-grounded labels on disputed cues, mixed-speaker abstention, zero severe regressions on
  safety corpus, fresh holdout title, production-path replay at user model settings.
- **Method B:** independent adjudication of all 69 proposed axes and stable accepts; at least one long title
  completing three identical classifier runs; measured stability above v5d bar; explicit maintainer enable.
- **C1:** held-out natural episodes, zero FP on committed negatives + adjudicated changed cues per language.

---

## 14. Build checks and live runs

**Proven in gates (not live Gemini):** four switches default false and migrate safely (F17.0); Settings copy and
master behaviour (F17.1); Start snapshot and card (F17.2–F17.3); Speaker eligibility and dual repair (F17-G5,
R19A A.5); blind Method B and fail-soft (F17-G6, H.2); C1 two-callers and conflict abstain (F17-G7); pronoun
reader (R19A A.6); reader clause and guard fixes (R19A A.1–A.4, A.7).

**Seen live:** the matrices in sections 10 and 11 (real API, six-title core) and a packaged-app Speaker
A/B on drama **F** (4 of 4 speaker changes correct). **Not seen live:** full eleven-title Method B stability at v5d scale inside the shipped
app UI; independent blind adjudication of Method B accepts; default-ON for any layer.

---

## 15. Limits

- Most quality evidence: **English → Hebrew**, Gemini **3.5 Flash-Lite LOW**, specific human reference files the
  maintainer supplied — not other language pairs or models unless noted.
- Historical Stage-1 for September campaigns is not transport-proven to current config; v5d regenerated Stage-1
  at 3.5/LOW but used synthetic timecodes for structure.
- Live matrices used Stage-1 **without** reference in the first pass; production runs include hints — counts
  differ.
- Romance **B** Hebrew reference aligns loosely in places; hand judging inherits that noise.
- Speaker “correct” in live matrix means agreement with **human subtitle at same index**, not verified on-screen
  identity except the 30-cue identity substudy.
- Method B **165/123** and stability percentages describe **research** accepts, not user-visible “fixes”.

---

## 16. Recommendations

- Leave all four layers **OFF** until the user explicitly needs them and will **review** output.
- Turn **Speaker** on only with a trusted human **Hebrew** reference and tolerance for two-speaker risk.
- Turn **Method B** on only when willing to accept abstention on blocked chunks and run-to-run differences.
- Turn **C1** on for Spanish or Portuguese helper/source jobs when addressee gender in the Romance text matters;
  treat Portuguese as thinner evidence than Spanish.
- Do not cite v5d accept counts as accuracy improvements without completing the stable-candidate adjudication
  set.

---

## 17. Code and checks

| What | Where | Gate sections |
|---|---|---|
| Layer flags → run | `run.ts` `requestedGenderLayers`, `genderFinish`, `methodBStep` | R19 F17.3 (F17-G5–G8) |
| Readers: ported addressee, speaker, C1, pronoun | `genderReaders.ts` | R19 H.1; R19A A.2, A.6 |
| Repair + Method B classifier | `genderRepair.ts` | R19 H.2; R19A A.3–A.5 |
| Split repair by axis | `genderRepair.ts` `repairGenderByAxis` | R19A A.5 |
| Stray alphabet redo | `strayAlphabet.ts`, wired in finish path | R19A A.7 |
| Defaults / migration | `electron/main/store.ts`, `migrations.ts` | R19 F17.0 |
| Settings UI + tooltips | `SettingsPage.tsx` `AdvancedHebrewCorrection` | R19 F17.1 (F17-G2) |
| Translate card | `TranslatePage.tsx` | R19 F17.2 (F17-G3–G4) |
| Types / IPC | `electron/shared/types.ts`, `nativeAdapter.ts` | R19 F17.3 |

---

## 18. Label index

| Label | Meaning | Section |
|---|---|---|
| D17-1…D17-7 | Enablement contract: opt-in Speaker, group UI, snapshots, honest copy | 9, 13 |
| D19A-1 | Two repair requests when Speaker on | 1.4, 11, 13.3 |
| D19A-2 | C1 pronoun reader / veto; grey-C1 fallback **not** triggered | 1.4, 11 |
| D19A-3 | Other-alphabet redo | 1.4, 11 |
| H18 | Ported Kodi addressee reader (Test 0) | 4, 12 |
| H19a | Speaker-eligible Hebrew helper provenance | 1.3, 4 |
| H19b | Speaker reader + dual-anchor mute | 4, 12 |
| H26 | 24 000-character repair JSON cap | 1.1, 10 |
| E108–E110 | September campaign measurement labels | 3, 7–8 |
| §2.5b | Method B design | 4 |
| §2.5d | Frozen measurement | 4 |
| F17-G* | Feature 17 gate group | 14, 17 |
