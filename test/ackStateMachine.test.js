"use strict";
// The ACK state machine: one physical SMS = one durable fact.
//
// Before this module the replay branch called EVERY late/repeated successful
// ACK "sent_after_revocation", so an ordinary retried ACK corrupted the anomaly
// counter and the operator trail, and a restarted process answered "unknown id"
// for a task it durably knew about.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { decideAck, OUTCOME, AUDIT } = require("../src/ackStateMachine");
const { SendStore } = require("../src/sendStore");
const { AndroidOutbox } = require("../src/androidOutbox");

const NOW = Date.parse("2026-09-14T12:00:00Z");

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-ack-"));
  const store = new SendStore(path.join(dir, "sends.db"));
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => { try { store.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
}

function seed(store, status, extra = {}) {
  const id = store.create({ to: "+989120000900", text: "ack " + status + Math.random(), keyName: "eve" });
  const jobId = "job-" + id;
  store.attachJob(id, jobId);
  store.markStatus(jobId, status, { attempts: 1, error: extra.error || null });
  if (extra.revoked) store.revokeById(id, { reason: extra.reason || "renewed" });
  return { id, jobId, row: store.byId(id) };
}

// ── the matrix, one row per decision case ────────────────────────────────────
test("case 18: a repeated ACK for a normal sent task is sent/duplicate, never an anomaly", () => {
  const first = decideAck({ reported: { ok: true }, memory: "inflight" });
  assert.equal(first.outcome, OUTCOME.SENT);
  assert.equal(first.newlyRecorded, true);
  assert.equal(first.terminal, true);
  assert.equal(first.retryable, false);
  assert.equal(first.audit, null, "an ordinary send is never an anomaly");

  const replayDecision = decideAck({ reported: { ok: true }, memory: "settled", memoryOutcome: OUTCOME.SENT });
  assert.equal(replayDecision.outcome, OUTCOME.SENT);
  assert.equal(replayDecision.duplicate, true);
  assert.equal(replayDecision.newlyRecorded, false);
  assert.equal(replayDecision.counted, false, "a replay must not count twice");
  assert.equal(replayDecision.audit, null);
  assert.equal(replayDecision.transition, null, "no second ledger mutation");
});

test("case 19: after a restart the durable row still answers (sent/duplicate)", () => {
  const d = decideAck({ reported: { ok: true }, memory: null, durable: { status: "sent" } });
  assert.equal(d.outcome, OUTCOME.SENT);
  assert.equal(d.duplicate, true);
  assert.equal(d.newlyRecorded, false);
  assert.equal(d.reason, "durable_sent");
});

test("case 20+21: a revoked task physically sent is one audit and one counter", async () => {
  await withStore(async (store) => {
    const revoked = seed(store, "active", { revoked: true });
    const row = store.byId(revoked.id);
    const d = decideAck({ reported: { ok: true, sentAt: NOW }, memory: null, durable: row });
    assert.equal(d.outcome, OUTCOME.SENT_AFTER_REVOCATION);
    assert.equal(d.audit, AUDIT.SENT_AFTER_REVOCATION);
    assert.equal(d.newlyRecorded, true);
    assert.equal(d.counted, true);
    // The transition happens ONCE...
    assert.equal(store.reconcileLateSent(revoked.id, { reason: d.audit, sentAt: NOW }).changed, true);
    assert.equal(store.byId(revoked.id).status, "sent");
    // ...and the SAME decision is then a replay: further ACKs record nothing.
    const after = store.reconcileLateSent(revoked.id, { reason: d.audit, sentAt: NOW });
    assert.equal(after.changed, false, "already sent -> no second mutation");
    const replayDecision = decideAck({
      reported: { ok: true }, memory: null,
      durable: { status: "sent", result_json: JSON.stringify({ sentAfterRevocation: true }) }
    });
    assert.equal(replayDecision.outcome, OUTCOME.SENT_AFTER_REVOCATION);
    assert.equal(replayDecision.duplicate, true);
    assert.equal(replayDecision.newlyRecorded, false);
    for (let i = 0; i < 10; i += 1) {
      assert.equal(decideAck({ reported: { ok: true }, memory: null, durable: { status: "sent", result_json: '{"sentAfterRevocation":true}' } }).newlyRecorded, false);
    }
  });
});

test("case 22: unverified + a late authenticated sent ACK reconciles exactly once", async () => {
  await withStore(async (store) => {
    const s = seed(store, "unverified", { error: "android_ack_missing" });
    const d = decideAck({ reported: { ok: true, sentAt: NOW }, memory: null, durable: store.byId(s.id) });
    assert.equal(d.outcome, OUTCOME.SENT);
    assert.equal(d.audit, AUDIT.LATE_UNVERIFIED);
    assert.equal(d.transition, "sent");
    const first = store.reconcileLateSent(s.id, { reason: d.audit, sentAt: NOW });
    assert.equal(first.changed, true);
    assert.equal(store.byId(s.id).status, "sent");
    assert.equal(store.byId(s.id).result_json.includes("lateAck"), true);
    const second = store.reconcileLateSent(s.id, { reason: d.audit, sentAt: NOW });
    assert.equal(second.changed, false, "exactly once");
    // ...and later ACKs replay sent.
    assert.equal(decideAck({ reported: { ok: true }, memory: null, durable: store.byId(s.id) }).duplicate, true);
  });
});

test("case 23: a sent row then a late failed ACK stays sent", () => {
  const d = decideAck({ reported: { ok: false, outcome: "failed" }, memory: null, durable: { status: "sent" } });
  assert.equal(d.outcome, OUTCOME.SENT);
  assert.equal(d.successful, true);
  assert.equal(d.transition, null);
  assert.equal(d.newlyRecorded, false);
});

test("case 24: superseded row then a real sent ACK is sent_after_revocation, once", () => {
  const d = decideAck({
    reported: { ok: true }, memory: null,
    durable: { status: "superseded", revoked_at: NOW - 1000, revocation_reason: "renewed" }
  });
  assert.equal(d.outcome, OUTCOME.SENT_AFTER_REVOCATION);
  assert.equal(d.audit, AUDIT.SENT_AFTER_REVOCATION);
  assert.equal(d.newlyRecorded, true);
  // A settled-in-memory superseded task that reports sent behaves the same.
  const warm = decideAck({
    reported: { ok: true }, memory: "settled", memoryOutcome: OUTCOME.SUPERSEDED,
    durable: { status: "superseded", revoked_at: NOW - 1000 }
  });
  assert.equal(warm.outcome, OUTCOME.SENT_AFTER_REVOCATION);
  // ...but confirming superseded replays superseded.
  const confirm = decideAck({ reported: { outcome: "superseded" }, memory: "settled", memoryOutcome: OUTCOME.SUPERSEDED });
  assert.equal(confirm.outcome, OUTCOME.SUPERSEDED);
  assert.equal(confirm.duplicate, true);
  assert.equal(confirm.successful, false);
  assert.equal(confirm.retryable, false);
});

test("case 25: a released, never-revoked task's late sent ACK is sent, NOT an anomaly", async () => {
  const outbox = new AndroidOutbox({ hooks: { now: () => NOW } });
  const worker = outbox.sendMessage({ to: "+989120000901", text: "released", requestId: "send_77" });
  await outbox.take(20);
  outbox.release("send_77");
  await assert.rejects(() => worker, /task_released/);

  const late = outbox.acknowledge("send_77", true, {});
  assert.equal(late.handled, true);
  assert.equal(late.outcome, OUTCOME.SENT);
  assert.equal(late.decision.audit, AUDIT.LATE_UNSETTLED);
  assert.equal(late.decision.newlyRecorded, true);
  // The replay is stable and silent.
  const again = outbox.acknowledge("send_77", true, {});
  assert.equal(again.outcome, OUTCOME.SENT);
  assert.equal(again.decision.duplicate, true);
  assert.equal(again.decision.newlyRecorded, false);
});

test("case 26+27: terminal/successful/retryable are explicit and not overloaded", () => {
  const sent = decideAck({ reported: { ok: true }, memory: "inflight" });
  assert.deepEqual([sent.terminal, sent.successful, sent.retryable], [true, true, false]);

  const superseded = decideAck({ reported: { outcome: "superseded" }, memory: "inflight" });
  assert.deepEqual([superseded.terminal, superseded.successful, superseded.retryable], [true, false, false]);

  const revokedFail = decideAck({ reported: { ok: false }, memory: "inflight", revoked: { cause: "superseded" } });
  assert.equal(revokedFail.outcome, OUTCOME.SUPERSEDED, "a revoked task is never retried");
  assert.equal(revokedFail.retryable, false);
});

test("case 28: a plain failed task is NON-terminal but retryable (documented)", () => {
  const d = decideAck({ reported: { ok: false }, memory: "inflight" });
  assert.equal(d.outcome, OUTCOME.FAILED);
  assert.equal(d.terminal, false, "the logical job may still retry");
  assert.equal(d.retryable, true, "retryability has its own field");
  assert.equal(d.successful, false);
  // After the retries are exhausted the durable row is failed and replays as failed.
  const replayed = decideAck({ reported: { ok: false }, memory: null, durable: { status: "failed" } });
  assert.equal(replayed.outcome, OUTCOME.FAILED);
  assert.equal(replayed.duplicate, true);
});

test("case 29: an unknown gatewayRequestId stays fail-safe", () => {
  const d = decideAck({ reported: { ok: true }, memory: null, durable: null });
  assert.equal(d.handled, false);
  assert.equal(d.outcome, null);
  assert.equal(d.newlyRecorded, false);
  assert.equal(d.transition, null);
  assert.equal(d.reason, "unknown_gateway_request_id");
  // An unrecognised durable status changes nothing either.
  const odd = decideAck({ reported: { ok: true }, memory: null, durable: { status: "weird" } });
  assert.equal(odd.handled, false);
  assert.equal(odd.newlyRecorded, false);
});

test("case 40: the gateway response schema declares every ACK field it returns", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "gatewayRoutes.js"), "utf8");
  const start = src.indexOf('app.post("/gateway/ack"');
  const body = src.slice(start, src.indexOf("}, async (request, reply)", start));
  for (const field of ["ok:", "outcome:", "terminal:", "successful:", "retryable:", "duplicate:", "newlyRecorded:", "counted:", "ackState:"]) {
    assert.ok(body.includes(field), `/gateway/ack schema must declare ${field}`);
  }
  // ...and the handler must not return anything undeclared.
  const handler = src.slice(src.indexOf("}, async (request, reply)", start), start + 6000);
  assert.ok(handler.includes("retryable: Boolean(decision.retryable)"));
});
