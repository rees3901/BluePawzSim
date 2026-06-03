# BluePawzSim native harness — compiles the REAL firmware cores with a host
# g++ and runs the tests. Run from anywhere:  pwsh native/run.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-Gpp {
  $c = Get-Command g++ -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
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
Write-Host "Using compiler: $gpp`n"

$TX = (Resolve-Path "..\..\BluePawzTransmitter\src").Path
$RX = (Resolve-Path "..\..\BluePawzReceiver\src").Path

# Each test: name + the .cpp files to compile + include dirs.
$tests = @(
  @{ name = "test_name_persist";
     srcs = @("test_name_persist.cpp", (Join-Path $TX "name_store.cpp"));
     incs = @($TX, "mocks") }
)

$fail = 0
foreach ($t in $tests) {
  $exe = Join-Path $PSScriptRoot ($t.name + ".exe")
  $args = @("-std=c++17", "-O1", "-Wall")
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
