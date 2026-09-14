"use strict";
// Fastify's response serializer STRIPS any property the route's response schema
// does not declare. That bit us live: /admin/queue and /admin/transport shipped
// the new transport/queue model and the wire still carried the old shape, so
// the dashboard silently fell back. These assertions are cheap and would have
// caught it before the deploy.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildQueueReport } = require("../src/queueSnapshot");

const SERVER = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");

function routeSchemaDump(routePath) {
  const start = SERVER.indexOf(`app.get("${routePath}"`);
  assert.ok(start !== -1, `${routePath} must exist`);
  // Up to the handler: everything between is the schema.
  const end = SERVER.indexOf("}, async", start);
  return SERVER.slice(start, end === -1 ? SERVER.length : end);
}

test("declared response schemas carry every field the handlers return", () => {
  const queueSchema = routeSchemaDump("/admin/queue");
  for (const key of ["queue:", "idle:", "ledger:", "transport:", "counts:", "android:"]) {
    assert.ok(queueSchema.includes(key), `/admin/queue schema must declare ${key}`);
  }

  const transportSchema = routeSchemaDump("/admin/transport");
  for (const key of ["health:", "activeTransport:", "mode:", "androidState:", "androidReason:", "androidLastPullAgeMs:"]) {
    assert.ok(transportSchema.includes(key), `/admin/transport schema must declare ${key}`);
  }

  // /admin/overview uses additionalProperties, so it cannot strip.
  const overviewSchema = routeSchemaDump("/admin/overview");
  assert.ok(overviewSchema.includes("additionalProperties: true"));
});

test("the queue report the endpoints return is the tested one", () => {
  const report = buildQueueReport({
    bullmq: { waiting: 0, active: 0, delayed: 0, prioritized: 0, paused: 0, completed: 0, failed: 0 },
    ledgerAllTime: { sent: 11353, unverified: 275, failed: 683, cancelled: 1716 },
    ledgerLast24h: { sent: 144, unverified: 11, failed: 0 }
  });
  assert.equal(report.idle, true);
  assert.equal(report.queue.failed, 0);
  assert.equal(report.ledger.allTime.failed, 683);
  assert.equal(report.ledger.last24h.failed, 0);
  assert.equal(report.counts.failed, 683, "legacy clients keep their meaning");
});
