# Finding and downloading a gender reference subtitle

**Decision in one paragraph.** For Hebrew-target translation, the app can align each source line to a
human reference subtitle in another gender-marking language and use that text in the model prompt (see
[`gender-reference.md`](gender-reference.md)). **Automatic download** is OpenSubtitles-only: one search
by TMDB/IMDb identity, then a **serial** walk in quality order (Hebrew, Arabic, Hindi, …), up to **five**
downloads per language and a **run cap** frozen from the service’s first reported allowance. Only files
OpenSubtitles marks as **not** machine-translated are tried; Wizdom is **manual picker only**, default
**off**, and never enters the walk or gender eligibility. Credentials are optional: an own API key and/or
login, else a **shared key pool** like the Kodi add-on. Every file fetch is guarded (redirect hops, DNS,
proxy routing, archive limits). If nothing aligns, translation still runs without a reference.

**Status:** current. **Evidence scope:** live OpenSubtitles and Wizdom probes on **2026-10-16** (metadata
captured in maintainer research notes); gate sections **R19 H.4–H.6, H.8–H.11** (178 new assertions in
Round 19, whole suite **4084** passed at the Round 19 commit); packaged release checks **S-27, T-25, T-26a** and related
rows in the release acceptance checklist (English→Hebrew and one other pair where noted). No sustained live burn of
daily OpenSubtitles quota beyond those probes and normal maintainer runs.

**How to read this file.** Section 1 is what the code does today. Section 2 is SRT AI Translator 1.1.0. Section 3 is the
timeline. Sections 4–12 are probes, design reviews, and Round 19 hardening. Section 13 lists decisions.
Section 14 separates gate proof from live runs. Sections 15–17 are limits, recommendations, and the code map.

**Related (out of scope here):** using the reference in prompts and repair ([`gender-reference.md`](gender-reference.md)),
experimental Hebrew switches ([`gender-extras.md`](gender-extras.md)), independent SRT alignment
([`subtitle-alignment.md`](subtitle-alignment.md)).

---

## Models used in testing

Finding and downloading a reference subtitle calls **no language model**. The probes, the walk, the
archive checks and the build checks talk only to TMDB, OpenSubtitles and Wizdom.

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Wizdom, OpenSubtitles and archive probes (4 to 6); build checks (11) | None | — | Subtitle-site requests only | — | See each section | Sep 9; Oct 16 |
| Release cases with a translation step: T-24, T-25, T-28, T-29 (12) | `gemini-3.5-flash-lite` | Low | The downloaded or chosen reference fed into a normal translation | Free first, Paid fallback on | 4 cases | Oct 18 |

**Would a different model change the results?** No. Which subtitle is found, how it is checked and how
many downloads are spent do not depend on the translation model. What the model **does with** the
reference is covered in [`gender-reference.md`](gender-reference.md).

## 1. What the app does today

### 1.1 Where it lives in the UI

Gender Reference appears on **Translate** only when the target language is **Hebrew**
(`referenceUiShown` in `electron/shared/genderReference.ts:19-22`). Default mode is **Off**
(`EMPTY_REFERENCE_DRAFT.mode` in `electron/shared/genderReference.ts:76-87`).

| Control | Default | Notes |
|---|---|---|
| Mode | **Off** | Off / Choose a file / Download automatically |
| Strength | **Hard** | German uses Hint unless the run confirms Hard (W-de-4) |
| Prefer language (2b) | empty | Tried first in the automatic walk when set |
| Downloads this run | **10** | `DEFAULT_PER_RUN_LIMIT`; minimum 1 (`genderReference.ts:15-17, 82`) |
| This is human Hebrew | off | Disk file + detected Hebrew only |
| Hard German this run | off | Resets after Start and on new German file load |

