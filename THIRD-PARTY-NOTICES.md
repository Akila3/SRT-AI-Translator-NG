# Third-Party Notices

SRT AI Translator NG itself is released under the MIT License (see [LICENSE](LICENSE)). The portable
build additionally redistributes the components below, which remain under their own licenses.

This file exists so that those licenses travel with the distribution, as each of them requires.

**Where these live in the portable build.** Everything below ships inside the ZIP alongside
`SRT AI Translator NG.exe`:

```
LICENSE.txt                              this application (MIT)
THIRD-PARTY-NOTICES.md                   this file
LICENSE.electron.txt                     Electron
LICENSES.chromium.html                   Chromium
licenses\README.txt                      what each licence covers, and where to get source
licenses\FFmpeg-GPL-3.0.txt              FFmpeg and FFprobe (GPL v3)
licenses\gemini-srt-translator-MIT.txt   gemini-srt-translator, which the engine is adapted from (MIT)
licenses\kodipovilai-MIT.txt             the Kodi add-on that several features are adapted from (MIT)
licenses\google-genai-and-dependencies.txt   the Google Gen AI SDK and its dependencies
licenses\alass\2.0.0\                    ALASS (GPL v3): licence, notices, dependency licences
resources\bin\alass\2.0.0\               ALASS: the executable and, in corresponding-source\, its source
```

The ALASS folders are in the Windows build only.

---

## Google Gen AI SDK (`@google/genai`) and its dependencies

The native engine talks to the Gemini API through Google's TypeScript SDK, `@google/genai` 2.27.0
(Apache-2.0), pinned exactly in `package.json`. It is a runtime dependency, so it and everything it
pulls in ship inside the application archive under `node_modules`.

Project: <https://github.com/googleapis/js-genai>

The full licence text of every package below, copied verbatim from the installed package, is in
`licenses/google-genai-and-dependencies.txt`. None of them ships a `NOTICE` file.
`data-uri-to-buffer` ships no licence file of its own; its `package.json` declares MIT.

| Package | Version | Licence |
|---|---|---|
| `@google/genai` | 2.27.0 | Apache-2.0 |
| `@protobufjs/aspromise` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/base64` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/codegen` | 2.0.5 | BSD-3-Clause |
| `@protobufjs/eventemitter` | 1.1.1 | BSD-3-Clause |
| `@protobufjs/fetch` | 1.1.1 | BSD-3-Clause |
| `@protobufjs/float` | 1.0.2 | BSD-3-Clause |
| `@protobufjs/path` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/pool` | 1.1.0 | BSD-3-Clause |
| `@protobufjs/utf8` | 1.1.2 | BSD-3-Clause |
| `@types/node` | 20.19.43 | MIT |
| `@types/retry` | 0.12.0 | MIT |
| `agent-base` | 7.1.4 | MIT |
| `base64-js` | 1.5.1 | MIT |
| `bignumber.js` | 9.3.1 | MIT |
| `buffer-equal-constant-time` | 1.0.1 | BSD-3-Clause |
| `data-uri-to-buffer` | 4.0.1 | MIT |
| `debug` | 4.4.3 | MIT |
| `ecdsa-sig-formatter` | 1.0.11 | Apache-2.0 |
| `extend` | 3.0.2 | MIT |
| `fetch-blob` | 3.2.0 | MIT |
| `formdata-polyfill` | 4.0.10 | MIT |
| `gaxios` | 7.3.1 | Apache-2.0 |
| `gcp-metadata` | 8.1.2 | Apache-2.0 |
| `google-auth-library` | 10.9.1 | Apache-2.0 |
| `google-logging-utils` | 1.1.3 | Apache-2.0 |
| `https-proxy-agent` | 7.0.6 | MIT |
| `json-bigint` | 1.0.0 | MIT |
| `jwa` | 2.0.1 | MIT |
| `jws` | 4.0.1 | MIT |
| `long` | 5.3.2 | Apache-2.0 |
| `ms` | 2.1.3 | MIT |
| `node-domexception` | 1.0.0 | MIT |
| `node-fetch` | 3.3.2 | MIT |
| `p-retry` | 4.6.2 | MIT |
| `protobufjs` | 7.6.6 | BSD-3-Clause |
| `retry` | 0.13.1 | MIT |
| `safe-buffer` | 5.2.1 | MIT |
| `undici-types` | 6.21.0 | MIT |
| `web-streams-polyfill` | 3.3.3 | MIT |
| `ws` | 8.22.0 | MIT |

If the SDK version changes, regenerate the licence file and this table from `package-lock.json`;
the transitive set moves with it.

---

## gemini-srt-translator

The application's translation and transcription engine is written in TypeScript and runs inside the
application. Parts of it are **adapted from gemini-srt-translator** — its request and prompt
construction, batching, retry and progress behaviour, and the vendored price table
`electron/shared/pricing.json` — under the MIT License below. No gemini-srt-translator executable,
Python runtime or Python package ships with this application.

Project: <https://github.com/MaKTaiL/gemini-srt-translator>

```
MIT License

