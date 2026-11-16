"use strict";
// PREVENT FUTURE CONTRACT DRIFT (P0):
//   - shared/pairing-protocol-v1.json::capability_definitions is the SINGLE
//     canonical capability contract.
//   - shared/pairingProtocol.mjs PAIRING_CAPABILITIES (browser-safe mirror)
//     must equal it EXACTLY.
//   - src/pairingCertificate.js / src/devicePolicy.js must read the allowlist
//     and the per-device_type_policy from it (never a hardcoded Set) and treat
//     each device type's required capabilities as mandatory.
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
  return [...d.base, ...d.sensitive, ...d.reserved, ...d.ai];
}

test("schema declares exactly the documented capability groups", () => {
  const d = schema.capability_definitions;
  assert.ok(d && Array.isArray(d.base) && Array.isArray(d.sensitive) && Array.isArray(d.reserved) && Array.isArray(d.ai),
    "capability_definitions with base/sensitive/reserved/ai is mandatory");
  assert.deepEqual(d.base, ["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS"]);
  assert.deepEqual(d.sensitive,
    ["CONTACTS_READ", "READ_OTP", "READ_BANK_SECURITY", "READ_PASSWORD_RESET", "READ_AUTH_CODES", "READ_FINANCIAL_NOTIFICATIONS"]);
  assert.deepEqual(d.reserved, ["MANAGE_DEVICES"]);
  assert.deepEqual(d.ai, ["AI_SUGGEST"]);
  const all = universe();
  assert.equal(new Set(all).size, all.length, "capability groups must not overlap or repeat");
});

test("device_type_policy classifies every capability exactly once per device type", () => {
  const d = schema.capability_definitions;
  const all = [...universe()].sort();
  const policy = schema.device_type_policy;
  assert.ok(policy && typeof policy === "object", "device_type_policy is mandatory");
  assert.deepEqual(Object.keys(policy).filter(k => !k.startsWith("$")).sort(), ["AI_AGENT", "WEB_PWA"]);

  // WEB_PWA keeps today's semantics: the base set is mandatory, sensitive and
  // reserved grants stay optional, AI_SUGGEST is forbidden.
  assert.deepEqual(policy.WEB_PWA.required_capabilities, d.base);
  assert.deepEqual(
    [...policy.WEB_PWA.optional_capabilities].sort(),
    [...d.sensitive, ...d.reserved].sort(),
  );
  assert.deepEqual(policy.WEB_PWA.forbidden_capabilities, d.ai);
  assert.deepEqual(policy.WEB_PWA.history_grant, ["FULL_HISTORY", "FROM_NOW_ON"]);

  // AI_AGENT: exactly READ_MESSAGES + AI_SUGGEST, no optional grants, and
  // every other capability explicitly forbidden. From-now-on history only.
  assert.deepEqual(policy.AI_AGENT.required_capabilities, ["READ_MESSAGES", "AI_SUGGEST"]);
  assert.deepEqual(policy.AI_AGENT.optional_capabilities, []);
  assert.deepEqual(policy.AI_AGENT.forbidden_capabilities, [
    "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS", "CONTACTS_READ", "READ_OTP",
    "READ_BANK_SECURITY", "READ_PASSWORD_RESET", "READ_AUTH_CODES",
    "READ_FINANCIAL_NOTIFICATIONS", "MANAGE_DEVICES",
  ]);
  assert.deepEqual(policy.AI_AGENT.history_grant, ["FROM_NOW_ON"]);

  for (const deviceType of ["WEB_PWA", "AI_AGENT"]) {
    const p = policy[deviceType];
    const classified = [...p.required_capabilities, ...p.optional_capabilities, ...p.forbidden_capabilities].sort();
    assert.deepEqual(classified, all,
      `${deviceType} policy must classify every capability in the universe exactly once`);
  }
});

test("runtime mirror (pairingProtocol.mjs) EXACTLY matches the JSON schema", () => {
  const all = universe().slice().sort();
  assert.deepEqual([...protocol.PAIRING_CAPABILITIES].sort(), all,
    "pairingProtocol.mjs PAIRING_CAPABILITIES drifted from capability_definitions");
  assert.deepEqual([...policy.CAPABILITIES].sort(), all,
    "server CAPABILITIES allowlist drifted from capability_definitions");
});

test("server certificate policy reads base/sensitive/reserved/ai from the schema", () => {
  assert.deepEqual(policy.REQUIRED_CAPABILITIES, schema.capability_definitions.base);
  assert.deepEqual(policy.SENSITIVE_CAPABILITIES, schema.capability_definitions.sensitive);
  assert.deepEqual(policy.OPTIONAL_CAPABILITIES, schema.capability_definitions.reserved);
  assert.deepEqual(policy.AI_CAPABILITIES, schema.capability_definitions.ai);
  assert.deepEqual(policy.CAPABILITY_DEFINITIONS, schema.capability_definitions);
  assert.deepEqual(policy.requiredCapabilitiesFor("WEB_PWA"),
    schema.device_type_policy.WEB_PWA.required_capabilities);
  assert.deepEqual(policy.requiredCapabilitiesFor("AI_AGENT"), ["READ_MESSAGES", "AI_SUGGEST"]);
  assert.equal(policy.requiredCapabilitiesFor("UNKNOWN_DEVICE"), null);
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
  const theirsPath = path.resolve(__dirname, "..", "..", "Messages", "protocol", "pairing-protocol-v1.json");
  if (!fs.existsSync(theirsPath)) return; // enforced by .github/workflows when this repo is alone
  const theirs = fs.readFileSync(theirsPath);
  // Both files are `*.json text eol=lf` in git, so the CONTENT that matters is
  // the LF-normalised one. A Windows checkout of the sibling repo (no
  // .gitattributes, core.autocrlf=true) rewrites every \n to \r\n and would
  // otherwise fail this guard on an artifact git itself ignores; the strict byte
  // comparison still runs in CI, which checks out both repos.
  const lf = (buffer) => buffer.toString("utf8").replace(/\r\n/g, "\n");
  assert.equal(lf(theirs), lf(ours),
    "Messages/protocol/pairing-protocol-v1.json drifted from GMweb-API/shared copy — fix both in the same commit");
});
