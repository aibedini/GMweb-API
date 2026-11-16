"use strict";

const {
  policy: eventCryptoPolicy,
  validateWireBatch,
  validateWireEvent,
  validateStoredBatch,
  MAX_BATCH_EVENTS,
  MAX_DECODED_BATCH_BYTES,
  MAX_HTTP_BODY_BYTES,
} = require("./eventCryptoPolicy");
const { ClaimWaiters, clampWaitMs } = require("./claimWaiters");
const { deviceCommandViolation, isAiDevice } = require("./devicePolicy");

const EVENT_TYPES = Object.keys({
  ...eventCryptoPolicy.contentBearing,
  ...eventCryptoPolicy.controlKey,
  ...eventCryptoPolicy.nonContentControl,
});
// XR-GA-008: SUGGESTIONS_READY is an AI-device command and must travel as an
// encrypted envelope exactly like every other linked-device write. Adding it
// here makes the route REQUIRE envelope.v1/schemaVersion 1/cryptoVersion 1 —
// an unencrypted suggestion command is rejected before persistence.
const ENCRYPTED_LINKED_COMMAND_TYPES = new Set(["SEND_SMS", "MARK_THREAD_READ", "REFRESH_DEVICE_TELEMETRY", "FETCH_THREAD_HISTORY", "SUGGESTIONS_READY"]);

// LDV-004 PR-D (§4.4.1): KEY_GRANT / KEYRING_ENTRY / HISTORY_KEY_GRANT /
// CONTACTS_KEY_GRANT carry account and conversation key material. The phone's
// rootSignature remains the end-to-end cryptographic authentication; this
// relay-side set is the AUTHORIZATION gate that stops any other authenticated
// agent (e.g. a LEGACY_AGENT or a linked browser) from publishing a control-key
// event into the account. It is applied after wire validation and before any
// ingestion.
const CONTROL_KEY_EVENT_TYPES = new Set(Object.keys(eventCryptoPolicy.controlKey));

/**
 * Summarize control-key events in a batch WITHOUT touching payloads.
 * @returns {{types: string[], count: number}|null} null when none are present.
 */
function controlKeyEventSummary(events) {
  const types = new Set();
  let count = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event && CONTROL_KEY_EVENT_TYPES.has(event.type)) {
      types.add(event.type);
      count += 1;
    }
  }
  return count > 0 ? { types: [...types], count } : null;
}

/**
 * Defensive validation of Android-advertised command capabilities (telemetry
 * path). Shared with the live runtime store so there is one implementation.
 *
 * These are FEATURE NEGOTIATION ONLY, never authorization: a linked browser
 * still needs its session, the command crypto and a valid target agent.
 */
function normalizeCommandTypes(value) {
  return require("./agentRuntime").normalizeCommandTypes(value);
}

/** Persist only the capability block, leaving the rest of the payload intact. */
function withNormalizedCapabilities(body) {
  if (!body || typeof body !== "object") return body;
  const types = normalizeCommandTypes(body.capabilities?.commandTypes);
  if (types === null) {
    // Older clients simply omit it; do not invent an empty capability set
    // (absent means "unsupported", which is the honest reading).
    const { capabilities, ...rest } = body;
    return rest;
  }
  return { ...body, capabilities: { ...body.capabilities, commandTypes: types } };
}
const SAFE_INGEST_ERROR_CODES = new Set(["invalid_event_id", "invalid_metadata", "invalid_payload_encoding",
  "invalid_encrypted_envelope", "unsupported_schema_version", "unsupported_crypto_version",
  "encrypted_payload_required", "event_payload_too_large"]);

/**
 * Phase 2 Control Plane routes (TechSpec §51–58, ADR-001/004) as a REGISTERED
 * MODULE — the modular-monolith boundary: server.js wires dependencies, this
 * file owns only route/schema/handler logic. Injectable dependencies keep the
 * whole surface testable without Redis/browser (fastify.inject).
 *
 * Trust Registry: GMweb relays Android-signed statements; clients verify
 * rootSignature locally. Commands: every write is a durable row BEFORE the
 * 202 (Rule 4); payload stays opaque (Phase 7 encryption, ADR-002).
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {object} deps { trustRegistry, commandEngine, eventStore, accountId, authorizeAgent }
 */
