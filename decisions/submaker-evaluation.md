# Stremio SubMaker evaluation: what was measured and what NG adopted

**Decision in one paragraph.** NG studied the open-source Stremio SubMaker subtitle add-on (release
**1.4.94**, AGPL) as a **failure-case library**, not as code to ship. Two research passes pinned the
upstream tree, ran **155** upstream unit tests (**154** pass, **1** skip), **34** initial offline
control-flow probes (**34/34** reproduced), then a **2026-09-20** follow-up with **25/25** deterministic
probes, **39/39** selected upstream regression reruns, a **192**-file RTL corpus with **10/10** libass
comparison renders, and one **free-first** live Gemini translation on **8** real cues (**8/8** output,
**2** generation calls). The maintainer chose **selective reliability adoption**: carry measured
provider, encoding, download, wire-integrity and key-policy **requirements** into NG’s existing TypeScript
owners; reject the server shell, unsafe recovery, canonical RTL injection, parallel engine, idle
keep-alive, and wholesale engine port. VTT/ASS support stays a **separate** strict-format programme, not
SubMaker’s conversion paths. Feature-specific rules live in the linked records below; this file is the
single timeline and disposition.

**Status:** current. **Evidence scope:** pinned upstream **1.4.94** (2026-08-24 tag), deterministic
probes and regressions on that snapshot, private fixture inventory and wire receipts (counts and
booleans only here), one live translation on a compact Latin-script fixture with free-tier key first.
No SubMaker source was ported into NG.

**How to read this file.** Section 1 summarises where the adopted ideas landed in the product (with
pointers). Section 2 is the SRT AI Translator 1.1.0 baseline. Section 3 is the timeline. Section 4 is the full test
campaign. Section 5 maps each adoption to a feature record and lists what was rejected. Sections 6–8
cover build proof, limits and follow-ups. Section 9 is the code map; section 10 is the label index.

Test material is described by type only. No film or series titles and no subtitle dialogue appear here
(see [`README.md`](README.md)).

**Related feature records (detail, not repeated here):**

| Topic | Record |
|---|---|
| Legacy encoding ladder and Start-time bytes | [`encoding-intake.md`](encoding-intake.md) |
| OpenSubtitles quota, archives, SSRF, walk | [`reference-subtitle-download.md`](reference-subtitle-download.md) |
| Previous-source context (not SubMaker’s parallel original-only context) | [`cross-batch-context.md`](cross-batch-context.md) |
| Exact reply check, commits, wire prompt contract | [`native-translation-engine.md`](native-translation-engine.md) |
| Recovery ladder (rejects placeholder success) | [`content-block-recovery.md`](content-block-recovery.md) |
| Free-first pacing, typed errors, no quota shrink | [`free-tier-protection.md`](free-tier-protection.md) |

---

## Models used in testing

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Upstream suite, offline probes, regression reruns, fixture inventory, RTL renders (4.1 to 4.6) | None (offline or stubbed) | — | SubMaker's own code with stubbed network | — | See each section | Sep |
| Live field test (4.7) | `gemini-2.5-flash-lite`, chosen by the probe from 41 listed models | `thinkingBudget: 0` | Sent through SubMaker's own Gemini service, not NG's | Free (Paid available, unused) | 2 counts and 2 generations; 8 lines | Sep 20 |

**Would a different model change the results?** Mostly not. The findings are about **SubMaker's
code**: it drops the custom prompt, duplicates source lines in the request, and its process does not
exit. Those are visible on the wire whatever model answers. The translation quality of the 8 lines was
not a question here, and it would differ by model.

## 1. What the app does today

NG **does not** embed SubMaker, call its server routes, or share its Redis/session architecture. What
shipped instead is a set of **NG-owned** behaviours chosen after the evaluation:

