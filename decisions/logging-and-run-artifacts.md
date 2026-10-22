# Logging parity and run artifacts

**Decision in one paragraph.** Every reserved run gets a readable `.console.log` (no off switch) and an
additive machine `.run.jsonl` record; neither replaces the other, and neither is a dump of the folded
run panel. One artifact session in `electron/engine/runArtifacts.ts` owns all sidecars, receives every
`RunEvent` once before IPC, and projects five formats with separate eligibility rules. Optional
Translate reports (`.progress.log`, `.thoughts.log`, `.tokens.json`) and the Transcribe token report
follow gst 3.7.0 suffixes and shapes where they apply; whole-file snapshots are replaced atomically so
a crash never leaves a half-written report. `.progress.log` is a human diagnostic only and never
authorises Continue. Panel folding caps at 200 + 1,800 visible lines; the console file caps at 8 MiB
head + 512 KiB tail with a 64 KiB per-line ceiling. Defaults: Show Token Usage **ON**; Write Token
Report, Progress Log and Thoughts Log **OFF**.

**Status:** current. **Evidence scope:** parity capture and independent review (Sep 2026); build gates
(LOG1, RUN1, LG28, P4-G6, G4, G9) and the console probe script through release 1.0.0; gst 3.7.0
behaviour from the fork baseline and captured engine notes (not re-run live in this record). Live
multi-hour runs with every toggle combination were not measured here.

**How to read this file.** Section 1 is what the code does today (mechanics also summarised in
[`ARCHITECTURE.md`](../ARCHITECTURE.md)). Section 2 is SRT AI Translator 1.1.0 / gst 3.7.0. Section 3 is the timeline,
section 4 the tests, section 5 the rules and why. Sections 6 to 10 are build proof, limits,
recommendations, the code map and the label index.

---

## Models used in testing

No test in this record called a live model. The build checks and the packaging probe drive the real
run, file and log code with a **stand-in provider** that returns fixed replies. Model names such as
`gemini-3.5-flash-lite` and `gemini-3.7-flash` appear only as run settings, so the headers and records
have something to show.

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Panel folding and cap, G4 / G4b (4.1) | None (pure functions, no network) | — | Synthetic log streams | — | 5 cases, up to 9,900 input lines and 3,000 distinct lines | Not recorded |
| Console file fidelity, G9a to G9e (4.2) | None | — | Injected size limits | — | 3 cases (60-line run, one 100 KiB line, sidecar naming) | Not recorded |
| Settings placement and toggle states, LOG1 (4.3) | None (static reads and settings round-trips) | — | — | — | All 16 combinations of the four switches | Oct 5 (Round 2) |
| Runner reservation and console on failures, RUN1 (4.4) | Stand-in engines | — | Injected I/O and failures | — | Throw after reserve, busy slot, no key after reserve, redaction | Not recorded |
| Native Translate reports matrix, LG28 (4.5) | Stand-in provider | — | Six-line fixture, real run and file code | — | 3 outcomes × 16 report settings = 48 runs, plus fault runs | Oct 6 (Rounds 3–4) |
| Run record, P4-G6 (4.6) | Stand-in provider | — | Native Translate and Transcribe through the shipped runner | — | Completed, failed, stopped, guarded and busy runs | Oct 12 (Round 13) |
| Packaging probe, `run-consolelog.mjs` (4.7) | Stand-in provider | — | Real run paths; completed, failed, stopped and refused runs | — | Assertion count grows with releases | Each release |

**Would a different model change the results?** No. What is written, when, and how faults are handled
is the same whichever model answers. The only model-dependent content is what the model returns: for
example, whether it sends thought summaries for `.thoughts.log`, which is why an empty thoughts file is
still written when none arrive.

## 1. What the app does today

### 1.1 One owner, event-before-IPC

`electron/engine/runner.ts` opens exactly one `openRunArtifacts()` session when the job slot is
reserved (before guards, preflight, or engine work). For each non-terminal event it calls
`artifacts.record(event)` and only then delivers the event to the renderer (`runner.ts` around the
`record` / `deliver` pair). Terminal `finished` events go through `artifacts.finalize()` first so
`logPaths`, warnings, and closed files are complete before the UI sees the ending.

