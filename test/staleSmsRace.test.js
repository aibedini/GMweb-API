"use strict";
// Stale-SMS / renewal race regression suite.
//
// The race being prevented:
//   T1 Eve queues "volume ended" (generation 17)
//   T2 GMweb / BullMQ / Android pick it up
//   T3 the customer renews
//   T4 Eve calls POST /send/invalidate (generation 18)
//   T5 BullMQ reports the job active and refuses to remove it
//   T6 the phone must STILL not send the stale reminder
//
// Every test below drives the REAL ledger, the REAL outbox, the REAL
// revocation service and the REAL gateway routes; only Redis and the phone are
// simulated (see test/revocationHarness.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./revocationHarness");
const { validateNotificationMeta, NOTIFICATION_KINDS, DEPLETION_KINDS } = require("../src/notificationMeta");

function withHarness(fn) {
  const harness = createHarness();
  return Promise.resolve()
    .then(() => fn(harness))
    .finally(() => harness.close());
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── 1-3: BullMQ pending states are removed, not just ignored ────────────────
for (const state of ["waiting", "delayed", "prioritized"]) {
  test(`${state} depletion job -> renewal invalidate -> never sent`, async () => {
    await withHarness(async (h) => {
      const { ledgerId, jobId } = h.queueNotification({
        kind: "volume_ended", generation: 17, text: `${state} reminder`, state
      });
      assert.equal(h.queue.jobs.get(jobId).state, state);

      const result = await h.invalidate();
      assert.equal(result.statusCode, 200);
      assert.equal(result.body.cancelledPending, 1);
      assert.equal(result.body.revokedActive, 0);
      assert.equal(result.body.alreadyTerminal, 0);

      // The BullMQ job is actually gone, and the ledger is terminal.
      assert.equal(h.queue.jobs.has(jobId), false, "the queued job must be removed");
      assert.equal(h.store.byId(ledgerId).status, "superseded");

      // Even a resurrected job (BullMQ stall, manual retry) cannot send it.
      const outcome = await h.runWorker(jobId);
      assert.equal(outcome.superseded, true, "a resurrected job must not reach a transport");
      assert.equal(h.store.byId(ledgerId).status, "superseded");
      assert.equal(h.store.counters().sms_jobs_superseded_total, 1);
    });
  });
}

// ── 4: the dead end the old code hit — an ACTIVE job ────────────────────────
test("BullMQ job already active -> invalidate -> marked superseded, not 'nothing to do'", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "active reminder"
    });
    h.queue.setState(jobId, "active");
    h.store.markStatus(jobId, "active", { attempts: 1 });

    const result = await h.invalidate();
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.revokedActive, 1, "the contract must report an active revocation");
    assert.equal(result.body.cancelledPending, 0);

    // Durable revocation is already written even though the row is not terminal.
    const row = h.store.byId(ledgerId);
    assert.equal(row.status, "active");
    assert.ok(row.revoked_at, "the tombstone must exist before the worker is told");
    assert.equal(row.revocation_reason, "renewed");
    assert.equal(h.revocation.guardForJob(jobId).superseded, true);
    assert.equal(h.store.counters().sms_jobs_superseded_total ?? 0, 0, "not terminal yet");

    // The worker's next checkpoint refuses to touch a transport, for both
    // transports.
    assert.equal((await h.runWorker(jobId)).superseded, true);
    assert.equal((await h.runWorker(jobId, { transport: "chrome" })).superseded, true);
    assert.equal(h.store.byId(ledgerId).status, "superseded");
  });
});

// ── 5: pending in the Android outbox ────────────────────────────────────────
test("AndroidOutbox pending -> invalidate -> the phone never receives it", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "pending reminder"
    });
    const worker = h.runWorker(jobId);          // worker offers the task
    assert.equal(h.outbox.stats().pending, 1, "task is waiting for a phone");

    const result = await h.invalidate();
    assert.equal(result.body.cancelledPending, 1);

    // The long-poll finds nothing: the revoked task was never handed out.
    const task = await h.outbox.take(30);
    assert.equal(task, null, "a revoked pending task must never be offered");
    assert.equal((await worker).superseded, true);
    assert.equal(h.store.byId(ledgerId).status, "superseded");
    assert.ok(h.events.some((event) => event.type === "send_superseded" || event.type === "send_revocation_requested"));
  });
});

