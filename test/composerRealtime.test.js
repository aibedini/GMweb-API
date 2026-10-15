"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Fastify = require("fastify");
const { SendStore } = require("../src/sendStore");
const { AndroidOutbox } = require("../src/androidOutbox");
const { registerGatewayRoutes } = require("../src/gatewayRoutes");
const { smsCapabilities } = require("../src/smsCapabilities");

test("multiline composer shortcuts preserve Enter and IME composition", async () => {
  const { shouldSendMessage, growMessageTextarea } = await import("../shared/smsComposer.ts");
  const enter = { key: "Enter", ctrlKey: false, metaKey: false, isComposing: false };
  assert.equal(shouldSendMessage(enter), false);
  assert.equal(shouldSendMessage({ ...enter, ctrlKey: true }), true);
  assert.equal(shouldSendMessage({ ...enter, metaKey: true }), true);
  assert.equal(shouldSendMessage({ ...enter, ctrlKey: true, isComposing: true }), false);
  const node = { style: {}, scrollHeight: 450 };
  growMessageTextarea(node); assert.equal(node.style.height, "192px");
  node.scrollHeight = 80; growMessageTextarea(node); assert.equal(node.style.height, "80px");
});

test("mixed alphabet and newline change segment boundaries immediately", async () => {
  const { calculateSmsSegments: count } = await import("../web/src/lib/smsSegments.ts");
  assert.equal(count("a".repeat(159) + "\n").segments, 1);
  assert.equal(count("a".repeat(160) + "\n").segments, 2);
  assert.equal(count("a".repeat(69) + "س").segments, 1);
  assert.equal(count("a".repeat(70) + "س").segments, 2);
  assert.equal(count("^".repeat(153)).segments, 3);
  assert.equal(count(" leading\nسلام hello\n trailing ").encoding, "Unicode");
});

test("SIM capability freshness and unknown permissions are honest", () => {
  const now = Date.now();
  const telemetry = { receivedAt: now, smsSubscriptions: { available: true, items: [
    { subscriptionId: 7, slotIndex: 0, carrierName: "Irancell", isActive: true, isDefaultSms: true },
    { subscriptionId: 9, slotIndex: 1, carrierName: "MCI", isActive: false, sendCapable: false }
  ] } };
  const caps = smsCapabilities(telemetry, now);
  assert.equal(caps.available, true); assert.equal(caps.items.length, 2);
  assert.equal(caps.items[0].carrierName, "Irancell");
  assert.equal(caps.items[0].sendCapable, null); assert.equal(caps.sendSmsPermission, null);
  assert.equal(caps.items[1].sendCapable, false); assert.equal(caps.items[1].isActive, false);
  assert.equal(smsCapabilities(telemetry, now + 180001).available, false);
  assert.equal(smsCapabilities(null, now).available, false);
});

