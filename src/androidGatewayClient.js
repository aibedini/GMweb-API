// Android gateway transport: relays sends to the Messages Android app
// (github.com/aibedini/Messages) over its EVE "Custom HTTP" contract instead of
// driving Google Messages for Web through Playwright.
//
// Duck-types the subset of GoogleMessagesClient that server.js touches on the
// send path, so the BullMQ pipeline (priority lanes, pacing, quiet hours,
// ledger, SSE/webhooks) stays shared: enable with ANDROID_GATEWAY_MODE=1.
//
// Phone contract (GatewayServer.kt):
//   POST /send            {to, text, priority?} + X-API-Key -> 202 {requestId,...}
//   GET  /send/status/:id -> {status: queued|active|sent|failed|cancelled, terminal, successful, sentAt, ...}
//   POST /send/cancel/:id -> {ok}
//   GET  /ready           -> 200 | 503   (unauthenticated health probe)

class AndroidGatewayClient {
  constructor(config) {
    this.baseUrl = String(config.androidGatewayBaseUrl || "").replace(/\/+$/, "");
    this.apiKey = config.androidGatewayApiKey || "";
    this.sendTimeoutMs = Number(config.androidSendTimeoutMs || 120000);
    this.pollMs = Math.max(250, Number(config.androidStatusPollMs || 3000));
    // Deliberately lenient: both transports are constructed at boot even when
    // this one is unconfigured (it simply reports paired=false until someone
    // fills ANDROID_GATEWAY_BASE_URL/API_KEY and selects this transport).
  }

  get configured() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  headers(extra = {}) {
    return { "X-API-Key": this.apiKey, "Content-Type": "application/json", ...extra };
  }

  async #fetchJson(url, options = {}) {
    let response;
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 15000) });
    } catch (error) {
      const err = new Error(`android_gateway_unreachable: ${error.message}`);
      err.code = "ANDROID_GATEWAY_UNREACHABLE";
      err.statusCode = 503;
      throw err;
    }
    let body = null;
    try { body = await response.json(); } catch { /* empty body is fine */ }
    if (!response.ok) {
      const err = new Error(`android_gateway_http_${response.status}: ${body?.error || response.statusText}`);
      err.code = response.status === 401 ? "ANDROID_GATEWAY_AUTH" : "ANDROID_GATEWAY_HTTP";
      err.statusCode = response.status;
      err.body = body;
      throw err;
    }
    return body || {};
  }

  // Submit to the phone, then poll its queue until the SMS is really sent.
  // The phone accepts fast (202, its own persistent queue) — returning at 202
  // would report success before the radio fires, so we wait for the terminal
  // status here, streaming progress through onStage like the browser client.
  async sendMessage({ to, text, onStage, shouldCancel }) {
    if (!to || !text) throw new Error("Both 'to' and 'text' are required.");
    onStage?.("phone_submitting");
    // ponytail: worker retries submit a fresh phone request (no Idempotency-Key
    // reuse across BullMQ attempts) — an ambiguous timeout can duplicate a send,
    // the same exposure the Chrome path has when it times out after Enter.
    const accepted = await this.#fetchJson(`${this.baseUrl}/send`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ to, text })
    });
    const requestId = accepted.requestId;
    if (!requestId) {
      const err = new Error("android_gateway_no_request_id");
      err.code = "ANDROID_GATEWAY_PROTOCOL";
      throw err;
    }
    onStage?.("phone_queued");

    const deadline = Date.now() + this.sendTimeoutMs;
    while (Date.now() < deadline) {
      if (shouldCancel?.()) {
        await this.cancelRequest(requestId).catch(() => {});
        const err = new Error(`Send to ${to} was cancelled while queued on the device.`);
        err.code = "SEND_CANCELLED";
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      let status;
      try {
        status = await this.#fetchJson(`${this.baseUrl}/send/status/${encodeURIComponent(requestId)}`, { timeoutMs: 10000 });
      } catch (error) {
        // Transient poll errors shouldn't abandon an accepted request; keep
        // polling until the deadline, then surface the last problem.
        if (Date.now() >= deadline) throw error;
        continue;
      }
      const phoneStatus = String(status.status || "").toLowerCase();
      if (phoneStatus === "sent") {
        onStage?.("phone_sent");
        return {
          type: "sent",
          to,
          requestedTo: String(to),
          sentTo: status.sentTo || String(to),
          recipientEvidence: null,
          conversationUrl: null,
          submission: {
            submittedOnce: true,
            submittedAt: status.sentAt || null,
            verified: true,
            verificationStatus: status.verificationStatus || "confirmed",
            verificationAttempts: Number(status.verificationAttempts || 0)
          },
          text,
          at: new Date().toISOString()
        };
      }
      if (phoneStatus === "active") onStage?.("phone_sending");
      if (phoneStatus === "failed" || phoneStatus === "cancelled") {
        const err = new Error(`android_gateway_${phoneStatus}: ${status.failedReason || "device reported " + phoneStatus}`);
        err.code = phoneStatus === "cancelled" ? "SEND_CANCELLED" : "ANDROID_GATEWAY_FAILED";
        err.statusCode = 502;
        throw err;
      }
    }
    const err = new Error(`android_gateway_timeout after ${this.sendTimeoutMs}ms waiting for ${requestId}`);
    err.code = "ANDROID_GATEWAY_TIMEOUT";
    err.statusCode = 504;
    throw err;
  }

  async cancelRequest(requestId) {
    return this.#fetchJson(`${this.baseUrl}/send/cancel/${encodeURIComponent(requestId)}`, {
      method: "POST",
      headers: this.headers(),
      timeoutMs: 10000
    });
  }

  async readyState() {
    if (!this.configured) return { paired: false, reason: "android_gateway_not_configured" };
    try {
      await this.#fetchJson(`${this.baseUrl}/ready`, { timeoutMs: 8000 });
      return { paired: true };
    } catch {
      return { paired: false, reason: "android_gateway_unreachable" };
    }
  }

  async status() { return this.readyState(); }
  async statusForDashboard() { return this.readyState(); }

  async recover() {
    // Nothing to heal locally; a reachable phone means healthy transport.
    const state = await this.readyState();
    if (!state.paired) {
      const err = new Error("android_gateway_unreachable during recovery probe");
      err.code = "ANDROID_GATEWAY_UNREACHABLE";
      throw err;
    }
    return state;
  }

  async warmConversationIndex() { return { skipped: true, transport: "android-gateway" }; }

  // Browser-lifecycle hooks server.js calls unconditionally; no-ops here so
  // startup/shutdown paths run unchanged in android mode.
  async start() {}
  async stop() {}
  detachForShutdown() {}
  setPacingController() {}
  refreshConversationInterval() {}
}

module.exports = { AndroidGatewayClient };