// ── 6-7: already in flight on the phone ─────────────────────────────────────
test("AndroidOutbox inflight -> invalidate -> validate returns false immediately", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "inflight reminder"
    });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);        // the phone pulled it
    // The id the phone receives IS the logical send identity (send_<ledger>),
    // stable for every attempt of the job.
    assert.equal(task.requestId, h.store.requestId(ledgerId));

    const result = await h.invalidate();
    assert.equal(result.body.revokedInflight, 1, "the contract must report an inflight revocation");

    // The task identity is preserved (the device may already hold it)...
    assert.equal(h.outbox.stats().inflight, 1);
    assert.ok(h.store.byGatewayRequest(task.requestId).revoked_at);

    // ...but it is invalid the instant the invalidation lands.
    const app = await h.buildGatewayApp();
    const verdict = await app.inject({
      method: "POST", url: "/gateway/validate",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: task.requestId }
    });
    assert.equal(verdict.statusCode, 200);
    assert.deepEqual(verdict.json(), { valid: false, status: "superseded", reason: "renewed", known: true });
    await app.close();

    // Stand-down: the phone confirms it did not send.
    const settled = h.outbox.acknowledge(task.requestId, false, { outcome: "superseded", reason: "renewed" });
    assert.equal(settled.outcome, "superseded");
    assert.equal((await worker).superseded, true);
    assert.equal(h.store.byId(ledgerId).status, "superseded");
  });
});

test("Android pulled task -> renewal -> /gateway/validate returns superseded (HTTP)", async () => {
  await withHarness(async (h) => {
    const { jobId } = h.queueNotification({ kind: "expired", generation: 17, text: "pulled reminder" });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);

    const app = await h.buildGatewayApp();
    const before = await app.inject({
      method: "POST", url: "/gateway/validate",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: task.requestId }
    });
    assert.deepEqual(before.json(), { valid: true, status: "valid", reason: null, known: true });

    await h.invalidate({ reason: "renewed" });

    const after = await app.inject({
      method: "POST", url: "/gateway/validate",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: task.requestId }
    });
    assert.equal(after.json().valid, false);
    assert.equal(after.json().status, "superseded");
    assert.equal(after.headers["cache-control"], "no-store");
    await app.close();

    h.outbox.acknowledge(task.requestId, false, { outcome: "superseded", reason: "renewed" });
    await worker;
  });
});

// ── 8: idempotency ──────────────────────────────────────────────────────────
test("repeated invalidate request is idempotent (same eventId replays, new eventId is a no-op)", async () => {
  await withHarness(async (h) => {
    h.queueNotification({ kind: "volume_ended", generation: 17, text: "idem reminder" });
    const first = await h.invalidate({ eventId: "lc-42" });
    assert.equal(first.body.cancelledPending, 1);
    assert.equal(first.body.replayed, false);

    const replay = await h.invalidate({ eventId: "lc-42" });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(
      { ...replay.body, replayed: false },
      { ...first.body, replayed: false }
    );

    const again = await h.invalidate({ eventId: "lc-43" });
    assert.equal(again.body.cancelledPending, 0);
    assert.equal(again.body.matched, 0);
    assert.equal(h.store.counters().sms_invalidations_total, 2, "a replay does not re-apply");
  });
});

test("a lower generation arriving late is refused, never applied", async () => {
  await withHarness(async (h) => {
    await h.invalidate({ currentGeneration: 18, eventId: "lc-hi" });
    const stale = await h.invalidate({ currentGeneration: 17, eventId: "lc-lo" });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.error, "stale_generation");
    assert.equal(stale.body.currentGeneration, 18);
    assert.equal(h.store.counters().sms_stale_generation_rejections_total, 1);
  });
});

// ── 9: a delayed retry cannot resurrect an old generation ───────────────────
test("old generation retry -> must not resurrect the reminder", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "retry reminder"
    });
    await h.invalidate();
    assert.equal(h.store.byId(ledgerId).status, "superseded");

    // BullMQ re-queues the same ledger row under a NEW job id (stall, defer,
    // promotion, manual retry). The row is still the same notification.
    h.store.attachJob(ledgerId, "job-retry-1");
    h.queue.add("job-retry-1", "waiting");
    const outcome = await h.runWorker("job-retry-1");
    assert.equal(outcome.superseded, true);
    assert.equal(h.store.byId(ledgerId).status, "superseded");

    // And a row that was never individually visited is still blocked by the
    // generation barrier itself.
    const late = h.queueNotification({
      kind: "near_expiry", generation: 17, text: "missed by the loop",
      serviceKey: "eve:1:uuid-A", jobId: "job-late"
    });
    // Re-create it with the same (already advanced) watermark scenario: the
    // barrier alone must judge it stale.
    const row = h.store.byId(late.ledgerId);
    assert.equal(row.notification_generation, 17);
    assert.equal(h.store.isSuperseded(row), true, "generation <= watermark is invalid forever");
    assert.equal((await h.runWorker("job-late")).superseded, true);
    assert.ok(jobId);
  });
});

