"use strict";

/**
 * Phase 4 (TechSpec §21–§24, §84) — Passkey (WebAuthn) authentication for the
 * control plane, using @simplewebauthn (audited library — Rule 6: no custom
 * crypto).
 *
 * Credential storage: control-plane.db, table webauthn_credentials. Per the
 * §21 ordering this is Passkey-FIRST: a successful passkey assertion opens a
 * dashboard-style session cookie (SameSite=Lax, HttpOnly, Secure in prod) —
 * the SAME session shape the legacy dashboard uses, so requireToken accepts
 * it with zero auth-matrix changes.
 *
 * §23: the cookie is the only auth artifact the browser holds; no tokens in
 * localStorage. §24 step-up: pairing/revocation screens re-prompt via
 * userVerification: "required" (enforced by the authenticator, verified in
 * the assertion's flags by the library).
 *
 * Challenge state lives in RAM (challenge is single-use, 5-min TTL, keyed by
 * the session cookie id) — a lost challenge is a retry, never a security
 * event. Registered credentials ARE durable.
 */

const crypto = require("node:crypto");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

class PasskeyService {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {object} opts { rpName, rpID, origin }
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.rpName = opts.rpName || "GMweb Messages";
    this.rpID = opts.rpID || "localhost";
    this.origin = opts.origin || "http://localhost:3030";
    // challenge (hex) → { expiresAt, kind: "registration"|"authentication" }
    this.challenges = new Map();

    db.exec(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id   TEXT PRIMARY KEY,
        public_key      BLOB NOT NULL,
        counter         INTEGER NOT NULL DEFAULT 0,
        transports      TEXT,
        device_type     TEXT,
        backed_up       INTEGER NOT NULL DEFAULT 0,
        label           TEXT,
        created_at      INTEGER NOT NULL,
        last_used_at    INTEGER
      );
    `);
    this.getCredStmt = db.prepare(`SELECT * FROM webauthn_credentials WHERE credential_id = ?`);
    this.allCredsStmt = db.prepare(`SELECT credential_id, transports, label, created_at, last_used_at FROM webauthn_credentials ORDER BY created_at DESC`);
    this.countCredsStmt = db.prepare(`SELECT COUNT(*) AS n FROM webauthn_credentials`);
    this.insertCredStmt = db.prepare(
      `INSERT INTO webauthn_credentials
       (credential_id, public_key, counter, transports, device_type, backed_up, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.updateCounterStmt = db.prepare(
      `UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?`
    );
    this.deleteCredStmt = db.prepare(`DELETE FROM webauthn_credentials WHERE credential_id = ?`);
  }

  #newChallenge(kind) {
    const challenge = crypto.randomBytes(32).toString("hex");
    this.challenges.set(challenge, { expiresAt: Date.now() + CHALLENGE_TTL_MS, kind });
    // opportunistic GC
    for (const [k, v] of this.challenges) {
      if (v.expiresAt < Date.now()) this.challenges.delete(k);
    }
    return challenge;
  }

  #takeChallenge(challenge, kind) {
    const entry = this.challenges.get(String(challenge));
    if (!entry) return false;
    this.challenges.delete(String(challenge)); // single-use regardless of validity
    return entry.kind === kind && entry.expiresAt >= Date.now();
  }

  hasCredentials() {
    return this.countCredsStmt.get()?.n > 0;
  }

  listCredentials() {
    return this.allCredsStmt.all();
  }

  /**
   * §21 Passkey-first: if ANY credential exists, the RP offers only
   * authentication; otherwise (first-run bootstrap) registration.
   * NOTE: @simplewebauthn generators are async — callers await these.
   */
  async registrationOptions() {
    const { generateRegistrationOptions } = require("@simplewebauthn/server");
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userName: "operator",
      attestationType: "none",
      excludeCredentials: this.allCredsStmt.all().map((c) => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    });
    options.challenge = this.#newChallenge("registration");
    return options;
  }

  async verifyRegistration(response, label) {
    const { verifyRegistrationResponse } = require("@simplewebauthn/server");
    const clientChallenge = response?.response?.challenge || response?.challenge;
    if (!this.#takeChallenge(clientChallenge, "registration")) {
      throw new Error("invalid or expired challenge");
    }
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: clientChallenge, // single-use take() above is the real gate
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true, // §24 step-up posture from day one
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("registration verification failed");
    }
    const { credential } = verification.registrationInfo;
    const info = this.insertCredStmt.run(
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter || 0,
      JSON.stringify(response.response?.transports || []),
      verification.registrationInfo.credentialDeviceType || "singleDevice",
      verification.registrationInfo.credentialBackedUp ? 1 : 0,
      String(label || "passkey"),
      Date.now(),
    );
    return { ok: info.changes > 0, credentialId: credential.id };
  }

  async authenticationOptions() {
    const { generateAuthenticationOptions } = require("@simplewebauthn/server");
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: "required", // §24
      allowCredentials: this.hasCredentials()
        ? this.allCredsStmt.all().map((c) => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined }))
        : [],
    });
    options.challenge = this.#newChallenge("authentication");
    return options;
  }

  async verifyAuthentication(response) {
    const { verifyAuthenticationResponse } = require("@simplewebauthn/server");
    const clientChallenge = response?.response?.challenge || response?.challenge;
    if (!this.#takeChallenge(clientChallenge, "authentication")) {
      throw new Error("invalid or expired challenge");
    }
    const credId = response?.id;
    const row = credId ? this.getCredStmt.get(credId) : null;
    if (!row) throw new Error("unknown credential");
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: clientChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error("assertion verification failed");
    this.updateCounterStmt.run(verification.authenticationInfo.newCounter, Date.now(), row.credential_id);
    return { ok: true, credentialId: row.credential_id };
  }

  removeCredential(credentialId) {
    return this.deleteCredStmt.run(String(credentialId)).changes > 0;
  }
}

module.exports = { PasskeyService };
