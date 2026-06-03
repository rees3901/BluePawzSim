"use strict";
// ─────────────────────────────────────────────────────────────────────────
// Simulation engine: a virtual Clock + a mocked LoRa Channel.
//
// Clock   — discrete-event scheduler. "Time" is simulated milliseconds, so a
//           30-minute firmware timeout test completes in microseconds of real
//           time. Mirrors the role of millis() in the firmware.
//
// Channel — the mock for the RadioLib radio layer. A shared half-duplex
//           medium. transmit() occupies the sender for an airtime, then
//           delivers the packet (after propagation) to every OTHER radio that
//           is LISTENING at that moment — which is exactly why a sleeping
//           collar (radio off) misses a command, and why the base must be
//           back in RX before the collar's ACK lands. Supports packet loss.
// ─────────────────────────────────────────────────────────────────────────

// Deterministic PRNG so scenarios reproduce exactly (seeded packet loss).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Clock {
  constructor() {
    this.now = 0;
    this._q = [];
    this._seq = 0;
  }
  // Schedule fn() to run at now + delayMs. Returns a token you can cancel().
  at(delayMs, fn, label) {
    const ev = { t: this.now + Math.max(0, delayMs | 0), seq: this._seq++, fn, label, cancelled: false };
    this._q.push(ev);
    return ev;
  }
  cancel(token) { if (token) token.cancelled = true; }

  // A self-rescheduling periodic timer (models the firmware loop()/tick).
  every(intervalMs, fn, label) {
    const tick = () => {
      if (token.cancelled) return;
      fn();
      token = this.at(intervalMs, tick, label);
      // keep the outer reference's cancelled flag authoritative
    };
    let token = this.at(intervalMs, tick, label);
    const handle = { cancel: () => { token.cancelled = true; } };
    return handle;
  }

  // Advance time, firing events in chronological order, until the queue is
  // empty or we reach untilMs.
  run(untilMs = Infinity) {
    for (;;) {
      // earliest live event
      let idx = -1;
      for (let i = 0; i < this._q.length; i++) {
        const e = this._q[i];
        if (e.cancelled) continue;
        if (idx === -1 || e.t < this._q[idx].t || (e.t === this._q[idx].t && e.seq < this._q[idx].seq)) idx = i;
      }
      if (idx === -1) break;
      const ev = this._q[idx];
      if (ev.t > untilMs) break;
      this._q.splice(idx, 1);
      this.now = ev.t;
      ev.fn();
      // opportunistic compaction of cancelled events
      if (this._q.length > 256) this._q = this._q.filter((e) => !e.cancelled);
    }
    if (untilMs !== Infinity && this.now < untilMs) this.now = untilMs;
  }
}

class Channel {
  // opts: { airtimeMs, lossRate, seed, log }
  constructor(clock, opts = {}) {
    this.clock = clock;
    this.airtimeMs = opts.airtimeMs != null ? opts.airtimeMs : 700; // ~SF9/BW125, 100-ish B
    this.propagationMs = opts.propagationMs != null ? opts.propagationMs : 1;
    this.lossRate = opts.lossRate != null ? opts.lossRate : 0;
    this.radios = [];
    this.rng = mulberry32(opts.seed != null ? opts.seed : 1);
    this.log = opts.log || (() => {});
    this.stats = { tx: 0, delivered: 0, lost: 0, missedAsleep: 0 };
  }

  // A radio is { id, isListening():bool, onReceive(obj), txBusyUntil }
  register(radio) {
    radio.txBusyUntil = 0;
    this.radios.push(radio);
    return radio;
  }

  // Transmit a JS object as a "packet" from senderId.
  transmit(senderId, obj) {
    const pkt = JSON.stringify(obj);
    const sender = this.radios.find((r) => r.id === senderId);
    if (sender) sender.txBusyUntil = this.clock.now + this.airtimeMs; // half-duplex: can't RX while TX
    this.stats.tx++;
    this.log(`TX   ${pad(senderId)} (${pkt.length}B)  ${pkt}`);

    // Deliver at end-of-airtime + propagation, to whoever is listening THEN.
    this.clock.at(this.airtimeMs + this.propagationMs, () => {
      for (const r of this.radios) {
        if (r.id === senderId) continue;
        const listening = r.isListening() && this.clock.now >= r.txBusyUntil;
        if (!listening) { this.stats.missedAsleep++; continue; }
        if (this.rng() < this.lossRate) {
          this.stats.lost++;
          this.log(`LOSS ${pad(r.id)}  (dropped in flight)  ${pkt}`);
          continue;
        }
        this.stats.delivered++;
        this.log(`RX   ${pad(r.id)}            ${pkt}`);
        try { r.onReceive(JSON.parse(pkt)); } catch (e) { this.log(`!! onReceive error on ${r.id}: ${e.message}`); }
      }
    });
  }
}

function pad(id) { return `[${String(id).padEnd(10)}]`; }

module.exports = { Clock, Channel, mulberry32 };