Providers and pages never open run files; only `runArtifacts.ts` uses `exclusiveFile` for sidecars
(gates **RUN1** source checks).

### 1.2 The five projections

| Artifact | When attempted | Consumer / role |
|---|---|---|
| `.console.log` | Every **reserved** run (Translate and Transcribe) | Human diagnosis; **Show it** opens this via `findConsoleLog` |
| `.run.jsonl` | Every reserved run | Machine replay: schema-1 JSONL, one redacted event per line |
| `.progress.log` | Native Translate, `progressLog` ON at reservation, after work begins | Human progress snapshot; not read for resume |
| `.thoughts.log` | Native Translate, `thoughtsLog` ON, after work begins | Thought **summaries** only, via `recordThoughtSummary` |
| `.tokens.json` | `writeTokenReport` ON; Translate after work began; Transcribe after ≥1 provider request | Usage report; gst key order plus a `native` section |

The console is built from typed events (`projectNative` in `runArtifacts.ts`): a native header and
facts line, then only `log` lines the panel also receives—no `[redrawn N times]` folding. The
effective user description is **console-only**; it is not copied into `RunEvent`, IPC, or JSONL
(`RunArtifactSnapshot.description`).

JSONL rows use `runRecordEvent()` and `redact()` (`electron/engine/redact.ts`); thought summary
text never enters JSONL or the console—only optional `.thoughts.log`.

### 1.3 Lifecycle and fault behaviour

- **Never reserved** (model guard, busy slot): no session, `logPaths: []`, no files (gates **RUN1**,
  **P4-G6** busy case).
- **Reserved then failed** (no key, UTF-8, preflight, spawn): `started` still fires; console and run
  record are finalised when possible; optional reports are **not** created because `working` never
  became true (guard ending in **LG28**).
- **Fail-soft:** a fault on one artifact adds one `artifact` warning and withholds that path only; the
  subtitle outcome stays authoritative (`runArtifacts.ts` header and `finalize`).

Optional reports use **claim once, replace whole**: write to a pid-staged sibling, `fsync`, then
`renameOver` with retries (`REPORT_RENAME_RETRY_DELAYS_MS`: 5, 10, 20, 40, 80 ms—documented as
clearing 8 000/8 000 renames in a stress run in code comments). A failed replace leaves the previous
complete snapshot on disk (**LG28** fault cases).

The run record appends one JSON line at a time with synchronous writes; a successful append has written
every byte of the row. An append that fails part-way, or a process killed between writes, can leave an
incomplete final row: nothing truncates it. On a detected write fault, recording stops and the finished
run does not offer the record (one warning says why); the run's own result is unaffected. Completed rows
are flushed to disk (`fsync`) after **32** rows
(`RUN_RECORD_SYNC_ROWS`), on the next append once **2 s** have passed since the last flush
(`RUN_RECORD_SYNC_MS`; there is no timer, so a quiet run is not flushed until its next row), and always
for the terminal row. An app crash loses nothing already written, because the operating system still
holds the written rows; a system crash or power loss can lose every row written since the last flush.
No tighter power-loss bound was measured.

### 1.4 Bounds (from code constants)

**Exported console / shared string clamp** (`electron/shared/consoleLog.ts`):

| Limit | Value |
|---|---|
| Head | 8 × 1024 × 1024 bytes |
| Tail | 512 × 1024 bytes |
| Per line | 64 × 1024 bytes |
| Truncation marker | `[log truncated]` |

**Run record** (`runArtifacts.ts`): per-string clamp uses the same 64 KiB as the console;
`RUN_RECORD_BUDGET_BYTES` = head + tail (8.5 MiB); list items capped at
`32 + 4 × admittedUnits`; schema version 1.

**Run panel** (`src/lib/logView.ts`): `HEAD_LINES` = 200, `TAIL_LINES` = 1800 (200 + 1,800 cap);
repeat folding uses frames up to `MAX_FRAME` 200 and detection window `MAX_DETECT_FRAME` 40. This
is independent of the console file limits (`consoleLog.ts` documents why exporting the panel array
would violate **FP-3**).

