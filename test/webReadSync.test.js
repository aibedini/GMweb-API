"use strict";
// Read-state synchronisation.
//
// The reported defects: opening an unread thread did not clear the Web unread
// UI immediately, read confirmation was not trustworthy, and the manual action
// could do nothing observable. These tests pin the state model, the auto-read
// gate and the deduplication key.
import test from "node:test";
import assert from "node:assert/strict";
import {
  IDLE_READ, readStateKey, readSyncLabel, readSyncTone, readSyncRetryable,
  shouldAutoRead, readFailureCode,
} from "../web/src/lib/readSync.ts";

const GATE = {
  tabActive: true, hasSelection: true, threadReady: true, readyThreadIdMatches: true,
  documentVisible: true, canMarkRead: true, lastSequence: 10, confirmedSequence: 9,
  alreadyInFlight: false,
};

test("local read and phone-confirmed read are distinct states", () => {
  assert.equal(readSyncLabel(IDLE_READ), null);
  assert.equal(readSyncLabel({ state: "READ_LOCAL", sequence: 5 }), "Read locally");
  assert.equal(readSyncLabel({ state: "SYNCING", sequence: 5, commandId: null }), "Read · syncing to phone");
  assert.equal(readSyncLabel({ state: "WAITING_FOR_PHONE", sequence: 5, commandId: "c1" }), "Read · waiting for phone");
  assert.equal(readSyncLabel({ state: "CONFIRMED", sequence: 5 }), "Read");
  assert.equal(readSyncLabel({ state: "FAILED", sequence: 5, errorCode: "PHONE_OFFLINE", commandId: null }),
    "Read sync failed");
});

test("only a failure gets alarm styling and offers Retry", () => {
  assert.equal(readSyncTone(IDLE_READ), "none");
  assert.equal(readSyncTone({ state: "CONFIRMED", sequence: 1 }), "ok");
  assert.equal(readSyncTone({ state: "WAITING_FOR_PHONE", sequence: 1, commandId: "c" }), "muted");
  assert.equal(readSyncTone({ state: "SYNCING", sequence: 1, commandId: null }), "muted");
  assert.equal(readSyncTone({ state: "FAILED", sequence: 1, errorCode: "X", commandId: null }), "failed");

  assert.equal(readSyncRetryable({ state: "FAILED", sequence: 1, errorCode: "X", commandId: null }), true);
  for (const state of [
    IDLE_READ, { state: "READ_LOCAL", sequence: 1 }, { state: "SYNCING", sequence: 1, commandId: null },
    { state: "WAITING_FOR_PHONE", sequence: 1, commandId: "c" }, { state: "CONFIRMED", sequence: 1 },
  ]) {
    assert.equal(readSyncRetryable(state), false, `${state.state} must not offer Retry as an error affordance`);
  }
});

test("the dedupe key is per conversation AND per read-through sequence", () => {
  assert.equal(readStateKey("conv-a", 10), "conv-a:10");
  assert.notEqual(readStateKey("conv-a", 10), readStateKey("conv-a", 11));
  assert.notEqual(readStateKey("conv-a", 10), readStateKey("conv-b", 10));
});

test("auto-read requires every precondition", () => {
  assert.equal(shouldAutoRead(GATE), true, "unread + visible + ready thread auto-reads");
  for (const [field, value] of Object.entries({
    tabActive: false, hasSelection: false, threadReady: false, readyThreadIdMatches: false,
    documentVisible: false, canMarkRead: false, alreadyInFlight: true,
  })) {
    assert.equal(shouldAutoRead({ ...GATE, [field]: value }), false, `${field}=false must block auto-read`);
  }
  assert.equal(shouldAutoRead({ ...GATE, lastSequence: 9, confirmedSequence: 9 }), false,
    "an already-read thread must not issue another command");
  assert.equal(shouldAutoRead({ ...GATE, lastSequence: 9, confirmedSequence: 10 }), false,
    "a server-confirmed read-through ahead of the local one wins");
});

test("read failures map to stable machine codes, never raw strings for logic", () => {
  assert.equal(readFailureCode(new Error("phone offline")), "PHONE_OFFLINE");
  assert.equal(readFailureCode(new Error("device unreachable")), "PHONE_OFFLINE");
  assert.equal(readFailureCode(new Error("COMMAND_EXPIRED")), "READ_EXPIRED");
  assert.equal(readFailureCode(new Error("read_pending")), "READ_PHONE_PENDING");
  assert.equal(readFailureCode(new Error("weird")), "weird");
  assert.equal(readFailureCode(null), "READ_FAILED");
});

/**
 * Drives the same transitions the App effect performs, so the invariants that
 * matter (local-first, one command per key, terminal states) are provable.
 */
