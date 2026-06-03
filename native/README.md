# BluePawzSim — native (true-replica) harness

Where the JS sandbox in the parent folder is a *model*, this folder compiles
and runs the **actual firmware source** on the host, so the tests exercise the
exact code that flashes to the ESP32 — no drift.

It works by extracting the hardware-coupled logic out of the firmware into
hardware-independent C++ "core" modules that depend only on small interfaces
(`INvs`, and later `IRadio`/`IClock`). The firmware backs those interfaces with
real hardware (Preferences/RadioLib/millis); this harness backs them with mocks
and a virtual clock. Both compile the **same** `.cpp` files.

## Layout requirement

The harness references the firmware repos by **relative path**, so it expects
the workspace layout the repos already use:

```
Legacy/
├── BluePawzReceiver/      (firmware repo)
├── BluePawzTransmitter/   (firmware repo)
└── BluePawzSim/
    └── native/            ← you are here  (../../BluePawzTransmitter/src, etc.)
```

## Run

```powershell
pwsh native/run.ps1
```

`run.ps1` finds a host `g++`, compiles each test together with the real
firmware core(s) it covers, and runs them. Exit code is non-zero on failure.

## Getting a native compiler (no admin)

The ESP32 toolchains PlatformIO ships are xtensa/riscv cross-compilers — they
can't run on the PC. You need a host `g++`. Pick one:

- **Elevated Chocolatey (cleanest):** in an *Administrator* PowerShell:
  `choco install mingw -y`  → puts `g++` on PATH.
- **Portable WinLibs (no admin):** download a `winlibs-x86_64-...-ucrt-...zip`
  from <https://github.com/brechtsanders/winlibs_mingw/releases>, extract to
  `%USERPROFILE%\winlibs` (so `%USERPROFILE%\winlibs\mingw64\bin\g++.exe`
  exists). `run.ps1` looks there automatically.
- **MSYS2 / scoop:** `scoop install gcc`, or MSYS2's `pacman -S mingw-w64-ucrt-x86_64-gcc`.

## Tests

| Test | Compiles (real firmware source) | Proves |
|---|---|---|
| `test_name_persist.cpp` | `BluePawzTransmitter/src/name_store.cpp` | bug #8 — the user-set name survives deep-sleep resets and is never reverted to the default; invalid renames are rejected without clobbering the stored name |
| `test_collar_cmd.cpp` | `BluePawzTransmitter/src/cmd_inbound.cpp` + `name_store.cpp` | the collar's inbound-command path — JSON parse, immutable-UID targeting (for-me / not-for-me / broadcast / missing), command dispatch (ping / set_name / OTHER), rename apply + **persistence across deep-sleep**, ACK build, and **msg_id echo** (the field the receiver pairs ACKs on). The firmware's `handleModeCommand` delegates these paths to this same `cmd_inbound.cpp`, so the test exercises the exact flashed code. |

`test_collar_cmd` needs ArduinoJson; `run.ps1` finds it inside the firmware's
`.pio/libdeps` automatically and skips the test (with a note) if no firmware
checkout has been built yet.

### What this rules out for the rename / "hangs on waiting" bug

`test_collar_cmd` exercises every collar-side step a base-station command goes
through **except** the two that are inherently hardware/RTOS-coupled and can't
run off-device: the SX1262 RX interrupt + `readData()` actually firing, and the
deep-sleep/awake-window timing that decides whether the collar is *listening*
when the base transmits. Since the logic path is proven correct here, a
real-world failure points at those two — diagnose them with the collar's serial
log (`[RX] Command received …`) and the post-TX RX-window timing, not the
parse/target/apply/ACK code.

The receiver command lifecycle + full RX↔TX round-trip remain to be extracted
behind `IRadio`/`IClock`.
