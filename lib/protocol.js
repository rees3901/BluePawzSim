"use strict";
// ─────────────────────────────────────────────────────────────────────────
// Shared protocol constants + wire-format helpers.
//
// This is the single source of truth the sandbox shares between the
// simulated collar and base — the SAME role the JSON wire format plays
// between the real firmwares. Values mirror the firmware:
//   * lifecycle constants  → BluePawzReceiver/src/main.cpp (v3.6.4)
//   * RX-window constants   → BluePawzTransmitter/src/main.cpp
//   * operating modes       → Bluepawz*/include/config.h
//
// ⚠ DRIFT WARNING: if you change a constant or a wire field in the
// firmware, change it here too. The README explains how to keep them in
// sync. Each constant notes the firmware #define it tracks.
// ─────────────────────────────────────────────────────────────────────────

const BROADCAST_ID = 65535; // DEVICE_ID_BROADCAST (0xFFFF)

// Receiver command-lifecycle tuning — mirrors the #defines in
// BluePawzReceiver/src/main.cpp.
const LIFECYCLE = {
  COMMAND_TX_INTERVAL: 3000,        // safety-net spacing between speculative sends
  COMMAND_SPECULATIVE_MAX: 2,       // immediate + 1 safety-net speculative send
  COMMAND_MAX_WAKE_ATTEMPTS: 10,    // collar-awake sends w/o ACK before FAILED
  COMMAND_MAX_AGE_MS: 1800000,      // 30 min durable-command backstop
  COMMAND_PING_TIMEOUT_MS: 8000,    // ephemeral presence-check window
  COMMAND_DELIVERED_LINGER_MS: 10000,
  COMMAND_FAILED_LINGER_MS: 60000,
};

// Collar post-TX RX window — mirrors BluePawzTransmitter/src/main.cpp.
const RXWINDOW = {
  POST_TX_LISTEN_MS: 20000, // hold RX open this long after telemetry
  POST_TX_EXTEND_MS: 3000,  // extend per received command (command bursts)
};

// Operating modes — mirrors the OperatingMode table in
// BluePawzTransmitter/include/config.h (v3.3.0 power levels). The sim only
// needs the sleep interval + power for realism; lat/lon/LED are irrelevant.
const MODES = {
  normal:    { sleep_s: 300,  power: 17 },
  active:    { sleep_s: 60,   power: 17 },
  powersave: { sleep_s: 1200, power: 10 },
  lost:      { sleep_s: 30,   power: 22 },
  developer: { sleep_s: 60,   power: 14 },
};

// Command-status names — mirror CommandStatus enum / commandStatusName().
const STATUS = {
  QUEUED: "queued",
  SENDING: "sending",
  AWAITING_ACK: "awaiting_ack",
  DELIVERED: "delivered",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

// ── Wire-format builders (collar → base). Field names match the firmware
//    exactly (BluePawzTransmitter/src/main.cpp, v3.6.0 device_id+name model).

function telemetry({ msg_id, device_id, name, status, mode, lat, lon, time }) {
  const d = { msg_id, device_id, name, status, mode };
  if (lat !== undefined) d.lat = lat;
  if (lon !== undefined) d.lon = lon;
  if (time !== undefined) d.time = time;
  return d;
}

function ackMode({ device_id, name, profile, power, sleep, msg_id }) {
  return { ack: "mode", profile, power, sleep, device_id, name, msg_id };
}

function ackSetName({ device_id, name, ok, msg_id }) {
  return { ack: "set_name", ok, device_id, name, msg_id };
}

function statusResponse({ device_id, name, mode, power, sleep, fw, ownMsgId, req_msg_id }) {
  return { status: "ok", fw, device_id, name, mode, power, sleep, msg_id: ownMsgId, req_msg_id };
}

function pong({ device_id, name, rssi, snr, uptime_ms, msg_id }) {
  return { pong: true, device_id, name, rssi, snr, uptime_ms, msg_id };
}

// ── Command builders (base → collar). Match BluePawzReceiver/src/main.cpp.
function cmdMode({ device_id, profile, msg_id }) {
  return { cmd: "mode", profile, device_id, msg_id };
}
function cmdGetStatus({ device_id, msg_id }) {
  return { cmd: "get_status", device_id, msg_id };
}
function cmdSetName({ device_id, name, msg_id }) {
  return { cmd: "set_name", device_id, name, msg_id };
}
function cmdPing({ device_id, msg_id }) {
  return { cmd: "ping", device_id, msg_id };
}

// Classify an inbound packet the way the receiver's handleLoRaPacketJSON
// isResponse() check does, so base/collar route consistently.
function isResponse(p) {
  return (
    typeof p.ack === "string" ||
    p.pong === true ||
    (typeof p.status === "string" && typeof p.mode === "string" &&
      p.lat === undefined && p.latitude === undefined)
  );
}

module.exports = {
  BROADCAST_ID, LIFECYCLE, RXWINDOW, MODES, STATUS,
  telemetry, ackMode, ackSetName, statusResponse, pong,
  cmdMode, cmdGetStatus, cmdSetName, cmdPing, isResponse,
};
