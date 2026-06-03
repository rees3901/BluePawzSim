"use strict";
// ─────────────────────────────────────────────────────────────────────────
// Simulated receiver / base station.
//
// Mirrors the command lifecycle in BluePawzReceiver/src/main.cpp (v3.6.4):
//   * enqueueAndSendNow → 1 immediate SPECULATIVE send.
//   * processCommandQueue safety-net → up to COMMAND_SPECULATIVE_MAX
//     speculative sends, then the command is SCHEDULED (stays QUEUED).
//   * On a target collar's telemetry (proof it's awake) → OPPORTUNISTIC send
//     into its RX window → AWAITING_ACK (counts toward MAX_WAKE_ATTEMPTS).
//   * ACK / pong / status-response → markCommandDelivered (by UID + msg_id).
//   * FAILED only on wake-cap, or age backstop (ephemeral ping = short window).
//   * Every status transition emits a command_status event = the WS push that
//     drives the GUI. (See GuiModel below.)
//
// Always in RX (mains-powered) except while transmitting (half-duplex handled
// by the Channel via txBusyUntil).
// ─────────────────────────────────────────────────────────────────────────

const P = require("./protocol");

class Base {
  constructor({ clock, channel, log = () => {} }) {
    this.clock = clock;
    this.channel = channel;
    this.log = log;
    this.queue = [];
    this.nodeStates = new Map(); // uid → { name, mode, lastSeen }
    this.nextMsgId = 1;
    this.lastCommandTxMs = -1e9;
    this._statusListeners = [];
    this._nodeListeners = [];

    this.radio = channel.register({
      id: "base",
      isListening: () => true,
      onReceive: (pkt) => this._onReceive(pkt),
    });
    // The firmware loop(): reap/age + safety-net retry. 250 ms tick.
    this.clock.every(250, () => this._tick(), "base loop");
  }

  onCommandStatus(fn) { this._statusListeners.push(fn); }
  onNodeState(fn) { this._nodeListeners.push(fn); }

  // ── Public command API (what /send-command does on the receiver) ────────
  sendMode(targetId, profile) {
    return this._enqueue(P.cmdMode({ device_id: targetId, profile, msg_id: 0 }),
      `mode→${profile}`, targetId, false);
  }
  sendStatus(targetId) {
    return this._enqueue(P.cmdGetStatus({ device_id: targetId, msg_id: 0 }),
      "get_status", targetId, false);
  }
  sendRename(targetId, name) {
    return this._enqueue(P.cmdSetName({ device_id: targetId, name, msg_id: 0 }),
      `rename→${name}`, targetId, false);
  }
  sendPing(targetId) {
    return this._enqueue(P.cmdPing({ device_id: targetId, msg_id: 0 }),
      "ping", targetId, true);
  }
  cancel(msgId) {
    const c = this.queue.find((x) => x.msgId === msgId);
    if (c && [P.STATUS.QUEUED, P.STATUS.SENDING, P.STATUS.AWAITING_ACK].includes(c.status)) {
      this._setStatus(c, P.STATUS.CANCELLED);
      return true;
    }
    return false;
  }

  nameForId(uid) {
    const n = this.nodeStates.get(uid);
    return (n && n.name) || `Device-${uid}`;
  }

  // ── Lifecycle internals ─────────────────────────────────────────────────
  _enqueue(obj, label, targetId, ephemeral) {
    const msgId = this.nextMsgId++;
    obj.msg_id = msgId;
    const cmd = {
      msgId, targetId, label, ephemeral,
      name: this.nameForId(targetId),
      obj,
      status: P.STATUS.QUEUED,
      statusChangedMs: this.clock.now,
      timestamp: this.clock.now,
      txAttempts: 0,
      wakeAttempts: 0,
    };
    this.queue.push(cmd);
    this._emitStatus(cmd);
    this.log(`[CMD] queued msg_id=${msgId} ${label} → UID ${targetId}${ephemeral ? " (ping)" : ""}`);
    this._transmit(cmd, /*collarAwake=*/false); // immediate speculative
    return cmd;
  }

