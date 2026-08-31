"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const Database = require("better-sqlite3");
const { TrustRegistry } = require("../src/trustRegistry");

function stmt(n, op, extra = {}) {
  return {
    trustSequence: n,
    statementId: `st_${n}`,
    operation: op,
    deviceId: "dev_web_1",
    issuedAt: Date.now(),
    ...extra,
    rootSignature: `sig_${n}`,
  };
}

describe("TrustRegistry relay", () => {
  test("applies statements strictly in sequence order with no gaps", () => {
    const reg = new TrustRegistry(new Database(":memory:"));
    let r = reg.applyStatement({ accountId: "acc1", statement: stmt(1, "DEVICE_APPROVED") });
    assert.equal(r.applied, true);
    assert.equal(r.trustSequence, 1);

    // gap: 3 without 2
    r = reg.applyStatement({ accountId: "acc1", statement: stmt(3, "DEVICE_APPROVED") });
    assert.equal(r.applied, false);
    assert.equal(r.reason, "sequence_gap");

    // stale: 1 again
    r = reg.applyStatement({ accountId: "acc1", statement: stmt(1, "DEVICE_REVOKED") });
    assert.equal(r.applied, false);
    assert.equal(r.reason, "stale_sequence");

    // correct continuation
    r = reg.applyStatement({ accountId: "acc1", statement: stmt(2, "DEVICE_REVOKED") });
    assert.equal(r.applied, true);
  });

  test("redelivery of the same sequence is an idempotent no-op", () => {
    const reg = new TrustRegistry(new Database(":memory:"));
    reg.applyStatement({ accountId: "acc1", statement: stmt(1, "DEVICE_APPROVED") });
    const r = reg.applyStatement({ accountId: "acc1", statement: stmt(1, "DEVICE_APPROVED") });
    assert.equal(r.applied, false);
    assert.equal(r.reason, "stale_sequence");
    assert.equal(reg.statementsAfter("acc1", 0).length, 1);
  });

  test("accounts are isolated — sequences are per-account", () => {
    const reg = new TrustRegistry(new Database(":memory:"));
    assert.equal(reg.applyStatement({ accountId: "a", statement: stmt(1, "DEVICE_APPROVED") }).applied, true);
    assert.equal(reg.applyStatement({ accountId: "b", statement: stmt(1, "DEVICE_APPROVED") }).applied, true);
    assert.equal(reg.applyStatement({ accountId: "a", statement: stmt(2, "DEVICE_REVOKED") }).applied, true);
    assert.equal(reg.applyStatement({ accountId: "b", statement: stmt(2, "DEVICE_KEY_ROTATED") }).applied, true);
    assert.equal(reg.statementsAfter("a", 0).length, 2);
    assert.equal(reg.statementsAfter("b", 0).length, 2);
  });

  test("snapshot stores and serves the latest Android-signed state", () => {
    const reg = new TrustRegistry(new Database(":memory:"));
    assert.equal(reg.getSnapshot("acc1"), null);
    reg.putSnapshot({
      accountId: "acc1",
      trustSequence: 4,
      rootPublicKey: "ROOTPUB",
      snapshot: { devices: [{ id: "android1", capabilities: ["*"] }] },
    });
    const snap = reg.getSnapshot("acc1");
    assert.equal(snap.trustSequence, 4);
    assert.equal(snap.rootPublicKey, "ROOTPUB");
    assert.equal(snap.snapshot.devices[0].id, "android1");
    // update overwrites
    reg.putSnapshot({ accountId: "acc1", trustSequence: 5, rootPublicKey: "ROOTPUB", snapshot: { devices: [] } });
    assert.equal(reg.getSnapshot("acc1").trustSequence, 5);
  });

  test("cursor pagination returns only statements after the cursor", () => {
    const reg = new TrustRegistry(new Database(":memory:"));
    for (let i = 1; i <= 5; i++) {
      reg.applyStatement({ accountId: "acc", statement: stmt(i, "DEVICE_APPROVED") });
    }
    const after3 = reg.statementsAfter("acc", 3);
    assert.deepEqual(after3.map((s) => s.trustSequence), [4, 5]);
  });
});
