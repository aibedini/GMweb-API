"use strict";
// Consumer notification identity (Eve lifecycle notifications) — the shared,
// pure contract between POST /send, POST /send/invalidate, the durable send
// ledger and the Android gateway bridge.
//
// This module is intentionally dependency-free so every layer can import the
// SAME allowlist and bounds instead of re-declaring them: a kind that one layer
// accepts and another rejects is exactly how a stale "your volume ended" SMS
// survives a renewal.
//
// Vocabulary
//   serviceKey    opaque consumer identity of ONE service
//                 ("eve:<serverId>:<clientUuid>"). NEVER a phone number: the
//                 same customer may own several services on one MSISDN, and
//                 renewing one must not cancel the others.
//   generation    monotonic lifecycle counter for that service. A renewal
//                 publishes a HIGHER generation; anything below the recorded
//                 watermark is stale forever.
//   notificationKind  what the message claims. Depletion claims are validated
//                 against live service state; transactional confirmations are
//                 not, and are therefore never revocable by a renewal.

const NOTIFICATION_KINDS = Object.freeze([
  "near_expiry",
  "low_volume",
  "expired",
  "volume_ended",
  "created",
  "renew"
]);

// A depletion claim can be falsified by a renewal that happened after it was
// queued, so it must be validated (and is invalidatable).
const DEPLETION_KINDS = Object.freeze([
  "near_expiry", "low_volume", "expired", "volume_ended"
]);

// A transactional confirmation states a fact that already happened; revoking it
// would tell the customer nothing after a successful renewal.
const TRANSACTIONAL_KINDS = Object.freeze(["created", "renew"]);

const NOTIFICATION_TEXT_LIMITS = Object.freeze({
  source: 32,
  serviceKey: 200,
  notificationKind: 48,
  correlationId: 64,
  reason: 64,
  eventId: 200
});

// Bounded non-negative integer. Keeps a hostile/garbage generation from
// poisoning the watermark comparison.
const MAX_GENERATION = 2147483647;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function boundedText(value, limit) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(CONTROL_CHARS, "").trim();
  if (!text) return null;
  return text.slice(0, limit);
}

function boundedGeneration(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return null;
  if (number < 0 || number > MAX_GENERATION) return null;
  return number;
}

/**
 * The requiresValidation rule is OURS, not the caller's: it is derived from the
 * kind so a client cannot turn a depletion claim into an unvalidated one by
 * sending requiresValidation:false. Unknown kinds fail closed (validated).
 */
function requiresValidationForKind(kind) {
  if (!kind) return false;
  return !TRANSACTIONAL_KINDS.includes(kind);
}

/**
 * Whitelist + bound a posted meta object. Unknown keys are dropped: the ledger
 * must never become a dumping ground for arbitrary consumer payloads.
 */
function normalizeNotificationMeta(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const kind = boundedText(source.notificationKind, NOTIFICATION_TEXT_LIMITS.notificationKind);
  return {
    source: boundedText(source.source, NOTIFICATION_TEXT_LIMITS.source),
    serviceKey: boundedText(source.serviceKey, NOTIFICATION_TEXT_LIMITS.serviceKey),
    notificationKind: kind,
    correlationId: boundedText(source.correlationId, NOTIFICATION_TEXT_LIMITS.correlationId),
    generation: boundedGeneration(source.generation),
    requiresValidation: requiresValidationForKind(kind)
  };
}

/**
 * Route-level validation for POST /send's optional "meta".
 *
 * Returns { ok:true, meta:null } when the caller sent no usable metadata (the
 * legacy payload — it must keep working exactly as before), { ok:true, meta }
 * for a complete, allowlisted tag, and { ok:false, error } otherwise. A partial
 * tag is rejected rather than silently stored, because a tag that cannot be
 * revoked is worse than no tag at all.
 */
function validateNotificationMeta(raw) {
  if (raw === undefined || raw === null) return { ok: true, meta: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "meta_must_be_an_object" };
  }
  const meta = normalizeNotificationMeta(raw);
  const present = [raw.source, raw.serviceKey, raw.notificationKind, raw.generation]
    .some((value) => value !== undefined && value !== null && value !== "");
  if (!present) return { ok: true, meta: null };
  if (!meta.source) return { ok: false, error: "meta_source_required" };
  if (!meta.serviceKey || meta.serviceKey.length < 3) {
    return { ok: false, error: "meta_service_key_required" };
  }
  if (!meta.notificationKind) return { ok: false, error: "meta_notification_kind_required" };
  if (!NOTIFICATION_KINDS.includes(meta.notificationKind)) {
    return { ok: false, error: "meta_notification_kind_unknown", allowed: [...NOTIFICATION_KINDS] };
  }
  if (meta.generation === null) return { ok: false, error: "meta_generation_required" };
  return { ok: true, meta };
}