| Measured lesson | Where it lives today |
|---|---|
| Language-scored legacy decoding; valid UTF-8 never reinterpreted; one canonical byte identity at Start | `electron/engine/subtitleInput.ts`, intake gates **A.1–A.2** |
| Regional target labels in the language registry | `electron/shared/languages.ts` (`pt-BR`, `pt-PT`, `es-MX`, `es-ES`, `ar-EG`, …) |
| Typed Gemini outcomes including **unsupported location** vs invalid key | `electron/engine/providers/gemini.ts`, `electron/engine/retry.ts` |
| Bounded provider response bodies (buffered path) | `electron/engine/providers/responseLimit.ts` |
| System Prompt Override on the **final** provider request (contrast with SubMaker’s dropped custom field) | `electron/engine/prompt.ts`, `electron/engine/native/nativeAdapter.ts`, gate **PT24** |
| OpenSubtitles **quota 406** vs other **406**; archive/body guards | `electron/main/opensubtitles.ts` (`isQuota406`), `electron/main/subtitleArchive.ts`, gates **R19 H.5–H.4** |
| Exact-permutation recovery; no `[⚠]` placeholder success | [`content-block-recovery.md`](content-block-recovery.md) |
| Source-only cross-batch context; no duplicate source block in the wire shape NG uses | [`cross-batch-context.md`](cross-batch-context.md) |
| Free-tier pacing; parse failures do not condemn keys | [`free-tier-protection.md`](free-tier-protection.md) |
| RTL: Smart/Classic/canonical derivative model; **no** sixth SubMaker wrapper option | [`rtl-output.md`](rtl-output.md) |
| Translate still **`.srt`-first**; no production ASS/VTT intake from SubMaker converters | Product boundary unchanged (see sections 5.3–5.4) |

SubMaker’s **translation engine** (XML/JSON/numbered/AI-timestamp workflows, server cache, parallel
batches, 45 s provider ping) is **not** present in NG.

---

## 2. What SRT AI Translator 1.1.0 did

SRT AI Translator 1.1.0 never integrated SubMaker. It used gst 3.7.0 for translation, with coarse error handling and no
language-scored legacy encoding ladder comparable to what the evaluation measured in SubMaker’s
`encodingDetector` path. OpenSubtitles behaviour in NG was rebuilt for Feature 2; the evaluation
**informed** quota typing and download guards but did not replace NG’s serial quality-first walk
(see [`reference-subtitle-download.md`](reference-subtitle-download.md)).

---

## 3. Timeline (2026)

| When | What | Outcome |
|---|---|---|
| Aug | Upstream **1.4.94** published (annotated tag on public GitHub) | Snapshot pinned for all probes |
| Sep (exact date not recorded) | First pass: upstream `npm test`, dependency audit, **34** offline probes on translation/control-flow | **155** tests (**154** pass); **34/34** probes reproduced upstream behaviour (including undesirable cases) |
| Sep 20 | Follow-up campaign: source reread, private fixture inventory, **25** deterministic probes, **39** selected upstream regressions, RTL corpus, free-first live wire test | **25/25**, **39/39**; live **8/8** cues; custom prompt sentinel on **neither** generation request |
| Sep 22 | Disposition chosen: selective adoption + separate format research | Requirements assigned to existing bundles/features (encoding, provider, downloads, keys, recovery, RTL) |
| Oct 6 | Provider response bounds (Round 3) and the native translation engine with its final-wire prompt check (Round 4) | **D14T**; **PT24** asserts the override reaches the provider-ready request |
| Oct 7 | Encoding/intake owner shipped (Round 5) | Gate **A.1** corpus and inspect/decode path |
| Oct 14–17 | Cross-batch context (Round 15), free-tier protection (Round 17), OpenSubtitles quota typing and archive guards (Round 19) | Bundle L, Bundle F, **R19 H.4–H.5** |

The October 18 change that made the System Prompt Override additive (it had replaced two built-in rules)
is unrelated to this evaluation: NG's override already reached the wire, which is what **PT24** checks.
See [`native-translation-engine.md`](native-translation-engine.md) section 1.5.

