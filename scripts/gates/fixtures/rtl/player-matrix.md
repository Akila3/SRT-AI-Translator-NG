# RTL player matrix (Round 11, D.6): the measured data

The measurement the gate section "R11 D.6" checks: which saved file each player showed, and whether every cue read
correctly right-to-left. Labels, hashes and verdicts only; the subtitle text, frames and montages stay private.
Copied unchanged from the private measurement record (sections 1 to 4) on 2026-10-18.

## 1. Fixtures — real subtitles, saved by the app's own Save code

Every file a player loaded was written by `saveSubtitleCopy(temp, dest, saveRecipeFor(settings,
target))` — the function `dialog:saveFile` calls — once with formatting Off and once per method. All
saves: `ok`, 8 cues, timings unchanged, wrong-alphabet repair 0/0. Each cue was retimed into its own
8 s slot (`n·8+0.5 s → n·8+7.5 s`) so a frame at `n·8+4 s` shows exactly cue `n`.

| Fixture | What it is | Provenance | sha256 (12) |
|---|---|---|---|
| **A-he** | 8 real English cues, live-translated to **Hebrew** by the app's CLI engine (`buildTranslateArgs`, `DEFAULT_SETTINGS`, `gemini-3.5-flash-lite`, low thinking, free key): a question, a two-speaker dash cue, an italic quoted title, numbers, a dash + ellipsis cue, exclamations, a comma two-liner, a dash + parenthesis cue | Source `Before.Sunset.eng.srt` (`479d71f2ce7c`); selected cues `9bd08a5dc235`; engine temp | `1c9d56e37aa0` |
| **A-ar** | The same 8 cues, live-translated to **Arabic** the same way | Same source | `b1d0476059c2` |
| **B-he** | 8 real AI Hebrew cues with **Latin inside Hebrew**: `GAA`, Spanish italics, `MI-`, `USB`, an italic two-liner whose second line **starts** with `AFC`, a quoted English song title with a number, `TMZ`, `UBA+` | Round 4 Step 2.9 native outputs (`.secrets/ab29/raw`), five titles. No professional Hebrew file in the corpus has Latin text (19 checked) | `12094fc27ae5` |
| **C-he** | 8 cues of a **human, old-style Hebrew** subtitle with reversed punctuation (`.text`, `?text`, `,text`, `"text"`): three leading ellipses, a dash line, a digit | `Before.Sunset.heb.srt` (`87a3b3aca658`), 1 644 of 1 935 cues start with punctuation | `2b0937efa38c` |
| Video | Gray 1280×720, 64 s, silent AAC, a burned-in clock above the subtitle area | `ffmpeg` lavfi | `39e442cc3454` |

**Distinct saved files.** Two methods produced bytes identical to another variant, so 15 files were
rendered, not 24. A row whose file is shared says so; a deterministic renderer given identical bytes
draws identical pixels.

