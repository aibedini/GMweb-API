// FAIL-CLOSED: an existing conversation must not be submitted without a verified
// Android thread identity.
//
// HONEST SCOPE: these are PURE-MODULE tests. They call `deriveSendReadiness`
// directly. They are NOT integration evidence and do NOT prove the mounted UI or
// the encrypted command assembly behaves this way — the repository still has no
// jsdom/React testing library, so that evidence does not exist yet.
//
// ANDROID DEFECT this guards (Messages v3.5.3, sms/SmsSender.kt:574):
//   if (threadId <= 0L) return SimChoice.UseRequestOrDefault
// A send without the identity makes Android SKIP the conversation's sticky
// preferred-SIM check, so the message is not held to its own line.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveSendReadiness, sendBlocked, sendReadinessNotice }
  from "../web/src/lib/sendReadiness.ts";

const base = {
  draft: "hello", hasRecipient: true, canSend: true, sending: false,
  phonePresence: "ONLINE", telemetryFreshness: "FRESH",
  sim: { state: "OK", active: [] }, selectedSimKey: null,
};

test("an existing conversation with no thread identity is blocked, not bypassed", () => {
  const readiness = deriveSendReadiness({ ...base, threadIdentityMissing: true });
  assert.equal(readiness.state, "THREAD_IDENTITY_UNAVAILABLE");
  assert.equal(sendBlocked(readiness), true, "no command may be assembled");
  const notice = sendReadinessNotice(readiness);
  assert.equal(notice?.blocking, true);
  assert.match(notice?.message ?? "", /no verified phone thread/i);
  assert.match(notice?.message ?? "", /preferred SIM/i, "must explain WHY it is blocked");
  // It must not be presented as "there is nothing older"/end-of-history style
  // dead end; it offers a recovery action.
  assert.equal(notice?.offersSimRefresh, true);
});

test("a genuinely NEW message is unaffected", () => {
  // No thread exists yet, so there is nothing to enforce and normal sending must
  // keep working.
  const readiness = deriveSendReadiness({ ...base, threadIdentityMissing: false });
  assert.equal(readiness.state, "READY_DEFAULT");
  assert.equal(sendBlocked(readiness), false);
  // And legacy callers that omit the field entirely behave as before.
  assert.equal(sendBlocked(deriveSendReadiness({ ...base })), false);
});

test("thread identity is checked AFTER routing and before SIM telemetry states", () => {
  // Routing refusal still wins: a pinned conversation whose line is gone is a
  // more specific diagnosis than a missing identity.
  const routing = deriveSendReadiness({ ...base, simRoutingBlocked: "PREFERRED_SIM_INACTIVE",
    threadIdentityMissing: true });
  assert.equal(routing.state, "SIM_ROUTING_BLOCKED");
  // But a missing identity outranks a merely-unresolvable explicit selection,
  // because it disables Android's enforcement rather than mis-resolving locally.
  const thread = deriveSendReadiness({ ...base, threadIdentityMissing: true,
    selectedSimKey: "ref:whatever" });
  assert.equal(thread.state, "THREAD_IDENTITY_UNAVAILABLE");
});

test("blocking is driven by the identity flag alone, never by heuristics", () => {
  // No title, contact name, sender string or phone number may substitute for a
  // verified thread identity. Only the explicit flag decides.
  for (const extra of [{}, { recipientAddress: "+989121234567" }, { selectedSimKey: "ref:refB" }]) {
    assert.equal(deriveSendReadiness({ ...base, ...extra, threadIdentityMissing: true }).state,
      "THREAD_IDENTITY_UNAVAILABLE", JSON.stringify(extra));
    // The property under test is that the IDENTITY flag is not what blocks here
    // (other states may legitimately block for their own reasons).
    assert.notEqual(deriveSendReadiness({ ...base, ...extra, threadIdentityMissing: false }).state,
      "THREAD_IDENTITY_UNAVAILABLE", JSON.stringify(extra));
  }
  // With no identity flag, a plain phone recipient and no SIM assertion is ready.
  assert.equal(sendBlocked(deriveSendReadiness({ ...base, threadIdentityMissing: false })), false);
  // An alphanumeric sender is not replyable AT ALL — a more fundamental block
  // than a missing thread identity, so it wins and must still block.
  const branded = deriveSendReadiness({ ...base, recipientAddress: "PARSIANBANK",
    threadIdentityMissing: true });
  assert.equal(branded.state, "NOT_REPLYABLE");
  assert.equal(sendBlocked(branded), true);
});