Implementation rounds are dated from the repository history (October 2026 commits); the evaluation itself
completed in September 2026 before those lands.

---

## 4. Tests

### 4.1 Upstream pinned suite (initial pass)

**Setup.** Disposable checkout of **1.4.94**, `npm ci`, upstream test runner on Node **24.18.0** / npm
**11.16.0** (release CI had also passed on Node 20/22/24).

| Metric | Result |
|---|---|
| Regression files listed | **26** |
| Tests executed | **155** |
| Passed | **154** |
| Skipped | **1** |
| Failed | **0** |
| Wall time (reported) | **7.35 s** |

**Analysis.** The suite strongly covers providers, encoding, archives, SSRF, sessions and request
hardening. It does **not** fully regression-test the translation core (no dedicated file for cue-count
recovery, XML/JSON workflows, AI timestamps, or cancellation).

**Conclusion.** Safe to mine behaviour and regressions; **unsafe** to treat green tests as proof that the
translation engine matches NG’s exact-permutation contract.

---

### 4.2 Initial offline control-flow probes (34)

**Setup.** Untracked Node probe against the pinned snapshot; every provider response injected; no live
model call.

| Area | Reproduced behaviour (includes bad behaviour) |
|---|---|
| Custom prompt | Absent from XML, JSON, numbered-original and AI-timestamp prompt builders |
| Parsers | XML/JSON/numbered salvage paths; missing-entry retry; unrecovered mismatch → `[⚠]` + source |
| RTL cleanup | RLE/PDF on every non-empty line; idempotent second pass |
| SRT validator | Accepts arbitrary non-timecode “timing” lines |
| Encoding sample | Windows-1255/1256 decode; UTF-8 not reinterpreted |
| ASS/VTT | Malformed inputs return original bytes after failed conversion |
| Regional labels | `por`, `pob`, `es-MX`, `ar-EG`, `zht` → explicit variant names |
| AI timestamps | Model times replace source times |
| `MAX_TOKENS` | One retry, no split; partial accepted via character-ratio heuristic |
| Keys / parallel | Five-key surface; 503 rotation logged as **429**; no cancel API; pending promise after deadline |

**Count:** **34/34** observations matched source.

**Conclusion.** SubMaker documents many failure modes NG must **avoid** (placeholder success, weak SRT
validation, silent custom-prompt drop, AI timestamps as default). Encoding and regional naming were
positive candidates for NG-owned adoption.

---

### 4.3 Follow-up deterministic probes (25)

**Setup.** Research script (not published) driving SubMaker modules from the pinned snapshot against
synthetic cases, stubbed HTTP, and private manifest metadata (no dialogue printed). Categories:

| Category | Count | What was asserted |
|---|---:|---|
| ASS/VTT validation and conversion | **9** | Valid VTT/ASS round-trips; malformed mixed fail-open paths; weak `validateSRT`; derived real-SRT VTT/ASS round-trips |
| Final-wire / request fields | **4** | Custom prompt dropped in all four engine workflows; duplicate source in XML/JSON/numbered batches; AI workflow omits context; direct adapter can carry custom text when bypassing engine builders |
| Provider errors | **3** | Location vs quota vs overload taxonomy; `promptFeedback` without candidates → prohibited class; `MAX_TOKENS` partial accepted |
| OpenSubtitles | **3** | Quota vs generic **406**; response-body classifier; informational error serialized as parseable SRT |
| Bounded responses | **3** | Axios buffered and stream `maxContentLength` enforced; oversized Gemini body non-retryable |
| Multi-key / rate | **3** | Five-key config without free/paid tier field; 503 retry receipted as **429**; five generic errors cool key with no error-kind input |

**Result:** **25/25** reproduced.

**Analysis.**

