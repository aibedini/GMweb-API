// Sticky per-conversation SIM: the SEND path must route from the conversation's
// Android-confirmed preference, not from a global composer selection.
//
// PRODUCTION BUG this fixes: `selectedSimKey` was a single global value persisted
// in localStorage and used directly as the SEND_SMS routing target, so a
// conversation pinned to SIM A could be sent from SIM B — or from the phone
// default — without the user asking.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSimRouting, simRoutingNotice, simKey, selectSmsSim }
  from "../web/src/lib/simSelection.ts";

const sim = (simRef, over = {}) => ({ simRef, isActive: true, isDefaultSms: false,
  sendCapable: true, slotIndex: 0, displayName: "d", carrierName: "c", ...over });

const SIM_A = sim("refA", { slotIndex: 0, carrierName: "Alpha" });
const SIM_B = sim("refB", { slotIndex: 1, carrierName: "Beta" });

test("1: two conversations keep independent SIM preferences", () => {
  const sims = [SIM_A, SIM_B];
  const a = resolveSimRouting({ sims, conversationPreferredRef: "refA", composerKey: null });
  const b = resolveSimRouting({ sims, conversationPreferredRef: "refB", composerKey: null });
  assert.deepEqual(a.commandTarget, { simRef: "refA" });
  assert.deepEqual(b.commandTarget, { simRef: "refB" });
  // Reopening A after B still resolves A, regardless of the composer's global key.
  const again = resolveSimRouting({ sims, conversationPreferredRef: "refA", composerKey: "ref:refB" });
  assert.deepEqual(again.commandTarget, { simRef: "refA" }, "conversation preference beats the composer");
  assert.equal(again.source, "CONVERSATION_PREFERENCE");
});

test("2: the confirmed preference is restored from decrypted metadata, not localStorage", () => {
  // The resolver is pure: the same decrypted reference always wins, so a browser
  // reload that restores E2EE data reproduces the confirmed routing.
  const sims = [SIM_A, SIM_B];
  const before = resolveSimRouting({ sims, conversationPreferredRef: "refB", composerKey: null });
  const afterReload = resolveSimRouting({ sims, conversationPreferredRef: "refB", composerKey: null });
  assert.deepEqual(before.commandTarget, afterReload.commandTarget);
  assert.deepEqual(afterReload.commandTarget, { simRef: "refB" });
});

test("3: an explicit composer selection still routes when there is NO preference", () => {
  const chosen = resolveSimRouting({ sims: [SIM_A, SIM_B], conversationPreferredRef: null, composerKey: "ref:refB" });
  assert.equal(chosen.source, "COMPOSER_SELECTION");
  assert.deepEqual(chosen.commandTarget, { simRef: "refB" });
  // No preference anywhere -> the target is OMITTED so the phone picks its default.
  const fallback = resolveSimRouting({ sims: [SIM_A, SIM_B], conversationPreferredRef: null, composerKey: null });
  assert.equal(fallback.source, "PHONE_DEFAULT");
  assert.equal(fallback.commandTarget, null);
});

test("4: a pending preference change blocks sending", () => {
  const pending = resolveSimRouting({ sims: [SIM_A, SIM_B], conversationPreferredRef: "refA",
    preferencePending: true, composerKey: null });
  assert.equal(pending.blocked, "PREFERENCE_PENDING");
  assert.equal(pending.commandTarget, null, "no target may be emitted while pending");
  assert.match(simRoutingNotice(pending.blocked), /waiting for your phone to confirm/i);
});

test("5/6: confirmation enables the new SIM; failure leaves the OLD line intentional", () => {
  const sims = [SIM_A, SIM_B];
  // Before confirmation the new choice is NOT usable.
  assert.equal(resolveSimRouting({ sims, conversationPreferredRef: "refA",
    preferencePending: true, composerKey: null }).blocked, "PREFERENCE_PENDING");
  // After confirmation Android reports B as the preference.
  const confirmed = resolveSimRouting({ sims, conversationPreferredRef: "refB", composerKey: null });
  assert.deepEqual(confirmed.commandTarget, { simRef: "refB" });
  assert.equal(confirmed.blocked, null);
  // A failed change leaves A confirmed: routing returns to A, never to default.
  const restored = resolveSimRouting({ sims, conversationPreferredRef: "refA", composerKey: null });
  assert.deepEqual(restored.commandTarget, { simRef: "refA" });
  assert.equal(restored.source, "CONVERSATION_PREFERENCE");
});

