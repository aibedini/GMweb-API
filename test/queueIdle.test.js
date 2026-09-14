"use strict";
// Queue "idle" must mean NO OUTSTANDING LIVE WORK, and last-24h telemetry must
// be served by an index — not by loading rows into JavaScript.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildQueueReport } = require("../src/queueSnapshot");
const { SendStore } = require("../src/sendStore");

const NOW = Date.parse("2026-09-14T12:00:00Z");
const DAY = 86400000;
const EMPTY = { waiting: 0, active: 0, delayed: 0, prioritized: 0, paused: 0, completed: 0, failed: 0 };

function report(bullmq, ledgerAllTime = {}, ledgerLast24h = {}) {
  return buildQueueReport({ bullmq: { ...EMPTY, ...bullmq }, ledgerAllTime, ledgerLast24h });
}

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-idle-"));
  const store = new SendStore(path.join(dir, "sends.db"));
  try { return fn(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("case 11: nothing outstanding is idle", () => {
  const r = report({});
  assert.equal(r.idle, true);
  assert.equal(r.executing, false);
  assert.equal(r.outstanding, 0);
});

for (const [state, caseId] of [["delayed", "12"], ["prioritized", "13"], ["paused", "14"]]) {
  test(`case ${caseId}: a non-zero ${state} job count is NOT idle`, () => {
    const r = report({ [state]: 1 });
    assert.equal(r.idle, false, `${state} jobs are outstanding work`);
    assert.equal(r.outstanding, 1);
    assert.equal(r.executing, false);
  });
}

test("waiting or active work is not idle, and active means executing", () => {
  assert.equal(report({ waiting: 1 }).idle, false);
  assert.equal(report({ active: 1 }).idle, false);
  assert.equal(report({ active: 1 }).executing, true);
  assert.equal(report({ delayed: 40, prioritized: 3 }).outstanding, 43, "the field is the sum of live lanes");
});

test("historical totals NEVER affect idle", () => {
  const r = report({}, { sent: 11353, failed: 683, unverified: 275 }, { sent: 155, failed: 0 });
  assert.equal(r.idle, true, "683 all-time failures do not make an empty queue busy");
  assert.equal(r.ledger.allTime.failed, 683);
  assert.equal(r.ledger.last24h.failed, 0);
});

test("case 15: the dashboard consumes the backend idle instead of recomputing it", () => {
  const overview = fs.readFileSync(path.join(__dirname, "..", "dashboard-next", "src", "pages", "Overview.tsx"), "utf8");
  assert.ok(overview.includes("queue?.idle"), "Overview must read the canonical field");
  assert.equal(/const liveIdle = queueNow \? queueNow\.waiting \+ queueNow\.active === 0/.test(overview), false,
    "the old client-side reimplementation must be gone");
  const types = fs.readFileSync(path.join(__dirname, "..", "dashboard-next", "src", "lib", "types.ts"), "utf8");
  assert.ok(types.includes("idle?: boolean"), "the type carries the backend field");
});

test("case 16: statsSince returns correct per-window outcomes", () => {
  withStore((store) => {
    const seed = (status, count, at) => {
      for (let i = 0; i < count; i += 1) {
        const id = store.create({ to: `+9891${String(i).padStart(8, "0")}`, text: `${status}-${at}-${i}`, keyName: "eve" });
        store.attachJob(id, `j-${status}-${at}-${i}`);
        store.markStatus(`j-${status}-${at}-${i}`, status, { attempts: 1 });
        store.db.prepare("UPDATE sends SET finished_at = ? WHERE id = ?").run(at, id);
      }
    };
    seed("sent", 4, NOW - 3600000);
    seed("unverified", 2, NOW - 7200000);
    seed("superseded", 1, NOW - 10800000);
    seed("failed", 9, NOW - 5 * DAY);
    seed("sent", 100, NOW - 30 * DAY);

    const all = store.stats();
    const window = store.statsSince(NOW - DAY);
    assert.equal(all.sent, 104);
    assert.equal(all.failed, 9);
    assert.equal(window.sent, 4);
    assert.equal(window.unverified, 2, "unverified keeps its own bucket");
    assert.equal(window.superseded, 1, "superseded is not a failure");
    assert.equal(window.failed, 0);
    assert.equal(window.total, 7);
  });
});

test("case 17: EXPLAIN QUERY PLAN proves the window query uses its index", () => {
  withStore((store) => {
    // A realistic-ish ledger so the planner has something to choose from.
    const insert = store.db.prepare(
      `INSERT INTO sends (dedupe_key,to_number,text,key_name,priority,status,attempts,created_at,updated_at,finished_at)
       VALUES (?,?,?,?,?,'sent',1,?,?,?)`
    );
    const bulk = store.db.transaction(() => {
      for (let i = 0; i < 20000; i += 1) {
        const t = NOW - (i % 400) * 3600000;
        insert.run("k" + i, "+989120000000", "bulk " + i, "eve", "expiring", t, t, t);
      }
    });
    bulk();

    const plan = store.db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT status, COUNT(*) AS n FROM sends
        WHERE status IN ('sent','unverified','failed','suppressed','cancelled','superseded')
          AND COALESCE(finished_at, sent_at, updated_at) >= ?
        GROUP BY status`
    ).all(NOW - DAY);

    const text = plan.map((row) => String(row.detail || "")).join(" | ");
    // Not a brittle exact-string test: we require the intended index and that
    // the access is a SEARCH/range scan rather than a full table SCAN.
    assert.ok(/idx_sends_terminal_window/.test(text), `expected the terminal-window index, got: ${text}`);
    assert.ok(/SEARCH/.test(text), `expected an index SEARCH, got: ${text}`);
    assert.equal(/SCAN sends/.test(text), false, `expected no full table scan, got: ${text}`);

    const started = Date.now();
    const stats = store.statsSince(NOW - DAY);
    const elapsed = Date.now() - started;
    assert.equal(stats.sent > 0, true);
    assert.ok(elapsed < 250, `window aggregation took ${elapsed}ms on 20k rows`);
    console.log(`      window aggregation over 20k rows: ${elapsed}ms; plan: ${text}`);
  });
});
