"use strict";
// ─────────────────────────────────────────────────────────────────────────
// Simulated transmitter / collar.
//
// Mirrors BluePawzTransmitter/src/main.cpp:
//   * MAC-derived immutable device_id (UID); editable `name` in fake NVS.
//   * Class-A duty cycle: sleep → wake → TX telemetry → open post-TX RX
//     window → handle commands → sleep. (GPS/BLE/LED are stubbed away.)
//   * handleModeCommand(): targets by device_id only; applies mode /
//     set_name / get_status / ping and queues the matching ACK/pong, echoing
//     msg_id (and req_msg_id for status). All field formats match the firmware.
//
// Test knobs (constructor opts):
//   ackEnabled  (default true)  — set false to model a collar that RECEIVES
//                                 commands but never ACKs (broken uplink).
//   neverWake   (default false) — model a dead / out-of-range collar.
//   firstWakeMs (default 0)     — when the collar first wakes.
// ─────────────────────────────────────────────────────────────────────────

const P = require("./protocol");

class Collar {
  constructor({ clock, channel, deviceId, name, mode = "developer", opts = {} }) {
    this.clock = clock;
    this.channel = channel;
    this.deviceId = deviceId;            // immutable UID
    this.nvs = { name: name || `Device-${deviceId}` }; // persists across the run
    this.mode = mode;
    this.fw = "sim-1.0";
    this.awake = false;
    this.msgCounter = 1;                  // own outbound counter (telemetry/status msg_id)
    this.bootMs = clock.now;
    this.ackEnabled = opts.ackEnabled !== false;
    this.neverWake = !!opts.neverWake;
    this.firstWakeMs = opts.firstWakeMs || 0;
    this._sleepToken = null;
    this.events = [];                     // observability log for assertions

    this.radio = channel.register({
      id: this.label(),
      isListening: () => this.awake,
      onReceive: (pkt) => this._onReceive(pkt),
    });
  }

  label() { return `collar:${this.deviceId}`; }
  get name() { return this.nvs.name; }
  _log(kind, detail) { this.events.push({ t: this.clock.now, kind, detail }); }

  start() {
    if (this.neverWake) { this._log("dead", "neverWake=true"); return; }
    this.clock.at(this.firstWakeMs, () => this._wake(), `${this.label()} first-wake`);
  }

  _sleepIntervalMs() {
    const m = P.MODES[this.mode] || P.MODES.developer;
    return m.sleep_s * 1000;
  }

  _wake() {
    if (this.neverWake) return;
    this.awake = true;
    this._log("wake", `mode=${this.mode}`);
    // Build + transmit telemetry exactly as the firmware does.
    const status = this.mode === "lost" ? "lost" : "roaming";
    const tlm = P.telemetry({
      msg_id: this.msgCounter++,
      device_id: this.deviceId,
      name: this.nvs.name,
      status,
      mode: this.mode,
      lat: 51.8738 + (Math.sin(this.clock.now / 1e6) * 1e-4),
      lon: -2.2394,
      time: `t+${this.clock.now}`,
    });
    this.channel.transmit(this.radio.id, tlm);

    // Open the post-TX RX window; sleep when it lapses.
    this._scheduleSleep(P.RXWINDOW.POST_TX_LISTEN_MS);
  }

  _scheduleSleep(delayMs) {
    if (this._sleepToken) this.clock.cancel(this._sleepToken);
    this._sleepToken = this.clock.at(delayMs, () => this._sleep(), `${this.label()} sleep`);
  }

  _sleep() {
    this.awake = false;
    this._log("sleep", null);
    this.clock.at(this._sleepIntervalMs(), () => this._wake(), `${this.label()} wake`);
  }

  _onReceive(pkt) {
    if (!this.awake) return; // belt-and-braces; the channel already gates this
    if (typeof pkt.cmd !== "string") return; // collars only act on commands

    // V3.6.0 targeting: strictly by device_id (UID) or broadcast.
    if (typeof pkt.device_id !== "number") { this._log("cmd-reject", "no device_id"); return; }
    if (pkt.device_id !== this.deviceId && pkt.device_id !== P.BROADCAST_ID) {
      this._log("cmd-ignore", `for ${pkt.device_id}, I am ${this.deviceId}`);
      return;
    }

    this._log("cmd-rx", pkt.cmd + (pkt.profile ? `:${pkt.profile}` : "") + (pkt.name ? `:${pkt.name}` : ""));
    // Each received command extends the RX window (mirrors POST_TX_EXTEND_MS).
    this._scheduleSleep(P.RXWINDOW.POST_TX_EXTEND_MS);

    let reply = null;
    switch (pkt.cmd) {
      case "mode": {
        const m = P.MODES[pkt.profile];
        if (!m) { this._log("cmd-bad", `unknown profile ${pkt.profile}`); return; }
        this.mode = pkt.profile; // apply
        this._log("apply-mode", pkt.profile);
        reply = P.ackMode({
          device_id: this.deviceId, name: this.nvs.name,
          profile: pkt.profile, power: m.power, sleep: m.sleep_s, msg_id: pkt.msg_id,
        });
        break;
      }
      case "set_name": {
        const ok = this._validName(pkt.name);
        if (ok) { this.nvs.name = pkt.name; this._log("apply-name", pkt.name); } // persists in NVS
        else this._log("name-reject", String(pkt.name));
        reply = P.ackSetName({ device_id: this.deviceId, name: this.nvs.name, ok, msg_id: pkt.msg_id });
        break;
      }
      case "get_status": {
        const m = P.MODES[this.mode] || P.MODES.developer;
        reply = P.statusResponse({
          device_id: this.deviceId, name: this.nvs.name, mode: this.mode,
          power: m.power, sleep: m.sleep_s, fw: this.fw,
          ownMsgId: this.msgCounter++, req_msg_id: pkt.msg_id,
        });
        break;
      }
      case "ping": {
        reply = P.pong({
          device_id: this.deviceId, name: this.nvs.name,
          rssi: -55, snr: 9.5, uptime_ms: this.clock.now - this.bootMs, msg_id: pkt.msg_id,
        });
        break;
      }
      default:
        this._log("cmd-unknown", pkt.cmd);
        return;
    }

    if (reply && this.ackEnabled) {
      // Small processing latency before the collar's radio TXes the reply.
      this.clock.at(20, () => {
        if (!this.awake) return;
        this._log("reply-tx", reply.ack || (reply.pong ? "pong" : reply.status));
        this.channel.transmit(this.radio.id, reply);
      }, `${this.label()} reply`);
    } else if (reply && !this.ackEnabled) {
      this._log("ack-suppressed", "ackEnabled=false");
    }
  }

  _validName(n) {
    if (typeof n !== "string") return false;
    if (n.length < 1 || n.length > 15) return false;
    return !/[\x00-\x1f",\\]/.test(n);
  }
}

module.exports = { Collar };
