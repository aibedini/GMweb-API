"use strict";
// Android v3.4.27 additive carrier-delivery contract.
//
// Android v3.4.27 added optional carrier metadata to the EXISTING
// /gateway/delivery-report payload. This suite pins that the extension is
// purely additive: a legacy four-field client keeps working, the new metadata
// is persisted (never fabricated as 0/false when absent), the same-transaction
// Eve callback carries the snake_case diagnostics, and idempotency still holds.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Fastify = require("fastify");
const { SendStore } = require("../src/sendStore");
const { registerGatewayRoutes } = require("../src/gatewayRoutes");

const at = 1_779_000_000_000;
const DEVICE = "aaaabbbbccccdddd";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-dlr3427-"));
  const dbPath = path.join(dir, "sends.db");
  const store = new SendStore(dbPath);
  let reopened = null;
  const id = store.create({
    to: "+989121234567", text: "sensitive-sms-content", keyName: "eve",
    notification: { source: "eve", serviceKey: "eve:1:uuid", notificationKind: "created",
      generation: 1, eveNotificationId: "eve-notification-42" }
  });
  store.attachGatewayRequest(id, "pull_123");
  return { store, dbPath, id, dir,
    // The reopened store must be closed too, or Windows keeps the file locked.
    reopen() { store.close(); const next = new SendStore(dbPath); reopened = next; return next; },
    close() { try { store.close(); } catch { /* already closed */ }
      try { reopened?.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

/** Legacy four-field payload: the original contract, no optional metadata. */
const legacy = (over = {}) => ({ eventId: "dlr_legacy", requestId: "pull_123",
  status: "delivered", occurredAt: at, ...over });

/** Complete v3.4.27 payload. */
const v3427 = (over = {}) => ({ eventId: "dlr_v27", requestId: "pull_123",
  status: "delivered", occurredAt: at,
  eventType: "carrier_delivery", segmentIndex: 0, segmentCount: 3,
  allSegmentsDelivered: true, receivedAtDevice: at - 500,
  subscriptionId: 2, carrierResultCode: 0, ...over });

const metaOf = (over = {}) => ({ segmentIndex: 0, segmentCount: 3, allSegmentsDelivered: true,
  receivedAtDevice: at - 500, subscriptionId: 2, carrierResultCode: 0, ...over });

const eveBody = (store) => {
  const row = store.db.prepare("SELECT body FROM eve_sms_outbox WHERE event_type LIKE 'sms.%' ORDER BY id DESC LIMIT 1").get();
  return row ? JSON.parse(row.body) : null;
};

// 1 — legacy compatibility
test("1: the legacy four-field payload is still accepted and unchanged", () => {
  const f = setup();
  try {
    const result = f.store.recordCarrierReport(legacy());
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    const row = f.store.db.prepare("SELECT * FROM carrier_delivery_reports WHERE event_id=?").get("dlr_legacy");
    assert.equal(row.status, "delivered");
    assert.equal(row.segment_index, null, "absent stays NULL");
    assert.equal(row.segment_count, null);
    assert.equal(row.all_segments_delivered, null);
    assert.equal(row.received_at_device, null);
    assert.equal(row.subscription_id, null);
    assert.equal(row.carrier_result_code, null);
  } finally { f.close(); }
});

// 2, 3, 14, 15, 16 — full payload persisted; null vs 0 distinction
test("2/3/14/15/16: the complete v3.4.27 payload persists exactly, and 0 is not null", () => {
  const f = setup();
  try {
    assert.equal(f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123",
      status: "delivered", occurredAt: at, meta: metaOf() }).ok, true);
    const row = f.store.db.prepare("SELECT * FROM carrier_delivery_reports WHERE event_id=?").get("dlr_v27");
    assert.equal(row.segment_index, 0);
    assert.equal(row.segment_count, 3);
    assert.equal(row.all_segments_delivered, 1, "true stored as 1");
    assert.equal(row.received_at_device, at - 500);
    assert.equal(row.subscription_id, 2);
    assert.equal(row.carrier_result_code, 0, "carrierResultCode 0 (RESULT_OK) preserved");

    // subscriptionId 0 is valid and distinct from missing.
    f.store.recordCarrierReport({ eventId: "dlr_sub0", requestId: "pull_123", status: "delivered",
      occurredAt: at, meta: metaOf({ subscriptionId: 0, carrierResultCode: null, segmentIndex: null,
        segmentCount: null, allSegmentsDelivered: null, receivedAtDevice: null }) });
    const sub0 = f.store.db.prepare("SELECT * FROM carrier_delivery_reports WHERE event_id=?").get("dlr_sub0");
    assert.equal(sub0.subscription_id, 0, "subscriptionId 0 preserved");
    assert.equal(sub0.carrier_result_code, null, "explicit null stays null");
    assert.equal(sub0.segment_index, null);

    // false is preserved as false, not as missing.
    f.store.recordCarrierReport({ eventId: "dlr_false", requestId: "pull_123", status: "failed",
      occurredAt: at, meta: metaOf({ allSegmentsDelivered: false }) });
    assert.equal(f.store.db.prepare("SELECT all_segments_delivered a FROM carrier_delivery_reports WHERE event_id=?")
      .get("dlr_false").a, 0, "false stored as 0, not NULL");
  } finally { f.close(); }
});

// 4 — survives reopen
test("4: optional fields survive a database close/reopen", () => {
  const f = setup();
  try {
    f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123", status: "delivered",
      occurredAt: at, meta: metaOf() });
    const reopened = f.reopen();
    const row = reopened.db.prepare("SELECT * FROM carrier_delivery_reports WHERE event_id=?").get("dlr_v27");
    assert.equal(row.segment_index, 0);
    assert.equal(row.segment_count, 3);
    assert.equal(row.carrier_result_code, 0);
    assert.equal(row.received_at_device, at - 500);
    // The ALTER TABLE migration is idempotent across reopen.
    assert.equal(reopened.db.prepare("PRAGMA table_info(carrier_delivery_reports)").all()
      .filter((c) => c.name === "carrier_result_code").length, 1);
  } finally { f.close(); }
});

