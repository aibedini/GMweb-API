"use strict";
// Duplicate-SMS regression suite.
//
// Production incident: ONE renewal reminder was physically delivered THREE
// times (01:16 / 01:28 / 01:40) because the Android pull path lost the task's
// identity between a BullMQ retry, the bridge and the phone:
//
//   SendQueue defaults to attempts: 3, and startSendWorker() did not pass a
//   requestId into client.sendMessage(). AndroidOutbox therefore minted a NEW
//   \`pull_<random>\` id on every attempt. The phone dedupes on that id, so a
//   retry looked exactly like a brand-new task and produced another SMS.
//
// Worse, /gateway/pull returned \`meta: null\` for every send without consumer
// notification metadata, and the Messages client can only record the gateway
// request id — and therefore only acknowledge at all — inside
// \`task.meta?.let { ... }\`. So the phone sent, never acked, the worker timed
// out, BullMQ retried, and the cycle repeated three times.
//
// These tests pin both halves.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AndroidOutbox } = require("../src/androidOutbox");
const { SendStore } = require("../src/sendStore");

const TO = "+989120000777";
const TEXT = "حجم رو به اتمامه";

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-dup-sms-"));
  const store = new SendStore(path.join(dir, "sends.db"));
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => {
      try { store.close(); } catch { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

/** The exact id startSendWorker now derives, per attempt, from the ledger. */
function gatewayRequestIdFor(store, jobId) {
  const ledgerId = store.byJob(jobId)?.id;
  return store.requestId(ledgerId) || `pull_${jobId}`;
}

test("every retry of ONE BullMQ job carries the SAME gateway request id", async () => {
  await withStore(async (store) => {
    const ledgerId = store.create({ to: TO, text: TEXT, keyName: "EVE new" });
    const jobId = "313999";
    store.attachJob(ledgerId, jobId);

    const outbox = new AndroidOutbox();
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Each attempt offers the task; the phone pulls it; the ACK is lost and
      // the worker gives up (that is what send_timeout does).
      const gatewayRequestId = gatewayRequestIdFor(store, jobId);
      assert.equal(gatewayRequestId, "send_" + ledgerId, "the identity must come from the ledger");
      const worker = outbox.sendMessage({ to: TO, text: TEXT, requestId: gatewayRequestId, ledgerId, jobId });
      const task = await outbox.take(50);
      attempts.push(task.requestId);
      assert.equal(outbox.tracks(gatewayRequestId), "inflight");
      assert.equal(outbox.stats().pending + outbox.stats().inflight, 1,
        "a retry must never create a second logical task");
      assert.ok(worker);
    }

    assert.deepEqual(attempts, ["send_" + ledgerId, "send_" + ledgerId, "send_" + ledgerId],
      "all three attempts must look like ONE task to the phone");

    // The phone eventually reports the real outcome once; every abandoned
    // attempt is settled by it.
    const settled = outbox.acknowledge("send_" + ledgerId, true, { sentAt: 1700000000000 });
    assert.equal(settled.outcome, "sent");
    assert.equal(outbox.stats().pending + outbox.stats().inflight, 0);
  });
});

test("a lost ACK does not duplicate the task: the retry is a redelivery", async () => {
  await withStore(async (store) => {
    const ledgerId = store.create({ to: TO, text: TEXT, keyName: "EVE new" });
    store.attachJob(ledgerId, "314000");
    const id = gatewayRequestIdFor(store, "314000");
    const outbox = new AndroidOutbox();

    // Attempt 1: pulled by the phone, ACK never arrives.
    const first = outbox.sendMessage({ to: TO, text: TEXT, requestId: id, ledgerId, jobId: "314000" });
    assert.equal((await outbox.take(50)).requestId, id);

    // Attempt 2 (BullMQ retry) with the same id.
    const second = outbox.sendMessage({ to: TO, text: TEXT, requestId: id, ledgerId, jobId: "314000" });
    assert.equal(outbox.tracks(id), "pending", "the task is offered again, not re-created");
    const redelivered = await outbox.take(50);
    assert.equal(redelivered.requestId, id, "the phone sees the SAME task again");
    assert.equal(outbox.stats().pending + outbox.stats().inflight, 1);

    // The phone recognises the id and only re-acks: one physical send, two
    // satisfied attempts.
    assert.equal(outbox.acknowledge(id, true, {}).outcome, "sent");
    assert.equal((await first).type, "sent");
    assert.equal((await second).type, "sent");
    assert.equal(outbox.stats().tombsTones ?? outbox.stats().tombstones, 1);
  });
});

test("a retry after the task already settled is answered from the tombstone", async () => {
  await withStore(async (store) => {
    const ledgerId = store.create({ to: TO, text: TEXT, keyName: "EVE new" });
    store.attachJob(ledgerId, "314001");
    const id = gatewayRequestIdFor(store, "314001");
    const outbox = new AndroidOutbox();

    const first = outbox.sendMessage({ to: TO, text: TEXT, requestId: id, ledgerId, jobId: "314001" });
    await outbox.take(50);
    outbox.acknowledge(id, true, { requestedTo: TO, sentTo: TO });
    assert.equal((await first).type, "sent");

    // A late/stalled attempt of the SAME job arrives after the phone already
    // confirmed delivery. It must NOT be handed to the phone again.
    const retry = outbox.sendMessage({ to: TO, text: TEXT, requestId: id, ledgerId, jobId: "314001" });
    const replayed = await retry;
    assert.equal(replayed.type, "sent");
    assert.equal(replayed.duplicate, true);
    assert.equal(await outbox.take(30), null, "nothing may be re-delivered after a terminal outcome");
  });
});

test("task.meta is NEVER null — the phone cannot ack a task it cannot track", async () => {
  const outbox = new AndroidOutbox();
  // A legacy send: no consumer notification identity at all.
  const worker = outbox.sendMessage({ to: TO, text: TEXT, requestId: "send_1" });
  const task = await outbox.take(50);
  assert.equal(typeof task.meta, "object");
  assert.notEqual(task.meta, null);
  assert.deepEqual(task.meta, {
    source: null, serviceKey: null, notificationKind: null,
    generation: null, correlationId: null, requiresValidation: false
  });
  outbox.acknowledge("send_1", true, {});
  await worker;
});

test("release() drops the entry but a late ACK is still recognised", async () => {
  const outbox = new AndroidOutbox();
  const worker = outbox.sendMessage({ to: TO, text: TEXT, requestId: "send_2" });
  await outbox.take(50);
  assert.equal(outbox.tracks("send_2"), "inflight");

  assert.equal(outbox.release("send_2"), true);
  assert.equal(outbox.tracks("send_2"), null);
  await assert.rejects(() => worker, /task_released/);

  // The phone's very late ACK is still answered, not swallowed.
  const late = outbox.acknowledge("send_2", true, {});
  assert.equal(late.handled, true);
  assert.equal(late.outcome, "sent_after_revocation");
});

test("a caller that supplies no id still gets a unique one (backward compatible)", async () => {
  const outbox = new AndroidOutbox();
  const a = outbox.sendMessage({ to: TO, text: TEXT });
  const first = await outbox.take(50);
  outbox.acknowledge(first.requestId, true, {});
  await a;
  const b = outbox.sendMessage({ to: TO, text: TEXT });
  const second = await outbox.take(50);
  assert.notEqual(first.requestId, second.requestId);
  outbox.acknowledge(second.requestId, true, {});
  await b;
});

// ── source guards: the fix must live in the worker, not only in the bridge ──
test("the worker passes a stable requestId and an always-object meta", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  assert.ok(server.includes("const gatewayRequestId = requestIdForJob(job) ||"),
    "the worker must derive ONE id per job");
  assert.ok(server.includes("requestId: gatewayRequestId"),
    "...and pass it to the transport");
  assert.ok(server.includes("const notificationMeta = {"),
    "meta must be built as an object even for a send with no notification identity");
  assert.equal(/ledgerRow\?\.service_key \? \{/.test(server), false,
    "the old 'null meta when there is no serviceKey' branch must be gone");
  assert.ok(server.includes('isBrowserAutomationWedge(error) && client.name !== "android"'),
    "an Android send timeout is not a browser wedge");
  assert.ok(server.includes("android_ack_missing"),
    "an unacknowledged Android task is unverified, never a plain failure");
});