**TMDB prerequisite.** “Download automatically” is a **disabled menu option** until the user selects a
TMDB title that carries an IMDb id (`referenceModeOptions` in
`src/components/GenderReferencePanel.tsx:32-35`, `referenceTitleUsable` in
`electron/shared/genderReference.ts:185-187`). Amber copy points to the TMDB search above
(`REFERENCE_AUTO_NEEDS_TITLE`, `REFERENCE_AUTO_TITLE_MISSING` in `GenderReferencePanel.tsx:35-36`).
**Choose a file** stays available without a title; **Search OpenSubtitles** / **Search Wizdom** need a
title (buttons disabled when there is no query or TV season/episode is missing:
`GenderReferencePanel.tsx:291-298`).

**Start refusals** (click Start; the button is not greyed): missing file in file mode; OpenSubtitles off in
auto mode; missing TMDB title; TV show without season and episode; invalid download limit
(`genderReferenceArgs` in `electron/shared/genderReference.ts:193-231`).

### 1.2 Settings → Subtitle Sources

| Setting | Default |
|---|---|
| OpenSubtitles | **On** |
| Wizdom | **Off** |
| Own API key, username, password | blank |

Neither provider toggle is disabled for a missing key (`scripts/gates/gates.ts` section **R19 H.8**).
Wizdom shows a persistent **alert** while on (unmarked AI Hebrew; not for gender). OpenSubtitles **Check**
tests key (`file_id: 0`), login, and `/infos/user` remainder, then logs out.

### 1.3 Identification (TMDB → IMDb)

Automatic and manual **search** use the selected title’s **IMDb id** and, for TV, season and episode
filled on the Gender Reference panel (defaults can come from `SxxExx` in the source file name via
`seasonEpisodeFromName` in `genderReference.ts:168-171`). NG passes the id from TMDB cast lookup; there
is no separate hash search in the product path (hash search was rejected as redundant given alignment).

### 1.4 OpenSubtitles client behaviour

Implementation: `electron/main/opensubtitles.ts`, `osKeyPool.ts`, wired through `osService.ts`.

| Topic | Behaviour |
|---|---|
| User-Agent | `SRT AI Translator v<app version>` (`opensubtitles.ts:40-42`) |
| Transport | Electron `net.fetch` for API; **manual** redirects for file bodies via dedicated sessions (`osService.ts:74-145`) |
| Own key vs pool | Own key if entered; else shuffled pool, at most **8** keys per download (`POOL_ATTEMPTS` in `osKeyPool.ts:16-17`) |
| Login | Optional; charges **account** allowance; JWT only in memory; **one** re-login on explicit token expiry; **401 login never retried** (`opensubtitles.ts:513-544`) |
| Search | Parameters in **alphabetical** order; first page omits `page=1` (301 otherwise); at most **10** pages (`OS_SEARCH_MAX_PAGES`, `searchUrl` `opensubtitles.ts:261-275, 33`) |
| Spacing | **250 ms** minimum between requests (`OS_REQUEST_SPACING_MS`, `opensubtitles.ts:35`) |
| Remainder | `readRemainder` accepts `remaining` or `remaining_downloads`; else **null** (unknown, never guessed zero) (`opensubtitles.ts:194-203`) |
| Quota 406 | Only when `isQuota406` (`opensubtitles.ts:225-229`); generic 406 → try next candidate / not “out of quota” |
| Download grant then body fail | `allocation` set so the walk still counts allowance spent (`opensubtitles.ts:168-173`, `referenceWalk.ts:168-192`) |

### 1.5 Wizdom (picker only)

`electron/main/wizdom.ts`: search `GET /api/search?action=by_id&imdb=…`; fetch `GET /api/files/sub/{id}`.
No credentials. Multi-member ZIPs: parse SRT members, **`chooseMember`** picks by oracle alignment (overlap,
vote, archive order), not by `score` or release name (`wizdom.ts:145-150`). Staged like OpenSubtitles picks
(`osService.ts:364-372`). **Never** called from `walkForReference`.

### 1.6 The automatic walk

