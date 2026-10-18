# Modifications to ALASS 2.0.0

**This is a modified version of ALASS.** The upstream program is `alass` v2.0.0 by kaegi
(<https://github.com/kaegi/alass>, tag `v2.0.0`), licensed under the GNU General Public License,
version 3 or later (`source/LICENSE`). The modified program is distributed under the same licence.

## What changed

| Date | File | Change |
|---|---|---|
| 2026-09-18 | `alass-cli/src/main.rs` | Adds `--json-report <path>`. After the output subtitle is written, the program also writes a JSON report (schema version 1, `report-schema-v1.json`) stating the mode, the fixed parameters, the frame-rate ratio, the score, the cue counts, the shift groups and the warnings it printed. Without the option, nothing is written and behaviour is unchanged. With it, the output subtitle is byte-identical to a run without it |
| 2026-10-07 | `alass-cli/src/main.rs` | Adds the dated modification notice to the file's header comment |

No other file differs from the upstream release. `source-inventory.json` lists every file with its
upstream and vendored SHA-256; `report-fork.patch` is the complete change as a unified diff against
the upstream archive (`alass-v2.0.0-source.zip`, SHA-256
`cf2a1472a290330e99aea7b82ed57e022ccb8a78705700bf7ac528999eecbc03`, root folder `alass-2.0.0/`).

## How to check it

```text
node scripts/check-alass.mjs --upstream-zip <path to alass-v2.0.0-source.zip>
```

extracts the upstream archive, applies `report-fork.patch`, and requires the result to equal
`source/` byte for byte.

## What the report is not

The report is candidate evidence. It carries no verdict, and the host application decides whether a
result is usable by its own checks against the reference, never from the report alone.
