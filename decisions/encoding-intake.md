# Subtitle encoding intake: detect, confirm, and start from one verified read

**Decision in one paragraph.** Subtitle bytes are owned by a single module that decides encoding and
language together: BOM markers, then strict UTF-8 (never reinterpreted), then a **closed** set of seven
legacy Windows code pages, each decode scored for script purity, common-word coverage, sibling-letter
penalties, and mojibake-shaped Latin runs. Nothing plausible means refusal with the user's language as
the way through. A hint from a track tag or filename can override a leader that is not alphabet-decided
when the hinted language is plausible and scores at least 0.7× the leader, even if that leader has a
clear margin; a hint never selects an implausible candidate or overrides an alphabet-decided leader. Uncertain
legacy input blocks Start until the Translate page confirms or overrides. Start performs **one**
digest-verified read of the user's file (canonical path, byte length, SHA-256, chosen encoding) and hands
that buffer onward; the native engine parses that text directly and never reopens the source path for
translation.

**Status:** current. **Evidence scope:** thirty-five independently provenance-labelled legacy `.srt`
samples (seven code pages × five files), a 196-file local workspace control, automated gate
assertions on synthetic fixtures (159 at the first boundary, 171 when the round completed), one
development-harness translation of a 12-cue Hebrew legacy clip (2026-10-06; not a packaged-app or
native-engine run), and release acceptance case T-04 (2026-10). Other encodings (CJK, Thai, Vietnamese, Windows-1257) were
not added because no labelled corpus met the entry bar.

**How to read this file.** Section 1 is what the code does today. Section 2 is the SRT AI Translator 1.1.0 baseline.
Sections 3–4 are the measured campaign. Section 5 lists each rule, constant, and rejected alternative.
Sections 6–8 cover build proof, limits, and follow-ups. Sections 9–10 map files and code-comment labels.

Test material is described by type and code page only; no film titles and no dialogue from corpus files
appear here (see [`README.md`](README.md)).

---

## Models used in testing

