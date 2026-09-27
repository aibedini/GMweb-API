"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SendStore } = require("../src/sendStore");
const { EveSmsEvents, eveEventsConfig, signature, retryDelay } = require("../src/eveSmsEvents");

const SECRET = "01234567".repeat(4); // synthetic 32-character test input
const CONFIG = { url: "https://eve.example.test/internal/gmweb/sms/events", secret: SECRET };
const TO = "+989121234567";
const TEXT = "private body sentinel";

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-eve-events-"));
  const dbPath = path.join(dir, "sends.db");
  const store = new SendStore(dbPath);
  const cleanup = () => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); };
  return Promise.resolve().then(() => fn(store, dbPath)).finally(cleanup);
}

function eveSend(store) {
  return store.create({
    to: TO, text: TEXT, keyName: "eve", notification: {
      source: "eve", serviceKey: "eve:1:uuid", notificationKind: "near_expiry",
      generation: 14, correlationId: TO, requiresValidation: true
    }
  });
}

function rows(store) {
  return store.db.prepare("SELECT * FROM eve_sms_outbox ORDER BY id").all();
}

test("configuration fails closed and requires HTTPS plus a 32-character secret", () => {
  assert.equal(eveEventsConfig({}), null);
  assert.throws(() => eveEventsConfig({ WEBHOOK_URL: CONFIG.url }), /must not target/);
  assert.throws(() => eveEventsConfig({ EVE_SMS_EVENTS_URL: CONFIG.url }), /both be configured/);
  assert.throws(() => eveEventsConfig({ EVE_SMS_EVENTS_URL: "http://eve.example.test", EVE_SMS_EVENTS_SECRET: SECRET }), /HTTPS/);
  assert.deepEqual(eveEventsConfig({ EVE_SMS_EVENTS_URL: CONFIG.url, EVE_SMS_EVENTS_SECRET: SECRET }), CONFIG);
});

test("signature uses the exact fixed timestamp, delivery ID and raw body", () => {
  const body = Buffer.from('{ "event_id" : "abc" }', "utf8");
  const expected = crypto.createHmac("sha256", SECRET)
    .update("1700000000.delivery-1.").update(body).digest("hex");
  assert.equal(signature(SECRET, "1700000000", "delivery-1", body), `sha256=${expected}`);
  assert.notEqual(signature(SECRET, "1700000000", "delivery-1", Buffer.from('{"event_id":"abc"}')), `sha256=${expected}`);
});

test("queued, sent and cancellation are committed with the ledger; replay adds no event", async () => fixture((store) => {
  const id = eveSend(store);
  assert.equal(rows(store).length, 1);
  store.attachJob(id, "job-1");
  store.markStatus("job-1", "active");
  assert.equal(rows(store).length, 1, "active is gateway work, not physical submission");
  store.markStatus("job-1", "sent", { attempts: 1 });
  store.markStatus("job-1", "sent", { attempts: 1 });
  assert.deepEqual(rows(store).map((row) => row.event_type), ["send.queued", "send.sent"]);
  const second = eveSend(store);
  store.markById(second, "superseded", "renewed");
  assert.deepEqual(rows(store).slice(2).map((row) => row.event_type), ["send.queued", "send.cancelled"]);
  const legacy = store.create({ to: TO, text: TEXT, keyName: "other" });
  store.markById(legacy, "sent");
  assert.equal(rows(store).length, 4, "non-Eve messages have no callback");
  assert.throws(() => store.db.prepare("UPDATE eve_sms_outbox SET body='{}' WHERE id=?").run(rows(store)[0].id),
    /immutable_eve_event/, "retry cannot rewrite the signed event body");
  const manual = eveSend(store);
  store.markById(manual, "sent");
  assert.deepEqual(rows(store).filter((row) => row.send_id === manual).map((row) => row.event_type),
    ["send.queued"], "admin completion has no physical evidence and cannot emit send.sent");
}));

