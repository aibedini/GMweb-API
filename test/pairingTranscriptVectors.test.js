"use strict";

/**
 * ADR-007 BLOCKER 2 — shared serialization test vectors.
 *
 * These vectors pin the BYTE-FOR-BYTE contract between PrimaryTrustRoot.kt
 * (Android) and web/src/lib/trustRoot.ts (web). If either side changes
 * canonical serialization, these tests fail — preventing Kotlin ↔ TypeScript
 * drift.
 *
 * The Android side generates its own fixture with the same inputs and must
 * produce the identical canonical string + SHA-256 + a verifiable ECDSA
 * signature over the same bytes (P-256/SHA-256, SPKI base64 public key).
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { canonicalCertificate, verifyRootSignature } = require("../src/pairingCanonical");

const VECTOR = {
  certificate: {
    accountId: "default",
    deviceId: "web-device-42",
    deviceType: "WEB_PWA",
    signingPublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETESTSIGINGPUBKEY0000000000=",
    encryptionPublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETESTENCPUBKEY00000000000=",
    capabilities: ["SEND_MESSAGES", "READ_MESSAGES", "MARK_READ"],
    historyGrant: "FULL_HISTORY",
    trustSequence: 7,
    issuedAt: 1788300000000,
    expiresAt: 1791000000000,
    pairingTranscriptHash: "a".repeat(64),
    origin: "https://messages.example.com",
    rootSignature: "", // filled by the signing side
  },
  // Expected canonical bytes: fixed key order (accountId..origin), capabilities SORTED
  // (MARK_READ, READ_MESSAGES, SEND_MESSAGES), compact JSON.
  expectedCanonical: JSON.stringify({
    accountId: "default",
    deviceId: "web-device-42",
    deviceType: "WEB_PWA",
    signingPublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETESTSIGINGPUBKEY0000000000=",
    encryptionPublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETESTENCPUBKEY00000000000=",
    capabilities: ["MARK_READ", "READ_MESSAGES", "SEND_MESSAGES"],
    historyGrant: "FULL_HISTORY",
    trustSequence: 7,
    issuedAt: 1788300000000,
    expiresAt: 1791000000000,
    pairingTranscriptHash: "a".repeat(64),
    origin: "https://messages.example.com",
  }),
  expectedSha256: crypto
    .createHash("sha256")
    .update(
      Buffer.from(
        JSON.stringify({
          accountId: "default",
          deviceId: "web-device-42",
          deviceType: "WEB_PWA",
          signingPublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETESTSIGINGPUBKEY0000000000=",
          encryptionPublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETESTENCPUBKEY00000000000=",
          capabilities: ["MARK_READ", "READ_MESSAGES", "SEND_MESSAGES"],
          historyGrant: "FULL_HISTORY",
          trustSequence: 7,
          issuedAt: 1788300000000,
          expiresAt: 1791000000000,
          pairingTranscriptHash: "a".repeat(64),
          origin: "https://messages.example.com",
        }),
        "utf8",
      ),
    )
    .digest("hex"),
};

describe("ADR-007 shared serialization vectors (Android ↔ Web)", () => {
  test("canonical serialization matches the fixture byte-for-byte", () => {
    const { rootSignature, ...rest } = VECTOR.certificate;
    assert.equal(canonicalCertificate(rest), VECTOR.expectedCanonical);
  });

  test("canonical SHA-256 matches the fixture", () => {
    const { rootSignature, ...rest } = VECTOR.certificate;
    const hash = crypto.createHash("sha256").update(Buffer.from(canonicalCertificate(rest), "utf8")).digest("hex");
    assert.equal(hash, VECTOR.expectedSha256);
  });

  test("ECDSA verification over the vector signature = true", async () => {
    // Generate a stand-in Trust Root key and sign the canonical bytes the
    // same way Android does (SHA256withECDSA over UTF-8 canonical JSON).
    const { rootSignature, ...rest } = VECTOR.certificate;
    const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const sig = crypto
      .sign("sha256", Buffer.from(canonicalCertificate(rest), "utf8"), pair.privateKey)
      .toString("base64");
    const spki = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const ok = await verifyRootSignature({ ...VECTOR.certificate, rootSignature: sig }, spki);
    assert.equal(ok, true);
  });

  // ── tampered variants: every one must REJECT ────────────────────────────

  async function verifyWithTamper(mutate) {
    const { rootSignature, ...rest } = VECTOR.certificate;
    const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const sig = crypto
      .sign("sha256", Buffer.from(canonicalCertificate(rest), "utf8"), pair.privateKey)
      .toString("base64");
    const tampered = { ...VECTOR.certificate, rootSignature: sig };
    mutate(tampered);
    const spki = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    return verifyRootSignature(tampered, spki);
  }

  test("tampered deviceId → reject", async () => {
    assert.equal(await verifyWithTamper((c) => { c.deviceId = "web-device-43"; }), false);
  });

  test("tampered web public key → reject", async () => {
    assert.equal(await verifyWithTamper((c) => { c.signingPublicKey = "EVIL"; }), false);
  });

  test("tampered origin → reject", async () => {
    assert.equal(await verifyWithTamper((c) => { c.origin = "https://evil.example.com"; }), false);
  });

  test("tampered transcript hash → reject", async () => {
    assert.equal(await verifyWithTamper((c) => { c.pairingTranscriptHash = "b".repeat(64); }), false);
  });

  test("tampered capability → reject", async () => {
    assert.equal(await verifyWithTamper((c) => { c.capabilities = ["READ_MESSAGES"]; }), false);
  });

  test("expired certificate → reject", async () => {
    assert.equal(await verifyWithTamper((c) => { c.expiresAt = Date.now() - 1000; }), false);
  });

  test("invalid signature → reject", async () => {
    const spki = crypto
      .generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    const ok = await verifyRootSignature(
      { ...VECTOR.certificate, rootSignature: crypto.randomBytes(64).toString("base64") },
      spki,
    );
    assert.equal(ok, false);
  });
});
