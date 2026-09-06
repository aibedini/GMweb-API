"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { buildServerChecks, fingerprint } = require("../src/connectionDiagnostics");

test("diagnostics compare the decoded trust-root key and expose safe server truth", () => {
  const root = crypto.randomBytes(91).toString("base64");
  const expected = crypto.createHash("sha256").update(Buffer.from(root, "base64")).digest("hex");
  assert.equal(fingerprint(root), expected);

  const checks = buildServerChecks({
    identity: { device_role: "PRIMARY_TRUST_AGENT", trust_root_public_key: root },
    trustRootFingerprint: expected,
    trustSequence: 14,
    linkedDevices: 2,
    activeSessions: 3,
    publicApiOrigin: "https://api.example.test",
  });
  assert.equal(checks.agentSignatureAccepted, true);
  assert.equal(checks.isPrimary, true);
  assert.equal(checks.trustRootMatch, true);
  assert.equal(checks.serverTrustSequence, 14);
  assert.equal(checks.linkedDeviceCount, 2);
  assert.equal(checks.activeLinkedSessionCount, 3);
  assert.equal(checks.publicApiOrigin, "https://api.example.test");
  assert.equal(JSON.stringify(checks).includes(root), false);
});

test("diagnostics fail closed for a missing identity", () => {
  const checks = buildServerChecks({
    identity: null,
    trustRootFingerprint: "0".repeat(64),
    trustSequence: 0,
    linkedDevices: 0,
    activeSessions: 0,
  });
  assert.equal(checks.agentSignatureAccepted, false);
  assert.equal(checks.identityEnrolled, false);
  assert.equal(checks.isPrimary, false);
  assert.equal(checks.trustRootMatch, false);
});
