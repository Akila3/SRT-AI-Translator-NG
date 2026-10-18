<#
.SYNOPSIS
  Builds the ALASS 2.0.0 sidecar from the tracked Corresponding Source and installs it as
  resources/bin/alass/2.0.0/alass.exe (ignored build output).

.DESCRIPTION
  Fails closed, and leaves any installed alass.exe untouched, when:
    - a file under vendor/alass/2.0.0/source is missing, extra or differs from source-inventory.json;
    - the Cargo.lock or source inventory differs from build-receipt.json;
    - rustc, cargo or gcc is not the exact recorded toolchain;
    - the built executable's SHA-256, size or version line differs from build-receipt.json.
  The receipt is changed deliberately, in a reviewed commit, never by this script.

  The same script ships inside the release, as corresponding-source/build-alass.ps1 beside the
  vendored files. Run from there it builds from that folder and writes to corresponding-source/rebuilt,
  so a recipient can rebuild and compare without touching the installed executable. Packaging never
  ships build.json; the release unit is listed in licenses/alass/2.0.0/UNIT-MANIFEST.json.

.PARAMETER OutDir
  Install folder. Default: resources/bin/alass/2.0.0 under the repository, or rebuilt/ beside this
  script when it runs from a release's corresponding-source folder.

.PARAMETER TargetDir
  Scratch CARGO_TARGET_DIR. Default: a fresh folder under %TEMP%, removed afterwards.

.PARAMETER KeepTarget
  Keep the scratch target folder.
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [string]$TargetDir,
  [switch]$KeepTarget
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$shipped = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'build-receipt.json')
if ($shipped) {
  $vendor = $PSScriptRoot
  if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'rebuilt' }
} else {
  $repo = Split-Path -Parent $PSScriptRoot
  $vendor = Join-Path $repo 'vendor\alass\2.0.0'
  if (-not $OutDir) { $OutDir = Join-Path $repo 'resources\bin\alass\2.0.0' }
}
$source = Join-Path $vendor 'source'
if (-not $TargetDir) { $TargetDir = Join-Path ([IO.Path]::GetTempPath()) ('ng-alass-build-' + [guid]::NewGuid().ToString('N').Substring(0, 12)) }

