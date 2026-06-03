// ─────────────────────────────────────────────────────────────────────────
// NATIVE test of the REAL collar inbound-command path.
//
// Compiles the ACTUAL firmware sources
//   ../../BluePawzTransmitter/src/cmd_inbound.cpp   (parse→target→dispatch→ACK)
//   ../../BluePawzTransmitter/src/name_store.cpp     (validate + persist name)
// — the same translation units that flash to the ESP32 — and throws real
// base-station command strings at them. This directly exercises the user's
// suspected fault points on the collar side:
//
//   1. JSON deserialised correctly                  → BP_PARSE_ERROR cases
//   2. target device_id matched correctly           → for-me / not-for-me / broadcast
//   3. command type matched correctly               → ping / set_name / OTHER
//   4. handler actually invoked + change applied     → name mutated in RAM
//   5. change persisted (survives deep-sleep reset)  → reload from MockNvs
//   6. acknowledgement built + sent back             → ACK JSON contents
//   7. msg_id echoed so the receiver can PAIR the ACK → ack.msg_id == request
//
// If any of these is broken in the flashed code, THIS test fails.
//
// Build/run via native/run.ps1.
// ─────────────────────────────────────────────────────────────────────────
#include "cmd_inbound.h"
#include "name_store.h"
#include "mock_nvs.h"
#include <ArduinoJson.h>
#include <cstdio>
#include <cstring>
#include <string>

static int failures = 0;
static void check(const char *desc, bool ok)
{
  std::printf("  %s %s\n", ok ? "[pass]" : "[FAIL]", desc);
  if (!ok)
    failures++;
}

static const int UID = 430;

// Convenience: run one command against a ctx bound to `name`/`flash`.
static BpInboundResult run(const char *json, char *name, MockNvs &flash,
                           char *ack, size_t ackSz)
{
  BpInboundCtx ctx{UID, name, SENDER_NAME_MAX_LEN + 1, &flash,
                   /*rssi*/ -42, /*snr*/ 7.5f, /*uptime*/ 123456UL};
  return bpHandleInbound(json, ctx, ack, ackSz);
}

// Reload the name from persistent NVS into a FRESH RAM buffer — models a
// deep-sleep wake (RAM wiped, loadSenderName() runs in setup()).
static std::string afterReset(MockNvs &flash)
{
  char fresh[SENDER_NAME_MAX_LEN + 1] = {0};
  bpLoadSenderName(fresh, sizeof(fresh), UID, flash);
  return std::string(fresh);
}

