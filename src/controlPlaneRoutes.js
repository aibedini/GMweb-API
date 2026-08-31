"use strict";

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
 * @param {object} deps { trustRegistry, commandEngine, accountId }
 */
function registerControlPlaneRoutes(app, { trustRegistry, commandEngine, accountId }) {
  const b64 = (buf) => (buf ? Buffer.from(buf).toString("base64") : null);

  // ── Trust Registry relay (ADR-001 LOCK 2/9) ──────────────────────────────

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
  }, async (request) => {
    const statement = request.body?.statement || request.body;
    const result = trustRegistry.applyStatement({ accountId, statement });
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
    const snap = trustRegistry.getSnapshot(accountId);
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
        400: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  }, async (request, reply) => {
    const body = request.body || {};
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
        sourceClientId: body.sourceClientId ?? null,
        clientSignature: body.clientSignature
          ? Buffer.from(String(body.clientSignature), "base64")
          : null,
        expiresAt: body.expiresAt ?? undefined,
      });
      reply.code(202).send({ commandId: command.id, state: command.state, created });
    } catch (error) {
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
}

module.exports = { registerControlPlaneRoutes };
