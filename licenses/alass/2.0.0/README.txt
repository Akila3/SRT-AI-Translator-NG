ALASS 2.0.0 - Automatic Language-Agnostic Subtitle Synchronization

  Covers resources\bin\alass\2.0.0\alass.exe, the separate program the application starts for
  Align -> Advanced -> Piecewise. Nothing else in the application uses it.

  Author       kaegi, https://github.com/kaegi/alass
               Copyright (C) 2017 kaegi
  Licence      GNU General Public License version 3 or (at your option) any later version.
               The full text is GPL-3.0.txt in this folder.

  This copy is MODIFIED. One file, alass-cli/src/main.rs, gained a --json-report option that writes
  a machine-readable report of what the program did; the subtitle it writes is unchanged.
  The modification notice and change log are corresponding-source\MODIFICATIONS.md and the exact
  change is corresponding-source\report-fork.patch.

  Corresponding Source
    resources\bin\alass\2.0.0\corresponding-source\ beside the executable holds the complete source
    the executable was built from: the upstream v2.0.0 tree with the change applied, Cargo.lock,
    the build receipt (exact toolchain, flags and expected executable hash), the report schema and
    the build instructions in its README.md. Building it again gives the same executable byte for
    byte.

  Files in this folder
    GPL-3.0.txt               the GNU GPL v3, unmodified
    rust-dependencies.txt     every Rust package compiled into alass.exe: its declared licence,
                              authors, where its exact source is published, and its licence
                              files verbatim. Generated from Cargo.lock.
    rust-toolchain\           notices for the parts of the Rust toolchain compiled into every
                              Rust program: the Rust standard library (COPYRIGHT-library.html)
                              and the GCC runtime library exception (COPYING.RUNTIME, COPYING3,
                              README.txt). Copied from the toolchain the receipt names.
    mingw-w64\COPYING.MinGW-w64-runtime.txt
                              the MinGW-w64 runtime notice: parts of that runtime are linked
                              into alass.exe, and their licences ask for these notices. The
                              upstream v14.0.0 file, unmodified.
    UNIT-MANIFEST.json        every file of this component with its SHA-256. The executable,
                              its source, its schema and these notices are one unit: they are
                              installed, updated and removed together, never mixed.

  If alass.exe is missing, damaged or a different build, only Advanced -> Piecewise is
  unavailable. Global alignment and everything else keep working, and no subtitle is touched.