| Fixture | Off | Smart RTL | Hebrew Compatibility | Classic RTL | Basic-Player RTL | Old Subtitle Repair |
|---|---|---|---|---|---|---|
| A-he | `18e7f206da05` | `2a131208e563` | = Smart RTL | `1c9d56e37aa0` (= engine temp: 1.1.0's shape) | `958e3ea70933` | = Off |
| A-ar | `627c2c964067` | `e08324a473eb` | = Off | `b1d0476059c2` (= engine temp) | = Off | = Off |
| B-he | `12094fc27ae5` | `a1be126a460b` | = Smart RTL | `c0d8f9a285e2` | `e52aee0d3beb` | = Off |
| C-he | `2b0937efa38c` | `2693a7356506` | = Smart RTL | `fc8cb129eb89` | = Off | `abeaff15152f` |

**Kodi port parity on these fixtures.** Basic-Player RTL and Old Subtitle Repair outputs for B-he and
C-he were compared line by line with the Kodi 0.2.548 addon's own `_reverse_fix_one_text_line` and
`_fix_one_text_line` run in Python 3.14: **50 lines, 0 mismatches.**

## 2. How a verdict is given

**PASS** — every one of the 8 cues reads correctly for a right-to-left reader: end punctuation at the
left end, a dialogue dash at the right, numbers and Latin words in the right order and position,
parentheses and quotes facing the right way, no missing-glyph boxes, italics kept. **FAIL** — at least
one cue does not; the observation names which.

**Expected by** — for a FAIL, the written source that predicts it:
- `Off` — Settings: *"Turning this off … exports logical text."* Off promises no display shaping.
- `1.1.0` — Classic RTL *"Reproduces the previous v1.1.0 whole-cue behavior"*: one wrapper around the
  whole cue, which a player resets at each new line, so a second line gets no RTL direction. The
  wrapper also sits outside a style tag (`<i>…</i>`), so a renderer that lays out each styled run on
  its own (MPC-HC) gives the italic run no RTL direction either. Classic RTL's A-he and A-ar files are
  byte-identical to the engine's own output — what 1.1.0 saved — so each such FAIL is 1.1.0's display.
- `Basic-Player` — *"Emergency Hebrew fallback for a player that ignores normal RTL direction
  controls… use it only after the first three methods fail."* On a player that honours them it draws
  the moved punctuation at the wrong edge.
- `not-a-repair` — formatting methods format text; they do not repair an already-damaged file
  (*"Old Subtitle Repair — Only for old Hebrew subtitles already saved with reversed… punctuation"*).
- `repair-scope` — Old Subtitle Repair is the Kodi 0.2.548 `_fix_one_text_line` port: a leading
  ellipsis is kept as authored and `"` is not a moved mark (D.2 gate *"an authored leading ellipsis
  stays"*; addon `srt.py:302` calls it with `move_ellipsis=False`). Its output is logical text with no
  direction control, so a player that lays a line out left-to-right shows the repaired lines LTR
  (`feature_decisions.md` D12-13: *"wrong as an ordinary display method"*).

## 3. Matrix

Players, renderer and how each frame was taken:
- **mpv** `v0.41.0-1115-gb2c255c13`, libass; `--no-config --vo=image`, one frame per slot.
- **VLC** `3.0.24`, freetype text renderer; `--ignore-config`, the subtitles burned in by VLC's own
  renderer (`#transcode{…,soverlay}`), the frame extracted with an exact decode-side seek.
- **MPC-HC** `2.8.3.2`, internal subtitle renderer (`SubtitleRenderer=0`), K-Lite configuration;
  opened paused at each slot (`/open /start`), the window captured.
- **Kodi** `21.3`, the tester's own profile — no subtitle or RTL add-on installed, every subtitle
  setting at its default; played full screen from the start, captured every 2 s, one frame kept per
  distinct subtitle (8 per file, each seen on 3 consecutive frames).

| Player | Version | Fixture | Language | Method | File | Verdict | Expected by | Observation |
|---|---|---|---|---|---|---|---|---|
| mpv | 0.41.0 | A-he | he | Off | `18e7f206da05` | PASS | — | libass resolves each line's direction itself; 8/8 correct |
| mpv | 0.41.0 | A-he | he | Smart RTL | `2a131208e563` | PASS | — | 8/8; italics kept |
| mpv | 0.41.0 | A-he | he | Hebrew Compatibility | `2a131208e563` | PASS | — | Same file as Smart RTL |
| mpv | 0.41.0 | A-he | he | Classic RTL | `1c9d56e37aa0` | PASS | — | 8/8; libass gives the unwrapped second lines RTL on its own |
| mpv | 0.41.0 | A-he | he | Basic-Player RTL | `958e3ea70933` | FAIL | Basic-Player | The moved end punctuation is drawn at the start (right) of the line on every cue |
| mpv | 0.41.0 | A-he | he | Old Subtitle Repair | `18e7f206da05` | PASS | — | Same file as Off: no-op on clean output |
| mpv | 0.41.0 | B-he | he | Off | `12094fc27ae5` | FAIL | Off | Cue 5 line 2 starts with `AFC`: laid out LTR, comma at the right |
| mpv | 0.41.0 | B-he | he | Smart RTL | `a1be126a460b` | PASS | — | 8/8, including the `AFC` line, the quoted English title and `UBA+` |
| mpv | 0.41.0 | B-he | he | Hebrew Compatibility | `a1be126a460b` | PASS | — | Same file as Smart RTL |
| mpv | 0.41.0 | B-he | he | Classic RTL | `c0d8f9a285e2` | FAIL | 1.1.0 | Cue 5 line 2 (`AFC`) LTR, as Off |
| mpv | 0.41.0 | B-he | he | Basic-Player RTL | `e52aee0d3beb` | FAIL | Basic-Player | The moved end punctuation is drawn at the start (right) of each line that has it |
| mpv | 0.41.0 | B-he | he | Old Subtitle Repair | `12094fc27ae5` | FAIL | Off | Same file as Off |
| mpv | 0.41.0 | C-he | he | Off | `2b0937efa38c` | FAIL | not-a-repair | The old file's reversed punctuation shows reversed on 8/8 cues |
| mpv | 0.41.0 | C-he | he | Smart RTL | `2693a7356506` | FAIL | not-a-repair | Pixel-identical to Off |
| mpv | 0.41.0 | C-he | he | Hebrew Compatibility | `2693a7356506` | FAIL | not-a-repair | Same file as Smart RTL |
| mpv | 0.41.0 | C-he | he | Classic RTL | `fc8cb129eb89` | FAIL | not-a-repair | Pixel-identical to Off |
| mpv | 0.41.0 | C-he | he | Basic-Player RTL | `2b0937efa38c` | FAIL | not-a-repair | Same file as Off |
| mpv | 0.41.0 | C-he | he | Old Subtitle Repair | `abeaff15152f` | FAIL | repair-scope | 4/8 cues repaired and correct (`?`, `!`, `.`), cue 3 half (`,` moved, `..` kept); leading ellipses (cues 1, 3, 6) and the reversed quote (cue 8) kept |
| VLC | 3.0.24 | A-he | he | Off | `18e7f206da05` | FAIL | Off | Every line laid out LTR: end punctuation at the right, dashes at the left |
| VLC | 3.0.24 | A-he | he | Smart RTL | `2a131208e563` | PASS | — | 8/8; parentheses mirrored correctly; italics kept |
| VLC | 3.0.24 | A-he | he | Hebrew Compatibility | `2a131208e563` | PASS | — | Same file as Smart RTL |
| VLC | 3.0.24 | A-he | he | Classic RTL | `1c9d56e37aa0` | FAIL | 1.1.0 | One-line cues correct; the second line of all 4 two-line cues LTR |
| VLC | 3.0.24 | A-he | he | Basic-Player RTL | `958e3ea70933` | FAIL | Basic-Player | 5/8 right; a dash before a parenthesis (2 cues) and a closing quote land on the wrong side |
| VLC | 3.0.24 | A-he | he | Old Subtitle Repair | `18e7f206da05` | FAIL | Off | Same file as Off |
| VLC | 3.0.24 | B-he | he | Off | `12094fc27ae5` | FAIL | Off | Every mixed Hebrew/Latin line scrambled; end punctuation at the right |
| VLC | 3.0.24 | B-he | he | Smart RTL | `a1be126a460b` | PASS | — | 8/8, including the `AFC` line, the quoted English title and `UBA+` |
| VLC | 3.0.24 | B-he | he | Hebrew Compatibility | `a1be126a460b` | PASS | — | Same file as Smart RTL |
| VLC | 3.0.24 | B-he | he | Classic RTL | `c0d8f9a285e2` | FAIL | 1.1.0 | Single lines correct; the Hebrew second lines of cues 4–8 laid out LTR |
| VLC | 3.0.24 | B-he | he | Basic-Player RTL | `e52aee0d3beb` | FAIL | Basic-Player | Lines mixing Hebrew and Latin reordered wrongly; most cues affected |
| VLC | 3.0.24 | B-he | he | Old Subtitle Repair | `12094fc27ae5` | FAIL | Off | Same file as Off |
| VLC | 3.0.24 | C-he | he | Off | `2b0937efa38c` | FAIL | not-a-repair | 7/8 correct — the old file was made for LTR players like this one; the one dash line shows the dash at the left |
| VLC | 3.0.24 | C-he | he | Smart RTL | `2693a7356506` | FAIL | not-a-repair | Wrapping the reversed text puts its punctuation at the start on 8/8 |
| VLC | 3.0.24 | C-he | he | Hebrew Compatibility | `2693a7356506` | FAIL | not-a-repair | Same file as Smart RTL |
| VLC | 3.0.24 | C-he | he | Classic RTL | `fc8cb129eb89` | FAIL | not-a-repair | First lines reversed, second lines as the old file |
| VLC | 3.0.24 | C-he | he | Basic-Player RTL | `2b0937efa38c` | FAIL | not-a-repair | Same file as Off |
| VLC | 3.0.24 | C-he | he | Old Subtitle Repair | `abeaff15152f` | FAIL | repair-scope | Repaired lines are logical text with no direction control; VLC lays them out LTR, so their punctuation moves to the right |
| MPC-HC | 2.8.3.2 | A-he | he | Off | `18e7f206da05` | FAIL | Off | Every line laid out LTR, as VLC: end punctuation at the right, dashes at the left; 8/8 cues wrong |
| MPC-HC | 2.8.3.2 | A-he | he | Smart RTL | `2a131208e563` | PASS | — | 8/8, drawn as mpv cue for cue; italics kept |
| MPC-HC | 2.8.3.2 | A-he | he | Hebrew Compatibility | `2a131208e563` | PASS | — | Same file as Smart RTL |
| MPC-HC | 2.8.3.2 | A-he | he | Classic RTL | `1c9d56e37aa0` | FAIL | 1.1.0 | One-line cues 1, 4, 6 pixel-identical to Smart RTL; the second line of all 4 two-line cues LTR, and the italic cue 3 LTR too (its wrapper sits outside `<i>`) |
| MPC-HC | 2.8.3.2 | A-he | he | Basic-Player RTL | `958e3ea70933` | FAIL | Basic-Player | 5/8 right, as VLC; a dash before a parenthesis (cues 2, 8) and the closing quote (cue 3) land on the wrong side |
| MPC-HC | 2.8.3.2 | A-he | he | Old Subtitle Repair | `18e7f206da05` | FAIL | Off | Same file as Off |
| MPC-HC | 2.8.3.2 | B-he | he | Off | `12094fc27ae5` | FAIL | Off | Mixed Hebrew/Latin lines scrambled and end punctuation at the right, as VLC; no cue drawn as Smart RTL |
| MPC-HC | 2.8.3.2 | B-he | he | Smart RTL | `a1be126a460b` | PASS | — | 8/8, drawn as mpv, including the `AFC` line, the quoted English title and `UBA+` |
| MPC-HC | 2.8.3.2 | B-he | he | Hebrew Compatibility | `a1be126a460b` | PASS | — | Same file as Smart RTL |
| MPC-HC | 2.8.3.2 | B-he | he | Classic RTL | `c0d8f9a285e2` | FAIL | 1.1.0 | Single-line cues 1–3 pixel-identical to Smart RTL; the Hebrew second lines of cues 4–8 laid out LTR, drawn exactly as Off |
| MPC-HC | 2.8.3.2 | B-he | he | Basic-Player RTL | `e52aee0d3beb` | FAIL | Basic-Player | Lines mixing Hebrew and Latin reordered wrongly (cues 1–3 checked at full size); no cue drawn as Smart RTL |
| MPC-HC | 2.8.3.2 | B-he | he | Old Subtitle Repair | `12094fc27ae5` | FAIL | Off | Same file as Off |
| MPC-HC | 2.8.3.2 | C-he | he | Off | `2b0937efa38c` | FAIL | not-a-repair | 7/8 correct, laid out as VLC — the old file was made for LTR players; the one dash line shows the dash at the left |
| MPC-HC | 2.8.3.2 | C-he | he | Smart RTL | `2693a7356506` | FAIL | not-a-repair | Wrapping the reversed text puts its punctuation at the start on 8/8 |
| MPC-HC | 2.8.3.2 | C-he | he | Hebrew Compatibility | `2693a7356506` | FAIL | not-a-repair | Same file as Smart RTL |
| MPC-HC | 2.8.3.2 | C-he | he | Classic RTL | `fc8cb129eb89` | FAIL | not-a-repair | First lines reversed (cue 5's first line has no punctuation and is drawn as Off); second lines as the old file |
| MPC-HC | 2.8.3.2 | C-he | he | Basic-Player RTL | `2b0937efa38c` | FAIL | not-a-repair | Same file as Off |
| MPC-HC | 2.8.3.2 | C-he | he | Old Subtitle Repair | `abeaff15152f` | FAIL | repair-scope | Cues 1, 6, 8 (kept ellipses, kept quote) drawn exactly as Off; the repaired lines are logical text with no direction control, laid out LTR, so their punctuation moves to the right |
| Kodi | 21.3 | A-he | he | Off | `18e7f206da05` | FAIL | Off | Every line laid out LTR, as VLC: end punctuation at the right, dashes at the left; 8/8 cues wrong |
| Kodi | 21.3 | A-he | he | Smart RTL | `2a131208e563` | PASS | — | 8/8, drawn as mpv cue for cue; italics kept |
| Kodi | 21.3 | A-he | he | Hebrew Compatibility | `2a131208e563` | PASS | — | Same file as Smart RTL |
| Kodi | 21.3 | A-he | he | Classic RTL | `1c9d56e37aa0` | FAIL | 1.1.0 | One-line cues 1, 4, 6 pixel-identical to Smart RTL; the second line of all 4 two-line cues LTR, and the italic cue 3 drawn exactly as Off (its wrapper sits outside `<i>`) |
| Kodi | 21.3 | A-he | he | Basic-Player RTL | `958e3ea70933` | FAIL | Basic-Player | 5/8 right, as VLC and MPC-HC; a dash before a parenthesis (cues 2, 8) and the closing quote (cue 3) land on the wrong side |
| Kodi | 21.3 | A-he | he | Old Subtitle Repair | `18e7f206da05` | FAIL | Off | Same file as Off |
| Kodi | 21.3 | B-he | he | Off | `12094fc27ae5` | FAIL | Off | Mixed Hebrew/Latin lines scrambled and end punctuation at the right, as VLC; no cue drawn as Smart RTL |
| Kodi | 21.3 | B-he | he | Smart RTL | `a1be126a460b` | PASS | — | 8/8, drawn as mpv, including the `AFC` line, the quoted English title and `UBA+` |
| Kodi | 21.3 | B-he | he | Hebrew Compatibility | `a1be126a460b` | PASS | — | Same file as Smart RTL |
| Kodi | 21.3 | B-he | he | Classic RTL | `c0d8f9a285e2` | FAIL | 1.1.0 | Single-line cues 1–3 correct; the Hebrew second lines of cues 4–8 laid out LTR, drawn exactly as Off |
| Kodi | 21.3 | B-he | he | Basic-Player RTL | `e52aee0d3beb` | FAIL | Basic-Player | Lines mixing Hebrew and Latin reordered wrongly; no cue drawn as Smart RTL |
| Kodi | 21.3 | B-he | he | Old Subtitle Repair | `12094fc27ae5` | FAIL | Off | Same file as Off |
| Kodi | 21.3 | C-he | he | Off | `2b0937efa38c` | FAIL | not-a-repair | 7/8 correct, laid out as VLC — the old file was made for LTR players; the one dash line shows the dash at the left |
| Kodi | 21.3 | C-he | he | Smart RTL | `2693a7356506` | FAIL | not-a-repair | Wrapping the reversed text puts its punctuation at the start on 8/8 |
| Kodi | 21.3 | C-he | he | Hebrew Compatibility | `2693a7356506` | FAIL | not-a-repair | Same file as Smart RTL |
| Kodi | 21.3 | C-he | he | Classic RTL | `fc8cb129eb89` | FAIL | not-a-repair | First lines reversed (cue 5's first line has no punctuation and is drawn as Off); second lines as the old file |
| Kodi | 21.3 | C-he | he | Basic-Player RTL | `2b0937efa38c` | FAIL | not-a-repair | Same file as Off |
| Kodi | 21.3 | C-he | he | Old Subtitle Repair | `abeaff15152f` | FAIL | repair-scope | Cues 1, 6, 8 (kept ellipses, kept quote) drawn exactly as Off; the repaired lines are logical text with no direction control, and stock Kodi lays them out LTR, so their punctuation moves to the right |
| mpv | 0.41.0 | A-ar | ar | Off | `627c2c964067` | PASS | — | 8/8 |
| mpv | 0.41.0 | A-ar | ar | Smart RTL | `e08324a473eb` | PASS | — | 8/8; the closing quote and Arabic question mark (U+061F) order checked at 2× |
| mpv | 0.41.0 | A-ar | ar | Hebrew Compatibility | `627c2c964067` | PASS | — | Hebrew-only method: same file as Off |
| mpv | 0.41.0 | A-ar | ar | Classic RTL | `b1d0476059c2` | PASS | — | 8/8 |
| mpv | 0.41.0 | A-ar | ar | Basic-Player RTL | `627c2c964067` | PASS | — | Hebrew-only method: same file as Off |
| mpv | 0.41.0 | A-ar | ar | Old Subtitle Repair | `627c2c964067` | PASS | — | Hebrew-only method: same file as Off |
| VLC | 3.0.24 | A-ar | ar | Off | `627c2c964067` | FAIL | Off | Laid out LTR: `.`, `!` and dashes at the wrong edge on 6/8 cues; the two cues ending in the Arabic question mark U+061F (itself a strong RTL character) read right |
| VLC | 3.0.24 | A-ar | ar | Smart RTL | `e08324a473eb` | PASS | — | 8/8 |
| VLC | 3.0.24 | A-ar | ar | Hebrew Compatibility | `627c2c964067` | FAIL | Off | Hebrew-only method: same file as Off |
| VLC | 3.0.24 | A-ar | ar | Classic RTL | `b1d0476059c2` | FAIL | 1.1.0 | Second line of all 4 two-line cues LTR |
| VLC | 3.0.24 | A-ar | ar | Basic-Player RTL | `627c2c964067` | FAIL | Off | Hebrew-only method: same file as Off |
| VLC | 3.0.24 | A-ar | ar | Old Subtitle Repair | `627c2c964067` | FAIL | Off | Hebrew-only method: same file as Off |
| MPC-HC | 2.8.3.2 | A-ar | ar | Off | `627c2c964067` | FAIL | Off | Laid out LTR, as VLC: `.`, `!` and dashes at the wrong edge on 6/8; the two cues ending in U+061F (cues 1, 3) pixel-identical to Smart RTL |
| MPC-HC | 2.8.3.2 | A-ar | ar | Smart RTL | `e08324a473eb` | PASS | — | 8/8, drawn as mpv cue for cue |
| MPC-HC | 2.8.3.2 | A-ar | ar | Hebrew Compatibility | `627c2c964067` | FAIL | Off | Hebrew-only method: same file as Off |
| MPC-HC | 2.8.3.2 | A-ar | ar | Classic RTL | `b1d0476059c2` | FAIL | 1.1.0 | One-line cues pixel-identical to Smart RTL (the italic cue 3 too: it ends in U+061F); the second line of all 4 two-line cues LTR |
| MPC-HC | 2.8.3.2 | A-ar | ar | Basic-Player RTL | `627c2c964067` | FAIL | Off | Hebrew-only method: same file as Off |
| MPC-HC | 2.8.3.2 | A-ar | ar | Old Subtitle Repair | `627c2c964067` | FAIL | Off | Hebrew-only method: same file as Off |
| Kodi | 21.3 | A-ar | ar | Off | `627c2c964067` | FAIL | Off | Laid out LTR, as VLC: `.`, `!` and dashes at the wrong edge on 6/8; the two cues ending in U+061F (cues 1, 3) read right |
| Kodi | 21.3 | A-ar | ar | Smart RTL | `e08324a473eb` | PASS | — | 8/8, drawn as mpv cue for cue |
| Kodi | 21.3 | A-ar | ar | Hebrew Compatibility | `627c2c964067` | FAIL | Off | Hebrew-only method: same file as Off |
| Kodi | 21.3 | A-ar | ar | Classic RTL | `b1d0476059c2` | FAIL | 1.1.0 | One-line cues pixel-identical to Smart RTL (the italic cue 3 too: it ends in U+061F); the second line of all 4 two-line cues LTR |
| Kodi | 21.3 | A-ar | ar | Basic-Player RTL | `627c2c964067` | FAIL | Off | Hebrew-only method: same file as Off |
| Kodi | 21.3 | A-ar | ar | Old Subtitle Repair | `627c2c964067` | FAIL | Off | Hebrew-only method: same file as Off |

How MPC-HC and Kodi cues were judged: each cue's subtitle strip was compared pixel by pixel with the
same fixture's Smart RTL strip in the same player (C-he: with Off). **0 differing pixels** is stated as
"pixel-identical"; every other cue was read at full size, because a moved mark that leaves the line
looking right still shifts it by a few pixels.

MPC-HC and Kodi were captured once the session was unlocked again (from 03:47); between 03:06 and
then a capture returned only the Windows lock screen, and nothing was done to get past it.

## 4. Does the player hold the `.srt` open?

While each player was playing the Smart RTL A-he file, the app writer's own replace was attempted:
write a sibling `.rtl-tmp`, rename it over the destination, then restore the original the same way.

| Player | Version | Replace while playing | Original bytes afterwards |
|---|---|---|---|
| mpv | 0.41.0 | replaced | intact |
| VLC | 3.0.24 | **refused (`EPERM`)** — VLC keeps the file open | intact |
| MPC-HC | 2.8.3.2 | replaced | intact |
| Kodi | 21.3 | replaced | intact |

So saving over a subtitle VLC is playing fails with the writer's existing open-file refusal, and the
file VLC has open is left whole (D.3 fault matrix; `gate_ledger.md` §5k.5).

## 5. End of the measured data
