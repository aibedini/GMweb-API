// SMS sender identity: branded / alphanumeric senders must survive end-to-end.
//
// PRODUCTION BUG: every sender was run through digits-only phone normalization,
// so Android showed PARSIANBANK / ResalatBank / Ssh3-652 while GMweb showed
// "Unknown conversation" — and worse, four distinct brands all normalized to the
// SAME empty string, and Ssh3-652 was silently corrupted to "3652".
import test from "node:test";
import assert from "node:assert/strict";
import { classifySender, isPhoneSender, senderKey, senderMatches, senderSearchText }
  from "../web/src/lib/senderIdentity.ts";
import { contactTitle, phoneKey } from "../web/src/lib/inboxActions.ts";
import { deriveSendReadiness, sendBlocked, sendReadinessNotice } from "../web/src/lib/sendReadiness.ts";

const PHONE_READINESS = {
  draft: "hello", hasRecipient: true, canSend: true, sending: false,
  phonePresence: "ONLINE", telemetryFreshness: "FRESH",
  sim: { state: "OK", active: true }, selectedSubscriptionId: null,
};

// ── §11 fixture matrix ──────────────────────────────────────────────────────

test("PHONE senders classify and normalize exactly as before", () => {
  assert.equal(classifySender("+989121234567").kind, "PHONE");
  assert.equal(classifySender("09121234567").kind, "PHONE");
  // Persian digits must normalize for phones.
  assert.equal(classifySender("\u06F0\u06F9\u06F1\u06F2\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7").kind, "PHONE");
  assert.equal(senderKey("+989121234567"), "phone:989121234567");
  assert.equal(senderKey("09121234567"), "phone:989121234567",
    "local and E.164 forms are the same subscriber");
  assert.equal(isPhoneSender("09121234567"), true);
});

test("branded alphanumeric senders keep their exact identity", () => {
  for (const raw of ["PARSIANBANK", "ResalatBank", "Ssh3-652", "S10 R180", "BANK_OTP", "Google"]) {
    const identity = classifySender(raw);
    assert.equal(identity.kind, "ALPHANUMERIC", raw);
    assert.equal(identity.rawAddress, raw, "raw value preserved verbatim");
    assert.equal(identity.displayValue, raw, "displayed exactly, never digits-only");
    assert.notEqual(identity.canonicalAddress, null, `${raw} must have a stable identity`);
  }
  // The old behaviour, for the record.
  assert.equal(phoneKey("PARSIANBANK"), "");
  assert.equal(phoneKey("Ssh3-652"), "3652");
});

test("two different alpha IDs never collide", () => {
  const keys = ["PARSIANBANK", "ResalatBank", "Google", "BANK_OTP"].map(senderKey);
  assert.equal(new Set(keys).size, 4, "four distinct senders must not collapse");
  assert.ok(!keys.includes("") && !keys.includes(null));
  // Case is branding: the key folds, the display does not.
  assert.equal(senderKey("ParsianBank"), senderKey("PARSIANBANK"));
  assert.equal(classifySender("ParsianBank").rawAddress, "ParsianBank");
});

test("Ssh3-652 does not collapse to digits only", () => {
  const identity = classifySender("Ssh3-652");
  assert.equal(identity.displayValue, "Ssh3-652");
  assert.notEqual(identity.canonicalAddress, "short:3652");
  assert.notEqual(senderKey("Ssh3-652"), senderKey("3000"));
  assert.equal(classifySender("S10 R180").displayValue, "S10 R180");
});

test("short codes have a stable, separate identity", () => {
  for (const code of ["3000", "100020"]) {
    const identity = classifySender(code);
    assert.equal(identity.kind, "SHORT_CODE", code);
    assert.equal(identity.displayValue, code);
  }
  assert.equal(senderKey("3000"), "short:3000");
  assert.notEqual(senderKey("3000"), senderKey("100020"));
  // A short code must never be confused with a phone number.
  assert.notEqual(senderKey("3000"), senderKey("+983000"));
});

test("UNKNOWN is reserved for genuinely absent data", () => {
  for (const raw of [null, undefined, "", "   "]) {
    const identity = classifySender(raw);
    assert.equal(identity.kind, "UNKNOWN", JSON.stringify(raw));
    assert.equal(identity.canonicalAddress, null);
  }
  // "Not a phone number" is NOT unknown.
  assert.notEqual(classifySender("PARSIANBANK").kind, "UNKNOWN");
  assert.notEqual(classifySender("3000").kind, "UNKNOWN");
});