Encoding and language detection call **no model**: they decode and score bytes on the computer.

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Corpus, decoder comparison, gates (4.1 to 4.4) | None | — | Local decode and scoring | — | 35 files; 196-file control; gate fixtures | Oct 6–7 |
| Development-harness live translation (6) | `gemini-3.5-flash-lite` | Low | Through the old command-line engine; Auto Detect → Hebrew | Free | 12 lines | Oct 6 |
| Release case T-04 (6) | `gemini-3.5-flash-lite` (the release tests' configuration) | Low | Packaged app; the case checks intake, not the translation | Free first, Paid fallback on | One case | Oct 18 |

**Would a different model change the results?** No. Every conclusion in this record is about reading
bytes before any request is sent, so no model choice changes it. The live translation only showed that
the decoded text and the detected language reached the request correctly.

## 1. What the app does today

### 1.1 Owner and ladder

`electron/engine/subtitleInput.ts` is the only place raw subtitle bytes are decoded for language
scoring. `electron/engine/srt.ts` does not guess an encoding.

The ladder matches the file header comment and `inspectSubtitleBytes`:

| Step | Rule | Outcome |
|---|---|---|
| 1 | UTF-8 BOM, UTF-16 LE/BE BOM | Decode with BOM semantics; encoding and language scoring follow |
| 2 | BOM-less buffer | If NUL bytes concentrate on one parity in the first 4096 bytes (>30% on even or odd positions), refuse as likely UTF-16 without BOM **before** UTF-8 (ASCII UTF-16 can pass strict UTF-8) |
| 3 | Strict UTF-8 (`TextDecoder` fatal) | Keep as UTF-8 or UTF-8 BOM; **never** run legacy code pages on valid UTF-8 |
| 4 | Legacy bytes on `.srt` | Try each allowed Windows code page (or only those tied to a user override language), score each (encoding, language) pair |
| 5 | Legacy bytes on `.ass` | Refuse with a fixed message to re-save as UTF-8 (styled ASS must not be guessed) |
| 6 | No plausible decode | Refuse `undetectable`; user must pick a language or re-save as UTF-8 |

Encoding and language are one decision for legacy files: each candidate is a code page plus a language
that language is written in on that page (`scoreProfiles` filters profiles by `cps`).

### 1.2 Scoring and plausibility

Dialogue text is extracted for analysis only (`analysisText`): strip BiDi controls, drop cue indices and
timings, strip ASS override tags. Handed-on text keeps BiDi marks (`stripBidiControls` is analysis-only).

For each language profile, score ≈ stopword coverage × script purity × forbid penalty × accent penalty ×
weird penalty. A candidate is **plausible** only if all of the following hold (`subtitleInput.ts`):

- coverage ≥ `MIN_COVERAGE` (0.06)
- purity ≥ `MIN_PURITY` (0.5)
- weird rate ≤ `MAX_WEIRD` (0.01)
- forbid factor > 0.5
- for Latin profiles: accent-run rate ≤ `MAX_ACCENT_RUNS` (0.05)

Script-only languages (Kana → Japanese, Hangul → Korean, etc.) use purity thresholds; Han chooses
simplified vs traditional using counted character lists.

### 1.3 Certainty, hints, override

| Concept | Behaviour |
|---|---|
| **Encoding certain** | For legacy, **two conditions must both hold** (`subtitleInput.ts`, `encodingCertain`): (1) the language is alphabet-decided (`SCRIPT_DECIDED`: Hebrew, Greek, and script-locked codes) **or** the decode has at least `MIN_TOKENS` (40) tokens; **and** (2) no rival code page gives **different decoded text**, or the chosen decode scores at least `MARGIN` (1.4×) that rival. Neither condition excuses the other: an alphabet-decided language with a close different-text rival is still uncertain, and the page asks |
| **Language certain** | Top plausible language beats the next by 1.4× **and** token count ≥ 40, unless alphabet-decided; hints can force a winner |
| **Hint** | Track tag or filename suffix via `subtitleLanguageHint` in `electron/shared/languages.ts`; applied only when the hinted language is plausible and scores ≥ `HINT_WINDOW` (0.7×) the leader. Within that window a hint naming a **different** language wins even over a clear leader; a hint naming the leader settles an otherwise unclear lead. A hint never overrides an alphabet-decided leader (`decideLanguage`) |
| **Override** | User language picks allowed code pages via `legacyEncodingsFor`; wrong language with no legacy mapping → `override-unsupported`. Multiple code pages for one language with different text → reading choice with `differingLine` preview |

### 1.4 Receipt and Start

Inspection returns a `SubtitleReceipt`: canonical `realpath`, `byteLength`, `sha256`, and `encoding`.

- **Pick / change file:** `subtitle:inspect` in `electron/main/ipc.ts` calls `inspectSubtitleFile`, then
  re-reads the same path once to run `parseCues` so refusal matches Start's cue reader (ASS/WebVTT/no timings
  refused with the same rules).
- **Start:** `readTranslateSource` in `electron/main/translateSource.ts` requires a valid receipt from the
  page. It calls `readVerifiedSubtitle`: one `readFileSync`, path match, length and digest match, then
  decode. Codes: `path-mismatch`, `changed`, `read-failed`, `receipt-invalid`. Without a receipt, the same
  bytes are inspected and `unconfirmed` is returned if encoding is not certain (callers cannot skip the UI
  confirmation).
- **Native translate:** `electron/engine/native/nativeAdapter.ts` uses `readTranslateSource` and keeps all
  parsing on `source.text` (no second user-path read for the run).

The user's file is never rewritten for detection; legacy translation consumes verified bytes in memory.

### 1.5 Translate page UX

Pure functions in `src/pages/TranslatePage.tsx` drive the amber/red cards:

