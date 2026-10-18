Licences for the third-party software redistributed with SRT AI Translator NG.

  FFmpeg-GPL-3.0.txt             Covers resources\bin\ffmpeg.exe and resources\bin\ffprobe.exe.
                                 The bundled binary is a gyan.dev "essentials" build configured
                                 with --enable-gpl --enable-version3, which makes it GPL v3.

                                 Package: ffmpeg-8.1.2-essentials_build.zip, unmodified.

                                 Corresponding source: the download
                                   ffmpeg-8.1.2-essentials-corresponding-source.zip
                                 on the release page of this build,
                                   https://github.com/Akila3/SRT-AI-Translator-NG/releases/tag/v1.0.0
                                 It holds FFmpeg 8.1.2 and every statically linked library,
                                 listed with versions and SHA-256 in its SOURCES.md.

                                 FFmpeg is run as a separate executable over its command line.
                                 No FFmpeg code is linked into this application.

  gemini-srt-translator-MIT.txt  Covers the parts of this application's translation and
                                 transcription engine adapted from gemini-srt-translator.
                                 No gemini-srt-translator executable or Python runtime ships.

  kodipovilai-MIT.txt            Covers the parts adapted from the Kodi add-on
                                 service.subtitles.kodipovilai by MoranTheKing (MIT): gender
                                 reference, alignment oracle, right-to-left and wrong-alphabet
                                 repairs, Wizdom/OpenSubtitles downloads and the shared
                                 OpenSubtitles key list. No add-on code ships.

  google-genai-and-dependencies.txt
                                 Covers the Google Gen AI SDK (@google/genai, Apache-2.0) and
                                 the 40 packages it brings in (Apache-2.0, BSD-3-Clause, MIT),
                                 which ship inside the application archive. Each licence is
                                 copied verbatim from the installed package.

  alass\2.0.0\                   Covers resources\bin\alass\2.0.0\alass.exe (Windows build only),
                                 a modified ALASS v2.0.0 by kaegi, GPL v3 or later. Its README.txt
                                 explains the licence, the modification and the files here.

                                 Corresponding source: shipped beside the executable in
                                   resources\bin\alass\2.0.0\corresponding-source\

                                 ALASS is run as a separate executable over its command line.
                                 No ALASS code is linked into this application.

SRT AI Translator NG itself is MIT licensed - see LICENSE.txt in the folder above.
Electron and Chromium ship their own notices as LICENSE.electron.txt and
LICENSES.chromium.html, also in the folder above.

THIRD-PARTY-NOTICES.md, alongside this application, explains all of the above in full.