- **Wire integrity:** The custom-prompt sentinel never reached generation in engine workflows, while
  target language, safety settings and generation config did. XML/JSON/numbered paths duplicated each
  batch’s source text in the outgoing body; the AI-timestamp workflow sent one copy and dropped batch
  context.
- **Errors:** Unsupported location stayed distinct from invalid key; quota and overload stayed distinct
  in the centralized parser even when retry policy overlapped.
- **Downloads:** Quota **406** text was classified differently from “file id not available” **406**.
- **Bounds:** Local **256 KiB** payload against a **32 KiB** ceiling rejected buffered and streaming
  reads (mirrors the need for NG transport ceilings).
- **Keys:** Rotation had no tier semantics; key health punished generic error counts.

**Conclusion.** These probes became **acceptance tests by reference** for NG’s provider seam, download
typing, and key policy—not for copying SubMaker’s engine.

---

### 4.4 Selected upstream regression reruns (39)

**Setup.** After the follow-up script, **six** upstream regression files were rerun in isolation with
forced process exit (same pinned snapshot):

| Suite focus | Pass |
|---|---:|
| OpenSubtitles error/quota distinctions | **5/5** |
| OpenSubtitles auth/relogin/key cache | **9/9** |
| Remote download URL / SSRF / redirect / size guards | **10/10** |
| OpenSubtitles prefetch/download guard | **5/5** |
| Encoding detector regressions | **5/5** |
| Custom-provider request/response-bound regressions | **5/5** |

**Total:** **39/39** pass, **0** fail.

**Conclusion.** NG’s OpenSubtitles and encoding gates were aligned to behaviours this suite already
guarded in upstream; NG re-proved them when hardening archives and quota typing.

---

### 4.5 Private fixture inventory (follow-up)

**Setup.** Inventory tool recorded paths and hashes only; stdout aggregates metadata (no keys, no
subtitle text).

| Asset class | Count / result |
|---|---|
| Media files (AAC, FLAC, M4A, MKV, MP3, MP4) | **14** (**14/14** ffprobe ok) |
| Subtitle files | **196** (**193** detected SRT; **3** legacy/invalid UTF-8 without safe decode) |
| Encoding observation | **187** UTF-8 BOM, **6** UTF-8, **3** legacy/invalid |
| Script observation (not language truth) | Hebrew **18**, Arabic-family **12**, Cyrillic **31**, Han **3**, Latin **149** |
| BiDi controls already in files | **4** |
| Keys supplied for live work | **2** (free + paid labels); live test used free only |

**Analysis.** No independently authored ASS/SSA/VTT fixtures were in the workspace; format tests relied
on synthetic malformed files and SRT-derived VTT/ASS. Media were inventoried but **not** sent to Gemini
(SubMaker translates subtitles, not transcribe-from-video).

**Conclusion.** Strong for encoding and RTL corpus work; **insufficient** to certify wild ASS/VTT
preservation.

---

### 4.6 RTL wrapper corpus and libass renders

**Setup.** SubMaker’s target-language RLE/PDF wrapper applied to every parseable private SRT; separate
RTL probe script; **10** FFmpeg/libass comparison renders (Canonical, Smart, Classic, SubMaker arms).

| Metric | Result |
|---|---|
| Parseable files | **192** |
| Cues | **151 115** |
| Encodings observed | **189** UTF-8 BOM, **2** cp1255, **1** cp1256 |
| Structure/idempotence checks | **0** failures |
| Libass comparisons completed | **10/10** |

Simulation highlights (RTL target selected):

| Observation | Count |
|---|---:|
| Cues changed | **148 569** |
| LTR-only cues changed (no prior BiDi markers) | **123 731** |
| Non-empty lines wrapped | **202 737** of **205 855** |
| Cues skipped whole-cue due to existing marker | **2 546** |
| RTL-bearing cues byte-identical to Smart RTL | **24 151** of **27 207** |
| Renders SubMaker pixel-identical to Smart | **7/10** |

