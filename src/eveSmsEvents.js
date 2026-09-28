"use strict";

const crypto = require("node:crypto");

const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 15 * 60 * 1000;
const STALE_CLAIM_MS = 30 * 1000;

function eveEventsConfig(env = process.env) {
  const urlText = String(env.EVE_SMS_EVENTS_URL || "").trim();
  const secret = String(env.EVE_SMS_EVENTS_SECRET || "");
  // The legacy webhook serializes raw send events, including recipient and
  // text. Refuse the Eve ingestion path even when the dedicated integration is
  // disabled, so configuration cannot bypass signing/privacy accidentally.
  if (env.WEBHOOK_URL) {
    try {
      if (new URL(env.WEBHOOK_URL).pathname === "/internal/gmweb/sms/events") {
        throw new Error("WEBHOOK_URL must not target the Eve SMS event endpoint");
      }
    } catch (error) {
      if (error.message === "WEBHOOK_URL must not target the Eve SMS event endpoint") throw error;
    }
  }
  if (!urlText && !secret) return null;
  if (!urlText || secret.length < 32) {
    throw new Error("EVE_SMS_EVENTS_URL and EVE_SMS_EVENTS_SECRET (at least 32 characters) must both be configured");
  }
  let url;
  try { url = new URL(urlText); } catch { throw new Error("EVE_SMS_EVENTS_URL must be a valid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("EVE_SMS_EVENTS_URL must be HTTPS and contain no credentials");
  }
  return { url: url.href, secret };
}

function signature(secret, timestamp, deliveryId, body) {
  return `sha256=${crypto.createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.`, "utf8")
    .update(body)
    .digest("hex")}`;
}

function retryDelay(attempt, random = Math.random) {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(20, Math.max(0, attempt - 1)));
  return Math.round(ceiling / 2 + random() * ceiling / 2);
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function boundedError(error) {
  // Never persist arbitrary exception text: it can contain a URL, token or
  // recipient. A stable class is sufficient for operator diagnostics.
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  return "network_error";
}

class EveSmsEvents {
  constructor(db, config, options = {}) {
    this.db = db;
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.log = options.log || null;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.intervalMs = options.intervalMs || 1000;
    this.selectDue = db.prepare(`SELECT * FROM eve_sms_outbox
      WHERE (state IN ('pending','retry_wait') AND next_attempt_at <= ?)
         OR (state='delivering' AND last_attempt_at <= ?)
      ORDER BY id LIMIT 1`);
    this.claimRow = db.prepare(`UPDATE eve_sms_outbox
      SET state='delivering', attempt_count=attempt_count+1, last_attempt_at=?, last_error=NULL
      WHERE id=? AND state IN ('pending','retry_wait','delivering')`);
    this.delivered = db.prepare(`UPDATE eve_sms_outbox
      SET state='delivered', delivered_at=?, last_http_status=?, last_error=NULL
      WHERE id=? AND state='delivering'`);
    this.retry = db.prepare(`UPDATE eve_sms_outbox
      SET state=?, next_attempt_at=?, last_http_status=?, last_error=?
      WHERE id=? AND state='delivering'`);
    this.claim = db.transaction((now) => {
      const row = this.selectDue.get(now, now - STALE_CLAIM_MS);
      if (!row) return null;
      this.claimRow.run(now, row.id);
      return { ...row, attempt_count: row.attempt_count + 1 };
    });
  }

  async tick() {
    if (!this.config || this.running) return false;
    this.running = true;
    try {
      const row = this.claim(this.now());
      if (!row) return false;
      const body = Buffer.from(row.body, "utf8");
      const timestamp = String(Math.floor(this.now() / 1000));
      let status = null;
      let errorCode = null;
      try {
        const response = await this.fetch(this.config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-GMweb-Timestamp": timestamp,
            "X-GMweb-Delivery-Id": row.delivery_id,
            "X-GMweb-Signature": signature(this.config.secret, timestamp, row.delivery_id, body)
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(8000)
        });
        status = response.status;
      } catch (error) {
        errorCode = boundedError(error);
      }
      const now = this.now();
      if (status !== null && status >= 200 && status < 300) {
        this.delivered.run(now, status, row.id);
        this.log?.info?.({ event_id: row.event_id, delivery_id: row.delivery_id,
          event_type: row.event_type, attempt: row.attempt_count, http_status: status,
          outbox_state: "delivered" }, "Eve SMS callback accepted");
      } else {
        const retry = status === null || retryableStatus(status);
        const state = retry ? "retry_wait" : "dead_letter";
        const next = retry ? now + retryDelay(row.attempt_count, this.random) : now;
        this.retry.run(state, next, status, errorCode || (retry ? "retryable_http" : "rejected_http"), row.id);
        this.log?.warn?.({ event_id: row.event_id, delivery_id: row.delivery_id,
          event_type: row.event_type, attempt: row.attempt_count, http_status: status,
          outbox_state: state, next_attempt_at: retry ? new Date(next).toISOString() : null,
          error: errorCode }, "Eve SMS callback not accepted");
      }
      return true;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (!this.config || !this.stopped) return;
    this.stopped = false;
    const poll = async () => {
      if (this.stopped) return;
      try { await this.tick(); }
      catch (error) { this.log?.error?.({ error: boundedError(error) }, "Eve SMS callback worker failed"); }
      if (!this.stopped) {
        this.timer = setTimeout(poll, this.intervalMs);
        this.timer.unref?.();
      }
    };
    poll();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    // In-flight HTTP has an 8-second bound; the caller may impose a shorter
    // shutdown deadline and let the persisted delivering claim recover.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  stats() {
    return this.db.prepare(`SELECT state, COUNT(*) AS count FROM eve_sms_outbox GROUP BY state`).all();
  }

  health(now = Date.now()) {
    const counts = { pending: 0, retry_wait: 0, delivering: 0, delivered: 0, dead_letter: 0 };
    for (const row of this.stats()) if (row.state in counts) counts[row.state] = Number(row.count);
    const oldest = this.db.prepare(`SELECT MIN(created_at) AS at FROM eve_sms_outbox WHERE state IN ('pending','retry_wait','delivering')`).get()?.at;
    const lastSuccess = this.db.prepare(`SELECT MAX(delivered_at) AS at FROM eve_sms_outbox`).get()?.at;
    const lastFailure = this.db.prepare(`SELECT MAX(last_attempt_at) AS at FROM eve_sms_outbox WHERE last_http_status IS NOT NULL AND last_http_status NOT BETWEEN 200 AND 299`).get()?.at;
    return {
      ...counts,
      last_success_at: lastSuccess ? new Date(Number(lastSuccess)).toISOString() : null,
      last_failure_at: lastFailure ? new Date(Number(lastFailure)).toISOString() : null,
      oldest_pending_age_ms: oldest ? Math.max(0, now - Number(oldest)) : null
    };
  }
}

module.exports = { EveSmsEvents, eveEventsConfig, signature, retryDelay, retryableStatus };