function makeReadDriver({ failWith = null, confirmAfter = 2, seedConfirmations = {} } = {}) {
  const commands = [];
  const inFlight = new Set();
  let readThrough = {};     // optimistic local
  let confirmations = { ...seedConfirmations };   // phone-confirmed
  let state = IDLE_READ;

  return {
    get state() { return state; },
    get readThrough() { return readThrough; },
    get confirmations() { return confirmations; },
    get commands() { return commands; },
    inFlight,
    /** One pass of the auto-read effect for a conversation. */
    async open(aggregateId, lastSequence, gateOverrides = {}) {
      const confirmedSequence = Math.max(confirmations[aggregateId] ?? -1, readThrough[aggregateId] ?? -1);
      const key = readStateKey(aggregateId, lastSequence);
      const auto = shouldAutoRead({
        ...GATE, lastSequence, confirmedSequence,
        alreadyInFlight: inFlight.has(key), ...gateOverrides,
      });
      if (!auto) {
        if (lastSequence <= confirmedSequence && !inFlight.has(key)) state = { state: "CONFIRMED", sequence: lastSequence };
        return "SKIPPED";
      }
      // Local-first, before any network work.
      readThrough = { ...readThrough, [aggregateId]: Math.max(readThrough[aggregateId] ?? -1, lastSequence) };
      inFlight.add(key);
      state = { state: "SYNCING", sequence: lastSequence, commandId: null };
      commands.push(key);
      await Promise.resolve();
      if (failWith) { state = { state: "FAILED", sequence: lastSequence, errorCode: readFailureCode(new Error(failWith)), commandId: "cmd" }; inFlight.delete(key); return "FAILED"; }
      commands.push(`${key}#poll`);
      if (confirmAfter === 0) { confirmations = { ...confirmations, [aggregateId]: lastSequence }; inFlight.delete(key); state = { state: "CONFIRMED", sequence: lastSequence }; return "CONFIRMED"; }
      state = { state: "WAITING_FOR_PHONE", sequence: lastSequence, commandId: "cmd" };
      confirmations = { ...confirmations, [aggregateId]: lastSequence };
      inFlight.delete(key);
      state = { state: "CONFIRMED", sequence: lastSequence };
      return "CONFIRMED";
    },
  };
}

test("opening an unread thread clears the local unread BEFORE the phone is involved", async () => {
  const driver = makeReadDriver({ confirmAfter: 1 });
  const promise = driver.open("conv-a", 10);
  // Synchronously after the call, the optimistic read-through is already set
  // even though the command has only been *issued*.
  assert.equal(driver.readThrough["conv-a"], 10, "local read-through set immediately");
  assert.equal(driver.state.state, "SYNCING");
  await promise;
  assert.equal(driver.state.state, "CONFIRMED");
  assert.equal(driver.confirmations["conv-a"], 10);
});

test("rapid open/close/switch creates one command per read-through, never a storm", async () => {
  const driver = makeReadDriver();
  const results = await Promise.all([
    driver.open("conv-a", 10), driver.open("conv-a", 10), driver.open("conv-a", 10),
    driver.open("conv-a", 10), driver.open("conv-a", 10),
  ]);
  const issued = driver.commands.filter(entry => !entry.endsWith("#poll"));
  assert.equal(issued.length, 1, "only one MARK_THREAD_READ for conv-a:10");
  assert.equal(results.filter(result => result === "SKIPPED").length, 4, "the rest observe the in-flight command");

  // Switching to another conversation with its own read-through is allowed.
  await driver.open("conv-b", 3);
  assert.equal(driver.commands.filter(entry => !entry.endsWith("#poll")).length, 2);

  // Returning to the already-confirmed thread must not re-issue.
  const before = driver.commands.length;
  assert.equal(await driver.open("conv-a", 10), "SKIPPED");
  assert.equal(driver.commands.length, before, "no new command for an already-confirmed read");
});

test("a failed read stays retryable and keeps the local read", async () => {
  const driver = makeReadDriver({ failWith: "phone offline" });
  assert.equal(await driver.open("conv-a", 10), "FAILED");
  assert.equal(driver.state.state, "FAILED");
  assert.equal(driver.state.errorCode, "PHONE_OFFLINE");
  assert.equal(readSyncRetryable(driver.state), true, "manual Retry becomes available");
  // The optimistic local read is NOT rolled back — the user did open the thread.
  assert.equal(driver.readThrough["conv-a"], 10);
  assert.equal(driver.inFlight.size, 0, "the key is released so Retry can run");
});

test("a server-confirmed read supersedes the optimistic one", async () => {
  const driver = makeReadDriver({ seedConfirmations: { "conv-a": 99 } });
  assert.equal(await driver.open("conv-a", 10), "SKIPPED");
  assert.equal(driver.state.state, "CONFIRMED");
  assert.equal(driver.commands.length, 0, "no command when the phone already confirmed a higher sequence");
});