test("callback body is allowlisted, bounded and signed over exact transmitted bytes", async () => fixture(async (store) => {
  const id = eveSend(store);
  store.markById(id, "failed", `failure for ${TO}: ${TEXT}`);
  const seen = [];
  let now = Date.now() + 1000;
  const sender = new EveSmsEvents(store.db, CONFIG, {
    now: () => now,
    fetch: async (_url, request) => {
      seen.push(request);
      return { status: 204 };
    }
  });
  assert.equal(await sender.tick(), true);
  assert.equal(await sender.tick(), true);
  assert.equal(seen.length, 2);
  for (const request of seen) {
    const body = Buffer.from(request.body);
    const parsed = JSON.parse(body.toString("utf8"));
    assert.deepEqual(Object.keys(parsed).sort(), ["event_id", "message_id", "occurred_at", "trace_id", "type"].sort());
    assert.equal(parsed.message_id, `send_${id}`);
    assert.match(parsed.occurred_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(body.includes(Buffer.from(TEXT)), false);
    assert.equal(body.includes(Buffer.from(TO)), false);
    const ts = request.headers["X-GMweb-Timestamp"];
    const deliveryId = request.headers["X-GMweb-Delivery-Id"];
    const expected = crypto.createHmac("sha256", SECRET)
      .update(Buffer.concat([Buffer.from(`${ts}.${deliveryId}.`), body])).digest("hex");
    assert.equal(request.headers["X-GMweb-Signature"], `sha256=${expected}`);
    assert.equal(signature(SECRET, ts, deliveryId, body), `sha256=${expected}`);
  }
  assert.deepEqual(rows(store).map((row) => row.state), ["delivered", "delivered"]);
  assert.ok(rows(store).every((row) => row.delivered_at));
}));

test("network failure survives restart and retries identical body and delivery ID", async () => fixture(async (store, dbPath) => {
  eveSend(store);
  let now = Date.now() + 1000;
  const calls = [];
  const failing = new EveSmsEvents(store.db, CONFIG, {
    now: () => now, random: () => 0,
    fetch: async (_url, request) => { calls.push(request); throw new Error(`secret ${SECRET} ${TO}`); }
  });
  await failing.tick();
  const pending = rows(store)[0];
  assert.equal(pending.state, "retry_wait");
  assert.equal(pending.last_error, "network_error");
  assert.ok(pending.next_attempt_at > now);
  store.close();
  const reopened = new SendStore(dbPath);
  try {
    now = pending.next_attempt_at;
    const recovered = new EveSmsEvents(reopened.db, CONFIG, {
      now: () => now,
      fetch: async (_url, request) => { calls.push(request); return { status: 200 }; }
    });
    await recovered.tick();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(calls[0].headers["X-GMweb-Delivery-Id"], calls[1].headers["X-GMweb-Delivery-Id"]);
    const final = rows(reopened)[0];
    assert.equal(final.state, "delivered");
    assert.equal(final.attempt_count, 2);
    assert.equal(rows(reopened).length, 1);
  } finally { reopened.close(); }
}));

test("stale delivering claims recover; retryable HTTP waits and permanent rejection is retained", async () => fixture(async (store) => {
  eveSend(store);
  let now = Date.now() + 1000;
  const statuses = [429, 400];
  const sender = new EveSmsEvents(store.db, CONFIG, {
    now: () => now, random: () => 0,
    fetch: async () => ({ status: statuses.shift() })
  });
  await sender.tick();
  let row = rows(store)[0];
  assert.equal(row.state, "retry_wait");
  assert.equal(row.last_http_status, 429);
  now = row.next_attempt_at;
  await sender.tick();
  row = rows(store)[0];
  assert.equal(row.state, "dead_letter");
  assert.equal(row.last_http_status, 400);
  assert.equal(await sender.tick(), false);
  assert.equal(retryDelay(100, () => 1), 15 * 60 * 1000);

  const id = eveSend(store);
  const stuck = rows(store).find((item) => item.send_id === id);
  store.db.prepare("UPDATE eve_sms_outbox SET state='delivering', last_attempt_at=? WHERE id=?")
    .run(now - 31_000, stuck.id);
  const recovery = new EveSmsEvents(store.db, CONFIG, { now: () => now, fetch: async () => ({ status: 200 }) });
  await recovery.tick();
  assert.equal(rows(store).find((item) => item.id === stuck.id).state, "delivered");
}));

test("late physical ACK after failure records sent but never fabricates delivered", async () => fixture((store) => {
  const id = eveSend(store);
  store.markById(id, "failed", "device unavailable");
  store.reconcileLateSent(id, { reason: "late_ack_confirmed_failed", sentAt: Date.now() });
  assert.deepEqual(rows(store).map((row) => row.event_type), ["send.queued", "send.failed", "send.sent"]);
  assert.equal(rows(store).some((row) => row.event_type === "send.delivered"), false);
}));
