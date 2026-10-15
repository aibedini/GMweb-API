"use strict";
// The command-key endpoint must declare the key format explicitly and refuse to
// serve a key it cannot vouch for. Byte-length guessing is what caused the
// production raw-vs-SPKI mismatch, so the format now travels with the key.
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const Fastify = require("fastify");
const { classifyPublicKey, toSpkiDer, SPKI_P256_LENGTH, RAW_P256_LENGTH } = require("../src/publicKeyFormat");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");
const { CommandEngine } = require("../src/commandEngine");
const { TrustRegistry } = require("../src/trustRegistry");
const sessions = require("../src/linkedSessions");
const { configure } = require("../src/pairingDb");

/** Node's EC export does not support raw points, so use WebCrypto, which is
 *  also exactly what the browser and Android use. */
async function keyPair(curve = "P-256") {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: curve }, true, ["deriveBits"]);
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey));
  const raw = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { spkiB64: spki.toString("base64"), rawB64: raw.toString("base64"), spki, raw };
}

test("classifyPublicKey detects both formats and rejects the rest", async () => {
  const { spkiB64, rawB64, spki, raw } = await keyPair();
  assert.equal(spki.length, SPKI_P256_LENGTH);
  assert.equal(raw.length, RAW_P256_LENGTH);

  assert.equal(classifyPublicKey(spkiB64).format, "spki-p256");
  assert.equal(classifyPublicKey(rawB64).format, "raw-p256");
  assert.equal(classifyPublicKey("").ok, false);
  assert.equal(classifyPublicKey(null).ok, false);
  assert.equal(classifyPublicKey(Buffer.from("nonsense").toString("base64")).error, "unrecognised_key_format");
  // A DER blob for another curve is not silently accepted.
  const p384 = await keyPair("P-384");
  assert.equal(classifyPublicKey(p384.spkiB64).error, "unsupported_der_spki");
  // A raw point of the wrong length.
  assert.equal(classifyPublicKey(Buffer.concat([Buffer.from([4]), raw.subarray(1, 30)]).toString("base64")).error,
    "invalid_point_length");
});

test("toSpkiDer wraps a raw point into a valid SPKI that Node accepts", async () => {
  const { raw, spkiB64 } = await keyPair();
  const wrapped = toSpkiDer(raw);
  assert.equal(wrapped.length, SPKI_P256_LENGTH);
  assert.equal(wrapped.toString("base64"), spkiB64, "identical to WebCrypto's own SPKI encoding");
});

function harness(encryptionKey) {
  const db = new Database(":memory:");
  configure(db);
  const app = Fastify({ logger: false });
  app.addHook("preHandler", (request, _reply, done) => {
    request.linkedDevice = sessions.resolve(request.headers["x-test-token"]);
    done();
  });
  registerControlPlaneRoutes(app, {
    commandEngine: new CommandEngine(db), trustRegistry: new TrustRegistry(db),
    eventStore: {}, accountId: "a", linkedSessions: sessions, authorizeAgent: () => null,
    agentAuthService: { getPrimaryIdentity: () => (encryptionKey === undefined
      ? { device_id: "phone" }
      : { device_id: "phone", encryption_public_key: encryptionKey }) },
  });
  return { app, db, token: sessions.issue("browser", ["SEND_MESSAGES"]) };
}

test("an SPKI identity is served as spki-p256, unchanged", async (t) => {
  const { spkiB64 } = await keyPair();
  const { app, db, token } = harness(spkiB64);
  t.after(async () => { await app.close(); db.close(); });
  const res = await app.inject({ url: "/api/v1/linked-device/command-key", headers: { "x-test-token": token } });
  assert.equal(res.statusCode, 200, res.payload);
  const body = res.json();
  assert.equal(body.encryptionPublicKeyFormat, "spki-p256");
  assert.equal(body.encryptionPublicKey, spkiB64, "served byte-for-byte as stored");
  assert.equal(body.deviceId, "phone");
});

test("a raw identity is served as raw-p256 (older enrolled devices)", async (t) => {
  const { rawB64 } = await keyPair();
  const { app, db, token } = harness(rawB64);
  t.after(async () => { await app.close(); db.close(); });
  const body = (await app.inject({ url: "/api/v1/linked-device/command-key",
    headers: { "x-test-token": token } })).json();
  assert.equal(body.encryptionPublicKeyFormat, "raw-p256");
  assert.equal(body.encryptionPublicKey, rawB64);
});

test("a missing key is 404, and a malformed key is 409 rather than served as valid", async (t) => {
  const missing = harness(undefined);
  t.after(async () => { await missing.app.close(); missing.db.close(); });
  const notFound = await missing.app.inject({ url: "/api/v1/linked-device/command-key",
    headers: { "x-test-token": missing.token } });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json().error, "primary_command_key_unavailable");

  // The placeholder the old test suite used: previously served as if valid.
  const malformed = harness("public-key");
  t.after(async () => { await malformed.app.close(); malformed.db.close(); });
  const invalid = await malformed.app.inject({ url: "/api/v1/linked-device/command-key",
    headers: { "x-test-token": malformed.token } });
  assert.equal(invalid.statusCode, 409);
  assert.equal(invalid.json().error, "invalid_primary_command_key");
  assert.equal(typeof invalid.json().reason, "string");
  assert.equal(invalid.json().encryptionPublicKey, undefined, "never serves the bad key");
});

test("the endpoint still enforces the command capability before anything else", async (t) => {
  const { spkiB64 } = await keyPair();
  const { app, db } = harness(spkiB64);
  t.after(async () => { await app.close(); db.close(); });
  const noCapability = sessions.issue("browser", ["READ_MESSAGES"]);
  const res = await app.inject({ url: "/api/v1/linked-device/command-key",
    headers: { "x-test-token": noCapability } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "command_capability_required");
});