// 5, 6, 7 — Eve callback body
test("5/6/7: the Eve callback carries snake_case diagnostics and distinct timestamps", () => {
  const f = setup();
  try {
    f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123", status: "delivered",
      occurredAt: at, deviceId: DEVICE, meta: metaOf() });
    const body = eveBody(f.store);
    assert.equal(body.type, "sms.delivered");
    assert.equal(body.gateway_request_id, "pull_123");
    assert.equal(body.carrier_status, "delivered");
    assert.equal(body.evidence, "android_delivery_report");
    assert.equal(body.carrier_result_code, 0);
    assert.equal(body.segment_index, 0);
    assert.equal(body.segment_count, 3);
    assert.equal(body.all_segments_delivered, true);
    assert.equal(body.device_id, DEVICE);
    assert.equal(body.occurred_at, new Date(at).toISOString());
    // Android's callback time and GMweb's receipt time are DIFFERENT facts.
    assert.equal(body.android_delivery_received_at, new Date(at - 500).toISOString());
    assert.equal(typeof body.gmweb_delivery_received_at, "string");
    assert.notEqual(body.gmweb_delivery_received_at, body.android_delivery_received_at);
    assert.equal(Number.isNaN(Date.parse(body.gmweb_delivery_received_at)), false, "ISO UTC");

    // A legacy report must not gain fabricated diagnostic fields.
    f.store.recordCarrierReport(legacy({ eventId: "dlr_legacy" }));
    const legacyBody = JSON.parse(f.store.db.prepare(
      "SELECT body FROM eve_sms_outbox WHERE event_id=?").get("dlr_legacy").body);
    assert.equal("carrier_result_code" in legacyBody, false, "never invented");
    assert.equal("segment_index" in legacyBody, false);
    assert.equal("all_segments_delivered" in legacyBody, false);
    assert.equal("android_delivery_received_at" in legacyBody, false);
    assert.equal("gmweb_delivery_received_at" in legacyBody, true, "GMweb always knows its own receipt time");
  } finally { f.close(); }
});

// 8 — failed never becomes delivered
test("8: failed never gets converted to delivered", () => {
  const f = setup();
  try {
    f.store.recordCarrierReport({ eventId: "dlr_f", requestId: "pull_123", status: "failed",
      occurredAt: at, meta: metaOf({ allSegmentsDelivered: false }) });
    const row = f.store.db.prepare("SELECT status FROM carrier_delivery_reports WHERE event_id=?").get("dlr_f");
    assert.equal(row.status, "failed");
    assert.equal(f.store.carrierStatus(f.id).status, "failed");
    assert.equal(eveBody(f.store).type, "sms.delivery_failed");
    assert.equal(eveBody(f.store).carrier_status, "failed");
  } finally { f.close(); }
});

