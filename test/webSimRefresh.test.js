"use strict";
// §20: "Refresh SIMs" must never fake success.
//
// GMweb can only re-read the last telemetry the phone published, so the only
// honest outcomes are "a newer report arrived" or "no newer report arrived".
import test from "node:test";
import assert from "node:assert/strict";
import { classifySimRefresh, simRefreshMessage } from "../web/src/lib/simTelemetry.ts";

const NOW = 1_700_000_000_000;

test("a genuinely newer phone report is the only success", () => {
  assert.equal(classifySimRefresh({
    previousReceivedAt: NOW - 60_000, nextReceivedAt: NOW, presence: "ONLINE",
  }), "UPDATED");
  assert.equal(classifySimRefresh({
    previousReceivedAt: null, nextReceivedAt: NOW, presence: "ONLINE",
  }), "UPDATED", "the first ever report counts as new");
});

test("an unchanged report is never reported as success", () => {
  assert.equal(classifySimRefresh({
    previousReceivedAt: NOW, nextReceivedAt: NOW, presence: "ONLINE",
  }), "NO_NEW");
  assert.equal(classifySimRefresh({
    previousReceivedAt: NOW, nextReceivedAt: null, presence: "ONLINE",
  }), "NO_NEW", "a missing report is not an update");
  // Same report while the phone itself looks stale gets its own state.
  assert.equal(classifySimRefresh({
    previousReceivedAt: NOW, nextReceivedAt: NOW, presence: "STALE",
  }), "STALE");
});

test("an unreachable phone blocks refresh instead of pretending", () => {
  for (const presence of ["OFFLINE", "NEVER_SEEN"]) {
    assert.equal(classifySimRefresh({
      previousReceivedAt: NOW, nextReceivedAt: NOW, presence,
    }), "PHONE_OFFLINE");
    assert.equal(classifySimRefresh({
      previousReceivedAt: NOW, nextReceivedAt: NOW + 5_000, presence,
    }), "PHONE_OFFLINE", "even a newer timestamp cannot be refreshed from an unreachable phone");
  }
});

test("refresh copy is honest for every outcome", () => {
  assert.equal(simRefreshMessage("IDLE").message, null);
  assert.match(simRefreshMessage("CHECKING").message, /Checking/);
  assert.match(simRefreshMessage("UPDATED").message, /updated/);
  assert.match(simRefreshMessage("NO_NEW").message, /No newer SIM report/);
  assert.match(simRefreshMessage("PHONE_OFFLINE").message, /offline/);
  assert.match(simRefreshMessage("STALE").message, /stale/i);

  // The word "updated" must never appear for a non-update outcome.
  for (const outcome of ["NO_NEW", "PHONE_OFFLINE", "STALE", "FAILED"]) {
    const message = simRefreshMessage(outcome).message ?? "";
    assert.doesNotMatch(message, /\bupdated\b/i, `${outcome} must not claim an update`);
  }
  // Every outcome carries its own distinct copy.
  const copies = ["CHECKING", "UPDATED", "NO_NEW", "PHONE_OFFLINE", "STALE", "FAILED"]
    .map(outcome => simRefreshMessage(outcome).message);
  assert.equal(new Set(copies).size, copies.length, "no two outcomes share copy");
});
