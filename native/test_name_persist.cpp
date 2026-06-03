// ─────────────────────────────────────────────────────────────────────────
// NATIVE test of the REAL collar name-persistence logic.
//
// This compiles the ACTUAL firmware source
//   ../../BluePawzTransmitter/src/name_store.cpp
// (the same translation unit that flashes to the ESP32) and exercises it
// across simulated deep-sleep resets. It directly targets bug #8: "the
// transmitter later overwriting the user-defined name with its default name
// when it next reports in."
//
// The collar deep-sleeps between reports; each wake is a full chip reset, so
// g_senderName (RAM) is wiped and must be reloaded from NVS by loadSenderName()
// in setup(). We model that exactly: a fresh RAM buffer per "boot", reloaded
// from a persistent MockNvs via the real bpLoadSenderName(). If the real logic
// has a revert-to-default bug, THIS test fails — unlike the JS model, which
// kept the name in RAM forever and could never catch it.
//
// Build it with native/run.ps1 (which compiles this with the real
// ../../BluePawzTransmitter/src/name_store.cpp and runs it).
// ─────────────────────────────────────────────────────────────────────────
#include "name_store.h"
#include "mock_nvs.h"
#include <cstdio>
#include <string>

static int failures = 0;
static void check(const char *desc, bool ok) {
  std::printf("  %s %s\n", ok ? "[pass]" : "[FAIL]", desc);
  if (!ok) failures++;
}

// Simulate a fresh boot/wake: brand-new RAM (deep sleep wiped it), reloaded
// from the persistent NVS via the REAL firmware function.
static std::string boot(MockNvs &nvs, int deviceId) {
  char name[SENDER_NAME_MAX_LEN + 1] = {0}; // RAM is wiped on deep-sleep wake
  bpLoadSenderName(name, sizeof(name), deviceId, nvs);
  return std::string(name);
}

int main() {
  std::printf("test_name_persist — REAL collar name_store across deep-sleep resets\n");
  MockNvs flash; // the NVS chip — survives resets
  const int UID = 430;

  // Boot 1: nothing stored → default name.
  check("boot 1: default name is Device-430", boot(flash, UID) == "Device-430");

  // While awake, a set_name "Gizmo" arrives → persist (REAL bpSaveSenderName).
  char live[SENDER_NAME_MAX_LEN + 1] = {0};
  bpLoadSenderName(live, sizeof(live), UID, flash);
  bool saved = bpSaveSenderName("Gizmo", live, sizeof(live), flash);
  check("set_name 'Gizmo' accepted + applied in RAM", saved && std::string(live) == "Gizmo");

  // ── BUG #8 ── deep-sleep reset → boot 2: RAM wiped, must reload Gizmo.
  check("boot 2 after deep sleep keeps 'Gizmo' (no revert to default)", boot(flash, UID) == "Gizmo");
  check("boot 3 still 'Gizmo'", boot(flash, UID) == "Gizmo");

  // An invalid rename must be rejected and must NOT clobber the stored name.
  bool badOk = bpSaveSenderName("bad,name", live, sizeof(live), flash);
  check("invalid name 'bad,name' rejected", !badOk);
  check("stored name unchanged after rejected rename", boot(flash, UID) == "Gizmo");

  // A second valid rename overwrites cleanly and persists.
  bpLoadSenderName(live, sizeof(live), UID, flash);
  bpSaveSenderName("Podge", live, sizeof(live), flash);
  check("rename to 'Podge' persists across reset", boot(flash, UID) == "Podge");

  std::printf(failures ? "\nRESULT: %d FAILED\n" : "\nRESULT: all passed\n", failures);
  return failures ? 1 : 0;
}
