# Gender reference and Hebrew gender repair

**Decision in one paragraph.** For English-to-Hebrew (and other sources into Hebrew), the app can load a
second subtitle in a language that marks grammatical gender, time-align it to the source, inject each
request's own aligned lines into the translation prompt as a gender oracle, and after translation run a
fail-soft compare-and-repair pass: designated readers flag lines where Hebrew output disagrees with the
reference on addressee or (optionally) speaker gender, one batched repair request rewrites only those
lines under strict splice guards, then optional leak cleaners remove reference wording that copied through.
Gender Reference is **Off** by default; strength defaults to **Hard** for non-German helpers; German
helpers default to **Hint** unless the user confirms Hard for that run; Wizdom files and machine-translated
OpenSubtitles files never drive gender; automatic download uses OpenSubtitles only, tries languages in a
fixed quality order, and stops at a per-run cap. Experimental speaker, Method B and C1 layers live in
[`gender-extras.md`](gender-extras.md).

**Status:** current. **Evidence scope:** design and constants ported from Kodi add-on 0.2.533; offline
corpus checks and thousands of gate assertions (sections `R19 H.*`, `R19A A.*`, alignment `B.1`); a
September 2026 Kodi production A/B on German Hard wording (323 scored triples from a 495-cue packet —
figures from that run's analysis, not re-measured here); October 2026 packaged-app runs (39–52 UI
checks, a six-title finishing matrix with hand judgment); release acceptance on human-Hebrew and
Spanish-reference runs. Most matrix work used Stage-1 output
**without** the oracle in the prompt, so it stress-tests repair more than end-to-end prompt compliance.

**How to read this file.** Section 1 is what the code does today. Section 2 is SRT AI Translator 1.1.0. Section 3 is the
timeline. Sections 4–11 are tests and analysis in order. Section 12 holds the decisions. Section 13 is
build checks versus live runs. Sections 14–16 are limits, recommendations, the code map and label index.

Related records: download mechanics and caps
[`reference-subtitle-download.md`](reference-subtitle-download.md); alignment profiles
[`subtitle-alignment.md`](subtitle-alignment.md); stray-script repair before gender
[`wrong-alphabet-repair.md`](wrong-alphabet-repair.md); batch context
[`cross-batch-context.md`](cross-batch-context.md).

---

## Models used in testing

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Earlier research harness, "46% → 69%" (4) | Translations from `gemini-3.5-flash` (as named in its results file); judged by a Flash model whose exact id was not recorded | Not recorded | A research harness scoring speaker and addressee gender; not NG code | Not recorded | Gap lines from the harness corpus | Before NG |
| German helper A/B inside the Kodi add-on (8) | `gemini-3.5-flash-lite` | **Medium** | Hard German reference wording | Not recorded | 323 scored triples from a 495-cue packet | Sep 14–15 |
| Blind semantic review of that A/B (8) | Two model reviewers; model ids not recorded | Not recorded | Blind, scored without the video | — | 60 lines | Sep 15 |
| UI smoke (9.1) and Speaker A/B on identical bytes (9.2) | `gemini-3.5-flash-lite` | Low | Batch 300; reference off, disk file, automatic, Speaker on | Free, then Paid | One 471-cue episode, 4 cases plus the A/B | Oct 16 |
| Six-title finishing matrix (9.3) | `gemini-3.5-flash-lite` | Low | First pass without reference, then each finishing layer | Free, then Paid | 10 first-pass jobs plus the layer matrix | Oct 16 |
| Matrix re-measure after the Round 19A fixes (9.3) | `gemini-3.5-flash-lite` | Low | Same 11 first-pass files | Free, then Paid | 11 files | Oct 17 |
| Release acceptance (9.4) | `gemini-3.5-flash-lite` | Low | Full translations with the gender layers each case named | Free first, Paid fallback on | 3 cases (T-24, T-28, T-29) | Oct 18 |

**Would a different model change the results?** Yes, for every **quality** result. How well a model
**follows a gender reference** placed in its prompt, and how accurately it repairs the lines it is
asked to fix, are model behaviour. All live NG evidence is `gemini-3.5-flash-lite` at Low. The German
conclusion was measured at **Medium** thinking on the same model, so it does not even transfer to Low
without re-measuring. A stronger model might use the reference better, or might need it less; neither
was measured. The repair request's occasional malformed JSON was also seen on this model. The
**alignment gate, the readers and the guards** (sections 5 to 7) are offline code checked against a
corpus, and do not depend on the model.

## 1. What the app does today

### 1.1 When the feature appears

