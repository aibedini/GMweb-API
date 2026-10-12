"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// A SIM fixture. `displayName`/`carrierName`/`slotIndex` are required by the SmsSim shape so the shared
// label helper can be generic over anything carrying a SIM identity.
const sim = (extra) => ({
  slotIndex: 0, displayName: "Line", carrierName: "Carrier", isActive: true, isDefaultSms: false, ...extra
});

test("saved active SIM wins, otherwise default then first; stale and inactive are rejected", async () => {
  const { selectSmsSim, simKey } = await import("../web/src/lib/simSelection.ts");
  const sims = [
    sim({ subscriptionId: 10, isDefaultSms: true }),
    sim({ subscriptionId: 20 }),
    sim({ subscriptionId: 30, isActive: false })
  ];
  assert.equal(selectSmsSim(sims, simKey(sims[1]))?.subscriptionId, 20);
  assert.equal(selectSmsSim(sims, null)?.subscriptionId, 10);
  assert.equal(selectSmsSim(sims, "sub:999"), undefined);
  assert.equal(selectSmsSim(sims, simKey(sims[2])), undefined);
  assert.equal(selectSmsSim([sims[1]], null)?.subscriptionId, 20);
  assert.equal(selectSmsSim([], null), undefined);
});

test("the selection key is the opaque simRef, never the subscription id", async () => {
  const { simKey } = await import("../web/src/lib/simSelection.ts");
  // Android mints `sim:v1:<32 hex>`. The key must be built from it, because a subscription id is
  // reassigned when SIMs move and current Android builds do not publish one at all.
  const ref = "sim:v1:0123456789abcdef0123456789abcdef";
  assert.equal(simKey(sim({ simRef: ref, subscriptionId: 7 })), `ref:${ref}`);
  // The namespace matters: an unnamespaced "7" could be mistaken for a simRef.
  assert.notEqual(simKey(sim({ simRef: ref, subscriptionId: 7 })), "7");
});

test("a SIM with no usable identity is not selectable and never matches", async () => {
  const { simKey, isSelectableSim, selectSmsSim } = await import("../web/src/lib/simSelection.ts");
  const anonymous = sim({});
  assert.equal(simKey(anonymous), null);
  assert.equal(isSelectableSim(anonymous), false);
  // A saved key must not match an identity-less SIM by accident.
  assert.equal(selectSmsSim([anonymous], "sub:1"), undefined);
});

test("legacy subscription ids still select, but under a namespaced key", async () => {
  const { simKey, simSelectChoice } = await import("../web/src/lib/simSelection.ts");
  assert.equal(simKey(sim({ subscriptionId: 5 })), "sub:5");
  assert.deepEqual(simSelectChoice("sub:5"), { subscriptionId: 5 });
});

test("simSelectChoice maps a ref key to simRef, and a bare legacy id to subscriptionId", async () => {
  const { simSelectChoice, DEFAULT_SIM_KEY } = await import("../web/src/lib/simSelection.ts");
  const ref = "sim:v1:0123456789abcdef0123456789abcdef";
  assert.deepEqual(simSelectChoice(`ref:${ref}`), { simRef: ref });
  // "Phone default" is the ABSENCE of a target, which is what makes Android resolve its own default.
  assert.equal(simSelectChoice(DEFAULT_SIM_KEY), null);
  assert.equal(simSelectChoice(null), null);
  assert.equal(simSelectChoice(undefined), null);
  // A bare value from a caller that still passes a raw id keeps working.
  assert.deepEqual(simSelectChoice(9), { subscriptionId: 9 });
  assert.equal(simSelectChoice("ref:"), null);
});

test("simLabelForRef matches by ref and returns null for a line that is not installed", async () => {
  const { simLabelForRef } = await import("../web/src/lib/simSelection.ts");
  const ref = "sim:v1:0123456789abcdef0123456789abcdef";
  const sims = [
    sim({ simRef: ref, slotIndex: 1, carrierName: "IR-MCI" }),
    sim({ simRef: "sim:v1:ffffffffffffffffffffffffffffffff", slotIndex: 0 })
  ];
  assert.equal(simLabelForRef(sims, ref), "SIM 2 · IR-MCI");
  // A preference can outlive the card. Returning null lets the caller say "not currently active" rather
  // than presenting a real, still-set preference as unset.
  assert.equal(simLabelForRef(sims, "sim:v1:00000000000000000000000000000000"), null);
  assert.equal(simLabelForRef(sims, undefined), null);
});

test("simSelectValue shows Phone default only while a default is actually reported", async () => {
  const { simSelectValue, DEFAULT_SIM_KEY, simKey } = await import("../web/src/lib/simSelection.ts");
  const withDefault = [sim({ subscriptionId: 1, isDefaultSms: true })];
  const withoutDefault = [sim({ subscriptionId: 1, isDefaultSms: false })];
  assert.equal(simSelectValue(withDefault, withDefault[0], true), DEFAULT_SIM_KEY);
  // No default reported: the control must not claim one, so it shows the resolved SIM instead.
  assert.equal(simSelectValue(withoutDefault, withoutDefault[0], true), simKey(withoutDefault[0]));
  assert.equal(simSelectValue(withDefault, withDefault[0], false), simKey(withDefault[0]));
});
