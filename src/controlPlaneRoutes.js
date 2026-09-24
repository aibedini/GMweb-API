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

const EVENT_TYPES = Object.keys({
  ...eventCryptoPolicy.contentBearing,
  ...eventCryptoPolicy.controlKey,
  ...eventCryptoPolicy.nonContentControl,
});
const ENCRYPTED_LINKED_COMMAND_TYPES = new Set(["SEND_SMS", "MARK_THREAD_READ"]);

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
function registerControlPlaneRoutes(app, { trustRegistry, commandEngine, eventStore, accountId, authorizeAgent, linkedSessions, deviceTelemetryStore, agentAuthService, checkRateLimit, enableCommandLeases = false }) {
  const b64 = (buf) => (buf ? Buffer.from(buf).toString("base64") : null);
  const replicationCapabilities = () => ({
    preferredProtocolVersion: 1,
    supportedProtocolVersions: [1],
    eventIngest: { maxBatchEvents: 100, perItemResults: false },
    snapshot: { stablePagination: true },
    keys: { deviceFiltered: true, independentFromEventCursor: true },
    commands: { durable: true, idempotent: true, leases: enableCommandLeases },
  });
  const capabilitiesSchema = {
    schema: {
      summary: "Implemented encrypted replication capabilities",
      description: "Reports active protocol behavior. V2 remains unavailable until its snapshot, ingest and command contracts are implemented.",
      tags: ["Sync"],
      response: { 200: { type: "object", additionalProperties: true } },
    },
  };

  app.get("/api/v1/agent/replication-capabilities", capabilitiesSchema, async (request, reply) => {
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
        400: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  };

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
    deviceTelemetryStore.upsert(request.body, agent.role);
    return { ok: true };
  });

  app.get("/admin/device-telemetry", {
    schema: { summary: "Latest Android fleet telemetry", tags: ["Admin"] },
  }, async () => ({ devices: deviceTelemetryStore?.getAll() || [] }));

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
    return { telemetry: deviceTelemetryStore?.getPrimary() || null };
  });

  app.get("/api/v1/linked-device/command-key", {
    schema: { summary: "Primary Android command encryption public key", tags: ["Commands"] },
  }, async (request, reply) => {
    if (!request.linkedDevice?.capabilities?.includes("SEND_MESSAGES")) {
      return reply.code(403).send({ error: "send_messages_capability_required" });
    }
    const identity = agentAuthService?.getPrimaryIdentity();
    if (!identity?.encryption_public_key) return reply.code(404).send({ error: "primary_command_key_unavailable" });
    return { deviceId: identity.device_id, encryptionPublicKey: identity.encryption_public_key };
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
          type: { type: "string", examples: ["SEND_SMS", "MARK_THREAD_READ"] },
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
    if (request.linkedDevice && body.type === "MARK_THREAD_READ" &&
        !request.linkedDevice.capabilities?.includes("MARK_READ")) {
      return reply.code(403).send({ error: "mark_read_capability_required" });
    }
    if (request.linkedDevice && body.type === "SEND_SMS" &&
        !request.linkedDevice.capabilities?.includes("SEND_MESSAGES")) {
      return reply.code(403).send({ error: "send_messages_capability_required" });
    }
    if (request.linkedDevice && ENCRYPTED_LINKED_COMMAND_TYPES.has(String(body.type))) {
      if (Number(body.cryptoVersion) !== 1 || body.encoding !== "envelope.v1" || Number(body.schemaVersion) !== 1) {
        return reply.code(400).send({ error: "encrypted_command_required" });
      }
    }
    if (request.linkedDevice && body.type === "SEND_SMS") {
      const limit = checkRateLimit(request, `linked-send:${request.linkedDevice.deviceId}`, 10, 60_000);
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
        type: String(body.type),
        ciphertext: payload,
        encoding: body.encoding,
        schemaVersion: body.schemaVersion,
        cryptoVersion: body.cryptoVersion,
        targetAgentId: body.targetAgentId ?? null,
        sourceClientId: request.linkedDevice?.deviceId ?? body.sourceClientId ?? null,
        clientSignature: body.clientSignature
          ? Buffer.from(String(body.clientSignature), "base64")
          : null,
        expiresAt: body.expiresAt ?? undefined,
      });
      if (request.linkedDevice && command.sourceClientId !== request.linkedDevice.deviceId) {
        return reply.code(409).send({ error: "idempotency_owner_mismatch" });
      }
      reply.code(202).send({ commandId: command.id, state: command.state, created });
    } catch (error) {
      reply.code(error.code === "idempotency_key_reused" ? 409 : 400).send({ error: error.message });
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
      description: "Atomically flips claimed rows QUEUED→DELIVERED_TO_AGENT. Payload stays opaque. Agent reports lifecycle via /status.",
      tags: ["Agent"],
      body: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "device/agent identity (device-key auth until PR-08 mTLS)" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
        }
      },
      response: { 200: { type: "object", properties: { commands: { type: "array", items: { type: "object", additionalProperties: true } } } } }
    }
  }, async (request) => {
    const agentId = String(request.body?.agentId || "android-agent");
    const limit = Math.max(1, Math.min(100, Number(request.body?.limit) || 25));
    const commands = commandEngine.claimForAgent(agentId, { limit }).map((c) => ({
      ...c,
      ciphertext: b64(c.ciphertext),
      clientSignature: b64(c.clientSignature),
    }));
    return { commands };
  });

  // V2 is opt-in and requires a signed, device-bound agent identity. Android
  // must dedupe commandId locally before this route is enabled in a rollout.
  app.post("/api/v1/agent/commands/claim-v2", {
    schema: {
      summary: "Claim or reclaim a leased command with stable identity",
      tags: ["Agent"],
      body: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
      response: { 200: { type: "object", properties: { commands: { type: "array", items: { type: "object", additionalProperties: true } } } } },
    },
  }, async (request, reply) => {
    if (!enableCommandLeases) return reply.code(409).send({ error: "lease_protocol_unavailable" });
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
        409: { type: "object", properties: { error: { type: "string" } } } },
    },
  }, async (request, reply) => {
    if (!enableCommandLeases) return reply.code(409).send({ error: "lease_protocol_unavailable" });
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

  app.post("/api/v1/agent/events/batch", {
    bodyLimit: MAX_HTTP_BODY_BYTES,
    schema: {
      summary: "Android Agent uploads a durable event batch (§55, partial ACK)",
      description: [
        "Each accepted event receives the account's next monotonic sequence (LOCK 10: per-account, never global).",
        "Response ACKs per eventId with its serverSequence — events missing from accepted[] stay PENDING in the device outbox and retry (LOCK 13 partial ACK).",
        "Duplicate eventIds are skipped WITHOUT consuming a sequence. Payload is opaque (encrypted in Phase 7)."
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
            duplicates: { type: "integer" }
          }
        }
      }
    }
  }, async (request, reply) => {
    const body = request.body || {};
    let events;
    try {
      events = validateWireBatch(body.events);
    } catch (error) {
      return reply.code(400).send({ error: error.code || "invalid_event_batch" });
    }
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
    schema: {
      summary: "Per-item encrypted event ingest outcomes",
      tags: ["Agent"],
      body: { type: "object", required: ["events"], properties: {
        events: { type: "array", minItems: 1, maxItems: MAX_BATCH_EVENTS, items: { type: "object", additionalProperties: true } }
      } },
      response: { 200: { type: "object", properties: {
        results: { type: "array", items: { type: "object", properties: {
          index: { type: "integer" }, eventId: { type: "string" }, status: { type: "string" }, serverSequence: { type: "integer" }, error: { type: "string" }
        } } },
        highWatermark: { type: "integer" }
      } } }
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
            (event.sortKey != null && (!Number.isInteger(event.sortKey) || event.sortKey < 0))) {
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
        results[index] = { index, eventId: String(event.eventId || ""), status: "INVALID_EVENT", error: error.code || "invalid_event" };
      }
    }
    const stored = valid.length
      ? eventStore.ingestBatch({ accountId, sourceDeviceId: request.authenticatedAgentId || null, events: valid, perItem: true })
      : { results: [], highWatermark: eventStore.highWatermark(accountId) };
    stored.results.forEach((result, offset) => { results[indices[offset]] = { index: indices[offset], ...result }; });
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
      querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 100 } } },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    webSnapshotHeaders(reply);
    return eventStore.bootstrap(accountId, Number(request.query?.limit) || 100);
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
