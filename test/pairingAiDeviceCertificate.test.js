"use strict";

// XR-GA-008 / LDV-002 — AI_AGENT device certificate + registry + command policy.
//
// The certificate canonical encoding is UNCHANGED: these tests re-derive the
// canonical bytes and verify an ECDSA signature over them, exactly like the
// approve route does. Only the policy layer (device_type_policy) is new.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Fastify = require("fastify");
const Database = require("better-sqlite3");

const pairing = require("../src/pairingSessions");
require("../src/pairingDb").configure(new Database(":memory:"));
const linkedSessions = require("../src/linkedSessions");
const { CommandEngine } = require("../src/commandEngine");
const { TrustRegistry } = require("../src/trustRegistry");
const { EventStore } = require("../src/eventStore");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");
const {
  AI_CAPABILITIES,
  AI_AGENT,
  WEB_PWA,
  certificateFailureReport,
  certificateValidationReason,
  validateCertificate,
  requiredCapabilitiesFor,
} = require("../src/pairingCertificate");
const { verifyP256 } = require("../src/pairingRoutes");
const { AI_FORBIDDEN_COMMAND_TYPES } = require("../src/devicePolicy");
const { canonicalCertificate } = require("../shared/pairingProtocol.mjs");

const AI_REQUIRED = Object.freeze(["READ_MESSAGES", "AI_SUGGEST"]);
const AI_FORBIDDEN = Object.freeze([
  "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS", "CONTACTS_READ", "READ_OTP",
  "READ_BANK_SECURITY", "READ_PASSWORD_RESET", "READ_AUTH_CODES",
  "READ_FINANCIAL_NOTIFICATIONS", "MANAGE_DEVICES",
]);

function fixture({
  deviceType = AI_AGENT,
  capabilities = [...AI_REQUIRED],
  historyGrant = "FROM_NOW_ON",
} = {}) {
  pairing._reset();
  const created = pairing.createSession({
    webDeviceId: deviceType === AI_AGENT ? "ai-device-1" : "android-compatible-web",
    webSigningPublicKey: "signing-key",
    webEncryptionPublicKey: "encryption-key",
    ephemeralPublicKey: "ephemeral-key",
    nonce: "nonce",
    deviceType,
  }, { ip: "127.0.0.1", origin: "https://web.example", apiOrigin: "https://api.example" });
  const session = pairing.getSession(created.pairingSessionId);
  const certificate = {
    protocol: session.protocol, accountId: "default", deviceId: session.webDeviceId,
    deviceType, signingPublicKey: session.webSigningPublicKey,
    encryptionPublicKey: session.webEncryptionPublicKey,
    capabilities,
    historyGrant, trustSequence: 1, issuedAt: Date.now(),
    expiresAt: Date.now() + 86400000, pairingTranscriptHash: session.transcriptHash,
    pairingSessionId: session.pairingSessionId, apiOrigin: session.apiOrigin, webOrigin: session.webOrigin,
  };
  return { session, certificate };
}

