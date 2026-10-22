# Wrong-alphabet repair for Hebrew translation output

**Decision in one paragraph.** Gemini sometimes mixes letters from the wrong script into Hebrew lines
(Arabic look-alikes inside Hebrew words, occasional Cyrillic or Greek fragments, and less often Thai,
Chinese, Devanagari, Korean or Telugu glued to Hebrew). Both the native engine and gst produce it
(section 5), and 1.1.0 never detected it. For a **Hebrew target only**, the app uses two layers that do
not overlap: at **Save**, a pure table repair (ported from the Kodi add-on) removes or transliterates
**Arabic** and short **Cyrillic, Greek or Armenian** runs glued to Hebrew, without touching the engine
temp; on **every Hebrew run**, before gender finishing, one guarded **model redo** fixes **other**
scripts the table cannot map. Neither layer has a user switch. Non-Hebrew targets are unchanged
(byte-identical to a copy without repair). Latin letters fused inside a Hebrew word are out of scope.

**Status:** current. **Evidence scope:** English to Hebrew on Gemini 3.5 Flash-Lite at Low thinking
unless noted; counts from whole-file scans of 33 comparison outputs (7,760 cues per arm), a 914-line
context-campaign audit, add-on parity over 174,439 cues, automated gates, packaged Save smoke, and
eleven Stage-1 finishing replays with live Gemini for the other-alphabet step.

**How to read this file.** Section 1 is what the code does today. Section 2 is 1.1.0. Section 3 is the
timeline. Sections 4–8 are discovery and tests in order. Section 9 is the decision record. Section 10 is
build checks and live runs. Sections 11–14 are limits, recommendations, the code map and label index.
Cross-batch context, the native engine comparison, gender extras and RTL formatting are linked only.

Test material is described by type or by the short episode labels used in
[`native-translation-engine.md`](native-translation-engine.md) (A1, A2, B, C, D, E1, E2, F, G1, G2, H).
No film or series titles and no subtitle text from private copies appear here.

---

## 1. What the app does today

### 1.1 Two layers, one target language

| Layer | When | Where in the pipeline | Scripts handled |
|---|---|---|---|
| **Table repair (Round 11)** | User **Save** (and the same recipe on a Hebrew-target export copy) | After gst's per-cue edge wrapper is stripped, **before** the RTL method (`ipc.ts` → `repairCueTexts` → `wrongAlphabet.ts`) | Arabic; Cyrillic, Greek, Armenian (glued runs only) |
| **Other-alphabet redo (Round 19A A.7)** | End of **every completed Hebrew translate run**, before gender finishing | `run.ts` → `repairStrayAlphabet` → one optional model request | Thai, CJK, Devanagari, Korean, Telugu, and other named scripts outside the allow-list (see section 1.3) |

Both apply only when the accepted run's target normalizes to Hebrew (`he`, `iw`, `he-IL`, and similar
via `normalizeRtlLanguage` / `referenceUiShown`). **There is no setting** for either layer: they are
always on for Hebrew and always off for every other target.

The **engine temp and promoted canonical text** are not passed through the Round 11 table repair during
translation. Batch context, resume, sanity scans and analysis inputs therefore still see what the model
returned, except that A.7 may rewrite specific cues before promotion when it accepts a guarded reply.

### 1.2 Table repair: behaviour (`wrongAlphabet.ts`)

Order matches the add-on: `stripLeakedArabic` then `foldForeignInHebrewWord`.

**Arabic step**

- Runs only on a **line that contains both Arabic and Hebrew** letters. A line with Arabic alone is
  left unchanged.
- **Glued** Arabic (at most eight letters, touching a Hebrew letter without a word boundary) is mapped
  through a fixed `AR2HE` consonant table; word-final Hebrew forms apply when the run ends a word.
- **Standalone** Arabic on a mixed line is removed (often replaced by a single space). Markup, HTML-like
  tags and quoted spans (`"…"`, `“…”`, `«…»`, `<!--…-->`) are skipped byte-for-byte via
  `mapUnprotected`.
- If cleaning would leave no Hebrew on the line, the **original line is kept**.

**Cyrillic / Greek / Armenian step**

- Only on lines that contain Hebrew.
- Only **glued** runs of at most **three** letters from the fold table; standalone foreign words are
  never changed.
