"use strict";
// FETCH_THREAD_HISTORY rides the EXISTING durable encrypted command transport.
//
// The server must accept the type in its linked-browser allowlist while treating
// the payload as opaque ciphertext: it never learns the phone number, the
// branded sender, the Android thread id or the SMS body. Support is negotiated
// from the runtime capability, never from an Android version string.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "controlPlaneRoutes.js"), "utf8");

function allowlist() {
  const match = source.match(/const ENCRYPTED_LINKED_COMMAND_TYPES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(match, "the allowlist is declared as a literal Set");
  return match[1].split(",").map(entry => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

test("FETCH_THREAD_HISTORY is in the linked-browser encrypted command allowlist", () => {
  const types = allowlist();
  assert.ok(types.includes("FETCH_THREAD_HISTORY"), "allowlist must contain it");
  // Existing types must not have been dropped.
  for (const existing of ["SEND_SMS", "MARK_THREAD_READ", "REFRESH_DEVICE_TELEMETRY"]) {
    assert.ok(types.includes(existing), `${existing} must remain allowed`);
  }
});

test("only encrypted envelope.v1 submissions reach the allowlist path", () => {
  // The allowlist is consulted for the encrypted linked-command branch, i.e.
  // after envelope/schema/crypto validation. There is no plaintext sibling.
  for (const field of ["encoding", "schemaVersion", "cryptoVersion"]) {
    assert.match(source, new RegExp(`${field}\\s*:`), `${field} must be validated`);
  }
  assert.match(source, /envelope\.v1/);
  // No plaintext command route was invented for history.
  assert.doesNotMatch(source, /\/commands\/history/);
  assert.doesNotMatch(source, /plaintext/i);
});

test("FETCH_THREAD_HISTORY requires READ_MESSAGES on the linked session", () => {
  assert.match(source,
    /body\.type === "FETCH_THREAD_HISTORY"[\s\S]{0,200}capabilities\?\.includes\("READ_MESSAGES"\)/,
    "the capability gate must exist and read READ_MESSAGES");
  assert.match(source, /read_messages_capability_required/);
});

test("the other capability gates are unchanged", () => {
  assert.match(source, /body\.type === "SEND_SMS"[\s\S]{0,120}SEND_MESSAGES/);
  assert.match(source, /body\.type === "MARK_THREAD_READ"[\s\S]{0,120}MARK_READ/);
});

test("the payload is opaque: no history field is ever read by the server", () => {
  // The server must not destructure or persist history-specific plaintext.
  for (const forbidden of ["androidThreadId", "nextBefore", "publishedCount", "phoneNextBefore"]) {
    assert.doesNotMatch(source, new RegExp(`body\\.${forbidden}`),
      `server must not read body.${forbidden}`);
    assert.doesNotMatch(source, new RegExp(`payload\\.${forbidden}`),
      `server must not read payload.${forbidden}`);
  }
});

test("command lifecycle stays durable and idempotent", () => {
  // Commands are created through the durable engine before responding, and the
  // history type rides that same path (no bypass, no special-casing).
  const historyBranch = source.slice(source.indexOf('body.type === "FETCH_THREAD_HISTORY"'));
  assert.doesNotMatch(historyBranch.slice(0, 600), /return reply\.code\(200\)\.send\(\{ ok: true \}\)/,
    "no early success bypass for history commands");
  assert.match(source, /idempotencyKey/);
});