`walkForReference` in `electron/main/referenceWalk.ts`:

1. **One search** with all walk languages (`referenceWalk.ts:143-148`).
2. Filter candidates: language in chain, `walkEligible` — `machineTranslated === false` only; reject
   `HebrewMachineTranslated` in name/release (`referenceWalk.ts:90-94, 151-155`).
3. **Language order:** prefer language first if in chain, then rest of `REF_CHAIN_WITH_DE` **except German
   unless prefer is German** (`walkLanguages` `referenceWalk.ts:84-88`, chain in `genderReference.ts:13`).
4. Up to **`PER_LANG_LIMIT` (5)** candidates per language, service ranking (`referenceWalk.ts:159`).
5. For each download: update frozen **`runOsCap`** from first usable remainder (or pool-only cap = user
   `perRunLimit`); stop on cap, `remaining < 1`, quota, auth, etc. (`referenceWalk.ts:161-204`).
6. Decode archive members once; **`bestAligned`** chooses member; outcome logged metadata-only
   (`walkLogLines` `referenceWalk.ts:337-346`).
7. First aligned candidate **wins**; walk stops.

**Alignment gate (oracle profile):** scale **0.90–1.11**, vote ≥ **0.65**, overlap ≥ **0.65**, and at
least **8** dialogue cues on the reference side (`ORACLE_PROFILE` and `oracleGatePasses` in
`electron/engine/align.ts:56-62, 325-328`). Out-of-sync timing is not a skip by itself; failure means no
reliable map.

At run Start, `resolveReference` (`referenceWalk.ts:293-331`) either reads a chosen file or runs the walk.
The OpenSubtitles client is **captured at Start** in `ipc.ts` (gate **R19 H.11**).

### 1.7 Manual download / search path

User picks **Choose a file**, then disk, **Search OpenSubtitles**, or **Search Wizdom**. Downloads are
written under `{userData}/temp` with generated names (`stageMembers` in `osService.ts:299-328`, `tempOutputPath`
in `tempFiles.ts:11-15`). Failed staging removes partial writes (`STAGE_FAILED` `osService.ts:333-341`).
Scratch files are swept after **7 days** at startup (`TEMP_TTL_MS` `tempFiles.ts:22-38`).

After a successful **automatic** run, the accepted file may be offered back into the picker (**Use this
file**) if staging succeeded; up to **8** recent run ids kept (`ACCEPTED_KEPT` `referenceWalk.ts:255-263`).
**Stale fencing:** panel searches clear when source/title/episode identity changes (`GenderReferencePanel.tsx:144-159`);
walked file applies only if the Start snapshot still matches (`referenceFromRun` in
`genderReference.ts:153-161`, mark at `genderReference.ts:145-147`, `TranslatePage.tsx:743-751`).

### 1.8 Network safety (R19-06)

File downloads (OpenSubtitles link hops and Wizdom archives):

- At most **5** redirect hops (`MAX_REDIRECT_HOPS` `opensubtitles.ts:102`).
- Each hop: HTTPS, public destination, DNS checked before contact (`getCheckedRedirects`, `publicDestination`
  in `opensubtitles.ts:360+`).
- **Direct routes:** loopback **checked proxy** binds TCP to the address that was verified (`checkedProxy.ts`).
- **System proxy:** PAC list mapped to up to **16** dedicated sessions; real proxies kept; `DIRECT` becomes the
  checked relay; unresolvable names may be **`ResolvedByProxy`** (the maintainer's decision, 2026-10-17,
  `opensubtitles.ts:89-98`, `osService.ts:147-163`).
- API JSON calls use `redirect: 'error'` (no silent redirect follow).

Archives: single owner `subtitleArchive.ts`, envelope **8 MiB** body, **128** entries, **1 MiB** member,
**16 MiB** total (`SUBTITLE_ENVELOPE` `subtitleArchive.ts:21`).

---

## 2. What SRT AI Translator 1.1.0 did