### 1.5 Settings and defaults

Persisted keys in `electron/main/store.ts` defaults:

| Setting | Default | Writes a file? |
|---|---|---|
| `showTokenStats` | **true** | No—controls the in-run token grid only |
| `writeTokenReport` | **false** | `.tokens.json` when ON |
| `progressLog` | **false** | `.progress.log` when ON (Translate only) |
| `thoughtsLog` | **false** | `.thoughts.log` when ON (Translate only) |

The Logs section (`src/pages/SettingsPage.tsx`) states that `.console.log` is always **attempted**
after reservation, has **no off switch**, and that `.progress.log` is **not resume state**. Four
toggles moved from Advanced to Logs in development Round 2 without changing keys or defaults (**LOG1**).

Preferences are frozen at reservation into `RunArtifactPreferences`; mid-run Settings edits do not
change the open session.

### 1.6 Resume vs progress log

In-memory transcription state and durable checkpoints live in `electron/engine/progress.ts` and
`electron/main/resumeStore.ts` (`checkpoint.json` under the app resume directory). Comments there
(**BR-13**) forbid writing that state as `.progress` or `.progress.log`. User `.progress.log` is only
the optional diagnostic snapshot from `runArtifacts.ts`.

---

## 2. What SRT AI Translator 1.1.0 did (gst 3.7.0 and the Electron shell)

At the fork, the desktop app **spawned gst 3.7.0** rather than owning translation calls. Logging parity
meant preserving what that stack already offered:

| Capability | SRT AI Translator 1.1.0 behaviour |
|---|---|
| Console file | `.console.log` beside the output stem; opened exclusively with stepped names; synchronous line writes; same 8 MiB / 512 KiB / 64 KiB policy (`consoleLog.ts`) |
| Console content | Masked argv line from gst, then stdout/stderr passed through terminal-noise rules (**REP-26**) before append |
| Live panel | Parsed stdout fed `appendLogLine` with folding and the 200 + 1,800 cap (**FP-3**) |
| `.progress.log` / `.thoughts.log` | Written by **gst** beside the input-derived paths when CLI flags were set; whole-file rewrite pattern captured from gst `logger.py` (read from the gst 3.7.0 source, not re-quoted here) |
| `.tokens.json` | Written by gst at end of run when enabled; Save could retarget paths to the user's subtitle folder |
| Machine resume | Separate **`.progress`** file owned by the engine—not the user-facing `.progress.log` |
| Settings | Same four booleans lived under Advanced; defaults **true / false / false / false** (verified on the fork baseline and still in `store.ts`) |
| Transcribe | Application exposed console and token report flows; gst's Transcribe progress/thought flags were **not** treated as shipped UI capability |

NG replaces the CLI with native engines but keeps suffixes, Save sidecar rules, and the readable
console contract. JSONL (`.run.jsonl`) is **new** and additive (**DLOG-2** intent, implemented Phase 4).

---

## 3. Timeline (2026)

| When | What | Outcome |
|---|---|---|
| Sep 2026 | Branch-complete parity capture for logging | Four toggles, panel vs file console, Save sidecars, reservation vs pre-reserve failures documented |
| Sep 18 | Independent review of the design | Six gaps found and fixed before building: the reservation boundary, safe `started.config` versus masked command-line arguments, zero-byte thoughts files, an RTL numbering collision, all 16 toggle combinations, and consistency between documents. A second review found nothing further |
| Oct 5 | Round 1 (Phase 0) | Typed `RunEvent` stream |
| Oct 5 | Round 2 (LOG.1) | Logs section in Settings; keys unchanged |
| Oct 6 | Rounds 3–4 (Phases 1–2) | Native Transcribe and Translate; artifact session first form; native Translate optional reports with the 16×3 preference matrix and fault injection (**LG28**) |
| Oct 12 | Round 13 (Phase 4) | Native-only engine; `.run.jsonl` run record (**P4-G6**); command-line engine removed |
| Oct 15 | Round 17 (Bundle F) | Token grid and report on Transcribe; one token writer |
| Oct 18 | Release 1.0.0 | Shipped behaviour this record describes |

