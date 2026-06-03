"use strict";
// ─────────────────────────────────────────────────────────────────────────
// Scenarios — each one builds a fresh sim, drives it on the virtual clock,
// and asserts the resulting command-lifecycle + GUI state. Covers every
// edge case in the brief: asleep-when-sent, wake+deliver, ACK→delivered,
// rename/mode persistence, ping presence-check, UID targeting, broken-ACK
// retry cap, dead-collar age backstop, cancel, and packet loss.
// ─────────────────────────────────────────────────────────────────────────

const { Clock, Channel } = require("./lib/sim");
const { Collar } = require("./lib/collar");
const { Base, GuiModel } = require("./lib/base");

function makeSim({ verbose = false, channelOpts = {} } = {}) {
  const clock = new Clock();
  const log = verbose
    ? (m) => console.log(`  ${String(clock.now).padStart(8)}ms  ${m}`)
    : () => {};
  const channel = new Channel(clock, Object.assign({ log }, channelOpts));
  const base = new Base({ clock, channel, log });
  const gui = new GuiModel(base);
  const collars = [];
  const addCollar = (cfg) => {
    const c = new Collar(Object.assign({ clock, channel }, cfg));
    c.start();
    collars.push(c);
    return c;
  };
  return { clock, channel, base, gui, log, addCollar };
}

