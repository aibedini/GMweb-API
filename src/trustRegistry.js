"use strict";

/**
 * ADR-001 Signed Trust Registry relay — GMweb NEVER authorizes devices.
 *
 * Android's Trust Root key signs every trust statement (DEVICE_APPROVED,
 * DEVICE_REVOKED, DEVICE_CAPABILITIES_CHANGED, DEVICE_KEY_ROTATED) with a
 * monotonic per-account trustSequence. GMweb:
 *   - stores the latest snapshot + the statement log (relay/persistence only),
 *   - serves them to all clients via /api/v1/trust/*,
 *   - verifies nothing beyond structural sanity (clients verify rootSignature
 *     locally; a forged statement simply fails client-side verification).
 *
 * Fail-safe model: a compromised GMweb can censor/delay trust updates
 * (availability attack) but cannot mint devices, forge revocations, add
 * capabilities or swap public keys — the rootSignature check on the client
 * rejects anything it fabricates.
 *
 * Durable via better-sqlite3 (same store family as the rest of GMweb).
 */

class TrustRegistry {
  /**
   * @param {import("better-sqlite3").Database} db
   */
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS trust_statements (
        account_id   TEXT NOT NULL,
        trust_sequence INTEGER NOT NULL,
        statement_id TEXT NOT NULL,
        operation    TEXT NOT NULL,
        device_id    TEXT,
        payload      TEXT NOT NULL,
        root_signature TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (account_id, trust_sequence)
      );
      CREATE TABLE IF NOT EXISTS trust_snapshots (
        account_id    TEXT PRIMARY KEY,
        trust_sequence INTEGER NOT NULL,
        root_public_key TEXT NOT NULL,
        snapshot      TEXT NOT NULL,
        updated_at    INTEGER NOT NULL
      );
    `);
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO trust_statements
       (account_id, trust_sequence, statement_id, operation, device_id, payload, root_signature, created_at)
       VALUES (@account_id, @trust_sequence, @statement_id, @operation, @device_id, @payload, @root_signature, @created_at)`
    );
    this.listStmt = db.prepare(
      `SELECT * FROM trust_statements WHERE account_id = ? AND trust_sequence > ? ORDER BY trust_sequence ASC`
    );
    this.snapshotStmt = db.prepare(
      `SELECT snapshot, trust_sequence, root_public_key, updated_at FROM trust_snapshots WHERE account_id = ?`
    );
    this.upsertSnapshotStmt = db.prepare(
      `INSERT INTO trust_snapshots (account_id, trust_sequence, root_public_key, snapshot, updated_at)
       VALUES (@account_id, @trust_sequence, @root_public_key, @snapshot, @updated_at)
       ON CONFLICT(account_id) DO UPDATE SET
         trust_sequence = excluded.trust_sequence,
         root_public_key = excluded.root_public_key,
         snapshot = excluded.snapshot,
         updated_at = excluded.updated_at`
    );
    this.maxSeqStmt = db.prepare(
      `SELECT MAX(trust_sequence) AS maxSeq FROM trust_statements WHERE account_id = ?`
    );
  }

  /**
   * Relay one Android-signed statement. Returns {applied, trustSequence}.
   * INSERT OR IGNORE: a redelivered statement (same sequence) is a no-op;
   * a genuinely NEW statement with a LOWER sequence is rejected (monotonic).
   */
  applyStatement({ accountId, statement }) {
    const seq = Number(statement.trustSequence);
    if (!Number.isInteger(seq) || seq <= 0) {
      return { applied: false, reason: "invalid_trust_sequence" };
    }
    const max = this.maxSeqStmt.get(accountId)?.maxSeq || 0;
    if (seq <= max) {
      return { applied: false, reason: "stale_sequence", currentSequence: max };
    }
    // Sequence must be exactly max+1 — no gaps (Android assigns them serially).
    if (seq !== max + 1) {
      return { applied: false, reason: "sequence_gap", expected: max + 1, received: seq };
    }
    const info = this.insertStmt.run({
      account_id: accountId,
      trust_sequence: seq,
      statement_id: String(statement.statementId || ""),
      operation: String(statement.operation || ""),
      device_id: statement.deviceId ? String(statement.deviceId) : null,
      payload: JSON.stringify(statement),
      root_signature: String(statement.rootSignature || ""),
      created_at: Date.now(),
    });
    return { applied: info.changes > 0, trustSequence: seq };
  }

  /** Store/refresh the latest Android-signed snapshot for an account. */
  putSnapshot({ accountId, trustSequence, rootPublicKey, snapshot }) {
    this.upsertSnapshotStmt.run({
      account_id: accountId,
      trust_sequence: Number(trustSequence) || 0,
      root_public_key: String(rootPublicKey || ""),
      snapshot: typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
      updated_at: Date.now(),
    });
    return { ok: true };
  }

  getSnapshot(accountId) {
    const row = this.snapshotStmt.get(accountId);
    if (!row) return null;
    let parsed = null;
    try { parsed = JSON.parse(row.snapshot); } catch { parsed = null; }
    return {
      accountId,
      trustSequence: row.trust_sequence,
      rootPublicKey: row.root_public_key,
      snapshot: parsed ?? row.snapshot,
      updatedAt: row.updated_at,
    };
  }

  /** Statements after a cursor (clients verify each rootSignature locally). */
  statementsAfter(accountId, afterSequence) {
    return this.listStmt.all(accountId, Number(afterSequence) || 0).map((r) => ({
      trustSequence: r.trust_sequence,
      statementId: r.statement_id,
      operation: r.operation,
      deviceId: r.device_id,
      payload: JSON.parse(r.payload),
      rootSignature: r.root_signature,
      createdAt: r.created_at,
    }));
  }
}

module.exports = { TrustRegistry };