  _setStatus(cmd, status) {
    if (cmd.status === status) return;
    this.log(`[CMD] ${cmd.msgId} ${cmd.status} → ${status}`);
    cmd.status = status;
    cmd.statusChangedMs = this.clock.now;
    this._emitStatus(cmd);
  }
  _emitStatus(cmd) {
    const snapshot = {
      msg_id: cmd.msgId, target_id: cmd.targetId, device: cmd.name,
      label: cmd.label, status: cmd.status,
      attempts: cmd.txAttempts, wake_attempts: cmd.wakeAttempts,
    };
    for (const fn of this._statusListeners) fn(snapshot);
  }

  // transmitCommandAt(idx, collarAwake)
  _transmit(cmd, collarAwake) {
    const maxAge = cmd.ephemeral ? P.LIFECYCLE.COMMAND_PING_TIMEOUT_MS : P.LIFECYCLE.COMMAND_MAX_AGE_MS;
    if (this.clock.now - cmd.timestamp > maxAge) {
      this.log(`[CMD] ${cmd.msgId} exceeded max age (${maxAge}ms${cmd.ephemeral ? ", ping" : ""}) → FAILED`);
      this._setStatus(cmd, P.STATUS.FAILED);
      return;
    }
    if (collarAwake) {
      if (cmd.wakeAttempts >= P.LIFECYCLE.COMMAND_MAX_WAKE_ATTEMPTS) {
        this.log(`[CMD] ${cmd.msgId} collar woke ${cmd.wakeAttempts}× w/o ACK → FAILED`);
        this._setStatus(cmd, P.STATUS.FAILED);
        return;
      }
      cmd.wakeAttempts++;
    }
    this._setStatus(cmd, P.STATUS.SENDING);
    cmd.txAttempts++;
    this.lastCommandTxMs = this.clock.now;
    const tag = collarAwake ? "[AWAKE]" : "[speculative]";
    this.log(`[LoRa] TX msg_id=${cmd.msgId} ${tag} spec=${cmd.txAttempts - cmd.wakeAttempts} wake=${cmd.wakeAttempts} → UID ${cmd.targetId}`);
    this.channel.transmit(this.radio.id, cmd.obj);
    // The radio "transmit" always succeeds at our layer; the firmware's
    // radio-error branch (LBT) is rare and modelled as never failing here.
    if (collarAwake) this._setStatus(cmd, P.STATUS.AWAITING_ACK);
    else this._setStatus(cmd, P.STATUS.QUEUED); // speculative: bytes may have gone nowhere
  }

  // transmitCommandForDevice(reportingId): opportunistic send on wake.
  _deliverOnWake(reportingId) {
    if (!reportingId) return;
    for (const c of this.queue) {
      if (![P.STATUS.QUEUED, P.STATUS.AWAITING_ACK].includes(c.status)) continue;
      if (c.targetId === reportingId || c.targetId === P.BROADCAST_ID) {
        this.log(`[LoRa] WAKE UID ${reportingId}: delivering msg_id=${c.msgId} (wake#${c.wakeAttempts + 1})`);
        this._transmit(c, /*collarAwake=*/true);
        return; // one per wake, fair airtime (mirrors firmware)
      }
    }
  }

  // markCommandDelivered(uid, ackMsgId)
  _markDelivered(uid, ackMsgId) {
    if (ackMsgId) {
      for (const c of this.queue) {
        if (c.msgId === ackMsgId &&
            [P.STATUS.AWAITING_ACK, P.STATUS.SENDING, P.STATUS.QUEUED].includes(c.status)) {
          this._setStatus(c, P.STATUS.DELIVERED);
          return true;
        }
      }
    }
    // Fallback: oldest awaiting-ack for this UID.
    for (const c of this.queue) {
      if (c.targetId === uid && c.status === P.STATUS.AWAITING_ACK) {
        this._setStatus(c, P.STATUS.DELIVERED);
        return true;
      }
    }
    return false;
  }

  _updateNodeState(p) {
    const uid = p.device_id;
    if (typeof uid !== "number") return;
    const name = typeof p.name === "string" ? p.name : `Device-${uid}`;
    const st = this.nodeStates.get(uid) || {};
    st.name = name;
    st.lastSeen = this.clock.now;
    if (typeof p.mode === "string" && p.mode !== "unknown" && !p.ack) st.mode = p.mode;
    if (p.ack === "mode" && p.profile) st.mode = p.profile; // mode ACK is authoritative
    this.nodeStates.set(uid, st);
    for (const fn of this._nodeListeners) fn({ device_id: uid, name, mode: st.mode });
  }