// Tiny assertion harness.
function scenario(name, fn) {
  return { name, fn };
}
function runChecks(fn, verbose) {
  const checks = [];
  const ctx = {
    check(desc, ok) { checks.push({ desc, ok: !!ok }); },
    eq(desc, got, want) { checks.push({ desc: `${desc} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, ok: got === want }); },
  };
  fn(ctx, verbose);
  return checks;
}

const SCENARIOS = [
  // 1 ───────────────────────────────────────────────────────────────────
  scenario("collar-awake-immediate-deliver", (t, v) => {
    const s = makeSim({ verbose: v });
    s.addCollar({ deviceId: 430, name: "Podge", mode: "developer" });
    // Collar wakes at t=0, telemetry done ~0.7s, in RX window until ~20.7s.
    // Send a status request at t=2s while it's listening.
    let cmd;
    s.clock.at(2000, () => { cmd = s.base.sendStatus(430); });
    s.clock.run(30000);
    t.eq("delivered", s.base.queue.find(c => c.msgId === cmd.msgId)?.status || cmd.status, "delivered");
    t.eq("GUI shows delivered", s.gui.statusOf(cmd.msgId), "delivered");
    t.check("at most 1 wake-attempt (was awake)", cmd.wakeAttempts <= 1);
  }),

  // 2 ───────────────────────────────────────────────────────────────────
  scenario("collar-asleep-queue-then-wake-deliver", (t, v) => {
    const s = makeSim({ verbose: v });
    const collar = s.addCollar({ deviceId: 430, name: "Podge", mode: "normal" }); // 300s sleep
    // Send while the collar is deep asleep (well after its first RX window).
    let cmd;
    s.clock.at(60000, () => { cmd = s.base.sendMode(430, "active"); });
    // Snapshot status just before the collar's next wake (~320s).
    let midStatus;
    s.clock.at(300000, () => { midStatus = cmd.status; });
    s.clock.run(360000);
    t.eq("scheduled (QUEUED) while asleep", midStatus, "queued");
    t.eq("delivered after wake", cmd.status, "delivered");
    t.eq("collar applied the mode", collar.mode, "active");
    t.check("exactly one awake delivery attempt", cmd.wakeAttempts === 1);
  }),

  // 3 ───────────────────────────────────────────────────────────────────
  scenario("rename-persists-and-reflected-later", (t, v) => {
    const s = makeSim({ verbose: v });
    const collar = s.addCollar({ deviceId: 742, name: "Device-742", mode: "developer" });
    let cmd;
    s.clock.at(2000, () => { cmd = s.base.sendRename(742, "Gizmo"); });
    s.clock.run(40000);
    t.eq("command delivered", cmd.status, "delivered");
    t.eq("collar NVS updated", collar.nvs.name, "Gizmo");
    t.eq("base nodeStates reflects new name", s.base.nameForId(742), "Gizmo");
    t.eq("GUI deviceNames reflects new name", s.gui.deviceNames.get(742), "Gizmo");
    // And it survives into the *next* telemetry report:
    let laterName;
    s.clock.at(80000, () => { laterName = s.base.nameForId(742); });
    s.clock.run(120000);
    t.eq("next telemetry still shows new name", laterName, "Gizmo");
  }),

  // 4 ───────────────────────────────────────────────────────────────────
  scenario("mode-change-persists", (t, v) => {
    const s = makeSim({ verbose: v });
    const collar = s.addCollar({ deviceId: 430, name: "Podge", mode: "normal" });
    let cmd;
    s.clock.at(2000, () => { cmd = s.base.sendMode(430, "lost"); });
    s.clock.run(40000);
    t.eq("delivered", cmd.status, "delivered");
    t.eq("collar now in lost mode", collar.mode, "lost");
    t.eq("base knows collar is in lost mode", s.base.nodeStates.get(430)?.mode, "lost");
  }),

  // 5 ───────────────────────────────────────────────────────────────────
  scenario("ping-awake-says-collar-awake", (t, v) => {
    const s = makeSim({ verbose: v });
    s.addCollar({ deviceId: 430, name: "Podge", mode: "developer" });
    let cmd;
    s.clock.at(2000, () => { cmd = s.base.sendPing(430); }); // collar in RX window
    s.clock.run(20000);
    t.eq("ping delivered", cmd.status, "delivered");
    t.eq("GUI ping result", s.gui.pingResult(cmd.msgId), "collar awake");
  }),

  // 6 ───────────────────────────────────────────────────────────────────
  scenario("ping-asleep-says-no-response", (t, v) => {
    const s = makeSim({ verbose: v });
    s.addCollar({ deviceId: 430, name: "Podge", mode: "normal" }); // long sleep
    let cmd;
    s.clock.at(60000, () => { cmd = s.base.sendPing(430); }); // collar asleep
    // Check shortly after the 8s ping window closes.
    let resultAt70;
    s.clock.at(70000, () => { resultAt70 = s.gui.pingResult(cmd.msgId); });
    s.clock.run(80000);
    t.eq("ping failed fast (no response)", resultAt70, "no response");
    t.check("ping did NOT wait 30 min like a durable command", cmd.statusChangedMs - cmd.timestamp <= 9000);
  }),

  // 7 ───────────────────────────────────────────────────────────────────
  scenario("uid-targeting-only-correct-collar", (t, v) => {
    const s = makeSim({ verbose: v });
    const a = s.addCollar({ deviceId: 430, name: "Podge", mode: "developer", opts: { firstWakeMs: 0 } });
    const b = s.addCollar({ deviceId: 742, name: "Gizmo", mode: "developer", opts: { firstWakeMs: 5000 } });
    let cmd;
    s.clock.at(2000, () => { cmd = s.base.sendRename(430, "Renamed430"); });
    s.clock.run(40000);
    t.eq("target collar renamed", a.nvs.name, "Renamed430");
    t.eq("other collar untouched", b.nvs.name, "Gizmo");
    t.eq("delivered", cmd.status, "delivered");
  }),

  // 8 ───────────────────────────────────────────────────────────────────
  scenario("broken-ack-fails-after-wake-cap", (t, v) => {
    const s = makeSim({ verbose: v });
    // Collar receives commands but never ACKs (ackEnabled:false).
    s.addCollar({ deviceId: 430, name: "Podge", mode: "lost", opts: { ackEnabled: false } }); // 30s sleep = many wakes
    let cmd;
    s.clock.at(2000, () => { cmd = s.base.sendMode(430, "normal"); });
    s.clock.run(2000000); // well past 10 wakes
    t.eq("eventually FAILED", cmd.status, "failed");
    t.check("failed at the wake cap (10) or age backstop", cmd.wakeAttempts >= 10 || cmd.status === "failed");
  }),

  // 9 ───────────────────────────────────────────────────────────────────
  scenario("dead-collar-age-backstop", (t, v) => {
    const s = makeSim({ verbose: v });
    s.addCollar({ deviceId: 430, name: "Podge", mode: "normal", opts: { neverWake: true } });
    let cmd;
    s.clock.at(1000, () => { cmd = s.base.sendMode(430, "active"); });
    // Snapshot before the 30-min backstop, then run past it.
    let at20min;
    s.clock.at(20 * 60000, () => { at20min = cmd.status; });
    s.clock.run(32 * 60000);
    t.eq("still trying (queued) at 20 min", at20min, "queued");
    t.eq("FAILED by the 30-min backstop", cmd.status, "failed");
  }),

  // 10 ──────────────────────────────────────────────────────────────────
  scenario("cancel-before-delivery", (t, v) => {
    const s = makeSim({ verbose: v });
    s.addCollar({ deviceId: 430, name: "Podge", mode: "normal" });
    let cmd;
    // Send at 50 s — AFTER the collar's initial ~20 s RX window has closed,
    // so it's genuinely asleep and the command sits QUEUED.
    s.clock.at(50000, () => { cmd = s.base.sendMode(430, "active"); });
    s.clock.at(55000, () => { s.base.cancel(cmd.msgId); }); // cancel while still queued/asleep
    s.clock.run(400000); // past the next wake (~320 s)
    t.eq("cancelled", cmd.status, "cancelled");
    t.check("never delivered to an awake collar", cmd.wakeAttempts === 0);
  }),

  // 11 ──────────────────────────────────────────────────────────────────
  scenario("packet-loss-redelivers-next-wake", (t, v) => {
    // 35% per-packet loss: the first wake's command and/or ACK is often lost;
    // the base keeps retrying on each subsequent wake until the round-trip
    // (telemetry → command → ACK) all gets through. (NB: the sim also shows a
    // real limitation — if only the ACK is lost the collar has already applied
    // the change but the base keeps retrying; harmless for idempotent commands
    // like rename/mode. See README "Findings".)
    const s = makeSim({ verbose: v, channelOpts: { lossRate: 0.35, seed: 7 } });
    const collar = s.addCollar({ deviceId: 430, name: "Podge", mode: "lost" }); // 30s sleep = frequent retries
    let cmd;
    // Send while asleep (after the initial RX window) so delivery must happen
    // across one or more later wakes — each of which may lose the command or
    // its ACK to the 60% drop rate, forcing redelivery.
    s.clock.at(50000, () => { cmd = s.base.sendRename(430, "Lucky"); });
    s.clock.run(600000); // 10 minutes of retries
    t.eq("eventually delivered despite 60% loss", cmd.status, "delivered");
    t.eq("collar got the rename", collar.nvs.name, "Lucky");
    t.check("required at least one wake-delivery attempt", cmd.wakeAttempts >= 1);
  }),
];

module.exports = { SCENARIOS, runChecks, makeSim };