The **Gender Reference** panel on Translate renders only when the target language is Hebrew
(`referenceUiShown`). TMDB cast gender in the description block and optional audio gender rules in the
prompt are unchanged and still apply when no reference is used.

### 1.2 Modes and defaults

| Control | Default | Notes |
|---|---|---|
| Gender Reference mode | **Off** | Off means no reference file, no walk, no oracle block, no reference-driven repair |
| Strength (Hard / Hint) | **Hard** | German reference uses **Hint** unless "Use Hard wording for German this run" is ticked |
| Hard-German confirmation | **Off** | Resets after Start and when a new reference file is chosen |
| **This is human Hebrew** | **Off** | Shown only for a disk file detected as Hebrew; required for a Hebrew disk file to be gender-eligible |
| Prefer language (automatic mode) | empty | Optional first language in the walk |
| Downloads this run | **10** | Frozen with allowance at first download; minimum 1 |
| OpenSubtitles source (Settings) | **On** | Required for automatic mode |
| Wizdom source (Settings) | **Off** | Wizdom picks may fill the file field but are **never** gender-eligible |

Start refuses with a plain sentence (button not greyed) when mode is **Choose a file** without a file,
**Download automatically** without OpenSubtitles, without a TMDB title carrying an IMDb id, without TV
season/episode when needed, or with an invalid download limit. **Download automatically** is greyed in the
menu until a usable TMDB title exists; missing API keys do not grey automatic download (shared pool).

Gender reference arguments are frozen in `genderReferenceArgs` at Start together with the rest of the run.

### 1.3 Reference resolution and alignment

Once per run, when `genderReference` is set and the target is Hebrew:

1. The reference file is read (disk, staged OpenSubtitles/Wizdom pick, or automatic walk — see the download
   record).
2. Dialogue cues are aligned with profile **`oracle`**: scale in **0.90–1.11**, vote **≥ 0.65**, overlap
   **≥ 0.65**, at least **8** dialogue cues per side, offset search ±10 minutes, per-cue pairing within
   **250 ms**, histogram sampled on at most **500** cues.
3. Failure or low confidence → **fail-soft**: translation runs without section (3); no error stop.
4. Eligible helpers get a frozen map `source cue index → reference line` and metadata for the log.

**Hint eligibility (H19a)** — first-pass oracle and base repair:

| Provenance | Used for gender when |
|---|---|
| OpenSubtitles | Language is Hebrew, Arabic, or a `_GENDER_SIGNALS` language; `_is_mt` is explicitly **false** |
| Disk | Hebrew only if **This is human Hebrew** is on; Arabic or `_GENDER_SIGNALS` language without the box |
| Wizdom | **Never** |

**Speaker repair** additionally requires a hint-eligible helper whose language is Hebrew.

Machine-translated Hebrew from OpenSubtitles is excluded because it tends toward masculine defaults;
correcting from it would harm output.

### 1.4 Oracle in the prompt (H-G)

The aligned map is resolved **once** per run. Every translation request — main batches, recovery-tree
children, and resends — passes the same map into `translationRequest`; `oracleBlock` keeps only entries
for **that request's cues**. If no row survives (blanks, Arabic lines with explicit gender markers skipped,
unsupported language pair), the request is **byte-identical** to a run without an oracle (H14).

Section order in the assembled request:

1. Core translation rules  
2. TMDB / description (unchanged)  
3. **Gender oracle block** (this feature), when present  
4. Audio gender rules, when the audio file is set  
5. Batch payload  

Strength **Hard** sends the Kodi verbatim Hebrew-target blocks (Arabic reference → dedicated Arabic block;
Hebrew reference → dedicated Hebrew block; others → generic block + `_GENDER_SIGNALS`). **Hint** replaces
only the hard constraint title and "you MUST" with preference wording. German uses Hint unless Hard is
confirmed for that run (`effectiveStrength`).

### 1.5 Finishing pipeline (Hebrew target)

After all batches commit:

1. **Other-alphabet repair** (Round 19A) on every Hebrew run when needed — see
   [`wrong-alphabet-repair.md`](wrong-alphabet-repair.md). Gender readers see its output.
2. **Gender finish** when there was an eligible reference **or** a C1 source-caller switch is on:
   - **Compare** helper reading vs Hebrew output on addressee (Kodi addressee reader) and, if Feature 17
     Speaker is on, speaker (`speakerGender` on output vs helper for Hebrew helpers only).
   - **Flag** opposite readings; no voting between readers on one axis.
   - **Repair:** one batched request by default; if Speaker is on and any flag includes speaker, **two**
     requests — addressee-only cues first, then speaker cues (Round 19A A.5).
   - **Method B** (optional): one blind classification, then one repair — [`gender-extras.md`](gender-extras.md).
   - **Leak cleaner:** strip leaked ALL-CAPS speaker prefixes from Hebrew lines when a reference was used
     (source-anchored; English chyrons like `WARNING:` survive).
