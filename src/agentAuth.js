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
    // BLOCKER 3 migration: existing databases predate device_role. SQLite
    // has no ADD COLUMN IF NOT EXISTS — inspect pragma and alter if needed.
    try {
      const cols = db.prepare("PRAGMA table_info(agent_identities)").all();
      if (cols.length > 0 && !cols.some((c) => c.name === "device_role")) {
        db.exec("ALTER TABLE agent_identities ADD COLUMN device_role TEXT NOT NULL DEFAULT 'LEGACY_AGENT'");
      }
    } catch {
      // fresh DB — the CREATE TABLE below already includes the column
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_identities (
        device_id          TEXT PRIMARY KEY,
        signing_public_key TEXT NOT NULL,   -- base64 uncompressed EC point
        encryption_public_key TEXT,
        trust_root_public_key TEXT,
        registered_at      INTEGER NOT NULL,
        protocol_version   INTEGER NOT NULL DEFAULT 1,
        -- BLOCKER 3: only PRIMARY_TRUST_AGENT may approve web pairings.
        device_role        TEXT NOT NULL DEFAULT 'LEGACY_AGENT'
      );
    `);
    this.upsertStmt = db.prepare(
      `INSERT INTO agent_identities (device_id, signing_public_key, encryption_public_key,
         trust_root_public_key, registered_at, protocol_version, device_role)
       VALUES (@device_id, @signing_public_key, @encryption_public_key,
         @trust_root_public_key, @registered_at, @protocol_version, @device_role)
       ON CONFLICT(device_id) DO UPDATE SET
         signing_public_key = excluded.signing_public_key,
         encryption_public_key = excluded.encryption_public_key,
         trust_root_public_key = excluded.trust_root_public_key,
         protocol_version = excluded.protocol_version,
         device_role = excluded.device_role`
    );
    this.getStmt = db.prepare(`SELECT * FROM agent_identities WHERE device_id = ?`);
    this.listStmt = db.prepare(`SELECT device_id, registered_at, protocol_version FROM agent_identities`);
    this.recentStamps = []; // [timestamp, deviceId] ring for duplicate rejection
  }

  /** Only a consumed dashboard setup claim grants the primary role.
   * Signed refreshes retain their existing role and immutable trust keys. */
  registerIdentity({ deviceId, publicKeys, protocolVersion = 1, forcePrimary = false }) {
    if (!deviceId || !publicKeys?.signing) {
      throw new Error("deviceId and publicKeys.signing are required");
    }
    if (forcePrimary) {
      this.db.transaction(() => {
        this.db.prepare(
          "UPDATE agent_identities SET device_role = 'LEGACY_AGENT' WHERE device_role = 'PRIMARY_TRUST_AGENT' AND device_id <> ?"
        ).run(String(deviceId));
        this._register(deviceId, publicKeys, protocolVersion, "PRIMARY_TRUST_AGENT");
      })();
      return { ok: true, role: "PRIMARY_TRUST_AGENT" };
    }
    const existing = this.getStmt.get(String(deviceId));
    const existingRole = existing ? String(existing.device_role || "LEGACY_AGENT") : null;
    const role = existingRole || "LEGACY_AGENT";
    if (existing && (existing.signing_public_key !== publicKeys.signing ||
        existing.trust_root_public_key !== (publicKeys.trustRoot || null))) {
      throw Object.assign(new Error("key changes require primary setup"), { statusCode: 403 });
    }
    this._register(deviceId, publicKeys, protocolVersion, role);
    return { ok: true, role };
  }

  /** Server-side-only role promotion (ops migration), never client-driven. */
  promotePrimary(deviceId) {
    const identity = this.getStmt.get(String(deviceId));
    if (!identity) throw new Error("unknown device");
    this._register(deviceId, {
      signing: identity.signing_public_key,
      encryption: identity.encryption_public_key,
      trustRoot: identity.trust_root_public_key,
    }, identity.protocol_version, "PRIMARY_TRUST_AGENT");
  }

  _register(deviceId, publicKeys, protocolVersion, role) {
    this.upsertStmt.run({
      device_id: String(deviceId),
      signing_public_key: String(publicKeys.signing),
      encryption_public_key: publicKeys.encryption ? String(publicKeys.encryption) : null,
      trust_root_public_key: publicKeys.trustRoot ? String(publicKeys.trustRoot) : null,
      registered_at: Date.now(),
      protocol_version: Number(protocolVersion) || 1,
      device_role: String(role),
    });
  }

  listIdentities() {
    return this.listStmt.all();
  }

  getIdentity(deviceId) {
    return this.getStmt.get(String(deviceId)) || null;
  }

  /** BLOCKER 3: explicit role for the identity (PRIMARY_TRUST_AGENT etc.). */
  getRole(deviceId) {
    const identity = this.getIdentity(deviceId);
    return identity ? String(identity.device_role || "LEGACY_AGENT") : null;
  }

  /** Promote an existing device to a role (e.g. first Android → primary). */
  setRole(deviceId, role) {
    this.upsertStmt.run({
      device_id: String(deviceId),
      signing_public_key: String(this.getIdentity(deviceId)?.signing_public_key || ""),
      encryption_public_key: this.getIdentity(deviceId)?.encryption_public_key || null,
      trust_root_public_key: this.getIdentity(deviceId)?.trust_root_public_key || null,
      registered_at: Date.now(),
      protocol_version: this.getIdentity(deviceId)?.protocol_version || 1,
      device_role: String(role),
    });
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
    const method = String(request.method || "POST").toUpperCase();
    const canonical = `${method}\n${request.url.split("?")[0]}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;

    try {
      // FIX 4 (wire format): Android v1 sent the RAW uncompressed P-256 point
      // (0x04||X||Y, 65 bytes); tests/SPKI migration use DER SPKI. Accept both:
      // raw points are wrapped into a SubjectPublicKeyInfo before import.
      const keyBytes = Buffer.from(identity.signing_public_key, "base64");
      let keyObject;
      if (keyBytes.length === 65 && keyBytes[0] === 0x04) {
        const spki = Buffer.concat([
          Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
          keyBytes,
        ]);
        keyObject = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
      } else {
        keyObject = crypto.createPublicKey({ key: keyBytes, format: "der", type: "spki" });
      }
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