**Analysis.** Zero integrity failures show the wrapper is mechanically stable. It is still **too broad**
for NG’s canonical text model: most LTR-only cues change solely because the target language is RTL.
Mixed Hebrew/Pashto controls favoured Smart over SubMaker ordering in visual inspection; Urdu could not
be ranked without a reader.

**Conclusion.** Keep SubMaker’s wrapper as a **compatibility test arm** only; do **not** add a sixth
user-facing RTL method (see [`rtl-output.md`](rtl-output.md)).

---

### 4.7 Free-first live Gemini field test

**Setup.** Live probe chose a compact Latin-script fixture by metadata (not filename); free key first;
paid key available but unused; only wire booleans/counts in the public receipt.

| Item | Result |
|---|---|
| Model discovery | **41** generation-capable models listed |
| Selected model | `gemini-2.5-flash-lite` |
| Input cues / characters | **8** / **343** |
| Batches | **2** × **4** cues |
| Elapsed | **2180 ms** |
| Output cues | **8/8**; timecodes preserved; **8/8** text changed; **0** placeholder cues |
| Output script observation | Hebrew **212** characters; Latin **0** |
| RTL wrapper on output lines | **13/13** non-empty lines edge-wrapped |
| Request sequence | countTokens → modelMetadata → generateContent → countTokens → generateContent |
| Per-generation `maxContentLength` | **67 108 864** (64 MiB) on **both** calls |
| Target + safety + generationConfig on wire | **Yes** |
| Custom-prompt sentinel on wire | **No** on **both** generations |

**Duplicated request content (both generation calls):**

| Call | Pattern |
|---|---|
| First batch | Each of the four source lines appeared **twice** in the request body |
| Second batch | Current four lines twice; prior batch’s **last two** lines also present as context |

**Process lifecycle.** The live process imported SubMaker server/storage/network helpers, finished
quickly, but did not exit cleanly within **three minutes** and had to be terminated—corroborating
avoidance of the server shell (Redis/storage handles present; not attributed to the 45 s ping alone).

**Conclusion.** Free-first translation worked on real fixture size; the **custom-prompt drop** and
**duplicate source/context shape** are confirmed on live wire, not only stubs. NG’s **N14** / **PT24**
contract exists precisely to prevent the silent-drop class.

---

## 5. Decisions

### 5.1 Adopt: requirements mapped to owners (not SubMaker code)

| Requirement | Rule | Why | Record / code |
|---|---|---|---|
| Legacy encoding ladder | Score Windows code pages with language hints; never reinterpret valid UTF-8; block ambiguous Start | Initial **34** probes + **5/5** encoding regressions + private inventory | [`encoding-intake.md`](encoding-intake.md), **A.1** |
| Regional targets | Explicit registry entries for measured variants | Reduces ambiguous `por`/`es` targets | `languages.ts` |
| Typed provider errors | Separate invalid key, permission, unsupported location, quota, rate, overload, network, block, malformed, response-too-large | **25** probe matrix + live taxonomy needs | [`free-tier-protection.md`](free-tier-protection.md), `gemini.ts`, `retry.ts` |
| Final-wire prompt gates | Every enabled field asserted on provider-ready body; system override after immutable rules | SubMaker dropped custom prompt on **all** workflows and live **2/2** calls | [`native-translation-engine.md`](native-translation-engine.md), **PT24**, **N14** |
| Response bounds | Count bytes before parse; non-retryable over-limit | SubMaker uses 64 MiB axios ceiling; probes proved buffered/stream enforcement | `responseLimit.ts`, **D14T** |
| OpenSubtitles typing | `isQuota406`; body classification; archive limits; no partial search as complete **5** error/quota + **9** auth/relogin + **10** remote-download + **5** prefetch upstream regressions, plus **3** deterministic OpenSubtitles probes | [`reference-subtitle-download.md`](reference-subtitle-download.md), **R19 H.5** |
| Free-first multi-key policy | Sticky free route; paid only with consent; no rotation on parse/recovery | Live free success; SubMaker lacks tier semantics | [`free-tier-protection.md`](free-tier-protection.md) |
| Exact recovery | No placeholder success; no character-ratio `MAX_TOKENS` acceptance | Initial **34** probes + error probes | [`content-block-recovery.md`](content-block-recovery.md) |
| Cross-batch context | Source-only, bounded window; not parallel worker original-only context | SubMaker parallel mode weakens context vs NG contract | [`cross-batch-context.md`](cross-batch-context.md) |