// ── 10: durability across a process restart ─────────────────────────────────
test("process restart -> the tombstone still blocks the old generation", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "restart reminder"
    });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);
    await h.invalidate();

    // Crash: the SQLite file survives, every in-memory structure is gone. The
    // original process keeps running (a restart overlaps the phone's session).
    const hotOutbox = h.outbox;
    const cold = h.coldRestart();
    assert.equal(cold.store.byId(ledgerId).revoked_at > 0, true, "tombstone is on disk");
    assert.equal(cold.store.counters().sms_inflight_revoked_total, 1, "counters are on disk");
    assert.equal(cold.revocation.guardForJob(jobId).superseded, true);
    assert.equal(cold.store.isSuperseded(cold.store.byId(ledgerId)), true);
    assert.equal(cold.store.generationFor("eve", "eve:1:uuid-A"), 18);

    // The cold process answers "superseded" for the id the phone still holds.
    assert.deepEqual(
      cold.outbox.revocationFor(task.requestId),
      { cause: "superseded", reason: "renewed", revokedAt: cold.store.byId(ledgerId).revoked_at }
    );

    // The worker is settled by the phone's stand-down ACK, never by a send.
    await tick();
    hotOutbox.acknowledge(task.requestId, false, { outcome: "superseded", reason: "renewed" });
    assert.equal((await worker).superseded, true);
  });
});

// ── 11: service identity, not phone number ──────────────────────────────────
test("another service on the SAME PHONE NUMBER is not cancelled", async () => {
  await withHarness(async (h) => {
    const sameNumber = "+989120000011";
    const a = h.queueNotification({
      to: sameNumber, text: "service A reminder", serviceKey: "eve:1:uuid-A",
      kind: "volume_ended", generation: 17, jobId: "job-a"
    });
    const b = h.queueNotification({
      to: sameNumber, text: "service B reminder", serviceKey: "eve:1:uuid-B",
      kind: "volume_ended", generation: 4, jobId: "job-b"
    });

    await h.invalidate({ serviceKey: "eve:1:uuid-A" });

    assert.equal(h.store.byId(a.ledgerId).status, "superseded");
    assert.equal(h.store.byId(b.ledgerId).status, "queued", "service B must be untouched");
    assert.equal(h.queue.jobs.has("job-b"), true);
    assert.equal(h.store.isSuperseded(h.store.byId(b.ledgerId)), false);
  });
});

// ── 12-14: what must stay valid ─────────────────────────────────────────────
test("new-generation depletion message remains valid", async () => {
  await withHarness(async (h) => {
    await h.invalidate({ currentGeneration: 18 });
    const fresh = h.queueNotification({
      kind: "volume_ended", generation: 18, text: "new generation reminder", jobId: "job-new"
    });
    const row = h.store.byId(fresh.ledgerId);
    assert.equal(h.store.isSuperseded(row), false);
    assert.equal(h.revocation.guardForJob("job-new"), null);
    const outcome = await h.runWorker("job-new", { transport: "chrome" });
    assert.equal(outcome.type, "sent");
    assert.equal(h.store.byId(fresh.ledgerId).status, "sent");
  });
});

test("renew confirmation is never invalidated, even when explicitly listed", async () => {
  await withHarness(async (h) => {
    const renew = h.queueNotification({
      kind: "renew", generation: 17, text: "your service was renewed", jobId: "job-renew"
    });
    assert.equal(h.store.byId(renew.ledgerId).requires_validation, 0, "requiresValidation is derived, not trusted");

    const result = await h.invalidate({ invalidateKinds: [...DEPLETION_KINDS, "renew"] });
    assert.equal(result.body.matched, 0);
    assert.equal(h.store.byId(renew.ledgerId).status, "queued");
    assert.equal(h.queue.jobs.has("job-renew"), true);
    assert.equal((await h.runWorker("job-renew", { transport: "chrome" })).type, "sent");
  });
});

