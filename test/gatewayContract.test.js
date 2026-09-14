"use strict";
// Android gateway contract: /gateway/pull, /gateway/validate, /gateway/ack.
//
// Focused on the wire contract and backward compatibility (the race scenarios
// live in test/staleSmsRace.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./revocationHarness");

function withHarness(fn) {
  const harness = createHarness();
  return Promise.resolve()
    .then(() => fn(harness))
    .finally(() => harness.close());
}

test("pull hands the phone the notification metadata so it can validate before sending", async () => {
  await withHarness(async (h) => {
    const { jobId } = h.queueNotification({
      kind: "volume_ended", generation: 17, text: "meta reminder",
      correlationId: "corr-meta"
    });
    const worker = h.runWorker(jobId);
    const app = await h.buildGatewayApp();

    const pulled = await app.inject({
      method: "GET", url: "/gateway/pull?waitMs=1000",
      headers: { "x-api-key": h.deviceKey }
    });
    const task = pulled.json().task;
    assert.equal(task.text, "meta reminder");
    assert.deepEqual(task.meta, {
      source: "eve",
      serviceKey: "eve:1:uuid-A",
      notificationKind: "volume_ended",
      generation: 17,
      correlationId: "corr-meta",
      requiresValidation: true
    });

    await app.close();
    h.outbox.acknowledge(task.requestId, false, { outcome: "superseded" });
    await worker;
  });
});

test("pull keeps the legacy shape for a send without meta", async () => {
  await withHarness(async (h) => {
    const id = h.store.claim({ to: "+989120000021", text: "legacy pull", keyName: "eve", windowMs: 0 });
    h.store.attachJob(id.id, "job-legacy-pull");
    h.queue.add("job-legacy-pull", "waiting");
    const worker = h.runWorker("job-legacy-pull", { text: "legacy pull" });

    const app = await h.buildGatewayApp();
    const pulled = await app.inject({ method: "GET", url: "/gateway/pull", headers: { "x-api-key": h.deviceKey } });
    const task = pulled.json().task;
    // meta is ALWAYS an object: the Messages client only records the gateway
    // request id — and therefore can only acknowledge at all — inside
    // task.meta?.let { ... }. A null meta produced tasks it could send but
    // never report, which is how one reminder became three physical SMS.
    assert.deepEqual(task.meta, {
      source: null, serviceKey: null, notificationKind: null,
      generation: null, correlationId: null, requiresValidation: false
    });
    assert.deepEqual(Object.keys(task).sort(), ["meta", "priority", "requestId", "text", "to"]);

    await app.close();
    h.outbox.acknowledge(task.requestId, true, {});
    await worker;
  });
});

test("pull never hands out a revoked task and terminalizes it as superseded", async () => {
  await withHarness(async (h) => {
    const { ledgerId, jobId } = h.queueNotification({ kind: "low_volume", generation: 17, text: "revoked pull" });
    const worker = h.runWorker(jobId);
    await h.invalidate();

    const app = await h.buildGatewayApp();
    const pulled = await app.inject({ method: "GET", url: "/gateway/pull?waitMs=1000", headers: { "x-api-key": h.deviceKey } });
    assert.equal(pulled.json().task, null);
    await app.close();

    assert.equal((await worker).superseded, true);
    assert.equal(h.store.byId(ledgerId).status, "superseded");
  });
});

test("pull requires the device key and an active pull transport", async () => {
  await withHarness(async (h) => {
    const app = await h.buildGatewayApp();
    const denied = await app.inject({ method: "GET", url: "/gateway/pull" });
    assert.equal(denied.statusCode, 401);
    assert.deepEqual(denied.json(), { error: "unauthorized" });
    await app.close();
  });
});

test("ack derives the outcome from the legacy ok flag when outcome is absent", async () => {
  await withHarness(async (h) => {
    const { jobId } = h.queueNotification({ kind: "expired", generation: 17, text: "derive outcome" });
    const worker = h.runWorker(jobId);
    const app = await h.buildGatewayApp();
    const task = (await app.inject({ method: "GET", url: "/gateway/pull", headers: { "x-api-key": h.deviceKey } })).json().task;

    const ack = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: task.requestId, ok: true }
    });
    // A successful send is TERMINAL for the task (the old contract reported
    // terminal:false, which read as "still running"). Retryability is a separate
    // field so the two concepts are never overloaded again.
    assert.deepEqual(ack.json(), {
      ok: true, outcome: "sent", terminal: true, successful: true,
      retryable: false, duplicate: false, newlyRecorded: true, counted: true,
      ackState: null
    });
    await app.close();
    await worker;
  });
});

test("ack rejects a body without requestId and accepts one without ok", async () => {
  await withHarness(async (h) => {
    const app = await h.buildGatewayApp();
    const missing = await app.inject({
      method: "POST", url: "/gateway/ack", headers: { "x-api-key": h.deviceKey }, payload: {}
    });
    assert.equal(missing.statusCode, 400);

    const { jobId } = h.queueNotification({ kind: "expired", generation: 17, text: "no ok field" });
    const worker = h.runWorker(jobId);
    const task = (await app.inject({ method: "GET", url: "/gateway/pull", headers: { "x-api-key": h.deviceKey } })).json().task;
    const ack = await app.inject({
      method: "POST", url: "/gateway/ack",
      headers: { "x-api-key": h.deviceKey },
      payload: { requestId: task.requestId, outcome: "superseded", reason: "renewed" }
    });
    assert.equal(ack.json().outcome, "superseded");
    assert.equal(ack.json().counted, false);
    await app.close();
    await worker;
  });
});

test("validate counts requests and rejects a malformed body", async () => {
  await withHarness(async (h) => {
    const app = await h.buildGatewayApp();
    await app.inject({
      method: "POST", url: "/gateway/validate",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: "pull_x" }
    });
    await app.inject({
      method: "POST", url: "/gateway/validate", headers: { "x-api-key": h.deviceKey }, payload: {}
    });
    await app.close();
    assert.equal(h.store.counters().sms_validation_requests_total, 1);
  });
});

test("a superseded task is invalid even before the worker notices", async () => {
  await withHarness(async (h) => {
    const { jobId } = h.queueNotification({ kind: "volume_ended", generation: 17, text: "early invalid" });
    const worker = h.runWorker(jobId);
    const app = await h.buildGatewayApp();
    const task = (await app.inject({ method: "GET", url: "/gateway/pull", headers: { "x-api-key": h.deviceKey } })).json().task;

    // The admin path is still running its worker loop when the renewal lands.
    await h.invalidate({ reason: "renewed" });
    const verdict = await app.inject({
      method: "POST", url: "/gateway/validate",
      headers: { "x-api-key": h.deviceKey }, payload: { requestId: task.requestId }
    });
    assert.deepEqual(verdict.json(), { valid: false, status: "superseded", reason: "renewed", known: true });
    await app.close();

    h.outbox.acknowledge(task.requestId, false, { outcome: "superseded" });
    await worker;
  });
});
