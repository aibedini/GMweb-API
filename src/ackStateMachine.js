"use strict";
// The ONE ACK state machine.
//
// Before this module, ACK meaning was spread across AndroidOutbox (memory +
// tombstones), gatewayRoutes, sendRevocation and SendStore, and the replay
// branch collapsed every late successful ACK into \`sent_after_revocation\` —
// labelling a perfectly ordinary retried ACK as a revoked-then-sent race.
//
// Everything below is pure: durable row + outbox memory + what the phone
// reported in, a canonical decision out. Both the bridge and the HTTP route
// consume it, so a process restart cannot change ACK semantics.

const OUTCOME = Object.freeze({
  SENT: "sent",
  SENT_AFTER_REVOCATION: "sent_after_revocation",
  SUPERSEDED: "superseded",
  CANCELLED: "cancelled",
  FAILED: "failed"
});

// Audit reasons. "sent_after_revocation" means exactly one thing: the task was
// durably revoked and the SIM had already taken it. Reconciliation reasons are
// separate so an operator can tell them apart.
const AUDIT = Object.freeze({
  SENT_AFTER_REVOCATION: "sent_after_revocation",
  LATE_UNVERIFIED: "late_ack_confirmed_unverified",
  LATE_FAILED: "late_ack_confirmed_failed",
  LATE_CANCELLED: "late_ack_confirmed_cancelled",
  LATE_UNSETTLED: "late_ack_confirmed_unsettled"
});

const TERMINAL_DURABLE = Object.freeze({
  sent: true, unverified: true, failed: true, suppressed: true, cancelled: true, superseded: true
});

function normalizeReported(reported = {}) {
  const raw = String(reported.outcome || "").toLowerCase();
  if (raw === OUTCOME.SENT || raw === OUTCOME.SUPERSEDED || raw === OUTCOME.FAILED) return raw;
  return reported.ok ? OUTCOME.SENT : OUTCOME.FAILED;
}

/** Was the task durably revoked (lifecycle invalidation) or cancelled by a consumer? */
function revocationOf(durable, revoked) {
  if (revoked && revoked.cause) return revoked;
  if (!durable) return null;
  if (durable.revoked_at) {
    return {
      cause: String(durable.status || "") === "cancelled" ? "cancel" : "superseded",
      reason: durable.revocation_reason || null
    };
  }
  if (String(durable.status || "") === "cancelled") return { cause: "cancel", reason: durable.error || null };
  return null;
}

function replay(previousOutcome, reason) {
  const sent = previousOutcome === OUTCOME.SENT || previousOutcome === OUTCOME.SENT_AFTER_REVOCATION;
  return {
    handled: true,
    outcome: previousOutcome,
    successful: sent,
    terminal: true,
    // A settled task is never retried, whatever it settled as.
    retryable: false,
    duplicate: true,
    newlyRecorded: false,
    counted: false,
    transition: null,
    audit: null,
    reason: reason || "duplicate_ack"
  };
}

/**
 * @param {object} input
 * @param {object} input.reported   { ok, outcome, reason, sentAt }
 * @param {"pending"|"inflight"|"settled"|null} [input.memory]  outbox state
 * @param {string|null} [input.memoryOutcome]  outcome already settled in memory
 * @param {{cause:string,reason:string|null}|null} [input.revoked]
 * @param {object|null} [input.durable]  the sendStore row (byGatewayRequest)
 * @returns {object} canonical decision
 */