### 5.2 Reject: architecture and behaviours

| Alternative | Why rejected |
|---|---|
| **Whole-engine port** (Option B) | AGPL tree, Redis/session server, weak translation success semantics, no cancellation API, idle keep-alive (~**25 000+** idle requests/day reported upstream), parallel mode, placeholder output |
| **Immediate ASS/VTT via SubMaker converters** (Option C) | Malformed paths return mixed artifact types; proportional ASS tag reinsertion; no real authored fixtures; contradicts frozen `.ass` boundary until a new format programme |
| **Provider gates only** (Option D) | Leaves encoding and regional targets unaddressed |
| **No adoption** (Option E) | Discards **25/25** + **39/39** + live wire evidence |
| SubMaker **server shell** in NG | Live process hang with storage/network imports; wrong fit for desktop single-user runs |
| **Anonymous fallback** after authenticated OS download failure | Would hide auth state |
| **Speculative multi-provider** background downloads | Violates user-action walk |
| **45 s provider keep-alive** | Idle traffic storm |
| **Targeted missing-index retry + XML default** as shipped engine | Left as **research candidates** only; NG keeps strict JSON index/text and recursive split ([`content-block-recovery.md`](content-block-recovery.md)) |
| **Sixth RTL method** (SubMaker wrapper) | **123 731** LTR-only cues changed in simulation; canonical/derivative boundary; Smart matched or beat in renders |

### 5.3 Defaults

| Topic | Default | Notes |
|---|---|---|
| SubMaker code in product | **Off** (absent) | Permanent |
| SubMaker RTL wrapper in UI | **Off** (not offered) | Test arm only |
| Free-first translation | **On** where Free-Tier Protection applies | See free-tier record |
| System Prompt Override | Blank; when set, **must** reach the wire | Checked by **PT24** since the native engine was built; SubMaker's drop is the failure it guards against |
| ASS/VTT intake | **Off** (unsupported) | Separate future feature |

### 5.4 What would reopen the decision

- A controlled bake-off showing ID-tagged XML or targeted missing-index retry beats NG’s exact-permutation
  ladder **without** placeholder success, on NG’s operating batch sizes.
- Independently authored ASS/VTT fixture campaigns (**≥20** valid + **≥20** malformed per format, not
  SRT-derived) proving strict preservation.
- Player evidence that Smart RTL fails where SubMaker’s wrapper succeeds **and** the case is common.
- Upstream SubMaker release materially changing encoding, quota typing, or wire semantics (re-pin and
  re-run the **34+25** probe set).

---

## 6. Build checks and live runs

| Claim | Proven in shipped build | Proven live |
|---|---|---|
| Encoding ladder + corpus | **A.1**, **A.2**, Round 5 | Private corpus informed labels; not every file re-run live |
| Quota **406** vs other **406** | **R19 H.5** | Stub + upstream regressions; not every live OS quota shape |
| Archive/SSRF/size guards | **R19 H.4**, **H.5**, **D14** archive receipts | Wizdom/archive probes in reference record |
| Response body ceiling | **D14T**, `responseLimit.ts` | Gemini transport; SubMaker 64 MiB observed on live SubMaker call only |
| Final-wire prompt fields | **PT24** | NG native wire; SubMaker live showed drop on **their** engine |
| Free-first pacing | Bundle F gates | [`free-tier-protection.md`](free-tier-protection.md) Oct 15 packaged runs |
| Custom prompt on NG wire | **PT24** | SubMaker's live test showed the drop on **their** engine; NG's behaviour is proven by checks |
| 8/8 cue translation quality | — | Live on SubMaker stack only (quality not blind-judged here) |
| Natural 429 exhaustion + paid consent | Partial gates | Not burned intentionally in SubMaker campaign |
| Kodi/VLC/MPC-HC/mpv RTL matrix for SubMaker arm | Smart/Classic gates | SubMaker arm libass **10/10** only |

