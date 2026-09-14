"use strict";
// Queue NOW vs DELIVERY OUTCOMES.
//
// The production dashboard showed "Failed 683" inside a card headed "Send
// queue", mixing live BullMQ counts with durable ledger totals. 683 was the
// all-time number of failed sends; the queue itself was empty and idle. These
// tests pin the split so a historical failure can never read as current queue
// health again.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SendStore } = require("../src/sendStore");
const { buildQueueReport } = require("../src/queueSnapshot");

const NOW = Date.parse("2026-09-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-semantics-"));
  const store = new SendStore(path.join(dir, "sends.db"));
  try {
    return fn(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedTerminal(store, { status, count, at, prefix = "x" }) {
  for (let i = 0; i < count; i += 1) {
    const id = store.create({ to: `+9891${String(i).padStart(8, "0")}`, text: `${prefix}-${status}-${at}-${i}`, keyName: "eve" });
    const jobId = `seed-${status}-${at}-${i}`;
    store.attachJob(id, jobId);
    store.markStatus(jobId, status, { attempts: 1 });
    // finished_at is what the windowed query uses; pin it so the test is
    // deterministic instead of depending on wall-clock time.
    store.db.prepare("UPDATE sends SET finished_at = ? WHERE id = ?").run(at, id);
  }
}

test("case 13: 683 historical failures cannot make an idle queue look broken", () => {
  withStore((store) => {
    seedTerminal(store, { status: "failed", count: 683, at: NOW - 10 * DAY, prefix: "old" });

    const report = buildQueueReport({
      bullmq: { waiting: 0, active: 0, delayed: 0, prioritized: 0, paused: 0, completed: 0, failed: 0 },
      ledgerAllTime: store.stats(),
      ledgerLast24h: store.statsSince(NOW - DAY)
    });

    assert.equal(report.idle, true, "an empty queue is idle regardless of history");
    assert.equal(report.queue.waiting, 0);
    assert.equal(report.queue.active, 0);
    // The live queue's own failed set is untouched by ledger history.
    assert.equal(report.queue.failed, 0, "the queue is not currently failing");
    // The history is still reported — just in the right place.
    assert.equal(report.ledger.allTime.failed, 683);
    assert.equal(report.ledger.last24h.failed, 0, "none of them finished in the last 24h");
    // ...and the deprecated merged shape keeps its old meaning for old clients.
    assert.equal(report.counts.failed, 683);
  });
});

test("case 14: all-time and last-24h windows are separated correctly", () => {
  withStore((store) => {
    seedTerminal(store, { status: "sent", count: 4, at: NOW - 1 * DAY, prefix: "new" });
    seedTerminal(store, { status: "failed", count: 2, at: NOW - 2 * 60 * 60 * 1000, prefix: "new" });
    seedTerminal(store, { status: "sent", count: 100, at: NOW - 30 * DAY, prefix: "old" });
    seedTerminal(store, { status: "failed", count: 50, at: NOW - 40 * DAY, prefix: "old" });

    const report = buildQueueReport({
      bullmq: { waiting: 1, active: 1 },
      ledgerAllTime: store.stats(),
      ledgerLast24h: store.statsSince(NOW - DAY)
    });

    assert.equal(report.ledger.allTime.sent, 104);
    assert.equal(report.ledger.allTime.failed, 52);
    assert.equal(report.ledger.last24h.sent, 4);
    assert.equal(report.ledger.last24h.failed, 2);
    assert.equal(report.ledger.last24h.total, 6);
    assert.equal(report.idle, false, "waiting+active > 0 is not idle");
  });
});

test("case 15: unverified is its own outcome — never counted as sent or failed", () => {
  withStore((store) => {
    seedTerminal(store, { status: "unverified", count: 7, at: NOW - 60_000, prefix: "u" });
    const report = buildQueueReport({
      bullmq: {},
      ledgerAllTime: store.stats(),
      ledgerLast24h: store.statsSince(NOW - DAY)
    });
    assert.equal(report.ledger.allTime.unverified, 7);
    assert.equal(report.ledger.allTime.sent, 0);
    assert.equal(report.ledger.allTime.failed, 0);
    assert.equal(report.counts.unverified, 7);
    assert.equal(report.counts.sent, 0);
  });
});

test("case 16: superseded is a terminal outcome, not a failure", () => {
  withStore((store) => {
    seedTerminal(store, { status: "superseded", count: 3, at: NOW - 60_000, prefix: "s" });
    const report = buildQueueReport({
      bullmq: {},
      ledgerAllTime: store.stats(),
      ledgerLast24h: store.statsSince(NOW - DAY)
    });
    assert.equal(report.ledger.allTime.superseded, 3);
    assert.equal(report.ledger.allTime.failed, 0, "a renewed-away reminder is not a failure");
    assert.equal(report.ledger.last24h.superseded, 3);
    // Superseded rows are terminal, so they carry a finished_at like every other
    // terminal state and are therefore visible in the window.
    assert.equal(report.ledger.last24h.failed, 0);
  });
});

test("a superseded row gets finished_at, so window metrics see it", () => {
  withStore((store) => {
    const id = store.create({ to: "+989120000999", text: "supersede me", keyName: "eve" });
    store.attachJob(id, "job-sup");
    store.markStatus("job-sup", "superseded", { attempts: 1 });
    const row = store.byId(id);
    assert.equal(row.status, "superseded");
    assert.ok(row.finished_at, "terminal rows must be timestamped for window queries");
  });
});

test("statsSince aggregates in SQL and is not a full-table scan in JS", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "sendStore.js"), "utf8");
  assert.ok(source.includes("_statsSince"), "the windowed query is a prepared statement");
  assert.ok(/GROUP BY status/.test(source), "aggregation happens in SQLite");
  assert.ok(source.includes("idx_sends_terminal_time"), "an index backs the window query");
  assert.ok(source.includes("idx_sends_finished"), "and the ordering column");
});