test("durable send retains exact body, SIM and browser identity across restart", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-composer-"));
  const file = path.join(dir, "sends.db");
  const original = new SendStore(file);
  let restored;
  t.after(() => {
    if (original.db.open) original.db.close();
    if (restored?.db.open) restored.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const payload = { to: "+989120000000", text: "  سلام\nhello\n  ", keyName: "test", subscriptionId: 9,
    clientMessageId: "synthetic_message_1", idempotencyKey: "synthetic_message_1" };
  const id = original.create(payload);
  assert.throws(() => original.create(payload), /client_message_already_exists/);
  assert.throws(() => original.create({ ...payload, subscriptionId: 7 }), /client_message_id_reused/);
  original.db.close();
  restored = new SendStore(file);
  const row = restored.byClientMessageId(payload.clientMessageId, "test");
  assert.equal(row.id, id); assert.equal(row.text, payload.text); assert.equal(row.subscription_id, 9);
  assert.equal(restored.byClientMessageId(payload.clientMessageId, "another-project"), undefined);
  const first = restored.claim({ to: payload.to, text: "synthetic", keyName: "test", subscriptionId: 7, windowMs: 120000 });
  assert.equal(first.action, "new");
  assert.equal(restored.claim({ to: payload.to, text: "synthetic", keyName: "test", subscriptionId: 9, windowMs: 120000 }).action, "new");
  assert.equal(restored.claim({ to: payload.to, text: "synthetic", keyName: "test", subscriptionId: 7, windowMs: 120000 }).action, "duplicate_inflight");
  assert.equal(restored.claim({ to: payload.to, text: "synthetic\nsim:7", keyName: "test", windowMs: 120000 }).action, "new");
});

test("push transport forwards exact text, selected SIM and stable request header", async t => {
  const http = require("node:http");
  const { AndroidGatewayClient } = require("../src/androidGatewayClient");
  let received;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") {
        received = { body: JSON.parse(data), id: req.headers["idempotency-key"] };
        res.end(JSON.stringify({ requestId: "phone_synthetic" }));
      } else res.end(JSON.stringify({ status: "sent", successful: true, submittedOnce: true, terminal: true }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const client = new AndroidGatewayClient({ androidGatewayBaseUrl: `http://127.0.0.1:${server.address().port}`,
    androidGatewayApiKey: "synthetic-key", androidSendTimeoutMs: 5000, androidStatusPollMs: 1 });
  const payload = { to: "+989120000000", text: " leading\nمتن\n ", subscriptionId: 7,
    clientMessageId: "synthetic_push", requestId: "send_synthetic_push" };
  await client.sendMessage(payload);
  assert.equal(received.body.text, payload.text); assert.equal(received.body.subscriptionId, 7);
  assert.equal(received.body.clientMessageId, payload.clientMessageId); assert.equal(received.id, payload.requestId);
});

test("gateway HTTP serialization preserves SIM and correlation, including redelivery", async t => {
  const stages = [];
  const outbox = new AndroidOutbox({ onPull: id => stages.push(id) });
  const app = Fastify(); registerGatewayRoutes(app, { outbox, checkDeviceKey: () => true });
  t.after(() => app.close());
  const payload = { to: "+989120000000", text: "  one\nدو\n ", subscriptionId: 9,
    clientMessageId: "synthetic_message_2", requestId: "send_synthetic" };
  const worker = outbox.sendMessage(payload);
  const response = await app.inject({ url: "/gateway/pull?waitMs=1000" });
  assert.equal(response.statusCode, 200);
  const task = response.json().task;
  assert.equal(task.text, payload.text); assert.equal(task.subscriptionId, 9);
  assert.equal(task.clientMessageId, payload.clientMessageId);
  const retry = outbox.sendMessage(payload);
  const replay = await app.inject({ url: "/gateway/pull?waitMs=1000" });
  assert.equal(replay.json().task.requestId, task.requestId);
  assert.equal(replay.json().task.subscriptionId, 9);
  outbox.ack(task.requestId, true, { sentAt: Date.now() });
  await Promise.all([worker, retry]);
  assert.ok(stages.length >= 1);
});

test("live state requires carrier evidence; Android errors retain their reason", async () => {
  const { sendStatusLabel, androidError } = await import("../shared/smsStatus.ts");
  assert.equal(sendStatusLabel({ status: "queued" }), "Queued");
  assert.equal(sendStatusLabel({ status: "active", stage: "phone_pulled" }), "Pulled by phone");
  assert.equal(sendStatusLabel({ status: "active", stage: "phone_sending" }), "Submitting");
  assert.equal(sendStatusLabel({ status: "sent" }), "Sent");
  assert.equal(sendStatusLabel({ status: "sent", submittedOnce: false }), "Submission unverified");
  assert.equal(sendStatusLabel({ status: "sent", carrierStatus: { status: "delivered" } }), "Delivered");
  assert.equal(sendStatusLabel({ status: "unverified" }), "Submission unverified");
  assert.equal(androidError('{"error":"selected_sim_unavailable"}'), "Selected SIM unavailable");
  assert.equal(androidError("send_sms_permission_missing"), "SEND_SMS permission missing");
  assert.equal(androidError("not_default_sms_app"), "Phone is not default SMS app");
  assert.equal(androidError("vendor_specific_failure: modem busy"), "vendor_specific_failure: modem busy");
  assert.equal(androidError("radio_error"), "radio_error");
});

test("modem progress is authenticated, correlated and cannot claim Sent", async t => {
  const app = Fastify(); const events = []; const stages = [];
  const row = { id: 1, job_id: "synthetic-job", status: "active", client_message_id: "synthetic-progress" };
  registerGatewayRoutes(app, { outbox: new AndroidOutbox(),
    checkDeviceKey: request => request.headers["x-api-key"] === "synthetic-key",
    sendStore: { byGatewayRequest: id => id === "send_1" ? row : null,
      requestId: id => `send_${id}`, markStage: (job, stage) => stages.push({ job, stage }) },
    onSendProgress: event => events.push(event) });
  t.after(() => app.close());
  const payload = { requestId: "send_1", clientMessageId: "synthetic-progress", stage: "submitting" };
  assert.equal((await app.inject({ method: "POST", url: "/gateway/progress", payload })).statusCode, 401);
  const headers = { "x-api-key": "synthetic-key" };
  assert.equal((await app.inject({ method: "POST", url: "/gateway/progress", headers, payload: { ...payload, stage: "sent" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/gateway/progress", headers, payload: { ...payload, clientMessageId: "another-message" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/gateway/progress", headers, payload })).statusCode, 200);
  assert.deepEqual(stages, [{ job: "synthetic-job", stage: "phone_submitting" }]);
  assert.equal(events[0].requestId, "send_1");
  row.revoked_at = Date.now();
  assert.equal((await app.inject({ method: "POST", url: "/gateway/progress", headers, payload })).statusCode, 409);
});
