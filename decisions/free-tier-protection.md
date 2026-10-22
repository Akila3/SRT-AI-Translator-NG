# Free-tier protection and request size

**Decision in one paragraph.** On a key marked **Free**, the app paces its own requests so it does not
run into Google's per-minute and per-day limits: it keeps a rolling 60-second record of requests and
input tokens per **Quota Group** and model, and sends each request at the earliest moment every known
limit allows. It ships **no** limit numbers. It uses only limits the user copies from AI Studio
(optional, off by default) or limits Google states in a structured error. Rate, quota, overload and
network errors make the app **wait, switch key or stop, never send smaller batches**. A batch is made
smaller only when the exact request is counted as too large for the model's published input limit.
Falling back from a Free key to a Paid one is **off by default**. **Automatic Free-Tier Protection** is
ON by default and covers Translate and Transcribe.

**Status:** current. **Evidence scope:** Google's documentation as read on 2026-09-16; a live probe on
2026-10-15 of one Free project and one model; two packaged-app runs on 2026-10-15. In the second, small
manual limits forced a live wait, a live daily stop and live Paid fallback. Only the switch between two
Quota Groups was never live, because only one real project was available.

**How to read this file.** Section 1 is what the code does. Section 2 is what SRT AI Translator 1.1.0 did. Section 3 is
the timeline. Section 4 is the evidence gathered before deciding, section 5 the decisions and the
alternatives rejected, section 6 the live probe, section 7 the build and acceptance. Sections 8 to 11
are the limits, recommendations, code map and label index.

---

## Models used in testing

| Test (section) | Model | Thinking | Other settings | Key | Size | Date |
|---|---|---|---|---|---|---|
| Does `countTokens` spend the request limit? (6.1) | `gemini-3.5-flash-lite` | Generations Low; counts take no thinking setting | Synthetic text, parallel waves of 10, tiny output limit | Free | 40 counts and 40 generations (20 generations before the counts, 20 after) | Oct 15 |
| Does it spend the input-token limit? (6.2) | `gemini-3.5-flash-lite` | Generations Low | A 400,441-token count payload, 75 s spacing | Free | 8 counts, 3 generations | Oct 15 |
| How is an over-limit request rejected? (6.4) | `gemini-3.5-flash-lite` | Generations Low | A 1,154,222-token body | Free, plus one Paid generation | 1 count, 2 generations | Oct 15 |
| Packaged smoke run (7) | Translate `gemini-3.5-flash-lite`; Transcribe `gemini-3.7-flash` | Low, Low | Fresh profile, both keys stored, Free first | Free | 19 checks | Oct 15–16 |
| Packaged UI acceptance (7) | Translate `gemini-3.5-flash-lite`; Transcribe `gemini-3.7-flash` | Low, Low | Manual limits (2 per minute, then 1 per day), real clicks | Free, with Paid fallback twice | 64 checks | Oct 15–16 |
| Release test that found the overload behaviour (7) | Transcribe `gemini-3.7-flash` | Low | 71-minute transcription, Allow paid fallback on | Free (overloaded three times; the Paid key sat idle) | One release case | Oct 18 |

The build checks for pacing, quota groups and the scheduler run on a simulated clock and call no model.
The switch to Paid on overload, added after that release test, is proven by checks only; no real
overload has yet been answered by the Paid key.

**Would a different model change the results?** The **limits** are Google's, set per project, per
model and per tier, and they change. That is why the app reads them from Google's own errors rather
than shipping figures. The `countTokens` findings were measured on **one model, one Free project, at one
time of day**; another model or project may be charged differently. Whether an over-limit request comes
back with a structured "too large" field was also checked only on this model on this date. How often a
model is overloaded is provider behaviour and changes from day to day. The **routing** is code and does
not depend on the model: Free first, Paid only with consent, a switch on overload, and no shrinking for
rate pressure.

## 1. What the app does today

### 1.1 Settings and defaults

Settings has a **Free-Tier Protection** section:

| Setting | Default |
|---|---|
| Automatic Free-Tier Protection | **ON** |
| Use manual AI Studio limits (RPM, input TPM, RPD per Quota Group and model) | **OFF**; fields blank, blank means unknown |
| Safety reserve for manual limits | **10%** left unused |
| Allow paid fallback | **OFF** |
| Quota Group of each Free key | **Group A**, shared |

Only a literal `false` turns protection off, and only a literal `true` turns on manual limits or Paid
fallback, so a damaged setting can never weaken protection.

### 1.2 Where a limit comes from