| State | Start | User-facing copy (summary) |
|---|---|---|
| `checking` | Blocked | "Still reading the subtitle file…" |
| `refused` | Blocked | Server/owner error string (empty, UTF-16 no BOM, ASS legacy, undetectable, override unsupported, read failure) |
| `confirm` / language | Blocked | "⚠ Check the subtitle's language before starting." plus `sourceConfirmText` (guess, choose another, "Yes, it's X", optional "Let the model work it out" **only when** `encodingCertain` — UTF-8/BOM bytes) |
| `confirm` / encoding rival | Blocked | "⚠ Check how the subtitle's letters are read…" with buttons per code page and a short preview window |
| `confirm` / mismatch | Blocked | Source Language would decode legacy bytes with a different code page than certain detection; Use detected vs Keep setting |
| `confirm` / undetectable | Blocked | Pick language or re-save UTF-8 |
| `ready` | Allowed | Inline note: detected / your choice / Source Language; legacy preview shows encoding |

`sourceBlockReason` maps confirm states to "Confirm the subtitle's language…" or "Choose how the
subtitle's letters are read…".

Per-file pick clears on Browse, Source Language change, and New; revert restores detection or the setting.

### 1.6 Closed runtime code pages

`LEGACY_ENCODINGS`: windows-1250, -1251, -1252, -1253, -1254, -1255, -1256 only. A page enters the set
only with ≥ five provenance-labelled real files in the gate manifest and zero silent corruption in the
private corpus verifier (see section 4).

---

## 2. What SRT AI Translator 1.1.0 did

From the shipped gst bridge behaviour captured in parity notes (pre-Bundle A):

| Topic | SRT AI Translator 1.1.0 behaviour |
|---|---|
| UTF-8 BOM / BOM UTF-16 | Normalised to a temp UTF-8 sibling |
| Valid BOM-less UTF-8 | **Original path passed through** (bytes unchanged) |
| Non-UTF-8 `.srt` | **Guessed** Windows-1252, then Latin-1 — Latin-only; Hebrew/Russian/Arabic legacy files became silent mojibake with no error |
| Non-UTF-8 `.ass` | Refused (styles protected) |
| UTF-8 / BOM UTF-16 `.ass` | Still accepted on CLI path |
| Read or temp-write failure | **Fail-open:** returned original path as success |
| Before Start | **No** inspection UI, confidence, override, or content digest |
| Auto Detect source | No dedicated source-language flag to gst; model inferred language from text |

NG enhances this by language-aware decoding, refusal instead of Latin guessing when nothing scores, UI
confirmation, digest-verified Start, and typed failures instead of fail-open reads — without dropping
valid UTF-8 pass-through of **bytes** on the user's file. The shipped native translation path consumes
the verified buffer in memory only (no second user-path read). An older gst coexistence design wrote a
run-owned UTF-8 sibling from the same buffer; that bridge is no longer in the tree.

---

## 3. Timeline (2026)

| When | What | Outcome |
|---|---|---|
| 2026-09 | Bundle A design: closed pages, real corpus, TextDecoder proof, one verified read | Requirements settled before implementation |
| 2026-10-06 | Module A.1: owner, synthetic gates, corpus acquire + verify scripts | 103 gate assertions; 35/35 corpus PASS |
| 2026-10-06 | Module A.2: `readTranslateSource`, IPC inspect, receipt validation | +36 gate assertions; single read enforced |
| 2026-10-06 | Module A.3: Translate page cards and `srcLang` sent as real language | +20 gate assertions; development-harness live translate (12 cues, Hebrew legacy, Auto Detect) |
| 2026-10-07 | Round 5 commit | Bundle A landed in product history |
| 2026-10-07 | Post-review repair | Albanian dual code-page reading choice; changeable `override-unsupported` UI |
| 2026-10 (release test) | T-04 non-UTF-8 subtitle | PASS — detection or confirm; file hash unchanged |

---