SRT AI Translator 1.1.0 had **no** gender reference surface, **no** OpenSubtitles or Wizdom integration, and **no** Subtitle
Sources settings (maintainer inventory rows **H-P4**, **H-P6**). TMDB existed for cast/context only;
nothing downloaded a reference subtitle. Everything in section 1 is **NG-new**; no shipped SRT AI Translator 1.1.0 behaviour
was removed.

---

## 3. Timeline

| When (2026) | What | Outcome |
|---|---|---|
| Sep 9 | Live probes: Wizdom search/file; OpenSubtitles auth model | Wizdom: no MT flag; multi-file ZIPs. OS: Api-Key + User-Agent required; key-only download works (Kodi code matches) |
| Sep 13–15 | Walk order settled; German auto-walk paused unless preferred (E47) | Serial chain; `per_lang_limit` 5; no round-robin |
| Sep 14 | Wizdom default off; auto walk OS-only | Unmarked AI Hebrew on Wizdom |
| Oct 16 | Live probe capture; automatic download built (units H.4–H.11) | Remainder field `remaining` on key downloads; pool 33 keys; Bronze login 50/day measured |
| Oct 17 | Validation findings R19-05–R19-08 (+ R19-06 proxy follow-ups) | Grant-after-fail cap; redirect/DNS; identity fence; typed body/staging failures |
| Oct 18+ | Release acceptance | Defaults, auto walk with cap 1, manual OS search (release acceptance checklist) |

---

## 4. Wizdom probe (September 9)

**Setup.** Direct HTTP to public Wizdom endpoints (documented in the automatic-reference download design).

| Call | Result |
|---|---|
| Search by IMDb id for a well-known feature film | **200** JSON; **~20** entries `{ id, versioname, score }`; **no** language or MT flag; **`score` was 0 on every entry** |
| Fetch one id | **200** `application/octet-stream`; ZIP magic; **~142 KB** (multi-entry archive, not one SRT) |

**Analysis.** Without a provider MT flag, automatic gender trust is impossible. Ranking by `score` or name
is unsafe; **alignment after download** is the only filter (later codified as `chooseMember` / walk gate).

**Conclusion.** Wizdom **off** by default; picker only; **never** in automatic walk or gender eligibility.

---

## 5. OpenSubtitles auth and remainder probe (October 16)

**Setup.** Live calls with maintainer credentials and the public Kodi pool list; full response bodies kept in
maintainer research notes only; product client verified the same day. **Count:** on the order of **twenty** documented call
types plus **three** end-to-end client checks (check, search, download without own key).

| Observation | Product rule |
|---|---|
| Keyless/malformed key → **503** on download | Pool / “not accepted or unavailable” messaging |
| Valid key, `file_id: 0` → **406 Invalid file_id** | Free **Check** without spending quota |
| Key-only download **200** includes numeric **`remaining`** (~100/day per consumer key in probe) | Freeze walk cap from first numeric remainder |
| Login + Bearer → **`remaining`** tracks **account** (Bronze **50**/day in probe) | Login charges account, not key |
| Quota **406** message names allowance vs generic **406** | `isQuota406` vs `notAccepted` |
| Pool JSON lists **33** keys; all passed check; shuffle ≤ **8** attempts | `EMBEDDED_POOL` + daily refresh URL |
| Wrong password **401** with “failed:1 remaining:9” | Never retry login on 401 |
| Search `page=1` → **301** strip page | Omit page on first request |
| `.com` REST only | No `.org` parallel API in product |

**Analysis.** The September design’s “remainder unknown for key-only” risk was **closed** for this product:
`remaining` is present on successful key downloads, so automatic walk can freeze `runOsCap`. Missing
remainder still means **unknown** (`null`) and triggers stop rules in §1.6 (not zero).

**Conclusion.** No hardcoded daily caps in code; read allowance or stop.

---

## 6. Wizdom archive hardening probe (October 16)

