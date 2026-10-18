# Changelog

All notable changes to SRT AI Translator NG are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-18

The first release of SRT AI Translator NG (New Generation), a new product built from
[SRT AI Translator](https://github.com/Akila3/SRT-AI-Translator) 1.1.0. The list below is what is
different from 1.1.0. Everything else 1.1.0 did is kept, including embedded-track extraction and
export, TMDB context, and an optional audio track that lets Gemini hear who is speaking.

### Changed

- **The engine runs inside the app.** Translation and transcription call the Gemini API directly
  through Google's SDK. The bundled `gemini-srt-translator` executable and its Python runtime are gone,
  and with them the work of reading a terminal's printed output to find out what happened. Parts of
  the engine are adapted from gemini-srt-translator under its MIT licence.
- **Every Gemini key is usable.** 1.1.0 ranked five keys but the engine could take two (and
  transcription one). A run can now use any ranked key that supports the selected model.
- **Why a request was refused is known.** A content block is read from the reply's own fields rather
  than inferred from an exit code, and the log says which kind it was.
- **Its own identity and settings.** NG installs and runs beside 1.1.0 without touching its settings.

### Added

- **Align tab.** Fixes a subtitle's timing against another subtitle or the video: one global shift and
  speed correction when the evidence supports it, or Advanced → Piecewise (ALASS, bundled with its
  source) for a different cut. Only times change, and nothing is written until you save.
- **Free-Tier Protection.** Paces Free-key requests from a request journal, groups keys that share one
  Google Cloud budget into Quota Groups, accepts manual AI Studio limits, and moves to a Paid key only
  when Allow paid fallback is on.
- **Resume.** An interrupted Translate or Transcribe run can be continued or started over.
- **Gender reference for Hebrew.** A subtitle of the same release in a language that marks gender,
  chosen or downloaded automatically from OpenSubtitles, corrects the translation's gendered forms.
  Optional experimental Advanced Hebrew correction adds speaker-gender repair, a pass for unreferenced
  lines, and Spanish/Portuguese reference rules.
- **Right-to-left output.** Five RTL display methods for saved copies, a wrong-alphabet repair and an
  other-alphabet redo for Hebrew output.
- **Transcription checks.** Each chunk's text is checked against the speech in its audio; empty or
  refused chunks are asked for again in smaller pieces. Dedicated transcription models with word
  timings, and an optional polishing pass that keeps every timing.
- **Subtitle sources.** OpenSubtitles (your own account and key, or a shared community key pool) and
  Wizdom.
- **Source checks when a file is chosen.** Encoding (UTF-8 or a legacy code page) and language are
  detected up front, and the app asks when it cannot be sure.
- **A run record.** Every run writes a `.run.jsonl` step-by-step record beside its `.console.log`, with
  no subtitle text and no keys, ready to attach to a bug report.
### Removed

- **`.ass` translation.** NG translates SubRip `.srt` only; an `.ass`/`.ssa` file is refused when it is
  chosen. Use SRT AI Translator 1.1.0 for styled `.ass` subtitles.
- **Streaming inside a batch.** Every reply is read whole and checked before it is committed.

[1.0.0]: https://github.com/Akila3/SRT-AI-Translator-NG/releases/tag/v1.0.0