test("an omitted invalidateKinds list defaults to the depletion kinds only", async () => {
  await withHarness(async (h) => {
    const depletion = h.queueNotification({
      kind: "low_volume", generation: 17, text: "default kinds reminder", jobId: "job-dep"
    });
    const confirmation = h.queueNotification({
      kind: "renew", generation: 17, text: "renewed ok", jobId: "job-conf"
    });
    const result = await h.invalidate({ invalidateKinds: undefined });
    assert.equal(result.body.matched, 1);
    assert.equal(result.body.cancelledPending, 1);
    assert.equal(h.store.byId(depletion.ledgerId).status, "superseded");
    assert.equal(h.store.byId(confirmation.ledgerId).status, "queued");
    // The barrier must also be scoped to those kinds.
    assert.equal(h.store.revocationBarrier("eve", "eve:1:uuid-A").kinds.includes("renew"), false);
    assert.equal(h.store.revocationBarrier("eve", "eve:1:uuid-A").kinds.includes("low_volume"), true);
  });
});

test("created confirmation is never invalidated", async () => {
  await withHarness(async (h) => {
    const created = h.queueNotification({
      kind: "created", generation: 17, text: "welcome", jobId: "job-created"
    });
    const result = await h.invalidate({ invalidateKinds: ["created", ...DEPLETION_KINDS] });
    assert.equal(result.body.matched, 0);
    assert.equal(h.store.byId(created.ledgerId).status, "queued");
    assert.equal(h.store.byId(created.ledgerId).requires_validation, 0);
  });
});

test("a depletion claim cannot opt out of validation by lying about requiresValidation", () => {
  const accepted = validateNotificationMeta({
    source: "eve", serviceKey: "eve:1:uuid-A", notificationKind: "volume_ended",
    generation: 17, requiresValidation: false
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.meta.requiresValidation, true, "depletion kinds always require validation");
  for (const kind of DEPLETION_KINDS) {
    assert.equal(validateNotificationMeta({
      source: "eve", serviceKey: "eve:1:uuid-A", notificationKind: kind, generation: 1
    }).meta.requiresValidation, true);
  }
  for (const kind of ["created", "renew"]) {
    assert.equal(validateNotificationMeta({
      source: "eve", serviceKey: "eve:1:uuid-A", notificationKind: kind, generation: 1
    }).meta.requiresValidation, false);
  }
});

// ── 15: legacy payloads ─────────────────────────────────────────────────────
test("legacy /send payload without meta continues to work end to end", async () => {
  await withHarness(async (h) => {
    // The route-level rule the /send handler applies.
    assert.deepEqual(validateNotificationMeta(undefined), { ok: true, meta: null });
    assert.deepEqual(validateNotificationMeta({}), { ok: true, meta: null });

    const id = h.store.claim({ to: "+989120000015", text: "legacy message", keyName: "eve", windowMs: 0 });
    const ledgerId = id.id;
    h.store.attachJob(ledgerId, "job-legacy");
    h.queue.add("job-legacy", "waiting");

    // A renewal for ANY service must not touch an untagged send.
    const result = await h.invalidate({ serviceKey: "eve:1:uuid-A" });
    assert.equal(result.body.matched, 0);
    assert.equal(h.store.byId(ledgerId).status, "queued");

    const worker = h.runWorker("job-legacy", { text: "legacy message" });
    const task = await h.outbox.take(50);
    // Legacy sends carry no notification identity, but meta must still be an
    // OBJECT: the phone builds its dedupe/ACK record from it.
    assert.equal(typeof task.meta, "object");
    assert.equal(task.meta.serviceKey, null, "legacy tasks keep an empty notification identity");
    h.outbox.acknowledge(task.requestId, true, {});
    const outcome = await worker;
    assert.equal(outcome.type, "sent");
    assert.equal(h.store.byId(ledgerId).status, "sent");
  });
});

test("partial or unknown meta is rejected instead of stored unrevocable", () => {
  assert.equal(validateNotificationMeta({ serviceKey: "eve:1:uuid-A" }).ok, false);
  assert.equal(validateNotificationMeta({ serviceKey: "eve:1:uuid-A" }).error, "meta_source_required");
  assert.equal(validateNotificationMeta({
    source: "eve", serviceKey: "eve:1:uuid-A", notificationKind: "expired"
  }).error, "meta_generation_required");
  assert.equal(validateNotificationMeta({
    source: "eve", serviceKey: "eve:1:uuid-A", notificationKind: "expired", generation: 1.5
  }).error, "meta_generation_required");
  const unknown = validateNotificationMeta({
    source: "eve", serviceKey: "eve:1:uuid-A", notificationKind: "nope", generation: 1
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "meta_notification_kind_unknown");
  assert.deepEqual(unknown.allowed, [...NOTIFICATION_KINDS]);
  const negative = validateNotificationMeta({
    source: "eve", serviceKey: "eve:1:uuid-A", notificationKind: "expired", generation: -1
  });
  assert.equal(negative.ok, false);
});

// ── 16-17: ACK outcomes ─────────────────────────────────────────────────────
test("superseded ACK is terminal, non-billable and non-retryable", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "ack reminder"
    });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);
    await h.invalidate();

    const app = await h.buildGatewayApp();
    const ack = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey },
      payload: { requestId: task.requestId, ok: false, outcome: "superseded", reason: "renewed" }
    });
    assert.equal(ack.statusCode, 200);
    assert.deepEqual(ack.json(), {
      ok: true, outcome: "superseded", terminal: true, successful: false, counted: false
    });
    await app.close();

    const outcome = await worker;
    assert.equal(outcome.superseded, true, "the worker must NOT retry a superseded task");
    const row = h.store.byId(ledgerId);
    assert.equal(row.status, "superseded");
    assert.equal(row.status === "sent", false, "never reported as a success");
    assert.equal(row.finished_at > 0, true);
    assert.equal(h.store.counters().sms_jobs_superseded_total, 1);
    assert.equal(h.store.counters().sms_sent_after_revocation_total ?? 0, 0);
  });
});