// 9, 10, 11 — idempotency and conflict semantics
test("9/10/11: duplicate event_id is idempotent; legacy retry is not a false conflict", () => {
  const f = setup();
  try {
    assert.equal(f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123",
      status: "delivered", occurredAt: at, meta: metaOf() }).duplicate, false);
    const before = f.store.db.prepare("SELECT COUNT(*) n FROM eve_sms_outbox").get().n;

    // Exact duplicate.
    for (let i = 0; i < 5; i++) {
      assert.equal(f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123",
        status: "delivered", occurredAt: at, meta: metaOf() }).duplicate, true);
    }
    // A retry that OMITS the optional metadata is the same semantic report.
    assert.equal(f.store.recordCarrierReport(legacy({ eventId: "dlr_v27" })).duplicate, true);
    assert.equal(f.store.carrierReportStats().conflicts, 0, "no false conflict from a legacy retry");
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM eve_sms_outbox").get().n, before,
      "no duplicate Eve callback");

    // Contradictory non-null immutable metadata IS a conflict.
    assert.equal(f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123",
      status: "delivered", occurredAt: at, meta: metaOf({ segmentCount: 9 }) }).error, "event_id_conflict");
    assert.equal(f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123",
      status: "delivered", occurredAt: at, meta: metaOf({ carrierResultCode: 42 }) }).error, "event_id_conflict");
    assert.equal(f.store.carrierReportStats().conflicts, 2);
    // Core identity disagreement is still a conflict.
    assert.equal(f.store.recordCarrierReport(legacy({ eventId: "dlr_v27", status: "failed" })).error,
      "event_id_conflict");
  } finally { f.close(); }
});

// 12, 13 — schema validation via the real route
async function routeApp(store) {
  const app = Fastify({ logger: false });
  registerGatewayRoutes(app, { outbox: { onPull() {} }, sendStore: store,
    checkDeviceKey: () => true, log: null });
  await app.ready();
  return app;
}

test("12/13: invalid segment bounds, eventType and types are rejected without writing", async (t) => {
  const f = setup();
  const app = await routeApp(f.store);
  t.after(async () => { await app.close(); f.close(); });
  const post = (payload) => app.inject({ method: "POST", url: "/gateway/delivery-report", payload });
  const rows = () => f.store.db.prepare("SELECT COUNT(*) n FROM carrier_delivery_reports").get().n;

  const before = rows();
  for (const bad of [
    v3427({ segmentIndex: 3, segmentCount: 3 }),   // index must be < count
    v3427({ segmentIndex: 4, segmentCount: 3 }),
    v3427({ segmentIndex: -1 }),
    v3427({ segmentCount: 0 }),
    v3427({ eventType: "something_else" }),
    v3427({ allSegmentsDelivered: "yes" }),
    v3427({ receivedAtDevice: "not-a-number" }),
    v3427({ subscriptionId: -1 }),
    v3427({ carrierResultCode: 1.5 }),
    legacy({ eventId: "not_a_dlr_prefix" })
  ]) {
    const res = await post(bad);
    // Rejection may come from the Fastify schema (400 Bad Request) or from the
    // handler's own guard (400 invalid_delivery_report). Either way it is a
    // clean 400 and nothing is written.
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
  }
  assert.equal(rows(), before, "nothing persisted for rejected payloads");
});

test("route: the complete v3.4.27 payload is accepted end to end", async (t) => {
  const f = setup();
  const app = await routeApp(f.store);
  t.after(async () => { await app.close(); f.close(); });
  const res = await app.inject({ method: "POST", url: "/gateway/delivery-report", payload: v3427() });
  assert.equal(res.statusCode, 200, res.payload);
  const row = f.store.db.prepare("SELECT * FROM carrier_delivery_reports WHERE event_id=?").get("dlr_v27");
  assert.equal(row.segment_count, 3);
  assert.equal(row.carrier_result_code, 0);
  assert.equal(row.subscription_id, 2);
  // Legacy payload through the real route too.
  const legacyRes = await app.inject({ method: "POST", url: "/gateway/delivery-report", payload: legacy() });
  assert.equal(legacyRes.statusCode, 200, legacyRes.payload);
});