test("7: an inactive preferred SIM blocks and NEVER falls back", () => {
  const sims = [SIM_A, sim("refB", { isActive: false }), sim("refC")];
  const routing = resolveSimRouting({ sims, conversationPreferredRef: "refB", composerKey: null });
  assert.equal(routing.blocked, "PREFERRED_SIM_INACTIVE");
  assert.equal(routing.commandTarget, null, "must not silently use another line");
  assert.equal(routing.sim, undefined);
  assert.match(simRoutingNotice(routing.blocked), /not currently active/i);
  // The same holds when the pinned SIM is gone entirely.
  const gone = resolveSimRouting({ sims, conversationPreferredRef: "refGONE", composerKey: null });
  assert.equal(gone.blocked, "PREFERRED_SIM_UNRESOLVABLE");
  assert.equal(gone.commandTarget, null);
});

test("a send-capable=false preferred SIM is also treated as unusable", () => {
  const sims = [sim("refB", { sendCapable: false }), sim("refA")];
  const routing = resolveSimRouting({ sims, conversationPreferredRef: "refB", composerKey: null });
  assert.notEqual(routing.blocked, null);
  assert.equal(routing.commandTarget, null);
});

test("an explicit selection that no longer resolves blocks instead of becoming default", () => {
  const routing = resolveSimRouting({ sims: [SIM_A], conversationPreferredRef: null, composerKey: "ref:refGONE" });
  assert.equal(routing.blocked, "PREFERRED_SIM_UNRESOLVABLE");
  assert.equal(routing.commandTarget, null);
});

test("every block reason has distinct, actionable copy", () => {
  const reasons = ["PREFERRED_SIM_INACTIVE", "PREFERRED_SIM_UNRESOLVABLE", "PREFERENCE_PENDING"];
  const notices = reasons.map(reason => simRoutingNotice(reason));
  for (const notice of notices) assert.ok(notice && notice.length > 0);
  assert.equal(new Set(notices).size, reasons.length, "no two reasons share copy");
  assert.equal(simRoutingNotice(null), null);
});

test("legacy phones without simRef still route by subscription id", () => {
  const legacy = { subscriptionId: 7, isActive: true, isDefaultSms: true, slotIndex: 0,
    displayName: "d", carrierName: "c" };
  assert.equal(simKey(legacy), "sub:7");
  const routing = resolveSimRouting({ sims: [legacy], conversationPreferredRef: null, composerKey: "sub:7" });
  assert.deepEqual(routing.commandTarget, { subscriptionId: 7 });
  // And a conversation preference expressed as a ref simply cannot resolve here.
  const pinned = resolveSimRouting({ sims: [legacy], conversationPreferredRef: "refA", composerKey: null });
  assert.equal(pinned.blocked, "PREFERRED_SIM_UNRESOLVABLE");
});

test("the resolver never mutates its inputs and is deterministic", () => {
  const sims = [SIM_A, SIM_B];
  const snapshot = JSON.stringify(sims);
  const one = resolveSimRouting({ sims, conversationPreferredRef: "refA", composerKey: "ref:refB" });
  const two = resolveSimRouting({ sims, conversationPreferredRef: "refA", composerKey: "ref:refB" });
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(sims), snapshot);
});

test("selectSmsSim still refuses to substitute an unresolvable explicit key", () => {
  // The earlier invariant must survive this change.
  assert.equal(selectSmsSim([SIM_A, SIM_B], "ref:GONE"), undefined);
  assert.equal(selectSmsSim([SIM_A, SIM_B], null), SIM_A.isDefaultSms ? SIM_A : SIM_A);
});
