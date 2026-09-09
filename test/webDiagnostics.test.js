"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

global.__GMWEB_VERSION__ = "0.16.2";

test("diagnostics derive projection, contacts, sync, and build failures deterministically", async () => {
  const diagnostics = await import("../web/src/lib/diagnostics.ts");
  const emptyCrypto = { decrypted: 0, accepted: 0, locked: 0, invalid: 0, reasons: {} };

  assert.equal(diagnostics.detectProjectionFailure(4, 0, 50, 50), "PROJECTION_DIVERGENCE");
  assert.equal(diagnostics.detectProjectionFailure(4, 4, 50, 50), null);
  assert.equal(diagnostics.detectContactsFailure({ CONTACTS_SNAPSHOT: 1 }, emptyCrypto, 0), "CONTACTS_NO_GRANT");
  assert.equal(diagnostics.detectContactsFailure(
    { CONTACTS_SNAPSHOT: 1, CONTACTS_KEY_GRANT: 1 },
    { ...emptyCrypto, invalid: 1 }, 0,
  ), "CONTACTS_DECRYPT_FAILED");
  assert.equal(diagnostics.diagnosticOutcome({
    buildMismatch: false, projectionFailure: null, syncState: "SYNCING_HISTORY",
    contactsFailure: null, syncLag: 10, projectionLag: 0,
  }), "SYNCING");
  assert.equal(diagnostics.diagnosticOutcome({
    buildMismatch: false, projectionFailure: null, syncState: "UP_TO_DATE",
    contactsFailure: null, syncLag: 0, projectionLag: 0,
  }), "PASS");
  assert.equal(diagnostics.diagnosticOutcome({
    buildMismatch: true, projectionFailure: null, syncState: "UP_TO_DATE",
    contactsFailure: null, syncLag: 0, projectionLag: 0,
  }), "FAIL");
});

test("diagnostic report is privacy-safe and exposes an old PWA build", async () => {
  const { formatWebDiagnostics } = await import("../web/src/lib/diagnostics.ts");
  const emptyCrypto = { decrypted: 0, accepted: 0, locked: 0, invalid: 0, reasons: {} };
  const secret = "SENSITIVE-MESSAGE-OR-KEY";
  const report = {
    collectedAt: 1,
    session: { linked: true, capabilities: ["READ_MESSAGES"], apiVersion: "0.16.2", pwaVersion: "0.16.1", loadedScript: "index-old.js", serviceWorker: "ACTIVE", online: true, buildMismatch: true },
    server: { total: 2, maxSequence: 2, countsByType: [], countsByCryptoVersion: [], distinctAggregateCount: 1, nullAggregateCount: 0 },
    browserSync: { state: "UP_TO_DATE", lastSuccessfulSyncAt: 1, lastPageCount: 0, appliedThisRun: 2, lastErrorPhase: null, lastErrorCode: null, lastErrorMessage: null, cursor: 2, projectionCursor: 2, syncLag: 0, projectionLag: 0 },
    indexedDb: { total: 2, byType: { MESSAGE_CREATED: 1 }, byCryptoVersion: { 1: 2 }, nullAggregateCount: 0, distinctMessageAggregateCount: 1, conversationRows: 1, contactRows: 0 },
    crypto: { browserIdentity: true, verifiedPrimary: true, primaryMatchesBrowser: true, messages: { ...emptyCrypto, decrypted: 1 }, keyGrants: { ...emptyCrypto, accepted: 1 } },
    projection: { cursor: 2, lag: 0, rawMessageAggregates: 1, rows: 1, readyRows: 1, lockedRows: 0, failure: null },
    contacts: { grants: 0, snapshots: 0, changed: 0, stored: 0, grantCrypto: emptyCrypto, payloadCrypto: emptyCrypto, failure: null },
    overall: "FAIL",
    body: secret, phone: secret, contactName: secret, ciphertext: secret, key: secret,
    signature: secret, cookie: secret, token: secret, aggregateId: secret,
  };
  const text = formatWebDiagnostics(report);
  assert.match(text, /0\.16\.2 \/ 0\.16\.1 FAIL/);
  assert.doesNotMatch(text, new RegExp(secret));
  for (const field of ["body", "phone", "contactName", "ciphertext", "signature", "cookie", "token", "aggregateId"])
    assert.doesNotMatch(text, new RegExp(field, "i"));
});

test("decrypt diagnostics group safe reasons and surface invalid payloads", async () => {
  const { countDecryptions } = await import("../web/src/lib/diagnostics.ts");
  const result = countDecryptions([
    { state: "decrypted", payload: {} },
    { state: "locked", reason: "Authorized key grant unavailable" },
    { state: "invalid", reason: "OperationError: secret browser detail" },
  ]);
  assert.deepEqual(result, {
    decrypted: 1, accepted: 0, locked: 1, invalid: 1,
    reasons: { "Authorized key grant unavailable": 1, "AEAD authentication failed": 1 },
  });
});