For each metric, in order: a valid manual value (only while protection and manual limits are both on);
otherwise the newest limit Google stated in a structured error for that group and model; otherwise
**unknown**. An unknown limit creates no wait. Manual values are never overwritten by learned ones.
With the reserve, a manual limit `L` becomes `floor(L × (100 − reserve) / 100)`.

### 1.3 Pacing

- Requests and input tokens are tracked over a **trailing 60 seconds** per Quota Group and model.
  Requests per day are bounded by the daily reset: Google's stated reset if given, else midnight
  Pacific time, labelled as such.
- Each send happens at `max(RPM ready, input-TPM ready, RPD ready, Google's retry hint)`. The waits are
  **not added together**, and a request goes immediately when every known limit allows it.
- Every attempt counts, including retries and recovery requests. The estimate is replaced by actual
  usage when the response reports it; a failure with no usage keeps the estimate.
- Reservations are written before sending, so a restart cannot forget recent use.

### 1.4 Keys and groups

- A **Quota Group** stands for a Google project, because Google applies limits per project, not per
  key. Keys in one group share one budget; rotating among them never adds capacity. The app cannot
  detect projects from key text, so the user assigns groups.
- From a Free primary key, the app may move to a key in another group that can send sooner. A Paid key
  is used from a Free route only if **Allow paid fallback** is on, and the switch is shown before the
  first Paid request. A Paid primary key is a normal Paid route and needs no consent.
