const test = require("node:test");
const assert = require("node:assert/strict");
const { AndroidGatewayClient } = require("../src/androidGatewayClient");

// Minimal HTTP stub server so the client is exercised over real fetch.
const http = require("node:http");

function startStub(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (!state.alive) { res.writeHead(503); res.end("{}"); return; }
        if (req.url === "/ready") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ready" }));
        } else if (req.url === "/send" && req.method === "POST") {
          const parsed = JSON.parse(body || "{}");
          const requestId = `sms_${String(state.nextId++).padStart(3, "0")}`;
          state.pending.set(requestId, parsed);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, requestId, jobId: requestId, statusUrl: `/send/status/${requestId}`, status: "queued" }));
        } else if (req.url.startsWith("/send/status/")) {
          const requestId = decodeURIComponent(req.url.split("/").pop());
          // Each poll advances the fake device one step: queued -> active -> sent.
          const step = (state.progress.get(requestId) || 0) + 1;
          state.progress.set(requestId, step);
          const status = step >= 3 ? "sent" : step === 2 ? "active" : "queued";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            requestId,
            status,
            terminal: status === "sent",
            successful: status === "sent",
            submittedOnce: step > 1,
            sentTo: state.pending.get(requestId)?.to,
            sentAt: status === "sent" ? "2026-08-24T10:00:00Z" : null,
            verificationStatus: status === "sent" ? "confirmed" : null,
            verificationAttempts: 0
          }));
        } else {
          res.writeHead(404); res.end("{}");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function makeClient(port) {
  return new AndroidGatewayClient({
    androidGatewayBaseUrl: `http://127.0.0.1:${port}`,
    androidGatewayApiKey: "test-key",
    androidSendTimeoutMs: 10000,
    androidStatusPollMs: 10
  });
}

test("android gateway relays send and waits for the phone's terminal sent status", async () => {
  const state = { requests: [], pending: new Map(), progress: new Map(), nextId: 1, alive: true };
  const server = await startStub(state);
  try {
    const client = makeClient(server.address().port);
    assert.equal((await client.readyState()).paired, true);

    const stages = [];
    const result = await client.sendMessage({
      to: "+989121234567",
      text: "سلام از GMweb",
      onStage: (s) => stages.push(s)
    });

    // Exactly one submit hit the phone, authenticated with X-API-Key.
    const submits = state.requests.filter((r) => r.url === "/send");
    assert.equal(submits.length, 1);
    assert.equal(submits[0].headers["x-api-key"], "test-key");
    assert.deepEqual(JSON.parse(submits[0].body), { to: "+989121234567", text: "سلام از GMweb" });

    // The relay only resolves after the phone reports terminal success and
    // exposes it in the GMweb submission shape (verificationStatus included).
    assert.equal(result.type, "sent");
    assert.equal(result.submission.verified, true);
    assert.equal(result.submission.verificationStatus, "confirmed");
    assert.equal(result.requestedTo, "+989121234567");
    assert.ok(stages.includes("phone_submitting") && stages.includes("phone_sent"));
  } finally {
    server.close();
  }
});

test("android gateway readiness flips to 503-style paired=false when the phone drops", async () => {
  const state = { requests: [], pending: new Map(), progress: new Map(), nextId: 1, alive: false };
  const server = await startStub(state);
  try {
    const client = makeClient(server.address().port);
    assert.deepEqual(await client.readyState(), { paired: false, reason: "android_gateway_unreachable" });
    await assert.rejects(() => client.sendMessage({ to: "+989120000000", text: "x" }),
      /android_gateway_unreachable|android_gateway_http_503/);
  } finally {
    server.close();
  }
});

test("missing configuration reports not-configured instead of throwing", async () => {
  const client = new AndroidGatewayClient({});
  assert.equal(client.configured, false);
  assert.deepEqual(await client.readyState(), { paired: false, reason: "android_gateway_not_configured" });
});

test("transport selector routes calls to the active transport and persists switches", async () => {
  const { createTransportSelector } = require("../src/transportSelector");
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const filePath = path.join(os.tmpdir(), `transport-test-${Date.now()}.json`);

  const chrome = { who: "chrome", readyState: async () => ({ paired: true }) };
  const android = new AndroidGatewayClient({});
  const client = createTransportSelector({ chromeClient: chrome, androidClient: android, filePath });

  await client.load();
  assert.equal(client.name, "chrome");           // default with no state file
  assert.equal(client.who, "chrome");            // proxy routes to the active transport
  assert.deepEqual(await client.readyState(), { paired: true });

  const status = await client.setTransport("android");
  assert.equal(status.transport, "android");
  assert.equal(client.name, "android");
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(persisted.transport, "android");  // survives restarts

  // Unknown transport is rejected and the active one stays untouched.
  await assert.rejects(() => client.setTransport("carrier-pigeon"), /unknown_transport/);
  assert.equal(client.name, "android");
  await fs.rm(filePath, { force: true });
});