int main()
{
  std::printf("test_collar_cmd — REAL collar inbound-command path (cmd_inbound.cpp)\n");

  MockNvs flash;
  char name[SENDER_NAME_MAX_LEN + 1] = {0};
  bpLoadSenderName(name, sizeof(name), UID, flash); // → "Device-430"
  char ack[256];

  // ── 1. Valid rename addressed to THIS collar ───────────────────────────
  {
    BpInboundResult r = run(
        "{\"cmd\":\"set_name\",\"device_id\":430,\"name\":\"Gizmo\",\"msg_id\":12345}",
        name, flash, ack, sizeof(ack));
    check("rename(Gizmo) → BP_SET_NAME_OK", r.kind == BP_SET_NAME_OK);
    check("rename(Gizmo) reports nameChanged", r.nameChanged);
    check("rename(Gizmo) applied in RAM", std::string(name) == "Gizmo");

    JsonDocument a;
    bool parsed = deserializeJson(a, ack) == DeserializationError::Ok;
    check("ACK is valid JSON", parsed);
    check("ACK ack==set_name", parsed && std::string(a["ack"] | "") == "set_name");
    check("ACK ok==true", parsed && (a["ok"] | false) == true);
    check("ACK device_id==430", parsed && (a["device_id"] | 0) == 430);
    check("ACK name==Gizmo", parsed && std::string(a["name"] | "") == "Gizmo");
    // CHECKPOINT 7 — the receiver pairs ACK→command by echoed msg_id.
    check("ACK echoes msg_id 12345 (ACK pairing)", parsed && (a["msg_id"] | 0u) == 12345u);
  }

  // ── 2. Persistence across a simulated deep-sleep reset ──────────────────
  check("renamed name persists across deep-sleep reset", afterReset(flash) == "Gizmo");

  // ── 3. Rename addressed to a DIFFERENT collar → ignored, no ACK ─────────
  {
    BpInboundResult r = run(
        "{\"cmd\":\"set_name\",\"device_id\":999,\"name\":\"Hijack\",\"msg_id\":1}",
        name, flash, ack, sizeof(ack));
    check("rename for UID 999 → BP_NOT_FOR_ME", r.kind == BP_NOT_FOR_ME);
    check("rename for UID 999 writes no ACK", ack[0] == '\0');
    check("rename for UID 999 leaves my name = Gizmo", std::string(name) == "Gizmo");
  }

  // ── 4. Broadcast rename is refused (renames must be UID-exact) ──────────
  {
    BpInboundResult r = run(
        "{\"cmd\":\"set_name\",\"device_id\":65535,\"name\":\"AllCats\"}",
        name, flash, ack, sizeof(ack));
    check("broadcast rename → BP_NOT_FOR_ME (refused)", r.kind == BP_NOT_FOR_ME);
    check("broadcast rename leaves my name = Gizmo", std::string(name) == "Gizmo");
  }

  // ── 5. Command with no device_id → rejected (UID targeting required) ────
  {
    BpInboundResult r = run("{\"cmd\":\"set_name\",\"name\":\"Nope\"}",
                            name, flash, ack, sizeof(ack));
    check("no device_id → BP_NO_DEVICE_ID", r.kind == BP_NO_DEVICE_ID);
  }

  // ── 6. Invalid name (comma) → rejected with ok:false ACK, name unchanged ─
  {
    BpInboundResult r = run(
        "{\"cmd\":\"set_name\",\"device_id\":430,\"name\":\"bad,name\",\"msg_id\":7}",
        name, flash, ack, sizeof(ack));
    check("invalid name → BP_SET_NAME_BAD", r.kind == BP_SET_NAME_BAD);
    JsonDocument a;
    bool parsed = deserializeJson(a, ack) == DeserializationError::Ok;
    check("invalid-name ACK ok==false", parsed && (a["ok"] | true) == false);
    check("invalid-name ACK echoes msg_id 7", parsed && (a["msg_id"] | 0u) == 7u);
    check("invalid name leaves my name = Gizmo", std::string(name) == "Gizmo");
    check("invalid name not persisted", afterReset(flash) == "Gizmo");
  }

  // ── 7. set_name missing the name field → refused, no ACK ────────────────
  {
    BpInboundResult r = run("{\"cmd\":\"set_name\",\"device_id\":430}",
                            name, flash, ack, sizeof(ack));
    check("set_name w/o name → BP_SET_NAME_BAD", r.kind == BP_SET_NAME_BAD);
  }

  // ── 8. Malformed JSON → parse error ─────────────────────────────────────
  {
    BpInboundResult r = run("{not valid json", name, flash, ack, sizeof(ack));
    check("garbage payload → BP_PARSE_ERROR", r.kind == BP_PARSE_ERROR);
  }

  // ── 9. Missing cmd field → BP_NO_CMD ────────────────────────────────────
  {
    BpInboundResult r = run("{\"device_id\":430}", name, flash, ack, sizeof(ack));
    check("no cmd field → BP_NO_CMD", r.kind == BP_NO_CMD);
  }

  // ── 10. Ping addressed to me → pong with echoed metrics + msg_id ────────
  {
    BpInboundResult r = run("{\"cmd\":\"ping\",\"device_id\":430,\"msg_id\":555}",
                            name, flash, ack, sizeof(ack));
    check("ping → BP_PING", r.kind == BP_PING);
    JsonDocument a;
    bool parsed = deserializeJson(a, ack) == DeserializationError::Ok;
    check("pong pong==true", parsed && (a["pong"] | false) == true);
    check("pong device_id==430", parsed && (a["device_id"] | 0) == 430);
    check("pong name==Gizmo (current label)", parsed && std::string(a["name"] | "") == "Gizmo");
    check("pong echoes rssi -42", parsed && (a["rssi"] | 0) == -42);
    check("pong echoes msg_id 555", parsed && (a["msg_id"] | 0u) == 555u);
  }

  // ── 11. Broadcast ping IS allowed (presence sweep) ──────────────────────
  {
    BpInboundResult r = run("{\"cmd\":\"ping\",\"device_id\":65535}",
                            name, flash, ack, sizeof(ack));
    check("broadcast ping → BP_PING", r.kind == BP_PING);
  }

  // ── 12. mode / get_status are NOT owned here → BP_OTHER (firmware acts) ──
  {
    BpInboundResult r = run(
        "{\"cmd\":\"mode\",\"profile\":\"lost\",\"device_id\":430}",
        name, flash, ack, sizeof(ack));
    check("mode command → BP_OTHER (firmware dispatches)", r.kind == BP_OTHER);
    BpInboundResult r2 = run("{\"cmd\":\"get_status\",\"device_id\":430}",
                             name, flash, ack, sizeof(ack));
    check("get_status command → BP_OTHER", r2.kind == BP_OTHER);
  }

  // ── 13. Second valid rename overwrites + persists (full round-trip) ──────
  {
    BpInboundResult r = run(
        "{\"cmd\":\"set_name\",\"device_id\":430,\"name\":\"Podge\",\"msg_id\":2}",
        name, flash, ack, sizeof(ack));
    check("rename(Podge) → BP_SET_NAME_OK", r.kind == BP_SET_NAME_OK);
    check("rename(Podge) persists across reset", afterReset(flash) == "Podge");
  }

  std::printf(failures ? "\nRESULT: %d FAILED\n" : "\nRESULT: all passed\n", failures);
  return failures ? 1 : 0;
}
