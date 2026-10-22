# Smart RTL and right-to-left subtitle output

**Decision in one paragraph.** Saved SubRip files for right-to-left targets are prepared at export time,
not inside the translation engine. **RTL subtitle formatting** is **ON** by default with method **Smart
RTL** (`hybrid`): line-aware `U+202B`…`U+202C` (RLE…PDF) wrapping that respects styles, mixed
Hebrew/Latin lines, and five known target languages (Hebrew, Arabic, Persian, Pashto, Urdu). Four other
methods remain selectable: **Hebrew Compatibility** (Kodi’s safe Hebrew line wrap), **Classic RTL** (gst
3.7.0’s whole-cue wrap for parity with the previous app), **Basic-Player RTL** (Kodi’s physical
punctuation move for players that ignore direction controls), and **Old Subtitle Repair** (Kodi’s
leading-punctuation repair for already-damaged old files). Turning formatting **Off** hides the method
picker but keeps the stored method and writes **logical canonical text** with no display shaping.
Analysis, gender, alignment, context and repair always read canonical text, never the display copy.

**Status:** current. **Evidence scope:** structural and corpus tests on **192** real subtitle files
(**151,115** cues); **40** fresh model-generated cues across five RTL languages; **60/60** bundled
FFmpeg/libass frames on ten cases; a **96-row** visual matrix on mpv, VLC, MPC-HC and Kodi with four
real fixtures; deterministic gate fixtures in `scripts/gates/gates.ts` (Round 11, Bundle D). Primary
acceptance language: **Hebrew**. Other named RTL languages were measured and must not regress.

**How to read this file.** Section 1 is what the code does. Section 2 is what the previous app did.
Section 3 is the timeline. Sections 4–10 are the test campaigns. Section 11 is the decision and why.
Section 12 covers build checks and live runs. Sections 13–16 are limits, recommendations, the code map
and label index. Wrong-alphabet repair on Hebrew targets is documented separately in
[`wrong-alphabet-repair.md`](wrong-alphabet-repair.md). Translation batching and engine behaviour are in
[`native-translation-engine.md`](native-translation-engine.md).

---

## Models used in testing