- Same protected-span rules as the Arabic step.

**Latin letters inside a Hebrew word** are explicitly **not** repaired (the add-on has no rule for them;
extending that would be new design).

The module is **pure** (no imports, no settings, no I/O). Any internal failure returns the input
unchanged.

**Save adapter**

- `repairCueTexts` maps cue text only; if a repair would change a cue's **line count**, that cue is kept
  unchanged.
- Counts of lines changed by each step are aggregated; when either count is non-zero, one line is appended
  to the **saved copy** of the run console log (the temp log is not modified).
- The repair does **not** depend on **RTL subtitle formatting** (`rtlEnabled`, default ON): Off still
  applies the table repair on Hebrew targets.

**Non-Hebrew targets**

- `saveRecipeFor` sets `hebrewTarget: false` unless the language is Hebrew. Yiddish (`yi`), Arabic,
  Persian, Urdu, Pashto, Russian, Greek, English, French, unknown and missing targets are gated
  **byte-identical** to saving without the repair, including fixtures that contain Hebrew and Arabic
  letters together.

### 1.3 Other-alphabet redo: behaviour (`strayAlphabet.ts`)

**Qualifies:** a translated cue (not kept in the source language) whose text has a Hebrew letter and at
least one letter whose script is **not** in the allow-list: Hebrew, Latin, Arabic, Cyrillic, Greek,
Armenian, Common, Inherited.

**Does not qualify:** lines without Hebrew; Latin-only foreign names; Arabic, Cyrillic, Greek or Armenian
slips (Round 11 handles those at Save, not here); cues where the **source subtitle's dominant stray
script** matches the letter in output (for example Thai source → Thai letters in output are treated as
intentional, not a slip).

**Request:** one prompt (`STRAY_ALPHABET_PROMPT`) listing every eligible cue, with source block, current
Hebrew, and source ±2 cues, subject to the same character caps as gender repair (2,000 per field, 24,000
JSON total). Built through `strayAlphabetRequest` in `prompt.ts`.

**Splice guards:** reply block must be Hebrew by `looksHebrew`, must not still contain a qualifying stray
letter, must keep the same number of non-empty text lines, must reach **sequence similarity ≥ 0.60**
(Python `difflib` ratio, `autojunk=False`), and must preserve ordered negation/number **invariant
tokens**. First acceptable block per cue wins; times and index stay the cue's own.

**Failure modes:** transport failure, refusal, or guard rejection leaves **every** cue as before. Log lines
report how many cues held stray letters, how many were corrected, and up to fifty cue numbers still
affected. When no cue qualifies, **nothing is sent** and the log stays silent.

Runs on **every** Hebrew target run, whether or not a gender reference was used and whether or not any
gender layer is enabled.

### 1.4 Interaction with gender finishing (H27–H32 / H31)

Bundle H's leak cleaners (**H27–H36**) must **not** import or re-run the Round 11 table repair. Gender
readers and repair see the output **after** A.7's redo. Arabic and Cyrillic handled at Save are **not**
sent through A.7, so the same fragment is not repaired twice in one run. A.7 explicitly excludes the
scripts Round 11 covers.

---

## 2. The starting point: what 1.1.0 did

- **No wrong-alphabet repair.** Slipped letters shipped in the saved file.
- **`scanTranslatedOutput`** (`outputSanity.ts`) warns on length ratio, line count and untranslated runs;
  it has **no target-script check** on translated Hebrew.
- The Kodi add-on (a separate public project) already repaired its **own** Gemini Hebrew output
  unconditionally (before RTL wrap), which became the design reference for Round 11.

---

## 3. Timeline