---

## 4. Tests

### 4.1 Panel folding and cap (G4 / G4b)

**Setup:** Pure functions in `src/lib/logView.ts`, driven from `scripts/gates/gates.ts` **G4** and
**G4b**—no network.

| Case | Count / size | Result | Analysis |
|---|---|---|---|
| Exact repeat `A B A B` | 4 lines in | 1 block, count 2, both lines visible | Collapsing must not hide distinct text |
| Changing progress integers | Stream of distinct lines | No collapse | Progress must remain readable |
| Synthetic flood | 900 repetitions of an 11-line frame (9,900 input lines) | 1 block, count 900, 11 lines shown | Matches **REP-12**-scale redraw |
| Growing-history fixture | 173 raw lines | 12 distinct messages shown | Frame growth capped by **MAX_FRAME** |
| Head/tail cap | 3,000 distinct lines | Head line 0 and tail line 2999 kept; gap marker counts 1,000 hidden | 200 + 1,800 contract |

**Conclusion:** Panel rules stay as in SRT AI Translator 1.1.0; they are explicitly **not** the console export path
(`consoleLog.ts` lines 4–9).

### 4.2 Console file fidelity (G9a / G9d / G9e / G9b / G9c)

**Setup:** `createConsoleLog` with injected limits in gates.

| Case | Result |
|---|---|
| 60-line run over tiny head budget | Start preserved, `[log truncated]` marker, end line 60 present, middle count reported |
| Single 100 KiB line with 64 KiB cap | Line cut with per-line marker; not split mid-UTF-8 |
| Sidecar Save naming | `.console.log`, `.progress.log`, `.tokens.json`, `.run.jsonl` each keep full compound suffix |

**Conclusion:** File console keeps **REP-1 / REP-3** shape; independent of panel folding.

### 4.3 Settings placement and 16 toggle states (LOG1)

**Setup:** Static reads of `SettingsPage.tsx`, `store.ts`, sanitise paths in gates.

- Navigation order: Output → **Logs** → Advanced (once each).
- Each of the four controls appears once, only under Logs.
- Defaults asserted **true / false / false / false**.
- All **16** boolean combinations survive sanitise and a round-trip through `setSettings` without
  silent rewrite.

**Conclusion:** Moving UI did not change persistence (**DLOG-6**).

### 4.4 Runner reservation and console on failures (RUN1)

**Setup:** In-process runner with injected engines and I/O; includes native adapter throw-after-reserve,
busy slot, post-reserve no-key, and redaction checks.

**Conclusion:** Artifacts bind to **reservation**, not spawn success; busy/pre-reserve never create files;
console bytes pass `redact()` once at write site.

### 4.5 Native Translate reports matrix (LG28)

**Setup:** Six-line Translate fixture, mocked provider, real `startRun` + `runArtifacts` I/O. Three
outcomes (completed, failed, stopped) × **16** preference masks = **48** runs, plus dedicated fault runs.

| Check | Result |
|---|---|
| Frozen prefs vs args | `started.config` reflects snapshotted report flags, not contradictory args |
| Offer order | Enabled reports (tokens → progress → thoughts), then `.run.jsonl`, then `.console.log` last |
| Disabled reports | Absent from disk and from `logPaths` |
| `.progress.log` shape | Latest status line, blank line, distinct stderr/warning diagnostics; no translated cue text |
| `.thoughts.log` | gst-style 80-char rule lines; retry headings; zero-byte file when enabled but model sent no summaries (**sanctioned enhancement** over gst omitting the file) |
| `.tokens.json` | gst key order and spacing, plus `native` pacing buckets |
| Fault: final progress write throws | Warning; prior snapshot still parseable; subtitle completes |
| Fault: early progress write throws, later succeeds | Offered with final "Completed" line, no warning |

**Conclusion:** Optional artifacts fail soft; atomic replace semantics behave as designed.

### 4.6 Run record (P4-G6)

**Setup:** Native Translate/Transcribe through shipped runner; parse every `.run.jsonl` row.

