"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyP256 } = require("../src/pairingRoutes");

test("server verifies the IEEE-P1363 signature emitted by WebCrypto", async () => {
  const keys = await crypto.webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const payload = Buffer.from("GMweb-Link-Session-v1\nweb-device\nchallenge\nhttps://gmweb.example\n1");
  const signature = Buffer.from(await crypto.webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    payload,
  ));
  const publicKey = Buffer.from(await crypto.webcrypto.subtle.exportKey("raw", keys.publicKey));

  assert.equal(signature.length, 64, "test must exercise browser P1363 format");
  assert.equal(verifyP256(payload, signature.toString("base64"), publicKey.toString("base64")), true);
});

test("web verifier accepts the DER signature emitted by Android/Java", async () => {
  const { canonicalCertificate, verifyRootSignature } = await import("../web/src/lib/trustRoot.ts");
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const certificate = {
    accountId: "default",
    deviceId: "web-device",
    deviceType: "WEB_PWA",
    signingPublicKey: "web-signing-key",
    encryptionPublicKey: "web-encryption-key",
    capabilities: ["SEND_MESSAGES", "READ_MESSAGES"],
    historyGrant: "FULL_HISTORY",
    trustSequence: 1,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    pairingTranscriptHash: "a".repeat(64),
    origin: "https://gmweb.example",
    rootSignature: "",
  };
  certificate.rootSignature = crypto.sign(
    "sha256",
    Buffer.from(canonicalCertificate(certificate), "utf8"),
    keys.privateKey,
  ).toString("base64");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

  assert.equal(await verifyRootSignature(certificate, publicKey), true);
});