## 4. Tests

### 4.1 Private legacy corpus (35 files)

**Setup.** A research script downloaded single-CD `.srt` files from a subtitle site API into a
git-ignored folder. For each file:

- **Encoding label** and language label come from the site's legacy (`.org`) metadata.
- **Expected Unicode** comes from the same subtitle's UTF-8 conversion on the modern (`.com`) API matched
  by legacy subtitle id — independent of the app's decoder.
- Every original was verified **not** valid UTF-8 before inclusion.
- Seven targets: CP1255 (Hebrew ×5), CP1256 (Arabic ×4, Persian ×1), CP1251 (Russian ×2, Bulgarian,
  Ukrainian, Serbian), CP1250 (Polish, Czech, Hungarian, Croatian, Romanian), CP1252 (French, Spanish,
  German, Italian, Portuguese), CP1253 (Greek ×5), CP1254 (Turkish ×5).

**Detection results**

| Code page | Files | Encoding + language correct | Encoding certain | Language certain |
|---|---:|---:|---:|---:|
| 1255 | 5 | 5/5 | 5/5 | 5/5 |
| 1256 | 5 | 5/5 | 5/5 | 5/5 |
| 1251 | 5 | 5/5 | 5/5 | 5/5 |
| 1250 | 5 | 5/5 | 5/5 | 4/5 |
| 1252 | 5 | 5/5 | 5/5 | 5/5 |
| 1253 | 5 | 5/5 | 5/5 | 5/5 |
| 1254 | 5 | 5/5 | 5/5 | 5/5 |
| **Total** | **35** | **35/35** | **35/35** | **34/35** |

The one honest uncertainty: Croatian material tied Bosnian/Serbian scores (Central European cp1250); the
app refuses to claim language certain and expects UI confirmation — matching the independent review note.

**Text fidelity.** A verifier bundles the shipped owner and compares dialogue lines to the reference:

- **Ads:** each legacy download carries two advertising cues absent from the `.com` UTF-8 copy: **70 of
  70** such cues, matched on the site's own ad text (counted, not treated as decode errors).
- **isoOnly:** the UTF-8 reference was converted with the ISO-8859 sibling of the Windows code page, so it
  drops or replaces what Windows places at 0x80–0x9F (and, for Greek, 0xA1/0xA2). Where they diverge the
  Windows decode is the correct text and is treated as ground truth: **4** French lines, **107** Greek
  lines across **4** files, **1** Turkish line.
- **malformedTiming:** one Greek file has corrupt in-cue timing; `.com` dropped following lines (two lines,
  one file).
- **Timing lines are not compared**, because the reference site re-times blocks whose timing is malformed
  (one Portuguese file was re-timed this way). Only text is compared.
- Nothing outside these three labelled, per-file counts was tolerated.
- **Wrong cross-script hints:** deliberately wrong hint per page — **0/35** changed encoding or language.
- **Immutability:** SHA-256 of every original unchanged after inspect (35/35).

**Analysis.** Labels and reference text were chosen so the test does not trust the decoder under test.
Failures would indicate silent corruption; none occurred on encoding/language pairing.

**Conclusion.** The seven-page closed set and scorer are validated on real legacy uploads, not only
synthetic bytes.

### 4.2 Decoder comparison (35/35)

The verifier compared each decode to `iconv-lite` 0.6.3 (transitive dependency, probe-only) and to the
built-in `TextDecoder` for windows-1250…1256. **35/35 byte-identical** to `TextDecoder` on Node/Electron
(ICU 74.2 in Electron 31). No new direct dependency or licence payload.

**Conclusion.** Ship `TextDecoder` only; do not import `iconv-lite` in product code.

### 4.3 Workspace control (196 files)

All `.srt` in a private developer workspace folder: **193** UTF-8/BOM, **3** legacy.

| Result | Count |
|---|---:|
| Detected with certainty matching track/filename tag | 195 |
| Wrong tag, correct detection, uncertain vs neighbour | 1 |