test("late actual sent ACK after revocation is visibly audited, never faked as cancelled", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "late send reminder"
    });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);
    await h.invalidate();

    // The SIM won the race: the phone reports a REAL submission.
    const settled = h.outbox.acknowledge(task.requestId, true, { sentAt: Date.now() });
    assert.equal(settled.outcome, "sent_after_revocation");

    const outcome = await worker;
    assert.equal(outcome.sentAfterRevocation, true);

    const row = h.store.byId(ledgerId);
    assert.equal(row.status, "sent", "the physical truth wins");
    assert.ok(row.result_json.includes("sentAfterRevocation"));
    assert.equal(row.revoked_at > 0, true, "the revocation is still on record");
    assert.equal(h.store.counters().sms_sent_after_revocation_total, 1);
    assert.equal(h.store.counters().sms_jobs_superseded_total ?? 0, 0);
    assert.ok(h.audits.some((entry) => entry.type === "sent_after_revocation"),
      "the anomaly must reach the operator audit trail");
  });
});

test("late sent ACK after a restart is still audited (durable fallback)", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "expired", generation: 17, text: "restart late send"
    });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);
    await h.invalidate();
    h.outbox.acknowledge(task.requestId, false, { outcome: "superseded" });
    await worker;
    assert.equal(h.store.byId(ledgerId).status, "superseded");

    // A brand-new process receives a very late "it actually sent" ACK for a
    // task it has no memory of.
    const cold = h.coldRestart();
    const app = await h.buildGatewayApp(cold);
    const ack = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey },
      payload: { requestId: task.requestId, ok: true, outcome: "sent", sentAt: Date.now() }
    });
    assert.equal(ack.statusCode, 200);
    assert.equal(ack.json().outcome, "sent_after_revocation");
    await app.close();
    assert.equal(cold.store.byId(ledgerId).status, "sent");
    assert.equal(cold.store.counters().sms_sent_after_revocation_total, 1);
  });
});

