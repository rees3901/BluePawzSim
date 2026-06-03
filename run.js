#!/usr/bin/env node
"use strict";
// ─────────────────────────────────────────────────────────────────────────
// BluePawzSim runner.
//
//   node run.js                  → run every scenario, print PASS/FAIL summary
//   node run.js <name>           → run one scenario by (sub)name, verbose trace
//   node run.js <name> --quiet   → run one scenario without the packet trace
//   node run.js --list           → list scenario names
//
// Exit code is non-zero if any scenario fails (CI-friendly).
// ─────────────────────────────────────────────────────────────────────────

const { SCENARIOS, runChecks } = require("./scenarios");

const args = process.argv.slice(2);
const wantList = args.includes("--list");
const quiet = args.includes("--quiet");
const nameArg = args.find((a) => !a.startsWith("--"));

if (wantList) {
  console.log("Scenarios:");
  for (const s of SCENARIOS) console.log("  - " + s.name);
  process.exit(0);
}

function runOne(s, verbose) {
  if (verbose) {
    console.log("\n══════════════════════════════════════════════════════════════");
    console.log("▶ " + s.name + "   (verbose packet trace)");
    console.log("══════════════════════════════════════════════════════════════");
  }
  let checks;
  try {
    checks = runChecks(s.fn, verbose);
  } catch (e) {
    return { name: s.name, pass: false, checks: [{ desc: "threw: " + e.message + "\n" + e.stack, ok: false }] };
  }
  const pass = checks.every((c) => c.ok);
  return { name: s.name, pass, checks };
}

function printResult(r, showChecks) {
  console.log(`${r.pass ? "✅ PASS" : "❌ FAIL"}  ${r.name}`);
  if (showChecks || !r.pass) {
    for (const c of r.checks) console.log(`        ${c.ok ? "·" : "✗"} ${c.desc}`);
  }
}

if (nameArg) {
  const matches = SCENARIOS.filter((s) => s.name.includes(nameArg));
  if (matches.length === 0) {
    console.error(`No scenario matches "${nameArg}". Use --list.`);
    process.exit(2);
  }
  let allPass = true;
  for (const s of matches) {
    const r = runOne(s, !quiet);
    console.log("");
    printResult(r, true);
    allPass = allPass && r.pass;
  }
  process.exit(allPass ? 0 : 1);
}

// Run the whole suite.
console.log("BluePawzSim — protocol & command-lifecycle simulation\n");
let pass = 0, fail = 0;
for (const s of SCENARIOS) {
  const r = runOne(s, false);
  printResult(r, false);
  if (r.pass) pass++; else fail++;
}
console.log(`\n${pass}/${pass + fail} scenarios passed.`);
process.exit(fail ? 1 : 0);