The remaining case: **Indonesian dialogue with a Hindi language tag** — detected Indonesian, uncertain
against Malay (close scores). Demonstrates filenames/tags are not authoritative (section 1.3).

### 4.4 Synthetic gate fixtures (A.1–A.3)

**Counts.** 159 assertions at the first boundary (A.1 103, A.2 36, A.3 20). The ambiguity and UI repair
later in the same round added 12, giving 171 when the round completed. These are historical counts, not
a census of today's suite.

**Setup.** `scripts/gates/gates.ts` sections **A.1**, **A.2**, and **A.3**, on representative
fixtures: 13 language/code-page pairs, UTF-8 never reinterpreted, BOM paths, UTF-16
refusal, ASS rules, undetectable noise, short-file never certain, Hebrew/English mix, mostly-English on
cp1255 must not win cp1252, override round-trip, BiDi strip vs preserve, receipt and verified read,
path/digest swap refusal, IPC type parity, page confirm/block Start, D3 legacy ASS refusal.

**Mutations (restored after each failure).**

| Mutation | What broke | Failed assertions |
|---|---|---|
| Verified read checks size only, not digest | Same-size swapped file accepted | 1 |
| Accent-run penalty disabled | Mostly-English bytes decoded as Western Latin | 1 |
| Receipt ignored on Start | Path/swap bypass | 4 |
| Sibling write fail-open to original | Silent wrong bytes | 2 |
| Native re-read user path | Second read | 2 |
| Uncertain treated as ready | Start without confirm | 4 |

**Conclusion.** Constants below are load-bearing where mutations say so; others are guarded by regression
tests even when not individually mutated.

### 4.5 Measured accent-run ceiling (0.05)

On the 35-file corpus, **correct Latin-script decodes** peaked at accent-run rate **0.012** (Turkish).
**Non-Latin files forced through a Latin code page** scored **0.81–0.99**. Setting `MAX_ACCENT_RUNS =
0.05` sits between those bands. Disabling the Latin accent penalty let cp1255 English-heavy bytes decode
as cp1252 English (mutation M2) — silent mojibake.

### 4.6 Certainty thresholds (40 words, 1.4× margin, 0.7× hint)

Unlike the accent-run ceiling, these three were not derived from a measured distribution. They were
chosen as design values and then checked against the corpus and the gate fixtures; no sweep of
alternative values was run.

| Constant | Role | Basis |
|---|---|---|
| `MIN_TOKENS = 40` | Language certainty for non-alphabet-decided scripts, and one half of encoding certainty (alphabet-decided **or** ≥ 40 tokens, always combined with the rival-margin condition) | Short files stay uncertain; two-cue synthetic fixture never certain |
| `MARGIN = 1.4` | Beat rival language or rival code page | Separates close Latin neighbours when enough tokens exist |
| `HINT_WINDOW = 0.7` | Hint may win | A hint wins only when its language scores within 0.7× of the leader (it can then override even a clear leader); deliberately wrong cross-script hints never came within that window (35/35 unchanged) |

Alphabet-decided languages (Hebrew, Greek, etc.) skip the word-count requirement for certainty.

---

## 5. Decisions

### 5.1 Rules