| When (2026) | What | Outcome |
|---|---|---|
| Sep 28 | Context campaign blind review; full accepted-output script audit (**E137**) | 914 mixed-script cue items; provisional context winner withdrawn ([`cross-batch-context.md`](cross-batch-context.md) section 5.4) |
| Sep–Oct | Context harness hard-stops on one-line wrong-alphabet leaves | Research-only table + one-line redo added to the harness; not the shipped translate path |
| Oct 6 | 11-episode native vs gst comparison (**Step 2.9**); whole-file letter scan | 55 / 71 / 64 Arabic cues per arm; Cyrillic/Greek/CJK/Hangul 9 / 5 / 7; Latin-in-word 9 / 7 / 4 ([`native-translation-engine.md`](native-translation-engine.md) section 6.2) |
| Oct 6 | Add-on `srt.py` run on the same 33 outputs | Arabic 55→0 native, 71→2 CLI, 64→0 CLI repeat; imperfect deletions and suffix spellings noted |
| Oct 6 | Maintainer directive | Port add-on repair for Hebrew target; prove no-op on other targets; built in Round 11 |
| Oct 10–11 | Round 11 D.4–D.6: `wrongAlphabet.ts`, Save wiring, gates, player matrix | 0 mismatches vs add-on on 174,439 cues; live Save fixed one Arabic line on real output |
| Oct 16–17 | Round 19 Stage-1 matrix | Thai/CJK/etc. glued fragments survived table repair (item 7) |
| Oct 17 | Round 19A **D19A-3 / A.7** | Automatic other-alphabet redo before gender step; 10/10 Stage-1 cues corrected in corpus replay |
| Oct 17+ | Release regression | Saved-copy repair note present on live saves in the acceptance log |

---

## 4. Discovery: context study audit (E137)

### 4.1 Setup

During the first blind review of the Feature 15 context campaign (English to Hebrew, Flash-Lite 3.5,
Low), the maintainer noticed **Arabic letters inside Hebrew lines**. A full scan of **every accepted
output line** from that campaign was run (not a sample).

### 4.2 Counts

| Script | Cue lines with wrong-script letters |
|---:|---:|
| Arabic | 792 |
| Cyrillic | 84 |
| CJK | 42 |
| Greek | 2 |
| **Total** | **914** |

Some lines carried more than one foreign script. Request captures showed **no Arabic in the prompts**;
the model generated the letters. The campaign validator had required **some** Hebrew in each line but did
**not** forbid other scripts, so these lines counted as accepted and downstream quality scores were
contaminated.

### 4.3 Analysis

This was a **gate design failure**, not a context-format failure: a check that passes the defect it exists
to catch is not a check ([`cross-batch-context.md`](cross-batch-context.md) section 5.4). The audit
**invalidated** the provisional “source-only 5” winner from the earlier context round.

### 4.4 What the research harness did next (not shipped defaults)

The campaign added a **stricter script gate** (reject Arabic, Persian, Latin, Cyrillic, Greek, CJK after
stripping supplied markup; retry/split recovery) and a **research-only** path: table mapping where the
add-on mapping is certain, plus **one targeted repair request** for remaining cases. Two harness runs
stopped when recursive split reached **single lines** that still returned the same wrong letters after
**53 requests** on one trial (Arabic glued to Hebrew; Korean and Cyrillic inside a transliterated name).
That proved **retry and split alone cannot fix every one-line leaf**.

The **product** translate path does not use the campaign's strict gate; it uses Round 11 at Save and A.7
at finishing instead.

---

## 5. Frequency: the Step 2.9 / native engine scan

Material: **11 English TV episodes** (labels A1, A2, B, C, D, E1, E2, F, G1, G2, H), **7,760 cues**
total, each translated **three ways**: native once, gst CLI once, gst CLI repeated (**33 outputs**).
Model: Gemini 3.5 Flash-Lite, Low. See [`native-translation-engine.md`](native-translation-engine.md)
sections 5–6.

### 5.1 Cues containing foreign letters (before any repair)

| Lines with… (of 7,760 per arm) | Native | Old engine (CLI) | Old engine again |
|---|---:|---:|---:|
| Arabic letters | 55 | 71 | 64 |
| Cyrillic, Greek, CJK or Hangul | 9 | 5 | 7 |
| A Latin letter fused inside a Hebrew word | 9 | 7 | 4 |

