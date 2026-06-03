# BluePawzSim native harness — compiles the REAL firmware cores with a host
# g++ and runs the tests. Run from anywhere:  pwsh native/run.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-Gpp {
  $c = Get-Command g++ -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
      "C:\ProgramData\mingw64\mingw64\bin\g++.exe",   # choco 'mingw' package
      "C:\ProgramData\chocolatey\lib\mingw\tools\install\mingw64\bin\g++.exe",
      "$env:USERPROFILE\winlibs\mingw64\bin\g++.exe",
      "$env:USERPROFILE\mingw64\bin\g++.exe",
      "$env:USERPROFILE\mingw32\bin\g++.exe",
      "C:\msys64\mingw64\bin\g++.exe",
      "C:\msys64\ucrt64\bin\g++.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$gpp = Find-Gpp
if (-not $gpp) {
  Write-Host "No native g++ found. See native/README.md for how to install one (no admin needed)."
  exit 2
}
# g++ needs its own bin dir on PATH to find cc1plus/as/ld — otherwise it
# exits non-zero with NO diagnostics. Prepend it for this process.
$env:PATH = (Split-Path $gpp) + [IO.Path]::PathSeparator + $env:PATH
Write-Host "Using compiler: $gpp`n"

$TX = (Resolve-Path "..\..\BluePawzTransmitter\src").Path
$RX = (Resolve-Path "..\..\BluePawzReceiver\src").Path

# Locate ArduinoJson (header-only) inside the firmware's PlatformIO libdeps so
# the extracted cores that use it compile against the EXACT version that flashes.
function Find-ArduinoJson {
  foreach ($root in @("..\..\BluePawzTransmitter\.pio\libdeps",
                      "..\..\BluePawzReceiver\.pio\libdeps")) {
    if (-not (Test-Path $root)) { continue }
    $hit = Get-ChildItem -Path $root -Recurse -Filter "ArduinoJson.h" -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -match "[\\/]ArduinoJson[\\/]src[\\/]ArduinoJson\.h$" } |
           Select-Object -First 1
    if ($hit) { return (Split-Path $hit.FullName) }
  }
  return $null
}
$AJ = Find-ArduinoJson
if ($AJ) { Write-Host "Using ArduinoJson: $AJ`n" }

# Each test: name + the .cpp files to compile + include dirs.
$tests = @(
  @{ name = "test_name_persist";
     srcs = @("test_name_persist.cpp", (Join-Path $TX "name_store.cpp"));
     incs = @($TX, "mocks") }
)

# Tests that need ArduinoJson are only added when it was found, so the basic
# harness still runs without a firmware checkout's libdeps present.
if ($AJ) {
  $tests += @{ name = "test_collar_cmd";
               srcs = @("test_collar_cmd.cpp",
                        (Join-Path $TX "cmd_inbound.cpp"),
                        (Join-Path $TX "name_store.cpp"));
               incs = @($TX, "mocks", $AJ) }
} else {
  Write-Host "ArduinoJson not found under .pio/libdeps — skipping test_collar_cmd."
  Write-Host "(Build the firmware once so PlatformIO fetches it, then re-run.)`n"
}

$fail = 0
foreach ($t in $tests) {
  $exe = Join-Path $PSScriptRoot ($t.name + ".exe")
  # -Wno-aggressive-loop-optimizations: silences a KNOWN false-positive from
  # g++ 15 on ArduinoJson 7.4's "tiny string" SSO. The compiler inlines the
  # tiny-string copy branch for short string literals (e.g. "set_name") and
  # warns about an over-read that the RUNTIME guard never reaches — the tests
  # prove the serialized output is correct. The ESP32 (xtensa-gcc) toolchain
  # that actually flashes never emits this; it is a host-build artifact only.
  $args = @("-std=c++17", "-O1", "-Wall", "-Wno-aggressive-loop-optimizations")
  foreach ($i in $t.incs) { $args += "-I"; $args += $i }
  $args += $t.srcs
  $args += @("-o", $exe)
  Write-Host "── building $($t.name) ──"
  & $gpp @args
  if ($LASTEXITCODE -ne 0) { Write-Host "  compile FAILED"; $fail++; continue }
  & $exe
  if ($LASTEXITCODE -ne 0) { $fail++ }
  Write-Host ""
}

if ($fail) { Write-Host "$fail test binary(ies) failed." } else { Write-Host "All native tests passed." }
exit $fail
