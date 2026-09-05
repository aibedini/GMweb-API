"use strict";

/**
 * ADR-007 — pairing session lifecycle contract tests.
 *
 * Invariants: TTL 120s, single-use approve+consume, single-use status poll,
 * expired sessions never approve, tampered state transitions rejected.
 */

const test = require("node:test");
const assert = require("node:assert");
const pairing = require("../src/pairingSessions");

const transcript = () => ({
  webDeviceId: "web-abc-123",
  webSigningPublicKey: "B64signingpub",
  webEncryptionPublicKey: "B64encryptionpub",
  // P1-1: ephemeral must differ from the operational signing key.
  ephemeralPublicKey: "B64ephemeralpub",
  nonce: "n0nc3",
});
const ctx = () => ({ ip: "203.0.113.9", origin: "https://messages.example.com" });

test.beforeEach(() => pairing._reset());

test("create returns a 120s single-use session and echoes the QR transcript", () => {
  const created = pairing.createSession(transcript(), ctx());
  assert.equal(created.ttlSeconds, 120);
  const session = pairing.getSession(created.pairingSessionId);
  assert.equal(session.state, "PENDING");
  const qr = pairing.qrPayload(session);
  assert.equal(qr.pairingSessionId, created.pairingSessionId);
  assert.equal(qr.webDeviceId, "web-abc-123");
  assert.equal(qr.origin, "https://messages.example.com");
});

test("all browser QRs omit phone enrollment authority", () => {
  const created = pairing.createSession(transcript(), { ...ctx(), identityBootstrap: true });
  assert.equal(created.identityBootstrapToken, undefined);
  assert.equal(pairing.qrPayload(pairing.getSession(created.pairingSessionId)).identityBootstrapToken, undefined);
});

test("approve flips PENDING → APPROVED exactly once", () => {
  const created = pairing.createSession(transcript(), ctx());
  const res = pairing.approveSession(created.pairingSessionId, {
    certificate: "CERT", deviceId: "web-abc-123",
  });
  assert.equal(res.state, "APPROVED");
  assert.throws(
    () => pairing.approveSession(created.pairingSessionId, { certificate: "CERT2", deviceId: "x" }),
    /already used/
  );
});

test("status consume is single-use (certificate returned exactly once)", () => {
  const created = pairing.createSession(transcript(), ctx());
  pairing.approveSession(created.pairingSessionId, { certificate: "CERT", deviceId: "web-abc-123" });
  const first = pairing.consumeApproval(created.pairingSessionId, created.pollSecret);
  assert.equal(first.certificate, "CERT");
  // Session destroyed after the first consume.
  assert.equal(pairing.getSession(created.pairingSessionId), null);
  assert.equal(pairing.consumeApproval(created.pairingSessionId, created.pollSecret), null);
});

test("expired sessions cannot be approved or fetched", () => {
  const created = pairing.createSession(transcript(), ctx());
  // Force expiry.
  const session = pairing.getSession(created.pairingSessionId);
  require("../src/pairingDb").db().prepare("UPDATE pairing_sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1, session.pairingSessionId);
  assert.throws(
    () => pairing.approveSession(created.pairingSessionId, { certificate: "C", deviceId: "d" }),
    /not found or expired/
  );
});

test("approve requires both certificate and deviceId", () => {
  const created = pairing.createSession(transcript(), ctx());
  assert.throws(
    () => pairing.approveSession(created.pairingSessionId, { certificate: "C" }),
    /certificate and deviceId/
  );
});

test("unapproved status stays PENDING (no certificate leak)", () => {
  const created = pairing.createSession(transcript(), ctx());
  assert.equal(pairing.consumeApproval(created.pairingSessionId), null);
  assert.equal(pairing.getSession(created.pairingSessionId).state, "PENDING");
});
