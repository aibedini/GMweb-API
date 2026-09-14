"use strict";
// Queue vs ledger: two different questions, never one number.
//
//   QUEUE NOW          live BullMQ state — what is happening right now
//   DELIVERY OUTCOMES  durable ledger rows for a stated window
//
// The dashboard used to render them in one "Send queue" grid, so 683 all-time
// ledger failures looked like a queue that was currently failing while the
// queue was in fact empty and idle. This module is the single place that builds
// that report, so the split is testable without Redis, BullMQ or HTTP.

const OUTCOME_KEYS = Object.freeze([
  "sent", "unverified", "failed", "suppressed", "cancelled", "superseded"
]);

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Only the durable OUTCOME fields — never `queued`/`active`/`revokedInflight`. */
function pickOutcomes(source = {}) {
  const out = { total: 0 };
  for (const key of OUTCOME_KEYS) out[key] = count(source[key]);
  out.total = OUTCOME_KEYS.reduce((sum, key) => sum + out[key], 0);
  return out;
}

/**
 * @param {object} input
 * @param {object} input.bullmq          raw BullMQ getJobCounts() result
 * @param {object} input.ledgerAllTime   sendStore.stats()
 * @param {object} input.ledgerLast24h   sendStore.statsSince(now - windowMs)
 * @param {number} [input.windowMs]
 */
function buildQueueReport(input = {}) {
  const bullmq = input.bullmq || {};
  const allTime = pickOutcomes(input.ledgerAllTime);
  const last24h = pickOutcomes(input.ledgerLast24h);

  const queue = {
    waiting: count(bullmq.waiting),
    active: count(bullmq.active),
    delayed: count(bullmq.delayed),
    prioritized: count(bullmq.prioritized),
    paused: count(bullmq.paused),
    completed: count(bullmq.completed),
    failed: count(bullmq.failed)
  };

  const ledger = { allTime, last24h };

  // Legacy shape. Older consumers read `counts.failed` / `counts.sent` as
  // LEDGER TOTALS; that stays true here so nothing breaks, but it is no longer
  // what the dashboard renders.
  const counts = {
    ...bullmq,
    waiting: queue.waiting,
    active: queue.active,
    delayed: queue.delayed,
    prioritized: queue.prioritized,
    paused: queue.paused,
    completed: allTime.sent,
    failed: allTime.failed,
    sent: allTime.sent,
    unverified: allTime.unverified,
    suppressed: allTime.suppressed,
    cancelled: allTime.cancelled,
    superseded: allTime.superseded
  };

  // "Idle" means there is NO OUTSTANDING LIVE WORK — not merely active=0. A
  // queue holding 40 delayed retries and 3 prioritized jobs is NOT idle, and
  // historical completed/failed totals never participate.
  const outstanding = queue.waiting + queue.active + queue.delayed + queue.prioritized + queue.paused;

  return {
    queue,
    ledger,
    counts,
    idle: outstanding === 0,
    executing: queue.active > 0,
    outstanding,
    windowMs: count(input.windowMs) || DEFAULT_WINDOW_MS
  };
}

module.exports = { buildQueueReport, pickOutcomes, OUTCOME_KEYS, DEFAULT_WINDOW_MS };