**Setup.** Client fetch plus archive scan after colon-guard fix (Round 19 **H.4**).

| Step | Result |
|---|---|
| Search for a feature film | **32** entries |
| First archive before colon fix | Refused (`path` guard too broad on `:` in filename) |
| After the `hostileEntryName` fix | **48** archives across **8** titles read; **58** members; **58/58** parsed as SRT; **10** multi-member archives |

**Conclusion.** Colon in **entry names** is allowed when not a path escape; device/traversal shapes still
refused (`subtitleArchive.ts` gate **R19 H.4**).

---

## 7. StremioSubMaker review (September 2026)

**Scope.** **34** offline control-flow probes on upstream **1.4.94**, plus upstream's own **155** tests
(154 pass). Not a port: **AGPL** vs MIT, server-shaped architecture. The full campaign, including the
parts unrelated to downloading, is in [`submaker-evaluation.md`](submaker-evaluation.md); only the
download-relevant outcome is summarised here.

**Adopted as requirements (not code), relevant here:**

| Idea | NG use |
|---|---|
| Distinguish quota **406** from other **406** | `isQuota406` |
| Bound bodies/archives; no retry on non-retryable SSRF/size | `subtitleArchive.ts`, redirect guard |
| Partial search ≠ complete | `partial` search state (`opensubtitles.ts:146-147`, `osService.ts:275-280`) |
| No idle provider polling | OS/Wizdom only on user action or automatic walk at Start |

**Rejected for NG:** anonymous fallback after authenticated download, speculative player downloads,
background multi-provider discovery, 45 s provider keep-alive (upstream idle **25 000+** requests/day
report), Redis/session server patterns (see [`submaker-evaluation.md`](submaker-evaluation.md)).

Feature 2’s **serial quality-first OpenSubtitles walk** stayed authoritative over SubMaker’s provider
orchestration.

---

## 8. Walk design: serial chain and budgets

**Setup.** Compared to Kodi add-on **round-robin** tiers (`arabic_gender.py` in the add-on source).

| Parameter | Addon (rejected for walk) | NG |
|---|---|---|
| Order | Round-robin tiers for player deadline | Strict **`REF_CHAIN_WITH_DE`** (`genderReference.ts:13`) |
| Per language tries | 10 | **5** (`PER_LANG_LIMIT`) |
| Total budget | Hard 50 / shared keys opaque | **`run_os_cap`** frozen from **`remaining + downloads so far`**, capped by user **Downloads this run** (default **10**) |
| Wizdom in walk | N/A | **Never** |
| German | In chain | **Skipped** unless **Prefer** is German (`walkLanguages`) |

**Analysis.** Five tries per language preserves a later Hebrew **release** variant without spending a whole
day’s quota in one language. Default run cap **10** = **2 × 5** so Arabic still gets five tries after five
Hebrew misses.

**Conclusion.** Telemetry is metadata-only per attempt (`walkLogLines`); retuning 5/10 is a product decision,
not a code constant.

---

## 9. Round 19 findings R19-05–R19-08

| Id | Issue | Fix (evidence) |
|---|---|---|
| **R19-05** | Download granted but link/body fails must still spend cap | `allocation` on failure (`opensubtitles.ts:168-173`); walk reads it (`referenceWalk.ts:168-173`) — gate **H.5** |
| **R19-06** | Redirect/DNS SSRF | Manual redirects, `publicDestination`, checked proxy, proxy PAC mapping, `ResolvedByProxy` — gates **H.5–H.6**, live PAC tests **17/0** and **6/0** |
| **R19-07** | Stale UI applying old downloads | Identity = `runSourceIdentity` + Start snapshot mark; panel generation counter — `genderReference.ts:134-161`, `GenderReferencePanel.tsx:144-179` |
| **R19-08** | Body/stream/staging failures | Typed `body`/`transport`; `stageMembers` rollback — `wizdom.ts:95-102`, `osService.ts:305-328` — gate **H.6** |