function registerControlPlaneRoutes(app, { trustRegistry, commandEngine, eventStore, accountId, authorizeAgent, linkedSessions, deviceTelemetryStore, agentActivityStore, agentRuntimeStore, derivePhonePresence, deriveTelemetryFreshness, agentAuthService, checkRateLimit, enableCommandLeases = false, claimWaiters = new ClaimWaiters() }) {
  // Held claim requests are resolved before Fastify completes shutdown; no
  // timer or promise outlives the app that owns it.
  app.addHook("onClose", async () => claimWaiters.shutdown());
  const b64 = (buf) => (buf ? Buffer.from(buf).toString("base64") : null);
  const replicationCapabilities = () => ({
    preferredProtocolVersion: 1,
    supportedProtocolVersions: [1],
    eventIngest: { maxBatchEvents: 100, perItemResults: true },
    snapshot: { stablePagination: true },
    keys: { deviceFiltered: true, independentFromEventCursor: true },
    commands: { durable: true, idempotent: true, leases: enableCommandLeases },
  });
  const capabilitiesSchema = {
    schema: {
      summary: "Implemented encrypted replication capabilities",
      description: "Reports active protocol behavior. V2 remains unavailable until its snapshot, ingest and command contracts are implemented.",
      tags: ["Sync"],
      response: { 200: { type: "object", additionalProperties: true },
        429: { type: "object", properties: { error: { type: "string" } } } },
    },
  };

  app.get("/api/v1/agent/replication-capabilities", capabilitiesSchema, async (request, reply) => {
    const rate = checkRateLimit(request, "agent-replication-capabilities", 60, 60_000);
    if (!rate.allowed) return reply.code(429).header("Retry-After", rate.retryAfterSeconds)
      .send({ error: "agent_rate_limit" });
    if (!authorizeAgent(request, request.rawBody || Buffer.alloc(0))) {
      return reply.code(401).send({ error: "agent_auth_required" });
    }
    reply.header("Cache-Control", "no-store");
    return replicationCapabilities();
  });

  app.get("/api/v1/linked-device/replication-capabilities", capabilitiesSchema, async (request, reply) => {
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    if (!request.linkedDevice.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "read_messages_capability_required" });
    }
    reply.header("Cache-Control", "no-store");
    return replicationCapabilities();
  });
  const applyStatement = statement => trustRegistry.db.transaction(() => {
    const result = trustRegistry.applyStatement({ accountId, statement });
    if (result.applied && statement.operation === "DEVICE_REVOKED") {
      // Observability (Phase 2) — grep in PM2/journalctl: `revocation_applied`.
      console.log(`[trustRegistry] revocation_applied deviceId=${statement.deviceId} sequence=${result.trustSequence}`);
      linkedSessions?.revokeDevice(statement.deviceId);
    }
    return result;
  }).immediate();


  // ── Trust Registry relay (ADR-001 LOCK 2/9) ──────────────────────────────
  // P0-4 (contract): the ANDROID-primary path is /api/v1/agent/trust/* —
  // the browser-facing /api/v1/trust/* stays GET-only (see requireToken).
  // The handler is shared; both paths demand the PRIMARY_TRUST_AGENT.
  const trustStatementSchema = {
    schema: {
      summary: "Android-signed trust statement (PRIMARY_TRUST_AGENT only)",
      description: "Android Trust Root posts DEVICE_APPROVED/DEVICE_REVOKED/etc statements with monotonic trustSequence. GMweb relays them; clients verify rootSignature locally. Monotonic per account, no gaps, idempotent redelivery.",
      tags: ["Trust"],
      body: { type: "object" },
      response: {
        200: { type: "object", properties: { ok: { type: "boolean" }, applied: { type: "boolean" }, trustSequence: { type: "integer" }, reason: { type: "string" } } },
        400: { type: "object", properties: { error: { type: "string" } } },
        409: { type: "object", additionalProperties: true },
      }
    }
  };

  app.get("/api/v1/agent/trust/position", {
    schema: { summary: "Primary-agent trust publication position", tags: ["Trust"],
      response: { 200: { type: "object", properties: {
        trustSequence: { type: "integer" },
        confirmedApprovals: { type: "array", items: { type: "object", properties: {
          trustSequence: { type: "integer" }, deviceId: { type: "string" },
        } } },
        pendingPairingSessionIds: { type: "array", items: { type: "string" } },
      } },
        429: { type: "object", properties: { error: { type: "string" } } } } },
  }, async (request, reply) => {
    const rate = checkRateLimit(request, "agent-trust-position", 60, 60_000);
    if (!rate.allowed) return reply.code(429).header("Retry-After", rate.retryAfterSeconds)
      .send({ error: "agent_rate_limit" });
    const agent = authorizeAgent(request, request.rawBody || Buffer.alloc(0));
    if (!agent || agent.role !== "PRIMARY_TRUST_AGENT") {
      return reply.code(403).send({ error: "primary_agent_required" });
    }
    reply.header("Cache-Control", "no-store");
    // These are server-side pairing receipts, not authorization by themselves.
    // The primary phone decides whether to publish its already signed statement.
    const db = trustRegistry.db;
    const now = Date.now();
    const confirmed = new Map();
    const pendingPairingSessionIds = [];
    const certificateApproval = (certificate, deviceId) => {
      try {
        const parsed = JSON.parse(certificate);
        const sequence = Number(parsed.trustSequence);
        if (parsed.accountId === accountId && parsed.deviceId === deviceId &&
            Number.isSafeInteger(sequence) && sequence > 0) {
          confirmed.set(`${sequence}:${deviceId}`, { trustSequence: sequence, deviceId });
        }
      } catch { /* expired or malformed evidence is never confirmation */ }
    };
    for (const row of db.prepare("SELECT id, payload FROM pairing_sessions WHERE expires_at > ? LIMIT 128").all(now)) {
      const session = JSON.parse(row.payload);
      if (session.state === "PENDING") pendingPairingSessionIds.push(row.id);
      if (session.state === "APPROVED" && session.approved)
        certificateApproval(session.approved.certificate, session.approved.deviceId);
    }
    for (const row of db.prepare("SELECT device_id, payload FROM pairing_challenges WHERE expires_at > ? LIMIT 128").all(now)) {
      const challenge = JSON.parse(row.payload);
      certificateApproval(challenge.certificate, row.device_id);
    }
    for (const row of db.prepare("SELECT device_id, payload FROM linked_sessions WHERE expires_at > ? LIMIT 128").all(now)) {
      const session = JSON.parse(row.payload);
      const sequence = Number(session.trustSequence);
      if (session.deviceId === row.device_id && Number.isSafeInteger(sequence) && sequence > 0)
        confirmed.set(`${sequence}:${row.device_id}`, { trustSequence: sequence, deviceId: row.device_id });
    }
    return { trustSequence: trustRegistry.currentSequence(accountId),
      confirmedApprovals: [...confirmed.values()], pendingPairingSessionIds };
  });

  app.post("/api/v1/agent/trust/statements", trustStatementSchema, async (request, reply) => {
    const statement = request.body?.statement || request.body;
    const agent = authorizeAgent(request, request.rawBody || Buffer.alloc(0));
    if (!agent || agent.role !== "PRIMARY_TRUST_AGENT") {
      console.warn("TRUST_STATEMENT_REJECTED", {
        reason: agent ? "role_mismatch" : "agent_not_authenticated",
        deviceId: agent?.deviceId ? `${agent.deviceId.slice(0, 8)}…` : null,
        role: agent?.role || null,
      });
      reply.code(403).send({
        error: "trust_write_forbidden",
        reason: agent ? "primary_agent_required" : "agent_not_authenticated",
      });
      return;
    }
    if (!statement.rootSignature || !statement.statementId) {
      reply.code(400).send({ error: "missing_rootSignature_or_statementId" });
      return;
    }
    const result = applyStatement(statement);
    if (!result.applied && result.reason !== "duplicate") return reply.code(409).send({ ok: false, ...result });
    return { ok: true, ...result };
  });

  app.post("/api/v1/trust/statements", {
    schema: {
      summary: "Relay an Android-signed trust statement (ADR-001)",
      description: "Android Trust Root posts DEVICE_APPROVED/DEVICE_REVOKED/etc statements with monotonic trustSequence. GMweb relays them; clients verify rootSignature locally. Monotonic per account, no gaps, idempotent redelivery.",
      tags: ["Trust"],
      body: { type: "object" },
      response: {
        200: { type: "object", properties: { ok: { type: "boolean" }, applied: { type: "boolean" }, trustSequence: { type: "integer" }, reason: { type: "string" } } },
        400: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  }, async (request, reply) => {
    // SECURITY (review): trust writes are ANDROID-PRIMARY-ONLY. The linked
    // browser (READ_MESSAGES) is auth'd for GET /trust/* — it must never be
    // able to POST a statement, even though rootSignature is what actually
    // protects the registry (defense in depth: authorization AND crypto).
    const agent = authorizeAgent(request);
    if (!agent || agent.role !== "PRIMARY_TRUST_AGENT") {
      reply.code(403).send({ error: "trust writes require the authenticated PRIMARY_TRUST_AGENT" });
      return;
    }
    const statement = request.body?.statement || request.body;
    // NOTE: statement.deviceId is the SUBJECT device (e.g. the web browser
    // being approved) — the AUTHOR is always the authenticated Trust Root
    // agent (checked above). rootSignature provides cryptographic binding;
    // web clients verify it independently before trusting.
    const result = applyStatement(statement);
    if (!result.applied && result.reason !== "duplicate") return reply.code(409).send({ ok: false, ...result });
    return { ok: true, ...result };
  });

  app.get("/api/v1/trust/snapshot", {
    schema: {
      summary: "Latest Android-signed trust snapshot (ADR-001 LOCK 9)",
      description: "rootPublicKey + trustSequence + active DeviceCertificates + revocations. Every client verifies signatures locally; no key is trusted merely because GMweb returned it.",
      tags: ["Trust"],
      response: {
        200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  }, async (request, reply) => {
    const primary = agentAuthService?.getPrimaryIdentity?.();
    const snap = trustRegistry.getSnapshot(accountId) ||
      trustRegistry.getStatementSnapshot(accountId, primary?.trust_root_public_key);
    if (!snap) { reply.code(404).send({ error: "no_trust_snapshot" }); return; }
    return snap;
  });

  app.get("/api/v1/trust/statements", {
    schema: {
      summary: "Signed trust statements after a cursor",
      tags: ["Trust"],
      querystring: {
        type: "object",
        properties: { after: { type: "integer", minimum: 0, default: 0 } }
      }
    }
  }, async (request) => {
    const after = Math.max(0, Number(request.query?.after) || 0);
    return { statements: trustRegistry.statementsAfter(accountId, after) };
  });

  // Diagnostic: which linked devices have been revoked (DEVICE_REVOKED).
  // Auth matrix: this is a GET under /api/v1/trust/* — reachable by an
  // authenticated linked-session cookie (READ_MESSAGES) or a master token.
  app.get("/api/v1/trust/revoked-devices", {
    schema: {
      summary: "Revoked linked devices (diagnostic, ADR-001 relayed state)",
      description: "Lists every stored DEVICE_REVOKED trust statement for the account. GMweb only relays; clients verify rootSignature themselves.",
      tags: ["Trust"],
      response: {
        200: {
          type: "object",
          properties: {
            revoked: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  deviceId: { type: ["string", "null"] },
                  trustSequence: { type: "integer" },
                  revokedAt: { type: "integer" },
                  reason: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  }, async () => ({ revoked: trustRegistry.revokedDevices(accountId) }));

  app.post("/api/v1/agent/device-telemetry", {
    schema: {
      summary: "Receive Android device health telemetry",
      tags: ["Agent"],
      body: { type: "object", required: ["deviceId", "timestamp"], additionalProperties: true,
        properties: { deviceId: { type: "string", maxLength: 128 }, timestamp: { type: "integer" } } },
    },
  }, async (request, reply) => {
    const agent = authorizeAgent(request, request.rawBody || Buffer.alloc(0));
    if (!agent) return reply.code(401).send({ error: "agent_auth_required" });
    if (request.body.deviceId !== agent.deviceId) return reply.code(403).send({ error: "device_id_mismatch" });
    if (!deviceTelemetryStore) return reply.code(503).send({ error: "telemetry_unavailable" });
    deviceTelemetryStore.upsert(withNormalizedCapabilities(request.body), agent.role);
    return { ok: true };
  });

  app.get("/admin/device-telemetry", {
    schema: { summary: "Latest Android fleet telemetry", tags: ["Admin"] },
  }, async () => ({ devices: deviceTelemetryStore?.getAll() || [] }));

  app.get("/admin/sms-capabilities", {
    schema: { summary: "Current Primary SIM capabilities; unknown permissions remain null", tags: ["Admin"] },
  }, async () => {
    const primary = agentAuthService?.getPrimaryIdentity();
    const telemetry = primary ? deviceTelemetryStore?.get(primary.device_id) : null;
    return require("./smsCapabilities").smsCapabilities(telemetry);
  });

  app.get("/api/v1/admin/sync-stats", {
    schema: { summary: "Encrypted sync and device queue statistics", tags: ["Admin"] },
  }, async () => {
    const primary = deviceTelemetryStore?.getPrimary() || null;
    return {
      ...eventStore.stats(accountId),
      pendingTrustStatements: primary?.sync?.trustOutboxDepth ?? null,
      deadLetterCount: primary?.sync?.deadLetterCount ?? null,
      linkedSessions: linkedSessions?.telemetry() || [],
    };
  });

  app.get("/api/v1/linked-device/telemetry", {
    schema: { summary: "Latest Primary Android telemetry", tags: ["Trust"] },
  }, async (request, reply) => {
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    const primary = agentAuthService?.getPrimaryIdentity();
    return { telemetry: primary ? deviceTelemetryStore?.get(primary.device_id) || null
      : deviceTelemetryStore?.getPrimary() || null };
  });

  /**
   * Canonical, honest Android status: PHONE LIVENESS and TELEMETRY FRESHNESS are
   * reported as two independent axes.
   *
   * This exists because deriving presence from telemetry `receivedAt` produced a
   * production false "Phone Offline · last seen 2 days ago" while the phone was
   * authenticating command polls every few seconds. Liveness comes from
   * server-observed authenticated activity only.
   */
  app.get("/api/v1/linked-device/status", {
    schema: { summary: "Primary Android liveness and telemetry freshness", tags: ["Trust"] },
  }, async (request, reply) => {
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    const now = Date.now();
    const primary = agentAuthService?.getPrimaryIdentity?.() || null;
    const deviceId = primary?.device_id || null;
    const activity = deviceId ? agentActivityStore?.get(deviceId) || null : null;
    const telemetry = deviceId ? deviceTelemetryStore?.get(deviceId) || null
      : deviceTelemetryStore?.getPrimary() || null;

    const phoneState = derivePhonePresence
      ? derivePhonePresence(activity?.lastActivityAt ?? null, now)
      : "NEVER_SEEN";
    const telemetryState = deriveTelemetryFreshness
      ? deriveTelemetryFreshness(telemetry?.receivedAt ?? null, now)
      : "NEVER_REPORTED";

    // Live runtime metadata comes from the authenticated command poll, never
    // from telemetry. See src/agentRuntime.js.
    const runtime = deviceId ? agentRuntimeStore?.get(deviceId) || null : null;

    // `phone.appVersion` is retained for older clients but is explicitly a
    // DERIVED value, and says whether it fell back to a stale telemetry row.
    const appVersionName = runtime?.appVersionName ?? telemetry?.app?.versionName ?? null;
    const appVersionSource = runtime?.appVersionName ? "RUNTIME"
      : telemetry?.app?.versionName ? "TELEMETRY_FALLBACK" : null;

    return {
      phone: {
        state: phoneState,
        lastActivityAt: activity?.lastActivityAt ?? null,
        lastActivitySource: activity?.lastSource ?? null,
        ageMs: activity?.lastActivityAt ? Math.max(0, now - activity.lastActivityAt) : null,
        // Deprecated: use `runtime`. True when this is a stale telemetry value.
        appVersion: appVersionName,
        appVersionSource,
        appVersionIsFallback: appVersionSource === "TELEMETRY_FALLBACK",
        // Safe device facts only; never SIM identifiers or phone numbers.
        model: telemetry?.device?.model ?? null,
        manufacturer: telemetry?.device?.manufacturer ?? null,
        androidVersion: telemetry?.device?.androidVersion ?? null,
      },
      runtime: {
        appVersionName: runtime?.appVersionName ?? null,
        appVersionCode: runtime?.appVersionCode ?? null,
        protocolVersion: runtime?.protocolVersion ?? null,
        commandTypes: runtime?.commandTypes ?? [],
        receivedAt: runtime?.receivedAt ?? null,
        source: runtime?.source ?? null,
        ageMs: runtime?.receivedAt ? Math.max(0, now - runtime.receivedAt) : null,
      },
      telemetry: {
        state: telemetryState,
        receivedAt: telemetry?.receivedAt ?? null,
        ageMs: telemetry?.receivedAt ? Math.max(0, now - telemetry.receivedAt) : null,
        // Diagnostic only: the phone's clock offset, which NEVER affects state.
        clockSkewMs: telemetry?.clockSkewMs ?? null,
        // The version the last telemetry row carried. Historical, not current.
        reportedAppVersion: telemetry?.app?.versionName ?? null,
      },
      now,
    };
  });

  app.delete("/api/v1/linked-session", {
    schema: { summary: "Sign out and unlink this browser's server sessions", tags: ["Pairing"],
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } } },
  }, async (request, reply) => {
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    linkedSessions.revokeDevice(request.linkedDevice.deviceId);
    reply.clearCookie(linkedSessions.COOKIE_NAME, { path: "/" });
    reply.header("Cache-Control", "no-store");
    return { ok: true };
  });

  app.get("/api/v1/linked-device/sessions", {
    schema: { summary: "Presence of linked browser sessions", tags: ["Trust"],
      response: { 200: { type: "object", additionalProperties: true } } },
  }, async (request, reply) => {
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    if (!request.linkedDevice.capabilities?.includes("READ_MESSAGES"))
      return reply.code(403).send({ error: "read_messages_capability_required" });
    const ack = eventStore?.db?.prepare(`SELECT updated_at AS lastSyncAt, last_acked_sequence AS lastAckedSequence
      FROM linked_client_sync_state WHERE account_id = ? AND linked_device_id = ?`);
    return { sessions: (linkedSessions?.presence() || []).map(row => ({
      deviceId: row.deviceId, ip: row.ip || null, userAgent: row.userAgent || null,
      lastSeenAt: row.lastSeenAt, lastDataAt: row.lastDataAt || null,
      lastSyncAt: ack?.get(accountId, row.deviceId)?.lastSyncAt || null,
      onlineNow: row.onlineNow,
    })) };
  });

  app.get("/api/v1/linked-device/command-key", {
    schema: { summary: "Primary Android command encryption public key", tags: ["Commands"] },
  }, async (request, reply) => {
    // SUGGESTIONS_READY (XR-GA-008) is encrypted to this same primary command
    // key, so an AI device holding AI_SUGGEST may read it too. It still cannot
    // send SMS: the command route only allows SUGGESTIONS_READY for AI_AGENT.
    if (!request.linkedDevice?.capabilities?.some(cap => ["SEND_MESSAGES", "MARK_READ", "AI_SUGGEST"].includes(cap))) {
      return reply.code(403).send({ error: "command_capability_required" });
    }
    const identity = agentAuthService?.getPrimaryIdentity();
    if (!identity?.encryption_public_key) return reply.code(404).send({ error: "primary_command_key_unavailable" });
    // The format travels with the key so the client never has to guess from
    // byte length. An unusable stored key is reported, never served as valid.
    const classified = require("./publicKeyFormat").classifyPublicKey(identity.encryption_public_key);
    if (!classified.ok) {
      return reply.code(409).send({ error: "invalid_primary_command_key", reason: classified.error });
    }
    return {
      deviceId: identity.device_id,
      encryptionPublicKey: identity.encryption_public_key,
      encryptionPublicKeyFormat: classified.format,
    };
  });

  // ── POST-PAIR: linked-device presence telemetry (Android-authenticated) ──
  // SERVER OBSERVATIONS only — Android merges with its local signed trust
  // state; GMweb is never the trust authority.
  app.get("/api/v1/agent/linked-devices", {
    schema: {
      summary: "Linked-device session telemetry (server observations)",
      tags: ["Trust"],
      response: { 200: { type: "object", additionalProperties: true } }
    }
  }, async (request, reply) => {
    const agent = authorizeAgent(request);
    if (!agent) {
      reply.code(401).send({ error: "agent signature required" });
      return;
    }
    const devices = linkedSessions.telemetry();
    return { devices };
  });

  // ── Commands (Rule 4: durable before 202) ────────────────────────────────

  app.post("/api/v1/commands", {
    schema: {
      summary: "Create a durable command (TechSpec §56)",
      description: [
        "Every client write (send/mark-read/…) is a command row committed before the 202 returns.",
        "Idempotent by (account, idempotencyKey): a redelivered key returns the ORIGINAL command with created=false.",
        "payload (base64) stays opaque to GMweb (encrypted in Phase 7; ADR-002).",
        "No endpoint ever claims SENT/DELIVERED — carrier truth comes from Android evidence (Rule 1)."
      ].join("\n"),
      tags: ["Commands"],
      body: {
        type: "object",
        required: ["type", "payload"],
        properties: {
          type: { type: "string", examples: ["SEND_SMS", "MARK_THREAD_READ", "REFRESH_DEVICE_TELEMETRY"] },
          payload: { type: "string", description: "base64-encoded opaque payload bytes" },
          encoding: { type: "string", default: "application/json" },
          schemaVersion: { type: "integer", default: 1 },
          cryptoVersion: { type: "integer", default: 0 },
          idempotencyKey: { type: "string", description: "client UUID; REQUIRED by real clients" },
          targetAgentId: { type: "string", nullable: true },
          clientSignature: { type: "string", nullable: true, description: "base64; verified by Android (PR-08)" },
          expiresAt: { type: "integer", nullable: true }
        }
      },
      response: {
        202: {
          type: "object",
          properties: { commandId: { type: "string" }, state: { type: "string" }, created: { type: "boolean" } }
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        409: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  }, async (request, reply) => {
    const body = request.body || {};
    const linked = request.linkedDevice || null;
    const commandType = String(body.type);
    // XR-GA-008 / LDV-002: the linked-device registry profile is authoritative,
    // never the request body. An AI_AGENT may only create SUGGESTIONS_READY and
    // must hold AI_SUGGEST; SEND_SMS, legacy SEND_MESSAGES and every other type
    // are refused here AND again in the command engine (fail closed, 403).
    if (linked) {
      const policyViolation = deviceCommandViolation({
        deviceType: linked.deviceType, capabilities: linked.capabilities, type: commandType,
      });
      if (policyViolation) {
        return reply.code(403).send({ error: "command_type_not_allowed_for_device" });
      }
      if (commandType === "SUGGESTIONS_READY" &&
          (!isAiDevice(linked.deviceType) || !linked.capabilities?.includes("AI_SUGGEST"))) {
        return reply.code(403).send({ error: "ai_suggest_capability_required" });
      }
    }
    if (linked && body.type === "MARK_THREAD_READ" &&
        !linked.capabilities?.includes("MARK_READ")) {
      return reply.code(403).send({ error: "mark_read_capability_required" });
    }
    if (linked && body.type === "SEND_SMS" &&
        !linked.capabilities?.includes("SEND_MESSAGES")) {
      return reply.code(403).send({ error: "send_messages_capability_required" });
    }
    // Fetching older provider history READS message content from the phone, so it
    // is gated by the same READ_MESSAGES capability as reading history. The
    // payload is opaque encrypted data: the server never learns the phone
    // number, the branded sender, the Android thread id or the SMS body.
    if (linked && body.type === "FETCH_THREAD_HISTORY" &&
        !linked.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "read_messages_capability_required" });
    }
    // Refreshing device telemetry reads device/SIM state, so it needs the same
    // capability that already gates reading that state. A linked browser may
    // refresh exactly what it is allowed to read.
    if (linked && body.type === "REFRESH_DEVICE_TELEMETRY" &&
        !linked.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "read_messages_capability_required" });
    }
    if (linked && ENCRYPTED_LINKED_COMMAND_TYPES.has(String(body.type))) {
      if (Number(body.cryptoVersion) !== 1 || body.encoding !== "envelope.v1" || Number(body.schemaVersion) !== 1) {
        return reply.code(400).send({ error: "encrypted_command_required" });
      }
    }
    if (linked && body.type === "SEND_SMS") {
      const limit = checkRateLimit(request, `linked-send:${linked.deviceId}`, 10, 60_000);
      if (!limit.allowed) return reply.code(429).send({ error: "send_rate_limit", retryAfterSeconds: limit.retryAfterSeconds });
    }
    let payload = null;
    try {
      payload = Buffer.from(String(body.payload || ""), "base64");
    } catch {
      reply.code(400).send({ error: "payload must be base64" });
      return;
    }
    if (payload.length === 0) {
      reply.code(400).send({ error: "payload is required" });
      return;
    }
    try {
      const { created, command } = commandEngine.createCommand({
        accountId,
        idempotencyKey: String(body.idempotencyKey || ""),
        type: commandType,
        ciphertext: payload,
        encoding: body.encoding,
        schemaVersion: body.schemaVersion,
        cryptoVersion: body.cryptoVersion,
        targetAgentId: body.targetAgentId ?? null,
        sourceClientId: linked?.deviceId ?? body.sourceClientId ?? null,
        sourceDeviceType: linked?.deviceType ?? null,
        sourceCapabilities: linked?.capabilities ?? null,
        clientSignature: body.clientSignature
          ? Buffer.from(String(body.clientSignature), "base64")
          : null,
        expiresAt: body.expiresAt ?? undefined,
      });
      if (linked && command.sourceClientId !== linked.deviceId) {
        return reply.code(409).send({ error: "idempotency_owner_mismatch" });
      }
      // Only a fresh row can wake a waiter; an idempotent replay (created
      // false) must not produce a second empty wake-up.
      if (created) claimWaiters.notify(command.targetAgentId);
      if (command.type === "MARK_THREAD_READ") request._readAudit = {
        action: "read_requested", commandId: command.id, readerDeviceId: command.sourceClientId,
        targetAgentId: command.targetAgentId, state: command.state, created,
      };
      reply.code(202).send({ commandId: command.id, state: command.state, created });
    } catch (error) {
      if (error.code === "idempotency_key_reused") return reply.code(409).send({ error: error.message });
      if (error.code === "command_type_not_allowed_for_device") {
        return reply.code(403).send({ error: error.code });
      }
      reply.code(400).send({ error: error.message });
    }
  });

  app.get("/api/v1/commands/:id", {
    schema: {
      summary: "Command status (lifecycle per §41)",
      tags: ["Commands"],
      response: { 200: { type: "object", additionalProperties: true }, 404: { type: "object", properties: { error: { type: "string" } } } }
    }
  }, async (request, reply) => {
    const command = commandEngine.get(String(request.params.id));
    if (!command) { reply.code(404).send({ error: "command_not_found" }); return; }
    if (request.linkedDevice && command.sourceClientId !== request.linkedDevice.deviceId) {
      return reply.code(404).send({ error: "command_not_found" });
    }
    return { ...command, ciphertext: b64(command.ciphertext), clientSignature: b64(command.clientSignature) };
  });

  app.get("/api/v1/commands", {
    schema: {
      summary: "Command queue depth by state (per-account counts)",
      tags: ["Commands"]
    }
  }, async () => ({ counts: commandEngine.counts(accountId) }));

  // ── Agent bridge v1 (§57/§58) — strategic Android transport ─────────────

  app.post("/api/v1/agent/commands/claim", {
    schema: {
      summary: "Android Agent claims queued commands (long-poll friendly)",
      description: "Atomically flips claimed rows QUEUED→DELIVERED_TO_AGENT. Optional query waitMs (0–25000) holds the request for an authenticated agent until a command is claimable. Payload stays opaque. Agent reports lifecycle via /status.",
      tags: ["Agent"],
      querystring: {
        type: "object",
        properties: {
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: 25000,
            description: "Optional long-poll wait in milliseconds. Values above 25000 are clamped; absent, 0, negative, fractional or non-numeric values are treated as absent. Ignored for unauthenticated callers."
          }
        }
      },
      body: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "device/agent identity (device-key auth until PR-08 mTLS)" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          // Optional, additive live runtime evidence. Older clients omit it.
          // Feature negotiation only — never authorization.
          runtime: {
            type: "object",
            description: "Live Android runtime metadata (app version, advertised command types)",
            additionalProperties: true,
            properties: {
              protocolVersion: { type: "integer" },
              appVersionName: { type: "string", maxLength: 64 },
              appVersionCode: { type: "integer", minimum: 0 },
              commandTypes: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 32 }
            }
          }
        }
      },
      response: { 200: { type: "object", properties: { commands: { type: "array", items: { type: "object", additionalProperties: true } } } } }
    },
    preValidation: (request, _reply, done) => {
      // Fastify's AJV would reject `?waitMs=abc` with 400, but the contract
      // says invalid values mean "do not wait". Normalise before validation
      // so the integer schema can still describe the parameter accurately.
      const waitMs = clampWaitMs(request.query?.waitMs);
      if (request.query) {
        if (waitMs > 0) request.query.waitMs = waitMs;
        else delete request.query.waitMs;
      }
      done();
    }
  }, async (request, reply) => {
    const agentId = String(request.body?.agentId || "android-agent");
    const limit = Math.max(1, Math.min(100, Number(request.body?.limit) || 25));

    // Runtime metadata is recorded only for an AgentAuth-authenticated request,
    // and is keyed by the AUTHENTICATED device id — never the body's claim.
    // This runs exactly once per request, before any wait.
    const authenticated = authorizeAgent(request, request.rawBody || Buffer.alloc(0));
    if (authenticated && request.body?.runtime) {
      agentRuntimeStore?.record(authenticated.deviceId, request.body.runtime, "COMMAND_POLL");
    }

    // The immediate path and every waiter wake use the SAME claim function.
    // The engine's conditional UPDATE remains the only delivery gate, so a
    // waiter cannot bypass at-most-once even when it races an immediate claim.
    const claim = () => commandEngine.claimForAgent(agentId, { limit }).map((c) => ({
      ...c,
      ciphertext: b64(c.ciphertext),
      clientSignature: b64(c.clientSignature),
    }));

    let commands = claim();
    if (commands.length > 0) return { commands };

    const waitMs = clampWaitMs(request.query?.waitMs);
    if (!authenticated || waitMs <= 0) return { commands };
    // The client may already be gone between the first claim and registration.
    if (request.raw.aborted || reply.raw.destroyed) return { commands };

    const controller = new AbortController();
    const onClose = () => controller.abort();
    reply.raw.once("close", onClose);
    try {
      const result = await claimWaiters.wait(agentId, waitMs, claim, { signal: controller.signal });
      return { commands: result.commands };
    } finally {
      reply.raw.off("close", onClose);
    }
  });

  // V2 is opt-in and requires a signed, device-bound agent identity. Android
  // must dedupe commandId locally before this route is enabled in a rollout.
  app.post("/api/v1/agent/commands/claim-v2", {
    schema: {
      summary: "Claim or reclaim a leased command with stable identity",
      tags: ["Agent"],
      body: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
      response: { 200: { type: "object", properties: { commands: { type: "array", items: { type: "object", additionalProperties: true } } } },
        429: { type: "object", properties: { error: { type: "string" } } } },
    },
  }, async (request, reply) => {
    if (!enableCommandLeases) return reply.code(409).send({ error: "lease_protocol_unavailable" });
    const rate = checkRateLimit(request, "agent-claim-v2", 60, 60_000);
    if (!rate.allowed) return reply.code(429).header("Retry-After", rate.retryAfterSeconds)
      .send({ error: "agent_rate_limit" });
    const identity = authorizeAgent(request, request.rawBody || Buffer.alloc(0));
    if (!identity || !request.authenticatedAgentId || identity.deviceId !== request.authenticatedAgentId) {
      return reply.code(403).send({ error: "signed_agent_identity_required" });
    }
    const limit = Math.max(1, Math.min(100, Number(request.body?.limit) || 25));
    const commands = commandEngine.claimForAgentV2(identity.deviceId, { limit }).map((command) => ({
      ...command, ciphertext: b64(command.ciphertext), clientSignature: b64(command.clientSignature),
    }));
    return { commands };
  });

  app.post("/api/v1/agent/commands/:id/status-v2", {
    schema: {
      summary: "Report a leased command status with claim generation",
      tags: ["Agent"],
      body: { type: "object", required: ["state", "claimGeneration"], properties: {
        state: { type: "string", enum: ["ACCEPTED", "EXECUTING", "COMPLETED", "FAILED"] },
        claimGeneration: { type: "integer", minimum: 1 },
        result: { type: "string", nullable: true },
      } },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } },
        409: { type: "object", properties: { error: { type: "string" } } },
        429: { type: "object", properties: { error: { type: "string" } } } },
    },
  }, async (request, reply) => {
    if (!enableCommandLeases) return reply.code(409).send({ error: "lease_protocol_unavailable" });
    const rate = checkRateLimit(request, "agent-status-v2", 120, 60_000);
    if (!rate.allowed) return reply.code(429).header("Retry-After", rate.retryAfterSeconds)
      .send({ error: "agent_rate_limit" });
    const identity = authorizeAgent(request, request.rawBody || Buffer.alloc(0));
    if (!identity || !request.authenticatedAgentId || identity.deviceId !== request.authenticatedAgentId) {
      return reply.code(403).send({ error: "signed_agent_identity_required" });
    }
    const { state, result, claimGeneration } = request.body || {};
    const from = {
      ACCEPTED: ["DELIVERED_TO_AGENT"], EXECUTING: ["ACCEPTED_BY_AGENT"],
      COMPLETED: ["EXECUTING", "ACCEPTED_BY_AGENT"],
      FAILED: ["EXECUTING", "ACCEPTED_BY_AGENT", "DELIVERED_TO_AGENT"],
    }[String(state)];
    if (!from) return reply.code(400).send({ error: "invalid_state" });
    const ok = commandEngine.transitionClaim(String(request.params.id), state === "ACCEPTED" ? "ACCEPTED_BY_AGENT" : state,
      { agentId: identity.deviceId, claimGeneration, fromStates: from, result: result ?? null });
    const command = commandEngine.get(String(request.params.id));
    if (ok && command?.type === "MARK_THREAD_READ") request._readAudit = {
      action: state === "COMPLETED" ? "read_completed" : "read_status",
      commandId: command.id, readerDeviceId: command.sourceClientId,
      targetAgentId: command.targetAgentId, state,
    };
    return ok ? { ok: true } : reply.code(409).send({ error: "stale_or_illegal_claim" });
  });

  app.post("/api/v1/agent/commands/:id/status", {
    schema: {
      summary: "Android Agent reports command lifecycle status (§58)",
      tags: ["Agent"],
      body: {
        type: "object",
        required: ["state"],
        properties: {
          state: { type: "string", enum: ["ACCEPTED", "EXECUTING", "COMPLETED", "FAILED"] },
          result: { type: "string", nullable: true }
        }
      },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 409: { type: "object", properties: { error: { type: "string" } } } }
    }
  }, async (request, reply) => {
    const id = String(request.params.id);
    if (commandEngine.get(id)?.claimGeneration > 0) return reply.code(409).send({ error: "lease_protocol_required" });
    const { state, result } = request.body || {};
    const from = {
      ACCEPTED: ["DELIVERED_TO_AGENT"],
      EXECUTING: ["ACCEPTED_BY_AGENT"],
      COMPLETED: ["EXECUTING", "ACCEPTED_BY_AGENT"],
      FAILED: ["EXECUTING", "ACCEPTED_BY_AGENT", "DELIVERED_TO_AGENT"],
    }[String(state)];
    if (!from) { reply.code(400).send({ error: "invalid state" }); return; }
    const ok = commandEngine.transition(id, state === "ACCEPTED" ? "ACCEPTED_BY_AGENT" : state, {
      fromStates: from,
      result: result ?? null,
    });
    if (!ok) { reply.code(409).send({ error: "illegal_transition" }); return; }
    const command = commandEngine.get(id);
    if (command?.type === "MARK_THREAD_READ") request._readAudit = {
      action: state === "COMPLETED" ? "read_completed" : "read_status",
      commandId: id, readerDeviceId: command.sourceClientId,
      targetAgentId: command.targetAgentId, state,
    };
    return { ok: true };
  });

  // Pure control-plane credential probe. The global /api/v1/agent/* gate has
  // already verified the signature exactly once and bound this identity.
  app.post("/api/v1/agent/ping", {
    schema: {
      summary: "Verify Android AgentAuth identity",
      description: "Validates the control-plane identity with no durable application/sync mutation.",
      tags: ["Agent"],
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            serverTime: { type: "integer" },
            deviceId: { type: "string" },
            role: { type: ["string", "null"] },
            protocolVersion: { type: "integer" }
          }
        },
        429: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  }, async (request, reply) => {
    if (checkRateLimit) {
      const limit = checkRateLimit(request, "agent-ping", 120, 60_000);
      if (!limit.allowed) {
        reply.header("retry-after", String(limit.retryAfterSeconds));
        return reply.code(429).send({ error: "rate_limited" });
      }
    }
    return {
      ok: true,
      serverTime: Date.now(),
      deviceId: request.authenticatedAgentId,
      role: agentAuthService?.getRole?.(request.authenticatedAgentId) || null,
      protocolVersion: 1
    };
  });

  // ── Event batch upload + cursor sync (PR-09, §54/§55, LOCK 10) ──────────

  /**
   * LDV-004 PR-D (§4.4.1): reject a control-key batch unless the authenticated
   * agent is exactly PRIMARY_TRUST_AGENT. authorizeAgent() short-circuits to the
   * identity the global /api/v1/agent/* gate already verified
   * (request.authenticatedAgentId), so the signature and replay window are NOT
   * checked twice. Returns true when the 403 was sent.
   */
  const rejectControlKeyBatchFromNonPrimary = (request, reply, events) => {
    const summary = controlKeyEventSummary(events);
    if (!summary) return false;
    const agent = authorizeAgent(request, request.rawBody || Buffer.alloc(0));
    if (agent?.role === "PRIMARY_TRUST_AGENT") return false;
    // Privacy: event types, a count and the authenticated device id only —
    // never a payload, wrapped key, signature or conversation identifier.
    request.log.warn({
      eventTypes: summary.types,
      eventCount: summary.count,
      agentId: agent?.deviceId || request.authenticatedAgentId || null,
    }, "control-key event batch rejected before ingestion: primary_trust_agent_required");
    reply.code(403).send({ error: "primary_trust_agent_required" });
    return true;
  };

  app.post("/api/v1/agent/events/batch", {
    bodyLimit: MAX_HTTP_BODY_BYTES,
    // The PRIMARY_TRUST_AGENT check below is authorization, so CodeQL's
    // js/missing-rate-limiting query needs a limit it can model. The server
    // registers @fastify/rate-limit with global:false; this declares the bound
    // for this ingest route, complementary to the body and batch caps.
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    schema: {
      summary: "Android Agent uploads a durable event batch (§55, partial ACK)",
      description: [
        "Each accepted event receives the account's next monotonic sequence (LOCK 10: per-account, never global).",
        "Response ACKs per eventId with its serverSequence — events missing from accepted[] stay PENDING in the device outbox and retry (LOCK 13 partial ACK).",
        "Duplicate eventIds are skipped WITHOUT consuming a sequence. Payload is opaque (encrypted in Phase 7).",
        "Control-key event types (KEY_GRANT, KEYRING_ENTRY, HISTORY_KEY_GRANT, CONTACTS_KEY_GRANT) are accepted only from the authenticated PRIMARY_TRUST_AGENT; any other authenticated agent receives 403 primary_trust_agent_required before ingestion."
      ].join("\n"),
      tags: ["Agent"],
      body: {
        type: "object",
        required: ["events"],
        properties: {
          sourceDeviceId: { type: "string", nullable: true, description: "Deprecated — IGNORED. The stored source identity is the authenticated agent bound from X-Agent-Auth (never the body)." },
          events: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["eventId", "type", "payload", "encoding", "schemaVersion", "cryptoVersion"],
              properties: {
                eventId: { type: "string", minLength: 1, maxLength: 128 },
                type: { type: "string", enum: EVENT_TYPES, maxLength: 64 },
                conversationId: { type: "string", maxLength: 256, nullable: true },
                messageId: { type: "string", maxLength: 128, nullable: true, description: "Opaque stable message identifier" },
                revision: { type: "integer", minimum: 1, nullable: true },
                sortKey: { type: "integer", minimum: 0, nullable: true, description: "Minimal non-content ordering metadata" },
                sourceOrder: { type: "integer", minimum: 0, nullable: true, description: "Durable device outbox insertion order" },
                payload: { type: "string", minLength: 4, maxLength: 174764, description: "canonical base64 opaque envelope bytes" },
                encoding: { type: "string", enum: ["envelope.v1", "envelope.v2", "envelope.v3"] },
                schemaVersion: { type: "integer", enum: [1] },
                cryptoVersion: { type: "integer", minimum: 0, maximum: 3 }
              }
            }
          }
        }
      },
      response: {
        200: {
          type: "object",
          properties: {
            accepted: {
              type: "array",
              items: {
                type: "object",
                properties: { eventId: { type: "string" }, serverSequence: { type: "integer" } }
              }
            },
            duplicates: { type: "integer" },
            results: { type: "array", items: { type: "object", properties: {
              eventId: { type: "string" }, status: { type: "string" },
              serverSequence: { type: "integer" }
            } } }
          }
        },
        403: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  }, async (request, reply) => {
    const body = request.body || {};
    let events;
    try {
      events = validateWireBatch(body.events);
    } catch (error) {
      request.log.warn({ validationCode: error.code || "invalid_event_batch",
        eventCount: Array.isArray(body.events) ? body.events.length : null },
      "agent event batch rejected before ingestion");
      return reply.code(400).send({ error: error.code || "invalid_event_batch" });
    }
    if (rejectControlKeyBatchFromNonPrimary(request, reply, events)) return;
    // P0: sourceDeviceId is NEVER taken from the request body. The per-device
    // identity was bound by the global agent gate from the verified
    // X-Agent-Auth signature (request.authenticatedAgentId). A legacy
    // shared-key caller has no per-device identity → null (it is not a device).
    const sourceDeviceId = request.authenticatedAgentId || null;
    return eventStore.ingestBatch({
      accountId,
      sourceDeviceId,
      events,
    });
  });

  app.post("/api/v1/agent/events/batch-v2", {
    bodyLimit: MAX_HTTP_BODY_BYTES,
    // Same modeled rate limit as /batch: the control-key authorization gate
    // must sit behind a framework-declared bound, not only the body/batch caps.
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    schema: {
      summary: "Per-item encrypted event ingest outcomes",
      description: "Control-key event types (KEY_GRANT, KEYRING_ENTRY, HISTORY_KEY_GRANT, CONTACTS_KEY_GRANT) are accepted only from the authenticated PRIMARY_TRUST_AGENT; any other authenticated agent receives 403 primary_trust_agent_required before ingestion.",
      tags: ["Agent"],
      body: { type: "object", required: ["events"], properties: {
        events: { type: "array", minItems: 1, maxItems: MAX_BATCH_EVENTS, items: { type: "object", additionalProperties: true } }
      } },
      response: { 200: { type: "object", properties: {
        results: { type: "array", items: { type: "object", properties: {
          index: { type: "integer" }, eventId: { type: "string" }, status: { type: "string" }, serverSequence: { type: "integer" }, error: { type: "string" }, errorClass: { type: "string", enum: ["VALIDATION", "IDENTITY_CONFLICT"] }
        } } },
        highWatermark: { type: "integer" }
      } },
      403: { type: "object", properties: { error: { type: "string" } } } }
    }
  }, async (request, reply) => {
    const submitted = request.body.events;
    const valid = [];
    const indices = [];
    const results = new Array(submitted.length);
    let decodedBytes = 0;
    for (let index = 0; index < submitted.length; index++) {
      const event = submitted[index];
      try {
        if (typeof event.eventId !== "string" || !event.eventId || event.eventId.length > 128) {
          throw Object.assign(new Error("invalid_event_id"), { code: "invalid_event_id" });
        }
        const { payload } = validateWireEvent(event);
        if ((event.conversationId != null && typeof event.conversationId !== "string") ||
            (event.messageId != null && typeof event.messageId !== "string") ||
            (event.revision != null && (!Number.isInteger(event.revision) || event.revision < 1)) ||
            (event.sortKey != null && (!Number.isInteger(event.sortKey) || event.sortKey < 0)) ||
            (event.sourceOrder != null && (!Number.isSafeInteger(event.sourceOrder) || event.sourceOrder < 0))) {
          throw Object.assign(new Error("invalid_metadata"), { code: "invalid_metadata" });
        }
        validateStoredBatch([{ ...event, payload }]);
        decodedBytes += payload.length;
        if (decodedBytes > MAX_DECODED_BATCH_BYTES) {
          return reply.code(413).send({ error: "batch_payload_too_large" });
        }
        valid.push({ ...event, payload });
        indices.push(index);
      } catch (error) {
        results[index] = { index, eventId: String(event.eventId || ""), status: "INVALID_EVENT",
          error: SAFE_INGEST_ERROR_CODES.has(error.code) ? error.code : "invalid_event", errorClass: "VALIDATION" };
      }
    }
    if (rejectControlKeyBatchFromNonPrimary(request, reply, valid)) return;
    const stored = valid.length
      ? eventStore.ingestBatch({ accountId, sourceDeviceId: request.authenticatedAgentId || null, events: valid, perItem: true })
      : { results: [], highWatermark: eventStore.highWatermark(accountId) };
    stored.results.forEach((result, offset) => { results[indices[offset]] = { index: indices[offset], ...result,
      ...(result.status === "CONFLICTING_DUPLICATE" ? { errorClass: "IDENTITY_CONFLICT" }
        : result.status === "ACCEPTED" || result.status === "DUPLICATE" ? {} : { errorClass: "VALIDATION" }) }; });
    return { results, highWatermark: stored.highWatermark };
  });

  app.get("/api/v1/sync", {
    schema: {
      summary: "Cursor-based catch-up sync (§54) — events after a per-account cursor",
      description: "Monotonic per-account sequences (LOCK 10). Ciphertext only. nextCursor + hasMore for pagination; clients apply events transactionally into their local store.",
      tags: ["Sync"],
      querystring: {
        type: "object",
        properties: {
          after: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 }
        }
      },
      response: { 200: { type: "object", additionalProperties: true } }
    }
  }, async (request, reply) => {
    const after = Math.max(0, Number(request.query?.after) || 0);
    const limit = Number(request.query?.limit) || 500;
    reply.header("Cache-Control", "no-store");
    const metadata = eventStore.replicaMetadata(accountId);
    if (after < metadata.minimumAvailableSequence - 1) {
      return reply.code(409).send({
        error: "snapshot_required",
        ...metadata,
        highWatermark: eventStore.highWatermark(accountId),
      });
    }
    return eventStore.after(accountId, after, limit);
  });

  app.post("/api/v1/sync/ack", {
    // Adapter acknowledgements are small and idempotent; bound abuse without
    // throttling a normal read/ack loop (the adapter batches ≤1000 ids).
    config: { rateLimit: { max: 120, timeWindow: 60000 } },
    schema: {
      summary: "Acknowledge processed sync events for the linked AI device",
      description: [
        "Adapter-compatibility surface for `Authorization: Device <token>` clients (XR-GA-008).",
        "The authenticated linked session, never the body or query, selects the device: a",
        "`device_id` naming any other device is rejected with 403 device_mismatch.",
        "GMweb's durable catch-up cursor stays sequence-based (`GET /api/v1/sync?after=`);",
        "this acknowledgement validates and accepts the adapter's processed event IDs but",
        "does not delete events, advance a cursor or compact the store (`durable:false`).",
      ].join("\n"),
      tags: ["Sync"],
      body: {
        type: "object",
        required: ["sync_event_ids"],
        additionalProperties: false,
        properties: {
          device_id: { type: "string", maxLength: 128 },
          sync_event_ids: {
            type: "array",
            maxItems: 1000,
            items: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            accepted: { type: "integer" },
            durable: { type: "boolean" },
          },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    if (!request.linkedDevice.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "read_messages_capability_required" });
    }
    if (request.body?.device_id && request.body.device_id !== request.linkedDevice.deviceId) {
      return reply.code(403).send({ error: "device_mismatch" });
    }
    return { ok: true, accepted: request.body.sync_event_ids.length, durable: false };
  });

  const webSnapshotHeaders = (reply) => reply.header("Cache-Control", "no-store");

  app.post("/api/v1/web/snapshot-v2", {
    schema: {
      summary: "Start immutable encrypted replica snapshot",
      tags: ["Sync"],
      body: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    webSnapshotHeaders(reply);
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    if (!request.linkedDevice.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "read_messages_capability_required" });
    }
    if (checkRateLimit) {
      const limit = checkRateLimit(request, `linked-snapshot:${request.linkedDevice.deviceId}`, 5, 60_000);
      if (!limit.allowed) return reply.code(429).header("Retry-After", limit.retryAfterSeconds)
        .send({ error: "rate_limited" });
    }
    return eventStore.beginSnapshot({ accountId, linkedDeviceId: request.linkedDevice.deviceId,
      limit: request.body?.limit || 100 });
  });
  app.get("/api/v1/web/snapshot-v2", {
    schema: {
      summary: "Continue immutable encrypted replica snapshot",
      tags: ["Sync"],
      querystring: { type: "object", required: ["token"], properties: {
        token: { type: "string", minLength: 32, maxLength: 128 },
        cursor: { type: "string", maxLength: 64 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      } },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    webSnapshotHeaders(reply);
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    if (!request.linkedDevice.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "read_messages_capability_required" });
    }
    try {
      return eventStore.snapshotPage({ accountId, linkedDeviceId: request.linkedDevice.deviceId,
        token: request.query.token, cursor: request.query.cursor, limit: request.query.limit || 100 });
    } catch (error) {
      return reply.code(error.code === "snapshot_forbidden" ? 403 : error.code === "invalid_snapshot_cursor" ? 400 : 409)
        .send({ error: error.code || "snapshot_required" });
    }
  });

  app.get("/api/v1/web/bootstrap", {
    schema: {
      summary: "Encrypted linked-browser bootstrap",
      tags: ["Sync"],
      querystring: { type: "object", properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
        includeContacts: { type: "boolean", default: true },
      } },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    webSnapshotHeaders(reply);
    return eventStore.bootstrap(accountId, Number(request.query?.limit) || 100,
      { includeContacts: request.query?.includeContacts !== false });
  });

  app.get("/api/v1/linked-device/contacts/events", {
    schema: {
      summary: "Bounded encrypted contact-event page for an authorized linked browser",
      tags: ["Sync"],
      querystring: { type: "object", properties: {
        beforeSequence: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      } },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    webSnapshotHeaders(reply);
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    if (!request.linkedDevice.capabilities?.includes("CONTACTS_READ"))
      return reply.code(403).send({ error: "contacts_read_capability_required" });
    return eventStore.contactEventsBefore(accountId, request.query?.beforeSequence,
      request.query?.limit);
  });

  app.post("/api/v1/web/sync/ack", {
    schema: {
      summary: "Acknowledge a delta cursor after durable browser commit",
      tags: ["Sync"],
      body: {
        type: "object",
        additionalProperties: false,
        required: ["cursor", "replicaGeneration", "snapshotVersion"],
        properties: {
          cursor: { type: "integer", minimum: 0 },
          replicaGeneration: { type: "string", minLength: 16, maxLength: 128 },
          snapshotVersion: { type: "integer", minimum: 1 },
        },
      },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    if (!request.linkedDevice) return reply.code(401).send({ error: "linked_session_required" });
    if (!request.linkedDevice.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "read_messages_capability_required" });
    }
    try {
      const result = eventStore.acknowledgeClient(
        accountId,
        request.linkedDevice.deviceId,
        request.body.cursor,
        request.body.replicaGeneration,
        request.body.snapshotVersion,
      );
      setImmediate(() => {
        try { eventStore.compact(accountId); } catch (error) {
          console.error(`[eventStore] compaction_failed code=${error.code || "internal"}`);
        }
      });
      return result;
    } catch (error) {
      return reply.code(error.code === "snapshot_required" ? 409 : 400)
        .send({ error: error.code || "sync_ack_failed" });
    }
  });

  app.get("/api/v1/web/conversations", {
    schema: {
      summary: "Encrypted conversation-state page",
      tags: ["Sync"],
      querystring: { type: "object", properties: {
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      } },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    webSnapshotHeaders(reply);
    return eventStore.conversations(accountId, request.query?.cursor, Number(request.query?.limit) || 100);
  });

  app.post("/api/v1/web/conversations/changed", {
    schema: {
      summary: "Bounded encrypted conversation states after a content-free SSE invalidation",
      tags: ["Sync"],
      body: { type: "object", additionalProperties: false, required: ["conversationIds"],
        properties: { conversationIds: { type: "array", minItems: 1, maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 128 } } } },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    webSnapshotHeaders(reply);
    if (!request.linkedDevice?.capabilities?.includes("READ_MESSAGES"))
      return reply.code(403).send({ error: "read_messages_capability_required" });
    return eventStore.conversationsByIds(accountId, request.body.conversationIds);
  });

  app.get("/api/v1/web/conversations/:conversationId/messages", {
    schema: {
      summary: "Encrypted message-state page",
      tags: ["Sync"],
      params: { type: "object", required: ["conversationId"], properties: { conversationId: { type: "string", minLength: 1 } } },
      querystring: { type: "object", properties: {
        before: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      } },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    webSnapshotHeaders(reply);
    return eventStore.messages(accountId, request.params.conversationId,
      request.query?.before, Number(request.query?.limit) || 50);
  });

  app.get("/api/v1/linked-device/sync-diagnostics", {
    schema: {
      summary: "Privacy-safe E2EE sync pipeline counts for the linked browser",
      tags: ["Diagnostics"],
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    if (!request.linkedDevice?.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "capability_denied" });
    }
    return eventStore.syncDiagnostics(accountId, request.linkedDevice.deviceId);
  });

  app.get("/api/v1/linked-device/key-grants", {
    schema: {
      summary: "Bootstrap opaque key grants before a linked browser replays message history",
      tags: ["Sync"],
      querystring: {
        type: "object",
        properties: {
          after: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 1000, default: 1000 },
        },
      },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    if (!request.linkedDevice?.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "capability_denied" });
    }
    return eventStore.deviceGrantsAfter(accountId, request.linkedDevice.deviceId,
      Number(request.query?.after) || 0, Number(request.query?.limit) || 1000);
  });

  app.get("/api/v1/linked-device/keyring", {
    schema: {
      summary: "Fetch this browser's bounded account keys and v3 full-history key",
      tags: ["Sync"],
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 1000, default: 1000 },
        },
      },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    if (!request.linkedDevice?.capabilities?.includes("READ_MESSAGES")) {
      return reply.code(403).send({ error: "capability_denied" });
    }
    return eventStore.deviceKeyring(accountId, request.linkedDevice.deviceId,
      Number(request.query?.limit) || 1000);
  });
}

module.exports = { registerControlPlaneRoutes };