3. Kept source-language lines are never flagged, repaired or cleaned.
4. Any repair failure, refusal, or guard rejection leaves **all** cues as the previous step left them.
5. Final file must match source **count, order, indices and timecodes** (`sameShape`).

Repair uses addressee prompt text from Kodi `translate.py` (0.2.533) or a per-axis prompt when speaker
corrections are included; evidence JSON is capped at **24 000** characters (Python `len(json.dumps(...))`);
each cue, reference line, or neighbour over **2 000** characters is omitted from the ask, not truncated.
Accepted splices require SequenceMatcher ratio **≥ 0.60**, invariant negation/number tokens, Hebrew script
checks, mixed-gender rejection, stray-letter rejection, and **put-back** of gender flips on axes the cue
did not request (Round 19A A.4).

### 1.6 Automatic walk (summary)

At Start in automatic mode: one OpenSubtitles search for the title, languages in
`REF_CHAIN_WITH_DE` order (Hebrew, Arabic, Hindi, Spanish, Russian, Portuguese, …, German, …), up to
**5** downloads per language until **`perRunLimit`** total attempts, skipping AI/MT-flagged or unknown-MT
files, **skipping German** unless Prefer language is German. First file that aligns and passes eligibility
wins; metadata-only attempt lines go to the run log (H-log-1). Details:
[`reference-subtitle-download.md`](reference-subtitle-download.md).

---

## 2. What SRT AI Translator 1.1.0 did

- **No second subtitle control** on Translate: no manual gender-reference picker, no automatic download, no
  compare-and-repair pass in the desktop app (documented parity gap H-P6).
- **TMDB cast** still sent genders in the `--description` string; **optional audio** still forwarded for
  GST's "grammatical gender from audio" rules. NG keeps both (principle: third input, not a replacement).
- The **Kodi add-on** (0.2.533) already implemented align-one, prompt gender blocks, `_regender_*` repair,
  and leak cleaners; that behaviour is what NG ported into TypeScript rather than a new design.

---

## 3. Timeline

| When (2026) | What | Outcome |
|---|---|---|
| Sep 8–10 | Fork decision: native TypeScript engine includes gender oracle (no Python seam) | Native engine record D2 |
| Sep 10 | Design of the manual picker, automatic walk, prompt and repair port settled | Built later (Round 19) |
| Sep 11–15 | Reader split: addressee = Kodi `addresses_*`; speaker = corrected `heb_gender` slot; no OR-merge | H18, H19b |
| Sep 13–14 | Wizdom hosts unmarked MT Hebrew → default off; auto walk OpenSubtitles explicit-human only | Wizdom policy |
| Sep 14–15 | German Hard production A/B on addon | No net benefit → Hint default, auto walk skips `de` |
| Sep 15 | Independent review: the feature is not Hebrew-only on the reference side (disk Arabic and gender-signal languages allowed; the human-Hebrew box applies to Hebrew files only) | E54 |
| Oct 6 | Engine comparison exposed Arabic letters in Hebrew model output, with no oracle involved | Decision to port the add-on's repair for Hebrew targets ([`wrong-alphabet-repair.md`](wrong-alphabet-repair.md)) |
| Oct 10–11 | Round 11 (committed Oct 11, `87c56ad`): the leak repair | Unconditional leak repair on own AI Hebrew output |
| Oct 16–17 | Round 19 authored: Bundle H + Feature 17 shell; gate suite **4087** assertions green after fixes | Round 19 receipts |
| Oct 16 | Live matrix: 6 titles × layers; JSON repair parser fix | Base repair 19/19 judged correct on matrix |
| Oct 17 | Round 19A: direction marks, speaker clause, mixed-gender guard, axis split repair, put-back | Focused gates **219+** pass |
| Oct 18+ | Release acceptance: human Hebrew file, Spanish reference, Speaker/Method B spot runs | Release tests T-24, T-28, T-29 |

---

## 4. Prior quality evidence (before NG code)

Two headline numbers measure **different things**; neither alone defines the feature.