| Run type | Record offered? | Row checks |
|---|---|---|
| Translate completed / failed / stopped | Yes | schema 1, contiguous sequence, one `runId`, `started` first, `finished` last |
| Transcribe completed | Yes, beside preselected output | Same |
| Guard after reservation | Yes | Rows include `started`, `error`, `finished` (non-log) |
| Busy (never reserved) | No file created | |

Delivered events match `runRecordEvent()` projection; `findConsoleLog` still returns the **last**
path—never the JSONL file.

**Conclusion:** JSONL is additive; console remains the human link (**DLOG-2**).

### 4.7 Packaging probe (run-consolelog.mjs)

**Setup:** Script drives real `startRun` paths (documented in `ARCHITECTURE.md` acceptance table).

**Conclusion:** Exercises end-to-end console + record on completed, failed, stopped, and refused runs
with redaction and header shape checks. Exact assertion count grows with releases; it is a required
release companion to the gate sections above.

---

## 5. Decisions

### 5.1 JSONL is additive, not a replacement

**Rule:** Always attempt `.run.jsonl` alongside `.console.log` for reserved runs; issue templates ask
for the record first and the console second as companions, not substitutes.

**Why:** Machine fields (allow-listed events, pacing, usage) serve automation; humans still need the
readable console with masked-description parity and line-for-line panel alignment.

**Rejected:** Replacing `.console.log` with JSONL only.

**Reopen if:** A format can be shown to satisfy both automation and **Show it** readers without the
console projection.

### 5.2 One lifecycle owner, distinct projections

**Rule:** Single session; separate writers per suffix; eligibility frozen at reservation.

**Why:** Avoids duplicate handles, keeps redaction central, and prevents the renderer from inventing
sidecars.

**Rejected:** Provider-local log files; renderer-exported logs.

### 5.3 Events before IPC

**Rule:** `record` / `finalize` on the artifact session precede renderer delivery.

**Why:** Save and **Show it** must see closed, complete files; JSONL must not race the UI.

### 5.4 Progress log ≠ resume state

**Rule:** Never read `.progress.log` for Continue; checkpoint schema stays in `resumeStore` /
`progress.ts`.

**Why:** gst already separated its machine `.progress` file from the human log, and NG keeps that
separation. The log is an optional, best-effort snapshot: it may be missing, stale or from a failed
write. Continue must only ever start from verified, committed progress, which the checkpoint provides
with fingerprints ([`continue-and-retry.md`](continue-and-retry.md)).

**Rejected:** Reusing `.progress.log` as resume input.

### 5.5 Atomic whole-file snapshots

**Rule:** Progress, thoughts, and token reports use staged write + rename; last successful snapshot wins.

**Why:** gst rewrote these logs whole, so at a random instant a crash or a full disk could leave a
half-written file. Staging and renaming means the file on disk is always the last complete snapshot.
**LG28** injects write faults to prove it: a failed final write leaves the previous snapshot parseable.
Real crashes and full disks were not reproduced.

### 5.6 Panel limits ≠ exported log limits

**Rule:** Panel: 200 + 1,800 lines with folding; console file: 8 MiB + 512 KiB + 64 KiB line clamp.

**Why:** Folding exists because uncapped panel rendering froze the window (**FP-3**); exporting the
folded array would drop middle content and hide repeats behind counters—exactly wrong for post-mortems.

**Rejected:** Exporting the panel buffer; one shared cap for UI and disk.

### 5.7 Other rejected options (from the parity review)

| Alternative | Why rejected |
|---|---|
| Generic combined "logging" toggle | Four independent user intents (live grid, JSON report, progress diary, thought summaries) |
| Duplicate Settings controls | Would desynchronise persisted keys |
| Silent Transcribe progress/thought files | Not SRT AI Translator 1.1.0 application capability; scope stated in UI tips |
| Persisting full provider bodies in JSONL/console | Security and subtitle leakage; structural diagnostics only |
| Direct truncate-in-place of reports | Superseded by atomic replace for crash safety |

### 5.8 Defaults

**Rule:** `showTokenStats: true`; all file-writing toggles **false** unless the user enables them.

**Why:** Matches SRT AI Translator 1.1.0; live token grid is low cost; file sidecars can be large and may contain
diagnostic or thought-summary text (tips warn about subtitle text in thoughts).

