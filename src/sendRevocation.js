"use strict";
// Semantic revocation for consumer notifications — the fix for the stale-SMS
// race.
//
//   T1 Eve queues "your volume ended"        (generation 17)
//   T2 GMweb/BullMQ/Android pick it up
//   T3 the customer renews
//   T4 Eve calls POST /send/invalidate with generation 18
//   T5 BullMQ says "active, not cancellable"  <-- the old dead end
//   T6 the phone must still NOT send it
//
// Queue removal alone cannot express that: removing a waiting BullMQ job says
// nothing about a task the phone already pulled, and an ACTIVE job cannot be
// removed at all. So the decision is written to the DURABLE LEDGER first and
// every hop that could still submit an SMS re-reads it:
//
//   1. this service records the revocation + advances the service generation
//   2. the BullMQ worker refuses to touch a transport for a revoked row
//   3. AndroidOutbox drops pending tasks and flags in-flight ones
//   4. /gateway/pull skips them and /gateway/validate answers "superseded"
//   5. the phone's late ACK is either a clean superseded confirmation, or a
//      sent_after_revocation audit when the SIM had already gone out
//
// Every step is idempotent, and the generation watermark makes the guarantee
// hold even for a row no loop ever visited (crash, restart, delayed retry).
const {
  DEPLETION_KINDS,
  TRANSACTIONAL_KINDS,
  isTerminalSendStatus
} = require("./notificationMeta");

const CAUSE_CANCEL = "cancel";
const CAUSE_SUPERSEDED = "superseded";

// Durable lifecycle counters (send_counters). Names follow the requested
// sms_*_total convention.
const METRICS = Object.freeze({
  invalidations: "sms_invalidations_total",
  superseded: "sms_jobs_superseded_total",
  inflightRevoked: "sms_inflight_revoked_total",
  sentAfterRevocation: "sms_sent_after_revocation_total",
  validationRequests: "sms_validation_requests_total",
  validationInvalid: "sms_validation_invalid_total",
  staleGenerationRejected: "sms_stale_generation_rejections_total",
  queueRemovalFailures: "sms_queue_removal_failures_total"
});

const BULLMQ_PENDING_STATES = Object.freeze(["waiting", "paused", "delayed", "prioritized"]);