---

## 10. D14-8 OpenSubtitles hardening

Confirms the automatic-download rules and adds: quota **406** classification; one controlled JWT re-login; remainder
**unknown** blocks speculative auto walk; HTML/JSON/archive classification before parse; partial search
never labeled complete; diagnostics without credential leakage. **`subtitleArchive.ts`** is the sole
archive owner for both providers.

---

## 11. Gate proof (Round 19)

| Section | Topic | Asserts (check-suite receipts) |
|---|---|---|
| **R19 H.4** | Archive envelope, hostile names | (Round 19 archive unit) |
| **R19 H.5** | OS client, pool, login, remainder, 406, redirects | **21** |
| **R19 H.6** | Wizdom picker, staging, never walk | **7** |
| **R19 H.8** | Settings sources defaults | (Round 19 settings unit) |
| **R19 H.9** | Gender Reference shell | (Round 19 UI unit) |
| **R19 H.10** | Automatic walk | **11** (focused **156** / 0) |
| **R19 H.11** | Run resolves reference at Start | **12** |

Whole suite after Round 19: **4084** passed (final Round 19 gate run).

---

## 12. Release and maintainer live runs (selected)

| Check | What was seen |
|---|---|
| **S-27** | OpenSubtitles on, Wizdom off; Wizdom warning when on |
| **T-25** | Auto mode, TMDB TV metadata, prefer Hebrew, **1** download cap: aligned reference; log metadata-only |
| **T-26a** | Manual OS search with season/episode from filename; **11** results; Use staged file |
| **T-24, T-28, T-29** | File-mode references (Hebrew, Spanish) complete with alignment counts in log |
| **X-04** | Scratch temp retained &lt; 7 days (gender reference copies among extracted tracks) |

**Not measured in release acceptance:** every language in the chain, pool exhaustion on quota day, proxy-only
corporate networks, or Wizdom as gender input (by design).

---

## 13. Decisions and why

### 13.1 Automatic download

| Rule | Why | Alternatives rejected |
|---|---|---|
| OpenSubtitles only for auto | Only provider with explicit human/MT flag | Wizdom (no flag), Ktuvit (shared login in addon) |
| TMDB title required | IMDb id already from cast; same as context | File hash search, filename-only id |
| Serial chain | The maintainer asked for a strict quality order: the best language is always tried first | Kodi round-robin, which suits a player's deadline rather than quality |
| Skip `de` unless preferred | E47: no measured net benefit in addon A/B | Always walk German |
| Skip MT and unknown MT | False masculine defaults hurt gender | Morphology heuristics (withdrawn) |
| Freeze cap from first remainder | Moving `min(remaining, limit)` stops early | Hardcoded 3/50/100 |
| Pool when no own key | Maintainer case: auto works without account | Built-in secret file; grey auto without key |

**Would reopen:** OpenSubtitles publishes reliable MT flags for Wizdom-scale corpus; or measured win from
auto German with holdout tests.

### 13.2 Wizdom

| Rule | Why |
|---|---|
| Default off | Unmarked AI Hebrew |
| Picker + alignment pick | No metadata to trust |
| Never gender-eligible | Same trust gap |

### 13.3 Security

| Rule | Why |
|---|---|
| Checked redirects + proxy sessions | SubMaker-class SSRF lessons; R19-06 |
| No API redirect follow | 301 on search params |
| Stage with `wx` + rollback | Partial files never left behind |

### 13.4 UI

| Rule | Why |
|---|---|
| Auto mode grey without IMDb | H-P8: disk path always available |
| Sources toggles never grey for missing key | Pool always exists (credential design D14-8 era) |
| Stale fencing | R19-07 |

**What Choose a file does.** In **Choose a file** mode the file can come from disk, from an OpenSubtitles
search or from a Wizdom search; the two searches need a TMDB title, and automatic download is not used.
The Settings provider toggles are never greyed by the choice of mode (`GenderReferencePanel.tsx`).

