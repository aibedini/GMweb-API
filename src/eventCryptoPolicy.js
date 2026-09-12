"use strict";

const policy = require("../shared/event-crypto-policy-v1.json");

const MAX_BATCH_EVENTS = 100;
const MAX_DECODED_BATCH_BYTES = 512 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_CONTROL_BYTES = 128 * 1024;
const MAX_HTTP_BODY_BYTES = 800 * 1024;

const groups = {
  content: new Map(Object.entries(policy.contentBearing)),
  key: new Map(Object.entries(policy.controlKey)),
  control: new Map(Object.entries(policy.nonContentControl)),
};

function eventRule(type) {
  for (const [kind, entries] of Object.entries(groups)) {
    const versions = entries.get(type);
    if (versions) return { kind, versions };
  }
  return null;
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    const error = new Error("payload must be canonical base64");
    error.code = "invalid_payload_encoding";
    throw error;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    const error = new Error("payload must be canonical base64");
    error.code = "invalid_payload_encoding";
    throw error;
  }
  return decoded;
}

function validationError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateEncryptedEnvelope(event, payload) {
  let envelope;
  try { envelope = JSON.parse(payload.toString("utf8")); } catch {
    throw validationError("invalid_encrypted_envelope");
  }
  if (!envelope || Array.isArray(envelope) || envelope.v !== event.cryptoVersion ||
      envelope.kind !== "message" || envelope.eventId !== event.eventId ||
      envelope.type !== event.type || envelope.conversationId !== String(event.conversationId || "")) {
    throw validationError("invalid_encrypted_envelope");
  }
  const fields = event.cryptoVersion === 3
    ? ["iv", "ciphertext", "historyWrapIv", "historyWrappedDek", "liveWrapIv", "liveWrappedDek"]
    : ["iv", "ciphertext", "wrapIv", "wrappedDek"];
  for (const field of fields) {
    const bytes = decodeCanonicalBase64(envelope[field]);
    if (bytes.length < (field.toLowerCase().includes("iv") ? 12 : 16)) {
      throw validationError("invalid_encrypted_envelope");
    }
  }
}

function validateWireEvent(event) {
  const type = typeof event?.type === "string" ? event.type : "";
  const rule = eventRule(type);
  if (!rule) throw validationError("unknown_event_type");
  if (!Number.isInteger(event.schemaVersion) || event.schemaVersion !== 1) {
    throw validationError("unsupported_schema_version");
  }
  if (!Number.isInteger(event.cryptoVersion) || !rule.versions.includes(event.cryptoVersion)) {
    throw validationError(rule.kind === "content" ? "encrypted_payload_required" : "unsupported_crypto_version");
  }
  const expectedEncoding = event.cryptoVersion === 0 ? "envelope.v1" : `envelope.v${event.cryptoVersion}`;
  if (event.encoding !== expectedEncoding) throw validationError("invalid_payload_encoding");
  const payload = decodeCanonicalBase64(event.payload);
  const limit = rule.kind === "content" ? MAX_CONTENT_BYTES : MAX_CONTROL_BYTES;
  if (payload.length > limit) throw validationError("event_payload_too_large");
  if (rule.kind === "content") validateEncryptedEnvelope(event, payload);
  return { payload, rule };
}

function validateWireBatch(events) {
  if (!Array.isArray(events) || events.length === 0) throw validationError("events_required");
  if (events.length > MAX_BATCH_EVENTS) throw validationError("too_many_events");
  let decodedBytes = 0;
  const validated = events.map((event) => {
    const result = validateWireEvent(event);
    decodedBytes += result.payload.length;
    if (decodedBytes > MAX_DECODED_BATCH_BYTES) throw validationError("batch_payload_too_large");
    return { ...event, payload: result.payload };
  });
  return validated;
}

function validateStoredBatch(events) {
  if (!Array.isArray(events) || events.length === 0) throw validationError("events_required");
  if (events.length > MAX_BATCH_EVENTS) throw validationError("too_many_events");
  let decodedBytes = 0;
  for (const event of events) {
    const rule = eventRule(String(event?.type || ""));
    if (!rule) throw validationError("unknown_event_type");
    const schemaVersion = event.schemaVersion ?? 1;
    if (!Number.isInteger(schemaVersion) || schemaVersion !== 1) {
      throw validationError("unsupported_schema_version");
    }
    if (!Number.isInteger(event.cryptoVersion) || !rule.versions.includes(event.cryptoVersion)) {
      throw validationError(rule.kind === "content" ? "encrypted_payload_required" : "unsupported_crypto_version");
    }
    const expectedEncoding = event.cryptoVersion === 0 ? "envelope.v1" : `envelope.v${event.cryptoVersion}`;
    if ((event.encoding ?? expectedEncoding) !== expectedEncoding) throw validationError("invalid_payload_encoding");
    if (!Buffer.isBuffer(event.payload) || event.payload.length === 0) throw validationError("invalid_payload_encoding");
    const limit = rule.kind === "content" ? MAX_CONTENT_BYTES : MAX_CONTROL_BYTES;
    if (event.payload.length > limit) throw validationError("event_payload_too_large");
    decodedBytes += event.payload.length;
    if (decodedBytes > MAX_DECODED_BATCH_BYTES) throw validationError("batch_payload_too_large");
  }
}

module.exports = {
  policy,
  eventRule,
  validateWireEvent,
  validateWireBatch,
  validateStoredBatch,
  MAX_BATCH_EVENTS,
  MAX_DECODED_BATCH_BYTES,
  MAX_CONTENT_BYTES,
  MAX_CONTROL_BYTES,
  MAX_HTTP_BODY_BYTES,
};