Copyright (c) 2024 Matheus Castro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## service.subtitles.kodipovilai (Kodi add-on)

Several features are **adapted from the Kodi subtitle add-on `service.subtitles.kodipovilai`** by
MoranTheKing and rewritten in TypeScript: the gender reference rules and prompt, the
subtitle-alignment oracle, the right-to-left and wrong-alphabet repairs, the Wizdom and
OpenSubtitles download handling, and parts of the model reply handling. The shared OpenSubtitles key
list the app uses when you have no key of your own is the add-on's public list, refreshed from its
address once a day, with a copy in `electron/main/osKeyPool.ts` as the fallback. No add-on code or
executable ships with this application. The full licence is `licenses/kodipovilai-MIT.txt`.

Project: <https://morantheking.github.io/Kodi-POV-IL/>

```
MIT License

Copyright (c) 2026 MoranTheKing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## FFmpeg and FFprobe

Used for subtitle-track extraction, media duration, and converting audio for transcription. Bundled
as `resources/bin/ffmpeg.exe` and `resources/bin/ffprobe.exe`. These binaries are **not** tracked in
this repository and are supplied by whoever produces a build.

Project: <https://ffmpeg.org/>
Licensing: <https://ffmpeg.org/legal.html>

FFmpeg is licensed under the **LGPL v2.1 or later**, or under the **GPL** when built with components
that require it. **Which one applies depends on the specific binary that was bundled**, not on this
project.

The binary used to produce the 1.0.0 portable build (the same file SRT AI Translator 1.1.0 shipped) reports:

```
ffmpeg version 8.1.2-essentials_build-www.gyan.dev
configuration: --enable-gpl --enable-version3 --enable-static ...
```

`--enable-gpl` together with `--enable-version3` makes that binary **GPL v3**. Redistributing it
carries the obligations of that license for the binary itself: the GPL v3 text must accompany it,
and the corresponding source must be made available — either shipped, or offered in writing on the
terms the GPL sets out.

The two programs are gyan.dev's `ffmpeg-8.1.2-essentials_build.zip` (SHA-256
`db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec`), unmodified and byte-identical to
its `bin\ffmpeg.exe` and `bin\ffprobe.exe`. **Their corresponding source is published as a separate
download on the same release page as the portable build**,
`ffmpeg-8.1.2-essentials-corresponding-source.zip` at
<https://github.com/Akila3/SRT-AI-Translator-NG/releases/tag/v1.0.0>, for as long as that build is
offered. It holds the FFmpeg 8.1.2 release source and the source of every library the binary links
statically, with a `SOURCES.md` that lists each version, how it was identified, its download address
and its SHA-256. gyan.dev does not publish its build scripts; `SOURCES.md` says which library versions
are read from the binary and which are reconstructed from the build date.

FFmpeg here is invoked as a **separate executable over its command line**; no FFmpeg code is linked
into this application. That is the ordinary basis for treating the two as aggregated works rather
than one combined work, but it does not remove the obligations attaching to the redistributed binary
itself.

**If you produce your own build, check your own binary** with `ffmpeg -version` and read the
`configuration:` line rather than assuming it matches this one.

**Nothing this application asks FFmpeg to do requires a GPL build.** It issues exactly three kinds
of call, and every one of them is satisfied by an LGPL configuration:

| Purpose | Codec arguments |
|---|---|
| Export a text subtitle track | `-c:s srt` |
| Export an image/PGS subtitle track | `-c:s copy` |
| Convert audio for the engine | `-c:a libmp3lame` (LAME is LGPL and needs no `--enable-gpl`) |

The GPL-only components in the shipped binary — x264, x265, Xvid, vidstab, VMAF and similar — are
encoders this application never invokes. Moving to an LGPL build would therefore change no
behaviour while removing the GPL obligations entirely. Verify before swapping that the LGPL build
you choose still ships `libmp3lame` (`ffmpeg -encoders | findstr mp3`), because FFmpeg has no
built-in MP3 encoder of its own and the audio path depends on it.

---

## ALASS (Automatic Language-Agnostic Subtitle Synchronization)

Used only by **Align → Advanced → Piecewise**, which lines a subtitle up piece by piece against
another subtitle or against the speech in a video. Bundled in the Windows build as
`resources\bin\alass\2.0.0\alass.exe`.

Project: <https://github.com/kaegi/alass> — ALASS v2.0.0, Copyright (C) 2017 kaegi.
Licence: **GNU General Public License v3 or later**; the text is `licenses\alass\2.0.0\GPL-3.0.txt`.

**This copy is modified.** One file, `alass-cli/src/main.rs`, gained a `--json-report` option that
writes a machine-readable report of the run; the subtitle it writes is unchanged. The modification
notice is `corresponding-source\MODIFICATIONS.md` and the exact change is
`corresponding-source\report-fork.patch`.

**The complete source ships with it.** `resources\bin\alass\2.0.0\corresponding-source\` holds the
source the executable was built from, its `Cargo.lock`, the build script and receipt (exact
toolchain, flags and expected hash) and the report schema. Building it again gives the same
executable byte for byte. The Rust packages compiled into it are listed, each with its declared
licence, authors, published source location, lockfile checksum and verbatim licence files, in
`licenses\alass\2.0.0\rust-dependencies.txt`. `licenses\alass\2.0.0\rust-toolchain\` carries the
notices for the Rust standard library and the GCC runtime library exception that every program built
by that toolchain contains. Parts of the MinGW-w64 runtime are linked into it as well; their notices
are `licenses\alass\2.0.0\mingw-w64\COPYING.MinGW-w64-runtime.txt`, the upstream v14.0.0 file.

ALASS is started as a **separate program over its command line**, with fixed arguments, and the
application reads the files it writes. No ALASS code is linked into this application, which stays
under its MIT licence. When it reads a video it uses this application's own FFmpeg and FFprobe
(above), not a copy of its own.

The executable, its source, schema and notices are one unit, listed file by file with SHA-256 in
`licenses\alass\2.0.0\UNIT-MANIFEST.json`. If the executable is missing, damaged or a different build,
only Advanced → Piecewise is unavailable.

---

## Electron, Node.js and the renderer stack

The application shell is [Electron](https://www.electronjs.org/), which embeds Chromium and Node.js
and carries its own set of licenses; the packaged build includes `LICENSE.electron.txt` and
`LICENSES.chromium.html`, generated by electron-builder. The React, Zustand, Tailwind and Vite
packages used to build the interface are MIT-licensed and are compiled into the application bundle
rather than redistributed as separate files. Their full dependency set and versions are recorded in
`package-lock.json`.

---

## TMDB

Metadata search and cast lookups are served by [The Movie Database](https://www.themoviedb.org/)
API. This product uses the TMDB API but is **not endorsed or certified by TMDB**. No TMDB code is
bundled; the API is called at run time.

---

## OpenSubtitles and Wizdom

Reference subtitles can be downloaded from [OpenSubtitles.com](https://www.opensubtitles.com/) and
[Wizdom](https://wizdom.xyz/) through their public APIs, at run time. This product is **not
endorsed by or affiliated with either service**. Downloaded subtitles belong to their authors. They
are saved on your own machine, and lines from them are sent only to the Gemini API inside your own
translation requests; this application never publishes or redistributes them.

---

## Google Gemini

Translation and transcription are performed by the Google Gemini API using **your own API key**,
under Google's terms. This product is **not endorsed by or affiliated with Google**.