| Metric | Setup | Result | Role |
|---|---|---|---|
| Addon field (cast vs Arabic oracle) | Kodi add-on maintainer field notes (**not re-measured** in NG) | **27% → 90%+** gender agreement | Motivates per-line oracle vs cast-only |
| Harness (Flash judge) | English source, gap lines only where English is gender-silent and baseline disagreed with human Hebrew gold (earlier research; **not re-measured** in NG) | **46% → 69%** | More conservative controlled estimate |
| `he` vs `ar` reference rank | Harness fixed Hebrew and Arabic at positions 1–2 | **Not measured** which is best; chain ranks from position 3 | Arabic standing rests on field figure |

The harness **scores** lines; it does not ship as the repair pipeline. Production repair follows Kodi
`_regender_blocks` guards, ported as `genderRepair.ts`.

---

## 5. Alignment gate (oracle profile)

**Source:** Kodi `align_one` constants, captured into gates `B.1` with byte-identical fixture receipts.

| Constant | Value | Role |
|---|---|---|
| `minDialogueCues` | 8 | Either side shorter → no map |
| `voteMin` / `overlapMin` | 0.65 | Random pairing ≈ **0.30** vote; gap motivates trust |
| `scaleMin` / `scaleMax` | 0.90–1.11 | Frame-rate ratios only |
| `_MAXOFF` | 600 000 ms | ±10 min search |
| `_TIGHT` | 250 ms | Per-cue gender pairing |
| `_SAMPLE` | 500 cues max | Vote normalised to sample, not full file |

**Conclusion:** The 0.65 floor is deliberate (addon author: tightening toward 0.80 rejected useful maps).
Partial maps still hint most entries. Independent Align uses **0.55** floors for user-facing alignment;
the oracle profile never calls ALASS or piecewise mode (registry-13 fence).

**Tests:** Gate `B.1` runs **`oracleFixtures()`** through `alignSubtitles('oracle', …)` with frozen
`ORACLE_PROFILE` (`electron/engine/align.ts:56-62`); boundary asserts at 0.6499 fail and 0.65 pass.

---

## 6. Reader design and eligibility

### 6.1 Two readers, no voting

| Axis | Reader on Hebrew output / helper | Source |
|---|---|---|
| Addressee | `addressesFemale` / `addressesMale` → `hebrewAddressee` | Ported addressee reader from Kodi `arabic_gender.py` (`addresses_female` / `addresses_male`, H18) |
| Speaker | `speakerGender` → first slot only | Research `heb_gender` with `מנסה` removed from present lists and dual-anchor mute when a confirmed 2nd-person pronoun coexists with `אני` (H19b) |

Do **not** use `heb_gender` slot 1 for addressee; do **not** OR readers on one axis.

Arabic helper addressee uses consonantal patterns where diacritics are absent (OpenSubtitles reality).
Spanish/Portuguese helper addressee optionally uses C1 rules when those switches are on
([`gender-extras.md`](gender-extras.md)).

### 6.2 Gate counts (Round 19 H.1 receipt)

Offline fixtures in the check suite covered, among others: addressee-female **419**, addressee-male **866**,
speaker **122**, C1 **14**, Arabic/other addressee paths **277** — both genders and abstain cases.

### 6.3 Round 19A — invisible direction marks (A.1)

**Setup:** Counted direction marks in **19** human Hebrew reference files; **3** files had marks on
**746–887** cues each. Ran addressee and speaker readers with and without stripping.

**Results:** Without stripping, line-leading `את` after U+202B was missed by `HE_FEM_CLAUSE`'s `^`
anchor — **15** addressee readings changed (all null → F) across three files; **0** speaker changes.

**Fix:** `visible()` strips U+200E/F, U+202A–E, U+2066–9, U+061C, U+FEFF before every public reader.

**Conclusion:** Human files from real workflows carry bidi controls; readers must not treat them as text.

### 6.4 Round 19A — speaker clause (A.2)

**Setup:** Compared old vs new `speakerGender` on **26 736** cues (19 reference files + 11 Stage-1
outputs), three iterations, hand judgment on diffs.

**Results (final iteration):**

| | Count |
|---|---:|
| Readings changed | 116 |
| M↔F flips | 0 |
| Judged-correct speaker readings lost | **0** |
| Lines that lost a reading but were wrong or ambiguous | ~80 (third-person verb after `אני`, quoted speech, stage directions, two-speaker cues) |

**Conclusion:** Present-tense verbs after `אני` must not vote speaker when they belong to another
clause; copula and pronoun-dropped forms were added iteratively until no good reading was lost.

---

## 7. Repair guards and leak cleaners

### 7.1 Ported guards (H1–H26)

Key limits from Kodi 0.2.533, enforced in gates `R19 H.2`:

