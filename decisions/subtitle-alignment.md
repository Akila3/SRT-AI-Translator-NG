# Subtitle synchronisation and alignment

**Decision in one paragraph.** NG adds an **Align** tab (planned as **Bundle C**) that retimes an existing SubRip file without
changing its text, cue count or order. **Global** mode fits one speed-and-offset map with a hardened
in-process engine (`independent-align`): Kodi-style coarse search, monotonic pairing at **250 ms**,
MAD-trimmed refit (**k = 3.5**, up to **8** iterations), then local windows, drift checks and an
**accept | check | refuse** verdict with stable reasons. **Advanced** mode is explicit only: a bundled
**ALASS 2.0.0** sidecar proposes piecewise timing; NG re-runs the same A–I contract on that output and
never trusts exit code or score. Against **video or audio**, embedded text tracks are tried first, then
a **1–4 kHz** loudness detector (not gst's **80–3400 Hz** transcription band), then transcription only
after a structurally valid audio attempt refuses. The gender oracle keeps a separate **0.65 / 0.65**
profile and never uses ALASS. Global runs first; piecewise runs only when the user chooses Advanced or
**Try piecewise** after `likely_different_cut`.

**Status:** current. **Evidence scope:** ALASS benchmark **112** rows (September 2026); E66 **20**
synthetic timing fixtures plus **11** self-test cases; E67–E68 detector A/B on **7** then **13** media
cases; E69 direct ALASS on **three** Japanese anime pairs; Round 8A corpus **138** OpenSubtitles release
pairs (**49** titles) plus **1 155 × 2** mode threshold sweep; Kodi oracle parity and Nuvio/Kodi joint
review (Feature 16 research, not shipped as engines). Live packaged Align behaviour was exercised in
release gates; no maintainer report of a full feature-length Align Apply run is recorded here.

**How to read this file.** Section 1 is what the code does today. Section 2 is 1.1.0. Section 3 is the
timeline. Sections 4–12 are measurements and design reviews in order. Section 13 states the decisions.
Section 14 separates gate-proven behaviour from live-only claims. Sections 15–17 are limits,
recommendations and the code map. Section 18 indexes comment labels.

Related records: [`gender-reference.md`](gender-reference.md) (oracle use of alignment), [`transcription.md`](transcription.md) (fallback after audio refusal).

---

## 1. What the app does today

### 1.1 Surfaces and modes

| Surface | Default | User-initiated alternative |
|---|---|---|
| **Align tab** (`src/pages/AlignPage.tsx`) | **Global** — one map for the whole file | **Advanced → Piecewise (ALASS)**; **Try piecewise** only when Global refuses `likely_different_cut` |
| **Reference: subtitle file** | Another `.srt` (or embedded track extracted to `.srt`) | — |
| **Reference: media file** | Every embedded text track extracted in one pass, each judged by A–I, then arbitrated (`alignService.ts`, `align.ts`) | Local **1–4 kHz** detector spans when no usable text track wins; then **Transcribe** if that path refuses and source preflight passed |
| **Advanced + video** | ALASS speech export + piecewise align (`alignAlassToSpeech`) | No fallback to Global or transcription on that path |

The original file is never modified; Apply writes a new path after one explicit Save confirmation
(`AlignPage.tsx`, `alignService.ts`).

### 1.2 Profiles and why two threshold sets exist

Every call names a profile; there is no default inside `align.ts`.

| Profile | Vote / overlap floor | Scale band | Min dialogue cues | Produces |
|---|---|---|---|---|
| **`oracle`** | **0.65 / 0.65** | **0.90–1.11** | **8** | Hint map or unhinted miss — **gender reference only**; fail-soft |
| **`independent-align`** | **0.55 / 0.55** | **0.90–1.11** | **8** | **`accept` / `check` / `refuse`** with reasons — **Align, detectors, ALASS re-check** |

Constants live in `electron/engine/align.ts`:

```ts
// electron/engine/align.ts
export const ORACLE_PROFILE = Object.freeze({
  minDialogueCues: 8,
  voteMin: 0.65,
  overlapMin: 0.65,
  scaleMin: 0.9,
  scaleMax: 1.11
})
// ...
export const INDEPENDENT_PROFILE = Object.freeze({
  minDialogueCues: 8,
  voteMin: 0.55,
  overlapMin: 0.55,
  scaleMin: 0.9,
  scaleMax: 1.11,
  pairToleranceMs: 250,
  acceptCoveragePct: 85,
  checkCoveragePct: 60,
  retainedMinPct: 65,
  madK: 3.5,
  madMaxIterations: 8,
  residualOkMs: 400,
  wrongTitleVoteMax: 0.42,
  wrongTitleOverlapMax: 0.35
})
```

**Why they differ.** The oracle was ported from Kodi's `align_one` for **optional translation hints**:
field-tested, intentionally conservative, and a miss simply leaves lines unhinted. Independent Align
was **searched** on a timing-only corpus (E66) for a stricter product gate: lower vote/overlap so partial
matches become **`check`** rather than silent failure, plus coverage, retained-pair, residual and local
rules that can **refuse** unsafe maps. The same file can **`check`** under `independent-align` while
the oracle stays unhinted at 0.60–0.64 vote (gate `R13.1`).

Local and density constants (`INDEPENDENT_LOCAL_PROFILE`, `INDEPENDENT_DENSITY_PROFILE`) apply only
to `independent-align` (`align.ts:92–120`).

### 1.3 Global fit pipeline (A–I summary)

| Step | What happens | Refusal examples |
|---|---|---|
| **A — Preflight** | Parse; require dialogue cues ≥ 8; finite times; order; round-trip | `malformed`, `insufficient` |
| **B — Coarse proposal** | Discrete FPS ratios, **0.002** grid, **0.0001** refine; 500 ms histogram buckets; median offset from voting deltas | — |
| **C — Pairs** | Monotonic nearest pairs within **250 ms** | — |
| **D — MAD refit** | Least squares; drop \|residual\| > **k·MAD**; repeat ≤ **8** times | — |
| **E — Local / drift** | Nine windows (whole, thirds, sliding); step vs drift; edge density (FE-1); mixed support (FE-2) | `likely_different_cut` |
| **F — Identity** | Compare unchanged / fixed-offset / fitted map | Can refuse weak “corrections” |
| **G — Invariants** | Count, index, text, order; writable times; reparse | `invariant_failure` |
| **H — Verdict** | `independentVerdict` + reasons | See table below |
| **I — Corpus** | Gates replay E66 matrix in CI | — |

**Verdict table** (after E and F pass and retained/residual gates pass):

| Verdict | Conditions | Machine reason | Apply |
|---|---|---|---|
| **`accept`** | Coverage ≥ **85%**, gates pass | `ok` | Yes — “Apply…” |
| **`check`** | **60% ≤ coverage < 85%**, gates pass | `partial_coverage` | Yes — “Apply with caution…” (same confirmation) |
| **`refuse`** | Coverage < **60%**, vote/overlap < **0.55**, scale outside band, retained < **65%**, \|median residual\| > **400 ms**, local/identity/invariant failure | `weak_correspondence`, `wrong_title`, `likely_different_cut`, etc. | No — findings only; Global `likely_different_cut` may offer **Try piecewise** |

`wrong_title` applies only when coverage is below **60%** **and** vote ≤ **0.42** **and** overlap ≤ **0.35**
(`independentVerdict`, `align.ts:557–568`).

**Preview eligibility** is verdict-only: `accept` and `check` may preview; `refuse` may not
(`electron/shared/alignment.ts`).

### 1.4 Advanced / ALASS sidecar

| Setting | Value | Source |
|---|---|---|
| Version | **2.0.0** | `ALASS_SIDECAR` in `electron/engine/alassSidecar.ts:36–40` |
| Interval | **1 ms** | `ALASS_FIXED` |
| Split penalty | **7** | `ALASS_FIXED` — E63 showed **5/7/10/20** equal on obvious gaps; not re-tuned |
| Speed optimisation | **1** | `ALASS_FIXED` |
| FPS guessing | **on** (Global NG search is separate) | `ALASS_FIXED` |
| Run timeout | **15 min** | `ALASS_LIMITS` |
| Missing sidecar | Advanced unavailable only | Global unchanged |

Flow: spawn hashed `alass.exe` in a scratch folder → read transformed SRT + JSON report →
`judgeCandidate('independent-align', …)` compares **ALASS output times** to the **selected reference**
(`align.ts`, `alignService.ts`). Sidecar **WebRTC VAD** is used only on Advanced media path
(`alassSidecar.ts` header comment). Score and exit **0** are diagnostic only (E69).

### 1.5 Feature 4 audio detector (default path)

| Aspect | NG Align detector | gst transcription |
|---|---|---|
| Band | **1000–4000 Hz** (`ALIGNMENT_HIGHPASS_HZ`, `ALIGNMENT_LOWPASS_HZ`) | **80–3400 Hz** when voice isolation is on (`ffmpeg.ts:639–649`) |
| Sample rate | **16 kHz** mono PCM | Model-oriented chain |
| Selection | One decode; sweep **2** hop sizes × **6** thresholds × **2** min spans = **24** candidates per envelope set (`ALIGNMENT_SWEEP`) | Not used for Align |
| Pick | Best coarse vote, then overlap (`pickAudioCandidate`) | — |

Channel rule follows gst: **≥ 6 channels** and isolation → centre channel; else weighted downmix
(`monoPan`, `alignmentFilterChain`).

### 1.6 Read-with-repair (FE-4)

Before analysis, the service may repair **only** `order` and `duration` issues on a side, at most
**10%** of cues (`REPAIR_MAX_FRACTION = 0.1`, `cueRepair.ts:21`). Analysis uses a sorted view with
**+2 ms** end nudge where needed; Apply writes **file order** with aligned times (E158: +1 ms broke
synthetic films in gates). Strict `align.ts` preflight is unchanged; repair changes **service outcome**
only (`alignService.ts`; label FE-4).

### 1.7 Defaults and why

| Default | Why |
|---|---|
| **Global first** | Cheaper, no GPL sidecar, catches most offset/FPS drift; E63 showed raw ALASS can exit 0 on catastrophic matches |
| **Piecewise only by user action** | E69: piecewise moved valid anime cues by **10+ s** while score rose; automatic piecewise would ship wrong dialogue |
| **No detector fusion** | E67: neither 1–4 kHz nor WebRTC dominates; fusion would hide refusals |
| **Transcription last** | Transcribed times are fallible anchors; A–I must still pass |
| **CHECK at 60% not 65%** | E66 search selected **60%** CHECK floor; supersedes an earlier standalone **65%** note |

---

## 2. What 1.1.0 did

1.1.0 shipped **Translate**, **Transcribe** and **Settings** only — **no Align tab**, no retiming command,
no ALASS integration (**AL-P1** in the 1.1.0 inventory).

Alignment-adjacent behaviour that existed:

- **Post-translation sanity** (fragment/drift warnings on completed translations) — not replaced by
  Align; REP-32 remains diagnostic (`gates.ts` G3d).
- **Embedded subtitle extraction** for Translate — same FFmpeg probe/extract machinery Feature 4 reuses
  for references (AL-P7, AL-P8).
- **gst** could align internally for transcription timing; NG owns explicit Align instead.

Nothing in 1.1.0 implemented the A–I contract, CHECK Apply, or the 0.55 production profile.

---

## 3. Timeline

| When (2026) | What | Outcome |
|---|---|---|
| Sep 9–11 | Feature 3–4 design; robust refit decision; parity rows AL-P1–AL-X | MAD refit; language-agnostic estimator |
| Sep 17 | E63 ALASS benchmark (**112** rows); E65 sidecar build parity (**102/102** vs official binary) | COEXIST: NG global + optional ALASS |
| Sep 17 | E66 threshold search + **20** fixture campaign | **0.55**, **250 ms**, **60/85%**, local **9** windows; **8/8** piecewise refuse global |
| Sep 17–18 | E67 detector A/B; E68 media + supplied SRT defects; E69 Japanese ALASS check | Mode-bound 1–4 kHz vs WebRTC; safe refusal on GST Japanese samples |
| Sep 18 | E70 binding; E72 independent review | Align approach recorded for implementation (Global A–I, optional ALASS, detector split) |
| Sep 23 | Kodi + Nuvio joint review | Nuvio retimer rejected; multi-track and lifecycle patterns evaluated for a later media pass |
| Oct 7–8 | Round 8 (Registry-13): ALASS sidecar, packaging, Advanced UI, media split (gates R13.1–R13.8); **138** release-pair evaluation; **1 155 × 2** threshold confirmation | FE-1 edge rule, FE-2 density (subtitle only), FE-4 repair designed; threshold study completed |
| Oct 9 | Round 8A built | Gates **8A FE.1** / **8A FE.2** / repair; chosen FE thresholds frozen in code |
| Oct 10 | Round 9 shipped (commit **52e4007**) | Bundle M: every embedded text track extracted in one pass, arbitrated (**R9 M.1–M.5**); text-free timing diagnostic export/replay |

---

## 4. ALASS evaluation (E63, E65)

### 4.1 Setup and counts

- **Harness:** tracked tool producing ignored artifacts under research storage; **10** controlled subtitle
  fixtures, **3** natural cross-language pairs, **3** short same-container videos, **1** ~28.6 min video.
- **Executions:** **102** ALASS runs (100 exit 0; malformed arms exit 1) + **10** Kodi coarse runs +
  **4** repeat byte-identical checks → **112** rows total (the ALASS evaluation).

### 4.2 Where ALASS helped (controlled)

On **631–809** cue valid fixtures with planted **30–90 s** gaps, split mode with penalties **5/7/10/20**
recovered within **0–1 ms**; cue counts preserved on missing/extra/segmented structures. **25/23.976**
FPS drift recovered within **1 ms** with FPS guessing; without guessing, median error **34 s+**
(the ALASS evaluation).

### 4.3 Where ALASS is unsafe alone

| Case | ALASS behaviour | NG response |
|---|---|---|
| **7-cue** excerpt vs long reference | Exit **0**, median error **~2.2×10⁶ ms** | Preflight `<8` cues → refuse |
| **Empty** input | Exit **0**, empty output | Preflight / malformed |
| **One 60 s gap, no-split** | **52%** within 400 ms, exit **0** | Global A–I → `likely_different_cut` |
| Long file with **23** zero-duration + reversed cue | Exit **0**, order-breaking output | Strict preflight |

**Conclusion:** adopt ALASS only as **candidate generator** behind A–I; fixed penalty **7**; no score-based
Apply.

### 4.4 Sidecar build

Self-built **2.0.0** matched official binary on all **102** rows (E65b). Shipped hash pinned in
`ALASS_SIDECAR` (`alassSidecar.ts:36–40`). GPL sidecar + MIT host follows same pattern as FFmpeg
(E64d).

---

## 5. E66 global threshold capture

### 5.1 Setup

- **20** timing-only fixtures (**12** controls, **8** piecewise positives) from a **736**-cue timing
  source with text replaced by labels before distortion.
- Coordinate search on compact rows, then full rerun (the ALASS evaluation).

### 5.2 Selected production values

| Parameter | Value |
|---|---|
| vote / overlap | **0.55** |
| pair tolerance | **250 ms** |
| accept / check coverage | **85% / 60%** |
| retained pairs | **≥ 65%** |
| MAD **k** / max iter | **3.5 / 8** |
| residual accept | **≤ 400 ms** median |
| local windows / vote | **9 / 0.55** |
| residual step | **1000 ms** |
| drift warn | **3000 ms** |
| linear drift **R²** | **0.85** |
| wrong-title band | vote **≤ 0.42**, overlap **≤ 0.35** |

### 5.3 Hard gate results (full fixtures)

| Metric | Result |
|---|---|
| Piecewise positives refusing global | **8 / 8** → `likely_different_cut` |
| Controls emitting piecewise hint | **0 / 12** |
| Self-test mirror | **11 / 11** pass (`e66-matrix.ts`, gate R13.1) |

**Analysis:** compact search scored **~70%** on broader labels and missed one early-edge case; full
fixtures passed after a histogram-only alias repair (E66e). Values are **evidence for the port**, not
tuned in product code after ship.

**Conclusion:** ship E66 numbers frozen in `INDEPENDENT_PROFILE` / `INDEPENDENT_LOCAL_PROFILE`; gates
R13.1 + B.2 enforce them.

---

## 6. Oracle parity (Kodi `align_one`)

- TypeScript port from Kodi add-on **0.2.528** `arabic_gender.py` (`align.ts` header).
- Gate **B.1:** fixture digest matches Kodi receipt; fail-soft on throw; **0.65/0.65** unchanged.
- Used for **Bundle H** gender hints only — **excluded from ALASS, WebRTC, and Align UI**
  (label **AL-X7**).

---

## 7. Detector A/B: 1–4 kHz vs WebRTC VAD (E67–E68)

### 7.1 Initial seven-case run (E67)

| Arm | Stress (3 cases) | Real (4 cases) |
|---|---|---|
| WebRTC (ALASS export) | **0** missed labelled speech windows | **403** cue-proxy misses, **238** false positives |
| 1–4 kHz (product sweep) | **7** missed windows | **556** misses, **29** FPs (15 s case: no admissible pick) |

Both arms fired ~**40 s** inside loud non-speech stress clip. **A–I refused every case** — no unsafe
Apply.

### 7.2 Expanded thirteen-case run (E68)

Includes five MKV/audio operating points (long silent opening, dialogue-rich then sparse MP3, format
variants). Highlights:

- **A long MP3, title F** (dialogue-rich then sparse): VAD activity **inverted** speech-rich vs sparse
  regions (−21 pp contrast); 1–4 kHz sweep also wrong-signed.
- **A documentary, title K** (AAC/FLAC/M4A encodings of the same ~28.6 min audio): 1–4 kHz picked
  **−166.5 s** false coarse candidate (**vote 1.125**, overlap **0.75**); A–I refused all nine selected
  configs.
- **80–3400 Hz “gst band” test:** more misses than 1–4 kHz on real corpus; **not** adopted for Align
  (the ALASS evaluation).

### 7.3 Decision

**Mode-bound coexistence:** default Feature 4 uses **1–4 kHz** + full A–I; **WebRTC** only inside
**Advanced ALASS** on media; no auto-switch, fusion, or sidecar after Global refuse.

---

## 8. Japanese GST samples — safe refusal (E68–E69)

Three **anime** episode pairs (two structurally valid, one with a backward jump) plus a synchronized
**documentary, title K** control pair.

| Finding | Detail |
|---|---|
| Quantization | **All** Japanese cue times whole seconds |
| Malformed | **770**-cue file: non-monotonic jump → preflight refuse |
| Documentary **K** control | **23** zero-duration cues; detectors see 0 ms coarse; A–I refuses malformed |
| Global ALASS | Uniform shifts **+60**, **−530**, **+120 ms** — cannot fix per-gap **0.5–2 s** leads |
| Piecewise ALASS | **85**-cue: **all** cues moved **>10 s** (groups **−59.6 s … +112.8 s**); score **rose** |
| | **119**-cue: **22** cues **>10 s** moves; score **rose** slightly |
| NG gate | Research A–I refused **`likely_different_cut`** / malformed |

**Conclusion:** these are **explicit safe-refusal** cases, not evidence for automatic piecewise or
per-cue repair. See [`transcription.md`](transcription.md) for future sub-second transcription output.

---

## 9. Release-pair corpus (138 pairs, October 2026)

### 9.1 Setup

- **138** natural OpenSubtitles **release pairs** from **49** feature titles (including extended/
  theatrical variants): **104** “natural” + **34** extended-set (the Round 8A corpus).
- **1 155** cases × **Global + Advanced** modes in the final confirmation run (same corpus, with Round 8
  rules as baseline).
- The parameter grid covered **77** controls and fixtures plus **1 078** real or derived cases in both
  modes (**2 310** case-modes in the sweep file; **1 717** distinct case-modes in the confirmation cache).
- Truth from **text anchors** (lines with enough normalised text, unique in both files, monotonic
  order), not from the checker. Short lines, lyrics and repeats are unscored.

### 9.2 Threshold study, what-if probes and confirmation

Research scripts (not published) cloned Round 8 `align.ts` into four checker variants — baseline, C810
(density-gated unsupported windows), Option 1 Global (FE-1 edge rule), and both combined — and scored
Global and Advanced on a shared case list: **77** controls and fixtures plus **1 078** real or derived
cases, each in both modes. The media are private; only counts are recorded here.

**Probe vs product parity.** Before the grid ran, the parameterised probe copy was diffed against
shipped `align.ts` with all WHATIF switches off: **1 717 / 1 717** case-modes matched. The sweep
therefore measures the same engine the app ships, not a divergent fork.

**Option 1 (FE-1) threshold grid** (density / coverage / gap axes):

| Parameter | Range tested | Effect (high level) | Chosen | Why |
|---|---|---|---|---|
| Reference density ≥ | 0.5 – 1.0 | FE-1 fixes move from 121 (0.5) toward 95 at 1.0; no new bad in grid | **0.8** | Must stay ≥ coverage limit ÷ 100 so a slice that merely lacks reference lines (density ≈ coverage) cannot trigger an edge cut |
| Coverage < | 40 – 90 | 120–121 fixes from 70 upward; 89 at 60; 52 at 40 | **70** | Same **120** FE-1 fixes as at **80**, with **153** fewer refusals of small edge mismatches |
| Gap ≥ (points) | 5 – 60 | More fixes as gap shrinks; gap **5** touched 2 controls only when measured at coverage **< 80** | **20** | Closest control near-miss: jitter ±300 ms, last window **74%** / density **0.99**, gap **9** only. Gap **20** leaves **11** points of margin |

**C810 (FE-2) density grid:** results were identical from density **0.2** through **0.7**; **0.8** added
3 new bad rows and **0.9** added 9. **Chosen 0.5** — middle of the flat range, below measured cut
densities (≥ **0.81** on fixtures) and above empty-slice densities (≤ **0.19** when unsupported).

**Confirmation at chosen values** (**1 155** cases × both modes, FE switches as shipped in Round 8A).
Counts label the checker variant explicitly:

| Variant | Total bad rows | New bad vs Round 8 | Controls changed | FE-1 fixes | FE-2 fixes |
|---|---|---|---|---|---|
| Round 8 baseline (pre–FE rules) | **134** | 0 (baseline) | 0 | 0 | 0 |
| **Chosen:** C810 on subtitle/embedded refs only + Option 1 Global (d≥0.8, c<70, g≥20) | **18** | **0** | **0** | **120** | **175** |
| Chosen rules but C810 on **every** reference kind (audio included) | **27** | **9** | 0 | 120 | 175 |
| Chosen C810 scope + Option 1 coverage **< 80** (not shipped) | **17** | 0 | 0 | 121 | 175 |

**Advanced rescoring correction (2026-10-08).** An earlier confirmation receipt scored Advanced “bad”
lines on the **raw ALASS sidecar candidate** rather than on the **returned cues** that Advanced Apply
actually writes after `judgeCandidate`. That inflated bad totals by **3** in every variant (for example
baseline **137 → 134**, chosen **21 → 18**). New-bad counts, FE fix counts and false-refusal totals
were unchanged; only the Advanced off-count moved. The figures above are the corrected ones.

**Median residual vs per-line error bound.** The shipped accept gate uses **|median pair residual| ≤
400 ms** (`residualOkMs`, `independentVerdict`). The sweep’s “bad” count and its safety bar instead ask
whether **any scored line** ends more than **400 ms** from truth. A **`check`** can satisfy the median
gate while individual lines are far off (for example a cut after 70% plus false audio spans in the
false-fire fixture). FE-2 scoping used the **per-line** bar to reject C810 on audio references.

**Rejected audio fixture model.** A prototype merged every *k* consecutive lines into one detector span.
That halved reference starts and refused even clean cases — not how the gate audio fixtures or the
product detector behave. It was discarded; all retained audio evidence uses authored envelope spans.

**Real decoded media — label variants.** With C810 applied to audio references **alone** (prototype
before scoping), **10 new bad** case-modes appeared (**7** Advanced, **3** Global): wrong ALASS output
flipped from refuse to **check** on stress clips such as loud non-speech bookends and sparse opening.
That **10** must not be read as the combined confirmation’s **9 new bad**, which is the **C810
everywhere** row in the table above (120 FE-1 + 175 FE-2 fixes unchanged, but **9** new bad). Subtitle-
only C810 (**chosen scope**) has **0** new bad on the same corpus while keeping all **175** FE-2 fixes
on derived “reference lacks lines” cases.

Outside edge probes, every verdict change at chosen thresholds is a fix of a planted problem except:
one natural PAL opening pair that Global refuses (Advanced rescues via **Try piecewise**); and one
derived edge cut refused at **10/250** lines off (4%, inside the scoring allowance).

### 9.3 FE-1 — Global edge cuts (Option A)

**Rule:** first or last of nine windows: coverage **< 70%**, reference density **≥ 0.8**, median window
≥ **20** points better → `likely_different_cut` + **Try piecewise** (`INDEPENDENT_DENSITY_PROFILE`).

| Measure | Result |
|---|---|
| Planted **+5 s** edge cuts on real pairs | Previously accept/check with **40–177** lines **>0.5 s** wrong |
| After FE-1 on corpus analog | **8/8** edge piecewise fixtures refuse (was **6/8** before) |
| Cost | **1** natural PAL opening pair Global refuse → piecewise rescues; **1** derived **+5 s** refuse |
| Advanced | Excluded — would refuse good piecewise on a speed pair at **<80%** coverage |

### 9.4 FE-2 — missing reference block (density-gated C810)

**Rule:** window ≤ **20%** coverage counts as unsupported **only if** reference density **≥ 0.5**
(subtitle/embedded references only — not audio/transcription).

| Measure | Result |
|---|---|
| Extended-set missing-scene pairs | **0** false accepts from C810 |
| **104** natural pairs | **0** verdict changes |
| Derived “reference lacks lines” | **175** fixes (refuse → accept/check), **0** new bad in chosen subtitle scope |
| C810 on audio references (prototype, not shipped) | **10** new bad — see §9.2 (*C810 alone* on real decoded media) |
| C810 everywhere in combined confirmation | **9** new bad (same FE fix counts, audio scope) |
| **Chosen scope** | Subtitle and embedded text tracks only; audio keeps full mixed-support refusal |

### 9.5 FE-4 — repair counts on real transcripts

| Material | Defect | % flagged |
|---|---|---|
| Long anime transcript **A** | 1 order cue / 770 | **0.13%** |
| Documentary transcript **B** | 22 zero-length + 1 reversed / 547 | **4.20%** |
| War drama transcript **C** | 59 zero-length / 913 | **6.46%** |

All within **10%** repair budget; end nudge **+2 ms** (not +1 ms) for write-back gates.

---

## 10. Other tools considered

### 10.1 ALASS 2.0.0 — **adopted (Advanced only)**

See sections 4–5. GPLv3 sidecar; MIT app invokes executable like FFmpeg.

### 10.2 Kodi add-on patterns — **partial port**

| Adopted | Not adopted as default engine |
|---|---|
| `align_one` coarse histogram + **oracle** profile | Kodi piecewise / per-group transplant as default |
| Multi-track safety ideas (independent tracks, identity, lifecycle fencing) — see §10.2.1 | Player hot-swap, provider workflow, title-specific certificates |
| MIT-licensed estimator code in `align.ts` | Wholesale copy of upstream Python sync scripts |

Gate **B.1** locks oracle parity. September 2026 research: Kodi optional piecewise repaired **6/8**
synthetic piecewise fixtures vs NG A–I **8/8** refuses — research only for piecewise default.

#### 10.2.1 Shipped multi-track arbitration (Bundle M, Round 9, 2026-10-10)

When Align uses a **video reference**, every decodable **text** subtitle stream is extracted in **one**
FFmpeg command (`extractTextTracks`, `ffmpeg.ts`), at most **128** streams. FFmpeg is asked to stop
each output at **8 MiB** (`ALIGN_TRACK_MAX_BYTES`, passed as `-fs`), but `-fs` is a target, not a strict
ceiling: on the bundled FFmpeg it stopped about one packet past the limit (a 300-byte request produced a
374-byte file, exit 0). So `alignService.ts` excludes any file **at or above** 8 MiB before reading it
(it may be truncated), and then excludes any track over **20 000** cues (`ALIGN_TRACK_MAX_CUES`, the
same limit the timing diagnostic accepts), so no track can exceed what the diagnostic can replay. Each extracted track runs the full **A–I** pipeline alone; arbitration
(`arbitrateTracks`, `audioSettles` in `align.ts`; `alignService.ts` orchestration) picks at most one
winning map. Gates **R9 M.1–M.5** pin the behaviour; the round landed at commit **52e4007** with
**3 192** build checks passing.

**Final rules vs early proposals.** The first design suggested stricter patterns, for example a
conflict on **any** 1 ms disagreement between transformed timelines, or one failed extraction
stopping every track. Independent review and the measurements below replaced them. What shipped:

| Topic | Shipped rule | Measured basis |
|---|---|---|
| Agreement metric | Two usable maps **agree** when every **source** cue’s moved start/end differs by ≤ **T** | Same metric as pair tolerance — not a cross-track text compare |
| **T** | **250 ms** (`TRACK_AGREEMENT_MS` = `INDEPENDENT_PROFILE.pairToleranceMs`) | Same-release subtitle sets (15 titles, 9–11 languages each, planted source offset): correct tracks put the source's lines at most **184 ms** apart on **14 of 15** titles; the fifteenth spread about **12 s**, read as mixed releases (an inference, not proven) |
| Correlated copies | **50 ms** raw start/end families (`TRACK_FAMILY_MS`); **one witness per family** | Stops three near-duplicate language tracks from outvoting one independent track |
| Side building | First usable track starts a side; later tracks join if within **T** of the side representative | Families split across sides are listed as `split_family` and do not double-count |
| Winner | Side with the **largest witness count**; exactly one leader wins | Simulation over **158** cases from those 15 titles at **T = 250 ms**: **148** right / **4** wrong / **0** ties, and **6** cases with no right answer available; all 4 wrong are on the mixed-release title. The early exact-match proposal would have declared a conflict on **136 of 152** cases |
| **250 ms vs 400 ms vs 100 ms** | **250 ms** kept | At a **fixed 250 ms correctness bar**, **T = 400** gives the same **aggregate** counts as **T = 250** (148 / 4 / 0; per-case winner equality was not recorded); **T = 100** gives 142 right / 3 wrong / **7** ties. A first comparison that moved the correctness bar along with T was re-run at the fixed bar. Larger T would merge genuinely different releases (median cross-release gap about **1 s**) |
| Tie | **Two or more** equal leaders → decode audio **once**, run A–I on the picked span; `audioSettles` breaks the tie only if exactly one leader is within **T** of the audio map | On available real media with subtitles, text tracks accepted while audio **refused** — **real tie-break by audio is unmeasured** |
| No winner | `embedded_track_conflict` — no Apply, no transcription offer, no **Try piecewise** on this path | Packaged smoke on a synthetic silent MKV with **three** SubRip tracks (two jittered copies of the true timing, ±40 ms, and one track 1 500 ms off) → sides **#1 [1,2]** (2 witnesses) vs **#2 [3]** (1); side 1 wins |
| Failed / sparse track | Listed and skipped; **one usable text track is enough** | Replaces an earlier “incomplete track stops all” sketch |
| Verdict of the winner | The winning side takes its **least permissive** member verdict: if the representative says accept but another member says check, the result is **check** (`alignService.ts`), with the caution label and warning | A side is only as trustworthy as its weakest witness |
| Identity | When the winning map is the identity (already aligned), the representative map is kept and Apply stays enabled, with an extra card note (`AlignPage.tsx`). The final verdict can still be **check**, and then the Apply label and warning follow it | Not reduced to “no Apply when already aligned”, and not upgraded to accept either |
| Codecs | Only bundled-FFmpeg **text** decoders vote; bitmap / undecodable streams are listed, never extracted | Mixed text+bitmap multi-output commands fail atomically on the bundled FFmpeg |

**Text-free timing diagnostic** (`alignmentDiagnostic.ts`, schema `ng-alignment-timing/v1`): stores
input times and a dialogue bit per cue — no dialogue text. Export is allowed only for replayable
**accept/check/refuse** outcomes after a live **Global** embedded pass or **Advanced** run; malformed
preflight, Advanced piecewise-only stops, and similar arms answer **`not_exportable`**. **Open** replays
verdict and arbitration stages but **never** offers Apply (proved in packaged smoke: replay card has
Close only).

**Residual wrong cases.** Simulation at **T = 250 ms** left **4** wrong decisions, **3** majority-wrong
and **1** where the agreeing tracks were all wrong, all on the same title read as mixed releases. **Real feature-length** multi-track tie resolution was
not exercised in this record beyond short MKV smoke (~**40 s** clips in extraction timing tests).

**Lifecycle.** One generation-fenced in-memory candidate (`alignService.ts`); Apply consumes
`{ generation, resultId }` with digest re-checks. Cancel/dispose drops snapshots; diagnostic export
does not create an Apply surface.

**Extraction cleanup is protected by a lease, not by the generation fence.** A cancelled extraction
can leave an FFmpeg child still writing into the scratch folder. The extraction therefore takes the
persistent session lease (`leaseSession`), and only releases it when the child has actually closed
(or never started). The start-up sweep reclaims session folders whose app owner has exited, but not
leased ones, so a folder is never deleted while a child that outlived the app can still write to it.
An in-memory "wait for it" promise was not enough on its own, because it does not survive the app
exiting. A build check covers the case where the owner has ended and the child is still running.

### 10.3 Nuvio AutoSync — **retimer rejected**

Current V2 retimer: global affine + banded DP, confidence gates. On **E66** differentials: **3/8**
planted piecewise cases **accepted** with **42 / 77 / 346** cues **>1 s** wrong; NG refused **8/8**.
V1 Android snapshot only adjusts ±**60 s** player delay — not an SRT rewriter. HTTP Matroska fast path
irrelevant for local Electron files. **C16-8:** no default Nuvio retimer; GPL Kotlin not copied into MIT
NG (label **C16-8**).

### 10.4 ffsubsync

No ffsubsync source or benchmark lives in the public repository. The joint Kodi/Nuvio source review
noted **no ffsubsync attribution marker** in Nuvio trees (provenance only, not a ffsubsync trial).
Product piecewise timing rests on **ALASS** after E63–E69, not on ffsubsync integration.

---

## 11. A–I reason taxonomy (independent-align)

| Reason | Typical cause |
|---|---|
| `ok` | Accept |
| `partial_coverage` | Check — 60–84.9% coverage |
| `malformed` | Structure, round-trip, unwritable times |
| `insufficient` | < 8 dialogue cues |
| `wrong_title` | Low coverage + random correspondence band |
| `weak_correspondence` | Vote/overlap/scale/retained/residual/coverage fail |
| `likely_different_cut` | Local step / edge / mixed-support pattern |
| `invariant_failure` | Post-transform structural break (incl. some ALASS outputs) |

`candidate` in shared types is a **lifecycle** label before NG analysis, not a fourth verdict
(`alignment.ts`).

---

## 12. CHECK flow (“Apply with caution”)

Copy is frozen in `AlignPage.tsx` (`ALIGN_COPY`):

- Label: **CHECK — Partial match**
- Warning (Global): “Only {coverage}% of dialogue cues support **one global map**…”
- Warning (Advanced): “…support **this piecewise alignment**…”
- Action: **Apply with caution…** — same single Save confirmation as accept; no second threshold.

Machine reason remains `partial_coverage`; UI must not collapse check into accept (E72c).

---

## 13. Decisions

### 13.1 Core rules

| Rule | Why | Alternatives rejected |
|---|---|---|
| **COEXIST: NG global default + optional ALASS** | E63 capability vs E63d/E69 unsafe CLI | Full ALASS replace; MIT merge of GPL core |
| **A–I before any Apply** | E63 seven-cue false pass; E69 score↑ on bad piecewise | Trust exit 0 / ALASS score |
| **E66 thresholds frozen in code** | 8/8 piecewise safety on corpus | Post-ship threshold tuning; oracle 0.65 for Align |
| **Global first; piecewise explicit** | User control; E69 catastrophic piecewise moves | Auto-Advanced after refuse |
| **1–4 kHz default detector** | Packaging boundary after E67–E68; gst band not safer | WebRTC default; detector fusion |
| **FE-1 Global-only edge rule** | Stops 40–177 line edge wrong accepts | New check reason; leave pinned limit |
| **FE-2 density on subtitle refs only** | 10 audio false checks if universal | C810 everywhere |
| **FE-4 read-with-repair** | Real transcripts blocked at preflight | Rewrite sorted file; unlimited repair |
| **Bundle M embedded arbitration** | Measured **250 ms** / **50 ms** families; one-pass extract | Per-ms vector equality; first-good-track-wins (Round 7) |
| **No ALASS in oracle / gender** | AL-X7; separate contracts | Single profile |

### 13.2 What would reopen a decision

- Labelled **real** piecewise corpus showing Advanced + A–I accepts known-wrong cuts at scale.
- New ALASS major version without parity receipt.
- Measured proof that 1–4 kHz or WebRTC beats the other on maintainer’s operating-point set **with**
  A–I still passing — might adjust defaults, not remove gate.
- ffsubsync or Nuvio retimer passing the same **8/8** E66-style refuses **and** 138-pair sweep with
  zero new “bad” by the FE sweep definition.

---

## 14. Build checks and live runs

### 14.1 Proven in shipped build (gate suite)

| Area | Gate sections (representative) |
|---|---|
| Oracle Kodi parity | **B.1** |
| Independent thresholds, MAD, boundaries | **B.2** |
| Shared contract, E66 11 + 20 matrix | **R13.1** |
| FE-1 density / edge | **8A FE.1**, **8A FE.2** |
| ALASS sidecar bounds, hash | **R13.4** |
| Advanced UI copy, Try piecewise | **R13.5–R13.6** |
| Media 1–4 kHz vs Advanced WebRTC split | **R13.7** |
| ALASS package unit | **R13.8** |
| Repair write-back | Round **8A** / FE paths in `gates.ts` |
| Embedded-track extract + arbitration | **R9 M.1–M.3** |
| Timing diagnostic export/replay | **R9 M.4–M.5** |

### 14.2 Not seen live (in this record)

- End-to-end Align Apply on maintainer’s full feature library with written acceptance notes.
- ALASS Advanced on a full-length feature in packaged app with a human check of the preview.
- Transcription fallback chain on every media refusal class in one session.

---

## 15. Limits

- **E66 / matrix:** timing-only; cannot prove semantic same-title identity or population rates.
- **138 pairs:** English-heavy OpenSubtitles releases; “bad” is relative to text anchors, not human watch-through.
- **Threshold sweeps** supplied cut positions, derived variants and the **5**-point scoring allowance by
  hand; the product must discover cuts and pairs on its own.
- **1–4 kHz intelligibility claims** in older notes were **not** re-verified from primary acoustics
  sources; the **decisive** evidence is detector A/B + A–I refusal.
- **Transcription fallback** quality depends on [`transcription.md`](transcription.md) — not re-derived here.
- **Multi-track arbitration** cannot fix a file where every text track refuses and audio cannot break a
  tie; **real feature-length** audio tie-break is **unmeasured** (available media showed text accept /
  audio refuse). Simulation still mis-picked **4** cases on one mixed-release title at **T = 250 ms**.

---

## 16. Recommendations

- Treat **`check`** as a first-class outcome: review unsupported sections before Apply; do not merge
  into accept in UI or telemetry.
- On **`likely_different_cut`**, try Advanced only when the user understands piecewise may still refuse
  (Japanese GST case).
- Keep **ALASS** version, SHA-256 and licence bundle locked with packaging gates.
- If adding a new aligner, run the **E66 analog** + release-pair sweep **before** exposing Apply.
- For gender hints, never raise oracle thresholds to “match” Align — different job (`align.ts` comments).

---

## 17. Code and checks

| What | Where | Checks |
|---|---|---|
| Profiles, A–I engine | `electron/engine/align.ts` | **B.1**, **B.2**, **R13.1** |
| Shared verdict contract | `electron/shared/alignment.ts` | **R13.1** |
| Main orchestration, repair, Apply | `electron/main/alignService.ts` | **R13.5**, IPC fixtures |
| 1–4 kHz detector | `electron/main/ffmpeg.ts` (`alignmentFilterChain`, `alignmentSweep`, `audioForAlignment`) | **R13.7**, fallback fixtures |
| ALASS sidecar | `electron/engine/alassSidecar.ts`, `alassReport.ts` | **R13.3**, **R13.4** |
| E66 matrix fixtures | `scripts/gates/fixtures/alignment/global/e66-matrix.ts` | **R13.1** |
| Align UI copy | `src/pages/AlignPage.tsx` | **R13.6**, UI fixtures |
| Read-with-repair | `electron/engine/cueRepair.ts` | **8A**, repair fixtures |
| Embedded-track extraction and arbitration | `electron/main/ffmpeg.ts` (`extractTextTracks`), `electron/main/alignService.ts` | **R9 M.1–M.3** |
| Timing diagnostic (text-free, export only for a replayable result) | `electron/engine/alignmentDiagnostic.ts` | **R9 M.4–M.5** |
| Result store / candidate id | `electron/engine/alignmentResultStore.ts` | **R13.5** |

---

## 18. Label index

| Label | Meaning | Section |
|---|---|---|
| **Bundle C**, "Bundle C item N" | The Align feature as planned; item numbers are its design rules (item 3: fixed ALASS defaults; item 7: re-check ALASS output with the same verdict) | 1 |
| **A–I** | The Global fit pipeline's steps, from coarse search to verdict | 1.3 |
| **E63** | ALASS benchmark + unsafe CLI | 4 |
| **E64–E65** | Sidecar compliance + build parity | 4.4 |
| **E66** | Threshold search + 20-fixture gate | 5 |
| **E67–E68** | Detector A/B + expanded media | 7 |
| **E69** | Japanese ALASS direct check | 8 |
| **E70–E72** | Binding + CHECK copy | 3, 12, 13 |
| **E157** | FE-1/2/4 threshold study + Round 8A | 9.2, 9.3–9.5, 13 |
| **E159** | Bundle M design + tolerance measurements | 10.2.1, 17 |
| **FE-1** | Global edge-cut refusal | 9.3, 13 |
| **FE-2** | Density-gated C810 (subtitle refs) | 9.4, 13 |
| **FE-4** | Read-with-repair | 1.6, 9.5 |
| **Bundle M** | Shipped embedded-track arbitration + diagnostic | 10.2.1, 14.1, 17 |
| **D16-3** | 50 ms track families, one witness | 10.2.1 |
| **D16-5** | In-memory candidate + generation fence (Apply id) | 10.2.1 |
| **AL-P1** | No 1.1.0 Align surface | 2 |
| **AL-X1–AL-X8** | Parity extensions for Align | 13, 15 |
| **R13.x** | Registry-13 implementation gates | 14.1, 17 |
| **§4.1b** | A–I steps A–I | 1.3 |
| **§9.4b** | Bundle B/C planning anchor | 1.2, 5 |
| **C16-8** | Nuvio retimer rejected | 10.3 |
| **R9 M.1–M.5** | Bundle M gate sections | 10.2.1, 14.1, 17 |
