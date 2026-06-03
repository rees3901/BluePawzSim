# BluePawzSim

A **hardware-free sandbox** that simulates the BluePawz collar ↔ base-station
LoRa protocol and the full remote-command lifecycle. It lets you reproduce and
assert end-to-end behaviour — queuing, retries, acknowledgements, queued
delivery, ping presence-checks, rename/mode persistence, and GUI state — in
**milliseconds**, with no ESP32s, no radios, and no waiting for a collar to
wake up.

> The goal (per the brief) is to test the **shared protocol and command
> lifecycle**, not the embedded hardware stack. The radio, GPS, BLE, NVS and
> sleep/wake are all mocked; the **wire format and command-processing logic
> are faithful models of the firmware.**

## Run it

```bash
node run.js                 # run every scenario, print PASS/FAIL summary
node run.js --list          # list scenario names
node run.js <name>          # run one scenario with a full packet trace
node run.js <name> --quiet  # one scenario, no trace
```

`node run.js` exits non-zero if any scenario fails, so it drops straight into
CI. No dependencies — pure Node ≥ 14.

A verbose run reads like a wire capture annotated with each side's reasoning:

```
        0ms  TX   [collar:430] {"msg_id":1,"device_id":430,"name":"Podge",...}
      701ms  RX   [base      ] {"msg_id":1,...}
      701ms  [RX] telemetry UID 430 (Podge) status=roaming mode=normal
    60000ms  [CMD] queued msg_id=1 mode→active → UID 430
    60000ms  [LoRa] TX msg_id=1 [speculative] spec=1 wake=0 → UID 430   ← collar asleep, goes nowhere
   320701ms  [LoRa] WAKE UID 430: delivering msg_id=1 (wake#1)          ← collar reported in
   320701ms  [LoRa] TX msg_id=1 [AWAKE] spec=2 wake=1 → UID 430
   321402ms  RX   [collar:430] {"cmd":"mode",...}                        ← collar receives it
   321422ms  TX   [collar:430] {"ack":"mode",...}                        ← collar ACKs
   322123ms  [ACK] mode from UID 430 → [CMD] 1 awaiting_ack → delivered  ← base closes the loop
```

## What it models

| Piece | File | Mirrors (firmware) |
|---|---|---|
| Virtual clock + scheduler | `lib/sim.js` `Clock` | `millis()` / `loop()` timing |
| Mock LoRa medium (loss, airtime, half-duplex) | `lib/sim.js` `Channel` | the RadioLib radio layer |
| Shared constants + wire format | `lib/protocol.js` | `config.h` + the JSON messages in both `main.cpp`s |
| Collar (sleep/wake, RX window, command handling, NVS) | `lib/collar.js` | `BluePawzTransmitter/src/main.cpp` |
| Base (command queue + lifecycle) | `lib/base.js` `Base` | `BluePawzReceiver/src/main.cpp` (v3.6.4) |
| GUI state (commandsByMsgId, deviceNames, pending) | `lib/base.js` `GuiModel` | the web UI's WebSocket handlers |
| Scenarios + assertions | `scenarios.js` | — |

The base reproduces the **exact** v3.6.4 lifecycle: a durable command gets up
to `COMMAND_SPECULATIVE_MAX` (2) speculative sends while the collar may be
asleep (these stay **QUEUED**, never count toward failure), then it's
**scheduled** until the target collar's telemetry proves it's awake, then sent
for real into the collar's RX window (**AWAITING_ACK**, counted toward
`COMMAND_MAX_WAKE_ATTEMPTS`), and marked **DELIVERED** on the ACK/pong — or
**FAILED** only on the wake-cap or the 30-min age backstop. A presence-check
**ping** is *ephemeral*: an 8-second window, then "no response".

## Scenarios (all the brief's edge cases)

| Scenario | Proves |
|---|---|
| `collar-awake-immediate-deliver` | command lands at once if the collar is in its RX window |
| `collar-asleep-queue-then-wake-deliver` | sent-while-asleep → QUEUED/scheduled → wake → delivered → ACK |
| `rename-persists-and-reflected-later` | set_name applied to NVS, reflected on the base + GUI **and** in later telemetry |
| `mode-change-persists` | mode applied on the collar and known to the base |
| `ping-awake-says-collar-awake` | presence check → "collar awake" |
| `ping-asleep-says-no-response` | presence check fails fast (≤ 8 s), not a 30-min queue |
| `uid-targeting-only-correct-collar` | a command for UID 430 never touches UID 742 |
| `broken-ack-fails-after-wake-cap` | a collar that never ACKs → FAILED at the wake cap |
| `dead-collar-age-backstop` | a never-waking collar → FAILED by the 30-min backstop |
| `cancel-before-delivery` | a queued command can be cancelled before it's delivered |
| `packet-loss-redelivers-next-wake` | lossy link → redelivered across wakes → eventually delivered |

## Findings (bugs/limitations the sim surfaced)

- **Lost-ACK ambiguity.** If the *command* reaches the collar (which applies
  it) but the *ACK* is lost, the base can't distinguish that from "never
  received" — it keeps retrying. For idempotent commands (rename, mode) the
  retries simply re-apply the same value, so it's harmless; the base may still
  show `awaiting_ack`/`failed` while the collar is, in fact, already updated.
  A future "the collar already has this value, here's a fresh ACK" path could
  close that gap. The sim demonstrates this at high loss rates.

## ⚠ Keeping it honest (drift)

This is a **model**, not the literal firmware compiled natively. Its value
depends on staying in sync with the real code. If you change any of these in
the firmware, mirror them here:

- a wire field or message shape → `lib/protocol.js` builders
- a lifecycle constant (`COMMAND_*`, `POST_TX_*`) → `lib/protocol.js` `LIFECYCLE`/`RXWINDOW`
- the queue/retry/ACK logic → `lib/base.js`
- the collar's command handling → `lib/collar.js`

Each module names the firmware function/`#define` it tracks. Treat a sim change
as part of "done" whenever you touch the protocol or command lifecycle.