Most of this record is about how players render right-to-left text, which no model is involved in.

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Kodi / gst evaluation, method probe, corpus, libass renders (4, 5, 6, 8) | None | — | Offline code on saved text | — | 192 files; 15 fixtures; 60 frames | Sep 19 |
| Live model output (7) | `gemini-3.7-flash` | Not sent (the model's own default) | Temperature 0, JSON reply, 8 lines into each of 5 right-to-left languages | Free, then Paid | 5 successful calls, 40 lines | Sep 19 |
| Four-player matrix, live-translated fixtures (9) | `gemini-3.5-flash-lite` | Low | Through the bundled gst engine | Free | 2 translations, Hebrew and Arabic, 8 lines each | Oct 11 |
| Release R-09: long Hebrew transcription with marks (12.2) | `gemini-3.7-flash` | Low | Smart RTL set in Settings | Free first, Paid fallback on | One 71-minute transcript, 1,264 cues | Oct 18 |
| Release T-10: non-RTL target (12.2) | `gemini-3.5-flash-lite` | Low | English → French | Free first, Paid fallback on | One case | Oct 18 |

**Would a different model change the results?** Not for the method choice, the per-player behaviour or
the corpus invariants. Those come from the app's export code and the players, so they hold for any
model's text. The one model-dependent question is whether a model **inserts its own direction marks**
or mixed-direction text into its reply. Section 7 shows that `gemini-3.7-flash` produced clean
right-to-left script in 40 lines. It does not show that every model does, and other translation models
were not tested for this.

## 1. What the app does today

### 1.1 Settings and defaults

| Setting | Default |
|---|---|
| RTL subtitle formatting | **ON** (`rtlEnabled !== false`) |
| RTL display method | **Smart RTL (Recommended)** (`hybrid`) |

The five internal method ids and dropdown order are fixed in code:

| Order | Internal id | User-facing label |
|---:|---|---|
| 1 | `hybrid` | Smart RTL (Recommended) |
| 2 | `kodi_rtl_base` | Hebrew Compatibility |
| 3 | `gst_compatibility` | Classic RTL |
| 4 | `kodi_reverse` | Basic-Player RTL |
| 5 | `kodi_legacy` | Old Subtitle Repair |

When formatting is **Off**, the method label, dropdown and help are not shown; the chosen method stays
in settings and returns when formatting is turned back on. Invalid or unknown stored method ids sanitize
to `hybrid` in the view without rewriting the profile on disk.

Known RTL languages for Smart RTL’s “trusted target” arm: **Hebrew, Arabic, Persian, Pashto, Urdu**
(including common aliases such as `iw` → Hebrew and ISO names). Everything else uses a conservative
**line-dominance** fallback: wrap only when visible strong RTL letters outnumber visible strong LTR
letters on that line.

### 1.2 The five methods (behaviour)

All methods are **pure functions** over cue text. They never change cue count, index, timestamps or line
order. Each save **derives again from canonical logical text**: gst’s whole-cue RLE…PDF wrapper is
**stripped once** at the cue edge before any method runs, so wrappers never nest in normal use.

| Method | Scope | What it does |
|---|---|---|
| **Smart RTL** | Five RTL targets + unknown fallback | Per-line wrap when the line has RTL letters and (known target **or** RTL-strong dominance); wraps RTL runs inside style tags; safe Latin handle tails inside an RTL cue may inherit wrap |
| **Hebrew Compatibility** | Hebrew lines only | Same line/tag wrap as Kodi `rtl_base` without multi-style tag deletion |
| **Classic RTL** | Any RTL-dominant **cue** | gst 3.7.0 rule: count strong direction over the **raw cue** (including markup and controls); one RLE…PDF around the whole cue if RTL wins |
| **Basic-Player RTL** | Hebrew-shaped lines | Kodi `_reverse_fix_one_text_line`: moves trailing sentence punctuation to the physical start and dialogue dashes toward the end |
| **Old Subtitle Repair** | Hebrew-shaped lines | Kodi `_fix_one_text_line`: moves leading punctuation back toward the logical end; leading ellipses stay |

Punctuation and dialogue dashes: Smart RTL and Hebrew Compatibility rely on **Unicode direction
controls**, not on moving punctuation bytes. Basic-Player RTL and Old Subtitle Repair **physically
reorder** punctuation; corpus tests showed they can **remove** redundant marks (see section 6).

### 1.3 Where formatting applies

| Path | Language context for Smart RTL | Output |
|---|---|---|
| **Translate → Save** (`.srt` temp) | Accepted run **target language** | Derivative via atomic `.rtl-tmp` sibling, then replace destination |
| **Transcribe** | User-confirmed spoken code (D5-17) when dedicated path; else unknown | Partial stays canonical; destination gets derivative on success |
| **Off** | — | Canonical logical bytes (after edge strip only when re-saving a gst-wrapped temp) |

Only **`.srt`** destinations run through `rtl.ts`. Other extensions (for example `.ass`) copy bytes
unchanged, matching the previous app’s Save behaviour.

### 1.4 What never sees the display copy

Gender detection, alignment, repair JSON, hashing and cross-batch context use **canonical cue text**.
The display copy is for players only (an architectural rule taken from the Kodi add-on review: analysis
uses `for_delivery=false` canonical bytes).

---

## 2. The starting point: what SRT AI Translator 1.1.0 did

Shipping **gst 3.7.0** (bundled with the previous app) already wrapped **translation and transcription**
output:

- For each cue, count Unicode strong bidi classes on the **raw text** (R + AL + RLE + RLI versus L +
  LRE + LRI).
- If RTL strictly wins, store `U+202B` + text + `U+202C`; otherwise store text unchanged.
- **Always on** — no Settings toggle, no target-language gate, no method choice.
- **Whole-cue** wrap: one RLE…PDF pair around the entire cue, including newlines and outer style tags.
- Existing controls were **not** stripped, so re-processing could nest wrappers.
- Translate **Save** copied engine bytes verbatim; transcription wrote gst’s file directly.

The Electron shell had **no** RTL Settings surface; users received gst’s formatting whenever cue text
was RTL-dominant. **Classic RTL** in NG reproduces that shape when regenerated from canonical text
(with edge strip so it does not double-wrap).

**gst 3.8.3** moved the same algorithm into `session.py` but did not add a user-facing method or fix
whole-cue / idempotence issues.

---

## 3. Timeline

| When (2026) | What | Outcome |
|---|---|---|
| Sep 19 | Review Kodi addon **0.2.548** (RTL identical in supplied **0.2.542** / **0.2.543** trees), gst 3.7.0/3.8.3, parity capture | Corrected baseline: SRT AI Translator 1.1.0 **does** execute gst RTL; Bundle D is a **derivative** redesign, not a new feature from zero |
| Sep 19 | Synthetic five-method probe (**15** text fixtures) | Hybrid structurally beat exact Kodi base (tag loss) and gst (non-idempotent reapply) |
| Sep 19 | Real corpus campaign | **192/192** files, **151,115** cues; final Smart RTL **zero** invariant failures |
| Sep 19 | Live generation probe | **40/40** cues, five RTL targets, `gemini-3.7-flash` |
| Sep 19 | libass render probe | **60/60** frames, ten cases × six methods |
| Sep 19–20 | Independent review found problems in the first design; they were fixed, and a second review found none | Export ownership, language registry and UI contract frozen (D12-1…D12-17) |
| Oct 10–11 | Round 11 (Bundle D) implemented and validated | Settings, `rtl.ts`, Save/Transcribe adapters, gates D.1–D.6 |
| Oct 11 | Four-player matrix | **96** rows; Smart RTL **PASS 12/12** clean Hebrew/Arabic fixture×player cells |
| Release testing | Packaged app checks | Defaults, five methods, Save shape, Hebrew transcript marks (see section 12) |

---

## 4. Kodi and gst evaluation (September 19)

### 4.1 Setup

Read the public **Kodi POV IL** subtitle addon at **0.2.548** (standalone package max in the maintainer’s
dist stream that day) and extracted **gst 3.7.0** / **3.8.3** RTL commit paths. Compared product shape:
settings methods (`rtl_base`, `reverse`, `legacy`, `off`), line-aware Hebrew wrap, physical reverse mode,
canonical versus `.povil-rtl` delivery copy, and gst’s always-on whole-cue counter.

### 4.2 Conclusions

| Finding | Decision |
|---|---|
| gst already wraps RTL-dominant translation **and** transcription | Default formatting stays **ON**; move shaping to **export**, not engine session state |
| gst 3.8.3 adds no better algorithm | Do not port 3.8.3’s session mutation; offer **Classic RTL** as explicit parity |
| Kodi `rtl_base` is stronger for Hebrew SRT | Port **line-aware** wrap, but **not** the branch that drops inline tags on multi-style lines |
| Kodi `reverse` / `legacy` are narrow Hebrew tools | Expose with **warning labels**; never default |
| Whole-addon port rejected | Exclude mojibake/glyph/cache machinery; **five-method** selective port only |
| **RLI/PDI** not measured on players | Deferred; **RLE/PDF** kept (shipping gst + Kodi history + libass campaign) |

---

## 5. Synthetic method probe (September 19)

### 5.1 Setup

Research script `rtl_method_probe.py` (not published). **15** hand-written
text fixtures: English, Hebrew, mixed Hebrew/Latin/numbers/parentheses, Latin continuation, styles
(single, multiple, nested, malformed), dialogue dash, leading ellipsis, Arabic, Persian, Urdu,
pre-wrapped gst text, two-cue CRLF SubRip.

### 5.2 Results

| Method | Visible characters | Tags | Idempotent on own output | Notes |
|---|---|---|---|---|
| Smart RTL | Kept | Kept | **Yes** | Preserved two-cue structure; Arabic/Persian/Urdu active |
| Hebrew Compatibility (adapted Kodi base) | Kept | Kept | **Yes** | Hebrew-centric |
| Classic RTL (gst rule) | Kept | Kept | **No** on direct reapply | Matches gst lack of pre-strip |
| Basic-Player / Old Subtitle Repair | Kept | Kept | — | Punctuation moves only |
| Exact Kodi RTL base | Kept | **Lost on multi/malformed style fixtures** | — | Matches addon `srt.py` |

### 5.3 Analysis

The first **Hybrid** prototype was structurally promising but **not** sufficient for release: it reused
Kodi legacy normalizer, validated tags **per line**, and treated **any** RTL code point as sufficient.
Real corpus work (section 6) disproved all three; the synthetic probe still justified investing in Smart
RTL over exact Kodi base and raw gst reapplication.

---

## 6. Real corpus evaluation (September 19)

### 6.1 Setup

Research script `rtl_real_corpus_probe.py` (not published). Every `.srt` in the maintainer’s private
subtitle collection was parsed — **no sampling**.

### 6.2 Inventory

| Measurement | Count |
|---|---:|
| Files found / parsed | **192 / 192** |
| Total cues | **151,115** |
| UTF-8 with BOM / cp1255 / cp1256 | 189 / 2 / 1 |
| Multi-line cues | 54,716 |
| Tagged cues | 3,291 |
| Cues with visible strong RTL text | 26,917 |
| Mixed RTL + Latin cues | 1,741 |
| Cues with existing BiDi controls | 3,408 controls in 4 files |

### 6.3 Final method results (corpus)

| Method | Cues changed | Structure / visible text / tag failures | Idempotence failures |
|---|---:|---|---|
| Smart RTL (unknown-language fallback) | 25,177 | **0** | **0** |
| Smart RTL (known RTL target) | 26,917 applicable | **0** | **0** |
| Adapted Kodi RTL base | 19,336 | 0 | 0 |
| Basic-Player RTL | 12,270 | 0 visible; **89** cues lost punctuation | 0 |
| Old Subtitle Repair | 8,115 | 0 visible; **25** cues lost punctuation | 0 |
| Classic RTL | 25,467 | 0 | **25,467** (direct reapply nests controls) |

Punctuation removed by Kodi physical modes (inherited behaviour): Basic-Player removed **177** marks
across **89** cues (161 periods, 14 commas, 2 question marks); Legacy removed **25** marks across **25**
cues. Exact supplied Kodi RTL base additionally lost **12** tag sets and **25** punctuation marks versus
the safe NG Hebrew Compatibility port.

### 6.4 Applicability

| Arm | Cues transformed | Role |
|---|---:|---|
| Known RTL target + line-aware Smart RTL | 26,917 | Intended full coverage |
| Unknown + line RTL > LTR | 25,177 | Avoids isolated Hebrew-block **contamination** on mostly-Latin cues |
| Classic RTL whole-cue rule | 25,467 | Missed **1,450** known-target RTL cues; **290** extra cues already had BiDi controls |

**1,740** cues were added by trusted language context versus **1,741** measured mixed-script cues — the
corpus refuted a simple “any RTL character” rule.

### 6.5 Port verification (Round 11)

After `rtl.ts` was written, the same corpus probe was run against the shipped engine implementation:
**0 mismatches** across all **151,115** cues for Smart RTL (known and unknown arms) and the other four
methods (six variants total).

---

## 7. Live model output (September 19)

### 7.1 Setup

Research script `rtl_gemini_live_probe.py` (not published). **Eight** distinct
English source cues × **five** targets (Hebrew, Arabic, Persian, Pashto, Urdu). Model:
**`gemini-3.7-flash`**. Free key tried twice per target (ten attempts: three `503`, seven `429`); paid
key succeeded once per target.

### 7.2 Results

| Metric | Result |
|---|---:|
| Successful calls | 5 |
| Returned cues | **40 / 40** |
| Prompt + candidate + thinking tokens (final capture) | 1,541 + 1,683 + 4,047 = **7,271** |

Every response used ids 1–8 with strong target-script RTL text. On fresh output: Smart RTL **40/40**
transformed with structure, visible text and tags preserved and **idempotent**; Classic RTL **40/40**
transformed but not idempotent; Hebrew-only Kodi modes **no-op** on non-Hebrew targets; Legacy **no-op**
on clean new text. Seven Hebrew cues exposed cross-line `<i>` spans; final Smart RTL treats tags as
**opaque cue-spanning tokens**.

---

## 8. libass render probe (September 19)

### 8.1 Setup

Research script `rtl_libass_render_probe.py` (not published). Bundled **FFmpeg
8.1.2** with `subtitles` filter (libass). **Ten** cases: six live-generated (styled/multi-line Hebrew,
mixed Hebrew dialogue, Arabic, Persian, Pashto, Urdu) plus four high-confidence real-corpus Hebrew/Arabic
snippets. **Six** methods per case: Canonical, Smart RTL, Kodi RTL base, Classic RTL, Basic-Player,
Legacy → **60** PNG frames and contact sheets (not published; only the aggregate results are reported here).

### 8.2 Results

| Observation | Count / detail |
|---|---|
| Render failures | **0 / 60** |
| Hebrew: Smart RTL vs adapted Kodi base pixels | **Identical in all four Hebrew cases** |
| Hebrew styled case: Canonical / Classic / Legacy | Terminal punctuation on wrong visual edge |
| Hebrew: Smart RTL / Kodi base | Terminal punctuation and dialogue dashes on expected RTL edges |
| Six non-Hebrew cases | Three Hebrew-specific Kodi modes **pixel-identical to Canonical**; Smart RTL and Classic **differ** from each other and from Canonical |
| Classic RTL vs Canonical | **Not** a universal visual win (sometimes identical, sometimes worse than line-aware Smart RTL on Arabic-script cases) |

### 8.3 Conclusion

libass is **one real renderer**, not a player matrix. It supported choosing **line-aware RLE/PDF** over
whole-cue Classic for Hebrew punctuation/dash placement, and confirmed Smart RTL ≠ Classic on Arabic-script
layouts. It did **not** establish universal player compatibility (section 9).

---

## 9. Four-player visual matrix (October 11)

### 9.1 Setup

Player matrix receipt: `scripts/gates/fixtures/rtl/player-matrix.md` (parsed by gate **R11 D.6**). **Four** players: **mpv**
0.41.0 (libass), **VLC** 3.0.24 (freetype), **MPC-HC** 2.8.3.2, **Kodi** 21.3 (stock profile, no RTL
addon). **Four** fixtures of **8** cues each, saved only through the app’s own `saveSubtitleCopy` /
`saveRecipeFor` (same code as Translate Save):

| Fixture | Purpose |
|---|---|
| **A-he** | Eight English cues live-translated to **Hebrew** via the bundled CLI engine |
| **A-ar** | Same cues live-translated to **Arabic** |
| **B-he** | AI Hebrew with **Latin inside** (abbreviations, mixed second lines) |
| **C-he** | Human **old-style Hebrew** with reversed punctuation (leading `.` `?` `,` `"`) |

Fifteen distinct on-disk files (some methods byte-identical). **96** matrix rows = 4 players × 4 fixtures
× (Off + five methods). Verdict rules: end punctuation at the **left** for RTL readers, dialogue dash at
the **right**, Latin and numbers ordered correctly, no tofu, styles preserved.

### 9.2 Summary results

| Claim | Result |
|---|---|
| Smart RTL PASS on **clean** fixtures A-he, A-ar, B-he | **12 / 12** player×fixture cells (**PASS** everywhere) |
| Hebrew Compatibility on Hebrew fixtures | **Same bytes as Smart RTL** where both apply (A-he, B-he) |
| Off on VLC / MPC-HC / Kodi | **FAIL** (predicted): unwrapped lines laid out LTR |
| Classic RTL on two-line cues | **FAIL** on VLC, MPC-HC, Kodi (predicted **SRT AI Translator 1.1.0**): whole-cue wrapper closes on line 2, so line 2 has no RLE; italic cue fails when wrapper sits outside `<i>` |
| Basic-Player RTL on direction-aware players | **FAIL** (predicted): moved punctuation at wrong edge |
| Fixture C-he (damaged file) | Smart RTL **FAIL** (predicted **not-a-repair**): formatting does not repair reversed legacy punctuation |
| Old Subtitle Repair on C-he | Partial logical repair, **FAIL** on VLC/MPC-HC/Kodi (**repair-scope**): repaired lines have no direction controls → LTR layout |
| Hebrew-only methods on A-ar | **No-op** (same file as Off) — **PASS/FAIL** matches Off |

### 9.3 Kodi port line parity (fixtures B-he, C-he)

Basic-Player RTL and Old Subtitle Repair outputs were compared line-by-line to Kodi **0.2.548**
`srt.py` functions run under Python 3.14: **50** lines, **0** mismatches.

### 9.4 File held open while playing

Replace-while-playing test on Smart RTL A-he: **VLC** refused replace (`EPERM`, file intact); **mpv**,
MPC-HC and Kodi allowed replace. Save therefore surfaces “file open” for VLC without damaging the open
file.

---

## 10. Non-Hebrew no-op and parity proofs

| Test | Result |
|---|---|
| Corpus: Hebrew-only methods on Arabic/Persian text | No transformation (by design) |
| Live **40** cues: Kodi base / reverse on ar, fa, ps, ur | No-op |
| Gate **D.6**: Arabic fixture, `kodi_rtl_base`, `kodi_reverse`, `kodi_legacy` | Output unchanged vs input |
| Smart RTL on A-ar | **PASS** all four players (12/12 includes Arabic) |
| Translate to French (release test) | **No** RTL marks with Smart RTL on LTR target |

Hebrew remains the **primary** visual acceptance language; Arabic received full matrix and corpus
coverage as a **bonus** that must not be deliberately broken.

---

## 11. Decisions and why

### 11.1 Defaults: ON + Smart RTL

| Rule | Why | Alternatives rejected |
|---|---|---|
| **RTL subtitle formatting ON** | Preserves what SRT AI Translator 1.1.0 users already got from gst, but at the correct **derivative** boundary | OFF default would silently change player-facing behaviour for existing Hebrew/Arabic workflows |
| **Smart RTL (`hybrid`) default** | Zero corpus failures; best clean-fixture player matrix; line-aware fix for VLC/MPC-HC/Kodi second-line failures | **Classic RTL** alone leaves multi-line and `<i>` cues wrong on common players; exact **Kodi base** deletes tags on real files |
| **Hebrew Compatibility second** | Pixel-identical to Smart RTL on measured Hebrew libass cases; fallback if a player disagrees with Smart RTL | Promoting Hebrew-only method would drop Arabic/Persian/Pashto/Urdu coverage |
| **Classic RTL third** | Explicit **SRT AI Translator 1.1.0-shaped** escape hatch; byte-identical to gst temp on Round 11 fixtures | Not default because whole-cue wrap fails second lines on VLC/MPC-HC/Kodi |
| **Basic-Player RTL fourth** | Only for players that **ignore** direction controls; corpus punctuation deletion | Default would harm normal libass/VLC users |
| **Old Subtitle Repair fifth** | Repairs **old reversed files**, not new output; no-op on clean model text | Hiding it broke maintainer requirement to expose all active Kodi methods with honest labels |

### 11.2 Architecture rules

| Rule | Why |
|---|---|
| Canonical engine temp / native partial stays logical | Gender, align, context and resume must not ingest display shaping |
| Regenerate from canonical on every Save | Method switching and gst pre-wrap never stack controls |
| `.srt` only | `.ass` output is not supported by the native engine (an accepted reduction); other extensions are copied unchanged |
| Unknown Transcribe language → fallback arm | No guessing `zxx` or detector hints into a known RTL context |
| Parse/transform failure → no partial destination write | A data-loss finding from the independent design review (D12-15) |

### 11.3 What would reopen the decision

- A **FAIL** on Smart RTL in the player matrix **without** a documented predictor (material mismatch).
- Evidence that **RLI/PDI** renders more reliably than RLE/PDF on the maintainer’s player set.
- A regression in corpus invariants (cue count, visible text, tags) after a code change.
- Deliberate reduction of the five-language Smart RTL scope without maintainer sanction.

---

## 12. Build checks and live runs

### 12.1 Proven in gates (Round 11, Bundle D)

| Section | What it enforces (representative) |
|---|---|
| **R11 D.1** | Defaults ON + `hybrid`; five methods; sanitize unknown; Off retains method; five RTL languages |
| **R11 D.2** | Five methods pure; gst edge strip; structure preserved; Classic matches gst shape; Smart RTL per-line |
| **R11 D.3** | `.rtl-tmp` sibling, fsync, atomic replace; faults do not destroy prior destination |
| **R11 D.5** | Settings UI copy; Save/Transcribe adapters; Off hides method |
| **R11 D.6** | Player matrix schema; Smart RTL PASS on clean fixtures; predictors on every FAIL |

Round 11 gate run (D.5 boundary): **3489** passed, **0** failed.

### 12.2 Release and packaged checks (excerpt)

| Id | Result |
|---|---|
| A-02 | Fresh defaults include Smart RTL **on**, method Smart RTL |
| S-20 | RTL off hides method; on shows all **five** ids |
| T-09 | Save: same cue shape for every method; Off has no direction marks; words unchanged |
| T-10 | EN → French: no RTL marks |
| R-09 | Long Hebrew native transcript: **1263/1264** cues Hebrew; **1263** carry Settings RTL marks |

### 12.3 Not seen live (or narrow scope)

- Every combination of player × language × method beyond the **96** matrix rows.
- **PotPlayer**, **Plex**, **Jellyfin**, **Stremio**, mobile clients.
- Smart RTL on **fixture C-he**-style damaged files (by design: run Old Subtitle Repair first. Applying Smart RTL directly to damaged files was not measured and would be a separate future change).
- **`gemini-3.7-flash`** live probe is one model/day; not all translation models re-tested.

---

## 13. Limits

- **Player evidence is finite.** Four desktop players, four fixtures, eight cues each — strong for
  Hebrew/Arabic clean output, not a universal guarantee.
- **Physical modes delete punctuation** on some real cues (corpus counts in section 6.3).
- **Old Subtitle Repair** does not add direction controls; on LTR-first players its repaired lines still
  read wrong unless combined with a display method (not shipped as a chain today).
- **Classic RTL** matches SRT AI Translator 1.1.0 including weaknesses on multi-line and styled cues on VLC/MPC-HC/Kodi.
- **Transcribe with a general model** has no confirmed spoken language, so it uses Smart RTL's
  unknown-language arm (line dominance) even when the language is obvious from metadata.
- When Round 11 was built, Transcribe could still run through the old gst command-line engine, which was
  post-processed the same way. That engine was retired in Phase 4; native is now the only engine.

---

## 14. Recommendations

- Start with **Smart RTL**; switch to **Hebrew Compatibility** only for Hebrew display issues on a
  specific player; use **Classic RTL** when matching the previous app’s whole-cue output; use
  **Basic-Player RTL** only if the player ignores Unicode direction controls; use **Old Subtitle
  Repair** only on legacy reversed-punctuation files, not on new translations.
- If VLC is playing the file, close it or choose another name before Save — the writer correctly refuses
  replace while VLC holds the file open.
- When adding a new RTL target language, extend `normalizeRtlLanguage`, help text, corpus fixtures and
  player rows together; do not imply automatic support via open-ended copy.
- Treat **RLI/PDI** as a controlled experiment requiring a new player matrix before any default change.

---

## 15. Code and checks

| What | Where | Gate sections |
|---|---|---|
| Five methods, `rtlCopy`, `rtlCueText` | `electron/engine/rtl.ts` | **R11 D.2** |
| gst edge strip | `electron/engine/srt.ts` (`stripCueEdgeControls`) | **R11 D.2** |
| RTL language registry | `electron/shared/languages.ts` (`normalizeRtlLanguage`) | **R11 D.1** |
| Defaults and sanitize | `electron/main/store.ts`, `electron/main/migrations.ts` | **R11 D.1** |
| Settings labels and order | `src/pages/SettingsPage.tsx` | **R11 D.5** |
| Save recipe and derivative | `electron/main/ipc.ts` (`saveRecipeFor`, `saveSubtitleCopy`) | **R11 D.3**, **D.5** |
| Atomic `.rtl-tmp` writer | `electron/engine/output.ts` | **R11 D.3** |
| Native Transcribe destination copy | `electron/engine/transcribe.ts` (`destinationCopy`) | **R11 D.5** |
| Native adapter RTL snapshot | `electron/engine/native/nativeAdapter.ts` | **R11 D.5** |
| Player matrix receipt | `scripts/gates/fixtures/rtl/player-matrix.md` | **R11 D.6** |

Research probes (not shipped in the app bundle): `rtl_method_probe.py`, `rtl_real_corpus_probe.py`,
`rtl_gemini_live_probe.py`, `rtl_libass_render_probe.py` (maintainer-local tooling).

---

## 16. Label index

| Label | Meaning | Section |
|---|---|---|
| D12-1 | One toggle + method dropdown; Off hides picker | 1.1, 11 |
| D12-2 | Five named RTL languages in help | 1.1, 10 |
| D12-9 | Final Smart RTL contract (language-aware, no canonical punctuation repair) | 1.2, 6, 11 |
| D12-10 | ON + Smart RTL default | 1.1, 11 |
| D12-13 | Method order | 1.1, 11 |
| D12-14 | User-facing labels and tooltip text | 1.1 |
| D12-15 | Save/Transcribe derivative ownership | 1.3, 11 |
| D12-16 | `normalizeRtlLanguage` and caller context | 1.1, 1.3 |
| E80 | RTL evaluation identity and gst baseline correction | 3, 4 |
| E82 | Real corpus + live + libass measurements | 6, 7, 8 |
| E85–E87 | Independent design review, repair and re-review | 3, 11 |
| RTL-P1…P9 | Parity inventory for pre-NG baseline | 2 |
| F8 | Native engine does not embed gst RTL (Bundle D closes gap at export) | 1.3, 12 |