function createSendRevocation(deps = {}) {
  const {
    sendStore,
    queue,
    outbox = null,
    activeCancellationRequests = new Set(),
    onEvent = () => {},
    onAudit = () => {},
    log = null,
    now = Date.now
  } = deps;
  if (!sendStore) throw new Error("sendRevocation requires a sendStore");

  const bump = (name, delta = 1) => {
    try { sendStore.bumpCounters([{ name, delta }], now()); } catch { /* counters are best effort */ }
  };

  /**
   * Durable guard used by the BullMQ processor BEFORE it touches a transport.
   * Reads the ledger (not a Set), so a restart, a stalled job that BullMQ
   * re-queued, or a delayed retry hours later all see the same answer.
   */
  function guardForJob(jobId) {
    if (!jobId) return null;
    const row = sendStore.byJob(jobId);
    if (!row) return null;
    if (row.status === "cancelled") return { cancelled: true, row };
    if (sendStore.isSuperseded(row)) {
      return { superseded: true, row, reason: row.revocation_reason || "superseded" };
    }
    return null;
  }

  /** Terminalize a row as superseded exactly once, with its counter. */
  function finalizeSuperseded(row, reason = null) {
    if (!row) return false;
    const changed = sendStore.finalizeSuperseded(row.id, reason || row.revocation_reason || "superseded");
    if (changed) bump(METRICS.superseded);
    return changed;
  }

  /**
   * The single cancel/supersede state machine behind POST /send/cancel/:ref and
   * POST /send/invalidate. Returns { statusCode, body, location } where
   * location is pending | active | inflight | terminal | missing.
   */
  async function cancelOne(reference, options = {}) {
    const cause = options.cause || CAUSE_CANCEL;
    const superseding = cause === CAUSE_SUPERSEDED;
    const reason = options.reason || null;
    const ledger = sendStore.byReference(reference);
    if (!ledger) return { statusCode: 404, body: { error: "not_found" }, location: "missing" };

    const requestId = sendStore.requestId(ledger.id);
    const statusUrl = `/send/status/${requestId}`;
    const jobId = ledger.job_id || null;
    const common = { requestId, statusUrl, jobId };

    if (ledger.status === "cancelled") {
      return {
        statusCode: 200,
        location: "terminal",
        body: {
          ok: true, ...common,
          status: "cancelled", state: "cancelled",
          cancelled: true, alreadyCancelled: true,
          cancelledFromState: null, terminal: true
        }
      };
    }

    if (isTerminalSendStatus(ledger.status)) {
      return {
        statusCode: 409,
        location: "terminal",
        body: {
          ok: false, error: "not_cancellable", reason: "already_terminal",
          ...common,
          status: ledger.status,
          state: ledger.status === "sent" ? "completed" : ledger.status
        }
      };
    }

    // ── 1. An Android gateway task the phone may already hold ────────────────
    const gatewayRequestId = ledger.gateway_request_id || null;
    if (superseding && outbox && gatewayRequestId) {
      const revoked = outbox.revokeRequest(gatewayRequestId, {
        cause: CAUSE_SUPERSEDED, reason
      });
      if (revoked.found) {
        if (revoked.state === "inflight") {
          // Keep status 'active': the task is flagged revoked and we wait for
          // the phone's superseded ACK or the bounded lease.
          sendStore.revokeById(ledger.id, { reason, correlationId: options.correlationId,
            eventId: options.eventId, generation: options.generation, source: options.source, at: now() });
          bump(METRICS.inflightRevoked);
          onEvent({
            type: "send_revocation_requested", requestId, jobId, status: "revoked",
            revokedFromState: "inflight", reason, correlationId: options.correlationId,
            at: new Date(now()).toISOString()
          });
          return {
            statusCode: 200, location: "inflight",
            body: { ok: true, ...common, status: "revoked", state: "revoked",
              cancelled: true, alreadyCancelled: false, cancelledFromState: "inflight", terminal: false }
          };
        }
        // pending in the outbox: it is now settled as superseded there.
        finalizeSuperseded(
          sendStore.revokeById(ledger.id, { reason, correlationId: options.correlationId,
            eventId: options.eventId, generation: options.generation, source: options.source, at: now() }).row,
          reason
        );
        return {
          statusCode: 200, location: "pending",
          body: { ok: true, ...common, status: "superseded", state: "superseded",
            cancelled: true, alreadyCancelled: false, cancelledFromState: "pending", terminal: true }
        };
      }
    }

    // A plain consumer cancel of an in-flight gateway task must also stop it.
    if (!superseding && outbox && gatewayRequestId) {
      const revoked = outbox.revokeRequest(gatewayRequestId, { cause: CAUSE_CANCEL, reason });
      if (revoked.found && revoked.state === "inflight") {
        activeCancellationRequests.add(String(jobId || ""));
        sendStore.markById(ledger.id, "cancelled", "cancelled_by_consumer_active");
        onEvent({ type: "send_cancel_requested", requestId, jobId, to: ledger.to_number, at: new Date(now()).toISOString() });
        return {
          statusCode: 200, location: "inflight",
          body: { ok: true, ...common, status: "cancelled", state: "cancelled",
            cancelled: true, alreadyCancelled: false, cancelledFromState: "inflight", terminal: true }
        };
      }
    }

    // ── 2. BullMQ state ──────────────────────────────────────────────────────
    const live = jobId && queue ? await queue.jobStatus(jobId).catch(() => null) : null;

    if (live?.state === "active" || ledger.status === "active") {
      if (jobId) activeCancellationRequests.add(String(jobId));
      if (superseding) {
        // Cooperative revocation: the worker consults this row before the SMS
        // leaves and finalizes as superseded. Status stays 'active' until then.
        sendStore.revokeById(ledger.id, { reason, correlationId: options.correlationId,
          eventId: options.eventId, generation: options.generation, source: options.source, at: now() });
        onEvent({
          type: "send_revocation_requested", requestId, jobId, status: "revoked",
          revokedFromState: "active", reason, correlationId: options.correlationId,
          at: new Date(now()).toISOString()
        });
        return {
          statusCode: 200, location: "active",
          body: { ok: true, ...common, status: "revoked", state: "revoked",
            cancelled: true, alreadyCancelled: false, cancelledFromState: "active", terminal: false }
        };
      }
      sendStore.markById(ledger.id, "cancelled", "cancelled_by_consumer_active");
      onEvent({ type: "send_cancel_requested", requestId, jobId, to: ledger.to_number, at: new Date(now()).toISOString() });
      return {
        statusCode: 200, location: "active",
        body: { ok: true, ...common, status: "cancelled", state: "cancelled",
          cancelled: true, alreadyCancelled: false, cancelledFromState: "active", terminal: true }
      };
    }

    if (jobId && live) {
      const result = await queue.cancelPendingJob(jobId).catch((error) => ({
        cancelled: false, reason: "queue_remove_failed", error: error.message, state: live.state
      }));
      if (!result.cancelled) {
        if (!superseding) {
          return {
            statusCode: 409,
            location: "pending",
            body: {
              ok: false, error: "not_cancellable",
              reason: result.reason === "active" ? "already_active" :
                (["completed", "failed"].includes(result.state) ? "already_terminal" : result.reason),
              ...common, status: ledger.status, state: result.state || live.state
            }
          };
        }
        // Superseding: removing the job is an optimisation, not the guarantee.
        // The durable tombstone already makes it unsendable, so report success
        // and record that the queue cleanup itself failed.
        bump(METRICS.queueRemovalFailures);
        finalizeSuperseded(
          sendStore.revokeById(ledger.id, { reason, correlationId: options.correlationId,
            eventId: options.eventId, generation: options.generation, source: options.source, at: now() }).row,
          reason
        );
        return {
          statusCode: 200, location: "pending",
          body: { ok: true, ...common, status: "superseded", state: "superseded",
            cancelled: true, alreadyCancelled: false, cancelledFromState: result.state || live.state,
            terminal: true, queueRemovalFailed: true }
        };
      }
      if (superseding) {
        finalizeSuperseded(
          sendStore.revokeById(ledger.id, { reason, correlationId: options.correlationId,
            eventId: options.eventId, generation: options.generation, source: options.source, at: now() }).row,
          reason
        );
        return {
          statusCode: 200, location: "pending",
          body: { ok: true, ...common, status: "superseded", state: "superseded",
            cancelled: true, alreadyCancelled: false, cancelledFromState: result.state || live.state, terminal: true }
        };
      }
      sendStore.markById(ledger.id, "cancelled", "cancelled_by_consumer");
      onEvent({ type: "send_cancelled", requestId, jobId, to: ledger.to_number, at: new Date(now()).toISOString() });
      return {
        statusCode: 200, location: "pending",
        body: { ok: true, ...common, status: "cancelled", state: "cancelled",
          cancelled: true, alreadyCancelled: false, cancelledFromState: result.state || live.state, terminal: true }
      };
    }

    // ── 3. No queue job at all (Redis pruned/lost it) ─────────────────────────
    if (superseding) {
      finalizeSuperseded(
        sendStore.revokeById(ledger.id, { reason, correlationId: options.correlationId,
          eventId: options.eventId, generation: options.generation, source: options.source, at: now() }).row,
        reason
      );
      return {
        statusCode: 200, location: "pending",
        body: { ok: true, ...common, status: "superseded", state: "superseded",
          cancelled: true, alreadyCancelled: false, cancelledFromState: null, terminal: true }
      };
    }
    sendStore.markById(ledger.id, "cancelled", "cancelled_by_consumer_missing_queue_job");
    onEvent({ type: "send_cancelled", requestId, jobId, to: ledger.to_number, reason: "queue_job_missing", at: new Date(now()).toISOString() });
    return {
      statusCode: 200, location: "pending",
      body: { ok: true, ...common, status: "cancelled", state: "cancelled",
        cancelled: true, alreadyCancelled: false, cancelledFromState: null, terminal: true }
    };
  }

  /**
   * POST /send/invalidate — invalidate every outstanding notification of one
   * service whose generation is behind the caller's.
   *
   * Callers are responsible for authorization; this function owns the ordering
   * that makes the operation crash-safe:
   *   replay -> watermark -> ADVANCE -> revoke -> count -> remember.
   * Advancing before the revoke loop means a crash mid-loop leaves the barrier
   * in place, so the rows the loop never reached are still undeliverable.
   */
  async function invalidate(input = {}) {
    const source = String(input.source || "").trim();
    const serviceKey = String(input.serviceKey || "").trim();
    const requestedGeneration = Number.isInteger(input.currentGeneration) ? input.currentGeneration : null;
    const reason = input.reason || null;
    const correlationId = input.correlationId || null;
    const eventId = input.eventId || null;
    const requestedKinds = Array.isArray(input.invalidateKinds)
      ? input.invalidateKinds.map((kind) => String(kind).trim().toLowerCase()).filter(Boolean)
      : [];
    // An omitted/empty list means "every depletion kind" (the documented
    // contract), NOT "every notification": a transactional confirmation states
    // something that already happened and is never invalidated, not even when a
    // caller explicitly lists it.
    const kinds = (requestedKinds.length ? requestedKinds : [...DEPLETION_KINDS])
      .filter((kind) => !TRANSACTIONAL_KINDS.includes(kind));

    const identity = { source, serviceKey, currentGeneration: requestedGeneration, reason, correlationId, eventId };

    // 1. Replay BEFORE the watermark check, so a retry of an already-applied
    //    invalidation returns its original answer instead of a stale_generation
    //    error it did not deserve.
    if (eventId) {
      const replayed = sendStore.invalidationResult(eventId);
      if (replayed) {
        onAudit({ type: "invalidation_replayed", ...identity });
        return { statusCode: 200, body: { ...replayed, replayed: true } };
      }
    }

    // 2. Monotonic watermark: an out-of-order (older) invalidation must never
    //    revoke a notification a newer lifecycle already owns.
    if (requestedGeneration !== null) {
      const recorded = sendStore.generationFor(source, serviceKey);
      if (recorded !== null && requestedGeneration < recorded) {
        bump(METRICS.staleGenerationRejected);
        return {
          statusCode: 409,
          body: {
            ok: false, error: "stale_generation", serviceKey,
            currentGeneration: recorded, receivedGeneration: requestedGeneration, correlationId
          }
        };
      }
    }

    // 3. Barrier first (see above), then select.
    if (requestedGeneration !== null) {
      sendStore.advanceGeneration(source, serviceKey, requestedGeneration, kinds);
    }

    const rows = sendStore.invalidatableSends(source, serviceKey, 500, input.keyName || null);
    const counts = { cancelledPending: 0, revokedActive: 0, revokedInflight: 0, alreadyTerminal: 0 };
    let matched = 0;
    for (const row of rows) {
      const kind = String(row.notification_kind || "").trim().toLowerCase();
      if (!kinds.includes(kind)) continue;
      matched += 1;
      const decision = await cancelOne(sendStore.requestId(row.id), {
        cause: CAUSE_SUPERSEDED, reason, correlationId, eventId,
        generation: requestedGeneration, source
      });
      if (decision.location === "terminal") counts.alreadyTerminal += 1;
      else if (decision.location === "pending") counts.cancelledPending += 1;
      else if (decision.location === "active") counts.revokedActive += 1;
      else if (decision.location === "inflight") counts.revokedInflight += 1;
      else if (decision.location === "missing") counts.alreadyTerminal += 1;
    }

    const response = {
      ok: true,
      source,
      serviceKey,
      currentGeneration: requestedGeneration !== null
        ? (sendStore.generationFor(source, serviceKey) ?? requestedGeneration)
        : null,
      cancelledPending: counts.cancelledPending,
      revokedActive: counts.revokedActive,
      revokedInflight: counts.revokedInflight,
      alreadyTerminal: counts.alreadyTerminal,
      matched,
      reason,
      correlationId,
      eventId,
      replayed: false
    };

    bump(METRICS.invalidations);
    if (eventId) sendStore.rememberInvalidation(eventId, { source, serviceKey, response });
    onAudit({ type: "lifecycle_invalidation", ...identity, ...counts, matched });
    log?.info?.({ serviceKey, currentGeneration: requestedGeneration, ...counts, matched, correlationId },
      "lifecycle invalidation applied");
    return { statusCode: 200, body: response };
  }

  /**
   * The impossible-unsend case. A revoked task reported a REAL submission, so
   * the physical outcome wins: the row goes back to 'sent' with the race
   * recorded, counted and audited. It must never be reported as a cancellation.
   */
  function auditSentAfterRevocation(row, details = {}) {
    if (!row) return false;
    sendStore.recordSentAfterRevocation(row.id, details.result || details);
    bump(METRICS.sentAfterRevocation);
    const payload = {
      type: "send_sent_after_revocation",
      requestId: sendStore.requestId(row.id),
      jobId: row.job_id || null,
      gatewayRequestId: row.gateway_request_id || null,
      serviceKey: row.service_key || null,
      notificationKind: row.notification_kind || null,
      generation: row.notification_generation ?? null,
      correlationId: row.correlation_id || null,
      revocationReason: row.revocation_reason || null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      state: "sent_after_revocation",
      transport: details.transport || "android-pull",
      at: new Date(now()).toISOString()
    };
    // Distinct types on purpose: the SSE event is a lifecycle signal, the audit
    // entry is an operator-trail row. Spreading the payload last used to clobber
    // the audit type with the SSE one.
    onAudit({ ...payload, type: "sent_after_revocation" });
    onEvent(payload);
    log?.error?.({ ...payload }, "superseded notification was physically sent before the revocation landed");
    return true;
  }

  return {
    METRICS,
    guardForJob,
    cancelOne,
    invalidate,
    finalizeSuperseded,
    auditSentAfterRevocation
  };
}

module.exports = { createSendRevocation, METRICS, CAUSE_CANCEL, CAUSE_SUPERSEDED, BULLMQ_PENDING_STATES };