/**
 * Which of a service's outstanding sends a lifecycle invalidation targets.
 *
 * Pure so the selection rule is testable without HTTP, Redis or a live queue:
 * an empty kind list means "every depletion kind", and a send that carries no
 * notificationKind at all is never matched (an untagged message is not a claim
 * about service state and must not be revoked by a renewal).
 */
function selectInvalidatableSends(rows, kinds) {
  const wanted = new Set(
    (Array.isArray(kinds) ? kinds : [])
      .map((kind) => String(kind || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (!wanted.size) return [...(rows || [])];
  return (rows || []).filter((row) => {
    const kind = String(row?.notification_kind || "").trim().toLowerCase();
    return kind && wanted.has(kind);
  });
}

/**
 * Fold the per-send cancel decisions into the contract's counters. A send that
 * was already terminal when the invalidation arrived is REPORTED, never
 * silently dropped -- that count is how an operator sees "it had already gone".
 */
function summarizeInvalidation(rows, decisions) {
  const counts = {
    cancelledPending: 0,
    revokedActive: 0,
    revokedInflight: 0,
    alreadyTerminal: 0
  };
  (rows || []).forEach((row, index) => {
    const decision = decisions[index] || {};
    const body = decision.body || {};
    if (body.error === "not_cancellable" && body.reason === "already_terminal") {
      counts.alreadyTerminal += 1;
      return;
    }
    if (!body.cancelled) return;
    const stateBefore = String(row?.status || "").toLowerCase();
    if (stateBefore === "queued") counts.cancelledPending += 1;
    else if (stateBefore === "active") counts.revokedActive += 1;
    else counts.revokedInflight += 1;
  });
  return counts;
}

/**
 * The durable revocation barrier.
 *
 * A notification is superseded when either
 *   - the ledger row itself was revoked/superseded, or
 *   - its service generation is BELOW the watermark this gateway recorded for
 *     that service.
 *
 * The second rule is what makes the fix survive a crash: even a row that was
 * never individually visited by an invalidation (the process died mid-loop, the
 * job was delayed in Redis, a retry arrived hours later) can never be delivered
 * once a newer generation is on record.
 */
function isSupersededNotification(row, barrier) {
  if (!row) return false;
  const status = String(row.status || "").toLowerCase();
  if (status === "superseded") return true;
  if (row.revoked_at !== null && row.revoked_at !== undefined) return true;
  const generation = row.notification_generation;
  if (generation === null || generation === undefined) return false;
  if (!row.service_key) return false;
  // A plain number is accepted for callers that only track the watermark; the
  // full barrier also scopes which KINDS that watermark invalidated, so a
  // renewal that only revoked "volume_ended" cannot silently block an
  // "expired" reminder the consumer still considers valid.
  const watermark = typeof barrier === "number" ? barrier : barrier?.generation;
  if (watermark === null || watermark === undefined) return false;
  if (!(Number(generation) < Number(watermark))) return false;
  const kinds = typeof barrier === "number" ? null : barrier?.kinds;
  if (Array.isArray(kinds) && kinds.length) {
    const kind = String(row.notification_kind || "").trim().toLowerCase();
    if (!kind || !kinds.includes(kind)) return false;
  }
  return true;
}

// Terminal states of the durable send ledger. "superseded" is terminal, NOT
// successful, NOT billable and NOT retryable.
const TERMINAL_SEND_STATUSES = Object.freeze([
  "sent", "unverified", "failed", "suppressed", "cancelled", "superseded"
]);

function isTerminalSendStatus(status) {
  return TERMINAL_SEND_STATUSES.includes(String(status || "").toLowerCase());
}

module.exports = {
  NOTIFICATION_KINDS,
  DEPLETION_KINDS,
  TRANSACTIONAL_KINDS,
  NOTIFICATION_TEXT_LIMITS,
  MAX_GENERATION,
  TERMINAL_SEND_STATUSES,
  boundedText,
  boundedGeneration,
  requiresValidationForKind,
  normalizeNotificationMeta,
  validateNotificationMeta,
  selectInvalidatableSends,
  summarizeInvalidation,
  isSupersededNotification,
  isTerminalSendStatus
};