test("a real send reported after the revocation lease expired is still recorded as sent", async () => {
  // The phone pulled the reminder, the renewal revoked it, the device stayed
  // offline past the revocation lease, and only THEN reported a real SIM
  // submission. No worker is waiting any more, so the durable ledger is the
  // only place the anomaly can be told -- and it MUST be told: leaving the row
  // 'superseded' would claim a stale SMS never left the device.
  const h = createHarness({ leaseMs: 1000 });
  try {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "offline phone reminder"
    });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);
    await h.invalidate();

    // The bounded wait expires: the worker stops waiting, the row is terminal.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal((await worker).superseded, true);
    assert.equal(h.store.byId(ledgerId).status, "superseded");
    assert.equal(h.store.counters().sms_sent_after_revocation_total ?? 0, 0);

    const app = await h.buildGatewayApp();
    const ack = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey },
      payload: { requestId: task.requestId, ok: true, outcome: "sent", sentAt: Date.now() }
    });
    assert.equal(ack.statusCode, 200);
    assert.equal(ack.json().outcome, "sent_after_revocation");
    assert.equal(ack.json().successful, true);

    const row = h.store.byId(ledgerId);
    assert.equal(row.status, "sent", "the physical truth beats the superseded row");
    assert.ok(row.result_json.includes('"sentAfterRevocation":true'));
    assert.equal(h.store.counters().sms_sent_after_revocation_total, 1);
    assert.equal(h.store.counters().sms_jobs_superseded_total, 1);
    assert.equal(h.audits.filter((entry) => entry.type === "sent_after_revocation").length, 1,
      "the anomaly must reach the operator audit trail exactly once");

    // The device retries the SAME ack (its response was lost): one physical
    // submission, one audit -- never a second anomaly count.
    const retry = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey },
      payload: { requestId: task.requestId, ok: true, outcome: "sent", sentAt: Date.now() }
    });
    assert.equal(retry.json().outcome, "sent_after_revocation");
    assert.equal(h.store.counters().sms_sent_after_revocation_total, 1);
    assert.equal(h.audits.filter((entry) => entry.type === "sent_after_revocation").length, 1);
    await app.close();
  } finally {
    h.close();
  }
});

test("a retried ACK for an ordinary send is never audited as sent after revocation", async () => {
  // A device that never saw the 200 retries its ack. Nothing about that retry
  // is the stale-SMS race: the row was never revoked, so the only honest answer
  // is "this task is no longer mine", not a fabricated sent_after_revocation
  // anomaly (which would corrupt the operator trail and the anomaly counter).
  const h = createHarness();
  try {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "ordinary reminder"
    });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);
    const app = await h.buildGatewayApp();
    const first = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: task.requestId, ok: true }
    });
    assert.equal(first.json().outcome, "sent");
    await worker;
    assert.equal(h.store.byId(ledgerId).status, "sent");
    const outcomeJson = h.store.byId(ledgerId).result_json;

    // Same process, tombstone only.
    const warm = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: task.requestId, ok: true }
    });
    assert.equal(warm.json().outcome, "sent_after_revocation",
      "the outbox still recognises a settled id (wire label is unchanged)");
    assert.equal(h.store.counters().sms_sent_after_revocation_total ?? 0, 0);
    assert.equal(h.store.byId(ledgerId).result_json, outcomeJson, "the retry must not rewrite the outcome");
    assert.equal(h.audits.some((entry) => entry.type === "sent_after_revocation"), false);

    // A restart is the same durable situation with no memory at all.
    const cold = h.coldRestart();
    const coldApp = await h.buildGatewayApp(cold);
    const retry = await coldApp.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: task.requestId, ok: true }
    });
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(retry.json(), {
      ok: false, outcome: null, terminal: false, successful: null, counted: false
    });
    assert.equal(cold.store.counters().sms_sent_after_revocation_total ?? 0, 0);
    assert.equal(cold.store.byId(ledgerId).result_json, outcomeJson);
    assert.equal(cold.store.byId(ledgerId).revoked_at, null);
    assert.equal(h.audits.some((entry) => entry.type === "sent_after_revocation"), false);
    await coldApp.close();
  } finally {
    h.close();
  }
});

test("legacy ok:true / ok:false ACKs keep their old behaviour", async () => {
  await withHarness(async (h) => {
    const good = h.queueNotification({ kind: "volume_ended", generation: 17, text: "legacy ok true" });
    const goodWorker = h.runWorker(good.jobId);
    const goodTask = await h.outbox.take(50);
    const app = await h.buildGatewayApp();
    const okAck = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: goodTask.requestId, ok: true }
    });
    assert.equal(okAck.json().outcome, "sent");
    assert.equal(okAck.json().counted, true);
    assert.equal((await goodWorker).type, "sent");
    assert.equal(h.store.byId(good.ledgerId).status, "sent");

    const bad = h.queueNotification({ kind: "volume_ended", generation: 17, text: "legacy ok false" });
    const badWorker = h.runWorker(bad.jobId);
    const badTask = await h.outbox.take(50);
    const failAck = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey },
      payload: { requestId: badTask.requestId, ok: false, reason: "radio_down" }
    });
    assert.equal(failAck.json().outcome, "failed");
    assert.equal((await badWorker).failed, true, "a non-superseded failure is still retryable");
    await app.close();

    // An unknown requestId stays a no-op, exactly as before.
    const unknown = await h.outbox.acknowledge("pull_unknown", true, {});
    assert.deepEqual(unknown, { handled: false, outcome: null });
  });
});

