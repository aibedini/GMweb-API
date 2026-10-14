// Canonical SIM routing: ONE decision must feed display, readiness, the disabled
// Send state and the command payload.
//
// PRODUCTION DEFECT this fixes: `simRouting` used the conversation's preferred
// SIM while `deriveSendReadiness()` still consumed the GLOBAL `selectedSimKey`,
// so the two could disagree — a conversation whose own line was ready could show
// Send disabled because an unrelated global selection failed to resolve, and the
// banner could name a different problem than the actual block.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSimRouting, simRoutingNotice } from "../web/src/lib/simSelection.ts";
import { deriveSendReadiness, sendBlocked, sendReadinessNotice }
  from "../web/src/lib/sendReadiness.ts";

const sim = (simRef, over = {}) => ({ simRef, isActive: true, isDefaultSms: false,
  sendCapable: true, slotIndex: 0, displayName: "d", carrierName: "c", ...over });

const SIM_A = sim("refA", { slotIndex: 0, carrierName: "Alpha" });
const SIM_B = sim("refB", { slotIndex: 1, carrierName: "Beta" });

/** Mirrors App.tsx: the canonical key implied by the routing decision. */
const canonicalKey = (routing) => routing.commandTarget === null
  ? null
  : "simRef" in routing.commandTarget
    ? `ref:${routing.commandTarget.simRef}`
    : `sub:${routing.commandTarget.subscriptionId}`;

/** Mirrors App.tsx: readiness is derived from the canonical decision ONLY. */
function readinessFor({ sims, preferredRef, composerKey, preferencePending = false }) {
  const routing = resolveSimRouting({ sims, conversationPreferredRef: preferredRef,
    preferencePending, composerKey });
  const readiness = deriveSendReadiness({
    draft: "hello", hasRecipient: true, canSend: true, sending: false,
    phonePresence: "ONLINE", telemetryFreshness: "FRESH",
    sim: { state: "OK", active: [SIM_A, SIM_B] },
    selectedSimKey: canonicalKey(routing),
    simRoutingBlocked: routing.blocked,
  });
  return { routing, readiness, blocked: sendBlocked(readiness),
    notice: sendReadinessNotice(readiness), key: canonicalKey(routing) };
}

test("15: display, readiness, disabled Send and payload always agree", () => {
  const cases = [
    { preferredRef: "refA", composerKey: null },              // conversation pin
    { preferredRef: "refB", composerKey: "ref:refA" },        // pin beats composer
    { preferredRef: null, composerKey: "ref:refB" },          // composer only
    { preferredRef: null, composerKey: null },                // phone default
    { preferredRef: "refGONE", composerKey: null },           // unresolvable pin
    { preferredRef: "refB", composerKey: null, preferencePending: true },
  ];
  for (const item of cases) {
    const sims = [SIM_A, SIM_B];
    const { routing, blocked, key } = readinessFor({ sims, ...item });
    const label = JSON.stringify(item);
    // The payload target and the key readiness used must describe the SAME line.
    const targetRef = routing.commandTarget && "simRef" in routing.commandTarget
      ? `ref:${routing.commandTarget.simRef}` : null;
    if (routing.commandTarget) {
      assert.equal(key, targetRef, `key/payload disagree: ${label}`);
    } else {
      assert.equal(key, null, `blocked or default must yield no key: ${label}`);
    }
    // Send is disabled exactly when routing is blocked.
    assert.equal(blocked, routing.blocked !== null, `Send/block disagree: ${label}`);
  }
});

test("a conversation whose own SIM is ready is NOT blocked by a bad global key", () => {
  // The defect: a stale/unresolvable global selection used to disable Send even
  // though the conversation's confirmed line was perfectly usable.
  const { routing, blocked, key } = readinessFor({
    sims: [SIM_A, SIM_B], preferredRef: "refB", composerKey: "ref:refGONE" });
  assert.equal(routing.blocked, null);
  assert.equal(blocked, false, "the conversation's ready line must enable Send");
  assert.equal(key, "ref:refB", "and the payload must name that line");
});

test("the banner names the REAL routing reason, not a generic SIM hint", () => {
  const inactive = readinessFor({ sims: [SIM_A, sim("refB", { isActive: false })],
    preferredRef: "refB", composerKey: null });
  assert.equal(inactive.readiness.state, "SIM_ROUTING_BLOCKED");
  assert.equal(inactive.blocked, true);
  assert.equal(inactive.notice?.kind, "SIM");
  assert.match(inactive.notice?.message ?? "", /not currently active/i);
  assert.match(inactive.notice?.message ?? "", new RegExp(
    simRoutingNotice("PREFERRED_SIM_INACTIVE").slice(0, 28).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.notEqual(inactive.notice?.title, "SIM needs attention",
    "must not be presented as a generic SIM fault");

  const pending = readinessFor({ sims: [SIM_A, SIM_B], preferredRef: "refA",
    composerKey: null, preferencePending: true });
  assert.equal(pending.readiness.state, "SIM_ROUTING_BLOCKED");
  assert.match(pending.notice?.message ?? "", /waiting for your phone to confirm/i);

  const unknown = readinessFor({ sims: [SIM_A], preferredRef: "refGONE", composerKey: null });
  assert.match(unknown.notice?.message ?? "", /no longer available/i);
});

test("routing refusal outranks the SIM telemetry states", () => {
  // The SIM list can look healthy while THIS conversation's line is the problem.
  const routing = resolveSimRouting({ sims: [SIM_A, sim("refB", { isActive: false })],
    conversationPreferredRef: "refB", composerKey: null });
  const readiness = deriveSendReadiness({
    draft: "hi", hasRecipient: true, canSend: true, sending: false,
    phonePresence: "ONLINE", telemetryFreshness: "FRESH",
    sim: { state: "OK", active: [SIM_A, SIM_B] }, selectedSimKey: null,
    simRoutingBlocked: routing.blocked,
  });
  assert.equal(readiness.state, "SIM_ROUTING_BLOCKED");
});

test("legacy callers that omit simRoutingBlocked are unaffected", () => {
  const readiness = deriveSendReadiness({
    draft: "hi", hasRecipient: true, canSend: true, sending: false,
    phonePresence: "ONLINE", telemetryFreshness: "FRESH",
    sim: { state: "OK", active: [SIM_A, SIM_B] }, selectedSimKey: null,
  });
  assert.equal(readiness.state, "READY_DEFAULT");
  assert.equal(sendBlocked(readiness), false);
});

test("no canonical decision ever yields both a key and a block", () => {
  for (const preferredRef of ["refA", "refB", "refGONE", null]) {
    for (const composerKey of ["ref:refA", "ref:refB", "ref:refGONE", null]) {
      for (const preferencePending of [false, true]) {
        const { routing, key } = readinessFor({ sims: [SIM_A, SIM_B], preferredRef,
          composerKey, preferencePending });
        if (routing.blocked !== null) {
          assert.equal(key, null, "a blocked decision must emit no target");
          assert.equal(routing.commandTarget, null);
        }
      }
    }
  }
});

test("A and B keep independent canonical routing across interleaved opens", () => {
  const sims = [SIM_A, SIM_B];
  const openA = readinessFor({ sims, preferredRef: "refA", composerKey: null });
  const openB = readinessFor({ sims, preferredRef: "refB", composerKey: null });
  const reopenA = readinessFor({ sims, preferredRef: "refA", composerKey: "ref:refB" });
  assert.equal(openA.key, "ref:refA");
  assert.equal(openB.key, "ref:refB");
  assert.equal(reopenA.key, "ref:refA", "reopening A restores A regardless of the composer");
});
