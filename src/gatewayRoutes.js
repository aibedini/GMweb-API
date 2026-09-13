"use strict";
// Android device pull bridge — the phone dials OUT, picks up queued sends,
// delivers them over the SIM and reports the outcome.
//
//   GET  /gateway/pull      long-poll for the next task      (device key)
//   POST /gateway/validate  "is this task still wanted?"     (device key)
//   POST /gateway/ack       report the SIM outcome           (device key)
//
// This module exists as its own boundary because the bridge is where the
// stale-SMS race is actually won or lost: a task the phone already holds can
// only be stopped if the bridge can answer "superseded" DURABLY — after a
// restart, after a Redis reconnect, after the device went offline and came
// back. Keeping it out of server.js lets the whole contract be tested against a
// real store and a real outbox with no Redis and no browser.
//
// Auth is the existing gateway device key (X-API-Key), checked here AND in the
// global preHandler hook (defence in depth, unchanged).
const MAX_REQUEST_ID = 120;

function registerGatewayRoutes(app, deps = {}) {
  const {
    outbox,
    sendStore,
    checkDeviceKey,
    revocation = null,
    isPullModeActive = () => true,
    checkRateLimit = null,
    validateLimit = { max: 600, windowMs: 60000 },
    log = null
  } = deps;
  if (!outbox) throw new Error("registerGatewayRoutes requires an outbox");

  const bump = (name, delta = 1) => {
    try { sendStore?.bumpCounters([{ name, delta }]); } catch { /* counters are best effort */ }
  };
  const metrics = revocation?.METRICS || {};

  const unauthorized = (reply) => {
    reply.code(401).send({ error: "unauthorized" });
  };

  // ── pull ─────────────────────────────────────────────────────────────────
  app.get("/gateway/pull", {
    schema: {
      summary: "Android device pulls the next queued send",
      description: [
        "Long-poll for devices in android transport pull mode. Authenticated with the device key (X-API-Key).",
        "Returns {task:null} or {task:{requestId,to,text,priority,meta}}.",
        "Tasks whose lifecycle was invalidated are never handed out: they are terminalized as superseded here.",
        "Older Android builds that ignore \`meta\` keep working unchanged."
      ].join(" "),
      tags: ["Gateway"],
      response: {
        200: {
          type: "object",
          properties: {
            task: {
              type: ["object", "null"],
              properties: {
                requestId: { type: "string" },
                to: { type: "string" },
                text: { type: "string" },
                priority: { type: "string" },
                meta: {
                  type: ["object", "null"],
                  description: "Consumer notification identity. Null for legacy sends without meta.",
                  properties: {
                    source: { type: ["string", "null"] },
                    serviceKey: { type: ["string", "null"] },
                    notificationKind: { type: ["string", "null"] },
                    generation: { type: ["integer", "null"] },
                    correlationId: { type: ["string", "null"] },
                    requiresValidation: { type: "boolean" }
                  }
                }
              }
            }
          }
        },
        401: { type: "object", properties: { error: { type: "string" } } },
        409: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  }, async (request, reply) => {
    if (!checkDeviceKey(request)) return unauthorized(reply);
    if (!isPullModeActive() || !outbox) {
      reply.code(409).send({ error: "pull_mode_inactive" });
      return;
    }
    const waitMs = Math.min(30000, Math.max(1000, Number(request.query?.waitMs) || 25000));
    const task = await outbox.take(waitMs);
    if (task) {
      const row = task.meta ? sendStore?.byGatewayRequest(task.requestId) : null;
      log?.info?.({
        gatewayRequestId: task.requestId,
        serviceKey: task.meta?.serviceKey || null,
        notificationKind: task.meta?.notificationKind || null,
        generation: task.meta?.generation ?? null,
        correlationId: task.meta?.correlationId || null,
        bullmqJobId: row?.job_id || null,
        state: "pulled",
        transport: "android-pull",
        pullAt: new Date().toISOString()
      }, "android gateway task pulled");
    }
    return { task };
  });

  // ── validate ─────────────────────────────────────────────────────────────
  app.post("/gateway/validate", {
    schema: {
      summary: "Android validates a task before submitting it to the SIM",
      description: [
        "Final gate before the modem is touched. Answers \`valid:false\` the instant its service generation is invalidated,",
        "including while the task is already in flight. Returns only the verdict — never task, customer or message metadata."
      ].join(" "),
      tags: ["Gateway"],
      body: {
        type: "object",
        required: ["requestId"],
        properties: { requestId: { type: "string", maxLength: MAX_REQUEST_ID } }
      },
      response: {
        200: {
          type: "object",
          properties: {
            valid: { type: "boolean" },
            status: { type: "string", enum: ["valid", "superseded", "terminal"] },
            reason: { type: ["string", "null"] },
            known: { type: "boolean", description: "False when the gateway has no durable record of this task id." }
          }
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        401: { type: "object", properties: { error: { type: "string" } } },
        429: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  }, async (request, reply) => {
    if (!checkDeviceKey(request)) return unauthorized(reply);
    if (checkRateLimit) {
      const limit = checkRateLimit(request, "gateway-validate", validateLimit.max, validateLimit.windowMs);
      if (!limit.allowed) {
        reply.header("retry-after", String(limit.retryAfterSeconds));
        reply.code(429).send({ error: "rate_limited" });
        return;
      }
    }
    const requestId = String(request.body?.requestId || "").slice(0, MAX_REQUEST_ID);
    if (!requestId) {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }
    bump(metrics.validationRequests || "sms_validation_requests_total");

    const verdict = validateTask(requestId);
    if (!verdict.valid) bump(metrics.validationInvalid || "sms_validation_invalid_total");
    log?.info?.({
      gatewayRequestId: requestId,
      state: verdict.valid ? "validated" : "validation_rejected",
      reason: verdict.reason,
      transport: "android-pull"
    }, "android gateway validation");
    reply.header("cache-control", "no-store");
    return verdict;
  });

  /**
   * The verdict itself. In-memory state answers first (cheap, and covers a task
   * the ledger has not been told about yet), then the durable ledger answers —
   * which is what keeps the guarantee across a restart.
   *
   * Deliberately returns no task, phone number, service key or message data.
   */
  function validateTask(requestId) {
    const overlay = outbox.revocationFor(requestId, null);
    if (overlay) {
      return { valid: false, status: "superseded", reason: overlay.reason || null, known: true };
    }
    const row = sendStore?.byGatewayRequest(requestId) || null;
    if (!row) {
      // A task id this gateway has no record of: neither valid nor provably
      // revoked. Never fail closed on unknown ids, or a device that pulled a
      // task before an upgrade would be stuck.
      return { valid: true, status: "valid", reason: null, known: false };
    }
    if (sendStore.isSuperseded(row)) {
      return { valid: false, status: "superseded", reason: row.revocation_reason || "superseded", known: true };
    }
    const status = String(row.status || "").toLowerCase();
    if (status === "cancelled") {
      return { valid: false, status: "superseded", reason: row.error || "cancelled", known: true };
    }
    if (["sent", "unverified", "failed", "suppressed"].includes(status)) {
      // Already finished: re-submitting would be a duplicate SMS.
      return { valid: false, status: "terminal", reason: status, known: true };
    }
    return { valid: true, status: "valid", reason: null, known: true };
  }

  // ── ack ──────────────────────────────────────────────────────────────────
  app.post("/gateway/ack", {
    schema: {
      summary: "Android device reports a delivery outcome",
      description: [
        "Acknowledge a pulled task.",
        "\`ok:true\` marks it sent (drives ledger, SSE, webhooks); \`ok:false\` fails that attempt so BullMQ can retry.",
        "\`outcome:\"superseded\"\` means the device did NOT send it because the lifecycle was invalidated:",
        "terminal, not successful, not billable, not retryable and not a gateway failure.",
        "Legacy \`{requestId, ok}\` bodies keep working exactly as before."
      ].join(" "),
      tags: ["Gateway"],
      body: {
        type: "object",
        required: ["requestId"],
        properties: {
          requestId: { type: "string", maxLength: MAX_REQUEST_ID },
          ok: { type: "boolean", description: "Legacy flag. Derived from outcome when omitted." },
          outcome: { type: "string", enum: ["sent", "failed", "superseded"] },
          reason: { type: "string", maxLength: 200 },
          error: { type: "string", maxLength: 300 },
          status: { type: "string", maxLength: 40 },
          sentAt: { type: "integer" },
          requestedTo: { type: "string" },
          sentTo: { type: "string" },
          cancelled: { type: "boolean" }
        }
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            outcome: { type: ["string", "null"] },
            terminal: { type: "boolean" },
            successful: { type: ["boolean", "null"] },
            counted: { type: "boolean", description: "False for superseded: it never counts toward send limits." }
          }
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        401: { type: "object", properties: { error: { type: "string" } } }
      }
    }
  }, async (request, reply) => {
    if (!checkDeviceKey(request)) return unauthorized(reply);
    const body = request.body || {};
    const requestId = String(body.requestId || "").slice(0, MAX_REQUEST_ID);
    if (!requestId) {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }
    const outcome = ["sent", "failed", "superseded"].includes(body.outcome) ? body.outcome : null;
    const ok = typeof body.ok === "boolean" ? body.ok : outcome === "sent";
    const result = outbox.acknowledge(requestId, ok, {
      outcome: outcome || undefined,
      reason: body.reason,
      error: body.error || body.reason,
      status: body.status,
      sentAt: body.sentAt,
      requestedTo: body.requestedTo,
      sentTo: body.sentTo,
      cancelled: body.cancelled
    });

    if (!result.handled) {
      // The gateway already settled this task (restart, lease expiry). Consult
      // the durable ledger: a real submission that lands AFTER the revocation
      // is the impossible-unsend case and must be audited, not swallowed.
      const row = sendStore?.byGatewayRequest(requestId) || null;
      if (row && ok) {
        (revocation?.auditSentAfterRevocation || (() => false))(row, {
          transport: "android-pull", result: { lateAck: true, reportedAt: body.sentAt || null }
        });
        return { ok: true, outcome: "sent_after_revocation", terminal: true, successful: true, counted: true };
      }
      return { ok: false, outcome: null, terminal: false, successful: null, counted: false };
    }

    const terminal = result.outcome !== "sent" && result.outcome !== "failed";
    return {
      ok: true,
      outcome: result.outcome,
      terminal,
      successful: result.outcome === "sent" || result.outcome === "sent_after_revocation"
        ? true : (result.outcome === "failed" || result.outcome === "superseded" || result.outcome === "cancelled" ? false : null),
      // A superseded task must never consume a successful-send budget.
      counted: result.outcome === "sent" || result.outcome === "sent_after_revocation"
    };
  });

  return { validateTask };
}

module.exports = { registerGatewayRoutes };