function decideAck(input = {}) {
  const reported = normalizeReported(input.reported || {});
  const durable = input.durable || null;
  const memory = input.memory || null;
  const revocation = revocationOf(durable, input.revoked || null);
  const revoked = Boolean(revocation);
  const reason = input.reported?.reason || revocation?.reason || null;

  // ── 1. A live bridge task: the normal path ────────────────────────────────
  if (memory === "pending" || memory === "inflight") {
    if (reported === OUTCOME.SUPERSEDED) {
      return {
        handled: true, outcome: OUTCOME.SUPERSEDED, successful: false, terminal: true,
        retryable: false, duplicate: false, newlyRecorded: true, counted: false,
        transition: "superseded", audit: null, reason
      };
    }
    if (reported === OUTCOME.SENT) {
      // Physical truth. "sent_after_revocation" is reserved for a task that was
      // ACTUALLY revoked before the submission.
      return {
        handled: true,
        outcome: revoked ? OUTCOME.SENT_AFTER_REVOCATION : OUTCOME.SENT,
        successful: true, terminal: true, retryable: false,
        duplicate: false, newlyRecorded: true, counted: true,
        transition: revoked ? "sent_after_revocation" : "sent",
        audit: revoked ? AUDIT.SENT_AFTER_REVOCATION : null,
        reason
      };
    }
    // failed
    if (revoked) {
      // Never retry a revoked task, even when the device reports a failure.
      return {
        handled: true, outcome: OUTCOME.SUPERSEDED, successful: false, terminal: true,
        retryable: false, duplicate: false, newlyRecorded: true, counted: false,
        transition: "superseded", audit: null, reason: reason || "revoked_task_failed"
      };
    }
    return {
      handled: true, outcome: OUTCOME.FAILED, successful: false, terminal: false,
      // The logical BullMQ job may still retry; `terminal` describes the task
      // outcome, `retryable` describes whether another attempt may happen.
      retryable: true, duplicate: false, newlyRecorded: true, counted: false,
      transition: "failed", audit: null, reason
    };
  }

  // ── 2. Already settled in memory ─────────────────────────────────────────
  if (memory === "settled" && input.memoryOutcome) {
    const previous = input.memoryOutcome;
    const previousWasSend = previous === OUTCOME.SENT || previous === OUTCOME.SENT_AFTER_REVOCATION;
    if (reported === OUTCOME.SENT && !previousWasSend) {
      // A real submission CONTRADICTS a settled non-send (superseded, cancelled
      // or failed). The physical truth wins and is recorded exactly once — the
      // case where a device that was offline past the revocation lease reports
      // the SMS it had already handed to the modem.
      return {
        handled: true,
        outcome: revoked ? OUTCOME.SENT_AFTER_REVOCATION : OUTCOME.SENT,
        successful: true, terminal: true, retryable: false,
        duplicate: false, newlyRecorded: true, counted: true,
        transition: revoked ? "sent_after_revocation" : "sent",
        audit: revoked
          ? AUDIT.SENT_AFTER_REVOCATION
          : (previous === OUTCOME.CANCELLED ? AUDIT.LATE_CANCELLED
            : previous === OUTCOME.FAILED ? AUDIT.LATE_FAILED : AUDIT.LATE_UNSETTLED),
        reason
      };
    }
    // Otherwise a replay: same answer, nothing mutated.
    return replay(previous, "duplicate_ack");
  }

  // ── 3. No live memory: answer from DURABLE state ─────────────────────────
  if (!durable) {
    if (memory === "released") {
      // The job ended and the bridge handed the task back, but the phone may
      // still have been working on it. A late report for a RELEASED task is
      // real evidence about a task we know existed — not an unknown id.
      if (reported === OUTCOME.SENT) {
        return {
          handled: true,
          outcome: revoked ? OUTCOME.SENT_AFTER_REVOCATION : OUTCOME.SENT,
          successful: true, terminal: true, retryable: false,
          duplicate: false, newlyRecorded: true, counted: true,
          transition: revoked ? "sent_after_revocation" : "sent",
          audit: revoked ? AUDIT.SENT_AFTER_REVOCATION : AUDIT.LATE_UNSETTLED,
          reason
        };
      }
      if (reported === OUTCOME.SUPERSEDED) {
        return {
          handled: true, outcome: OUTCOME.SUPERSEDED, successful: false, terminal: true,
          retryable: false, duplicate: false, newlyRecorded: true, counted: false,
          transition: "superseded", audit: null, reason
        };
      }
      // The job is over, so nothing will retry it.
      return {
        handled: true, outcome: OUTCOME.FAILED, successful: false, terminal: true,
        retryable: false, duplicate: false, newlyRecorded: true, counted: false,
        transition: "failed", audit: null, reason
      };
    }
    // Unknown id. Never fabricate a delivery fact.
    return {
      handled: false, outcome: null, successful: null, terminal: false,
      retryable: false, duplicate: false, newlyRecorded: false, counted: false,
      transition: null, audit: null, reason: "unknown_gateway_request_id"
    };
  }

  const status = String(durable.status || "").toLowerCase();
  const sentAfterRevocationStamp = (() => {
    try { return JSON.parse(durable.result_json || "{}")?.sentAfterRevocation === true; } catch { return false; }
  })();

  if (status === "sent") {
    return replay(sentAfterRevocationStamp ? OUTCOME.SENT_AFTER_REVOCATION : OUTCOME.SENT, "durable_sent");
  }
  if (status === "superseded") {
    if (reported === OUTCOME.SENT && revoked) {
      // Real submission after a durable revocation: physical truth wins and is
      // audited EXACTLY once (newlyRecorded false afterwards).
      return {
        handled: true, outcome: OUTCOME.SENT_AFTER_REVOCATION, successful: true, terminal: true,
        retryable: false, duplicate: false, newlyRecorded: true, counted: true,
        transition: "sent_after_revocation", audit: AUDIT.SENT_AFTER_REVOCATION, reason
      };
    }
    return replay(OUTCOME.SUPERSEDED, "durable_superseded");
  }
  if (status === "cancelled") {
    if (reported === OUTCOME.SENT) {
      return {
        handled: true,
        outcome: revoked ? OUTCOME.SENT_AFTER_REVOCATION : OUTCOME.SENT,
        successful: true, terminal: true, retryable: false,
        duplicate: false, newlyRecorded: true, counted: true,
        transition: revoked ? "sent_after_revocation" : "sent",
        audit: revoked ? AUDIT.SENT_AFTER_REVOCATION : AUDIT.LATE_CANCELLED,
        reason
      };
    }
    return replay(OUTCOME.CANCELLED, "durable_cancelled");
  }
  if (status === "unverified") {
    if (reported === OUTCOME.SENT) {
      // The server never knew whether the SIM took it. This is new evidence:
      // reconcile to \`sent\` exactly once, never a revocation audit.
      return {
        handled: true, outcome: OUTCOME.SENT, successful: true, terminal: true,
        retryable: false, duplicate: false, newlyRecorded: true, counted: true,
        transition: "sent", audit: AUDIT.LATE_UNVERIFIED, reason
      };
    }
    return replay(OUTCOME.FAILED, "durable_unverified");
  }
  if (status === "failed" || status === "suppressed") {
    if (reported === OUTCOME.SENT && status === "failed") {
      // Documented physical-truth policy: a real submission outranks a recorded
      // failure. It is NOT a revocation race unless the row was revoked.
      return {
        handled: true,
        outcome: revoked ? OUTCOME.SENT_AFTER_REVOCATION : OUTCOME.SENT,
        successful: true, terminal: true, retryable: false,
        duplicate: false, newlyRecorded: true, counted: true,
        transition: revoked ? "sent_after_revocation" : "sent",
        audit: revoked ? AUDIT.SENT_AFTER_REVOCATION : AUDIT.LATE_FAILED,
        reason
      };
    }
    return replay(OUTCOME.FAILED, `durable_${status}`);
  }
  if (status === "queued" || status === "active") {
    // The row is not terminal but no worker is waiting (process restart, or an
    // attempt that already gave up). A proven submission is still the truth.
    if (reported === OUTCOME.SENT) {
      return {
        handled: true,
        outcome: revoked ? OUTCOME.SENT_AFTER_REVOCATION : OUTCOME.SENT,
        successful: true, terminal: true, retryable: false,
        duplicate: false, newlyRecorded: true, counted: true,
        transition: revoked ? "sent_after_revocation" : "sent",
        audit: revoked ? AUDIT.SENT_AFTER_REVOCATION : AUDIT.LATE_UNSETTLED,
        reason
      };
    }
    if (reported === OUTCOME.SUPERSEDED) {
      return {
        handled: true, outcome: OUTCOME.SUPERSEDED, successful: false, terminal: true,
        retryable: false, duplicate: false, newlyRecorded: true, counted: false,
        transition: "superseded", audit: null, reason
      };
    }
    return {
      handled: true, outcome: OUTCOME.FAILED, successful: false, terminal: false,
      retryable: true, duplicate: false, newlyRecorded: true, counted: false,
      transition: "failed", audit: null, reason
    };
  }

  // Any other status: fail safe, change nothing.
  return {
    handled: false, outcome: null, successful: null, terminal: TERMINAL_DURABLE[status] === true,
    retryable: false, duplicate: false, newlyRecorded: false, counted: false,
    transition: null, audit: null, reason: `unhandled_status_${status || "unknown"}`
  };
}

module.exports = { decideAck, OUTCOME, AUDIT };