describe("AI_AGENT certificate policy", () => {
  test("valid AI_AGENT certificate with exactly READ_MESSAGES + AI_SUGGEST is accepted", () => {
    const { session, certificate } = fixture();
    assert.equal(validateCertificate(certificate, session), true);
    assert.equal(certificateFailureReport(certificate, session), null);
    assert.deepEqual(requiredCapabilitiesFor(AI_AGENT), AI_REQUIRED);
    assert.deepEqual(AI_CAPABILITIES, ["AI_SUGGEST"]);

    // Canonical encoding is untouched: sign the exact bytes the approve route
    // signs, then verify them with the same P-256 verifier.
    const bytes = Buffer.from(canonicalCertificate(certificate), "utf8");
    assert.match(bytes.toString("utf8"), /^GMweb-Pairing-v1:certificate\n/);
    const root = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    certificate.rootSignature = crypto.sign("sha256", bytes, root.privateKey).toString("base64");
    const publicKey = root.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    assert.equal(verifyP256(bytes, certificate.rootSignature, publicKey), true);
    // Same bytes on re-validation: the policy layer adds no encoding.
    assert.equal(validateCertificate(certificate, session), true);
  });

  test("AI_AGENT without AI_SUGGEST is rejected", () => {
    const { session, certificate } = fixture({ capabilities: ["READ_MESSAGES"] });
    assert.equal(certificateValidationReason(certificate, session), "certificate_capability_invalid");
    const report = certificateFailureReport(certificate, session);
    assert.equal(report.meta.predicate, "missing_required_capability");
    assert.match(JSON.stringify(report.meta), /AI_SUGGEST/);
  });

  test("AI_AGENT without READ_MESSAGES is rejected", () => {
    const { session, certificate } = fixture({ capabilities: ["AI_SUGGEST"] });
    assert.equal(certificateValidationReason(certificate, session), "certificate_capability_invalid");
    assert.match(JSON.stringify(certificateFailureReport(certificate, session).meta), /READ_MESSAGES/);
  });

  test("AI_AGENT rejects every forbidden/sensitive capability", () => {
    assert.deepEqual(AI_FORBIDDEN, [
      "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS", "CONTACTS_READ", "READ_OTP",
      "READ_BANK_SECURITY", "READ_PASSWORD_RESET", "READ_AUTH_CODES",
      "READ_FINANCIAL_NOTIFICATIONS", "MANAGE_DEVICES",
    ]);
    for (const forbidden of AI_FORBIDDEN) {
      const { session, certificate } = fixture({ capabilities: [...AI_REQUIRED, forbidden] });
      assert.equal(certificateValidationReason(certificate, session), "certificate_capability_invalid",
        `${forbidden} must be rejected for AI_AGENT`);
      const report = certificateFailureReport(certificate, session);
      assert.equal(report.meta.predicate, "forbidden_capability");
      assert.match(JSON.stringify(report.meta), new RegExp(forbidden));
    }
  });

  test("AI_AGENT with FULL_HISTORY is rejected; FROM_NOW_ON is the only grant", () => {
    const { session, certificate } = fixture({ historyGrant: "FULL_HISTORY" });
    assert.equal(certificateValidationReason(certificate, session), "certificate_history_grant_invalid");
    assert.equal(certificateFailureReport(certificate, session).meta.predicate, "history_grant");
  });

  test("unknown device type is rejected", () => {
    const { session, certificate } = fixture();
    certificate.deviceType = "ROBOT";
    assert.equal(certificateValidationReason(certificate, session), "certificate_device_type_invalid");
  });

  test("certificate device type must match the pairing session that was created", () => {
    const { session, certificate } = fixture(); // AI_AGENT session
    certificate.deviceType = WEB_PWA;
    certificate.capabilities = ["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS"];
    certificate.historyGrant = "FULL_HISTORY";
    assert.equal(certificateValidationReason(certificate, session), "certificate_device_type_mismatch");
  });

  test("WEB_PWA semantics are unchanged and AI_SUGGEST is forbidden there", () => {
    const { session, certificate } = fixture({
      deviceType: WEB_PWA,
      capabilities: ["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS"],
      historyGrant: "FULL_HISTORY",
    });
    assert.equal(validateCertificate(certificate, session), true);
    certificate.capabilities = [...certificate.capabilities, "AI_SUGGEST"];
    assert.equal(certificateValidationReason(certificate, session), "certificate_capability_invalid");
    assert.equal(certificateFailureReport(certificate, session).meta.predicate, "forbidden_capability");
  });
});

describe("device registry (linked_sessions) AI_AGENT policy", () => {
  test("AI_AGENT registers only with exactly READ_MESSAGES + AI_SUGGEST", () => {
    const token = linkedSessions.issue("ai-register-1", [...AI_REQUIRED], 1,
      Date.now() + 86400000, AI_AGENT);
    const session = linkedSessions.resolve(token);
    assert.equal(session.deviceType, AI_AGENT);
    assert.deepEqual([...session.capabilities].sort(), [...AI_REQUIRED].sort());
    linkedSessions.revokeDevice("ai-register-1");
  });

  test("registry refuses an AI device holding SEND_MESSAGES (and any other capability)", () => {
    const cases = [
      [...AI_REQUIRED, "SEND_MESSAGES"],
      [...AI_REQUIRED, "MARK_READ"],
      [...AI_REQUIRED, "MANAGE_DEVICES"],
      [...AI_REQUIRED, "READ_OTP"],
      ["READ_MESSAGES"], // AI_SUGGEST missing
      ["AI_SUGGEST"], // READ_MESSAGES missing
    ];
    for (const capabilities of cases) {
      assert.throws(
        () => linkedSessions.issue("ai-register-bad", capabilities, 1, Date.now() + 86400000, AI_AGENT),
        error => error.code === "device_registration_rejected" && error.statusCode === 403,
        `registration must fail closed for ${capabilities.join(",")}`,
      );
    }
    assert.equal(linkedSessions.resolve(
      linkedSessions.issue("ai-register-2", [...AI_REQUIRED], 1, Date.now() + 86400000, AI_AGENT),
    ).deviceId, "ai-register-2");
    linkedSessions.revokeDevice("ai-register-2");
  });

  test("registry rejects an unknown device kind", () => {
    assert.throws(
      () => linkedSessions.issue("robot-1", [...AI_REQUIRED], 1, Date.now() + 86400000, "ROBOT"),
      error => error.code === "device_registration_rejected",
    );
  });

  test("WEB_PWA registration keeps today's capability set and defaults to WEB_PWA", () => {
    const token = linkedSessions.issue("web-register-1",
      ["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS", "READ_OTP"]);
    const session = linkedSessions.resolve(token);
    assert.equal(session.deviceType, WEB_PWA);
    assert.ok(session.capabilities.includes("SEND_MESSAGES"));
    linkedSessions.revokeDevice("web-register-1");
  });
});