---

## 14. Build checks vs live runs

| Claim | Gates | Live |
|---|---|---|
| Walk order, caps, German skip | **R19 H.10** | T-25 (1-download cap) |
| Remainder freeze / pool cap | **R19 H.5** | Oct-16 probe + T-25 log |
| Grant-then-fail counts | **R19 H.5** | Gate only |
| Redirect/proxy relay | **R19 H.5–H.6** | Live PAC proxy tests (17/0 and 6/0) |
| Wizdom never in walk | **R19 H.6** | By inspection |
| Staging rollback | **R19 H.6** | Gate only |
| Identity fence | **R19 H.9**, **H.11** | Gate; partial UI exercise |

---

## 15. Limits

- Probes used maintainer keys and a handful of public titles; pool keys are **shared** with all Kodi users.
- **English→Hebrew** dominates gender reference testing; other target languages hide the panel.
- **Proxy-only** networks rely on sanctioned **`ResolvedByProxy`** residual; direct-only networks refuse
  unresolvable names.
- The embedded pool is a copy of **33** third-party keys from the Kodi add-on's public list, refreshed
  from that list at most once a day. If the add-on withdraws the list, keyless automatic download stops
  working until the user enters a key of their own.

---

## 16. Recommendations

1. Keep automatic walk **OpenSubtitles-only** until a provider exposes reliable human/MT metadata.
2. Use **Downloads this run** and prefer language before re-tuning `PER_LANG_LIMIT`.
3. For manual Hebrew, use disk + **This is human Hebrew** when Wizdom or OS MT flags are wrong.
4. If OpenSubtitles stops returning `remaining` on key downloads, expect auto mode to stop spending (by design).

---

## 17. Code and checks

| Area | Path |
|---|---|
| Walk | `electron/main/referenceWalk.ts` |
| OS API | `electron/main/opensubtitles.ts`, `electron/main/osKeyPool.ts` |
| IPC / transport | `electron/main/osService.ts`, `electron/main/checkedProxy.ts` |
| Wizdom | `electron/main/wizdom.ts` |
| Archives | `electron/main/subtitleArchive.ts` |
| Shared args | `electron/shared/genderReference.ts` |
| UI | `src/components/GenderReferencePanel.tsx`, `src/pages/TranslatePage.tsx` |
| Defaults | `electron/main/store.ts` |
| Oracle gate | `electron/engine/align.ts` (`ORACLE_PROFILE`, `oracleGatePasses`) |
| Start wiring | `electron/main/ipc.ts` |

| Gate section | Enforces |
|---|---|
| **R19 H.4** | Archive envelope |
| **R19 H.5** | OpenSubtitles core, R19-05/06 |
| **R19 H.6** | Wizdom picker, R19-08 |
| **R19 H.8** | Settings subtitle sources |
| **R19 H.9** | Gender Reference UI shell |
| **R19 H.10** | Automatic walk |
| **R19 H.11** | Run reference resolution |

---

## 18. Label index

| Label | Meaning | Section |
|---|---|---|
| **E47** | German skipped in auto walk unless preferred | 1.6, 8 |
| **W-de-4** | German Hint unless Hard confirmed this run | 1.1 |
| **H-log-1** | Metadata-only walk log | 1.6 |
| **R19-05** | Grant spent if body fails | 9, 13 |
| **R19-06** | Redirect/DNS/proxy guard | 1.8, 9 |
| **R19-07** | Stale download fencing | 1.7, 9 |
| **R19-08** | Body/staging typed failures | 9 |
| **D14-8** | OS hardening checklist | 10 |
| **§3.4–§3.6** | Automatic walk / budget / MT screening (design labels) | 8, 13 |
| **§14.8** | Subtitle envelope limits | 1.8 |
| **H-P8** | Auto mode grey without TMDB | 1.1, 13.4 |
