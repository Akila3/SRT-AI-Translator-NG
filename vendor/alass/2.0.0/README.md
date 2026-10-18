# ALASS 2.0.0 sidecar component

**ALASS** (Automatic Language-Agnostic Subtitle Synchronization) v2.0.0 by kaegi,
<https://github.com/kaegi/alass>, GNU GPL v3 or later. **This copy is modified** — see
[`MODIFICATIONS.md`](MODIFICATIONS.md).

This folder is the complete Corresponding Source for the executable the application ships as
`resources\bin\alass\2.0.0\alass.exe`. The Windows release carries this folder beside it, byte for
byte, as `resources\bin\alass\2.0.0\corresponding-source\`, together with the build script
`build-alass.ps1`. The licences are in `licenses\alass\2.0.0\` at the top of the release.

| Item | Value |
|---|---|
| Upstream | `kaegi/alass` tag `v2.0.0`; archive SHA-256 `cf2a1472a290330e99aea7b82ed57e022ccb8a78705700bf7ac528999eecbc03` |
| Build target | `x86_64-pc-windows-gnu` |
| Toolchain | rustc 1.98.1 (48a229cea 2026-09-01), cargo 1.98.1 (797e8a9bc 2026-08-05), MinGW-W64 UCRT POSIX SEH GCC 16.1.0 (WinLibs r4) |
| Executable | `alass.exe`, SHA-256 `ea314c5c83ca4d30af5259cc658e696352492438015dd55dae47290699efe5aa`, 1 878 645 bytes, reports `alass-cli 2.0.0` |
| Imports | Windows system DLLs only (`build-receipt.json` lists them) |

## Contents

| Path | What it is |
|---|---|
| `source/` | The upstream v2.0.0 source tree with the report fork applied: workspace manifests, `Cargo.lock`, both crates, upstream documentation and `LICENSE` |
| `report-fork.patch` | The only change, as a unified diff against upstream |
| `MODIFICATIONS.md` | The modification notice and change log |
| `report-schema-v1.json` | The JSON report the fork writes |
| `source-inventory.json` | Every source file with its upstream and vendored SHA-256 |
| `dependency-inventory.json` | Every locked Rust package with its declared licence, generated from `Cargo.lock` by `scripts/check-alass.mjs --write-inventory` |
| `build-receipt.json` | The exact toolchain, flags and expected executable hash |
| `.gitattributes` | Keeps these bytes free of end-of-line conversion |

## Building

From the application's repository:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-alass.ps1
```

From a release, in `resources\bin\alass\2.0.0\corresponding-source\`. This writes to `rebuilt\`
beside the script and leaves the installed executable alone:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File build-alass.ps1
```

Either way it needs the toolchain `build-receipt.json` names: rustup's
`stable-x86_64-pc-windows-gnu` at that exact rustc/cargo version, and that exact MinGW-w64 `gcc` on
`PATH`. The Rust packages `Cargo.lock` pins are fetched from crates.io and checked against the
lockfile's SHA-256 sums; `licenses\alass\2.0.0\rust-dependencies.txt` lists each one and where it is
published.

The script refuses to build, and leaves any installed executable untouched, unless the source matches
`source-inventory.json` and the toolchain matches `build-receipt.json`. It refuses to install unless
the result matches the receipt's hash. The receipt's two path flags keep the builder's own folders out
of the executable, and the linker flag leaves out the link time, so the same source gives the same
bytes on any machine with this toolchain. `node scripts/check-alass.mjs --rebuild` proves that.

## How the application uses it

- **A separate program.** The application starts `alass.exe` as a child process with fixed arguments
  and reads its output files. Nothing is linked into the application, and the application's own code
  stays under its own licence.
- **Only for Advanced → Piecewise.** Default (global) alignment never starts it.
- **Media goes through the application's own FFmpeg.** `ALASS_FFMPEG_PATH` and `ALASS_FFPROBE_PATH`
  name the application's FFmpeg/FFprobe pair; ALASS's own 2019 FFmpeg build is not shipped.
- **Its report is evidence only.** Every candidate is checked by the application against the
  reference before it can be previewed or applied.

## Replacing or removing it

The executable, schema, notices and this source are one unit, and are updated or rolled back
together. `licenses\alass\2.0.0\UNIT-MANIFEST.json` lists every file of the unit with its SHA-256;
packaging refuses a release whose copy has a file missing, changed or extra, or a second ALASS
version beside this one. A new version is a new folder (`alass/<version>/`) shipped with the
application release that expects it. If the executable is missing, corrupt or the wrong version,
only Advanced → Piecewise is unavailable; global alignment and everything else keep working, and no
subtitle is touched. Deleting the application folder removes the executable and its source; the
subtitles you aligned are elsewhere and are never touched.