---

## 6. Build checks and live runs

**Proven in gates / probes:**

- Reservation-bound artifact lifecycle (**RUN1**, **P4-G6**, **LG28** guard case).
- 16-way toggle matrix for native Translate reports (**LG28**).
- Console head/tail/line caps (**G9a**, **G9d**).
- Panel folding invariants (**G4**, **G4b**).
- LOG1 Settings structure and defaults.
- Save sidecar suffix integrity (**G9b**, **P4-G6** Save rows).
- Fault injection on report create/write (**LG28** fault block).

**Not re-measured for this record:**

- Side-by-side byte comparison of every gst 3.7.0 console line vs native for a full feature-length run.
- All 16 toggle combinations on **Transcribe** (only Translate matrix in **LG28**).
- Live ENOSPC or antivirus rename races beyond the injected I/O faults and the 8 000-rename comment
  in `runArtifacts.ts`.

---

## 7. Limits

- Evidence for gst **logger.py** field order rests on captured 3.7.0 source read during design; that
  capture was **not available** in the workspace when this record was written—gst shape checks rely on
  gates (**LG28**) and code comments citing gst line ranges.
- Thought summaries may include subtitle-related text; only secrets are redacted, not content.
- Run record stops offering if total size would exceed ~8.5 MiB; the run continues.
- JSONL omits description text, system prompt, Quota Group labels, and thought bodies by design
  (**DLOG-8** / redaction allow-list).

---

## 8. Recommendations

- When debugging a user run, ask for **`.run.jsonl` first** and `.console.log` second; do not scrape
  the panel alone.
- If adding a sixth sidecar, extend `runArtifacts.ts` and `KNOWN_SIDECAR_SUFFIXES` together—never
  a second owner.
- Do not wire `.progress.log` into Continue without a new decision; use checkpoint schema instead.
- Keep `[log truncated]` semantics stable; support and diff tools key off the marker string.

---

## 9. Code and checks

| File | Role | Gate sections ( `scripts/gates/gates.ts` ) |
|---|---|---|
| `electron/engine/runArtifacts.ts` | Session, projections, finalize | **LG28**, **RUN1**, **P4-G6** |
| `electron/engine/runner.ts` | Reservation, record-before-deliver | **RUN1**, **NG2**, **NA19** |
| `electron/shared/consoleLog.ts` | Console caps, suffix helpers | **G9a**, **G9d**, **G9e**, **G9b**, **G9c** |
| `src/lib/logView.ts` | Panel fold/cap | **G4**, **G4b** |
| `src/pages/SettingsPage.tsx` | Logs UI copy | **LOG1** |
| `electron/main/store.ts` | Defaults | **LOG1** |
| `electron/engine/redact.ts` | JSONL/console redaction | **RUN1**, **P4-G6** |
| `electron/engine/progress.ts` | Resume schema (not `.progress.log`) | Resume gates (separate from this feature) |
| `scripts/verify/run-consolelog.mjs` | Packaging console probe | Release acceptance (see `ARCHITECTURE.md`) |

Mechanics table: [`ARCHITECTURE.md`](../ARCHITECTURE.md) — "The files a run leaves".

---

## 10. Label index

Short labels in code comments are mapped here to the sections above that explain them.

| Label | Meaning | Section |
|---|---|---|
| **DLOG-6** | Logs Settings section | 1.5, 5.8 |
| **DLOG-8** | Safe `started.config` vs console-only description | 1.2, 7 |
| **LOG.1** | Settings move only | 3, 4.3 |
| **REP-1** | Console / token report parity capture | 2, 4.2 |
| **REP-3** | Console head/tail ceiling | 1.4, 4.2 |
| **REP-26** | CLI terminal-noise reduction (retired with CLI) | 2 |
| **FP-3** | Panel fold/cap motive | 1.4, 5.6 |
| **BR-13** | Forbid resume data in `.progress.log` | 1.6, 5.4 |
| **G3b** | Token report shape | 1.2 |
| **E74** | Independent review repairs (Sep 2026) | 3 |
| **E75** | Independent review passed (Sep 2026) | 3 |
