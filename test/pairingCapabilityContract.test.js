"use strict";
// PREVENT FUTURE CONTRACT DRIFT (P0):
//   - shared/pairing-protocol-v1.json::capability_definitions is the SINGLE
//     canonical capability contract.
//   - shared/pairingProtocol.mjs PAIRING_CAPABILITIES (browser-safe mirror)
//     must equal it EXACTLY.
//   - src/pairingCertificate.js must read the allowlist from it (never a
//     hardcoded Set) and treat base capabilities as mandatory.
//   - The shared fixture must carry the REAL Android LinkedDevicesScreen
//     certificate vector so both runtimes re-derive identical canonical bytes.
//   - When the Messages checkout sits next to this repo, the two protocol
//     files must be byte-identical (also enforced cross-repo in CI).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const schema = require("../shared/pairing-protocol-v1.json");
const protocol = require("../shared/pairingProtocol.mjs");
const policy = require("../src/pairingCertificate");

function universe() {
  const d = schema.capability_definitions;
  return [...d.base, ...d.sensitive, ...d.reserved];
}

test("schema declares exactly the documented capability groups", () => {
  const d = schema.capability_definitions;
  assert.ok(d && Array.isArray(d.base) && Array.isArray(d.sensitive) && Array.isArray(d.reserved),
    "capability_definitions with base/sensitive/reserved is mandatory");
  assert.deepEqual(d.base, ["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS"]);
  assert.deepEqual(d.sensitive,
    ["CONTACTS_READ", "READ_OTP", "READ_BANK_SECURITY", "READ_PASSWORD_RESET", "READ_AUTH_CODES", "READ_FINANCIAL_NOTIFICATIONS"]);
  assert.deepEqual(d.reserved, ["MANAGE_DEVICES"]);
  const all = universe();
  assert.equal(new Set(all).size, all.length, "capability groups must not overlap or repeat");
});

test("runtime mirror (pairingProtocol.mjs) EXACTLY matches the JSON schema", () => {
  const all = universe().slice().sort();
  assert.deepEqual([...protocol.PAIRING_CAPABILITIES].sort(), all,
    "pairingProtocol.mjs PAIRING_CAPABILITIES drifted from capability_definitions");
  assert.deepEqual([...policy.CAPABILITIES].sort(), all,
    "server CAPABILITIES allowlist drifted from capability_definitions");
});

test("server certificate policy reads base/sensitive/reserved from the schema", () => {
  assert.deepEqual(policy.REQUIRED_CAPABILITIES, schema.capability_definitions.base);
  assert.deepEqual(policy.SENSITIVE_CAPABILITIES, schema.capability_definitions.sensitive);
  assert.deepEqual(policy.OPTIONAL_CAPABILITIES, schema.capability_definitions.reserved);
  assert.deepEqual(policy.CAPABILITY_DEFINITIONS, schema.capability_definitions);
});

test("every certificate vector stays inside the schema capability universe", () => {
  const all = new Set(universe());
  for (const v of schema.vectors) {
    if (!v.input || !Array.isArray(v.input.capabilities)) continue;
    for (const cap of v.input.capabilities) {
      assert.ok(all.has(cap), `vector ${v.kind} (${v.label || ""}) uses unknown capability ${cap}`);
    }
  }
});

test("the shared fixture carries the REAL Android linked-browser certificate vector", () => {
  const android = schema.vectors.find(v => v.label === "android_linked_browser_default");
  assert.ok(android, "android_linked_browser_default vector missing from shared fixture");
  assert.deepEqual(
    [...android.input.capabilities].sort(),
    [...schema.capability_definitions.base, "CONTACTS_READ", "READ_OTP"].sort(),
    "Android vector must equal LinkedDevicesScreen output: base + selected contacts and OTP grants",
  );
  assert.equal(android.canonicalBase64.length > 0, true);
  assert.match(android.sha256, /^[0-9a-f]{64}$/);
});

test("Messages protocol copy is byte-identical (local drift guard; CI enforces remotely)", () => {
  const ours = fs.readFileSync(path.join(__dirname, "..", "shared", "pairing-protocol-v1.json"));
  const theirs = path.resolve(__dirname, "..", "..", "Messages", "protocol", "pairing-protocol-v1.json");
  if (!fs.existsSync(theirs)) return; // enforced by .github/workflows when this repo is alone
  assert.deepEqual(fs.readFileSync(theirs), ours,
    "Messages/protocol/pairing-protocol-v1.json drifted from GMweb-API/shared copy — fix both in the same commit");
});