// 17 — atomicity
test("17: the carrier report and the Eve callback stay in one transaction", () => {
  const f = setup();
  try {
    // The store exposes an injected fault hook precisely to prove atomicity.
    assert.throws(() => f.store.recordCarrierReport(legacy({ eventId: "dlr_atomic" }),
      { fault: "afterReportInsert" }));
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM carrier_delivery_reports WHERE event_id=?")
      .get("dlr_atomic").n, 0, "report rolled back");
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM eve_sms_outbox WHERE event_id=?")
      .get("dlr_atomic").n, 0, "callback rolled back with it");
  } finally { f.close(); }
});

// 18 — retry semantics unchanged
test("18: outbox retry semantics are unchanged for carrier events", () => {
  const f = setup();
  try {
    f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123", status: "delivered",
      occurredAt: at, meta: metaOf() });
    const row = f.store.db.prepare("SELECT state, next_attempt_at, attempt_count FROM eve_sms_outbox WHERE event_id=?")
      .get("dlr_v27");
    assert.equal(row.state, "pending");
    assert.equal(row.attempt_count, 0);
    assert.equal(Number(row.next_attempt_at) > 0, true);
  } finally { f.close(); }
});

// 19 — diagnostics exposure
test("19: search and timeline expose the new fields without regressing the old ones", () => {
  const f = setup();
  try {
    f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123", status: "delivered",
      occurredAt: at, deviceId: DEVICE, meta: metaOf() });
    const found = f.store.searchCarrierReports({ keyName: "eve", eventId: "dlr_v27" });
    assert.equal(found.length, 1);
    const e = found[0];
    assert.equal(e.segmentIndex, 0);
    assert.equal(e.segmentCount, 3);
    assert.equal(e.allSegmentsDelivered, true);
    assert.equal(e.subscriptionId, 2);
    assert.equal(e.carrierResultCode, 0);
    assert.equal(new Date(e.receivedAtDevice).getTime(), at - 500);
    // Existing diagnostics preserved.
    assert.equal(e.eventId, "dlr_v27");
    assert.equal(e.gatewayRequestId, "pull_123");
    assert.equal(e.status, "delivered");
    assert.equal(e.deviceId, DEVICE);
    assert.equal(e.callbackState, "pending");

    // Legacy row: optional diagnostics are null, never fabricated.
    f.store.recordCarrierReport(legacy({ eventId: "dlr_legacy" }));
    const legacyEntry = f.store.searchCarrierReports({ keyName: "eve", eventId: "dlr_legacy" })[0];
    assert.equal(legacyEntry.segmentIndex, null);
    assert.equal(legacyEntry.carrierResultCode, null);
    assert.equal(legacyEntry.allSegmentsDelivered, null);
    assert.equal(legacyEntry.receivedAtDevice, null);

    const timeline = f.store.carrierTimeline(f.id);
    assert.equal(timeline.length, 2);
    const modern = timeline.find((x) => x.eventId === "dlr_v27");
    assert.equal(modern.segmentCount, 3);
    assert.equal(modern.carrierResultCode, 0);
    assert.equal(timeline.find((x) => x.eventId === "dlr_legacy").segmentCount, null);
  } finally { f.close(); }
});

// 20 — no PII anywhere in the new surfaces
test("20: no phone number or SMS body enters the Eve event or diagnostics", () => {
  const f = setup();
  try {
    f.store.recordCarrierReport({ eventId: "dlr_v27", requestId: "pull_123", status: "delivered",
      occurredAt: at, meta: metaOf() });
    const body = f.store.db.prepare("SELECT body FROM eve_sms_outbox WHERE event_id=?").get("dlr_v27").body;
    assert.equal(body.includes("sensitive-sms-content"), false);
    assert.equal(body.includes("+989121234567"), false);
    assert.equal(body.includes("989121234567"), false);
    const diagnostics = JSON.stringify(f.store.searchCarrierReports({ keyName: "eve" }));
    assert.equal(diagnostics.includes("sensitive-sms-content"), false);
    assert.equal(diagnostics.includes("+989121234567"), false);
    assert.equal(diagnostics.includes("989121234567"), false);
  } finally { f.close(); }
});