| Rule | Why | Rejected alternative |
|---|---|---|
| Closed seven Windows pages only | Each page has ≥5 labelled files and 0/35 corruption; 1252 kept for Western legacy parity with old cp1252 fallback | Blind charset sniffing; open-ended `iconv` pages; Windows-1257 / CJK / Thai without corpus (listed as future expansion only) |
| Valid UTF-8 never reinterpreted | Prevents mojibake on UTF-8 misread as cp1252 | "Try legacy if UTF-8 scores badly" |
| Linguistic scoring, not byte-frequency detection | Wrong page produces absurd Latin accent runs and wrong script mix | Third-party `encodingDetector.js` / chardet-style sniffers (explicitly not copied per Bundle A contract) |
| Refuse undetectable legacy | User override or UTF-8 re-save | SRT AI Translator 1.1.0 cp1252/Latin-1 guess on any `.srt` |
| Refuse BOM-less UTF-16 | Byte order unknown; ASCII UTF-16 passes UTF-8 | Guess LE vs BE |
| Refuse legacy `.ass` | Style names and tags corrupt if guessed | Guess cp1252 on ASS |
| A plausible different-language hint scoring ≥ 0.7× a leader that is not alphabet-decided wins, even over a clear margin | Wrong cross-script hint 0/35 on corpus (never within the window) | Hint forcing an implausible decode or overriding an alphabet-decided leader |
| Uncertain blocks Start | Prevents shipping wrong letters to the model | Silent start; receipt optional |
| One verified read at Start | Digest closes swap-between-inspect-and-run race | Second read from disk without check; SRT AI Translator 1.1.0 multiple reads |
| `TextDecoder` in product | 35/35 identical to iconv probe | Direct `iconv-lite` dependency |
| BiDi stripped for analysis only | Gender/align see logical text; players keep marks | Strip on export/input file |
| Real `srcLang` to engine when Auto Detect settles | Model receives `-d` / instruction language, not only "auto" | Keep folding language into description only |

### 5.2 Constants (product code)

| Constant | Value | Measured vs chosen |
|---|---|---|
| `MIN_COVERAGE` | 0.06 | Chosen — stopword hit rate floor |
| `MIN_PURITY` | 0.5 | Chosen — allows mixed-script dialogue (e.g. Hebrew + English lines) |
| `MAX_WEIRD` | 0.01 | Chosen — replacement/C1/symbol wedging rate |
| `MAX_ACCENT_RUNS` | 0.05 | **Measured** band between 0.012 (good Latin) and 0.81+ (wrong page); **M2** load-bearing |
| Purity skip in scorer | 0.3 | Chosen — ignore profiles far from script |
| `forbidRate` threshold | 0.002, scale ×60 | Chosen — sibling alphabet letters |
| `MIN_TOKENS` | 40 | Chosen, then validated: short files stay uncertain in the gates, and every corpus file that needed it cleared it |
| `MARGIN` | 1.4 | Chosen, then validated: 34/35 corpus files certain, and the one close Croatian/Bosnian/Serbian case correctly uncertain |
| `HINT_WINDOW` | 0.7 | Chosen, then validated: deliberately wrong cross-script hints changed 0/35 corpus results. A tag can only win for a language that already scores within 0.7× of the leader, and never against an alphabet-decided leader |
| UTF-16 heuristic sample | 4096 bytes, 30% NUL parity | Chosen — fast pre-UTF-8 guard |
| `READING_WINDOW` / `READING_LEAD` | 120 / 40 chars | Chosen — reading-choice preview |
| Han simplified vs traditional | ≥5 chars, 3× ratio | Chosen — zh vs zh-TW disambiguation |
| Kana purity scale | ×3 effective purity | Chosen — Japanese kana+kanji mix |

### 5.3 What would reopen a decision

- Any silent corruption on a newly labelled real file for an enabled code page.
- `TextDecoder` divergence from a reference decoder on a supported page (OS/ICU upgrade).
- Evidence that 40 words / 1.4× / 0.7× fails on a new language group at scale.
- A shipped requirement to read Shift_JIS, Big5, or Windows-1257 with the same bar (corpus + zero silent
  corruption + gates).

---

## 6. Build checks and live runs

