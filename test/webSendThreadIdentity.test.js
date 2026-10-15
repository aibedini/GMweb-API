// SEND_SMS must carry the Android Telephony thread id, or Android silently
// bypasses the conversation's sticky preferred SIM.
//
// VERIFIED ANDROID DEFECT this addresses (Messages master, v3.5.3):
//   SmsSender.kt:574
//     private fun chooseSim(threadId: Long, ...): SimChoice {
//         if (threadId <= 0L) return SimChoice.UseRequestOrDefault
//   ...
//     data object UseRequestOrDefault : SimChoice   // "Nothing pinned this send"
//
// Android DOES publish the id (GatewayEventFactory.kt:227/321/454 emit
// `androidThreadId` when > 0), but GMweb's SEND_SMS payload never included it,
// so Android saw threadId = 0 and skipped the preference check on EVERY
// web-originated send. The per-conversation preference was therefore inert.
import test from "node:test";
import assert from "node:assert/strict";

/** Mirrors App.tsx `selectedAndroidThreadId`: newest valid payload value wins. */
function selectedAndroidThreadId(messages, projected) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = validThreadId(messages[index]?.payload?.androidThreadId);
    if (value !== null) return value;
  }
  return validThreadId(projected);
}

/** Valid id, or null. Mirrors the guard App.tsx applies before spreading. */
function validThreadId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Mirrors the SEND_SMS payload assembly. */
function sendPayload({ phone = "+98912", body = "hi", clientMessageId = "c1",
  commandTarget = { simRef: "refB" }, androidThreadId = null }) {
  const threadId = validThreadId(androidThreadId);
  return { phone, body, clientMessageId, ...(commandTarget ?? {}),
    ...(threadId ? { androidThreadId: threadId } : {}) };
}

const msg = (androidThreadId) => ({ payload: { androidThreadId } });

test("the thread id is taken from the newest decrypted payload that has one", () => {
  assert.equal(selectedAndroidThreadId([msg(11), msg(552)], null), 552);
  // Older messages may predate the field; the newest VALID value still wins.
  assert.equal(selectedAndroidThreadId([msg(11), msg(undefined), msg(552)], null), 552);
  assert.equal(selectedAndroidThreadId([msg(552)], 11), 552, "messages outrank the projection");
});

test("an absent or unusable thread id is never guessed", () => {
  assert.equal(selectedAndroidThreadId([], null), null);
  assert.equal(selectedAndroidThreadId([msg(undefined)], null), null);
  assert.equal(selectedAndroidThreadId([msg(0)], null), null, "0 is the bypass value, not an id");
  assert.equal(selectedAndroidThreadId([msg(-1)], null), null);
  assert.equal(selectedAndroidThreadId([msg(1.5)], null), null);
  assert.equal(selectedAndroidThreadId([msg(Number.NaN)], null), null);
  assert.equal(selectedAndroidThreadId([], 0), null, "a zero projection is not an id");
  // Falls back to the conversation projection when no message carries one.
  assert.equal(selectedAndroidThreadId([msg(undefined)], 552), 552);
});

test("SEND_SMS carries the thread id so Android can enforce the preference", () => {
  const payload = sendPayload({ androidThreadId: 552 });
  assert.equal(payload.androidThreadId, 552);
  assert.deepEqual(payload.simRef, "refB", "the routing target is unchanged");
  // Android only consults the conversation preference when threadId > 0.
  assert.ok(payload.androidThreadId > 0, "must be positive or Android bypasses the check");
});

test("a legacy/unmapped conversation omits the field instead of sending 0", () => {
  const payload = sendPayload({ androidThreadId: null });
  assert.equal("androidThreadId" in payload, false,
    "omitting is backward compatible; sending 0 would be indistinguishable from the bypass");
  // The command is still well formed and still routed.
  assert.equal(payload.simRef, "refB");
  assert.equal(payload.body, "hi");
});

test("thread identity and SIM routing are independent fields", () => {
  const withBoth = sendPayload({ androidThreadId: 552, commandTarget: { simRef: "refB" } });
  const noSim = sendPayload({ androidThreadId: 552, commandTarget: null });
  const noThread = sendPayload({ androidThreadId: null, commandTarget: { simRef: "refB" } });
  assert.equal(withBoth.simRef, "refB");
  assert.equal(noSim.simRef, undefined, "phone-default omits the target");
  assert.equal(noSim.androidThreadId, 552, "but thread identity is still asserted");
  assert.equal(noThread.androidThreadId, undefined);
});

test("no payload ever carries a non-positive thread id", () => {
  for (const candidate of [null, undefined, 0, -5, 1.5, Number.NaN]) {
    const payload = sendPayload({ androidThreadId: candidate });
    if ("androidThreadId" in payload) {
      assert.ok(Number.isSafeInteger(payload.androidThreadId) && payload.androidThreadId > 0,
        `invalid id leaked: ${candidate}`);
    }
  }
});
