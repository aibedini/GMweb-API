"use strict";
// The consumer (Eve) transport-health projection.
//
// Why this module exists: /admin/transport is master-token-only and returns a
// backward-compatible dashboard shape, so the consumer could not read transport
// health at all and every card in its SMS delivery panel rendered as "unknown".
// This module is the ONE place that turns the authoritative snapshot
// (src/transportHealth.js) into the cross-repository contract declared in
// shared/eve-gmweb-contract-v1.json.
//
// The field lists, the contract version and the device semantics are all read
// FROM that file rather than restated here, because the response shape is shared
// with a different repository. A rule restated at a call site loses clauses; a
// contract restated in two codebases drifts silently. The only thing that may
// drift is caught by the contract tests in test/eveTransportHealth.test.js.
//
// Security posture: the projection is built by explicit field selection. The
// snapshot object is NEVER spread into the response, so a field added to the
// snapshot later cannot leak here by default.

const contract = require("../shared/eve-gmweb-contract-v1.json");

const RESPONSE = contract.transportHealthResponse;

/** Declared field names per section, from the shared contract. */
function sectionFields(name) {
  const fields = RESPONSE.sections?.[name];
  return Array.isArray(fields) ? fields : [];
}

/** The declared contract version, or 0 when the shared file is unusable. */
function contractVersion() {
  const raw = Number(RESPONSE?.contractVersion);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

/** An ISO-8601 instant, or null. Unparseable input is reported as "never". */
function instantOrNull(value) {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** A non-negative integer age in ms, or null when it was never measured. */
function ageOrNull(value) {
  // `Number(null)` is 0, so an absent age must be screened out explicitly:
  // "never measured" and "measured as zero milliseconds" are different facts.
  if (value === null || value === undefined || value === "") return null;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : null;
}

/**
 * A non-active Android bridge, reported as explicitly NON-authoritative so it
 * can never be mistaken for the active delivery health.
 */
function androidPullDiagnostics(android) {
  if (!android || typeof android !== "object") return null;
  return {
    authoritative: false,
    state: String(android.state || "unknown"),
    reason: android.reason || null,
    last_seen_at: instantOrNull(android.lastPullAt),
    last_seen_age_ms: ageOrNull(android.lastPullAgeMs),
    pending: Number(android.pending || 0),
    inflight: Number(android.inflight || 0)
  };
}

/**
 * Project an authoritative snapshot into the declared consumer contract.
 *
 * @param {object} snapshot  the result of transportHealth.snapshot()
 * @param {object} [options]
 * @param {function} [options.now]  injectable clock, for deterministic tests
 */
function projectTransportHealth(snapshot, options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const androidActive = source.activeTransport === "android";
  const alternatives = source.alternatives && typeof source.alternatives === "object"
    ? source.alternatives
    : {};

  const ready = Boolean(source.ready);
  const reason = source.reason || null;
  const operationalReason = source.operationalReason || null;
  const state = String(source.state || "unknown");

  // device describes the device of the ACTIVE transport and nothing else. When
  // chrome is the active transport it has no pull presence, so the timestamp
  // fields are honestly null rather than carrying Android's fresher number.
  const lastSeenAt = androidActive ? instantOrNull(source.lastPullAt) : null;
  const lastSeenAgeMs = androidActive ? ageOrNull(source.lastPullAgeMs) : null;

  return {
    contract_version: contractVersion(),
    observed_at: new Date(now()).toISOString(),
    gmweb: {
      // `ready` is about the ACTIVE delivery transport, not about whether GMweb
      // answered: a 200 response already proves GMweb was reachable.
      ready,
      // Actionable first: "work is waiting on a device" tells an operator what
      // to do, and the transport reason alone does not.
      reason: ready ? null : (operationalReason || reason)
    },
    transport: {
      active: String(source.activeTransport || "unknown"),
      mode: source.mode ?? null,
      state,
      reason
    },
    device: {
      state,
      reason,
      last_seen_at: lastSeenAt,
      last_seen_age_ms: lastSeenAgeMs,
      // Deprecated alias. Kept so a provider-first or consumer-first rollout
      // cannot silently drop the field; consumers must read last_seen_age_ms.
      age_ms: lastSeenAgeMs
    },
    queue: {
      pending: Number(source.pending || 0),
      inflight: Number(source.inflight || 0)
    },
    last_ack: {
      at: instantOrNull(source.lastAckAt),
      outcome: source.lastAckOutcome || null
    },
    diagnostics: {
      androidPull: androidActive ? null : androidPullDiagnostics(alternatives.android)
    }
  };
}

// ── Fastify response schema ────────────────────────────────────────────────
// Fastify's serializer strips every property the response schema does not
// declare, so an undeclared field would silently never reach the consumer.
// The property NAMES come from the shared contract (one source of truth) and
// each section is left open (additionalProperties) so a field added to the
// contract can never be silently dropped here.

const FIELD_TYPES = Object.freeze({
  "gmweb.ready": { type: "boolean" },
  "gmweb.reason": { type: ["string", "null"] },
  "transport.active": { type: "string" },
  "transport.mode": { type: ["string", "null"] },
  "transport.state": { type: "string" },
  "transport.reason": { type: ["string", "null"] },
  "device.state": { type: "string" },
  "device.reason": { type: ["string", "null"] },
  "device.last_seen_at": { type: ["string", "null"] },
  "device.last_seen_age_ms": { type: ["integer", "null"] },
  "device.age_ms": {
    type: ["integer", "null"],
    deprecated: true,
    description: RESPONSE?.deprecatedAliases?.["device.age_ms"]
  },
  "queue.pending": { type: "integer" },
  "queue.inflight": { type: "integer" },
  "last_ack.at": { type: ["string", "null"] },
  "last_ack.outcome": { type: ["string", "null"] }
});

function sectionSchema(name) {
  const properties = {};
  for (const field of sectionFields(name)) {
    properties[field] = FIELD_TYPES[`${name}.${field}`] || {};
  }
  return { type: "object", properties, additionalProperties: true };
}

function diagnosticsSchema() {
  return {
    type: "object",
    properties: {
      androidPull: { type: ["object", "null"], additionalProperties: true }
    },
    additionalProperties: true
  };
}

/** The `properties` object for the route's 200 response schema. */
function responseSchemaProperties() {
  const topLevel = Array.isArray(RESPONSE?.topLevel) ? RESPONSE.topLevel : [];
  const properties = {};
  for (const name of topLevel) {
    if (name === "contract_version") properties[name] = { type: "integer" };
    else if (name === "observed_at") properties[name] = { type: "string" };
    else if (name === "diagnostics") properties[name] = diagnosticsSchema();
    else properties[name] = sectionSchema(name);
  }
  return properties;
}

module.exports = {
  projectTransportHealth,
  responseSchemaProperties,
  contractVersion,
  androidPullDiagnostics
};