// ── security / leakage ──────────────────────────────────────────────────────
test("validate leaks no task metadata and is authenticated", async () => {
  await withHarness(async (h) => {
    const { jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "secret body",
      to: "+989120000099", correlationId: "corr-secret"
    });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);
    await h.invalidate();
    const app = await h.buildGatewayApp();

    const denied = await app.inject({
      method: "POST", url: "/gateway/validate", payload: { requestId: task.requestId }
    });
    assert.equal(denied.statusCode, 401);

    const verdict = await app.inject({
      method: "POST", url: "/gateway/validate",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: task.requestId }
    });
    const body = verdict.json();
    assert.deepEqual(Object.keys(body).sort(), ["known", "reason", "status", "valid"]);
    assert.equal(JSON.stringify(body).includes("+989120000099"), false);
    assert.equal(JSON.stringify(body).includes("secret body"), false);
    assert.equal(JSON.stringify(body).includes("eve:1:uuid-A"), false);
    await app.close();

    h.outbox.acknowledge(task.requestId, false, { outcome: "superseded" });
    await worker;
  });
});

test("validate on an unknown task id stays valid (legacy devices are not stranded)", async () => {
  await withHarness(async (h) => {
    const app = await h.buildGatewayApp();
    const verdict = await app.inject({
      method: "POST", url: "/gateway/validate",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: "pull_from_before_upgrade" }
    });
    assert.deepEqual(verdict.json(), { valid: true, status: "valid", reason: null, known: false });
    await app.close();
  });
});

// ── concurrency ─────────────────────────────────────────────────────────────
test("concurrent invalidations and an in-flight send settle consistently", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "concurrent reminder"
    });
    const worker = h.runWorker(jobId);
    const task = await h.outbox.take(50);

    const [a, b, c] = await Promise.all([
      h.invalidate({ eventId: "lc-c1" }),
      h.invalidate({ eventId: "lc-c2" }),
      h.invalidate({ currentGeneration: 19, eventId: "lc-c3" })
    ]);
    // Exactly one caller may claim the revocation of this task.
    const inflight = a.body.revokedInflight + b.body.revokedInflight + c.body.revokedInflight;
    assert.equal(inflight, 1, "a task is revoked exactly once");
    assert.equal((await h.runWorker(jobId)).superseded, true);

    const verdict = h.outbox.revocationFor(task.requestId);
    assert.equal(verdict.cause, "superseded");

    // Settling twice cannot double-count or double-resolve.
    const first = h.outbox.acknowledge(task.requestId, false, { outcome: "superseded" });
    const second = h.outbox.acknowledge(task.requestId, false, { outcome: "superseded" });
    assert.equal(first.handled, true);
    assert.equal(second.handled, true, "the tombstone still recognises the id");
    assert.equal(second.outcome, "superseded");
    const outcome = await worker;
    assert.equal(outcome.superseded, true);
    assert.equal(h.store.byId(ledgerId).status, "superseded");
    assert.equal(h.store.counters().sms_jobs_superseded_total, 1, "finalized exactly once");
  });
});

test("an invalidation that lands while the worker is offering the task still stops it", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({
      kind: "low_volume", generation: 17, text: "offer race"
    });
    // No await between runWorker() and the invalidation: the task is offered and
    // revoked in the same tick, the worst case for the pending queue.
    const worker = h.runWorker(jobId);
    const result = await h.invalidate();
    assert.equal(result.body.cancelledPending + result.body.revokedInflight + result.body.revokedActive, 1);
    assert.equal(await h.outbox.take(30), null, "nothing may be handed to a phone");
    assert.equal((await worker).superseded, true);
    assert.equal(h.store.byId(ledgerId).status, "superseded");
  });
});