describe("command engine AI_AGENT policy", () => {
  const AI = { sourceDeviceType: AI_AGENT, sourceCapabilities: [...AI_REQUIRED] };
  const encrypt = () => Buffer.from("opaque-envelope-ciphertext");

  test("refuses SEND_SMS and legacy SEND_MESSAGES for an AI_AGENT device", () => {
    const engine = new CommandEngine(new Database(":memory:"));
    // The explicit send types are documented AND rejected by the allowlist.
    assert.deepEqual(AI_FORBIDDEN_COMMAND_TYPES, ["SEND_SMS", "SEND_MESSAGES"]);
    for (const type of ["SEND_SMS", "SEND_MESSAGES", "MARK_THREAD_READ", "FETCH_THREAD_HISTORY", "REFRESH_DEVICE_TELEMETRY"]) {
      assert.throws(() => engine.createCommand({
        accountId: "a", idempotencyKey: `ai-${type}`, type,
        ciphertext: encrypt(), targetAgentId: "phone", ...AI,
      }), error => error.code === "command_type_not_allowed_for_device" && error.statusCode === 403,
      `${type} must be refused for AI_AGENT`);
    }
    assert.deepEqual(engine.counts("a"), {}, "a refused AI command must never be persisted");
  });

  test("SUGGESTIONS_READY is accepted only while the device holds AI_SUGGEST", () => {
    const engine = new CommandEngine(new Database(":memory:"));
    assert.throws(() => engine.createCommand({
      accountId: "a", idempotencyKey: "ai-no-cap", type: "SUGGESTIONS_READY",
      ciphertext: encrypt(), targetAgentId: "phone",
      sourceDeviceType: AI_AGENT, sourceCapabilities: ["READ_MESSAGES"],
    }), error => error.code === "command_type_not_allowed_for_device");
    assert.throws(() => engine.createCommand({
      accountId: "a", idempotencyKey: "ai-null-cap", type: "SUGGESTIONS_READY",
      ciphertext: encrypt(), targetAgentId: "phone", sourceDeviceType: AI_AGENT,
    }), error => error.code === "command_type_not_allowed_for_device", "missing caps fail closed");
    const { created, command } = engine.createCommand({
      accountId: "a", idempotencyKey: "ai-suggest", type: "SUGGESTIONS_READY",
      ciphertext: encrypt(), targetAgentId: "phone", ...AI,
    });
    assert.equal(created, true);
    assert.equal(command.type, "SUGGESTIONS_READY");
    assert.equal(command.sourceClientId, null);
    assert.equal(engine.claimForAgent("phone")[0].ciphertext.equals(encrypt()), true);
    assert.equal(JSON.stringify(command).includes("opaque-envelope-ciphertext"), false,
      "payload must stay opaque (stored/client-visible as bytes, never parsed plaintext)");
  });

  test("WEB_PWA / legacy callers keep the existing command path", () => {
    const engine = new CommandEngine(new Database(":memory:"));
    assert.equal(engine.createCommand({
      accountId: "a", idempotencyKey: "web-send", type: "SEND_SMS",
      ciphertext: encrypt(), targetAgentId: "phone",
      sourceDeviceType: WEB_PWA,
      sourceCapabilities: ["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS"],
    }).created, true);
    assert.equal(engine.createCommand({
      accountId: "a", idempotencyKey: "legacy-send", type: "SEND_SMS",
      ciphertext: encrypt(), targetAgentId: "phone",
    }).created, true);
  });
});