All three arms exhibited mixed-script defects, so the defect belongs to the model on this setting and
every engine needs the repair. Native had fewer Arabic-affected cues and more of the other two
categories than either CLI run. The CLI was run twice to show its own run-to-run variation, but with
one native run and two CLI runs the comparison does **not** establish that the engines are equivalent
or isolate an engine effect. (An earlier reading, "native inside the CLI's run-to-run spread on every
row", does not follow from these numbers: native is outside the two CLI values on every row.)

### 5.2 Add-on repair on the same outputs

The unmodified add-on `strip_leaked_arabic` + `fold_foreign_in_hebrew_word` was applied to every cue
(markers stripped first):

| Cues with… before → after | Native | CLI | CLI again |
|---|---|---|---|
| Arabic letters | 55 → **0** | 71 → **2** | 64 → **0** |
| Cyrillic/Greek/Armenian/CJK/Hangul | 10 → 4 | 5 → 3 | 7 → 5 |
| Latin inside a Hebrew word | 9 → 9 | 7 → 8 | 4 → 5 |

**0** cues lost Hebrew; **0** line-count changes. Residual foreign-script cues match cases the add-on
also leaves (no Hebrew on the line, unmapped letter, or whole Arabic lines kept by design). Known
imperfect outcomes: a **standalone Arabic word deleted** with its meaning lost, and occasional **wrong
suffix** when spelling Arabic glued to Hebrew (example class: Arabic feminine suffix mapped to the wrong
Hebrew letters).

### 5.3 Conclusion

Wrong-alphabet slips are a **model property**, not something the native engine introduced: they appear
on **every** engine and every run measured, at low rates (4 to 71 lines per category, out of 7,760), though
the per-category counts differ between engines and the sample cannot say whether either engine is
better. 1.1.0 does not detect them. A Hebrew-target repair is an **enhancement**, not
a parity requirement.

---

## 6. Round 11: table repair design and proof

### 6.1 Maintainer requirements

- Port the add-on's two functions **literally** for **Translate output with a Hebrew target**.
- Apply on the **disposable Save copy** only; canonical engine temp unchanged.
- Run **before** RTL wrap; **independent** of the RTL toggle.
- **Byte-identical** behaviour for all non-Hebrew targets exercised in gates (including `yi` and
  right-to-left languages that use Arabic script).
- Do **not** tie the repair to gender-reference injection (Step 2.9 showed Arabic leaks with **no**
  reference in the prompt).
- Log rewrite counts on the saved console log copy when anything changed.

### 6.2 Port parity

| Test | Count | Result |
|---|---:|---|
| Port vs unmodified add-on `srt.py`, all comparison outputs + RTL corpus | 174,439 cues | **0 mismatches** |
| Step 2.9 arms after port (same 33 outputs re-scanned) | 7,760 cues × 3 arms | Arabic native **55→0**; CLI **71→2**; CLI repeat **64→0**; line fixes logged per arm |

A first comparison had **14** mismatches from shared RegExp `lastIndex`; fixed with non-global tests and
reset before each scan.

### 6.3 Alternatives considered for Arabic / Cyrillic class

| Option | Verdict |
|---|---|
| **Do nothing** | Rejected: 55–71 Arabic cues per feature-length run; visible on screen in Hebrew subtitles |
| **Prompt-only** ("output Hebrew letters only") | Insufficient alone; E137 showed slips still accepted under weaker gates; campaign strict gate is research-only |
| **Delete standalone foreign runs** | Partially used: standalone Arabic on a **mixed** line is removed; all-Arabic lines kept |
| **Transliteration tables** | **Chosen** for glued Arabic and short Cyrillic/Greek/Armenian (add-on-proven) |
| **Model re-request** | **Deferred** for this script class at run time; cost and guard complexity; Save-time table is deterministic |
| **Run-time table repair on canonical output** | Rejected for Round 11: would alter resume/analysis inputs; Save copy matches add-on UX |

---

## 7. Round 19A A.7: other-alphabet redo

### 7.1 Why a second layer was needed

Round 19 live Stage-1 outputs (eleven files, Hebrew target, Flash-Lite 3.5, no reference in prompt)
still contained **glued non-table scripts** after translation. A manual inventory found **11 runs in 10
words across 6 of 11 files** (the fragments were Thai, Chinese, Devanagari, Korean and Telugu).
Round 11's table **by design** does not map those scripts. Thai letters glued into a Hebrew word (as in
the Round 19 Stage-1 inventory) survived through translation and would have reached gender readers
unchanged without A.7.

Maintainer decision **D19A-3**: **automatic redo**, not a switch and not warning-only. Reason recorded:
about **half** of the glued words were the **right word in the wrong script** (for example a Chinese or
Korean morpheme meaning “but”), which a letter table cannot fix; a single small model request with guards
was the minimal fix.

### 7.2 Corpus detection (offline, before live redo)