- **An overload on a Free key** (Google's "The model is overloaded") normally pauses that request
  before retrying. With **Allow paid fallback** on and an eligible Paid key, that one request is
  retried on the Paid key at once instead, and the retry line says no wait is needed. It is
  request-local: the next request tries Free first again. Without consent, without an eligible Paid
  key, or when a Paid key is already ranked first, the normal pause is unchanged. If consent is
  withdrawn between the overload and the retry, the request waits out the original pause on Free. The
  overload still counts toward the shared limit of three errors in a row (`electron/engine/run.ts`,
  `createRequestGate.retryWait`).
- If every eligible Free group has used its daily allowance and Paid fallback is off, the run stops
  cleanly, keeps resumable progress and shows the next reset time.

### 1.5 Request size

- Before a Translate request is sent, the app may count the **exact** request with Google's
  `countTokens` and compare it with the model's published `inputTokenLimit`. If it does not fit, the
  batch is halved until a counted prefix fits; the rest is re-cut and stays queued. At most
  `1 + ceil(log2(lines))` counts per batch. The run's batch size never grows back, and the saved Batch
  Size is never changed.
- At Start, each queued batch is checked once as it would be sent. Nothing is shown when everything
  fits.
- The advisor **fails open**: no published limit, a failed count, a timeout or a single line that alone
  overflows all mean "send at the saved size".

### 1.6 What the user sees

A notice above the run log appears **only** when protection is changing the run: a batch made smaller
to fit, a wait with a named limit, a budget-caused group switch, a switch to Paid, or a daily stop.
Countdowns are live. A normal run, or one where the limits are unknown but not binding, shows nothing.

### 1.7 Hidden retries are off

The Google SDK's own automatic retries (five attempts by default, including on 429 and 5xx) are
disabled, so every request the provider makes is one the app counted, paced and reported.

### 1.8 Transcribe

Transcribe shares the same budget, budgeted against the model each request actually uses. It has no
request-size advisor: audio sizing belongs to transcription recovery, and rate pressure never shrinks
audio chunks either.

---

## 2. The starting point: what SRT AI Translator 1.1.0 did

From gst 3.7.0's source:

- **A fixed gap.** On a Free key with a Pro model, gst waited 30 seconds between batches (15 with a
  second key). Other models and Paid keys had no pacing.
- **Fixed pauses on errors.** A quota error switched key if possible or ran a 60-second countdown.
  Other 429, 500 and 503 errors got another fixed 60-second pause, up to the error ceiling.
- **An interactive question.** When gst's token check failed, it asked on the terminal for a new batch
  size, which a desktop app cannot answer.
- **Transcribe** got one key, no Paid flag, and a retry branch with no ceiling for unexpected errors.
- The app itself did no scheduling; it only recognised gst's countdown so it would not treat it as a
  hang.

---

## 3. Timeline

| When (2026) | What |
|---|---|
| Sep 16 | Evidence gathered (section 4); the maintainer chose the product behaviour |
| Sep 17 | Independent review of the design found two contradictions (one rule kept a Paid primary key usable while another excluded every Paid key without fallback consent; old two-key copy would have stayed on screen with N keys) and six smaller gaps; all repaired before building |
| Oct 15 | Built. Live probe of how `countTokens` is charged and how an over-limit request is rejected (section 6). Packaged-app acceptance |
| Oct 16 | The whole-file check at Start added |
| Oct 18 | After the release test, Allow paid fallback extended to overloads (section 1.4, section 7) |

---

## 4. Evidence gathered before deciding (September 16)

| Question | What was found |
|---|---|
| Does Google publish per-model free-tier limits? | No longer. The rate-limit page sends users to AI Studio for their project's active values and says they may vary. The app's `src/data/freeTier.ts` therefore ships no figures, and its revalidation marker forbids copying any from a document |
| Are limits per key or per project? | Per project. Hence Quota Groups |
| What does TPM count? | **Input** tokens |
| When does the daily count reset? | Midnight Pacific time |
| Can the app read a project's limits? | No. `models.get` gives the model's input and output token limits; nothing reveals RPM, TPM or RPD |
| Can a request's size be checked before sending? | Yes: `countTokens` accepts the full request and returns its token count |
| Is `countTokens` charged against generation limits? | The documentation does not say. Left open and handled conservatively until measured (section 6) |
| Does the SDK retry on its own? | Yes, five attempts by default, including 429 and 5xx. Cancelling a call does not cancel work the service already accepted |
| Does an upstream change conflict? | Yes. gst 3.8.3 (upstream issue #135) shrinks batch size after repeated errors of almost any kind, including 429. Section 5.2 |

---

## 5. Decisions and why

### 5.1 The alternatives rejected

| Rejected | Why |
|---|---|
| Hardcode "published" free limits | Google no longer publishes the table; stale third-party numbers are worse than an honest "unknown" |
| One fixed delay between batches (SRT AI Translator 1.1.0's approach) | It waits too long after a small batch and not long enough after a large one, and ignores rolling use, retries and re-cut batches |
| One quota pool per key | Keys in the same project share capacity, so per-key pools would over-send |
| Automatic Free-to-Paid fallback | It can create unexpected cost |
| Shrink batches to cope with RPM, TPM, 429 or overload | Section 5.2 |
| Save a calculated batch size automatically | One film does not prove a lasting preference; the user can apply it with **Use N in Settings** |
| An always-visible readiness card | Clutter |
| Advice in Settings only | Settings does not have the loaded file, so the advice would come too late |
| The calculator as a condition of Start | It is a bonus; it must never hang or stop a translation |
| Scrape AI Studio, or infer a limit from one 429 | Use what the user enters or what Google's structured error states |

### 5.2 Why rate pressure never shrinks batches

gst 3.8.3's adaptive reduction cuts the batch by a fixed step multiplied by the number of consecutive
errors (down to a floor), restores the original size after the first success, and counts rate errors
among its triggers (upstream issue #135). NG's input-limit rule (section 1.5) is a different
algorithm: it bisects one batch only on a counted overflow. For rate pressure, gst's policy is the
wrong remedy for translation:

- More, smaller batches mean **more** requests, which is exactly what a requests-per-minute limit
  counts.
- Every request repeats the fixed prompt and the context block, so total input tokens **rise**.
- Each line gets less surrounding context, which can lower quality.

Waiting fixes rate pressure; shrinking fixes only a request that is genuinely too large. So the
upstream behaviour was adopted for transcription audio recovery only, under its own rules, and replaced
for translation by the input-limit rule.

### 5.3 Why only structured evidence counts

A learned limit needs a metric **and** a positive whole-number limit in that metric's own unit, as
Google stated it. A retry delay, a reset time or a metric name without a limit controls that one wait
but never becomes a ceiling. A correlation between recent traffic and a 429 is not a limit. Learned
evidence stores no key, prompt, subtitle text or raw error body, only a redacted list of the error's
field names and their hash.

### 5.4 Why the notice is so quiet

The maintainer chose "Option A": show something only when protection is actually changing the run.
Missing information is explained in Settings, not pushed onto the run page.

---

## 6. Live probe (October 15)

Two questions were still open, and both were settled by live measurement on a Free key, with the full
responses saved as evidence.

**Operating point:** Gemini 3.5 Flash-Lite only (input limit 1,048,576 tokens), one Free project, one
time of day, the same REST endpoints and request body as the app. Synthetic text only (about 5.9 tokens
per word), no subtitle or audio content. Requests in parallel waves of 10, which the app does not do.
Some `503 UNAVAILABLE` replies appeared (1 in 20 and 4 in 20).

The limits quoted below are what Google's own error messages stated for that project on that day. The
app does not use or ship them.

### 6.1 Does `countTokens` spend the generation request limit? No.

A controlled pair, where only "40 counts first" differs:

| Arm | Sent | Generations admitted |
|---|---|---|
| Control | 20 generations on a clean window | **16** (Google's error named the limit: 15 per minute) |
| Counts | 40 `countTokens` of the same small request, 75 s later | all 40 accepted |
| Test | 20 generations immediately after the counts | **12**, plus 4 that failed with 503 |

If counts drew from the same limit, 40 counts would have used it up and the first generation after them
would have been refused. Not counting the 503s, 16 were not refused by quota, against 17 in the control.

### 6.2 Does it spend the input-token limit? No.

8 counts of a 400,441-token request inside one minute: **3,203,528 tokens counted**, about 13 times the
input-token limit Google stated (250,000 per minute). A small generation immediately after: accepted.
As a control, one real generation of the 400,000-token request was accepted and a second one straight
after was refused for input tokens per minute, so generation input **is** charged.

### 6.3 Not measured

Requests per day (settling it would use up the whole daily allowance; every quota seen was a
`Generate…` quota, so counts are inferred to skip the daily one too), `countTokens`' own limit (not
reached), other models, Paid-tier counts and audio counts.

### 6.4 How is an over-limit request rejected?

A 1,154,222-token request:

| Step | Result |
|---|---|
| `countTokens` on Free | Accepted, counted exactly |
| Generation on Free | Refused for input tokens per minute; it never reached the size check |
| Generation on Paid (one call) | `400`, `INVALID_ARGUMENT`, *"The input token count exceeds the maximum number of tokens allowed 1048576."* |

The 400 body's complete key set is `error.code`, `error.message`, `error.status`: **no structured
detail** names the condition, and no header does either. The app does not read message text, so it has
no admissible signal for "too large" in a rejection. **Counting first is the only resize trigger**, and
the probe shows it works on exactly this case: the over-limit request was counted exactly, on the Free
key, without spending generation quota.

### 6.5 What changed

Count calls were originally reserved against the request budget, and skipped when that would delay real
work. That booked a request Google does not count and, at 15 requests per minute, cost real work one
slot in fifteen. **Counts now reserve nothing.** They still fail open on any failure, and each one still
appears in the usage report. If the daily inference is wrong, the cost is bounded: counts run only for
requests with audio, for each smaller candidate, and for a text request whose raw size exceeds the
input limit, at most `1 + ceil(log2(lines))` per batch; Google's structured daily 429 is still handled.

---

## 7. Build and acceptance (October 15–16)

- **Checks:** each part has its own section (`R17 F0` to `R17 F7`, and `R18 G.9a` for the check at
  Start). The scheduler is tested on a controlled clock: earliest-safe send, no fixed delay, the
  maximum rather than the sum of waits, immediate send when capacity frees, and recomputation after
  every resize, attempt, response or settings change. Re-cut batches keep the exact line order.
- **Packaged smoke run:** the portable build unpacked to a fresh folder, a fresh profile, `PATH`
  limited to System32, one Free and one Paid key stored. **19 of 19 checks passed:** model refresh on
  both keys; Translate of 12 lines with a usage report grouped by Quota Group and model, and no key in
  any event; Translate and Transcribe each stopped and reported; restart with settings and keys kept;
  Continue completing 60 of 60 lines; the usage card in light, dark and narrow layouts (4 of 4). **No
  limit was reached on either key**, so no wait happened.
- **Packaged UI acceptance:** the same conditions, driven by real clicks, typing and the native
  Open/Save dialogs. **64 checks passed, none failed.** Manual limits typed into Settings (2 requests per
  minute, then 1 per day) produced:
  - a live per-minute wait with a countdown, then Stop and Continue;
  - a live daily stop, with the reset notice kept;
  - live Paid fallback twice: once from a structured per-day 429 on a Free key during Transcribe, once
    from a used-up Group A during Translate.

  It also checked adding, duplicating, renaming, assigning and deleting Quota Groups, rejecting an
  invalid reserve, the usage card, Save with the report moved alongside, report on and off, restart
  persistence, dark and narrow layouts, and that no key appeared in any event.
- **Observed, not changed:** one Free per-day refusal from Google cleared within minutes. The app
  trusts a structured per-day error as planned, so with consent that run finished on Paid.
- **Not live:** switching between two Quota Groups, because only one real project was available. It is
  proven by checks only.
- **Independent code review:** the first pass returned 21 findings. One was withdrawn by the reviewer,
  the other 20 were accepted and fixed, none rejected. The re-review found one regression introduced
  by a fix, which was also fixed.
- **Overload to Paid (October 18).** In the release test, a Free key that kept answering "The model is
  overloaded" was paused 60 seconds and asked again, three times, while a Paid key sat idle. That
  matched SRT AI Translator 1.1.0, but the maintainer preferred moving to Paid when he had consented. Allow paid fallback was extended to cover that case (section 1.4). Checks cover five cases:
  switch on (the request goes to Paid with no wait, and the next request tries Free again); switch
  off (normal pause); no Paid key (normal pause); a Paid key already ranked first (unchanged); and
  consent withdrawn between the overload and the retry (the request waits out the original pause on
  Free, with its log line). Every Paid send still passes the request gate, and the overload still
  counts toward three errors in a row. Transcribe and polishing use the same gate. Not seen live: a
  real overload answered by the Paid key.

---

## 8. Limits

- The pacing only knows requests this app made while protection was on. It cannot see AI Studio or
  other programs using the same project, so it cannot promise Google has capacity left. Google's
  structured errors still win when they arrive.
- With no manual limits and no learned limit, protection creates no proactive wait; it then relies on
  reacting to Google's errors.
- A forward jump of the system clock after a restart cannot be told apart from elapsed time.
- The probe covered one model, one project and one time of day.
- The live waits were forced with manual limits far below any real one. A per-minute wait driven by a
  limit learned from Google's own error, and a switch between two real projects, have not been seen
  live.

## 9. Recommendations

- Never add limit numbers to source, defaults or tests. If Google publishes them again, read them from
  the service.
- If Google ever adds a structured field for "input too large", allow-list it explicitly; until then,
  do not match on message text.
- Keep SDK retries off. A hidden retry is a request the budget, the report and Stop cannot see.
- Before changing what triggers a smaller batch, re-read section 5.2.

## 10. Code and checks

| What | Where | Checks |
|---|---|---|
| Rolling budget and journal | `electron/engine/requestBudget.ts` | `R17 F2` |
| Request-size advisor | `electron/engine/requestAdvisor.ts`, `electron/engine/batching.ts` (`resizedQueue`) | `R17 F5`, `R18 G.9a` |
| Routing across keys and groups | `electron/engine/keys.ts` (`chooseRoute`), `electron/engine/run.ts` | `R17 F4` |
| Learned evidence, `countTokens`, token limits | `electron/engine/providers/gemini.ts` | `R17 F3` |
| Quota Groups and reserve | `electron/shared/quotaGroups.ts` | `R17 F1` |
| Settings | `src/pages/SettingsPage.tsx` (Free-Tier Protection) | `R17 F5` |
| The notice | `src/components/FreeTierNotice.tsx` | `R17 F5` |
| Usage report | `electron/engine/runArtifacts.ts`, `src/components/TokenUsageCard.tsx` | `R17 F7` |
| No limit figures | `src/data/freeTier.ts` | — |

## 11. Label index

| Label | Meaning | Section |
|---|---|---|
| `D8-1` | One Automatic Protection setting for both modes | 1.1 |
| `D8-2` | The Settings section and optional manual limits | 1.1 |
| `D8-3` | Quota Groups | 1.4 |
| `D8-4` | Limit precedence and the reserve | 1.2 |
| `D8-5` | Model token limits from Fetch Models | 4 |
| `D8-6` | Learn only what a structured error states | 5.3 |
| `D8-7` | Rolling, earliest-safe pacing | 1.3 |
| `D8-8` | Batch size changes only for a counted input-limit fit | 1.5 |
| `D8-9` | The advisor is optional and fails open | 1.5 |
| `D8-10` | Option A: the quiet notice | 1.6, 5.4 |
| `D8-11` | Group-aware keys; Paid fallback default off | 1.4 |
| `D8-12` | Every attempt counted; SDK retries off | 1.7 |
| `D8-13` | Transcribe shares the budget, not the advisor | 1.8 |
| `D8-14` | Token usage and report preferences | 7 |
| `D8-15` | Replaces upstream's shrink-on-any-error for translation | 5.2 |
| `#135` | The upstream gst change that shrinks batches on errors | 4, 5.2 |
| `E60e`, `AS-F8-1` | Is `countTokens` charged against generation limits | 6.1–6.3 |
| `AS-F8-9` | Is there a structured "input too large" signal | 6.4 |
| `PR-6` | The whole-file check at Start | 1.5 |
| `RT-12` | The release-test finding behind overload-to-Paid | 1.4, 7 |
| `§12.7` | The request-size advisor | 1.5 |