describe("SUGGESTIONS_READY HTTP relay is AI-only and ciphertext-only", () => {
  let app;
  let db;
  let commandEngine;
  const envelope = {
    payload: Buffer.from(JSON.stringify({ v: 1, kind: "command", ciphertext: "AAAA" })).toString("base64"),
    encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1,
  };

  async function setup() {
    db = new Database(":memory:");
    require("../src/pairingDb").configure(db);
    commandEngine = new CommandEngine(db);
    app = Fastify({ logger: false });
    app.addHook("preHandler", (request, _reply, done) => {
      const kind = request.headers["x-test-device"];
      if (kind === "ai") request.linkedDevice = {
        deviceId: "ai-1", deviceType: AI_AGENT, capabilities: [...AI_REQUIRED],
      };
      else if (kind === "ai-no-cap") request.linkedDevice = {
        deviceId: "ai-2", deviceType: AI_AGENT, capabilities: ["READ_MESSAGES"],
      };
      else if (kind === "web") request.linkedDevice = {
        deviceId: "web-1", deviceType: WEB_PWA,
        capabilities: ["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS"],
      };
      done();
    });
    registerControlPlaneRoutes(app, {
      trustRegistry: new TrustRegistry(db),
      commandEngine,
      eventStore: new EventStore(db),
      accountId: "acct",
      linkedSessions,
      checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 1 }),
      authorizeAgent: () => null,
    });
    await app.ready();
  }

  test("SEND_SMS from an AI_AGENT device is 403 and persists nothing", async () => {
    await setup();
    try {
      const res = await app.inject({
        method: "POST", url: "/api/v1/commands",
        headers: { "x-test-device": "ai" },
        payload: { type: "SEND_SMS", idempotencyKey: "http-ai-send", ...envelope },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error, "command_type_not_allowed_for_device");
      assert.deepEqual(commandEngine.counts("acct"), {});
    } finally { await app.close(); db.close(); }
  });

  test("SUGGESTIONS_READY requires AI_AGENT + AI_SUGGEST and an encrypted envelope", async () => {
    await setup();
    try {
      const noCap = await app.inject({
        method: "POST", url: "/api/v1/commands",
        headers: { "x-test-device": "ai-no-cap" },
        payload: { type: "SUGGESTIONS_READY", idempotencyKey: "http-ai-nocap", ...envelope },
      });
      assert.equal(noCap.statusCode, 403);
      assert.equal(noCap.json().error, "command_type_not_allowed_for_device");

      const web = await app.inject({
        method: "POST", url: "/api/v1/commands",
        headers: { "x-test-device": "web" },
        payload: { type: "SUGGESTIONS_READY", idempotencyKey: "http-web-suggest", ...envelope },
      });
      assert.equal(web.statusCode, 403, "WEB_PWA must never create SUGGESTIONS_READY");
      assert.equal(web.json().error, "ai_suggest_capability_required");

      const plaintext = await app.inject({
        method: "POST", url: "/api/v1/commands",
        headers: { "x-test-device": "ai" },
        payload: { type: "SUGGESTIONS_READY", idempotencyKey: "http-ai-plain", payload: Buffer.from("plain").toString("base64") },
      });
      assert.equal(plaintext.statusCode, 400);
      assert.equal(plaintext.json().error, "encrypted_command_required");

      const ok = await app.inject({
        method: "POST", url: "/api/v1/commands",
        headers: { "x-test-device": "ai" },
        payload: { type: "SUGGESTIONS_READY", idempotencyKey: "http-ai-ok", targetAgentId: "phone", ...envelope },
      });
      assert.equal(ok.statusCode, 202, ok.payload);
      const { commandId } = ok.json();
      const stored = commandEngine.get(commandId);
      assert.equal(stored.type, "SUGGESTIONS_READY");
      assert.equal(stored.sourceClientId, "ai-1");
      assert.equal(stored.cryptoVersion, 1);
      // Server never parses or re-serialises the payload as plaintext.
      assert.equal(Buffer.isBuffer(stored.ciphertext), true);
    } finally { await app.close(); db.close(); }
  });
});