function Fail([string]$why) { throw "build-alass: $why" }
function Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Native([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = @(& $exe @argv 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($argv -join ' ') exited $LASTEXITCODE`n$($out -join "`n")" }
  return , $out
}

$receipt = Get-Content -LiteralPath (Join-Path $vendor 'build-receipt.json') -Raw | ConvertFrom-Json
$inventoryPath = Join-Path $vendor 'source-inventory.json'
$inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json

# 1. Corresponding Source is exactly the inventory.
if ((Sha $inventoryPath) -ne $receipt.inputs.sourceInventorySha256) { Fail 'source-inventory.json differs from build-receipt.json' }
if ((Sha (Join-Path $source 'Cargo.lock')) -ne $receipt.inputs.cargoLockSha256) { Fail 'Cargo.lock differs from build-receipt.json' }
$sourceRoot = (Resolve-Path -LiteralPath $source).Path
$onDisk = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($sourceRoot.Length + 1).Replace('\', '/') } | Sort-Object)
$listed = @($inventory.files | ForEach-Object { $_.path } | Sort-Object)
$extra = @($onDisk | Where-Object { $listed -notcontains $_ })
$missing = @($listed | Where-Object { $onDisk -notcontains $_ })
if ($extra.Count -or $missing.Count) { Fail "source tree differs from inventory: extra [$($extra -join ', ')] missing [$($missing -join ', ')]" }
foreach ($f in $inventory.files) {
  if ((Sha (Join-Path $sourceRoot $f.path)) -ne $f.sha256) { Fail "source file $($f.path) differs from inventory" }
}
Write-Host "source: $($listed.Count) files match the inventory"

# 2. Exact toolchain.
$tc = $receipt.toolchain
$rustc = Native 'rustup' @('run', $tc.rustupToolchain, 'rustc', '-vV')
$field = { param($name) ($rustc | Where-Object { $_ -like "${name}: *" } | Select-Object -First 1) -replace "^${name}: ", '' }
if ($rustc[0] -ne $tc.rustc) { Fail "rustc is '$($rustc[0])', expected '$($tc.rustc)'" }
if ((& $field 'commit-hash') -ne $tc.rustcCommitHash) { Fail 'rustc commit hash differs' }
if ((& $field 'host') -ne $tc.rustcHost) { Fail 'rustc host differs' }
if ((& $field 'LLVM version') -ne $tc.llvm) { Fail 'rustc LLVM version differs' }
$cargo = (Native 'rustup' @('run', $tc.rustupToolchain, 'cargo', '-V'))[0]
if ($cargo -ne $tc.cargo) { Fail "cargo is '$cargo', expected '$($tc.cargo)'" }
$gcc = (Native 'gcc' @('--version'))[0]
if ($gcc -ne $tc.gcc) { Fail "gcc is '$gcc', expected '$($tc.gcc)'" }
Write-Host "toolchain: $($tc.rustc); $cargo; $gcc"

# 3. Build into scratch.
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$sep = [char]0x1f
$savedFlags = $env:CARGO_ENCODED_RUSTFLAGS
$savedTarget = $env:CARGO_TARGET_DIR
$savedRustflags = $env:RUSTFLAGS
try {
  Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue
  $env:CARGO_ENCODED_RUSTFLAGS = "--remap-path-prefix=$cargoHome=/cargo$sep--remap-path-prefix=$sourceRoot=/alass$sep-Clink-arg=-Wl,--no-insert-timestamp"
  $env:CARGO_TARGET_DIR = $TargetDir
  $null = Native 'rustup' @('run', $tc.rustupToolchain, 'cargo', 'build', '--locked', '--release', '--manifest-path', (Join-Path $sourceRoot 'Cargo.toml'))
} finally {
  $env:CARGO_ENCODED_RUSTFLAGS = $savedFlags
  $env:CARGO_TARGET_DIR = $savedTarget
  $env:RUSTFLAGS = $savedRustflags
}

try {
  # 4. The built executable is exactly the receipt.
  $built = Join-Path $TargetDir $receipt.executable.built
  $hash = Sha $built
  $bytes = (Get-Item -LiteralPath $built).Length
  if ($hash -ne $receipt.executable.sha256 -or $bytes -ne $receipt.executable.bytes) {
    Fail "built executable is $hash ($bytes bytes), expected $($receipt.executable.sha256) ($($receipt.executable.bytes) bytes); nothing installed"
  }
  $version = (Native $built @('--version'))[0]
  if ($version -ne $receipt.executable.versionLine) { Fail "built executable reports '$version'; nothing installed" }

  # 5. Stage beside the target, re-verify, then swap in with one rename.
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $final = Join-Path $OutDir 'alass.exe'
  $staged = Join-Path $OutDir ('.alass.exe.' + [guid]::NewGuid().ToString('N') + '.partial')
  try {
    Copy-Item -LiteralPath $built -Destination $staged
    if ((Sha $staged) -ne $receipt.executable.sha256) { Fail 'staged copy differs; nothing installed' }
    if (Test-Path -LiteralPath $final) { [IO.File]::Replace($staged, $final, [NullString]::Value) } else { [IO.File]::Move($staged, $final) }
  } finally {
    if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
  }
  if ((Sha $final) -ne $receipt.executable.sha256) { Fail 'installed executable differs after the swap' }

  $actual = [ordered]@{
    component = $receipt.component
    version = $receipt.version
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    toolchain = [ordered]@{ rustc = $rustc[0]; cargo = $cargo; gcc = $gcc }
    sourceInventorySha256 = $receipt.inputs.sourceInventorySha256
    sha256 = $hash
    bytes = $bytes
    versionLine = $version
  }
  $json = ($actual | ConvertTo-Json -Depth 4) + "`n"
  $tmp = Join-Path $OutDir ('.build.json.' + [guid]::NewGuid().ToString('N') + '.partial')
  [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding $false))
  $buildJson = Join-Path $OutDir 'build.json'
  if (Test-Path -LiteralPath $buildJson) { [IO.File]::Replace($tmp, $buildJson, [NullString]::Value) } else { [IO.File]::Move($tmp, $buildJson) }
  Write-Host "installed $final ($hash)"
} finally {
  if (-not $KeepTarget -and (Test-Path -LiteralPath $TargetDir)) { Remove-Item -LiteralPath $TargetDir -Recurse -Force }
}
