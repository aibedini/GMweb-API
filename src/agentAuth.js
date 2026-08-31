"use strict";

/**
 * PR-08b (TechSpec §57, ADR-001 LOCK 1/4) — per-device agent authentication.
 *
 * Each Android agent authenticates with its own ECDSA P-256 signature over
 * a canonical request string, using the OPERATIONAL_SIGNING key enrolled at
 * registration (PR-05). GMweb verifies against the agent's registered
 * public key and FAILS CLOSED when the key is missing/mismatched.
 *
 * Canonical string (same bytes the Android side signs — must stay in sync):
 *   METHOD\nPATH\nSHA256_HEX(bodyBytes)\nX-AGENT-TS:<epochMs>\n
 * Timestamp freshness window: 90s (±45s) — replay window tightened by the
 * nonce ledger below (last 1000 stamps cached; duplicates rejected).
 *
 * Header: X-Agent-Auth: <deviceId>:<base64(derSignature)>
 *
 * A compromised GMweb still cannot forge device commands (ADR-001); this
 * header only proves WHICH agent is speaking on the wire — server-side
 * rate/authorization stays separate.
 */

const crypto = require("node:crypto");

const REPLAY_WINDOW_MS = 90_000;
const NONCE_CACHE_MAX = 1000;

class AgentAuthService {
  /**
   * @param {import("better-sqlite3").Database} db
   */
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_identities (
        device_id          TEXT PRIMARY KEY,
        signing_public_key TEXT NOT NULL,   -- base64 uncompressed EC point
        encryption_public_key TEXT,
        trust_root_public_key TEXT,
        registered_at      INTEGER NOT NULL,
        protocol_version   INTEGER NOT NULL DEFAULT 1
      );
    `);
    this.upsertStmt = db.prepare(
      `INSERT INTO agent_identities (device_id, signing_public_key, encryption_public_key,
         trust_root_public_key, registered_at, protocol_version)
       VALUES (@device_id, @signing_public_key, @encryption_public_key,
         @trust_root_public_key, @registered_at, @protocol_version)
       ON CONFLICT(device_id) DO UPDATE SET
         signing_public_key = excluded.signing_public_key,
         encryption_public_key = excluded.encryption_public_key,
         trust_root_public_key = excluded.trust_root_public_key,
         protocol_version = excluded.protocol_version`
    );
    this.getStmt = db.prepare(`SELECT * FROM agent_identities WHERE device_id = ?`);
    this.listStmt = db.prepare(`SELECT device_id, registered_at, protocol_version FROM agent_identities`);
    this.recentStamps = []; // [timestamp, deviceId] ring for duplicate rejection
  }

  /** Registration payload (PR-05 publicKeys block) → durable identity. */
  registerIdentity({ deviceId, publicKeys, protocolVersion = 1 }) {
    if (!deviceId || !publicKeys?.signing) {
      throw new Error("deviceId and publicKeys.signing are required");
    }
    this.upsertStmt.run({
      device_id: String(deviceId),
      signing_public_key: String(publicKeys.signing),
      encryption_public_key: publicKeys.encryption ? String(publicKeys.encryption) : null,
      trust_root_public_key: publicKeys.trustRoot ? String(publicKeys.trustRoot) : null,
      registered_at: Date.now(),
      protocol_version: Number(protocolVersion) || 1,
    });
    return { ok: true };
  }

  listIdentities() {
    return this.listStmt.all();
  }

  getIdentity(deviceId) {
    return this.getStmt.get(String(deviceId)) || null;
  }

  /**
   * Verify the X-Agent-Auth header for a request. Returns
   * {ok, deviceId} or {ok:false, reason}.
   *
   * @param {object} request fastify request (headers, method, url, raw body)
   * @param {Buffer|string} rawBody the EXACT request body bytes
   */
  verifyAgentHeader(request, rawBody) {
    const header = String(request.headers["x-agent-auth"] || "");
    if (!header) return { ok: false, reason: "missing_agent_auth_header" };
    const sep = header.indexOf(":");
    if (sep <= 0) return { ok: false, reason: "malformed_agent_auth_header" };
    const deviceId = header.slice(0, sep);
    const sigB64 = header.slice(sep + 1);
    const identity = this.getIdentity(deviceId);
    if (!identity) return { ok: false, reason: "unknown_device" };

    const ts = Number(request.headers["x-agent-ts"] || 0);
    const now = Date.now();
    if (!ts || Math.abs(now - ts) > REPLAY_WINDOW_MS) {
      return { ok: false, reason: "timestamp_out_of_window" };
    }
    // Duplicate (deviceId, ts) inside the window = replay.
    const stampKey = `${deviceId}:${ts}`;
    if (this.recentStamps.some(([d, t]) => `${d}:${t}` === stampKey)) {
      return { ok: false, reason: "replayed_timestamp" };
    }
    this.recentStamps.push([deviceId, ts]);
    if (this.recentStamps.length > NONCE_CACHE_MAX) this.recentStamps.shift();

    const bodyHash = crypto
      .createHash("sha256")
      .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || "")))
      .digest("hex");
    const canonical = `POST\n${request.url.split("?")[0]}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;

    try {
      const keyObject = crypto.createPublicKey({
        key: Buffer.from(identity.signing_public_key, "base64"),
        format: "der",
        type: "spki",
      });
      const ok = crypto.verify(
        "sha256",
        Buffer.from(canonical, "utf8"),
        keyObject,
        Buffer.from(sigB64, "base64"),
      );
      return ok ? { ok: true, deviceId } : { ok: false, reason: "signature_mismatch" };
    } catch (e) {
      return { ok: false, reason: `verification_error: ${e.message}` };
    }
  }
}

module.exports = { AgentAuthService };