---

## 7. Limits

- **Translation quality** of SubMaker vs NG was not blind-reviewed in this campaign; structural/wire
  evidence dominated.
- **Feature-length** batch behaviour was not re-tested on SubMaker live (one **8**-cue fixture).
- **ASS/VTT** evidence is largely synthetic or SRT-derived; malformed behaviour is **inconsistent** across
  SubMaker paths.
- **RTL render** evidence is libass-only for the SubMaker arm; player matrix remains NG’s Bundle D gate.
- **Dependency audit** on the pinned lockfile showed **1** high and **3** moderate advisories against a
  later advisory DB (release CI was clean at tag time)—another reason not to import the tree wholesale.
- **Licence:** AGPL vs MIT noted; disposition was technical selective adoption, not a SubMaker fork.

---

## 8. Recommendations

1. Treat SubMaker as a **regression oracle**: when OpenSubtitles or encoding edge cases appear, check
   whether upstream **1.4.94** already has a regression file before inventing a new probe shape.
2. Keep **format intake** on a separate track ([`encoding-intake.md`](encoding-intake.md) for bytes;
   future VTT-before-ASS programme for containers).
3. Do **not** revive SubMaker’s XML/numbered default or placeholder recovery without a formal comparison
   at NG batch sizes.
4. If idle provider traffic is ever considered, require proof of zero background calls when the app is
   idle—SubMaker’s 45 s ping is the counterexample.

---

## 9. Code and checks

| File | Role in this disposition | Gate section (representative) |
|---|---|---|
| `electron/engine/subtitleInput.ts` | Encoding/language owner inspired by measured detector | **A.1**, **A.2** |
| `electron/shared/languages.ts` | Regional target registry entries | Language/registry gates in **A.1** / UI parity |
| `electron/engine/providers/gemini.ts` | Unsupported location, auth typing | Provider sections in Bundle F / **PT24** |
| `electron/engine/providers/responseLimit.ts` | D14 response envelope | **D14T** |
| `electron/engine/prompt.ts` | Prompt assembly + **N14** override | **PT24** |
| `electron/engine/native/nativeAdapter.ts` | Native translate seam | **PT24**, native engine sections |
| `electron/engine/retry.ts` | User-visible error mapping | Bundle F / retry gates |
| `electron/main/opensubtitles.ts` | `isQuota406`, download state | **R19 H.5** |
| `electron/main/subtitleArchive.ts` | Shared archive limits | **R19 H.4** |
| `electron/engine/recover.ts` | Rejects placeholder success path | Bundle G / recovery gates |
| `scripts/gates/gates.ts` | All sections above | — |

Research scripts that produced the **25** probes and live receipt are maintained locally and are **not**
published with the app.

---

## 10. Label index

| Label | Meaning in code | Section |
|---|---|---|
| **N14** | System Prompt Override must reach the provider when set | 4.7, 5.1, 6 |
| **D14-5** | Provider response byte ceiling before parse | 4.3, 5.1, 6 |
| **PT24** | Final-wire translation prompt receipt | 4.7, 5.1, 6 |
| **A.1 / A.2** | Subtitle inspect/decode/intake | 4.4, 5.1 |
| **R19 H.5** | OpenSubtitles quota typing and download branches | 4.4, 5.1 |
| **D14T** | Transport-level response size proof | 4.3, 6 |