| Corpus | Cues with qualifying stray letters |
|---|---:|
| 19 human Hebrew reference files | 0 |
| 11 Stage-1 model outputs | **10** (the ten glued fragments from the Stage-1 inventory) |

Scripts seen in Stage-1: Thai, CJK, Devanagari, Korean, Telugu (five alphabets).

### 7.3 Live re-measure (Round 19A matrix)

The Round 19 layer matrix was re-run on the same eleven Stage-1 byte strings, with direction marks stripped
to match production (canonical text into finishing). The other-alphabet step ran once per file before
gender arms.

| Measure | Result |
|---|---|
| Other-alphabet redo on 11 Stage-1 files | **10 found, 10 corrected**, 0 wrong, 0 unclear (judged against human Hebrew) |
| Round 19 before A.7 | not built |

Gender-arm numbers from that re-measure belong in [`gender-extras.md`](gender-extras.md); this file only
records that A.7 ran first and did not double-apply Round 11 scripts.

### 7.4 Alternatives for the “other alphabet” class

| Option | Verdict |
|---|---|
| **Warning only** | Rejected (D19A-3) |
| **Default-off Advanced switch** | Rejected; slips are not rare enough to hide behind an opt-in |
| **Extend `wrongAlphabet.ts` tables** | Rejected for whole foreign words in wrong script; tables work for look-alike **letters**, not morphemes |
| **One guarded redo** | **Chosen**; same request shape and caps as gender repair |

---

## 8. ON/OFF defaults and scope summary

| Mechanism | Default | Applies to | Non-Hebrew target |
|---|---|---|---|
| Table repair at Save | **Always ON** (no UI) | Hebrew target Save / export copy | **No-op** (byte-identical) |
| Other-alphabet redo | **Always ON** (no UI) | Every Hebrew **translate** run at finishing | **Skipped** (`hebrewTarget` false) |
| RTL subtitle formatting | ON separately ([`rtl-output.md`](rtl-output.md)) | Display copy | Independent of wrong-alphabet repair |

Transcribe output is **out of scope** for the Round 11 repair (Translate only). A.7 runs only on the
translate finishing path in `run.ts`.

---

## 9. Decisions and why

| Rule | Why | Alternatives rejected | What would reopen it |
|---|---|---|---|
| Hebrew target only for table repair | Add-on logic rewrites any line with Hebrew; on Arabic/Persian/Urdu/Yiddish targets it would damage correct text | Running the add-on rules on every RTL language | Measured safe behaviour on another target language with evidence |
| Table repair on **Save copy** only | Keeps canonical temp aligned with engine truth for resume and sanity | Repair in-engine on every batch | Decision to normalize canonical files at commit time |
| Add-on order: Arabic then Cyrillic/Greek/Armenian | Proven order before RTL in add-on; port matches 174k cues | Single combined pass | Port mismatch evidence |
| No Latin-in-word repair | Add-on has none; new design | Heuristic Latin stripping | Measured defect rate and safe mapping |
| A.7 before gender, one request | Gender readers must not read Thai/CJK slips; batching limits cost | Per-cue requests | Evidence that batched redo breaks guards |
| A.7 excludes Round 11 scripts | Prevents double repair; Save still fixes Arabic/Cyrillic | Running table repair again at finishing | — |
| No user toggle | Slips occur every run at non-trivial rates; opt-in would leave files dirty | Default-off Advanced | Product decision only |
| Fail-soft everywhere | Data loss worse than a visible slip | Throw on repair failure | — |

---

## 10. Build checks and live runs

### 10.1 Proven in automated gates (`scripts/gates/gates.ts`)

| Section | What it proves |
|---|---|
| **R11 D.4** | Add-on fixture vectors; no line or Hebrew letter lost; markup protected; `repairWrongAlphabet` order and counts; pure module; log line wording; non-Hebrew targets byte-identical across RTL methods; Hebrew target repairs then RTL; `.ass` pass-through |
| **R19 H.3 H27–H32 / H31** | Gender bundle does **not** re-import Round 11 repair |
| **R19A A.7** | `hasStrayAlphabet` qualification; splice guards; end-to-end `runTranslation` sends redo only when needed; quota stop before promotion; French target sends no redo |

### 10.2 Seen live (packaged app)