  _onReceive(p) {
    if (P.isResponse(p)) {
      this._updateNodeState(p); // responses carry device_id + name
      if (p.pong === true) {
        this.log(`[PONG] UID ${p.device_id} (${p.name}) AWAKE rssi=${p.rssi} msg_id=${p.msg_id}`);
        this._markDelivered(p.device_id, p.msg_id || 0);
        return;
      }
      if (typeof p.ack === "string") {
        this.log(`[ACK] ${p.ack} from UID ${p.device_id} (${p.name}) msg_id=${p.msg_id}`);
        this._markDelivered(p.device_id, p.msg_id || 0);
        return;
      }
      // status-response (get_status): echoes req_msg_id
      if (typeof p.status === "string" && typeof p.mode === "string") {
        this.log(`[STATUS] from UID ${p.device_id}: mode=${p.mode} req_msg_id=${p.req_msg_id}`);
        this._markDelivered(p.device_id, p.req_msg_id || 0);
        return;
      }
      return;
    }
    // Telemetry
    if (typeof p.device_id === "number") {
      this._updateNodeState(p);
      this.log(`[RX] telemetry UID ${p.device_id} (${p.name}) status=${p.status} mode=${p.mode}`);
      this._deliverOnWake(p.device_id);
    }
  }

  _tick() {
    const now = this.clock.now;
    // Reap terminals + age-based backstop (reapTerminalCommands).
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const c = this.queue[i];
      const maxAge = c.ephemeral ? P.LIFECYCLE.COMMAND_PING_TIMEOUT_MS : P.LIFECYCLE.COMMAND_MAX_AGE_MS;
      const nonTerminal = [P.STATUS.QUEUED, P.STATUS.AWAITING_ACK, P.STATUS.SENDING].includes(c.status);
      if (nonTerminal && now - c.timestamp > maxAge) {
        this.log(`[CMD] ${c.msgId} unreachable >${maxAge}ms${c.ephemeral ? " (ping)" : ""} → FAILED (backstop)`);
        this._setStatus(c, P.STATUS.FAILED);
      }
      const age = now - c.statusChangedMs;
      let reap = false;
      if (c.status === P.STATUS.DELIVERED && age > P.LIFECYCLE.COMMAND_DELIVERED_LINGER_MS) reap = true;
      if (c.status === P.STATUS.FAILED && age > P.LIFECYCLE.COMMAND_FAILED_LINGER_MS) reap = true;
      if (c.status === P.STATUS.CANCELLED) reap = true;
      if (reap) this.queue.splice(i, 1);
    }
    // Safety-net speculative retry (processCommandQueue), rate-gated.
    if (now - this.lastCommandTxMs < P.LIFECYCLE.COMMAND_TX_INTERVAL) return;
    for (const c of this.queue) {
      if (c.status !== P.STATUS.QUEUED) continue;
      const speculativeSoFar = c.txAttempts - c.wakeAttempts;
      if (speculativeSoFar >= P.LIFECYCLE.COMMAND_SPECULATIVE_MAX) continue; // scheduled; await wake
      this._transmit(c, /*collarAwake=*/false);
      return;
    }
  }
}

// ── GUI state model. Consumes the base's command_status + node_state events
//    exactly like the web UI's WebSocket handlers (commandsByMsgId,
//    deviceNames, deviceHasPendingCommand). Lets scenarios assert the
//    user-visible state, not just the server queue.
class GuiModel {
  constructor(base) {
    this.commandsByMsgId = new Map();
    this.deviceNames = new Map();
    base.onCommandStatus((c) => this.commandsByMsgId.set(c.msg_id, c));
    base.onNodeState((n) => { if (n.name) this.deviceNames.set(n.device_id, n.name); });
  }
  pending(uid) {
    for (const c of this.commandsByMsgId.values()) {
      if (c.target_id !== uid) continue;
      if (["queued", "sending", "awaiting_ack"].includes(c.status)) return true;
    }
    return false;
  }
  statusOf(msgId) { const c = this.commandsByMsgId.get(msgId); return c && c.status; }
  // Plain-English ping result, matching renderCommandPanel().
  pingResult(msgId) {
    const c = this.commandsByMsgId.get(msgId);
    if (!c) return null;
    return ({ queued: "ping sent", sending: "ping sent", awaiting_ack: "pinging…",
      delivered: "collar awake", failed: "no response", cancelled: "cancelled" })[c.status] || c.status;
  }
}

module.exports = { Base, GuiModel };