- Duplicate cue indices in one reply → both kept original.
- Reply index/time always from **source** block, never model.
- Similarity ≥ **0.60**, ordered invariant tokens for negation and numbers.
- Empty reply, wrong line count, or still-wrong gender → keep original.
- Oracle-off request must match no-oracle fixture (H14).

### 7.2 Round 19A repair hardening

| Issue found (live matrix) | Fix | Gate |
|---|---|---|
| Model returns JSON-shaped repair bodies | Parse fenced JSON; accept only whole SRT entry strings; guards unchanged | H.2 +2 asserts |
| `אתה` + feminine verb accepted | `mixedAddress` reader + `mixedGender` splice rejection | A.3 |
| Foreign letter or extra `\` accepted | `strayLetters`; splice `\"` → `"` when old had no backslash | A.3 |
| Model flips axis not requested | `putBackUnrequested` after empty check | A.4 |
| Speaker crowds out addressee in one 24k bucket | Split into two requests by axis when Speaker on | A.5 |

**Corpus:** `mixedAddress` fired on **2** cues in **26 736** (one human typo `את יודע`, one model
`אתה יודעת`).

### 7.3 Arabic leak and speaker-prefix cleaners (H27–H36)

**Arabic letters.** On Hebrew model output **without** any reference in the prompt, **55–71** of **7 760**
cues per run still carried Arabic letters, so the leak is a model property rather than something the
reference causes. The add-on's `strip_leaked_arabic` was therefore not tied to this feature: it ships as
the Save-time wrong-alphabet repair on **every** Hebrew target
([`wrong-alphabet-repair.md`](wrong-alphabet-repair.md)), and gender finishing deliberately does **not**
run it a second time (H27–H32, H31).

**Speaker names (H33–H36).** When a reference was used, gender finishing removes an ALL-CAPS Latin
`NAME:` prefix that the reference leaked into a Hebrew line (`stripLeakedSpeakerTags`, `run.ts`). It is
anchored to the source: a label that is also in the source line stays, and English chyrons such as
`WARNING:` and URLs are unchanged.

---

## 8. German helper wording (September 2026 A/B)

**Setup:** The Kodi add-on's **German Hard** prompt wording against a no-reference baseline, scored on
**323** triples (source, baseline output, German-reference output) from a **495-cue** packet (six
drama-series episodes, English source to Hebrew). The run is partial (323 of 495), not a holdout (it
reproduced hard and gap cases from an earlier 11-title set), Hard strength only, and scored by
morphology plus blind model review, not against the video. The request bodies were reconstructed from
the saved prompts rather than captured at transport. The figures below come from that run's analysis;
they were **not re-run** for this record.

**Morphology results.** Each pair is **fixes / breaks** (lines where the German reference made the
gender right that the baseline had wrong, against lines it made wrong that the baseline had right). They
are counts, not fractions.

| Axis | Fixes / breaks | Net lines | Net as reported |
|---|---|---|---|
| Speaker | 24 / 25 | −1 | −0.60 pp |
| Addressee | 30 / 29 | +1 | +0.48 pp |
| All axes | 46 / 44 | +2 | +0.62 pp |

**How the percentage points relate to the counts.** The "as reported" column is copied from the run's
analysis, whose per-axis denominators were not preserved with it. They are consistent with each axis
being measured only over the lines where it applies: +2 over all **323** triples is +0.62 pp, and the
speaker and addressee figures imply about **167** and **208** applicable lines (−1/167 ≈ −0.60 pp,
+1/208 ≈ +0.48 pp). Those two denominators are inferred, not recorded. Dividing by 323 instead would give
about ∓0.31 pp. Either way the net is one or two lines, and the **fixes / breaks counts are the primary
result**.

p = 0.916, and the bootstrap confidence interval crosses zero on every axis.

**Blind semantic review.** Of **60** sampled lines, the reviewers agreed exactly on **45**: baseline
better **10**, German better **5**, tie **17**, uncertain **13**. The other **15** had no exact agreement.
One line was a joint severe **regression** with German. Two lines were jointly labelled German
improvements, but after unblinding one had invented a quantity and the other had restored an
interrupted sentence: wording changes, not gender wins. One genuine joint **addressee-axis** improvement
with German was found.

**Generation noise.** Identical request bodies produced different outputs on repeat, so a net
difference of one or two lines can be ordinary variation.

**Conclusion:** **Hard German failed to establish a reliable net benefit**, and left unresolved safety
cases. That is not the same as "every result favoured the baseline": the addressee axis and one
reviewed line went German's way. Shipping behaviour: `_GENDER_SIGNALS['de']`
exists; auto walk **skips** German unless Prefer is `de`; UI defaults German to **Hint** and requires
per-run Hard confirmation (resets on new file and after Start).

---

## 9. Live packaged runs (October 2026)

### 9.1 UI smoke (Round 19 H.13)

**Setup:** Fresh profile, packaged Windows build, Gemini 3.5 Flash-Lite Low, batch 300, one comedy-drama
episode (**471** cues) English → Hebrew.

| Case | Outcome |
|---|---|
| Reference Off | **0.9 min**; no gender log lines |
| Disk human Hebrew + box ticked | **461/471** aligned; **1** line corrected |
| Automatic, no user OS key | **1** pool download; **461/471** aligned |
| Speaker ON | Layer log `requested 0 … skipped: no_evidence` on this title |

**39** UI checks passed (later **52** after download UX fixes).

### 9.2 Speaker A/B on identical bytes

Speaker OFF vs ON on same Stage-1 output + human Hebrew reference: OFF **0** flags; ON **4** speaker
corrections, all judged correct (masculine first person where reference speaker is masculine). Shape
unchanged.

### 9.3 Six-title finishing matrix (October 2026 addendum)

**Setup:** **10** Stage-1 runs (six titles, some in Spanish/Portuguese source) **without** oracle in prompt;
then production `genderFinish` with human Hebrew or es/pt references; hand judgment at same timecodes.

**Results (accepted changes judged):**

| Layer | Accepted | Correct | Wrong | Unclear |
|---|---:|---:|---:|---:|
| Base addressee repair | 19 | 19 | 0 | 0 |
| Speaker (6 titles) | 50 | 48 | 1 | 1 |
| Method B alone | 20 | 19 | 1 | 0 |
| C1 alone | 0 | — | — | — |
| C1 + Method B | 3 | 3 | 0 | 0 |

**Analysis:** Stage-1 without oracle **overstates** flag rate vs production. C1 marks few lines and Hebrew
reader ignores `את + adjective` contradictions by design — Method B reached those three cases. Before fix,
**3 of ~22** repair replies lost to JSON shape; a mystery-comedy series, episode **G1**, lost **14** speaker
fixes in one arm.

**Re-measured after the Round 19A fixes** (same six titles, 11 Stage-1 files, the same arms through
`genderFinish`, every changed line judged by hand against the human Hebrew; each arm run once, so a
difference between arms can be model variation rather than the layer):

| Layer | Changes | Correct | Wrong | Unclear | Round 19 figure |
|---|---:|---:|---:|---:|---|
| Base addressee repair | 42 | 41 | 1 | 0 | 19 / 19 / 0 / 0 |
| Speaker arm (lines differing from base) | 67 | 66 | 0 | 1 | 50 / 48 / 1 / 1 |
| Method B arm (lines differing from base) | 28 | 25 | 0 | 1 | 20 / 19 / 1 / 0 |
| Speaker + Method B arm (lines differing from base) | 92 | 87 | 2 | 3 | 29 / 26 / 2 / 1 |
| C1 alone | 4 | 4 | 0 | 0 | 0 |
| C1 + Method B | 4 | 4 | 0 | 0 | 3 / 3 / 0 / 0 |

Two Method B arm lines were neither right nor wrong: a space added after a full stop, and a base fix that
the arm's own base request did not repeat. Every arm kept the file's shape (count, order, numbers and
times).

**Conclusion:** JSON repair parsing was mandatory for Flash-Lite. Base addressee repair was strong on
this sample, and the Round 19A splitting of requests by axis let it make more than twice as many correct
fixes. C1 now works on its own, so it was not greyed out. Speaker and Method B stay **default OFF** with
the tooltip "Recommended: keep OFF" (reasons in [`gender-extras.md`](gender-extras.md)).

### 9.4 Release acceptance (spot checks)

| Test | Result |
|---|---|
| Human Hebrew file Hard | Completed; log: aligned count + **2** corrected (T-24) |
| Speaker + Method B, human Hebrew | **25** flagged, **18** corrected; two-speaker skip logged (T-28) |
| Spanish reference Hard + C1 | **1** corrected; C1 layer counts in log (T-29) |

---

## 10. Feature 17 boundary (pointer)

Speaker repair, blind Method B, and Spanish/Portuguese C1 are **separate default-OFF switches** frozen at
Start; they gate only their layer on Hebrew targets. Measurement that justified tooltips and defaults:
[`gender-extras.md`](gender-extras.md). This file covers the **core** reference + base addressee repair only.

---

## 11. Open findings at Round 19 close (addressed in 19A where noted)

| Finding | Status |
|---|---|
| Speaker single bucket drops late addressee fixes | **Mitigated** A.5 axis split when Speaker on |
| Unrequested-axis edits accepted | **Fixed** A.4 put-back |
| `אתה`+feminine verb passes | **Fixed** A.3 |
| Speaker reader reads third-person after `אני` | **Fixed** A.2 |
| Stray letters pass | **Fixed** A.3 |
| C1 alone changes nothing without Method B | **Fixed** A.6: the Hebrew pronoun now reads C1 lines; 4 of 4 correct after the fix |
| Thai glued to Hebrew in Stage-1 | Wrong-alphabet pass (A.7), separate record |

---

## 12. Decisions and why

### 12.1 Core defaults

| Decision | Why | Alternatives rejected |
|---|---|---|
| Gender Reference **Off** by default | Opt-in cost (download, alignment, extra API repair); unmeasured for most users | ON by default |
| UI only for **Hebrew target** | Repair reads Hebrew morphology; other targets get hint assembly in code only until exposed | Hide module entirely (withdrawn — H22 tests assembly) |
| **Hard** default strength | Matches validated Kodi Hebrew/Arabic paths | Hint default for Hebrew |
| **Hint** default for **German** | Production A/B showed no net Hard benefit | Hard German in auto walk (E47 skip) |
| **This is human Hebrew** required for disk Hebrew | MT Hebrew defaults masculine | Trust any Hebrew file |
| Wizdom **never** gender-eligible | Unmarked AI Hebrew on service | Optional gender from Wizdom |
| OS **explicit human** only in auto walk | `_is_mt` true or missing skipped | Walk Wizdom first |
| Fail-soft align | Bad reference must not block translation | Hard error on low vote |
| Oracle profile **0.65/0.65** | Field + addon author intent | 0.80 floor |
| **H-G:** per-request oracle slice | Recovery children must not carry neighbour lines | Whole-file oracle every request |
| Kept lines excluded | Source text must not be rewritten | Repair kept cues |
| Two repair requests when Speaker on | 24k/ordering crowding on a flag-heavy romance drama, episode **B2** | Larger limit only |
| JSON repair parsing | Flash-Lite returns JSON bodies | Prompt change only |

### 12.2 What would reopen a decision

- Measured **net harm or benefit** from Hard German on a holdout set with human video judgment.
- Evidence that **0.65** alignment gate systematically accepts wrong-title maps on NG's download corpus.
- A target language other than Hebrew with a shipped **output** reader and repair prompt.
- Live rate of repair **data-loss** (wrong index/time) above zero — would trigger guard review, not loosen guards.

---

## 13. Build checks and live runs

| Claim | Proven by checks | Seen live |
|---|---|---|
| Oracle constants = Kodi align_one | `B.1`, frozen `ORACLE_PROFILE` | Indirectly via aligned counts in logs |
| Per-request oracle slicing | `R19 H.7`, `R19 H.11` (H-G1–G4) | Not isolated in live log |
| Eligibility rules | `R19 H.1`, H19a fixtures | MT skip, Wizdom note in UI |
| Repair guards | `R19 H.2`, H1–H26 fixtures | Matrix + T-24/T-28 |
| JSON repair fallback | H.2 post-19A asserts | Rerun after fix (3/13 JSON replies used) |
| Direction marks | `R19A A.1` | Not separately logged live |
| Axis-split repair | `R19A A.5` | Not A/B measured live after fix |
| Leak cleaners | `R19 H.3`, Round 11 gates | Not counted live per run |
| Automatic walk order/caps | `R19 H.10` | 1 download case in UI test |
| Off mode sends no gender work | `R19 H.11`, F17 OFF | 0.9 min run, no gender lines |

The whole suite passed with no failures at each round boundary (4,087 assertions at the end of Round 19;
4,180 at the final release check). Occasional temporary-folder contention in unrelated checkpoint tests
was recorded and passed on re-run; it was not product logic.

---

## 14. Limits

- **Language pair:** Quality evidence is overwhelmingly **English (and some es/pt) → Hebrew** with Gemini
  Flash-Lite / Flash family; other pairs are not measured here.
- **Matrix bias:** Finishing tests often omitted oracle-in-prompt on Stage-1; production flag rates may be
  lower.
- **Arabic vocalization:** Consonantal Arabic reader helps but cannot match diacritic-perfect addon lab
  conditions.
- **Single repair request cap:** Heavy titles may still truncate evidence within 24k even with axis split.
- **Reference quality:** Garbage alignment fail-softs to unhinted run — silent quality loss, not a crash.
- **German, Hint path:** Explicitly **experimental / unmeasured** benefit.

---

## 15. Recommendations

- Keep **Off** default until the user opts in; keep German on **Hint** until new holdout evidence says
  otherwise.
- For manual Hebrew files, treat **This is human Hebrew** as a serious attestation — wrong tick hurts output.
- Prefer **human OpenSubtitles** or known-good disk references over Wizdom for gender.
- If Speaker or Method B is enabled, read [`gender-extras.md`](gender-extras.md) tooltips and expect extra
  API calls.
- When comparing to SRT AI Translator 1.1.0, remember NG **adds** reference + repair; cast and audio gender paths remain.

---

## 16. Code and checks

| What | Where | Checks ( `scripts/gates/gates.ts` ) |
|---|---|---|
| Draft, defaults, Start refusals | `electron/shared/genderReference.ts` | `R19 H.9`, `R19 H.12` |
| Translate panel | `src/components/GenderReferencePanel.tsx`, `src/pages/TranslatePage.tsx` | `R19 H.9`, `R19 T3` |
| Oracle profile align | `electron/engine/align.ts` | `B.1`, `B.2` (oracle unchanged) |
| Prompt block + slice | `electron/engine/prompt.ts` | `R19 H.7` |
| Run: resolve reference, H-G inject | `electron/engine/run.ts`, `native/nativeAdapter.ts` | `R19 H.11` |
| Readers + eligibility | `electron/engine/genderReaders.ts` | `R19 H.1`, `R19A A.1–A.2`, `R19A A.6` |
| Repair + Method B classify | `electron/engine/genderRepair.ts` | `R19 H.2`, `R19A A.3–A.5`, `R19 F17.3` |
| Leak cleaners | `electron/engine/srt.ts` | `R19 H.3` |
| Finishing orchestration | `run.ts` `genderFinish`, `genderRepairRequest` | `R19 H.11`, `R19A A.7` (stray before gender) |
| Settings defaults | `electron/main/store.ts` | `R19 F17.0`, `R19 H.8` |
| Automatic walk | `electron/engine/referenceWalk.ts` (and OS client) | `R19 H.10`, `R19 H.5` |

Feature-17-only UI copy and snapshots: `R19 F17.1`, `R19 F17.2`.

---

## 17. Label index

| Label | Meaning | Section |
|---|---|---|
| H-G, H-G1–G4 | Oracle map travels per request; recovery uses same slice | 1.4 |
| H14 | Oracle-off prompt parity | 1.4, 7.1 |
| H17–H20 | Designated readers; no voting | 6.1 |
| H18 | Hebrew addressee reader (Kodi `addresses_*`) | 6.1 |
| H19a | Helper hint/speaker eligibility | 1.3 |
| H19b | Speaker reader + dual-anchor mute | 6.1 |
| H22 | Non-Hebrew-target hint assembly (gate only until UI exposes) | 2, 12.1 |
| H23–H26 | Similarity, invariants, char limits, skip long cues | 1.5, 7.1 |
| H27–H32 | Arabic leak cleaning: satisfied by the Save-time wrong-alphabet repair, not repeated here (H31) | 7.3 |
| H33–H36 | Speaker-prefix leak cleaner | 7.3 |
| H-log-1 | Metadata-only walk attempt log | 1.6 |
| W-de-4, W-de-5 | German Hard confirm + `_GENDER_SIGNALS['de']` | 1.2, 8 |
| E47 | Auto walk skips German unless prefer | 1.6, 8 |
| E48–E53 | German A/B evidence; no Hard default | 8 |
| E54 | Feature not Hebrew-only; box is Hebrew-disk fail-safe | 1.2 |
| P7 | First shipping UI: Hebrew target only | 1.1 |
| §2.3 | Alignment gate constants (Kodi port) | 5 |
| §2.5f | Round 19A measurement items (code label) | 6.3–6.4, 11 |
| §17.9a | Bundle H gate bundle id (code label) | 16 |
| D19A-1 | Two repair requests when Speaker on | 1.5, 11 |
| D19A-2 | C1 unread → pronoun-only read | 16 |
| D19A-3 | Stray alphabet before gender | 1.5 |
| F17 | Advanced Hebrew switches (see extras record) | 10 |
| R19A-01 | Masculine `ת…י` not treated as feminine future | 7.2 |
| R19A-02 | Requested pronoun flip not put back | 7.2 |
