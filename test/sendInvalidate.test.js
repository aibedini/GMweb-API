const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SendStore, normalizeNotificationMeta, selectInvalidatableSends,
  summarizeInvalidation, NOTIFICATION_KINDS } = require("../src/sendStore");
const { requiredProjectKeyScope, PROJECT_KEY_SCOPES } = require("../src/projectKeyScopes");
const contract = require("../shared/eve-gmweb-contract-v1.json");

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-invalidate-"));
  const store = new SendStore(path.join(dir, "sends.db"));
  try {
    return fn(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function queueNotification(store, { to, text, kind, generation, serviceKey = "eve:1:uuid-A",
                                    source = "eve", requiresValidation = true,
                                    jobId = null } = {}) {
  const id = store.create({ to, text, keyName: "eve", priority: "expiring" });
  store.setNotification(id, { source, serviceKey, notificationKind: kind,
                               generation, correlationId: "corr-1", requiresValidation });
  if (jobId) store.attachJob(id, jobId);
  return id;
}

test("the contract declares /send/invalidate with the sms.invalidate scope", () => {
  const entry = contract.endpoints.find((item) => item.key === "post_invalidate");
  assert.equal(entry.method, "POST");
  assert.equal(entry.path, "/send/invalidate");
  assert.equal(entry.scope, "sms.invalidate");
  assert.ok(PROJECT_KEY_SCOPES.includes("sms.invalidate"));
  assert.equal(requiredProjectKeyScope("POST", "/send/invalidate"), "sms.invalidate");
  assert.equal(requiredProjectKeyScope("POST", "/send/cancel/send_1"), "sms.cancel");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  assert.ok(source.includes('app.post("/send/invalidate"'),
    "the production route must exist for the contract to hold");
});

test("the documented example answer matches the declared response shape", () => {
  const example = contract.invalidationResponse.example;
  assert.deepEqual(Object.keys(contract.invalidationResponse.fields).sort(),
    ["alreadyTerminal", "cancelledPending", "currentGeneration", "matched",
      "ok", "replayed", "revokedActive", "revokedInflight"].sort());
  assert.equal(example.ok, true);
  assert.equal(example.currentGeneration, 18);
  assert.equal(example.cancelledPending, 2);
  assert.equal(example.revokedActive, 1);
  assert.equal(example.revokedInflight, 1);
  assert.equal(example.alreadyTerminal, 0);
});

test("notification meta is whitelisted and bounded", () => {
  const meta = normalizeNotificationMeta({
    source: "eve", serviceKey: "eve:1:uuid-A", notificationKind: "volume_ended",
    generation: 17, correlationId: "c1", requiresValidation: true,
    text: "must never be stored", smsBody: "nor this"
  });
  assert.deepEqual(meta, {
    source: "eve", serviceKey: "eve:1:uuid-A", notificationKind: "volume_ended",
    correlationId: "c1", generation: 17, requiresValidation: true
  });
  const huge = normalizeNotificationMeta({ serviceKey: "x".repeat(500) });
  assert.equal(huge.serviceKey.length, 200);
  assert.equal(huge.generation, null);
  assert.equal(huge.requiresValidation, false);
  assert.deepEqual(normalizeNotificationMeta(undefined), {
    source: null, serviceKey: null, notificationKind: null, correlationId: null,
    generation: null, requiresValidation: false
  });
  assert.ok(NOTIFICATION_KINDS.includes("volume_ended"));
});

test("only sends tagged with a matching serviceKey are invalidatable", () => {
  withStore((store) => {
    const a1 = queueNotification(store, { to: "+989120000001", text: "A1", kind: "volume_ended", generation: 17 });
    const a2 = queueNotification(store, { to: "+989120000002", text: "A2", kind: "expired", generation: 17 });
    queueNotification(store, { to: "+989120000003", text: "B1", kind: "volume_ended",
                         generation: 4, serviceKey: "eve:1:uuid-B" });
    const untagged = store.create({ to: "+989120000004", text: "plain", keyName: "eve" });

    const rows = store.invalidatableSends("eve", "eve:1:uuid-A");
    assert.deepEqual(rows.map((row) => row.id).sort(), [a1, a2].sort());
    assert.equal(rows.some((row) => row.id === untagged), false);
    // Renewing A must never reach B: same phone owner, different service.
    assert.equal(rows.every((row) => row.service_key === "eve:1:uuid-A"), true);
  });
});

test("a settled send is never offered for invalidation", () => {
  withStore((store) => {
    const queued = queueNotification(store, { to: "+989120000010", text: "Q", kind: "volume_ended", generation: 17, jobId: "job-q" });
    const active = queueNotification(store, { to: "+989120000011", text: "A", kind: "volume_ended", generation: 17, jobId: "job-a" });
    const sent = queueNotification(store, { to: "+989120000012", text: "S", kind: "volume_ended", generation: 17, jobId: "job-s" });
    store.markStatus("job-a", "active", { attempts: 1 });
    store.markStatus("job-s", "sent", { attempts: 1 });

    const rows = store.invalidatableSends("eve", "eve:1:uuid-A");
    assert.deepEqual(rows.map((row) => row.id).sort(), [queued, active].sort());
    assert.equal(rows.some((row) => row.id === sent), false);
  });
});

test("invalidateKinds narrows the match and transactional kinds never match", () => {
  withStore((store) => {
    const ended = queueNotification(store, { to: "+989120000020", text: "E", kind: "volume_ended", generation: 3 });
    const expired = queueNotification(store, { to: "+989120000021", text: "X", kind: "expired", generation: 3 });
    const confirmation = queueNotification(store, { to: "+989120000022", text: "R", kind: "renew",
                                              generation: 3, requiresValidation: false });
    queueNotification(store, { to: "+989120000023", text: "C", kind: "created",
                         generation: 3, requiresValidation: false });
    const rows = store.invalidatableSends("eve", "eve:1:uuid-A");

    const onlyEnded = selectInvalidatableSends(rows, ["volume_ended"]);
    assert.deepEqual(onlyEnded.map((row) => row.id), [ended]);
    // The confirmation telling the customer "renewed" is never revoked.
    assert.equal(onlyEnded.some((row) => row.id === confirmation), false);
    assert.equal(selectInvalidatableSends(rows, []).length, 4);
    assert.deepEqual(
      selectInvalidatableSends(rows, ["volume_ended", "expired"]).map((row) => row.id).sort(),
      [ended, expired].sort());
    assert.deepEqual(selectInvalidatableSends(rows, ["renew"]).map((row) => row.id), [confirmation]);
  });
});

test("a send with no notificationKind is never matched by a lifecycle invalidation", () => {
  withStore((store) => {
    store.create({ to: "+989120000030", text: "legacy", keyName: "eve" });
    const rows = store.invalidatableSends("eve", "eve:1:uuid-A");
    assert.equal(rows.length, 0);
  });
});

test("the generation watermark is monotonic per service", () => {
  withStore((store) => {
    assert.equal(store.generationFor("eve", "eve:1:uuid-A"), null);
    assert.equal(store.advanceGeneration("eve", "eve:1:uuid-A", 18), 18);
    // A duplicate or out-of-order invalidation must not lower the watermark.
    assert.equal(store.advanceGeneration("eve", "eve:1:uuid-A", 17), 18);
    assert.equal(store.advanceGeneration("eve", "eve:1:uuid-A", 18), 18);
    assert.equal(store.advanceGeneration("eve", "eve:1:uuid-A", 19), 19);
    // Another service keeps its own watermark.
    assert.equal(store.generationFor("eve", "eve:1:uuid-B"), null);
    assert.equal(store.advanceGeneration("eve", "eve:1:uuid-B", 2), 2);
    assert.equal(store.generationFor("eve", "eve:1:uuid-A"), 19);
    assert.equal(store.advanceGeneration("eve", "eve:1:uuid-A", -5), null);
  });
});

test("eventId replays the original answer instead of acting twice", () => {
  withStore((store) => {
    assert.equal(store.invalidationResult("lc-1"), null);
    const response = { ok: true, currentGeneration: 18, cancelledPending: 2,
                       revokedActive: 1, revokedInflight: 1, alreadyTerminal: 0 };
    assert.equal(store.rememberInvalidation("lc-1", {
      source: "eve", serviceKey: "eve:1:uuid-A", response }), true);
    assert.deepEqual(store.invalidationResult("lc-1"), response);
    // A second remember with different content must not overwrite the ledger.
    store.rememberInvalidation("lc-1", {
      source: "eve", serviceKey: "eve:1:uuid-A", response: { ok: false } });
    assert.deepEqual(store.invalidationResult("lc-1"), response);
  });
});

test("invalidation counters classify each send by the state it was in", () => {
  const rows = [
    { id: 1, status: "queued", notification_kind: "volume_ended" },
    { id: 2, status: "queued", notification_kind: "near_expiry" },
    { id: 3, status: "active", notification_kind: "expired" },
    { id: 4, status: "cancelled", notification_kind: "low_volume" },
    { id: 5, status: "queued", notification_kind: "volume_ended" }
  ];
  const decisions = [
    { statusCode: 200, body: { ok: true, cancelled: true, state: "cancelled" } },
    { statusCode: 200, body: { ok: true, cancelled: true, state: "cancelled" } },
    { statusCode: 200, body: { ok: true, cancelled: true, state: "cancelled" } },
    { statusCode: 200, body: { ok: true, cancelled: true, alreadyCancelled: true, state: "cancelled" } },
    { statusCode: 409, body: { ok: false, error: "not_cancellable", reason: "already_terminal" } }
  ];
  assert.deepEqual(summarizeInvalidation(rows, decisions), {
    cancelledPending: 2, revokedActive: 1, revokedInflight: 1, alreadyTerminal: 1
  });
});

test("a send that was already terminal is reported, not silently dropped", () => {
  const rows = [{ id: 9, status: "queued", notification_kind: "expired" }];
  const counts = summarizeInvalidation(rows, [
    { statusCode: 409, body: { error: "not_cancellable", reason: "already_terminal" } }
  ]);
  assert.equal(counts.alreadyTerminal, 1);
  assert.equal(counts.cancelledPending, 0);
});

test("requiresValidation marks the sends that still need a live check", () => {
  withStore((store) => {
    queueNotification(store, { to: "+989120000040", text: "D", kind: "volume_ended",
                         generation: 17, requiresValidation: true });
    assert.equal(store.hasValidationRequired("eve:1:uuid-A"), true);
    assert.equal(store.hasValidationRequired("eve:1:uuid-B"), false);
    queueNotification(store, { to: "+989120000041", text: "R", kind: "renew",
                         generation: 17, requiresValidation: false });
    assert.equal(store.hasValidationRequired("eve:1:uuid-A"), true);
  });
});

test("the invalidate route reuses the same cancel decision as /send/cancel", () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
  const server = read("server.js");
  const service = read("sendRevocation.js");
  const gateway = read("gatewayRoutes.js");
  const worker = read("androidOutbox.js");

  // ONE state machine, in its own durable layer, called by both routes.
  assert.ok(service.includes("async function cancelOne(reference, options"),
    "the shared cancel state machine lives in sendRevocation.js");
  assert.ok(server.includes("return sendRevocation.cancelOne(reference, options)"),
    "/send/cancel delegates to it");
  assert.ok(server.includes("sendRevocation.invalidate("),
    "/send/invalidate delegates to it");
  assert.ok(service.includes("stale_generation"),
    "an out-of-order invalidation is refused, not applied");
  assert.ok(service.includes("rememberInvalidation"),
    "the answer is durable so a retry replays it");
  assert.ok(service.includes("sendStore.advanceGeneration"),
    "the generation barrier is advanced BEFORE the revoke loop");

  // The fix is only real if every hop re-reads the durable decision.
  assert.ok(server.includes("sendRevocation.guardForJob(job.id)"),
    "the BullMQ worker consults the ledger before touching a transport");
  assert.ok(server.includes("revoked_at"),
    "the pull bridge's durable hook reads the tombstone");
  assert.ok(gateway.includes('app.post("/gateway/validate"'),
    "Android can validate a task before submitting it to the SIM");
  assert.ok(gateway.includes("sendStore.isSuperseded(row)"),
    "validation answers from the durable ledger, not just memory");
  assert.ok(worker.includes("revokeRequest"),
    "the outbox can revoke a pending or in-flight task");
  assert.ok(worker.includes("tombstones"),
    "an in-flight task keeps its identity after being revoked");

  // A synchronous /send?wait=true must never report a superseded reminder as a
  // completed send, and the 200 response schema must not strip the verdict.
  const waitStart = server.indexOf("if (result?.superseded)");
  const waitEnd = server.indexOf("if (result?.cancelled)");
  assert.ok(waitStart !== -1 && waitEnd > waitStart,
    "/send?wait=true has its own superseded branch before the cancelled one");
  const waitBranch = server.slice(waitStart, waitEnd);
  for (const fragment of ['status: "superseded"', "terminal: true",
    "successful: false", "retryable: false", "counted: false"]) {
    assert.ok(waitBranch.includes(fragment), `wait branch must report ${fragment}`);
  }
  assert.ok(server.includes('"cancelled", "failed", "superseded"\]'),
    "the /send 200 response schema declares the superseded status");
});

test("the ledger migration is additive and old rows stay readable", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "sendStore.js"), "utf8");
  for (const column of ["revoked_at", "revocation_reason", "revocation_json",
    "gateway_request_id", "notification_generation", "requires_validation"]) {
    assert.ok(source.includes(`ADD COLUMN ${column}`), `missing additive column: ${column}`);
  }
  assert.ok(source.includes("CREATE TABLE IF NOT EXISTS send_counters"),
    "durable counters live in their own additive table");
  assert.ok(source.includes("CREATE TABLE IF NOT EXISTS send_counters"));
  assert.equal(/DROP TABLE|DROP COLUMN|DELETE FROM sends/.test(source), false,
    "no destructive migration may exist");
});