| Run | Result |
|---|---|
| Round 11 Save smoke (40-cue Hebrew translate, Flash-Lite free key) | One Hebrew line with Arabic in temp; **all three** saved copies (Smart RTL, Classic RTL, RTL Off) had **no** Arabic; console log copy ended with the wrong-alphabet repair line (**1** Arabic line fixed, **0** Cyrillic/Greek/Armenian) |
| Release acceptance log | **10** saved copies included a save-time wrong-alphabet repair note among **69** console logs |
| Round 19A matrix | **10/10** Stage-1 stray cues corrected by the other-alphabet step with live Gemini |

### 10.3 Not seen live

- Table repair on **every** Arabic slip in a full feature-length production run (only the one-line smoke
  above plus offline scans).
- Other-alphabet redo on a **clean** Hebrew run with zero qualifying cues (gates simulate; no dedicated
  long-run live log cited).
- Non-English **source** where `sourceStrayScript` excludes output letters (logic gated; limited live
  titles).

---

## 11. Limits

- Counts are overwhelmingly **English source → Hebrew**, Gemini 3.5 Flash-Lite, Low thinking.
- **Latin fused in Hebrew words** (9/7/4 cues per arm in Step 2.9) is counted but **not repaired**.
- Table repair **deletes** some standalone Arabic on mixed lines; meaning can be lost.
- Glued Arabic **suffix transliteration** can be wrong even when the consonant mapping is correct.
- A.7 accepts only replies passing similarity and token guards; **hard slips can remain** (named in log).
- Campaign **914** audit used a **different** validator and prompt class than production translate; it
  explains discovery, not current product rates.
- Stage-1 matrix had **no reference in prompt**; production runs with a reference may differ slightly.

---

## 12. Recommendations

- When comparing engines or models on Hebrew, keep a **third identical arm** and a **whole-file script
  scan**, not only spot review ([`native-translation-engine.md`](native-translation-engine.md) section 9).
- If a future target language needs similar repair, treat it as a **new** port with its own non-target
  no-op proof; do not widen Hebrew-only tables without that evidence.
- Revisit **Latin-in-word** slips only with a measured mapping and add-on or human-labeled fixtures.
- If A.7 remaining counts rise in production logs, inspect failing guards before loosening similarity.

---

## 13. Code and checks

| What | Where | Gate sections |
|---|---|---|
| Table repair | `electron/engine/wrongAlphabet.ts` | **R11 D.4** |
| Save wiring, log line | `electron/main/ipc.ts` (`repairCueTexts`, `wrongAlphabetLogLine`, `saveSubtitleCopy`, `saveRecipeFor`) | **R11 D.4** |
| Other-alphabet redo | `electron/engine/strayAlphabet.ts` | **R19A A.7** |
| Redo request shape | `electron/engine/prompt.ts` (`strayAlphabetRequest`) | **R19A A.7** |
| Finishing order | `electron/engine/run.ts` (stray before `genderFinish`) | **R19A A.7** |
| Hebrew target gate | `electron/shared/genderReference.ts` (`referenceUiShown`) | **R19A A.7**, gender bundle |
| No double repair in gender | `genderRepair.ts`, `genderReaders.ts`, `srt.ts` (no import) | **R19 H.3 H31** |
| Sanity (no translate script check) | `electron/shared/outputSanity.ts` (`scanTranslatedOutput`) | — |
| RTL defaults (separate) | `electron/main/store.ts` (`rtlEnabled: true`) | [`rtl-output.md`](rtl-output.md) |

---

## 14. Label index

| Label | Meaning | Section |
|---|---|---|
| **E137** | 914-line mixed-script audit; context winner withdrawn | 4 |
| **§13.3a** | Maintainer directive into Round 11 | 3, 6 |
| **Step 2.9** | 11-episode scan; 55/71/64 Arabic | 5 |
| **D.4** | Round 11 wrong-alphabet module and Save adapters | 6, 10 |
| **H31** | Bundle H must not apply table repair twice | 1.4, 10 |
| **H27–H32** | Gender leak-cleaner gates; Round 11 repair cited, not duplicated | 1.4 |
| **D19A-3** | Automatic other-alphabet redo decision | 7, 8 |
| **A.7** | Round 19A implementation unit for stray redo | 1.3, 7, 10 |
| **e147-fold-v1** | Research-harness fold only; no product authority | 4.4 |