| Check | Proved | Not proved live |
|---|---|---|
| A.1 synthetic + manifest gates | UTF-8/BOM/legacy detect, refusal paths, receipt, BiDi, overrides | — |
| Corpus verifier (maintainer machine) | 35/35 when private folder present | Not run in CI (bytes not in repo) |
| A.2 Start/read | One read, digest swap refused, `unconfirmed` without receipt | — |
| A.3 page | All Start-blocked states, override/revert, legacy ASS D3 message | — |
| Live translate 2026-10-06 (development harness: the real page decision functions feeding the real Start path, with the engine then in use, the old CLI) | cp1255 clip, Auto Detect → Hebrew, 12/12 cues, user file unchanged | Not a packaged-app run; the native engine path was not run live (covered by A.2) |
| Release T-04 | Non-UTF-8: show or ask; hash unchanged | — |

---

## 7. Limits

- **Corpus scope:** European/Middle Eastern single-byte pages only; no measured CJK/Thai/Vietnamese legacy
  intake.
- **Inspect I/O:** Pick-time inspect reads bytes for `inspectSubtitleFile` and reads again for `parseCues`
  on the canonical path (same path, two reads at pick — not the Start verified-read contract).
- **Reference download / Align:** Other features call `inspectSubtitleFile` or `readVerifiedSubtitle` with
  their own receipts; rules match the owner but UX differs from Translate.
- **Transcription:** Speech language detection is a separate feature ([`transcription.md`](transcription.md));
  it does not reuse this ladder on subtitle bytes.
- **Workspace control:** One maintainer folder; not a public benchmark.

---

## 8. Recommendations

- Before adding a code page, extend the manifest with ≥5 independently labelled files and run the private
  verifier; keep subtitle bytes out of git.
- On ICU/Electron upgrades, re-run the 35-file decoder comparison script.
- If Croatian/Bosnian/Serbian Latin tie rates rise in support, consider richer forbid lists or explicit
  UI copy — the scorer already refuses false certainty.
- Treat wrong filename tags as normal: keep confirmation, do not trust tags as ground truth.

---

## 9. Code and checks

| File | Role | Gate section (`scripts/gates/gates.ts`) |
|---|---|---|
| `electron/engine/subtitleInput.ts` | Ladder, score, receipt, verified read | **A.1 — subtitle intake: inspect, decode, language, receipt**; exercised in **A.2**, **A.3** |
| `electron/main/translateSource.ts` | Start read + receipt validation | **A.2 — Start reads the subtitle once, proves it is the inspected file, and hands that text onward** |
| `electron/main/ipc.ts` | `subtitle:inspect`, cue parity check | **A.2** |
| `electron/shared/languages.ts` | `subtitleLanguageHint` | **A.2** |
| `electron/shared/types.ts` | IPC intake types | **A.2** (compile-time parity) |
| `electron/engine/native/nativeAdapter.ts` | Consumes `readTranslateSource` text | **A.2** (source pin) |
| `src/pages/TranslatePage.tsx` | Confirm/refuse UX, `srcLang` | **A.3 — the Translate page asks when it cannot be sure, and sends the language it settled on** |
| `scripts/gates/fixtures/encoding/manifest.json` | Provenance metadata only | **A.1** manifest assertions |
| `scripts/gates/fixtures/encoding/verify-corpus.mjs` | 35-file regression (local) | Not part of `npm run test:gates`; maintainer script |
| `scripts/gates/fixtures/encoding/acquire.mjs` | Corpus download | Not gated |

---

## 10. Label index

Labels appear in code comments; they point to sections above.

| Label | Meaning in this feature |
|---|---|
| D14.1 | Bundle A subtitle intake (encoding + language + verified read) — sections 1, 4–6 |
| §2.6 (comment in `subtitleInput.ts`) | Encoding/language ladder — sections 1.1, 5.1 |
| §2.9 (comment) | BiDi strip analysis-only — sections 1.2, 5.1 |
| §17.5 item 8 (comment in owner / translate source) | Receipt + single verified read — sections 1.4, 5.1 |
| A.1 / A.2 / A.3 | Gate sections in table 9 |
| D3 (page comment) | Legacy `.ass` refused on Translate pick — sections 1.1, 6 |