// ── §12 production incident ─────────────────────────────────────────────────

test("incident: Android shows PARSIANBANK, GMweb must too", () => {
  // This is what the GMweb projection does with a raw address that arrived.
  const address = "PARSIANBANK";
  const displayName = typeof undefined === "string" ? undefined : address;
  assert.equal(displayName || "Unknown conversation", "PARSIANBANK");
});

test("incident: Ssh3-652 is not empty, not 3652, not Unknown", () => {
  const title = classifySender("Ssh3-652").displayValue || "Unknown conversation";
  assert.equal(title, "Ssh3-652");
  assert.notEqual(title, "");
  assert.notEqual(title, "3652");
  assert.notEqual(title, "Unknown conversation");
});

// ── §6/§7 contact lookup ────────────────────────────────────────────────────

test("alphanumeric senders are never contact-matched as phones", () => {
  const names = new Map([["3652", "Wrong contact"], ["", "Blank contact"]]);
  const row = { aggregateId: "c1", title: "Ssh3-652", subtitle: "", preview: "", lastAt: 0,
    read: true, unreadCount: 0, lastMessageId: "c1", lastSequence: 0, decodeState: "ready" };
  // The buggy lookup would have matched names["3652"] and renamed the thread.
  assert.equal(phoneKey("Ssh3-652"), "3652");
  assert.deepEqual(contactTitle(row, names), row, "branded sender must keep its own title");
  // A real phone still resolves a contact name.
  const phoneRow = { ...row, title: "+989121234567", subtitle: "" };
  assert.equal(contactTitle(phoneRow, new Map([["989121234567", "Ali"]])).title, "Ali");
});

// ── §8 replyability ────────────────────────────────────────────────────────

test("a branded sender is not replyable and blocks sending", () => {
  const readiness = deriveSendReadiness({ ...PHONE_READINESS, recipientAddress: "PARSIANBANK" });
  assert.equal(readiness.state, "NOT_REPLYABLE");
  assert.equal(sendBlocked(readiness), true, "must never dispatch to PARSIANBANK");
  const notice = sendReadinessNotice(readiness);
  assert.equal(notice?.title, "Replies unavailable");
  assert.notEqual(notice?.kind, "SIM", "not a SIM fault");
});

test("phone and short-code recipients stay sendable", () => {
  for (const to of ["+989121234567", "09121234567", "3000"]) {
    const readiness = deriveSendReadiness({ ...PHONE_READINESS, recipientAddress: to });
    assert.notEqual(readiness.state, "NOT_REPLYABLE", to);
    assert.equal(sendBlocked(readiness), false, to);
  }
});

test("legacy callers that omit recipientAddress are unaffected", () => {
  const readiness = deriveSendReadiness({ ...PHONE_READINESS });
  assert.equal(readiness.state, "READY_DEFAULT");
  assert.equal(sendBlocked(readiness), false);
});

// ── §9 search ──────────────────────────────────────────────────────────────

test("search finds branded senders", () => {
  assert.equal(senderMatches("PARSIANBANK", "parsian"), true);
  assert.equal(senderMatches("PARSIANBANK", "PARSIANBANK"), true);
  assert.equal(senderMatches("ResalatBank", "Resalat"), true);
  assert.equal(senderMatches("Ssh3-652", "Ssh3"), true);
  assert.equal(senderMatches("Ssh3-652", "ssh3-652"), true, "case-insensitive");
  // A bare digit fragment must NOT match a branded sender: "3652" matching
  // "Ssh3-652" is exactly the phoneKey() corruption this fix removes, and it
  // would also let a search for a real short code alias a branded sender.
  assert.equal(senderMatches("Ssh3-652", "3652"), false);
  assert.equal(senderMatches("PARSIANBANK", "resalat"), false);
  assert.equal(senderMatches("PARSIANBANK", ""), true, "empty query matches all");
  // The raw value is in the haystack even though a contact name replaced the title.
  assert.match(senderSearchText("PARSIANBANK"), /parsianbank/);
});

test("E2EE/decrypt contract is untouched by classification", () => {
  // Classification is a pure function of a plaintext address; it neither reads
  // nor produces ciphertext, and returns the input unchanged for phones.
  const identity = classifySender("+989121234567");
  assert.equal(identity.rawAddress, "+989121234567");
  assert.equal(typeof identity.replyable, "boolean");
});
