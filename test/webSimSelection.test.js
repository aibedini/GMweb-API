"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("saved active SIM wins, otherwise default then first; stale and inactive are rejected", async () => {
  const { selectSmsSim } = await import("../web/src/lib/simSelection.ts");
  const sims = [
    { subscriptionId: 10, isActive: true, isDefaultSms: true },
    { subscriptionId: 20, isActive: true, isDefaultSms: false },
    { subscriptionId: 30, isActive: false, isDefaultSms: false }
  ];
  assert.equal(selectSmsSim(sims, 20)?.subscriptionId, 20);
  assert.equal(selectSmsSim(sims, null)?.subscriptionId, 10);
  assert.equal(selectSmsSim(sims, 999), undefined);
  assert.equal(selectSmsSim(sims, 30), undefined);
  assert.equal(selectSmsSim([sims[1]], null)?.subscriptionId, 20);
  assert.equal(selectSmsSim([], null), undefined);
});
