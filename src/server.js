const Fastify = require("fastify");
const cors = require("@fastify/cors");
const cookie = require("@fastify/cookie");
const linkedSessions = require("./linkedSessions");
const proxy = require("@fastify/http-proxy");
const swagger = require("@fastify/swagger");
const swaggerUi = require("@fastify/swagger-ui");
const crypto = require("node:crypto");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { z } = require("zod");
const config = require("./config");
const { GoogleMessagesClient } = require("./googleMessagesClient");
const { AndroidGatewayClient } = require("./androidGatewayClient");
const { ApiKeyStore } = require("./apiKeys");
const {
  PROJECT_KEY_SCOPES,
  requiredProjectKeyScope,
} = require("./projectKeyScopes");
const { ActivityLogStore, classify: classifyActivity } = require("./activityLog");
const { SendQueue } = require("./queue");
const { SendStore } = require("./sendStore");
const {
  NOTIFICATION_TEXT_LIMITS,
  normalizeNotificationMeta,
  validateNotificationMeta
} = require("./notificationMeta");
const { createSendRevocation, METRICS: REVOCATION_METRICS } = require("./sendRevocation");
const { registerGatewayRoutes } = require("./gatewayRoutes");
const { GatewayPresenceTracker } = require("./gatewayPresence");
const { createTransportHealth, STATE: TRANSPORT_STATE, REASON: TRANSPORT_REASON } = require("./transportHealth");
const {
  projectTransportHealth,
  responseSchemaProperties: eveTransportHealthSchema
} = require("./eveTransportHealth");
const { applyStaticCachePolicy } = require("./staticCachePolicy");
const { buildQueueReport } = require("./queueSnapshot");
const { SendPacingController } = require("./sendPacing");
const { sendGate, DEFAULT_TIME_ZONE } = require("./sendSchedule");
const { PRIORITY_LEVELS, PRIORITY_NAMES, normalizeSendPriority, priorityForJob } = require("./sendPriority");
const pkg = require("../package.json");

const app = Fastify({
  logger: true,
  trustProxy: true
});

// ADR-007 P0-2/P0-3: the canonical signature contract includes the EXACT raw
// request body hash. Capture raw bytes in a content-type parser (the reliable
// timing — hook-based capture deadlocks under fastify.inject). request.rawBody
// then feeds AgentAuthService verification for every /api/v1/agent/* and
// pairing-approve call.
// REVIEW P0 FIX: Fastify ships a built-in application/json parser, so the
// old `if (!app.hasContentTypeParser(...))` guard never installed ours —
// rawBody was then reconstructed via JSON.stringify in the preHandler,
// which is NOT byte-identical to what the Android agent signed (key order /
// whitespace differ) → signature_mismatch on pairing approve.
// PHASE A1 (review 041b509): the passive-listener design was a REGRESSION —
// there was no actual capture, so signed POSTs verified against
// Buffer.alloc(0) and always failed with signature_mismatch on real devices.
// We EXPLICITLY REPLACE the built-in parser again (same as e68a537): capture
// the exact inbound bytes, then delegate to Fastify's own parser (identical
// strict/prototype-pollution behavior) for request.body.
// @fastify/http-proxy re-registers application/json at its own load; that is
// handled by registering the proxy inside an encapsulated child scope (see
// vncProxyScope below) so the root-level parser swap is safe.
function installExactJsonBodyCapture(app) {
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      req.rawBody = Buffer.from(body, "utf8");
      defaultJsonParser(req, body, done);
    }
  );
  // Fallback for bodies that bypass the JSON parser (non-JSON/empty):
  // signed requests must NEVER receive reconstructed bytes — empty stays
  // empty and fails closed in signature verification.
  app.addHook("preHandler", (request, _reply, done) => {
    if (request.rawBody === undefined) {
      request.rawBody = Buffer.alloc(0);
    }
    done();
  });
}
installExactJsonBodyCapture(app);
module.exports.installExactJsonBodyCapture = installExactJsonBodyCapture;

// Dual delivery transports, always both constructed. `client` is a proxy that
// routes every call to the ACTIVE transport (chrome by default); the operator
// switches at runtime via the dashboard Controls page (/admin/transport).
const { createTransportSelector } = require("./transportSelector");
const { AndroidOutbox } = require("./androidOutbox");
const { DeviceKeyStore } = require("./deviceKey");
const { TrustRegistry } = require("./trustRegistry");
const { CommandEngine } = require("./commandEngine");
const { EventStore } = require("./eventStore");
const { WebPushService } = require("./webPush");
const { PasskeyService } = require("./passkeys");
const { AgentAuthService } = require("./agentAuth");
const { PwaAccessTokenStore } = require("./pwaAccessTokens");
const pairingGate = require("./pairingGate");
const { registerAgentIdentityRoutes } = require("./agentIdentityRoutes");
const { registerControlPlaneRoutes } = require("./controlPlaneRoutes");
const { registerPairingRoutes } = require("./pairingRoutes");
const { registerConnectionDiagnostics } = require("./connectionDiagnostics");
const { registerPwaAuthRoutes, registerPwaTokenAdminRoutes } = require("./pwaAuthRoutes");
const chromeClient = new GoogleMessagesClient(config);
const androidClient = new AndroidGatewayClient(config);
// Pull mode: the phone dials OUT to the server and picks up tasks (no tunnel).
//
// The outbox itself only knows "who is waiting on this task right now". The
// durable revocation state lives in the send ledger, and these hooks are how
// the two stay in sync -- which is what stops a stale depletion reminder from
// reaching the SIM after a restart, a Redis reconnect or a phone that comes
// back online later. sendRevocation is assigned right after the ledger is
// constructed; hooks only run at request time.
let sendRevocation = null;
const androidOutbox = new AndroidOutbox({
  hooks: {
    // Durable barrier. Answers "superseded" for a revoked row even when this
    // process has never seen the task (post-restart validation).
    isRevoked: (gatewayRequestId) => {
      const row = sendStore.byGatewayRequest(gatewayRequestId);
      if (!row) return null;
      if (row.revoked_at) {
        return {
          cause: row.status === "cancelled" ? "cancel" : "superseded",
          reason: row.revocation_reason || (row.status === "cancelled" ? "cancelled" : "superseded"),
          revokedAt: row.revoked_at
        };
      }
      if (row.status === "cancelled") {
        return { cause: "cancel", reason: row.error || "cancelled", revokedAt: null };
      }
      if (sendStore.isSuperseded(row)) {
        return { cause: "superseded", reason: row.revocation_reason || "superseded", revokedAt: null };
      }
      return null;
    },
    // Bind the phone's opaque task id to its ledger row BEFORE the device can
    // observe the task, so validation survives a restart.
    onOffer: (gatewayRequestId, entry) => {
      if (entry?.ledgerId) sendStore.attachGatewayRequest(entry.ledgerId, gatewayRequestId);
    },
    // Durable ACK replay: after a restart the bridge memory is gone, but the
    // ledger row is not — so an ACK retried by the phone is still answered with
    // the canonical truth instead of "unknown id".
    durableLookup: (gatewayRequestId) => sendStore.byGatewayRequest(gatewayRequestId),
    // Settlements are logged here; the single authoritative sent-after-
    // revocation audit runs in handleSendCompleted (or in the gateway ACK
    // fallback when no worker is left waiting), so it can never double-count.
    onSettle: (gatewayRequestId, outcome, entry, details) => {
      app.log.info({
        gatewayRequestId,
        state: outcome,
        serviceKey: entry?.meta?.serviceKey || null,
        notificationKind: entry?.meta?.notificationKind || null,
        generation: entry?.meta?.generation ?? null,
        correlationId: entry?.meta?.correlationId || null,
        bullmqJobId: entry?.jobId || null,
        revocationReason: entry?.revoked?.reason || details?.reason || null,
        transport: "android-pull",
        ackAt: new Date().toISOString()
      }, "android gateway task settled");
    },
    leaseMs: Number(process.env.ANDROID_REVOCATION_LEASE_MS) || 120000
  }
});
const client = createTransportSelector({
  chromeClient,
  androidClient,
  androidOutbox,
  filePath: path.join(config.rootDir, "data", "transport.json"),
  logger: (msg) => app.log.info(msg)
});
// Pull-bridge device key: dashboard-managed, falls back to the env value.
const deviceKeyStore = new DeviceKeyStore({
  filePath: path.join(config.rootDir, "data", "device-key.json"),
  envValue: process.env.GMWEB_ANDROID_DEVICE_KEY
});
const gatewayTelemetry = new GatewayPresenceTracker();

// ONE authoritative transport-health model (src/transportHealth.js).
// /admin/overview and /admin/transport both read this snapshot, so two cards on
// one dashboard refresh can never contradict each other — the old code built
// "Delivery" from the ACTIVE transport and "Device bridge" from the direct-PUSH
// client, which reported "No device" while pull mode was serving the phone.
const transportHealth = createTransportHealth({
  client,
  chromeClient,
  androidClient,
  deviceKeyStore,
  gatewayTelemetry
});

// ── Phase 2 (ADR-001/004): Trust Registry relay + durable Command Engine ────
// GMweb relays Android-signed trust statements and owns the durable command
// store. Account v1: a single-account deployment — the dashboard operator IS
// the account (account_id constant until passkey auth lands in Phase 4).
require("node:fs").mkdirSync(path.join(config.rootDir, "data"), { recursive: true });
const controlDb = new (require("better-sqlite3"))(path.join(config.rootDir, "data", "control-plane.db"));
const { DeviceTelemetryStore } = require("./deviceTelemetry");
const deviceTelemetryStore = new DeviceTelemetryStore(controlDb);
controlDb.pragma("journal_mode = WAL");
const trustRegistry = new TrustRegistry(controlDb);
const commandEngine = new CommandEngine(controlDb);
const eventStore = new EventStore(controlDb, {
  // Observability (Phase 2): trace every inbound event batch end-to-end.
  // grep in PM2/journalctl: `batch_received`, `event_accepted`, `event_duplicate`.
  log: (line) => console.log(`[eventStore] ${line}`),
  debug: (line) => console.log(`[eventStore] ${line}`),
  // §44+§45: durability first, then two best-effort realtime hints —
  // (a) in-process SSE fan-out, (b) content-less Web Push wake-ups.
  onEventsAccepted: (count) => {
    emitControlEvent({ type: "sync.available", newEvents: count, at: new Date().toISOString() });
    void webPushService.notifySyncAvailable(count).catch(() => {});
  },
});
const pwaAccessTokens = new PwaAccessTokenStore(controlDb);
const webPushService = new WebPushService(controlDb, {
  vapidKeyPath: path.join(config.rootDir, "data", "webpush-vapid.json"),
});
// Phase 4 (§21): passkey RP config — rpID/origin must match the public origin
// the browser sees (env-driven; defaults suit local development).
const passkeyService = new PasskeyService(controlDb, {
  rpName: "GMweb Messages",
  rpID: process.env.WEBAUTHN_RP_ID || "localhost",
  origin: process.env.WEBAUTHN_ORIGIN || "http://localhost:3030",
});
// PR-08b: per-device agent identities (ADR-001) — the agent bridge upgrades
// from the shared device key to per-device ECDSA signatures.
const agentAuthService = new AgentAuthService(controlDb);
require("./pairingDb").configure(controlDb);
const DEFAULT_ACCOUNT_ID = "default";

/**
 * PR-08b per-device gate for /api/v1/agent/* (ADR-001): accept EITHER the
 * legacy shared device key (bootstrap/compat) OR a per-device ECDSA
 * signature (X-Agent-Auth + X-Agent-TS, 90s window, replay cache). When an
 * identity IS enrolled for the claimed deviceId, the signature is REQUIRED —
 * the shared key alone no longer authorizes that device. Returns the bound
 * deviceId or null.
 */
function authorizeAgent(request, rawBody) {
  // The global /api/v1/agent/* gate has already verified this exact request.
  // Re-verifying here would reject the same timestamp as a replay.
  if (request.authenticatedAgentId) {
    return {
      deviceId: request.authenticatedAgentId,
      role: agentAuthService.getRole(request.authenticatedAgentId),
    };
  }
  const header = String(request.headers["x-agent-auth"] || "");
  if (header) {
    const result = agentAuthService.verifyAgentHeader(request, rawBody);
    if (!result.ok) return null;
    return {
      deviceId: result.deviceId,
      role: agentAuthService.getRole(result.deviceId),
    };
  }
  // Legacy fallback: shared device key (pre-PR-08b agents). Only valid while
  // the agent has NOT enrolled a signature identity — an enrolled device
  // must sign.
  if (checkDeviceKey(request)) {
    const claimed = request.headers["x-agent-id"];
    if (claimed && agentAuthService.getIdentity(String(claimed))) {
      return null; // enrolled device MUST use signatures
    }
    return { deviceId: "legacy-shared-agent", role: "LEGACY_AGENT" };
  }
  return null;
}

// Endpoints that drive the Google Messages *browser* session (sidebar scrape,
// screenshots, DOM debug) have no android equivalent yet. Fail with a
// structured 501 instead of a TypeError->500, whichever way the caller reaches
// them: the outbox (pull) and AndroidGatewayClient (push) simply lack these
// methods, so absence-of-method IS the android-mode signal.
function requireChromeMethod(name) {
  if (typeof client[name] !== "function") {
    const err = new Error(
      `${name} is only available on the chrome transport (Google Messages web automation). Switch transport via /admin/transport or use the android-mode equivalents.`
    );
    err.statusCode = 501;
    err.code = "chrome_only_endpoint";
    throw err;
  }
}

// ── Android-mode conversation views derived from the durable send ledger ─────
// Pull-mode phones expose no sidebar to scrape yet; until device-side sync
// lands, the ledger IS the conversation history (the SMS we delivered out).
const LEDGER_THREAD_LIMIT_MAX = 200;

function androidConversationsFromLedger(limit) {
  const byNumber = new Map();
  for (const r of sendStore.recent(Math.max(Number(limit) || 20, 100))) {
    if (r.status === "suppressed" || r.status === "cancelled") continue;
    const key = String(r.to_number || "").trim();
    if (!key) continue;
    const at = Number(r.updated_at || r.created_at || 0) || Date.now();
    const existing = byNumber.get(key);
    if (!existing || at > existing.at) {
      byNumber.set(key, {
        id: `sms:${key}`,
        href: key,
        title: key,
        snippet: String(r.text || "").replace(/\s+/g, " ").slice(0, 80),
        timestamp: new Date(at).toISOString(),
        unread: false,
        unreadCount: 0,
        pinned: false,
        origin: "ledger"
      });
    }
  }
  return [...byNumber.values()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, Math.max(1, Number(limit) || 20));
}

function androidThreadFromLedger(number, limit) {
  const wanted = String(number || "").replace(/[^\d+]/g, "");
  const capped = Math.max(1, Math.min(Number(limit) || 50, LEDGER_THREAD_LIMIT_MAX));
  const rows = sendStore.recent(LEDGER_THREAD_LIMIT_MAX * 5)
    .filter((r) => String(r.to_number || "").replace(/[^\d+]/g, "") === wanted)
    .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))
    .slice(-capped);
  const messages = [];
  let lastDay = "";
  for (const r of rows) {
    const at = Number(r.sent_at || r.finished_at || r.updated_at || r.created_at || 0) || Date.now();
    const d = new Date(at);
    const day = d.toISOString().slice(0, 10);
    if (day !== lastDay) {
      messages.push({ index: messages.length, type: "timestamp", text: day });
      lastDay = day;
    }
    messages.push({ index: messages.length, type: "message", direction: "out", text: String(r.text || ""), status: r.status });
  }
  return {
    conversation: { id: `sms:${wanted}`, href: wanted, title: wanted, snippet: "", timestamp: "", origin: "ledger" },
    messages,
    source: "ledger"
  };
}
const sseClients = new Map(); // reply -> { type: "full" | "project", keyName }
const apiKeyStore = new ApiKeyStore(
  path.join(config.rootDir, "data", "api-keys.json"),
  path.join(config.rootDir, "data", "api-requests.jsonl")
);
const activityLogStore = new ActivityLogStore(path.join(config.rootDir, "data", "activity.jsonl"));
const sendQueue = new SendQueue();
// Durable send ledger — survives crashes, tracks per-message status, powers the
// 24h de-dupe, and lets us rebuild the queue from disk if Redis is ever wiped.
const sendStore = new SendStore(path.join(config.rootDir, "data", "sends.db"));
const dashboardSessionCookieName = "gmweb_session";
const dashboardPasswordCookieName = "gmweb_login";
const dashboardDir = path.join(config.rootDir, "public", "dashboard");
const spaDir = path.join(config.rootDir, "public", "dashboard-next");
// web-01 (ADR-004): the NEW secure PWA — independent Vite artifact from
// web/, served under /web. dashboard-next stays legacy until retirement.
const webAppDir = path.join(config.rootDir, "public", "web-app");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};
const rateBuckets = new Map();
const dashboardSessions = new Map();
const dashboardPasswordSessions = new Map();
const sessionsFile = path.join(config.rootDir, "data", "dashboard-sessions.json");
const browserHealthFile = process.env.BROWSER_HEALTH_FILE || "/var/lib/gmweb/browser-health.json";

function readCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

let previousCpuTimes = readCpuTimes();

async function readSystemMetrics() {
  const current = readCpuTimes();
  const totalDelta = current.total - previousCpuTimes.total;
  const idleDelta = current.idle - previousCpuTimes.idle;
  previousCpuTimes = current;

  let totalBytes = os.totalmem();
  let availableBytes = os.freemem();
  let swapTotalBytes = 0;
  let swapFreeBytes = 0;
  if (process.platform === "linux") {
    try {
      const meminfo = await fs.readFile("/proc/meminfo", "utf8");
      const values = Object.fromEntries([...meminfo.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
      totalBytes = values.MemTotal || totalBytes;
      availableBytes = values.MemAvailable || availableBytes;
      swapTotalBytes = values.SwapTotal || 0;
      swapFreeBytes = values.SwapFree || 0;
    } catch { /* os values remain available */ }
  }

  const cores = os.cpus().length;
  const load = os.loadavg();
  return {
    cpu: {
      cores,
      usagePercent: totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0,
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      load15: Math.round(load[2] * 100) / 100,
      loadPercent: cores ? Math.round((load[0] / cores) * 1000) / 10 : 0
    },
    memory: {
      totalBytes,
      availableBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
      usagePercent: totalBytes ? Math.round((1 - availableBytes / totalBytes) * 1000) / 10 : 0
    },
    swap: {
      totalBytes: swapTotalBytes,
      usedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
      usagePercent: swapTotalBytes ? Math.round((1 - swapFreeBytes / swapTotalBytes) * 1000) / 10 : 0
    },
    uptimeSeconds: Math.floor(os.uptime())
  };
}

async function loadSessions() {
  try {
    const text = await fs.readFile(sessionsFile, "utf8");
    const saved = JSON.parse(text);
    const now = Date.now();
    for (const [id, session] of Object.entries(saved || {})) {
      if (session.expiresAt > now) dashboardSessions.set(id, session);
    }
  } catch { /* first run or missing file */ }
}

function saveSessions() {
  const obj = Object.fromEntries(dashboardSessions);
  fs.writeFile(sessionsFile, JSON.stringify(obj), "utf8").catch(() => {});
}
const dummyDashboardPasswordHash = "scrypt$v1$16384$8$1$aHInyzzd-xELadFCqewEOXskJ5E-EUJY$UUWVXTBwmOEPmu1yAIiq1mCAOTKFLv_WmAfqYSRzd8zlOtaUNx3KcADlnh6r5UWxbfoALvpmBxeTF7ELK9hITA";

function corsOrigin(origin, callback) {
  if (!origin) return callback(null, true);
  if (!config.corsOrigins.length) return callback(null, true);
  callback(null, config.corsOrigins.includes(origin));
}

function applySecurityHeaders(request, reply, done) {
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "SAMEORIGIN");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("cross-origin-resource-policy", "same-origin");
  if (!requestPath(request.url).startsWith("/vnc")) {
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
    );
  }
  if (config.dashboardCookieSecure) {
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  done();
}

function checkRateLimit(request, key, max, windowMs) {
  const now = Date.now();
  const bucketKey = `${key}:${request.ip || request.socket?.remoteAddress || "unknown"}`;
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
  }
  bucket.count += 1;
  rateBuckets.set(bucketKey, bucket);
  return {
    allowed: bucket.count <= max,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  };
}

function passwordAuthEnabled() {
  return Boolean(config.dashboardUsername && config.dashboardPasswordHash);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function userAgentHash(request) {
  return crypto
    .createHash("sha256")
    .update(String(request.headers["user-agent"] || ""))
    .digest("base64url");
}

function cleanupDashboardSessions() {
  const now = Date.now();
  for (const [sessionId, session] of dashboardSessions) {
    if (session.expiresAt <= now) dashboardSessions.delete(sessionId);
  }
  for (const [sessionId, session] of dashboardPasswordSessions) {
    if (session.expiresAt <= now) dashboardPasswordSessions.delete(sessionId);
  }
}

function createDashboardSession(request) {
  cleanupDashboardSessions();
  const sessionId = randomToken(32);
  const csrfToken = randomToken(32);
  const now = Date.now();
  dashboardSessions.set(sessionId, {
    csrfToken,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + config.dashboardSessionTtlMs,
    userAgentHash: userAgentHash(request)
  });
  saveSessions();
  return { sessionId, csrfToken };
}

function createDashboardPasswordSession(request) {
  cleanupDashboardSessions();
  const sessionId = randomToken(32);
  const now = Date.now();
  dashboardPasswordSessions.set(sessionId, {
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + config.dashboardPasswordSessionTtlMs,
    userAgentHash: userAgentHash(request)
  });
  return { sessionId };
}

function dashboardSession(request) {
  const sessionId = parseCookies(request.headers.cookie)[dashboardSessionCookieName] || "";
  if (!sessionId) return null;
  const session = dashboardSessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    dashboardSessions.delete(sessionId);
    return null;
  }
  if (config.dashboardBindUserAgent && session.userAgentHash !== userAgentHash(request)) {
    dashboardSessions.delete(sessionId);
    return null;
  }
  session.lastSeenAt = Date.now();
  return { sessionId, ...session };
}

function dashboardPasswordSession(request) {
  if (!passwordAuthEnabled()) return { bypass: true };
  const sessionId = parseCookies(request.headers.cookie)[dashboardPasswordCookieName] || "";
  if (!sessionId) return null;
  const session = dashboardPasswordSessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    dashboardPasswordSessions.delete(sessionId);
    return null;
  }
  if (config.dashboardBindUserAgent && session.userAgentHash !== userAgentHash(request)) {
    dashboardPasswordSessions.delete(sessionId);
    return null;
  }
  session.lastSeenAt = Date.now();
  return { sessionId, ...session };
}

function clearDashboardSession(request) {
  const sessionId = parseCookies(request.headers.cookie)[dashboardSessionCookieName] || "";
  if (sessionId) dashboardSessions.delete(sessionId);
  const passwordSessionId = parseCookies(request.headers.cookie)[dashboardPasswordCookieName] || "";
  if (passwordSessionId) dashboardPasswordSessions.delete(passwordSessionId);
  saveSessions();
}

function parsePasswordHash(hash) {
  const [scheme, version, n, r, p, salt, derived] = String(hash || "").split("$");
  if (scheme !== "scrypt" || version !== "v1" || !salt || !derived) return null;
  return {
    n: Number.parseInt(n, 10),
    r: Number.parseInt(r, 10),
    p: Number.parseInt(p, 10),
    salt,
    derived
  };
}

function safeStringEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a || "")).digest();
  const right = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(left, right);
}

function verifyDashboardPassword(password, hash = config.dashboardPasswordHash) {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;
  const expected = Buffer.from(parsed.derived, "base64url");
  const actual = crypto.scryptSync(String(password || ""), parsed.salt, expected.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: 64 * 1024 * 1024
  });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function sameOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) return true;
  const proto = request.headers["x-forwarded-proto"] || request.protocol || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return origin === `${proto}://${host}`;
}

function csrfAllowed(request, session) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (!sameOriginAllowed(request)) return false;
  return request.headers["x-csrf-token"] === session.csrfToken;
}

function requestPath(url) {
  return String(url || "").split("?")[0] || "/";
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function bearerToken(request) {
  const header = request.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function hasDashboardAccess(request) {
  if (!config.apiToken) return true;
  return Boolean(dashboardSession(request)) || bearerToken(request) === config.apiToken;
}

function isDashboardAsset(requestUrl) {
  const pathname = requestPath(requestUrl);
  return pathname === "/" || pathname === "/dashboard" || pathname === "/dashboard/" ||
    pathname === "/dashboard/password-login" || pathname === "/dashboard/login" ||
    pathname === "/dashboard/logout" || pathname === "/dashboard/session" ||
    pathname.startsWith("/dashboard/") ||
    // New React console (Vite SPA) served as static assets under /app.
    pathname === "/app" || pathname.startsWith("/app/") ||
    // web-01: the NEW secure PWA under /web (bypasses master-token auth like
    // the legacy consoles; its own auth layer lands with passkeys in Phase 4).
    pathname === "/web" || pathname.startsWith("/web/");
}

// Routes only accessible by master token or dashboard session (not project keys)
const ADMIN_ONLY_PREFIXES = ["/admin/", "/browser/", "/session/", "/dashboard/", "/vnc", "/docs"];
const ADMIN_ONLY_EXACT_PATHS = new Set(["/api/v1/pairing/diagnostics", "/api/v1/admin/sync-stats"]);

function isAdminOnlyPath(url) {
  const p = requestPath(url);
  return ADMIN_ONLY_EXACT_PATHS.has(p) || ADMIN_ONLY_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// Brute-force protection: track auth failures per IP
const authFailBuckets = new Map();
const AUTH_FAIL_MAX = 20;        // max failed auth attempts
const AUTH_FAIL_WINDOW = 600_000; // per 10 minutes
const AUTH_BLOCK_DURATION = 1800_000; // 30-minute block after repeated failures

function isAuthBlocked(ip) {
  const bucket = authFailBuckets.get(ip);
  if (!bucket) return false;
  const now = Date.now();
  if (bucket.blockedUntil && now < bucket.blockedUntil) return true;
  // Reset expired window
  bucket.attempts = bucket.attempts.filter((ts) => now - ts < AUTH_FAIL_WINDOW);
  if (bucket.attempts.length >= AUTH_FAIL_MAX) {
    bucket.blockedUntil = now + AUTH_BLOCK_DURATION;
    bucket.attempts = [];
    return true;
  }
  return false;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  let bucket = authFailBuckets.get(ip);
  if (!bucket) { bucket = { attempts: [], blockedUntil: 0 }; authFailBuckets.set(ip, bucket); }
  bucket.attempts.push(now);
}

// Device key for the android pull bridge (/gateway/pull + /gateway/ack).
// Top-level because the global requireToken hook (below) delegates /gateway/*
// here — a function defined inside app.after() would not be visible to it.
function checkDeviceKey(request) {
  const expected = deviceKeyStore.key;
  if (!expected) return false;
  const got = String(request.headers["x-api-key"] || "");
  return got.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function recordGatewayAuthFailure() {
  gatewayTelemetry.recordAuthFailure();
  try { sendStore?.bumpCounters([{ name: "gateway_auth_failures_total", delta: 1 }]); } catch { /* best effort */ }
  app.log.warn({ event: "gateway_auth_failed" }, "gateway authentication failed");
}

function requireToken(request, reply, done) {
  if (requestPath(request.url) === "/api/v1/primary-enrollment" && request.method === "POST") return done();
  if (config.publicHealth && requestPath(request.url) === "/health") return done();
  // Phase 4 (§21): passkey login flow endpoints must be reachable BEFORE any
  // session exists — status, both option generators, and the auth verify.
  // The verify handlers themselves gate on challenge single-use + UV flag.
  if (requestPath(request.url).startsWith("/api/v1/auth/")) return done();
  // Public only in the routing sense: this exact endpoint consumes its own
  // dedicated one-time PWA token and rate-limits attempts before issuing a
  // restricted HttpOnly session. Master/project API tokens are rejected.
  if (requestPath(request.url) === "/api/v1/pwa/token-login") return done();
  // ADR-007 P0-1 (security fix): EXACTLY two pairing surfaces are reachable
  // without a session — the unlinked browser's create/status calls. They are
  // rate-limited + capacity-bound + TTL-bound (pairingSessions.js). The
  // Android-only endpoints (GET /pairing/session/:id, POST /pairing/approve)
  // are NOT exempted here: they require agent-bridge auth, enforced at the
  // route level below (P0-2). Prefix exemption is not used for trust
  // decisions — match the exact paths.
  if (requestPath(request.url) === "/api/v1/pairing/session" ||
      requestPath(request.url) === "/api/v1/pairing/status") return done();
  // POST-PAIR: linked-session introspection is public — the route itself
  // reports authenticated:false when no valid cookie is present.
  if (requestPath(request.url) === "/api/v1/linked-session") return done();
  if (requestPath(request.url) === "/api/v1/pairing/challenge" || requestPath(request.url) === "/api/v1/pairing/complete") return done();
  // FIX 2 (review): the Android-only pairing endpoints delegate to the SAME
  // agent pipeline as /api/v1/agent/* — verified here ONCE (method-aware,
  // exact rawBody) and bound to request.authenticatedAgentId. The route
  // handlers then check ROLE only, never re-verify the signature (a second
  // verify would trip the replay cache). These paths never hit
  // master/dashboard/project auth.
  // REVIEW FIX: trust-sensitive pairing routes are SIGNATURE-REQUIRED. The
  // shared device key (X-API-Key) must never authorize them — an earlier
  // `checkDeviceKey → done()` shortcut skipped signature verification, left
  // authenticatedAgentId unset, and the route then 401'd the real agent.
  // Trust-sensitive pairing routes → pairingGate (signature-required,
  // single verification, role binding). Extracted to its own module so the
  // E2E composition test exercises the EXACT production decision logic.
  // PHASE A2 (review 041b509): pairing routes get EXACTLY ONE auth decision —
  // the gate's done()/reply must terminate this hook. Without `return`,
  // execution fell through to the agent/dashboard/token branches below and
  // could double-handle the request (double-send / replay-cache trips).
  if (
    requestPath(request.url).startsWith("/api/v1/pairing/session/") ||
    requestPath(request.url) === "/api/v1/pairing/approve"
  ) {
    return pairingGate(agentAuthService, request, reply, done);
  }
  // POST-PAIR SECURE BOOTSTRAP: the linked-device session class —
  // capability-scoped, NEVER master/admin. Paths are whitelisted by
  // capability; everything else falls through to the normal auth ladder
  // (and typically 401s for a browser that only holds this cookie).
  const linkedCookie = request.cookies
    ? request.cookies[linkedSessions.COOKIE_NAME]
    : "";
  const linkedSession = linkedSessions.resolve(linkedCookie);
  if (linkedSession && requestPath(request.url).startsWith("/api/v1/")) {
    const p = requestPath(request.url);
    const caps = linkedSession.capabilities || [];
    const allowed =
      (caps.includes("READ_MESSAGES") &&
        request.method === "GET" &&
        (p === "/api/v1/sync" ||
          p === "/api/v1/sse" ||
          p === "/api/v1/web/bootstrap" ||
          p === "/api/v1/web/snapshot-v2" ||
          p === "/api/v1/web/conversations" ||
          p.startsWith("/api/v1/web/conversations/") ||
          p === "/api/v1/linked-device/sync-diagnostics" ||
          p === "/api/v1/linked-device/key-grants" ||
          p === "/api/v1/linked-device/keyring" ||
          p === "/api/v1/linked-device/replication-capabilities" ||
          p === "/api/v1/linked-session" ||
          p.startsWith("/api/v1/trust/"))) ||
      (caps.includes("READ_MESSAGES") && request.method === "POST" &&
        (p === "/api/v1/web/sync/ack" || p === "/api/v1/web/snapshot-v2")) ||
      (caps.includes("READ_MESSAGES") && request.method === "GET" &&
        p === "/api/v1/linked-device/telemetry") ||
      (caps.includes("SEND_MESSAGES") && request.method === "GET" &&
        p === "/api/v1/linked-device/command-key") ||
      ((caps.includes("SEND_MESSAGES") || caps.includes("MARK_READ")) &&
        (p === "/api/v1/commands" || p.startsWith("/api/v1/commands/"))) ||
      (caps.includes("READ_PAIRING_DIAGNOSTICS") &&
        request.method === "GET" && p === "/api/v1/pairing/diagnostics") ||
      p === "/api/v1/linked-session"; // introspection always allowed
    if (allowed) {
      request.linkedDevice = linkedSession;
      return done();
    }
    // A linked browser must not silently fall through to bearer auth with
    // its cookie — fail closed for out-of-scope paths.
    reply.code(403).send({ error: "capability_denied" });
    return;
  }

  // Android agent bridge: device key (legacy) OR per-device ECDSA signature
  // (PR-08b) — the route handler/hook re-checks and binds the identity.
  if (requestPath(request.url).startsWith("/gateway/")) {
    if (checkDeviceKey(request)) return done();
    recordGatewayAuthFailure();
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  // Phase 2 (PR-08) + PR-08b: agent bridge under /api/v1/agent/* accepts the
  // shared device key (legacy/compat) OR per-device ECDSA signatures
  // (X-Agent-Auth, verified in controlPlaneRoutes/agentAuth.js). Identity
  // registration (/api/v1/agent/identity) is device-key bootstrap only.
  // P0-3 (ADR-007 security fix): the signature is verified against the EXACT
  // raw request body captured in onRequest — the old Buffer.alloc(0) probe
  // verified "a signature exists" without binding it to this request. The
  // bound deviceId is exposed as request.authenticatedAgentId for handlers.
  if (requestPath(request.url).startsWith("/api/v1/agent/")) {
    if (checkDeviceKey(request) && !(requestPath(request.url) === "/api/v1/agent/identity" && agentAuthService.getIdentity(request.body?.deviceId))) {
      if (requestPath(request.url) === "/api/v1/agent/identity") {
        request._pairingDiagnostic = {
          stage: "ANDROID_IDENTITY_AUTH",
          status: "SUCCESS",
          reason: "device_key_valid",
        };
      }
      return done();
    }
    if (requestPath(request.url) === "/api/v1/agent/identity") {
      // An already-enrolled Android identity refreshes its own public keys
      // with the same per-device signature used by all other agent routes.
      // Fresh phones enroll through the independent primary setup endpoint.
      const auth = agentAuthService.verifyAgentHeader(
        request,
        request.rawBody || Buffer.alloc(0),
      );
      if (auth.ok) {
        request.authenticatedAgentId = auth.deviceId;
        request._pairingDiagnostic = {
          stage: "ANDROID_IDENTITY_AUTH",
          status: "SUCCESS",
          reason: "agent_signature_valid",
          deviceId: auth.deviceId,
        };
        return done();
      }
      const failure = request.headers["x-agent-auth"]
        ? { error: "unauthorized", reason: auth.reason }
        : deviceKeyStore.authFailure();
      request._pairingDiagnostic = {
        stage: "ANDROID_IDENTITY_AUTH",
        status: "FAILED",
        reason: failure.reason || "identity_auth_failed",
      };
      reply.code(401).send(failure);
      return;
    }
    const auth = agentAuthService.verifyAgentHeader(request, request.rawBody || Buffer.alloc(0));
    if (auth.ok) {
      request.authenticatedAgentId = auth.deviceId;
      return done();
    }
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  if (config.dashboardEnabled && isDashboardAsset(request.url)) return done();
  if (config.dashboardEnabled && requestPath(request.url).startsWith("/vnc")) {
    if (hasDashboardAccess(request)) return done();
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  if (!config.apiToken) return done();

  const ip = request.ip || "";

  // Brute-force block check
  if (isAuthBlocked(ip)) {
    reply.code(429).send({ error: "too_many_auth_failures", retryAfterSeconds: Math.ceil(AUTH_BLOCK_DURATION / 1000) });
    return;
  }

  // Master token — full access (constant-time compare)
  const token = bearerToken(request);
  if (token) {
    const masterHash = crypto.createHash("sha256").update(config.apiToken).digest();
    const tokenHash  = crypto.createHash("sha256").update(token).digest();
    if (masterHash.length === tokenHash.length && crypto.timingSafeEqual(masterHash, tokenHash)) {
      return done();
    }
  }
  // web-01 bridge (pre-passkey, §23-honest): native EventSource cannot send
  // headers, so the control-plane SSE accepts ?token=<apiToken> as a
  // constant-time equivalent of the Bearer header. TEMPORARY until the PWA
  // gets its own passkey session (Phase 4) — then this bridge is deleted.
  if (requestPath(request.url) === "/api/v1/sse" && config.apiToken && config.allowLegacySseQueryToken) {
    app.log.warn("legacy SSE query-token authentication used; disable ALLOW_LEGACY_SSE_QUERY_TOKEN");
    const q = String(request.query?.token || "");
    if (
      q.length === config.apiToken.length &&
      crypto.timingSafeEqual(Buffer.from(q), Buffer.from(config.apiToken))
    ) {
      return done();
    }
  }

  // Dashboard session — full access
  const session = dashboardSession(request);
  if (session && csrfAllowed(request, session)) return done();
  if (session) {
    reply.code(403).send({ error: "csrf_failed" });
    return;
  }

  // Project API key — only for non-admin paths
  if (!isAdminOnlyPath(request.url) && token) {
    const key = apiKeyStore.findByToken(token);
    if (key) {
      if (!apiKeyStore.isIpAllowed(key, ip)) {
        recordAuthFailure(ip); // wrong IP for a valid-format token
        reply.code(403).send({ error: "ip_not_allowed", ip });
        return;
      }
      const requiredScope = requiredProjectKeyScope(request.method, request.url);
      if (!requiredScope || !apiKeyStore.hasScope(key, requiredScope)) {
        reply.code(403).send({ error: "project_scope_denied", requiredScope });
        return;
      }
      request._projectKey = key;
      apiKeyStore.recordUse(key.id);
      apiKeyStore.appendLog({
        ts: new Date().toISOString(),
        keyId: key.id,
        keyName: key.name,
        ip,
        method: request.method,
        path: requestPath(request.url),
        count: key.requestCount
      }).catch(() => {});
      return done();
    }
  }

  // Only count as brute-force when a token was actually provided but wrong.
  // Missing auth (browser hitting /docs assets, dashboard session expired) is NOT brute force.
  if (token) recordAuthFailure(ip);
  reply.code(401).send({ error: "unauthorized" });
}

function activityActor(request) {
  if (request._projectKey) return { type: "api_key", name: request._projectKey.name, id: request._projectKey.id };
  if (request.linkedDevice) return { type: "device", name: "Linked PWA", id: shortLogHash(request.linkedDevice.deviceId) };
  if (requestPath(request.url).startsWith("/gateway/")) return { type: "device", name: "Android gateway" };
  if (dashboardSession(request)) return { type: "dashboard", name: config.dashboardUsername || "Dashboard operator" };
  if (bearerToken(request)) return { type: "master", name: "Master API token" };
  if (requestPath(request.url).startsWith("/dashboard/")) return { type: "dashboard", name: "Dashboard visitor" };
  return { type: "anonymous", name: "Anonymous" };
}

function shouldRecordActivity(request) {
  const pathname = requestPath(request.url);
  if (["/admin/activity-logs", "/admin/api-logs", "/api/v1/pairing/diagnostics", "/events"].includes(pathname)) return false;
  if (["/", "/dashboard", "/dashboard/", "/app", "/app/"].includes(pathname)) return false;
  if (pathname.startsWith("/app/assets/")) return false;
  return !/\.(?:js|css|png|svg|ico|map|woff2?)$/i.test(pathname);
}

function safeActivityFields(value) {
  if (!value || typeof value !== "object") return undefined;
  const safe = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|password|secret|authorization|api.?key|text|message/i.test(key)) safe[key] = "[redacted]";
    else safe[key] = String(raw).slice(0, 200);
  }
  return Object.keys(safe).length ? safe : undefined;
}

function shortLogHash(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function safePairingDiagnostic(value) {
  if (!value || typeof value !== "object") return undefined;
  return {
    stage: String(value.stage || "UNKNOWN").replace(/[^A-Z0-9_]/gi, "_").slice(0, 64),
    status: String(value.status || "UNKNOWN").replace(/[^A-Z0-9_]/gi, "_").slice(0, 32),
    reason: String(value.reason || "").replace(/[\r\n\t]/g, " ").slice(0, 160) || null,
    sessionIdHash: shortLogHash(value.sessionId),
    deviceIdHash: shortLogHash(value.deviceId),
  };
}

function recordActivity(request, reply, done) {
  if (!shouldRecordActivity(request)) return done();
  const pathname = requestPath(request.url);
  const { category, type } = classifyActivity(pathname, request.method);
  const durationMs = request._activityStartedAt
    ? Number(process.hrtime.bigint() - request._activityStartedAt) / 1e6
    : 0;
  const pairing = safePairingDiagnostic(request._pairingDiagnostic);
  if (pairing) {
    const logMethod = reply.statusCode >= 400 ? "warn" : "info";
    app.log[logMethod]({ pairing, path: pathname, statusCode: reply.statusCode }, "pairing state");
  }
  activityLogStore.append({
    type,
    category,
    method: request.method,
    path: pathname,
    statusCode: reply.statusCode,
    title: pairing ? `Pairing ${pairing.stage}: ${pairing.reason || pairing.status}` : undefined,
    durationMs,
    actor: activityActor(request),
    ip: request.ip,
    requestId: request.id,
    userAgent: request.headers["user-agent"],
    details: {
      route: request.routeOptions?.url || null,
      params: safeActivityFields(request.params),
      query: safeActivityFields(request.query),
      ...(pairing ? { pairing } : {})
    }
  }).catch(() => {});
  done();
}

function emitSse(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const [reply, scope] of sseClients) {
    // Project API keys may only receive events for their own sends. /send/status
    // and /send/cancel already enforce this per-key isolation; the live stream
    // must not leak other projects' recipients or message bodies. The master
    // token and dashboard sessions still see the full stream.
    if (scope.type === "project") {
      const ledger = sendStore.byJob(event.jobId) || sendStore.byReference(event.requestId);
      if (!ledger || ledger.key_name !== scope.keyName) continue;
    }
    try { reply.raw.write(payload); } catch { sseClients.delete(reply); }
  }
}

// web-01 (§44): the PWA's realtime channel is a NARROW invalidation signal —
// never message content. EventUploader's batch ACK calls emitControlEvent,
// which fans out to /api/v1/sse subscribers as {type:"sync.available"} and
// clients re-pull /api/v1/sync with their cursor. Durability is untouched:
// if the SSE drops, the cursor sync still catches everything up.
const controlSseClients = new Set();

function emitControlEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const reply of controlSseClients) {
    if (reply._linkedToken && !linkedSessions.resolve(reply._linkedToken)) {
      reply.raw.end();
      controlSseClients.delete(reply);
      continue;
    }
    try { reply.raw.write(payload); } catch { controlSseClients.delete(reply); }
  }
}

async function postWebhook(event) {
  if (!config.webhookUrl) return;
  try {
    await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
  } catch (error) {
    app.log.warn({ error }, "webhook post failed");
  }
}

client.on("conversation:changed", (event) => {
  emitSse(event);
  postWebhook(event);
});
client.on("session:claimed", (event) => {
  app.log.warn({ at: event.at }, "Google Messages requested this web session; selected Use here automatically");
  emitSse({ type: "browser_session_claimed", at: event.at });
});
// Note: message send lifecycle SSE/webhooks are emitted by the queue worker
// (with jobId), so we no longer mirror client's internal "message:sent" here.
client.on("error", (error) => app.log.warn({ error }, "client error"));

// Queue worker: processes one send at a time using the shared browser.
// Hard per-send timeout so a wedged page can never stall the queue, plus
// auto-recovery (reconnect + fresh page) after consecutive failures.
// The UI flow intentionally gets up to three attempts. Preserve that contract
// even on installations carrying the old 80-second environment default.
const SEND_TIMEOUT_MS = Math.max(240000, Number(config.sendTimeoutMs) || 240000);
// Durable de-dupe window: an identical {to,text} already SENT within this many
// hours (or still in flight) is suppressed — even with no Idempotency-Key, and
// even across restarts (backed by the SQLite ledger). Default 24h.
const SEND_DEDUPE_MS = (Number(process.env.SEND_DEDUPE_HOURS) || 24) * 3600 * 1000;
const ANNOUNCEMENT_PENDING_LIMIT = Math.max(1, Number(process.env.ANNOUNCEMENT_PENDING_LIMIT) || 200);
// Conversation-opening misses may be deferred once. A submitted-but-unverified
// message is NEVER deferred or retried because Enter may already have sent it.
const configuredConversationDefers = Number(process.env.SEND_MAX_CONVERSATION_DEFERS ?? 1);
const MAX_CONVERSATION_DEFERS = Number.isFinite(configuredConversationDefers)
  ? Math.max(0, Math.floor(configuredConversationDefers))
  : 1;
const SEND_FAIL_RESTART_THRESHOLD = Number(process.env.SEND_FAIL_RESTART_THRESHOLD) || 3;
// client.recover() only drops Playwright's reference and reconnects — it
// fixes a wedged *page*, but does nothing if the Chrome *process* itself is
// too resource-starved to service a new CDP connection (connectOverCDP just
// times out again, identically, on every job). If a soft recover doesn't
// stop the failures within one more full streak, escalate to the same
// process-level restart the "restart-chrome" admin action performs.
const SEND_HARD_RESTART_THRESHOLD = Number(process.env.SEND_HARD_RESTART_THRESHOLD) || 2;
const HARD_RESTART_COOLDOWN_MS = Number(process.env.HARD_RESTART_COOLDOWN_MS) || 5 * 60 * 1000;
const browserRecoveryFile = path.join(config.rootDir, "data", "browser-recovery.json");
const browserRecoveryLogFile = path.join(config.rootDir, "data", "browser-recovery.jsonl");
const sendPacing = new SendPacingController({
  filePath: path.join(config.rootDir, "data", "send-settings.json"),
  defaults: {
    maxPerMinute: Math.max(1, Number(process.env.SEND_MAX_PER_MINUTE) || 4),
    randomDelayEnabled: false,
    randomExtraSeconds: 0
  }
});
client.setPacingController(sendPacing);
const SEND_TIME_ZONE = process.env.SEND_TIMEZONE || DEFAULT_TIME_ZONE;
const SEND_QUIET_START_HOUR = Number(process.env.SEND_QUIET_START_HOUR ?? 2);
const SEND_QUIET_END_HOUR = Number(process.env.SEND_QUIET_END_HOUR ?? 8);
let sendFailStreak = 0;
let recovering = false;
let recoverEscalations = 0;
let lastHardRestartAt = 0;
let hardRecoveryScheduled = false;
const activeSendCancellationRequests = new Set();

// ── Notification lifecycle revocation (stale-SMS race) ─────────────────────
// ONE durable decision, shared by POST /send/cancel, POST /send/invalidate, the
// BullMQ processor and the Android pull bridge. The ordering contract that
// makes it crash-safe (replay -> watermark -> ADVANCE -> revoke -> count) lives
// in src/sendRevocation.js; server.js only wires it to HTTP, SSE and the log.
sendRevocation = createSendRevocation({
  sendStore,
  queue: sendQueue,
  outbox: androidOutbox,
  activeCancellationRequests: activeSendCancellationRequests,
  log: app.log,
  // Same fan-out as every other send lifecycle event: live stream + webhook.
  onEvent: (event) => { emitSse(event); postWebhook(event); },
  // Durable operator trail. Only identity/ordering fields are recorded: never
  // message text, never a phone number.
  onAudit: (entry) => {
    activityLogStore.append({
      type: "action",
      category: "messaging",
      method: "POST",
      path: entry.type === "lifecycle_invalidation" ? "/send/invalidate" : "/gateway/ack",
      statusCode: 200,
      title: `Notification ${entry.type}`,
      details: { ...entry }
    }).catch(() => {});
  }
});

// --- Send power (global kill switch) ------------------------------------
// "power-off" flips `sendPowerOn` to false and blocks EVERY send path: new
// /send requests are rejected, the queue is paused, and any in-flight send is
// cancelled before Enter is pressed. "power-on" restores normal operation.
// The state is persisted to disk so an API restart cannot silently re-enable
// sending while an operator believes it is still off.
const sendPowerFile = path.join(config.rootDir, "data", "send-power.json");
let sendPowerOn = true;
let sendPowerChangedAt = Date.now();
// BullMQ persists its paused bit in Redis. That is transport state, not
// operator intent: a crash during startup must not leave delivery paused.
const queueManualPauseFile = path.join(config.rootDir, "data", "queue-manual-pause.json");
let queueManualPause = false;
let queueManualPauseChangedAt = Date.now();

async function loadSendPower() {
  try {
    const parsed = JSON.parse(await fs.readFile(sendPowerFile, "utf8"));
    if (typeof parsed.on === "boolean") {
      sendPowerOn = parsed.on;
      sendPowerChangedAt = Number(parsed.changedAt) || Date.now();
      if (!sendPowerOn) app.log.warn("send power is OFF (persisted); no messages will be sent until power-on");
    }
  } catch { /* default on */ }
}

async function persistSendPower() {
  try {
    await fs.mkdir(path.dirname(sendPowerFile), { recursive: true });
    await fs.writeFile(sendPowerFile, JSON.stringify({ on: sendPowerOn, changedAt: sendPowerChangedAt }, null, 2), "utf8");
  } catch (error) {
    app.log.warn({ error }, "could not persist send power state");
  }
}

async function loadManualQueuePause() {
  try {
    const parsed = JSON.parse(await fs.readFile(queueManualPauseFile, "utf8"));
    if (typeof parsed.paused === "boolean") {
      queueManualPause = parsed.paused;
      queueManualPauseChangedAt = Number(parsed.changedAt) || Date.now();
      if (queueManualPause) app.log.warn("send queue is manually paused (persisted)");
    }
  } catch { /* default: operators have not manually paused delivery */ }
}

async function persistManualQueuePause() {
  await fs.mkdir(path.dirname(queueManualPauseFile), { recursive: true });
  await fs.writeFile(queueManualPauseFile, JSON.stringify({
    paused: queueManualPause,
    changedAt: queueManualPauseChangedAt
  }, null, 2), "utf8");
}

async function setManualQueuePause(paused) {
  queueManualPause = paused;
  queueManualPauseChangedAt = Date.now();
  await persistManualQueuePause();
  if (paused || !sendPowerOn) await sendQueue.pause();
  else await sendQueue.resume();
}

async function setSendPower(on) {
  const changed = sendPowerOn !== on;
  sendPowerOn = on;
  sendPowerChangedAt = Date.now();
  if (changed) await persistSendPower();
  if (on && !queueManualPause) await sendQueue.resume().catch(() => {});
  else await sendQueue.pause().catch(() => {});
  emitSse({ type: "send_power", powerOn: on, at: new Date().toISOString() });
  return { ok: true, powerOn: on };
}

function isBrowserAutomationWedge(error) {
  const text = String(error?.message || error || "");
  return /send_timeout|browser_lock_.*timeout|connectOverCDP.*Timeout|Target page.*closed/i.test(text);
}

function isPairingReadinessFailure(error) {
  return error?.code === "GOOGLE_MESSAGES_NOT_READY";
}

async function publishBrowserRecovery(event) {
  const payload = {
    ...event,
    at: event.at || new Date().toISOString()
  };
  await fs.mkdir(path.dirname(browserRecoveryLogFile), { recursive: true }).catch(() => {});
  await fs.appendFile(browserRecoveryLogFile, `${JSON.stringify(payload)}\n`, "utf8").catch((error) => {
    app.log.warn({ error }, "could not persist browser recovery event");
  });
  emitSse(payload);
  // WEBHOOK_URL may point at Eve or another monitoring server. Recovery must
  // never wait for that remote receiver before the local retry can proceed.
  postWebhook(payload);
  return payload;
}

async function scheduleHardBrowserRecovery(reason, jobId) {
  if (hardRecoveryScheduled || process.platform === "win32") return false;
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(browserRecoveryFile, "utf8")); } catch { /* first recovery */ }
  if (Date.now() - Number(previous.at || 0) < HARD_RESTART_COOLDOWN_MS) {
    await publishBrowserRecovery({
      type: "browser_recovering",
      action: "hard_restart",
      outcome: "cooldown",
      reason: String(reason || "browser_unresponsive"),
      jobId: String(jobId || ""),
      retryAfterMs: HARD_RESTART_COOLDOWN_MS - (Date.now() - Number(previous.at || 0))
    });
    return false;
  }

  hardRecoveryScheduled = true;
  const record = { at: Date.now(), reason: String(reason || "browser_unresponsive"), jobId: String(jobId || "") };
  await fs.writeFile(browserRecoveryFile, JSON.stringify(record, null, 2), "utf8").catch(() => {});
  app.log.error({ reason: record.reason, jobId: record.jobId }, "browser automation wedged; scheduling hard recovery");
  await publishBrowserRecovery({
    type: "browser_hard_restart",
    action: "restart_chrome_and_api",
    outcome: "scheduled",
    reason: record.reason,
    jobId: record.jobId
  });
  scheduleSystemctl(["restart", "gmweb-chrome.service"]);
  setTimeout(() => scheduleSystemctl(["restart", "gmweb-api.service"]), 2500);
  return true;
}

async function recoverUnreadyBrowser(error, job) {
  if (recovering) return false;
  recovering = true;
  sendStore.markStage(job.id, "browser_recovering");
  const details = error?.details || {};
  await publishBrowserRecovery({
    type: "browser_recovering",
    action: "reload_and_reconnect",
    outcome: "started",
    reason: error?.code || "GOOGLE_MESSAGES_NOT_READY",
    jobId: String(job.id || ""),
    hint: details.hint || "",
    url: details.url || "",
    qrVisible: Boolean(details.qrVisible),
    signInVisible: Boolean(details.signInVisible)
  });

  try {
    await client.recover({ reload: true });
    const status = await client.status();
    if (status.paired) {
      app.log.info({ jobId: job.id }, "Google Messages recovered after reload/reconnect");
      await publishBrowserRecovery({
        type: "browser_recovering",
        action: "reload_and_reconnect",
        outcome: "recovered",
        reason: error?.code || "GOOGLE_MESSAGES_NOT_READY",
        jobId: String(job.id || "")
      });
      return true;
    }

    app.log.warn({ jobId: job.id, status }, "Google Messages still unready after reload/reconnect");
    await publishBrowserRecovery({
      type: "browser_recovering",
      action: "reload_and_reconnect",
      outcome: "still_unready",
      reason: error?.code || "GOOGLE_MESSAGES_NOT_READY",
      jobId: String(job.id || ""),
      hint: status.hint || "",
      qrVisible: Boolean(status.qrVisible),
      signInVisible: Boolean(status.signInVisible)
    });
    return scheduleHardBrowserRecovery(error.message, job.id);
  } catch (recoveryError) {
    app.log.warn({ error: recoveryError, jobId: job.id }, "reload/reconnect recovery failed");
    await publishBrowserRecovery({
      type: "browser_recovering",
      action: "reload_and_reconnect",
      outcome: "failed",
      reason: error?.code || "GOOGLE_MESSAGES_NOT_READY",
      jobId: String(job.id || ""),
      error: recoveryError?.message || String(recoveryError)
    });
    return scheduleHardBrowserRecovery(recoveryError?.message || error.message, job.id);
  } finally {
    recovering = false;
  }
}

async function waitForSendPace(job) {
  await sendPacing.wait({
    onWait: ({ waitMs, randomExtraMs, settings }) => {
      sendStore.markStage(job.id, "pacing");
      emitSse({
        type: "send_stage",
        requestId: requestIdForJob(job),
        jobId: job.id,
        to: job.data?.to,
        stage: "pacing",
        waitMs,
        randomExtraMs,
        maxPerMinute: settings.maxPerMinute,
        at: new Date().toISOString()
      });
    }
  });
}

function isHighPriorityJob(job) {
  return priorityForJob(job).bypassQuietHours;
}

function isDelayedRetryJob(job) {
  return Number(job?.attemptsMade || 0) > 0 ||
    Number(job?.opts?.delay || job?.delay || 0) > 0 ||
    Number(job?.data?.deferCount || 0) > 0 ||
    Boolean(job?.data?.deferReason);
}

function requestIdForJob(job) {
  const ledgerId = job?.data?._ledgerId || sendStore.byJob(job?.id)?.id;
  return sendStore.requestId(ledgerId);
}

/**
 * The key this job's task is held under in the Android bridge. The ledger row
 * is authoritative (it is written when the task is offered); the requestId and
 * the job-scoped fallback cover a job whose row was never bound.
 */
function gatewayTaskKey(job) {
  try {
    const row = job?.id ? sendStore.byJob(job.id) : null;
    if (row?.gateway_request_id) return row.gateway_request_id;
  } catch { /* fall through to the derived keys */ }
  return requestIdForJob(job) || (job?.id ? `pull_${job.id}` : null);
}

/**
 * Hand the bridge task back once its job is over. The durable tombstone stays
 * in the ledger, so a late ACK is still recognised as a late ACK — this only
 * stops in-memory entries from accumulating for the lifetime of the process.
 */
function releaseGatewayTask(job) {
  try {
    const key = gatewayTaskKey(job);
    if (key) return androidOutbox.release(key);
  } catch { /* bookkeeping must never break completion */ }
  return false;
}

async function deferQuietHoursJob(job, releaseAt) {
  const priority = priorityForJob(job);
  const ledger = sendStore.byJob(job.id);
  const data = {
    ...job.data,
    priority: priority.name,
    priorityLevel: priority.level,
    _ledgerId: ledger?.id || job.data?._ledgerId || null
  };
  const releaseIso = releaseAt.toISOString();
  sendStore.markStatus(job.id, "queued", { attempts: job.attemptsMade || 0 });
  sendStore.markStage(job.id, "quiet_hours");

  const deferredJob = await sendQueue.deferUntil(data, releaseAt, "quiet_hours", { priority: priority.name });
  if (data._ledgerId) sendStore.attachJob(data._ledgerId, deferredJob.id);
  if (data._idempotencyKey && data._bodyHash) {
    await sendQueue.setIdempotencyJob(data._idempotencyKey, deferredJob.id, data._bodyHash).catch(() => {});
  }

  const event = {
    type: "send_deferred",
    reason: "quiet_hours",
    requestId: requestIdForJob(job),
    jobId: job.id,
    deferredJobId: deferredJob.id,
    to: job.data?.to,
    priority: priority.name,
    priorityLevel: priority.level,
    timeZone: SEND_TIME_ZONE,
    releaseAt: releaseIso,
    at: new Date().toISOString()
  };
  emitSse(event);
  return { deferred: true, ...event };
}

async function deferConversationJob(job, error) {
  const priority = priorityForJob(job);
  const ledger = sendStore.byJob(job.id);
  const data = {
    ...job.data,
    priority: priority.name,
    priorityLevel: priority.level,
    _ledgerId: ledger?.id || job.data?._ledgerId || null
  };
  sendStore.markStatus(job.id, "queued", {
    attempts: job.attemptsMade || 0,
    error: error.message
  });

  const deferred = await sendQueue.deferBySuccesses(data, 10);
  if (data._ledgerId) sendStore.attachJob(data._ledgerId, deferred.job.id);
  if (data._idempotencyKey && data._bodyHash) {
    await sendQueue.setIdempotencyJob(data._idempotencyKey, deferred.job.id, data._bodyHash).catch(() => {});
  }

  const event = {
    type: "send_deferred",
    requestId: requestIdForJob(job),
    jobId: job.id,
    deferredJobId: deferred.job.id,
    to: job.data?.to,
    priority: priority.name,
    priorityLevel: priority.level,
    releaseAfterSuccesses: 10,
    at: new Date().toISOString()
  };
  emitSse(event);
  return { deferred: true, ...event };
}

// When the send power is off, a job that somehow reached the worker (a race
// with the queue pause) is NOT sent. It is re-queued with a short delay so it
// is delivered after power-on, mirroring the quiet-hours defer path.
async function deferPowerOffJob(job) {
  const priority = priorityForJob(job);
  const ledger = sendStore.byJob(job.id);
  sendStore.markStatus(job.id, "queued", { attempts: job.attemptsMade || 0 });
  sendStore.markStage(job.id, "power_off");
  const data = {
    ...job.data,
    priority: priority.name,
    priorityLevel: priority.level,
    _ledgerId: ledger?.id || job.data?._ledgerId || null
  };
  const deferred = await sendQueue.deferUntil(data, Date.now() + 30000, "power_off", { priority: priority.name });
  if (data._ledgerId) sendStore.attachJob(data._ledgerId, deferred.id);
  if (data._idempotencyKey && data._bodyHash) {
    await sendQueue.setIdempotencyJob(data._idempotencyKey, deferred.id, data._bodyHash).catch(() => {});
  }
  const event = {
    type: "send_deferred",
    reason: "power_off",
    requestId: requestIdForJob(job),
    jobId: job.id,
    deferredJobId: deferred.id,
    to: job.data?.to,
    priority: priority.name,
    priorityLevel: priority.level,
    at: new Date().toISOString()
  };
  emitSse(event);
  return { deferred: true, ...event };
}

async function handleSendCompleted(job, result) {
  activeSendCancellationRequests.delete(String(job.id));
  // This BullMQ job is over, whatever its outcome: the phone's task identity
  // belongs to the ledger tombstone now, not to a live promise.
  releaseGatewayTask(job);
  if (result?.deferred) return;
  const priority = priorityForJob(job);
  // The consumer may have cancelled while Playwright was between two awaits.
  // Never let a late worker completion overwrite that terminal decision.
  if (sendStore.byJob(job.id)?.status === "cancelled") return;
  // Lifecycle invalidation won the race: the reminder is terminal, NOT
  // successful, NOT billable and NEVER retryable. It deliberately skips
  // recordSuccessAndReleaseHigh() below, so a superseded notification cannot
  // consume the successful-send budget that releases deferred high-priority
  // work.
  if (result?.superseded) {
    const row = sendStore.byJob(job.id);
    const reason = result.reason || row?.revocation_reason || "superseded";
    if (row) sendRevocation.finalizeSuperseded(row, reason);
    const event = {
      type: "send_superseded",
      requestId: requestIdForJob(job),
      jobId: job.id,
      status: "superseded",
      state: "superseded",
      terminal: true,
      successful: false,
      superseded: true,
      retryable: false,
      counted: false,
      reason,
      serviceKey: row?.service_key || null,
      notificationKind: row?.notification_kind || null,
      generation: row?.notification_generation ?? null,
      correlationId: row?.correlation_id || null,
      revokedAt: row?.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      to: job.data?.to,
      priority: priority.name,
      priorityLevel: priority.level,
      at: result.at || new Date().toISOString()
    };
    emitSse(event);
    postWebhook(event);
    return;
  }
  if (result?.cancelled) {
    sendStore.markStatus(job.id, "cancelled", {
      attempts: job.attemptsMade || 0,
      error: result.error || "cancelled_by_consumer",
      result
    });
    const event = {
      type: "send_cancelled",
      requestId: requestIdForJob(job),
      jobId: job.id,
      status: "cancelled",
      to: job.data?.to,
      priority: priority.name,
      priorityLevel: priority.level,
      error: result.error || "cancelled_by_consumer",
      at: new Date().toISOString()
    };
    emitSse(event);
    postWebhook(event);
    return;
  }
  if (result?.unverified) {
    sendStore.markStatus(job.id, "unverified", {
      attempts: job.attemptsMade || 0,
      error: result.error || "outgoing_bubble_not_verified_after_single_submit",
      result
    });
    const event = {
      type: "send_unverified",
      requestId: requestIdForJob(job),
      jobId: job.id,
      status: "unverified",
      terminal: true,
      successful: false,
      to: job.data?.to,
      priority: priority.name,
      priorityLevel: priority.level,
      error: result.error || "outgoing_bubble_not_verified_after_single_submit",
      submittedOnce: true,
      submittedAt: result.submittedAt || null,
      verificationStatus: result.verificationStatus || "manual_review_required",
      verificationAttempts: Number(result.verificationAttempts || 0),
      conversationUrl: result.conversationUrl || null,
      recipientEvidence: result.recipientEvidence || null,
      at: new Date().toISOString()
    };
    emitSse(event);
    postWebhook(event);
    return;
  }
  if (result?.terminalFailure) {
    sendStore.markStatus(job.id, "failed", {
      attempts: job.attemptsMade || 0,
      error: result.error || "conversation_open_failed",
      result
    });
    const event = {
      type: "send_failed",
      requestId: requestIdForJob(job),
      jobId: job.id,
      status: "failed",
      terminal: true,
      successful: false,
      to: job.data?.to,
      priority: priority.name,
      priorityLevel: priority.level,
      error: result.error || "conversation_open_failed",
      at: new Date().toISOString()
    };
    emitSse(event);
    postWebhook(event);
    return;
  }
  sendStore.markStatus(job.id, "sent", { attempts: job.attemptsMade || 0, result });
  // Impossible-unsend: the revocation reached GMweb after the SIM had already
  // accepted the message. The physical truth wins and the race is recorded,
  // counted and audited -- it is never rewritten as a cancellation.
  const sentAfterRevocation = Boolean(result?.sentAfterRevocation);
  if (sentAfterRevocation) {
    sendRevocation.auditSentAfterRevocation(sendStore.byJob(job.id), {
      transport: client.name === "android" ? "android-pull" : client.name,
      result
    });
  }
  const submission = result?.submission || {};
  const event = {
    type: "send_completed",
    requestId: requestIdForJob(job),
    jobId: job.id,
    status: "sent",
    to: job.data?.to,
    priority: priority.name,
    priorityLevel: priority.level,
    text: job.data?.text,
    result: result || null,
    submittedOnce: Boolean(submission.submittedOnce),
    submittedAt: submission.submittedAt || null,
    verificationStatus: submission.verificationStatus || null,
    verificationAttempts: Number(submission.verificationAttempts || 0),
    fastPath: result?.fastPath,
    // A real submission that beat its own revocation: visible on the event so
    // no consumer can misread it as a clean, expected send.
    sentAfterRevocation,
    revocation: sentAfterRevocation ? (result?.revocation || null) : null,
    at: result?.at || new Date().toISOString()
  };
  emitSse(event);
  postWebhook(event);

  const release = await sendQueue.recordSuccessAndReleaseHigh();
  if (release.released) {
    const releasedPriority = priorityForJob(release.released);
    emitSse({
      type: "send_deferred_released",
      jobId: release.released.id,
      to: release.released.data?.to,
      priority: releasedPriority.name,
      priorityLevel: releasedPriority.level,
      successSequence: release.sequence,
      at: new Date().toISOString()
    });
  }
}

function startSendWorker() {
  sendQueue.startWorker(
    async (job) => {
      if (!sendPowerOn) return deferPowerOffJob(job);
      // DURABLE revocation barrier, read from the SQLite ledger rather than an
      // in-memory Set: a restarted process, a BullMQ-stalled job that got
      // re-queued, or a delayed retry hours later all refuse to touch a
      // transport for a notification whose lifecycle has moved on.
      const guard = sendRevocation.guardForJob(job.id);
      if (guard?.superseded) {
        return {
          superseded: true,
          reason: guard.reason,
          ledgerId: guard.row?.id ?? null,
          at: new Date().toISOString()
        };
      }
      if (guard?.cancelled) {
        return { cancelled: true, error: "cancelled_by_consumer" };
      }
      const priority = priorityForJob(job);
      // Runs in-process; shares the single Playwright browser via withBrowserLock.
      const schedule = sendGate(new Date(), {
        highPriority: isHighPriorityJob(job),
        delayedRetry: isDelayedRetryJob(job),
        timeZone: SEND_TIME_ZONE,
        startHour: SEND_QUIET_START_HOUR,
        endHour: SEND_QUIET_END_HOUR
      });
      if (schedule.blocked) return deferQuietHoursJob(job, schedule.releaseAt);
      await waitForSendPace(job);
      try {
        // The consumer notification identity is re-read from the ledger at send
        // time so the Android bridge can hand it to the phone (meta) and bind
        // the phone's task id for later /gateway/validate calls.
        const ledgerRow = sendStore.byJob(job.id);
        // ALWAYS an object, even when the send carries no consumer notification
        // identity. The phone builds its local dedupe record — the one holding
        // the gateway request id, and therefore the ability to acknowledge at
        // all — from this payload; a null meta produced tasks it could send but
        // never report. That is how one renewal became three physical SMS.
        const notificationMeta = {
          source: ledgerRow?.source ?? null,
          serviceKey: ledgerRow?.service_key ?? null,
          notificationKind: ledgerRow?.notification_kind ?? null,
          generation: ledgerRow?.notification_generation ?? null,
          correlationId: ledgerRow?.correlation_id ?? null,
          requiresValidation: Boolean(ledgerRow?.requires_validation)
        };
        // ONE logical identity for the whole life of this BullMQ job. A retry,
        // a delayed retry or a transport timeout must NOT look like a new task
        // to the phone, or a lost ACK turns into a duplicate SMS.
        const gatewayRequestId = requestIdForJob(job) || `pull_${job.id}`;
        const result = await Promise.race([
          client.sendMessage({
            to: job.data.to,
            text: job.data.text,
            ledgerId: ledgerRow?.id ?? null,
            jobId: job.id,
            requestId: gatewayRequestId,
            meta: notificationMeta,
            // Cooperative stop: consulted between every browser step AND before
            // the Android bridge hands the task to a phone.
            shouldCancel: () => !sendPowerOn
              || activeSendCancellationRequests.has(String(job.id))
              || Boolean(sendRevocation.guardForJob(job.id)),
            // Per-message progress: record the stage in the ledger and stream it.
            onStage: (s) => {
              sendStore.markStage(job.id, s);
              emitSse({ type: "send_stage", requestId: requestIdForJob(job), jobId: job.id, to: job.data?.to, priority: priority.name, priorityLevel: priority.level, stage: s, at: new Date().toISOString() });
            }
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("send_timeout")), SEND_TIMEOUT_MS))
        ]);
        sendFailStreak = 0; // a success clears the streak
        recoverEscalations = 0; // and proves the browser is genuinely healthy again
        return result;
      } catch (error) {
        if (error?.code === "SEND_CANCELLED") {
          // A cooperative stop can mean "the consumer cancelled" or "the
          // lifecycle was invalidated". The ledger knows which.
          const stopped = sendRevocation.guardForJob(job.id);
          if (stopped?.superseded) {
            return { superseded: true, reason: stopped.reason, ledgerId: stopped.row?.id ?? null, at: new Date().toISOString() };
          }
          return { cancelled: true, error: error.message };
        }
        if (error?.code === "SEND_UNVERIFIED") {
          return {
            unverified: true,
            submittedOnce: true,
            error: error.message,
            ...(error.details || {})
          };
        }
        // A send timeout only means "the browser is wedged" when the BROWSER is
        // the transport. On the Android pull transport the same timeout means
        // the phone never acknowledged — restarting Chrome AND the API (which
        // wipes this in-memory outbox) would turn a stalled task into a
        // redelivery storm instead of fixing anything.
        if (isBrowserAutomationWedge(error) && client.name !== "android") {
          sendStore.markStage(job.id, "browser_unresponsive");
          await scheduleHardBrowserRecovery(error.message, job.id);
        } else if (isPairingReadinessFailure(error)) {
          await recoverUnreadyBrowser(error, job);
        }
        if (error?.code === "GOOGLE_CONVERSATION_RATE_LIMIT") {
          await sendQueue.pause();
          app.log.warn("send queue auto-paused after Google limited new conversations");
          emitSse({
            type: "queue_paused",
            reason: "google_conversation_rate_limit",
            at: new Date().toISOString()
          });
        }
        if (error?.code === "CONVERSATION_OPEN_DEFER") {
          if (Number(job.data?.deferCount || 0) >= MAX_CONVERSATION_DEFERS) {
            return {
              terminalFailure: true,
              error: `${error.message} Maximum conversation defers reached (${MAX_CONVERSATION_DEFERS}).`
            };
          }
          return deferConversationJob(job, error);
        }
        throw error;
      }
    },
    {
      onActive: (job) => {
        const priority = priorityForJob(job);
        sendStore.markStatus(job.id, "active", { attempts: job.attemptsMade || 0 });
        emitSse({
          type: "send_processing",
          requestId: requestIdForJob(job),
          jobId: job.id,
          to: job.data?.to,
          priority: priority.name,
          priorityLevel: priority.level,
          at: new Date().toISOString()
        });
      },
      onCompleted: (job, result) => {
        handleSendCompleted(job, result)
          .catch((error) => app.log.warn({ error }, "send completion bookkeeping failed"));
      },
      onFailed: (job, err) => {
        activeSendCancellationRequests.delete(String(job?.id || ""));
        const attemptsMade = job?.attemptsMade || 0;
        const maxAttempts = job?.opts?.attempts || 1;
        const willRetry = attemptsMade < maxAttempts;
        const priority = priorityForJob(job);
        // While BullMQ still has retries left the job goes back to waiting, so
        // keep the ledger row 'queued'; only mark 'failed' once it's terminal.
        let status = willRetry ? "queued" : "failed";
        let failure = err?.message || "send failed";
        if (!willRetry && client.name === "android") {
          // The task went to a phone and was never acknowledged, so it may well
          // have been sent. Calling that "failed" invites a consumer retry that
          // becomes a duplicate SMS; "unverified" is the honest terminal state
          // and the documented contract for it is "never resend".
          const key = gatewayTaskKey(job);
          if (key && androidOutbox.tracks(key)) {
            status = "unverified";
            failure = "android_ack_missing";
          }
          releaseGatewayTask(job);
        }
        sendStore.markStatus(job?.id, status, {
          attempts: attemptsMade,
          error: failure
        });
        const event = {
          type: "send_failed",
          requestId: requestIdForJob(job),
          jobId: job?.id,
          status,
          to: job?.data?.to,
          priority: priority.name,
          priorityLevel: priority.level,
          error: failure,
          attemptsMade,
          willRetry,
          at: new Date().toISOString()
        };
        emitSse(event);
        postWebhook(event);

        // Auto-recover the browser after repeated failures (likely a wedged
        // page). Reconnects and loads a fresh Messages page without killing
        // the external Chrome. Only counts terminal failures (no more retries).
        if (!willRetry) {
          sendFailStreak += 1;

          sendQueue.recordSuccessAndReleaseHigh()
            .then((release) => {
              if (release.released) {
                const releasedPriority = priorityForJob(release.released);
                emitSse({
                  type: "send_deferred_released",
                  jobId: release.released.id,
                  to: release.released.data?.to,
                  priority: releasedPriority.name,
                  priorityLevel: releasedPriority.level,
                  successSequence: release.sequence,
                  at: new Date().toISOString()
                });
              }
            })
            .catch((error) => app.log.warn({ error }, "failed send deferred release bookkeeping failed"));
        }
        if (sendFailStreak >= SEND_FAIL_RESTART_THRESHOLD && !recovering) {
          recovering = true;
          sendFailStreak = 0;
          recoverEscalations += 1;

          // A soft recover already failed to clear a full streak once before —
          // reconnecting Playwright's reference isn't enough (seen in
          // production: every job failing identically on
          // "connectOverCDP: Timeout 30000ms exceeded" while the CDP port
          // still answered plain HTTP pings, i.e. Chrome itself was too
          // starved to service a new automation session). Escalate to a real
          // process restart, the same action "restart-chrome" performs.
          const hardRestartDue = recoverEscalations >= SEND_HARD_RESTART_THRESHOLD &&
            Date.now() - lastHardRestartAt > HARD_RESTART_COOLDOWN_MS;

          if (hardRestartDue) {
            lastHardRestartAt = Date.now();
            recoverEscalations = 0;
            app.log.warn("hard-restarting Chrome after repeated failed soft-recoveries");
            emitSse({ type: "browser_hard_restart", at: new Date().toISOString() });
            scheduleSystemctl(["restart", "gmweb-chrome.service"]);
            setTimeout(() => scheduleSystemctl(["restart", "gmweb-api.service"]), 2500);
            recovering = false; // this process is about to be restarted anyway
          } else {
            app.log.warn(`auto-recovering browser after ${SEND_FAIL_RESTART_THRESHOLD} consecutive send failures`);
            emitSse({ type: "browser_recovering", at: new Date().toISOString() });
            client.recover()
              .then(() => app.log.info("browser recover complete"))
              .catch((e) => app.log.warn({ e }, "browser recover failed"))
              .finally(() => { recovering = false; });
          }
        }
      },
      onError: (err) => app.log.warn({ err }, "send worker error")
    }
  );
}

app.register(swagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "GMweb API",
      description: [
        "Google Messages SMS/RCS gateway — control Google Messages Web via a REST API.",
        "",
        "## Authentication",
        "All endpoints (except `/health`) require a Bearer token in the `Authorization` header.",
        "",
        "Two token types are accepted:",
        "- **Master token** (`API_TOKEN` env var) — full access to all endpoints including admin and key management.",
        "- **Project API key** (`gmw_...`) — access to messaging & conversation endpoints only. Admin routes return 401.",
        "",
        "```",
        "Authorization: Bearer gmw_your_project_token",
        "```",
        "",
        "## Rate Limits",
        "Project keys have configurable per-minute and per-hour send limits.",
        "Repeated auth failures from an IP trigger a 30-minute block."
      ].join("\n"),
      version: pkg.version,
      contact: { name: "GMweb API" }
    },
    servers: [{ url: "/", description: "This server" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "gmw_... or master API_TOKEN",
          description: "Pass your API token. Project keys start with `gmw_`. Master key is the API_TOKEN env var."
        }
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", description: "Machine-readable error code" },
            message: { type: "string", description: "Human-readable description" }
          }
        },
        Message: {
          type: "object",
          properties: {
            index: { type: "integer" },
            type: { type: "string", enum: ["message", "timestamp"] },
            direction: { type: "string", enum: ["in", "out"] },
            text: { type: "string" },
            aria: { type: "string" }
          }
        },
        Conversation: {
          type: "object",
          properties: {
            id: { type: "string" },
            href: { type: "string", description: "Stable conversation path (use as identifier)" },
            title: { type: "string", description: "Contact name" },
            snippet: { type: "string", description: "Last message preview" },
            timestamp: { type: "string" },
            unread: { type: "boolean" },
            unreadCount: { type: "integer" },
            pinned: { type: "boolean" }
          }
        },
        ApiKey: {
          type: "object",
          properties: {
            id: { type: "string", description: "Key ID (hex)" },
            name: { type: "string" },
            allowedIps: { type: "array", items: { type: "string" }, description: "Allowed source IPs. Empty = any IP." },
            sendRateMinute: { type: "integer", description: "Max /send calls per minute (0 = unlimited)" },
            sendRateHour: { type: "integer", description: "Max /send calls per hour (0 = unlimited)" },
            createdAt: { type: "string", format: "date-time" },
            lastUsedAt: { type: "string", format: "date-time", nullable: true },
            requestCount: { type: "integer" },
            enabled: { type: "boolean" },
            tokenPreview: { type: "string", description: "First 8 chars of token for identification" }
          }
        }
      }
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Messaging", description: "Send messages" },
      { name: "Conversations", description: "Browse and read conversation history" },
      { name: "Session", description: "Browser session and pairing status" },
      { name: "Admin", description: "Service administration — master token only" },
      { name: "API Keys", description: "Manage project API keys — master token only" }
    ]
  }
});

app.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: {
    docExpansion: "list",
    deepLinking: true,
    displayRequestDuration: true,
    persistAuthorization: true,
    filter: true
  },
  staticCSP: false,
  transformStaticCSP: (header) => header
});

// Register reusable schemas for Fastify serialization and OpenAPI $ref
app.addSchema({
  $id: "Message",
  type: "object",
  properties: {
    index: { type: "integer" },
    type: { type: "string", enum: ["message", "timestamp"] },
    direction: { type: "string", enum: ["in", "out"] },
    text: { type: "string" },
    aria: { type: "string" }
  }
});

app.addSchema({
  $id: "Conversation",
  type: "object",
  properties: {
    id: { type: "string" },
    href: { type: "string" },
    title: { type: "string" },
    snippet: { type: "string" },
    timestamp: { type: "string" },
    unread: { type: "boolean" },
    unreadCount: { type: "integer" },
    pinned: { type: "boolean" }
  }
});

app.addSchema({
  $id: "ApiKey",
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    allowedIps: { type: "array", items: { type: "string" } },
    sendRateMinute: { type: "integer" },
    sendRateHour: { type: "integer" },
    scopes: { type: "array", items: { type: "string", enum: [...PROJECT_KEY_SCOPES] } },
    createdAt: { type: "string" },
    lastUsedAt: { type: ["string", "null"] },
    requestCount: { type: "integer" },
    enabled: { type: "boolean" },
    tokenPreview: { type: "string" }
  }
});

app.register(cors, { origin: corsOrigin });
app.register(cookie, {});
app.addHook("onRequest", applySecurityHeaders);
app.addHook("onRequest", (request, _reply, done) => {
  request._activityStartedAt = process.hrtime.bigint();
  done();
});
app.addHook("preHandler", requireToken);
app.addHook("onResponse", recordActivity);
app.setErrorHandler((error, request, reply) => {
  // If the reply was already sent (e.g. a streaming/raw handler finished the
  // response and a later code path threw — FST_ERR_REP_ALREADY_SENT), we must
  // NOT send again: re-sending throws ERR_HTTP_HEADERS_SENT, which is
  // uncaught and kills the process (the 502 restart loop seen in prod).
  if (
    reply.sent === true ||
    error.code === "FST_ERR_REP_ALREADY_SENT" ||
    /ERR_HTTP_HEADERS_SENT/i.test(String(error.message))
  ) {
    request.log.warn(
      { err: error.message, url: request.raw.url },
      "error after reply sent — suppressed (no double-send)"
    );
    return reply;
  }
  const statusCode = error.statusCode || 500;
  reply.code(statusCode).send({
    error: statusCode >= 500 ? "internal_error" : "request_error",
    message: error.message,
    details: error.details
  });
});

if (config.dashboardEnabled) {
  // Encapsulated child scope: @fastify/http-proxy re-adds its own
  // application/json parser at load, which previously collided with our
  // raw-body parser at the root. A child plugin isolates both.
  app.register(async function vncProxyScope(child) {
    // With the root-level exact-body parser installed, the child inherits
    // an application/json parser snapshot; @fastify/http-proxy registers
    // its own — remove the inherited one first to avoid
    // FST_ERR_CTP_ALREADY_PRESENT.
    if (child.hasContentTypeParser("application/json")) {
      child.removeContentTypeParser("application/json");
    }
    child.register(proxy, {
      upstream: config.vncProxyTarget,
      wsUpstream: config.vncProxyTarget.replace(/^http/i, "ws"),
      prefix: "/vnc",
      websocket: true,
      preHandler: async (request, reply) => {
        if (!hasDashboardAccess(request)) {
          reply.code(401).send({ error: "unauthorized" });
        }
      },
    });
  });
}

// Routes are registered inside app.after() so they run AFTER @fastify/swagger has
// loaded its onRoute hook. Routes added before that hook attaches are invisible to
// the generated OpenAPI spec (/docs would only show the proxy routes otherwise).
app.after(() => {

function parseLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

function currentQuietHours(now = new Date()) {
  const gate = sendGate(now, {
    highPriority: false,
    timeZone: SEND_TIME_ZONE,
    startHour: SEND_QUIET_START_HOUR,
    endHour: SEND_QUIET_END_HOUR
  });
  return {
    active: gate.blocked,
    timeZone: SEND_TIME_ZONE,
    startHour: SEND_QUIET_START_HOUR,
    endHour: SEND_QUIET_END_HOUR,
    releaseAt: gate.releaseAt?.toISOString() || null
  };
}

const STAGE_LABELS = {
  pacing: "Waiting for send pacing",
  quiet_hours: "Quiet hours (02:00–08:00 Asia/Tehran)",
  legacy_queued: "Imported from the existing Redis backlog",
  legacy_active: "Active job imported from the existing Redis backlog",
  checking_paired: "Checking Google Messages session",
  opening: "Opening recipient conversation",
  legacy_candidate_found: "Found an old cached conversation candidate",
  candidate_opened_for_verification: "Opened cached candidate to verify its phone number",
  recipient_revalidated: "Cached conversation recipient revalidated",
  candidate_rejected: "Cached candidate did not prove the requested phone number",
  locating: "Searching existing conversations",
  conversation_pacing: "Waiting before opening a new conversation",
  start_chat: "Opening Start chat",
  opening_start_chat: "Opening Start chat",
  restarting_start_chat: "Retrying Start chat",
  recipient_input_ready: "Recipient field ready",
  recipient_filled: "Recipient entered",
  selecting_recipient: "Selecting recipient",
  open_by_url: "Opening cached conversation URL",
  typing: "Typing and sending message",
  send_unverified: "Submitted once; outgoing bubble was not confirmed",
  verification_pending: "Submitted once; checking for the outgoing bubble without resending",
  verification_retry_1: "Verification recheck 1; no resend",
  verification_retry_2: "Verification recheck 2; no resend",
  verification_retry_3: "Verification recheck 3; no resend",
  sent_after_recheck: "Send confirmed by a later verification check",
  unverified_manual_review: "Submitted once; automatic checks exhausted; manual review required",
  retrying_without_reload: "Retrying without reloading Messages",
  browser_recovering: "Reloading and reconnecting Google Messages",
  browser_unresponsive: "Chrome automation is unresponsive; recovery scheduled",
  google_rate_limited: "Google asked the gateway to wait",
  sent: "Send confirmed",
  failed: "Send attempt failed"
};

function enrichQueueJob(job) {
  const now = Date.now();
  const ledger = sendStore.byJob(job.id);
  const createdMs = Date.parse(job.createdAt || "") || ledger?.created_at || now;
  const processedMs = Date.parse(job.processedAt || "") || ledger?.active_at || 0;
  const stageMs = ledger?.stage_at || ledger?.updated_at || 0;
  const activeForMs = job.state === "active" && processedMs ? now - processedMs : 0;
  const isPendingState = ["waiting", "paused", "delayed", "prioritized"].includes(job.state);
  const waitingForMs = isPendingState
    ? now - createdMs : Math.max(0, processedMs - createdMs);
  const stage = ledger?.stage || null;
  const stageForMs = stageMs ? Math.max(0, now - stageMs) : 0;
  const quietHours = currentQuietHours(new Date(now));
  const quietHoursHeld = quietHours.active &&
    (job.priority !== "critical" || job.state === "delayed") &&
    isPendingState;
  const visibleStage = quietHoursHeld ? "quiet_hours" : stage;

  let diagnosis = { code: "queued", severity: "info", message: "Waiting for its turn in the queue" };
  if (quietHoursHeld) {
    diagnosis = {
      code: "quiet_hours", severity: "info",
      message: job.priority === "critical"
        ? `Delayed CRITICAL retry held by quiet hours until 08:00 ${SEND_TIME_ZONE}`
        : `Held by quiet hours until 08:00 ${SEND_TIME_ZONE}; only fresh CRITICAL messages can send now`
    };
  } else if (job.state === "delayed") {
    diagnosis = job.deferReason === "quiet_hours"
      ? { code: "quiet_hours", severity: "info", message: "Non-critical SMS paused until 08:00 Asia/Tehran; fresh CRITICAL messages can send now" }
      : {
          code: "retry_backoff", severity: "warning",
          message: job.failedReason ? `Retry scheduled after: ${job.failedReason}` : "Waiting for retry delay"
        };
  } else if (job.state === "active") {
    if (stage === "browser_unresponsive" || activeForMs >= SEND_TIMEOUT_MS) {
      diagnosis = { code: "browser_unresponsive", severity: "error", message: "Chrome/Google Messages automation is hung; automatic recovery is scheduled" };
    } else if (stage === "browser_recovering") {
      diagnosis = { code: "browser_recovering", severity: "warning", message: "Google Messages was not ready; automatic reload/reconnect is running" };
    } else if (!stage && activeForMs > 15000) {
      diagnosis = { code: "waiting_browser_lock", severity: "warning", message: "Waiting for the browser automation lock; a previous browser action may be stuck" };
    } else {
      diagnosis = { code: stage || "starting", severity: activeForMs > 120000 ? "warning" : "info", message: STAGE_LABELS[stage] || "Starting browser operation" };
    }
  }

  return {
    ...job,
    stage: visibleStage,
    stageLabel: visibleStage ? (STAGE_LABELS[visibleStage] || visibleStage) : null,
    stageAt: quietHoursHeld ? null : (stageMs ? new Date(stageMs).toISOString() : null),
    ageMs: Math.max(0, now - createdMs),
    waitingForMs,
    activeForMs,
    stageForMs: quietHoursHeld ? 0 : stageForMs,
    quietHoursHeld,
    tracking: ledger ? "sqlite" : "redis_only",
    diagnosis
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout || 15000,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? error.code || 1 : 0,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim()
      });
    });
  });
}

async function systemctl(args) {
  if (process.platform === "win32") {
    return { ok: false, code: 1, stdout: "", stderr: "systemctl is not available on Windows" };
  }
  return runCommand("sudo", ["-n", "systemctl", ...args], { timeout: 20000 });
}

function scheduleSystemctl(args) {
  if (process.platform === "win32") return false;
  const child = spawn("sudo", ["-n", "systemctl", ...args], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return true;
}

async function serviceInfo(name) {
  if (process.platform === "win32") {
    return { name, active: "unsupported", enabled: "unsupported" };
  }
  const [active, enabled] = await Promise.all([
    runCommand("systemctl", ["is-active", name], { timeout: 5000 }),
    runCommand("systemctl", ["is-enabled", name], { timeout: 5000 })
  ]);
  return {
    name,
    active: active.stdout || "unknown",
    enabled: enabled.stdout || "unknown"
  };
}

async function sendDashboardFile(reply, filename, urlPath = "/dashboard/") {
  const safeName = filename || "index.html";
  if (safeName.includes("/") || safeName.includes("\\") || safeName.includes("..")) {
    reply.code(404).send("Not found");
    return;
  }
  const filePath = path.join(dashboardDir, safeName);
  const ext = path.extname(filePath);
  try {
    const body = await fs.readFile(filePath);
    applyStaticCachePolicy(reply, urlPath);
    reply.type(contentTypes[ext] || "application/octet-stream").send(body);
  } catch (error) {
    reply.code(404).send("Not found");
  }
}

// Serve the Vite SPA build (public/dashboard-next) under /app. Unknown paths
// fall back to index.html so client-side state routing works. relPath is the
// part after "/app/" (may include "assets/...").
async function sendSpaFile(reply, relPath, urlPath = "/app/") {
  const clean = String(relPath || "").replace(/\\/g, "/");
  if (clean.includes("..")) { reply.code(404).send("Not found"); return; }
  const candidate = clean && clean !== "/" ? path.join(spaDir, clean) : path.join(spaDir, "index.html");
  const ext = path.extname(candidate);
  try {
    const body = await fs.readFile(candidate);
    applyStaticCachePolicy(reply, urlPath);
    reply.type(contentTypes[ext] || "application/octet-stream").send(body);
  } catch {
    // SPA fallback: serve index.html for any non-asset path
    try {
      const html = await fs.readFile(path.join(spaDir, "index.html"));
      applyStaticCachePolicy(reply, "/app/index.html");
      reply.type("text/html; charset=utf-8").send(html);
    } catch {
      reply.code(404).send("Console not built. Run: npm --prefix dashboard-next run build");
    }
  }
}

// web-01: serve the NEW secure PWA (public/web-app) under /web with a strict
// CSP (TechSpec §20): self-only scripts/styles, no inline/eval, no frames.
// The hashed-asset Vite output never needs inline code.
function webAppSecurityHeaders(reply) {
  reply.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; ")
  );
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
}

async function sendWebAppFile(reply, relPath, urlPath = "/web/") {
  const clean = String(relPath || "").replace(/\\/g, "/");
  if (clean.includes("..")) { reply.code(404).send("Not found"); return; }
  const candidate = clean && clean !== "/" ? path.join(webAppDir, clean) : path.join(webAppDir, "index.html");
  const ext = path.extname(candidate);
  try {
    const body = await fs.readFile(candidate);
    webAppSecurityHeaders(reply);
    applyStaticCachePolicy(reply, urlPath);
    reply.type(contentTypes[ext] || "application/octet-stream").send(body);
  } catch {
    // SPA fallback for client-side routing (never for missing assets — but the
    // strict path check above already blocks traversal).
    try {
      const html = await fs.readFile(path.join(webAppDir, "index.html"));
      webAppSecurityHeaders(reply);
      applyStaticCachePolicy(reply, "/web/index.html");
      reply.type("text/html; charset=utf-8").send(html);
    } catch {
      reply.code(404).send("Web app not built. Run: npm --prefix web run build");
    }
  }
}

/**
 * PWA build provenance + release integrity.
 *
 * Returns an explicit machine state (never just a boolean), so the dashboard
 * can say WHY it is unhappy:
 *   current | version_mismatch | pwa_assets_missing | pwa_not_built | pwa_manifest_invalid
 *
 * The revision comes from the build artifact written by `npm run build:pwa`
 * (web/vite.config.ts). It is read from disk, never shelled out to git on a
 * poll.
 */
async function webAppDeploymentInfo() {
  const base = {
    ok: false, state: "pwa_not_built", reason: "pwa_not_built",
    version: null, revision: null, script: null, styles: [], matchesApi: false,
    builtAt: null, path: "/web", missingAssets: []
  };
  let versionText;
  let indexText;
  let stat;
  try {
    [versionText, indexText, stat] = await Promise.all([
      fs.readFile(path.join(webAppDir, "version.json"), "utf8"),
      fs.readFile(path.join(webAppDir, "index.html"), "utf8"),
      fs.stat(path.join(webAppDir, "index.html")),
    ]);
  } catch (error) {
    return {
      ...base,
      state: error.code === "ENOENT" ? "pwa_not_built" : "pwa_manifest_invalid",
      reason: error.code === "ENOENT" ? "pwa_not_built" : "pwa_manifest_invalid"
    };
  }

  let build;
  try {
    build = JSON.parse(versionText);
  } catch {
    return { ...base, state: "pwa_manifest_invalid", reason: "pwa_manifest_invalid" };
  }
  const version = String(build?.version || "");
  if (!version) return { ...base, state: "pwa_manifest_invalid", reason: "pwa_manifest_invalid" };

  // Optional provenance from the build (same version, different commit).
  let info = {};
  try { info = JSON.parse(await fs.readFile(path.join(webAppDir, "build-info.json"), "utf8")); } catch { /* optional */ }

  const script = indexText.match(/\/web\/assets\/(index-[^"']+\.js)/)?.[1] || null;
  const styles = [...indexText.matchAll(/\/web\/(assets\/[^"']+\.css)/g)].map((m) => m[1]);
  const referenced = [...new Set([...(script ? [`assets/${script}`] : []), ...styles])];
  const missingAssets = [];
  for (const ref of referenced) {
    try { await fs.access(path.join(webAppDir, ref)); } catch { missingAssets.push(ref); }
  }

  const matchesApi = version === pkg.version;
  const complete = Boolean(script) && missingAssets.length === 0;
  const state = !complete ? "pwa_assets_missing"
    : (!matchesApi ? "version_mismatch" : "current");

  return {
    ok: complete && matchesApi,
    state,
    reason: state === "current" ? null : state,
    version,
    revision: String(info.revision || "") || null,
    script,
    styles,
    missingAssets,
    matchesApi,
    // builtAt: what the build recorded, else when the entry file landed.
    builtAt: info.builtAt || stat.mtime.toISOString(),
    path: "/web",
  };
}

app.get("/health", {
  schema: {
    summary: "Health check",
    description: "Returns 200 if the API server process is running. Does **not** require authentication.",
    tags: ["Session"],
    security: [],
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          service: { type: "string" },
          version: { type: "string" },
          serverTime: { type: "integer" },
          uptimeSeconds: { type: "integer" }
        }
      }
    }
  }
}, async () => ({
  ok: true,
  service: pkg.name,
  version: pkg.version,
  serverTime: Date.now(),
  uptimeSeconds: Math.floor(process.uptime())
}));

if (config.dashboardEnabled) {
  app.get("/", async (_request, reply) => reply.redirect("/dashboard"));

  app.get("/dashboard", async (request, reply) => sendDashboardFile(reply, "index.html", request.url));
  app.get("/dashboard/", async (request, reply) => sendDashboardFile(reply, "index.html", request.url));
  app.get("/dashboard/:file", async (request, reply) => sendDashboardFile(reply, request.params.file, request.url));

  // New React console (Vite SPA). Static assets + SPA fallback. Hidden from OpenAPI.
  app.get("/app", { schema: { hide: true } }, async (request, reply) => sendSpaFile(reply, "index.html", request.url));
  app.get("/app/", { schema: { hide: true } }, async (request, reply) => sendSpaFile(reply, "index.html", request.url));
  app.get("/app/*", { schema: { hide: true } }, async (request, reply) => sendSpaFile(reply, request.params["*"], request.url));
  // web-01: the NEW secure PWA under /web (strict CSP §20, own artifact).
  app.get("/web", { schema: { hide: true } }, async (request, reply) => sendWebAppFile(reply, "index.html", request.url));
  app.get("/web/", { schema: { hide: true } }, async (request, reply) => sendWebAppFile(reply, "index.html", request.url));
  app.get("/web/*", { schema: { hide: true } }, async (request, reply) => sendWebAppFile(reply, request.params["*"], request.url));

  app.get("/dashboard/session", async (request) => {
    const session = dashboardSession(request);
    const passwordSession = dashboardPasswordSession(request);
    return {
      passwordRequired: passwordAuthEnabled(),
      passwordAuthenticated: Boolean(passwordSession),
      authenticated: Boolean(session),
      csrfToken: session ? session.csrfToken : null,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null
    };
  });

  app.post("/dashboard/password-login", async (request, reply) => {
    if (!passwordAuthEnabled()) {
      return { ok: true, passwordRequired: false };
    }
    const limit = checkRateLimit(request, "dashboard-password-login", config.dashboardPasswordMax, config.dashboardPasswordWindowMs);
    if (!limit.allowed) {
      reply.header("retry-after", String(limit.retryAfterSeconds));
      reply.code(429).send({ error: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds });
      return;
    }

    const schema = z.object({
      username: z.string().min(1).max(128),
      password: z.string().min(1).max(512)
    });
    const parsed = schema.safeParse(request.body || {});
    const username = parsed.success ? parsed.data.username : "";
    const password = parsed.success ? parsed.data.password : "";
    const usernameValid = safeStringEqual(username, config.dashboardUsername);
    const passwordHash = usernameValid ? config.dashboardPasswordHash : dummyDashboardPasswordHash;
    const passwordValid = verifyDashboardPassword(password, passwordHash);
    const valid = parsed.success && usernameValid && passwordValid;
    if (!valid) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const passwordSession = createDashboardPasswordSession(request);
    reply.header(
      "set-cookie",
      `${dashboardPasswordCookieName}=${encodeURIComponent(passwordSession.sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.dashboardPasswordSessionTtlMs / 1000)}${config.dashboardCookieSecure ? "; Secure" : ""}`
    );
    return { ok: true, passwordRequired: true };
  });

  app.post("/dashboard/login", async (request, reply) => {
    if (!dashboardPasswordSession(request)) {
      reply.code(403).send({ error: "password_login_required" });
      return;
    }
    const limit = checkRateLimit(request, "dashboard-login", config.dashboardLoginMax, config.dashboardLoginWindowMs);
    if (!limit.allowed) {
      reply.header("retry-after", String(limit.retryAfterSeconds));
      reply.code(429).send({ error: "rate_limited" });
      return;
    }
    const schema = z.object({ token: z.string().min(1) });
    const parsed = schema.safeParse(request.body || {});
    if (!parsed.success || (config.apiToken && parsed.data.token !== config.apiToken)) {
      reply.code(401).send({
        error: "invalid_api_token",
        message: "This API token is not active. Run `gmweb token` on the server to print the active token."
      });
      return;
    }
    const session = createDashboardSession(request);
    reply.header(
      "set-cookie",
      `${dashboardSessionCookieName}=${encodeURIComponent(session.sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.dashboardSessionTtlMs / 1000)}${config.dashboardCookieSecure ? "; Secure" : ""}`
    );
    return { ok: true, csrfToken: session.csrfToken };
  });

  app.post("/dashboard/logout", async (request, reply) => {
    const session = dashboardSession(request);
    if (session && !csrfAllowed(request, session)) {
      reply.code(403).send({ error: "csrf_failed" });
      return;
    }
    clearDashboardSession(request);
    reply.header("set-cookie", [
      `${dashboardSessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.dashboardCookieSecure ? "; Secure" : ""}`,
      `${dashboardPasswordCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.dashboardCookieSecure ? "; Secure" : ""}`
    ]);
    return { ok: true };
  });
}

app.get("/admin/overview", {
  schema: {
    summary: "Service overview",
    description: "Returns pairing status, browser state, and systemd service health for all GMweb components. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          service: { type: "string" },
          version: { type: "string" },
          now: { type: "string", format: "date-time" },
          adminActionsEnabled: { type: "boolean" },
          readiness: {
            type: "object",
            additionalProperties: true,
            properties: {
              ready: { type: "boolean" },
              status: { type: "object", additionalProperties: true }
            }
          },
          browserAutomation: { type: "object", additionalProperties: true },
          webApp: { type: "object", additionalProperties: true },
          metrics: {
            type: "object",
            additionalProperties: { type: "integer" },
            description: "Durable lifecycle counters (sms_invalidations_total, sms_jobs_superseded_total, sms_inflight_revoked_total, sms_sent_after_revocation_total, sms_validation_requests_total, ...)."
          },
          revocation: {
            type: "object",
            properties: {
              superseded: { type: "integer" },
              revokedInflight: { type: "integer" },
              tombstones: { type: "integer" }
            }
          },
          system: {
            type: "object",
            properties: {
              cpu: {
                type: "object",
                properties: {
                  cores: { type: "integer" }, usagePercent: { type: "number" },
                  load1: { type: "number" }, load5: { type: "number" }, load15: { type: "number" },
                  loadPercent: { type: "number" }
                }
              },
              memory: {
                type: "object",
                properties: {
                  totalBytes: { type: "integer" }, availableBytes: { type: "integer" },
                  usedBytes: { type: "integer" }, usagePercent: { type: "number" }
                }
              },
              swap: {
                type: "object",
                properties: {
                  totalBytes: { type: "integer" }, usedBytes: { type: "integer" }, usagePercent: { type: "number" }
                }
              },
              uptimeSeconds: { type: "integer" }
            }
          },
          services: { type: "array", items: { type: "object", additionalProperties: true } }
        }
      }
    }
  }
}, async () => {
  // ONE snapshot for this refresh. "Delivery" (readiness.ready) and "Device
  // bridge" (transport.ready) are two readings of the SAME object, so the old
  // "Phone ready + No device" contradiction is structurally impossible.
  const transport = await transportHealth.snapshot();
  const android = await transportHealth.android();
  const readiness = { ready: transport.ready, status: transport };
  let browserAutomation = { ok: null, code: "not_checked" };
  try {
    browserAutomation = JSON.parse(await fs.readFile(browserHealthFile, "utf8"));
  } catch { /* watchdog has not written its first probe yet */ }

  const services = await Promise.all([
    serviceInfo("gmweb-chrome.service"),
    serviceInfo("gmweb-api.service"),
    serviceInfo("gmweb-vnc.service"),
    serviceInfo("gmweb-novnc.service")
  ]);
  const system = await readSystemMetrics();
  const webApp = await webAppDeploymentInfo();
  // Queue NOW and ledger OUTCOMES are sampled together so one refresh can never
  // mix a live count with a stale total, and they use the SAME builder as
  // /admin/queue so the two endpoints cannot disagree.
  const [queueCounts, queuePaused] = await Promise.all([
    sendQueue.counts().catch(() => ({})),
    sendQueue.isPaused().catch(() => false)
  ]);
  const queueReport = buildQueueReport({
    bullmq: queueCounts,
    ledgerAllTime: sendStore.stats(),
    ledgerLast24h: sendStore.statsSince(Date.now() - 24 * 60 * 60 * 1000)
  });

  return {
    ok: true,
    service: pkg.name,
    version: pkg.version,
    now: new Date().toISOString(),
    adminActionsEnabled: config.adminActionsEnabled,
    // Explicit transport identity for dashboards. The normalised fields are
    // authoritative; the aliases below keep existing consumers working
    // (`name` is always exactly chrome|android, `transport` keeps the old
    // "android-pull"/"android"/"chrome" string).
    transport: {
      ...transport,
      name: transport.activeTransport,
      paired: transport.ready,
      transport: transport.activeTransport === "android"
        ? (transport.mode === "pull" ? "android-pull" : "android")
        : "chrome",
      androidReady: android.ready,
      androidReason: android.reason || null
    },
    // Queue NOW (live BullMQ) and delivery OUTCOMES (durable ledger) are
    // different questions with different time windows and are never merged.
    queue: {
      ...queueReport.queue,
      paused: queuePaused,
      manualPause: queueManualPause,
      powerOn: sendPowerOn
    },
    idle: queueReport.idle,
    ledger: queueReport.ledger,
    vnc: {
      proxyPath: "/vnc/vnc.html?autoconnect=true&resize=scale&path=vnc/websockify",
      target: config.vncProxyTarget,
      ready: services.some((service) => service.name === "gmweb-vnc.service" && service.active === "active") &&
        services.some((service) => service.name === "gmweb-novnc.service" && service.active === "active")
    },
    readiness,
    browserAutomation,
    webApp,
    // Lifecycle revocation observability (the stale-SMS race): durable counters
    // in the project's sms_*_total style, plus the live bridge tombstones. No
    // phone number, message text or service key is ever exposed here.
    metrics: sendStore.counters(),
    revocation: {
      superseded: sendStore.stats().superseded,
      revokedInflight: sendStore.revokedInflightCount(),
      tombstones: androidOutbox.stats().tombstones
    },
    system,
    services
  };
});

app.post("/admin/action", {
  schema: {
    summary: "Run admin action",
    description: "Trigger a system-level action such as restarting the browser, toggling VNC, or running a smoke test. **Master token only.**",
    tags: ["Admin"],
    body: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["vnc-on", "vnc-off", "restart-api", "restart-chrome", "browser-start", "browser-restart", "smoke", "power-off", "power-on"],
          description: "`restart-api` and `restart-chrome` are async (return immediately). All others are synchronous."
        }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          action: { type: "string" },
          queued: { type: "boolean", description: "True for async actions that are scheduled but not yet complete" }
        }
      }
    }
  }
}, async (request, reply) => {
  const limit = checkRateLimit(request, "admin-action", config.adminActionMax, config.adminActionWindowMs);
  if (!limit.allowed) {
    reply.header("retry-after", String(limit.retryAfterSeconds));
    reply.code(429).send({ error: "rate_limited" });
    return;
  }

  if (!config.adminActionsEnabled) {
    reply.code(403).send({ error: "admin_actions_disabled" });
    return;
  }

  const schema = z.object({
    action: z.enum([
      "vnc-on",
      "vnc-off",
      "restart-api",
      "restart-chrome",
      "browser-start",
      "browser-restart",
      "smoke",
      "power-off",
      "power-on"
    ])
  });
  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  const { action } = parsed.data;
  if ((action === "browser-start" || action === "browser-restart") && typeof client.start !== "function") {
    reply.code(501).send({ error: "chrome_only_endpoint", action, message: "Browser control applies to the chrome transport; the android transport runs with no local browser." });
    return;
  }
  if (action === "browser-start") {
    await client.start();
    return { ok: true, action, status: await client.status() };
  }
  if (action === "browser-restart") {
    await client.stop();
    await client.start();
    return { ok: true, action, status: await client.status() };
  }
  if (action === "smoke") {
    const status = await client.status();
    const conversations = typeof client.listConversations === "function"
      ? await client.listConversations(3)
      : androidConversationsFromLedger(3);
    return { ok: true, action, status, conversations };
  }
  if (action === "vnc-on") {
    const result = await systemctl(["start", "gmweb-vnc.service", "gmweb-novnc.service"]);
    return { ok: result.ok, action, result };
  }
  if (action === "vnc-off") {
    const result = await systemctl(["stop", "gmweb-novnc.service", "gmweb-vnc.service"]);
    return { ok: result.ok, action, result };
  }
  if (action === "restart-api") {
    scheduleSystemctl(["restart", "gmweb-api.service"]);
    return { ok: true, action, queued: true };
  }
  if (action === "restart-chrome") {
    scheduleSystemctl(["restart", "gmweb-chrome.service"]);
    setTimeout(() => scheduleSystemctl(["restart", "gmweb-api.service"]), 2500);
    return { ok: true, action, queued: true };
  }
  if (action === "power-off") {
    return setSendPower(false);
  }
  if (action === "power-on") {
    return setSendPower(true);
  }
});

app.get("/admin/power", {
  schema: {
    summary: "Send power state",
    description: "Returns whether sending is currently powered on. When `powerOn` is false, `POST /send` rejects every message (HTTP 503 `powered_off`) and the send queue is paused. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          powerOn: { type: "boolean" },
          changedAt: { type: "string", format: "date-time" }
        }
      }
    }
  }
}, async () => ({
  ok: true,
  powerOn: sendPowerOn,
  changedAt: new Date(sendPowerChangedAt).toISOString()
}));

app.get("/admin/transport", {
  schema: {
    summary: "Delivery transport state",
    description: "Returns the active delivery transport (`chrome` = Google Messages for Web automation, `android` = Messages app relay) plus per-transport readiness and, for android, the pull/push mode and live device connection state. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          transport: { type: "string", enum: ["chrome", "android"] },
          available: { type: "array", items: { type: "string" } },
          chromeReady: { type: "boolean" },
          androidReady: { type: "boolean" },
          androidConfigured: { type: "boolean" },
          androidMode: { type: "string", enum: ["pull", "push"] },
          androidDevices: { type: "integer", deprecated: true, description: "Deprecated compatibility alias for active polls; not a device count." },
          androidActivePolls: { type: "integer" },
          androidDistinctDevices: { type: ["integer", "null"] },
          androidPending: { type: "integer", description: "Sends waiting for a device to pick up." },
          androidInflight: { type: "integer", description: "Sends a device is delivering right now." },
          androidLastPullAt: { type: ["string", "null"], format: "date-time", description: "Most recent Android pull in pull mode." },
          androidState: { type: "string", enum: ["connected", "stale", "unconfigured", "push_unreachable", "not_paired", "unknown"] },
          androidReason: { type: ["string", "null"], description: "Machine reason, e.g. no_recent_device_pull or device_key_not_configured." },
          androidLastPullAgeMs: { type: ["integer", "null"] },
          androidLivenessMs: { type: "integer" },
          androidLastAckAt: { type: ["string", "null"] },
          androidLastTaskPulledAt: { type: ["string", "null"] },
          // Additive + authoritative. Declared explicitly: Fastify's response
          // serializer strips properties the schema does not list, so an
          // undeclared field would silently never reach the dashboard.
          activeTransport: { type: "string", enum: ["chrome", "android"] },
          mode: { type: ["string", "null"], enum: ["pull", "push", null] },
          health: { type: "object", additionalProperties: true, description: "The full normalized snapshot (same object /admin/overview returns as `transport`)." }
        }
      }
    }
  }
}, async () => {
  // ONE snapshot — the same object /admin/overview reports as `transport`, so
  // the two endpoints can never disagree about the active device.
  const health = await transportHealth.snapshot();
  const android = await transportHealth.android();

  return {
    ok: true,
    // ── normalised, authoritative ───────────────────────────────────────────
    health,
    activeTransport: health.activeTransport,
    mode: health.mode,
    // ── backward-compatible shape (existing dashboard + consumers) ───────────
    // `transport` keeps meaning "the canonical active transport".
    transport: health.activeTransport,
    available: ["chrome", "android"],
    chromeReady: health.activeTransport === "chrome"
      ? health.ready
      : Boolean(health.alternatives.chrome?.ready),
    // androidReady answers "is the ANDROID bridge usable", independent of which
    // transport is active — and in pull mode it is the pull bridge that answers,
    // never the direct-push client.
    androidReady: Boolean(android.ready),
    androidConfigured: Boolean(android.configured),
    androidMode: health.mode === "pull" ? "pull" : "push",
    androidState: android.state,
    androidReason: android.reason || null,
    androidDevices: Number(android.waitingPhones || 0),
    androidActivePolls: Number(android.activePolls || 0),
    androidDistinctDevices: android.distinctDevices ?? null,
    androidPending: Number(android.pending || 0),
    androidInflight: Number(android.inflight || 0),
    androidLastPullAt: android.lastPullAt || null,
    androidLastPullAgeMs: android.lastPullAgeMs ?? null,
    androidLivenessMs: Number(android.livenessMs || 0),
    androidLastAckAt: android.lastAckAt || null,
    androidLastTaskPulledAt: android.lastTaskPulledAt || null
  };
});

app.get("/eve/v1/transport-health", {
  schema: {
    summary: "Delivery transport health for the Eve consumer",
    description: "Read-only projection of the authoritative transport snapshot (the same object /admin/transport serves), scoped with `transport:read` instead of the master token. Never exposes device keys, credentials, recipients or message content. The response shape is declared in shared/eve-gmweb-contract-v1.json, and the schema below is derived from that file so no declared field can be silently stripped by the response serializer.",
    tags: ["Eve"],
    response: {
      200: {
        type: "object",
        properties: eveTransportHealthSchema()
      }
    }
  }
}, async (request, reply) => {
  // The same operational budget the other read-only diagnostics use: this is
  // polled by an operator's settings page, never by a device.
  const limit = checkRateLimit(request, "eve-transport-health", 120, 60_000);
  if (!limit.allowed) {
    reply.header("retry-after", String(limit.retryAfterSeconds));
    reply.code(429).send({ error: "rate_limited" });
    return;
  }
  return projectTransportHealth(await transportHealth.snapshot());
});

app.get("/admin/gateway-diagnostics", {
  schema: {
    summary: "Privacy-safe Android pull-bridge diagnostics",
    description: "Returns operational gateway telemetry without keys, recipients, message bodies or raw request identifiers. **Master token only.**",
    tags: ["Admin"],
    response: { 200: { type: "object", additionalProperties: true } }
  }
}, async () => {
  const transport = await transportHealth.android();
  const bridge = gatewayTelemetry.snapshot();
  return {
    serverTime: Date.now(),
    transport,
    deviceKey: { configured: deviceKeyStore.configured, source: deviceKeyStore.source },
    pullBridge: bridge,
    devices: gatewayTelemetry.deviceSnapshot(),
    queue: {
      pending: Number(transport.pending || 0),
      inflight: Number(transport.inflight || 0),
      revokedInflight: Number(transport.revokedInflight || 0)
    },
    recent: {
      lastTaskPulledAt: bridge.lastTaskPulledAt,
      lastAckAt: bridge.lastAckAt,
      lastValidateAt: bridge.lastValidateAt
    }
  };
});

// ── Device key management (dashboard-managed pull-bridge credential) ────────
app.get("/admin/device-key", {
  schema: {
    summary: "Android device key state",
    description: "Returns the masked device key the Messages app must present as X-API-Key on /gateway/*. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          configured: { type: "boolean" },
          preview: { type: ["string", "null"] },
          source: { type: "string", enum: ["file", "env", "none"] }
        }
      }
    }
  }
}, async () => ({
  ok: true,
  configured: deviceKeyStore.configured,
  preview: deviceKeyStore.preview(),
  source: deviceKeyStore.source
}));

app.post("/admin/device-key/reveal", {
  schema: {
    summary: "Reveal the full device key",
    description: "Returns the full key once so it can be pasted into the phone app. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: { type: "object", properties: { ok: { type: "boolean" }, key: { type: ["string", "null"] } } }
    }
  }
}, async () => ({ ok: true, key: deviceKeyStore.key || null }));

app.post("/admin/device-key/rotate", {
  schema: {
    summary: "Generate a new device key",
    description: "Generates a fresh device key, persists it, and returns it once. Devices configured with the old key stop authenticating immediately — paste the new key into the app. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: { type: "object", properties: { ok: { type: "boolean" }, key: { type: "string" }, preview: { type: "string" } } }
    }
  }
}, async (request, reply) => {
  const limit = checkRateLimit(request, "admin-action", config.adminActionMax, config.adminActionWindowMs);
  if (!limit.allowed) {
    reply.header("retry-after", String(limit.retryAfterSeconds));
    reply.code(429).send({ error: "rate_limited" });
    return;
  }
  const key = await deviceKeyStore.generate();
  app.log.info({ preview: deviceKeyStore.preview() }, "device key rotated");
  return { ok: true, key, preview: deviceKeyStore.preview() };
});

app.post("/admin/transport", {
  schema: {
    summary: "Switch delivery transport",
    description: "Switches message delivery between the paired Chrome browser and the Messages Android gateway. Persisted across restarts. **Master token only.**",
    tags: ["Admin"],
    body: {
      type: "object",
      required: ["transport"],
      properties: { transport: { type: "string", enum: ["chrome", "android"] } }
    },
    response: {
      200: {
        type: "object",
        properties: { ok: { type: "boolean" }, transport: { type: "string" }, available: { type: "array", items: { type: "string" } } }
      },
      400: { type: "object", properties: { error: { type: "string" } } }
    }
  }
}, async (request, reply) => {
  const limit = checkRateLimit(request, "admin-action", config.adminActionMax, config.adminActionWindowMs);
  if (!limit.allowed) {
    reply.header("retry-after", String(limit.retryAfterSeconds));
    reply.code(429).send({ error: "rate_limited" });
    return;
  }
  try {
    const status = await client.setTransport(String(request.body?.transport || ""));
    return { ok: true, ...status };
  } catch (error) {
    reply.code(400).send({ error: error.message });
  }
});

// ── Android device pull bridge (phone dials OUT; no tunnel needed) ──────────
// GET /gateway/pull, POST /gateway/validate and POST /gateway/ack live in
// src/gatewayRoutes.js: the bridge is where the stale-SMS race is won or lost,
// and keeping it a separate boundary is what lets the whole supersede/validate
// contract be tested against a real ledger with no Redis and no browser.
// Auth is unchanged: the device key, checked by the global preHandler AND by
// each handler (defence in depth).
registerGatewayRoutes(app, {
  outbox: androidOutbox,
  sendStore,
  revocation: sendRevocation,
  checkDeviceKey,
  checkRateLimit,
  isPullModeActive: () => Boolean(client.pullMode && client.name === "android" && client.outbox),
  log: app.log,
  telemetry: gatewayTelemetry
});

// ── Phase 2 Control Plane (ADR-001/004, TechSpec §51–58) ────────────────────
// Trust relay + durable commands + agent bridge — logic lives in
// controlPlaneRoutes.js (modular-monolith boundary; injectable deps).
registerControlPlaneRoutes(app, {
  trustRegistry,
  commandEngine,
  eventStore,
  accountId: DEFAULT_ACCOUNT_ID,
  authorizeAgent,
  linkedSessions,
  deviceTelemetryStore,
  agentAuthService,
  checkRateLimit,
});

// PR-08b: per-device identity registration (device-key bootstrap → ECDSA).
registerAgentIdentityRoutes(app, { agentAuthService });

// ADR-007: primary-device QR pairing relay (web ← Android approval).
require("./primaryEnrollment").registerPrimaryEnrollment(app, { agentAuthService, config, canAdmin: hasDashboardAccess });
registerConnectionDiagnostics(app, {
  agentAuthService,
  canAdmin: hasDashboardAccess,
  checkRateLimit,
  config,
  eventStore,
  accountId: DEFAULT_ACCOUNT_ID,
});
registerPairingRoutes(app, {
  agentAuthService,
  config,
  checkRateLimit,
  eventStore,
  accountId: DEFAULT_ACCOUNT_ID,
});

registerPwaAuthRoutes(app, {
  pwaAccessTokens,
  linkedSessions,
  checkRateLimit,
  canAdmin: hasDashboardAccess,
  loginMax: Math.min(config.dashboardLoginMax, 10),
  loginWindowMs: config.dashboardLoginWindowMs,
});
registerPwaTokenAdminRoutes(app, { pwaAccessTokens, linkedSessions });

app.get("/api/v1/pairing/diagnostics", {
  schema: {
    summary: "Recent sanitized pairing diagnostics",
    description: "Admin-only audit trail for pairing/identity/PWA recovery. IDs are hashed and credentials are never recorded.",
    tags: ["Pairing"],
    querystring: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
    },
    response: { 200: { type: "object", additionalProperties: true } },
  },
}, async (request) => activityLogStore.query({
  limit: Math.min(Math.max(Number(request.query?.limit) || 50, 1), 200),
  category: "pairing",
}));

// web-01 (§44): narrow realtime channel for the PWA — {type:"sync.available"}
// only. Auth: master token / dashboard session via requireToken (project keys
// have no meaning in the single-account control plane yet).
app.get("/api/v1/sse", {
  schema: {
    summary: "Control plane SSE — sync.available invalidation signal (§44)",
    description: [
      "Emits {type:\"sync.available\", lastEventId} whenever new events land in the encrypted event store.",
      "**Never carries message content** — clients re-pull /api/v1/sync with their cursor (durability lives there)."
    ].join("\n"),
    tags: ["Sync"],
    produces: ["text/event-stream"],
    response: { 200: { type: "string", description: "SSE stream" } }
  }
}, async (request, reply) => {
  // P0 (review): raw streaming REQUIRES explicit lifecycle hijack —
  // "return reply" alone does NOT stop Fastify from later serializing.
  reply.hijack();

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  reply.raw.write(": connected\n\n");

  if (request.linkedDevice) {
    reply._linkedToken = request.cookies[linkedSessions.COOKIE_NAME];
    const expiryCheck = setInterval(() => {
      if (!linkedSessions.resolve(reply._linkedToken)) {
        reply.raw.write('data: {"type":"device.revoked"}\n\n');
        reply.raw.end();
        controlSseClients.delete(reply);
      }
    }, 1000);
    expiryCheck.unref();
    reply.raw.on("close", () => clearInterval(expiryCheck));
  }
  controlSseClients.add(reply);
  request.raw.on("close", () => controlSseClients.delete(reply));
  return reply;
});

// ── web-01 Web Push (§45/§89, content-less wake-ups) ────────────────────────

app.get("/api/v1/push/public-key", {
  schema: {
    summary: "VAPID public key for PushSubscription (§45)",
    tags: ["Push"],
    response: { 200: { type: "object", properties: { publicKey: { type: "string" } } } }
  }
}, async () => ({ publicKey: webPushService.publicKey() }));

app.post("/api/v1/push/subscribe", {
  schema: {
    summary: "Register a Web Push subscription (§89 — bound, prunable)",
    description: "Subscription is stored keyed by a hash of the endpoint (the raw URL may contain capability tokens). Content-less pushes only — §30 default.",
    tags: ["Push"],
    body: {
      type: "object",
      required: ["endpoint", "keys"],
      properties: {
        endpoint: { type: "string" },
        keys: {
          type: "object",
          required: ["p256dh", "auth"],
          properties: { p256dh: { type: "string" }, auth: { type: "string" } }
        }
      }
    },
    response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 400: { type: "object", properties: { error: { type: "string" } } } }
  }
}, async (request, reply) => {
  try {
    webPushService.upsertSubscription({
      endpoint: request.body?.endpoint,
      keys: request.body?.keys,
      userAgent: request.headers["user-agent"],
    });
    return { ok: true };
  } catch (error) {
    reply.code(400).send({ error: error.message });
  }
});

app.post("/api/v1/push/unsubscribe", {
  schema: {
    summary: "Remove a Web Push subscription (logout/revoke, §89)",
    tags: ["Push"],
    body: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "string" } } },
    response: { 200: { type: "object", properties: { ok: { type: "boolean" }, removed: { type: "boolean" } } } }
  }
}, async (request) => ({
  ok: true,
  removed: webPushService.removeSubscription(request.body?.endpoint),
}));

app.get("/api/v1/push/subscriptions", {
  schema: {
    summary: "List push subscriptions (Privacy: endpoint hashes truncated)",
    tags: ["Push"]
  }
}, async () => ({ subscriptions: webPushService.listSubscriptions(), count: webPushService.count() }));

// ── Phase 4: Passkey (WebAuthn) auth (§21–§24) ──────────────────────────────
// Bootstrap model: the FIRST registration is allowed without an existing
// session ONLY while no credential is enrolled (first-run); afterwards,
// registration (adding a new passkey) and credential listing/removal require
// an authenticated session (Bearer, dashboard session, or passkey cookie).
// Authentication issues the SAME gmweb_session cookie the dashboard uses, so
// requireToken accepts it unchanged (§21 Passkey-first, §23 cookie-only).

function issuePasskeySession(reply, request) {
  const session = createDashboardSession(request);
  reply.header(
    "set-cookie",
    `${dashboardSessionCookieName}=${encodeURIComponent(session.sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.dashboardSessionTtlMs / 1000)}${config.dashboardCookieSecure ? "; Secure" : ""}`
  );
  return { csrfToken: session.csrfToken };
}

app.get("/api/v1/auth/status", {
  schema: {
    summary: "Passkey-first status (§21): enroll or authenticate?",
    tags: ["Auth"]
  }
}, async () => ({
  passkeyConfigured: passkeyService.hasCredentials(),
  next: passkeyService.hasCredentials() ? "authentication" : "registration", // first-run bootstrap
}));

app.get("/api/v1/auth/passkey/register/options", {
  schema: { summary: "WebAuthn registration options (§21)", tags: ["Auth"] }
}, async (request, reply) => {
  // First-run bootstrap: enrollment without auth only while the registry is
  // empty. Afterwards, hasDashboardAccess gates (requireToken already let the
  // request through, so hasDashboardAccess decides via Bearer/session).
  if (passkeyService.hasCredentials() && !hasDashboardAccess(request)) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  return passkeyService.registrationOptions();
});

app.post("/api/v1/auth/passkey/register/verify", {
  schema: { summary: "Verify attestation and enroll the credential (§22/§23)", tags: ["Auth"], body: { type: "object" } }
}, async (request, reply) => {
  if (passkeyService.hasCredentials() && !hasDashboardAccess(request)) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  try {
    const result = await passkeyService.verifyRegistration(request.body, "operator");
    const issued = issuePasskeySession(reply, request); // enroll = sign-in (§21 flow)
    return { ok: result.ok, credentialId: result.credentialId, csrfToken: issued.csrfToken };
  } catch (error) {
    reply.code(400).send({ error: error.message });
  }
});

app.get("/api/v1/auth/passkey/auth/options", {
  schema: { summary: "WebAuthn authentication options (§21)", tags: ["Auth"] }
}, async () => passkeyService.authenticationOptions());

app.post("/api/v1/auth/passkey/auth/verify", {
  schema: { summary: "Verify assertion → issue session cookie (§23)", tags: ["Auth"], body: { type: "object" } }
}, async (request, reply) => {
  try {
    const result = await passkeyService.verifyAuthentication(request.body);
    const issued = issuePasskeySession(reply, request);
    return { ok: result.ok, csrfToken: issued.csrfToken };
  } catch (error) {
    reply.code(401).send({ error: error.message });
  }
});

app.get("/api/v1/auth/credentials", {
  schema: { summary: "List enrolled passkeys (§84 Security Center)", tags: ["Auth"] }
}, async (request, reply) => {
  if (!hasDashboardAccess(request)) { reply.code(401).send({ error: "unauthorized" }); return; }
  return { credentials: passkeyService.listCredentials() };
});

app.post("/api/v1/auth/credentials/remove", {
  schema: {
    summary: "Remove an enrolled passkey (§24 step-up: authenticated session required)",
    tags: ["Auth"],
    body: { type: "object", required: ["credentialId"], properties: { credentialId: { type: "string" } } }
  }
}, async (request, reply) => {
  if (!hasDashboardAccess(request)) { reply.code(401).send({ error: "unauthorized" }); return; }
  const removed = passkeyService.removeCredential(request.body?.credentialId);
  if (!removed) { reply.code(404).send({ error: "credential_not_found" }); return; }
  // §26-adjacent honesty: if the registry is now empty, next flow is bootstrap again.
  return { ok: true, passkeyConfigured: passkeyService.hasCredentials() };
});

app.get("/ready", {
  schema: {
    summary: "Readiness check",
    description: "Returns 200 if Google Messages is paired and ready to send/receive. Returns 503 if not paired. Use this before calling `/send` to verify readiness.",
    tags: ["Session"],
    response: {
      200: { type: "object", properties: { ready: { type: "boolean" }, status: { type: "object", additionalProperties: true } } },
      503: { type: "object", properties: { ready: { type: "boolean" }, status: { type: "object", additionalProperties: true } } }
    }
  }
}, async (request, reply) => {
  // ONE source of truth (src/transportHealth.js). This route used to re-derive
  // its own liveness rule from the raw transport, which is how /ready and
  // /admin/transport could disagree. A stale pull phone is never ready here,
  // and the legacy push client can never make pull mode ready.
  const health = await transportHealth.snapshot();
  const transition = transportHealth.reportTransition(health);
  if (transition) app.log.warn({ transport: transition }, "android transport state changed");
  if (!health.ready) reply.code(503);
  return {
    ready: health.ready,
    status: {
      ...health,
      // Back-compat aliases for consumers that read the old shape.
      paired: health.ready,
      transport: health.activeTransport === "android"
        ? (health.mode === "pull" ? "android-pull" : "android")
        : "chrome"
    }
  };
});

app.post("/browser/start", {
  schema: {
    summary: "Start browser",
    description: "Launches the Playwright browser and navigates to Google Messages. **Master token only.**",
    tags: ["Admin"]
  }
}, async () => {
  requireChromeMethod("start");
  await client.start();
  return client.status();
});

app.post("/browser/stop", {
  schema: {
    summary: "Stop browser",
    description: "Gracefully closes the Playwright browser context. **Master token only.**",
    tags: ["Admin"]
  }
}, async () => {
  requireChromeMethod("stop");
  await client.stop();
  return { stopped: true };
});

app.post("/browser/restart", {
  schema: {
    summary: "Restart browser",
    description: "Stops and restarts the Playwright browser. Use after pairing issues. **Master token only.**",
    tags: ["Admin"]
  }
}, async () => {
  requireChromeMethod("stop");
  requireChromeMethod("start");
  await client.stop();
  await client.start();
  return client.status();
});

app.get("/session/status", {
  schema: {
    summary: "Browser session status",
    description: "Returns detailed browser and pairing state including URL, QR visibility, and pairing hint. **Master token only.**",
    tags: ["Session"]
  }
}, async () => client.status());

app.get("/session/screenshot", {
  schema: {
    summary: "Browser screenshot",
    description: "Returns a full-page PNG screenshot of the current browser state. Useful for debugging pairing issues. **Master token only.**",
    tags: ["Session"],
    produces: ["image/png"],
    response: { 200: { type: "string", format: "binary" } }
  }
}, async (_request, reply) => {
  requireChromeMethod("screenshot");
  const image = await client.screenshot();
  reply.type("image/png").send(image);
});

app.get("/conversations", {
  schema: {
    summary: "List conversations",
    description: "Returns the most recent conversations visible in the Google Messages sidebar. Each item includes title, snippet, timestamp, unread status, and a stable `href` identifier.",
    tags: ["Conversations"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 2000, default: 20, description: "Max number of conversations to return" }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          conversations: { type: "array", items: { $ref: "Conversation#" } }
        }
      }
    }
  }
}, async (request) => {
  const limit = parseLimit(request.query.limit, 20, 2000);
  // Android transport: no Google Messages sidebar to scrape. Serve a ledger
  // derived view so dashboards/consumers keep working instead of crashing.
  if (typeof client.listConversations !== "function") {
    return { conversations: androidConversationsFromLedger(limit), source: "ledger" };
  }
  return { conversations: await client.listConversations(limit) };
});

app.get("/messages/active", {
  schema: {
    summary: "Messages in currently open conversation",
    description: "Returns messages from whichever conversation the browser currently has open. Faster than `/conversations/messages` since it skips navigation. Use after `/conversations/open`.",
    tags: ["Conversations"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Max messages to return (most recent)" }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          messages: { type: "array", items: { $ref: "Message#" } }
        }
      }
    }
  }
}, async (request) => {
  const limit = parseLimit(request.query.limit, 50, 200);
  requireChromeMethod("getActiveConversationMessages");
  return { messages: await client.getActiveConversationMessages(limit) };
});

app.post("/conversations/open", {
  schema: {
    summary: "Open a conversation",
    description: "Navigates the browser to a specific conversation. Provide exactly one of: `href` (recommended — stable identifier from `/conversations`), `id`, `title`, or `index`.",
    tags: ["Conversations"],
    body: {
      type: "object",
      properties: {
        href: { type: "string", description: "Conversation path e.g. `/web/conversations/1234`. Most reliable identifier." },
        id: { type: "string", description: "Conversation ID (same as href in most cases)" },
        title: { type: "string", description: "Contact name (fuzzy matched)" },
        index: { type: "integer", minimum: 0, description: "Zero-based position in conversation list" }
      }
    }
  }
}, async (request, reply) => {
  const schema = z.object({
    id: z.string().optional(),
    href: z.string().optional(),
    title: z.string().optional(),
    index: z.number().int().nonnegative().optional()
  }).refine((body) => body.id || body.href || body.title || Number.isInteger(body.index), {
    message: "Provide one of: id, href, title, index"
  });

  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  return client.openConversation(parsed.data);
});

app.post("/conversations/messages", {
  schema: {
    summary: "Get conversation messages",
    description: "Opens the specified conversation and returns its messages. Slower than `/messages/active` because it navigates the browser. Returns both message bubbles and timestamps in order.",
    tags: ["Conversations"],
    body: {
      type: "object",
      properties: {
        href: { type: "string", description: "Conversation path from `/conversations` response. Use this for reliability." },
        id: { type: "string" },
        title: { type: "string" },
        index: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Max messages to return" }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          conversation: { $ref: "Conversation#" },
          messages: { type: "array", items: { $ref: "Message#" } }
        }
      }
    }
  }
}, async (request, reply) => {
  const schema = z.object({
    id: z.string().optional(),
    href: z.string().optional(),
    title: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(200).optional()
  }).refine((body) => body.id || body.href || body.title || Number.isInteger(body.index), {
    message: "Provide one of: id, href, title, index"
  });

  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  const { limit = 50, ...query } = parsed.data;
  // Android transport: resolve the thread from the durable send ledger keyed
  // by the phone number carried in href/id/title.
  if (typeof client.getConversationMessages !== "function") {
    const number = query.href || query.id || query.title || "";
    return androidThreadFromLedger(number, limit);
  }
  return client.getConversationMessages(query, limit);
});

if (config.enableDebugRoutes) {
  app.get("/debug/sidebar", async (request) => {
    requireChromeMethod("debugSidebarElements");
    const limit = parseLimit(request.query.limit, 80, 300);
    return {
      elements: await client.debugSidebarElements(limit)
    };
  });

  app.get("/debug/main", async (request) => {
    requireChromeMethod("debugMainElements");
    const limit = parseLimit(request.query.limit, 120, 500);
    return {
      elements: await client.debugMainElements(limit)
    };
  });
}

app.post("/send", {
  schema: {
    summary: "Send a message (queued)",
    description: [
      "Queue an SMS/RCS message for delivery via Google Messages.",
      "",
      "**Asynchronous by default.** The message is added to a durable Redis-backed",
      "queue and processed in the background by a single worker (one browser, one",
      "send at a time). The endpoint returns a stable `requestId` plus the current",
      "BullMQ `jobId` immediately with HTTP 202.",
      "",
      "**Track delivery via:**",
      "- `GET /send/status/{requestId}` — poll durable status, stage, result, and timestamps",
      "  (`jobId` is also accepted for backwards compatibility)",
      "- `POST /send/cancel/{requestId}` — cancel before the worker starts sending",
    "- `POST /send/invalidate` — revoke every not-yet-started reminder for one service after a renewal",
      "- `GET /events` (SSE) — real-time `send_processing` / `send_completed` / `send_failed` / `send_cancelled`",
      "",
      "**Retries:** failed sends retry up to 3 times with exponential backoff.",
      "",
      "**Synchronous mode:** pass `\"wait\": true` to block until the send finishes",
      "(up to 90s) and receive the result directly. Use only for low-volume callers.",
      "",
      "**Priority lanes:** use `critical` (purchase/renewal), `expired` (already expired),",
      "`expiring` (near expiry; default), or `announcement` (bulk/lowest). Lower numeric",
      "levels run first and every lane remains FIFO. Legacy `high` maps to `critical`;",
      "legacy `normal` maps to `expiring`.",
      "",
      "**Quiet hours:** non-critical messages are held from 02:00 through 07:59",
      "`Asia/Tehran` and released at 08:00. Delayed retries are also held even when",
      "CRITICAL; only a fresh critical first attempt bypasses quiet hours.",
      "Announcements are capped at the configured pending capacity (default 200).",
      "",
      "**Rate limits (project keys):** configurable per-minute and per-hour (default 30/min, 1000/hr).",
      "",
      "**Phone format:** include country code, e.g. `+989121234567`.",
      "",
      "**Auto de-dupe:** an identical `{to,text}` re-sent within ~120s (no Idempotency-Key needed) is suppressed and returns `status:\"duplicate_suppressed\"` with the original `jobId` — guards against accidental double-posting."
    ].join("\n"),
    tags: ["Messaging"],
    body: {
      type: "object",
      required: ["to", "text"],
      properties: {
        to: { type: "string", minLength: 3, maxLength: 32, description: "Recipient phone number with country code, e.g. `+989121234567`" },
        text: { type: "string", minLength: 1, maxLength: 4000, description: "Message content. Plain text only." },
        wait: { type: "boolean", default: false, description: "If true, block until the send completes (max 90s) and return the result." },
        priority: {
          oneOf: [
            { type: "string", enum: ["critical", "expired", "expiring", "announcement", "high", "normal"] },
            { type: "integer", minimum: 1, maximum: 10 }
          ],
          description: "Priority lane: `critical`=1, `expired`=3, `expiring`=6 (default), `announcement`=10. FIFO within a lane. Legacy `high` and `normal`, plus numeric 1-10, remain accepted. Only a fresh critical attempt bypasses quiet hours."
        }
      },
      examples: [{ to: "+989121234567", text: "تمدید شد", priority: "critical" }]
    },
    headers: {
      type: "object",
      properties: {
        "idempotency-key": {
          type: "string",
          description: "Optional. A unique id for this send. Retrying with the same key returns the original `jobId` instead of sending a duplicate (kept 24h). Reusing a key with a different `to`/`text` returns 409."
        }
      }
    },
    response: {
      202: {
        type: "object",
        description: "Message accepted and queued",
        properties: {
          ok: { type: "boolean" },
          requestId: { type: ["string", "null"], description: "Stable send request id. Use this value for status polling even if retries replace the queue job." },
          statusUrl: { type: ["string", "null"] },
          jobId: { type: "string" },
          status: { type: "string", enum: ["queued", "deferred"] },
          priority: { type: "string", enum: ["critical", "expired", "expiring", "announcement"] },
          priorityLevel: { type: "integer", enum: [1, 3, 6, 10] },
          deduped: { type: "boolean", description: "True if this returned an existing job for a repeated Idempotency-Key." },
          queuePosition: { type: "integer", description: "Approximate active and same-or-higher-priority jobs ahead." },
          reason: { type: "string" },
          releaseAt: { type: ["string", "null"] },
          timeZone: { type: "string" },
          releaseAfterSuccesses: { type: "integer" }
        }
      },
      409: {
        type: "object",
        description: "Idempotency-Key reused with different content",
        properties: {
          error: { type: "string", enum: ["idempotency_key_reused"] },
          message: { type: "string" }
        }
      },
      200: {
        type: "object",
        description: "Returned when wait=true and the send succeeded, for a deduped Idempotency-Key whose job already completed, or when an identical {to,text} was suppressed within the dedupe window (`duplicate_suppressed`).",
        properties: {
          ok: { type: "boolean" },
          requestId: { type: ["string", "null"] },
          statusUrl: { type: ["string", "null"] },
          jobId: { type: ["string", "null"] },
          status: { type: "string", enum: ["completed", "duplicate_suppressed", "unverified", "cancelled", "failed", "superseded"] },
          reason: { type: "string", enum: ["duplicate_suppressed", "duplicate_inflight"], description: "Why a send was suppressed: already sent within the window, or still in flight." },
          deduped: { type: "boolean" },
          // Lifecycle invalidation result: terminal, NOT successful, NOT
          // billable and NOT retryable. Declared here because Fastify's response
          // schema strips anything undeclared.
          state: { type: "string", enum: ["superseded"] },
          superseded: { type: "boolean" },
          terminal: { type: "boolean" },
          successful: { type: "boolean" },
          retryable: { type: "boolean" },
          counted: { type: "boolean" },
          priority: { type: "string", enum: ["critical", "expired", "expiring", "announcement"] },
          priorityLevel: { type: "integer", enum: [1, 3, 6, 10] },
          result: { type: "object" }
        }
      },
      429: {
        type: "object",
        properties: {
          error: { type: "string", enum: ["send_rate_limited", "announcement_queue_full"] },
          reason: { type: "string", enum: ["per_minute_limit", "per_hour_limit"] },
          limits: { type: "object", properties: { minute: { type: "integer" }, hour: { type: "integer" } } },
          used: { type: "object", properties: { minute: { type: "integer" }, hour: { type: "integer" } } },
          priority: { type: "string" },
          priorityLevel: { type: "integer" },
          limit: { type: "integer" },
          pending: { type: "integer" },
          available: { type: "integer" },
          retryAfterSeconds: { type: "integer" }
        }
      },
      502: {
        type: "object",
        description: "Returned only when wait=true and the send failed",
        properties: {
          ok: { type: "boolean" },
          requestId: { type: ["string", "null"] },
          statusUrl: { type: ["string", "null"] },
          jobId: { type: "string" },
          status: { type: "string", enum: ["failed"] },
          priority: { type: "string", enum: ["critical", "expired", "expiring", "announcement"] },
          priorityLevel: { type: "integer", enum: [1, 3, 6, 10] },
          error: { type: "string" }
        }
      },
      503: {
        type: "object",
        description: "Returned when the global send power is off (poweroff). No message is sent.",
        properties: {
          error: { type: "string", enum: ["powered_off"] },
          message: { type: "string" }
        }
      }
    }
  }
}, async (request, reply) => {
  // Global kill switch: when the send power is off, refuse every message — no
  // matter the priority, key, idempotency, or remaining capacity. Nothing is
  // queued, so nothing can be sent until a power-on is issued.
  if (!sendPowerOn) {
    reply.code(503).send({ error: "powered_off", message: "Sending is powered off. No messages will be sent until power-on." });
    return;
  }

  // Active transport: the phone is the only delivery path in android mode.
  // Pull mode: the phone connects to US, so "ready" means a device has an
  // active long-poll; push mode probes the phone directly. Fail closed with
  // 503 like powered_off so Eve treats it as "retry later", never an error.
  if (client.name === "android") {
    let phone;
    if (client.pullMode && client.outbox) {
      phone = client.outbox.readyState();
    } else {
      phone = await client.readyState();
    }
    if (!phone.paired) {
      reply.code(503).send({ error: "android_gateway_unreachable", message: "No Android gateway device is connected (pull) or reachable (push). No messages will be queued until a device checks in." });
      return;
    }
  }

  // Per-project rate limit (only applies to project API keys, not master)
  const projectKey = request._projectKey;
  if (projectKey) {
    const rate = apiKeyStore.checkSendRate(projectKey.id);
    if (!rate.allowed) {
      reply.header("retry-after", "60");
      reply.code(429).send({
        error: "send_rate_limited",
        reason: rate.reason,
        limits: rate.limits,
        used: { minute: rate.minuteUsed, hour: rate.hourUsed }
      });
      return;
    }
  }

  const schema = z.object({
    to: z.string().min(3).max(32),
    text: z.string().min(1).max(4000),
    wait: z.boolean().optional(),
    priority: z.union([
      z.enum([...PRIORITY_NAMES, "high", "normal"]),
      z.number().int().min(1).max(10)
    ]).optional(),
    // Consumer notification identity. Eve attaches it to every notification so a
    // later lifecycle change can invalidate exactly this service's outstanding
    // reminders. Unknown keys are ignored and every value is bounded by
    // normalizeNotificationMeta before it touches the ledger.
    meta: z.object({
      source: z.string().max(32).optional(),
      serviceKey: z.string().max(200).optional(),
      notificationKind: z.string().max(48).optional(),
      generation: z.number().int().min(0).optional(),
      correlationId: z.string().max(64).optional(),
      requiresValidation: z.boolean().optional()
    }).partial().optional()
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const { to, text, wait, priority, meta } = parsed.data;
  // Optional consumer notification identity. No meta = the historical payload,
  // handled exactly as before. A HALF-filled tag is rejected (400) rather than
  // stored: a tag that cannot be revoked is worse than no tag at all.
  const metaCheck = validateNotificationMeta(meta);
  if (!metaCheck.ok) {
    reply.code(400).send({
      error: "invalid_meta",
      reason: metaCheck.error,
      allowedNotificationKinds: metaCheck.allowed || undefined
    });
    return;
  }
  const notificationMeta = metaCheck.meta;
  const sendPriority = normalizeSendPriority(priority);
  const enqueueOpts = { priority: sendPriority.level };

  // Idempotency: if the caller sends an `Idempotency-Key` header, dedupe retries
  // so a network blip doesn't send the SMS twice. Same key -> original jobId.
  const idemKey = String(request.headers["idempotency-key"] || "").trim().slice(0, 200) || null;
  const bodyHash = idemKey ? crypto.createHash("sha256").update(`${to}\n${text}`).digest("hex").slice(0, 16) : null;
  if (idemKey) {
    const reserved = await sendQueue.reserveIdempotency(idemKey, bodyHash).catch(() => "OK");
    if (reserved !== "OK") {
      // Duplicate. Wait briefly if the first request is still reserving, then
      // return the original job (or 409 if the key was reused with new content).
      let rec = await sendQueue.getIdempotency(idemKey);
      for (let i = 0; i < 20 && rec && rec.pending; i++) {
        await new Promise((r) => setTimeout(r, 100));
        rec = await sendQueue.getIdempotency(idemKey);
      }
      if (rec && rec.bodyHash !== bodyHash) {
        reply.code(409).send({ error: "idempotency_key_reused", message: "This Idempotency-Key was already used with a different to/text." });
        return;
      }
      if (rec && rec.jobId) {
        const st = await sendQueue.jobStatus(rec.jobId).catch(() => null);
        const ledger = sendStore.byJob(rec.jobId);
        const duplicateStatus =
          ledger?.status === "unverified" ? "unverified" :
          ledger?.status === "cancelled" ? "cancelled" :
          ledger?.status === "failed" || st?.state === "failed" ? "failed" :
          ledger?.status === "sent" || (!ledger && st?.state === "completed") ? "completed" :
          "queued";
        reply.code(duplicateStatus === "queued" ? 202 : 200);
        const originalPriority = normalizeSendPriority(ledger?.priority || sendPriority.name);
        return {
          ok: true,
          requestId: ledger ? sendStore.requestId(ledger.id) : null,
          statusUrl: ledger ? `/send/status/${sendStore.requestId(ledger.id)}` : null,
          jobId: rec.jobId,
          status: duplicateStatus,
          priority: originalPriority.name,
          priorityLevel: originalPriority.level,
          deduped: true
        };
      }
      // Original job expired/purged — re-reserve and fall through to send fresh.
      await sendQueue.reserveIdempotency(idemKey, bodyHash).catch(() => {});
    }
  }

  // Capacity is checked after Idempotency-Key lookup so a retry of an already
  // accepted announcement still returns the original request instead of 429.
  if (sendPriority.name === "announcement") {
    const pending = await sendQueue.countPendingByPriority("announcement");
    if (pending >= ANNOUNCEMENT_PENDING_LIMIT) {
      if (idemKey) await sendQueue.releaseIdempotency(idemKey).catch(() => {});
      reply.header("retry-after", "60");
      reply.code(429).send({
        error: "announcement_queue_full",
        message: "Announcement capacity is full; keep the remaining campaign rows in Eve and retry later.",
        priority: "announcement",
        priorityLevel: PRIORITY_LEVELS.announcement,
        limit: ANNOUNCEMENT_PENDING_LIMIT,
        pending,
        available: 0,
        retryAfterSeconds: 60
      });
      return;
    }
  }

  // Durable 24h de-dupe + status ledger (skipped when an explicit Idempotency-Key
  // is used — that path dedupes its own way). Atomically claims the {to,text}:
  // if an identical message was already sent within the window, or is still in
  // flight, suppress it instead of sending again.
  let ledgerId = null;
  if (!idemKey) {
    const claim = sendStore.claim({
      to, text, keyName: projectKey?.name || "master",
      priority: sendPriority.name, windowMs: SEND_DEDUPE_MS,
      notification: notificationMeta
    });
    if (claim.action !== "new") {
      app.log.warn({ to, reason: claim.action }, "duplicate send suppressed by ledger");
      reply.code(200);
      return {
        ok: true,
        requestId: sendStore.requestId(claim.row.id),
        statusUrl: `/send/status/${sendStore.requestId(claim.row.id)}`,
        jobId: claim.row.job_id || null,
        status: "duplicate_suppressed",
        reason: claim.action,           // duplicate_suppressed | duplicate_inflight
        deduped: true,
        priority: normalizeSendPriority(claim.row.priority).name,
        priorityLevel: normalizeSendPriority(claim.row.priority).level
      };
    }
    ledgerId = claim.id;
  } else {
    ledgerId = sendStore.create({
      to, text, keyName: projectKey?.name || "master",
      priority: sendPriority.name, idempotencyKey: idemKey,
      notification: notificationMeta
    });
  }
  const requestId = sendStore.requestId(ledgerId);

  let job;
  try {
    job = await sendQueue.enqueue(
      {
        to,
        text,
        keyId: projectKey?.id || null,
        keyName: projectKey?.name || "master",
        priority: sendPriority.name,
        priorityLevel: sendPriority.level,
        _ledgerId: ledgerId,
        _idempotencyKey: idemKey,
        _bodyHash: bodyHash
      },
      enqueueOpts
    );
  } catch (error) {
    if (idemKey) await sendQueue.releaseIdempotency(idemKey);
    if (ledgerId) sendStore.markById(ledgerId, "failed", error.message);
    throw error;
  }
  if (idemKey) await sendQueue.setIdempotencyJob(idemKey, job.id, bodyHash).catch(() => {});
  if (ledgerId) sendStore.attachJob(ledgerId, job.id);
  // The notification identity was written in the SAME transaction as the
  // ledger claim above, so an invalidation that races this request sees a row
  // that is already taggable -- there is no untagged window to slip through.
  emitSse({
    type: "send_queued", requestId, jobId: job.id, to,
    priority: sendPriority.name, priorityLevel: sendPriority.level,
    at: new Date().toISOString()
  });

  if (wait) {
    try {
      const result = await sendQueue.waitForJob(job, 90000);
      if (result?.deferred) {
        reply.code(202);
        return {
          ok: true,
          requestId,
          statusUrl: `/send/status/${requestId}`,
          jobId: result.deferredJobId,
          status: "deferred",
          priority: result.priority,
          priorityLevel: normalizeSendPriority(result.priority).level,
          reason: result.reason,
          releaseAt: result.releaseAt,
          timeZone: result.timeZone,
          releaseAfterSuccesses: result.releaseAfterSuccesses
        };
      }
      if (result?.unverified) {
        return {
          ok: false, requestId, statusUrl: `/send/status/${requestId}`,
          jobId: job.id, status: "unverified", priority: sendPriority.name, priorityLevel: sendPriority.level, result
        };
      }
      if (result?.superseded) {
        // A lifecycle invalidation won the race with this very request: the
        // customer renewed before the reminder left. Terminal, NOT successful,
        // NOT billable, NOT retryable -- reporting it as "completed" would be a
        // lie the consumer could act on.
        return {
          ok: false, requestId, statusUrl: `/send/status/${requestId}`,
          jobId: job.id, status: "superseded", state: "superseded",
          terminal: true, successful: false, superseded: true,
          retryable: false, counted: false, reason: result.reason || null,
          priority: sendPriority.name, priorityLevel: sendPriority.level, result
        };
      }
      if (result?.cancelled) {
        return {
          ok: false, requestId, statusUrl: `/send/status/${requestId}`,
          jobId: job.id, status: "cancelled", priority: sendPriority.name, priorityLevel: sendPriority.level, result
        };
      }
      if (result?.terminalFailure) {
        reply.code(502);
        return {
          ok: false, requestId, statusUrl: `/send/status/${requestId}`,
          jobId: job.id, status: "failed", priority: sendPriority.name, priorityLevel: sendPriority.level, error: result.error
        };
      }
      return { ok: true, requestId, statusUrl: `/send/status/${requestId}`, jobId: job.id, status: "completed", priority: sendPriority.name, priorityLevel: sendPriority.level, result };
    } catch (error) {
      reply.code(502).send({ ok: false, requestId, statusUrl: `/send/status/${requestId}`, jobId: job.id, status: "failed", priority: sendPriority.name, priorityLevel: sendPriority.level, error: error.message });
      return;
    }
  }

  const queuePosition = await sendQueue.queuePositionForPriority(sendPriority.name, job.id).catch(() => 0);
  reply.code(202);
  return {
    ok: true,
    requestId,
    statusUrl: `/send/status/${requestId}`,
    jobId: job.id,
    status: "queued",
    priority: sendPriority.name,
    priorityLevel: sendPriority.level,
    queuePosition
  };
});

app.get("/send/status/:reference", {
  schema: {
    summary: "Get durable send request status",
    description: "Poll with the stable `requestId` returned by `POST /send` (recommended), or a BullMQ `jobId` for backwards compatibility. Returns the durable delivery status, granular browser stage, final result/error, and ISO-8601 timestamps. The request remains queryable after retries replace the queue job or Redis prunes it.",
    tags: ["Messaging"],
    params: {
      type: "object",
      required: ["reference"],
      properties: { reference: { type: "string", description: "Stable requestId (`send_123`) or current jobId" } }
    },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          requestId: { type: ["string", "null"] },
          jobId: { type: ["string", "null"] },
          id: { type: ["string", "null"], description: "Backwards-compatible alias of jobId" },
          state: { type: "string", enum: ["waiting", "active", "completed", "failed", "delayed", "unverified", "cancelled", "suppressed", "superseded", "revoked"] },
          status: { type: "string", enum: ["queued", "active", "sent", "unverified", "failed", "cancelled", "suppressed", "superseded"] },
          superseded: { type: "boolean", description: "True when a lifecycle invalidation made this notification stale (terminal, not billable, never retried)." },
          revoked: { type: "boolean", description: "True while a revocation is recorded but the task has not finished standing down yet." },
          outcome: { type: ["string", "null"], description: "sent | superseded | cancelled | null" },
          revokedAt: { type: ["string", "null"] },
          revocationReason: { type: ["string", "null"], description: "Consumer reason carried by POST /send/invalidate (for example \"renewed\")." },
          serviceKey: { type: ["string", "null"] },
          notificationKind: { type: ["string", "null"] },
          generation: { type: ["integer", "null"] },
          requiresValidation: { type: "boolean" },
          correlationId: { type: ["string", "null"] },
          priority: { type: "string", enum: ["critical", "expired", "expiring", "announcement"] },
          priorityLevel: { type: "integer", enum: [1, 3, 6, 10] },
          stage: { type: ["string", "null"] },
          terminal: { type: "boolean" },
          successful: { type: ["boolean", "null"] },
          to: { type: "string" },
          requestedTo: { type: "string", description: "Phone number requested by the API caller." },
          sentTo: { type: ["string", "null"], description: "Recipient number verified in Google Messages before Enter was pressed." },
          recipientEvidence: { type: ["object", "null"], description: "How the active conversation was matched to sentTo." },
          conversationUrl: { type: ["string", "null"] },
          submittedOnce: { type: "boolean", description: "True only after Enter was pressed once." },
          submittedAt: { type: ["string", "null"] },
          verificationStatus: { type: ["string", "null"], description: "confirmed_initial, confirmed_after_recheck, or manual_review_required." },
          verificationAttempts: { type: "integer", description: "DOM confirmation checks; these never resend the message." },
          attemptsMade: { type: "integer" },
          maxAttempts: { type: "integer" },
          result: { type: ["object", "null"] },
          failedReason: { type: ["string", "null"] },
          currentAt: { type: ["string", "null"] },
          createdAt: { type: ["string", "null"] },
          queuedAt: { type: ["string", "null"] },
          activeAt: { type: ["string", "null"] },
          stageAt: { type: ["string", "null"] },
          updatedAt: { type: ["string", "null"] },
          processedAt: { type: ["string", "null"] },
          finishedAt: { type: ["string", "null"] },
          sentAt: { type: ["string", "null"] },
          timeline: {
            type: "array",
            items: {
              type: "object",
              properties: {
                status: { type: "string" },
                stage: { type: ["string", "null"] },
                at: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
}, async (request, reply) => {
  const reference = request.params.reference;
  const ledger = sendStore.byReference(reference);
  // Project keys can only inspect sends created by that same project. The
  // master token retains access to every request.
  if (request._projectKey && (!ledger || ledger.key_name !== request._projectKey.name)) {
    reply.code(404).send({ error: "not_found" });
    return;
  }

  const liveJobId = ledger?.job_id || reference;
  const live = await sendQueue.jobStatus(liveJobId).catch(() => null);
  if (!ledger && !live) { reply.code(404).send({ error: "not_found" }); return; }
  if (!ledger) {
    const legacyStatus = {
      waiting: "queued", delayed: "queued", active: "active",
      completed: "sent", failed: "failed"
    }[live.state] || "queued";
    const legacyTerminal = ["completed", "failed"].includes(live.state);
    return {
      ok: true, requestId: null, jobId: live.id, ...live,
      status: legacyStatus,
      stage: null,
      terminal: legacyTerminal,
      successful: live.state === "completed" ? true : (legacyTerminal ? false : null),
      currentAt: live.finishedAt || live.processedAt || live.createdAt,
      queuedAt: live.createdAt,
      activeAt: live.processedAt,
      stageAt: null,
      updatedAt: live.finishedAt || live.processedAt || live.createdAt,
      sentAt: live.state === "completed" ? live.finishedAt : null,
      timeline: []
    };
  }

  const iso = (value) => value ? new Date(Number(value)).toISOString() : null;
  let result = live?.result || null;
  if (ledger.result_json) {
    try { result = JSON.parse(ledger.result_json); } catch { result = { value: ledger.result_json }; }
  }
  const submission = result?.submission || result || {};
  const ledgerPriority = normalizeSendPriority(ledger.priority);
  // A revoked row may still be 'active' for a moment: the tombstone is written
  // first and the task finishes standing down after (superseded ACK or lease).
  const revoked = Boolean(ledger.revoked_at);
  const superseded = ledger.status === "superseded" || revoked || sendStore.isSuperseded(ledger);
  const terminal = superseded
    ? ledger.status === "superseded"
    : ["sent", "unverified", "failed", "cancelled", "suppressed"].includes(ledger.status);
  const fallbackState = {
    queued: "waiting", active: "active", sent: "completed", failed: "failed",
    unverified: "unverified", cancelled: "cancelled", suppressed: "suppressed",
    superseded: "superseded"
  }[ledger.status] || "waiting";
  const timeline = [
    ledger.queued_at && { status: "queued", stage: null, at: iso(ledger.queued_at) },
    ledger.active_at && { status: "active", stage: null, at: iso(ledger.active_at) },
    ledger.stage_at && { status: ledger.status, stage: ledger.stage || null, at: iso(ledger.stage_at) },
    ledger.finished_at && { status: ledger.status, stage: ledger.stage || null, at: iso(ledger.finished_at) }
  ].filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));

  return {
    ok: true,
    requestId: sendStore.requestId(ledger.id),
    jobId: ledger.job_id || live?.id || null,
    id: ledger.job_id || live?.id || null,
    state: superseded && !revoked ? "superseded" : (live?.state || fallbackState),
    status: ledger.status,
    priority: ledgerPriority.name,
    priorityLevel: ledgerPriority.level,
    stage: ledger.stage || null,
    terminal,
    successful: ledger.status === "sent" ? true : (terminal ? false : null),
    superseded,
    revoked,
    outcome: superseded ? "superseded"
      : (ledger.status === "sent" ? "sent" : (ledger.status === "cancelled" ? "cancelled" : null)),
    revokedAt: iso(ledger.revoked_at),
    revocationReason: ledger.revocation_reason || null,
    serviceKey: ledger.service_key || null,
    notificationKind: ledger.notification_kind || null,
    generation: ledger.notification_generation ?? null,
    requiresValidation: Boolean(ledger.requires_validation),
    correlationId: ledger.correlation_id || null,
    to: ledger.to_number,
    requestedTo: result?.requestedTo || ledger.to_number,
    sentTo: result?.sentTo || null,
    recipientEvidence: result?.recipientEvidence || null,
    conversationUrl: result?.conversationUrl || null,
    submittedOnce: Boolean(submission.submittedOnce),
    submittedAt: submission.submittedAt || null,
    verificationStatus: submission.verificationStatus || null,
    verificationAttempts: Number(submission.verificationAttempts || 0),
    attemptsMade: Math.max(Number(ledger.attempts || 0), Number(live?.attemptsMade || 0)),
    maxAttempts: live?.maxAttempts || 3,
    result,
    failedReason: ledger.error || live?.failedReason || null,
    currentAt: iso(ledger.finished_at || ledger.stage_at || ledger.updated_at),
    createdAt: iso(ledger.created_at),
    queuedAt: iso(ledger.queued_at),
    activeAt: iso(ledger.active_at),
    stageAt: iso(ledger.stage_at),
    updatedAt: iso(ledger.updated_at),
    processedAt: live?.processedAt || iso(ledger.active_at),
    finishedAt: live?.finishedAt || iso(ledger.finished_at),
    sentAt: iso(ledger.sent_at),
    timeline
  };
});

app.get("/send/capacity", {
  schema: {
    summary: "Get send-lane capacity",
    description: "Returns pending counts for all priority lanes and the remaining announcement slots. Eve should use `announcement.available` to bound each feeder batch. Authenticated API keys may call this endpoint.",
    tags: ["Messaging"],
    response: {
      200: {
        type: "object",
        properties: {
          priorities: {
            type: "object",
            properties: {
              critical: { type: "integer" },
              expired: { type: "integer" },
              expiring: { type: "integer" },
              announcement: { type: "integer" }
            }
          },
          announcement: {
            type: "object",
            properties: {
              limit: { type: "integer" },
              pending: { type: "integer" },
              available: { type: "integer" },
              recommendedBatchSize: { type: "integer" }
            }
          }
        }
      }
    }
  }
}, async () => {
  const priorities = await sendQueue.pendingCountsByPriority();
  const pending = priorities.announcement || 0;
  const available = Math.max(0, ANNOUNCEMENT_PENDING_LIMIT - pending);
  // Same readiness truth as /ready and /admin/transport (additive: the capacity
  // contract itself is unchanged, so existing feeders keep working).
  const health = await transportHealth.snapshot();
  return {
    priorities,
    announcement: {
      limit: ANNOUNCEMENT_PENDING_LIMIT,
      pending,
      available,
      recommendedBatchSize: Math.min(available, 50)
    },
    ready: health.ready,
    transport: {
      activeTransport: health.activeTransport,
      mode: health.mode,
      state: health.state,
      reason: health.reason
    }
  };
});

/**
 * One cancel decision for a reference, shared by POST /send/cancel/:reference
 * and POST /send/invalidate. The state machine itself lives in
 * src/sendRevocation.js: it owns the durable tombstone, the generation barrier
 * and the Android bridge hand-off, so cancel and invalidate can never diverge.
 *
 * Project-key isolation stays in the routes: this helper never widens what a
 * key may reach, it only centralizes the state machine so both endpoints make
 * the same decision.
 */
async function cancelOne(reference, options) {
  return sendRevocation.cancelOne(reference, options);
}

app.post("/send/cancel/:reference", {
  schema: {
    summary: "Cancel a queued send request",
    description: [
      "Cancels a send that has not started yet. Pass the stable `requestId`",
      "returned by `POST /send` (recommended), or the current BullMQ `jobId`",
      "for backwards compatibility. Project API keys can cancel only their own",
      "send requests. Pending jobs are removed immediately. For an active job,",
      "the browser operation is signalled to stop before any further Enter press."
    ].join(" "),
    tags: ["Messaging"],
    params: {
      type: "object",
      required: ["reference"],
      properties: {
        reference: { type: "string", description: "Stable requestId (`send_123`) or current jobId" }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          requestId: { type: ["string", "null"] },
          statusUrl: { type: ["string", "null"] },
          jobId: { type: ["string", "null"] },
          status: { type: "string", enum: ["cancelled"] },
          state: { type: "string", enum: ["cancelled"] },
          cancelled: { type: "boolean" },
          alreadyCancelled: { type: "boolean" },
          cancelledFromState: { type: ["string", "null"] },
          terminal: { type: "boolean" }
        }
      },
      404: {
        type: "object",
        properties: { error: { type: "string", enum: ["not_found"] } }
      },
      409: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          error: { type: "string", enum: ["not_cancellable"] },
          reason: {
            type: "string",
            enum: ["already_active", "already_terminal", "not_pending", "not_found", "queue_remove_failed"]
          },
          requestId: { type: ["string", "null"] },
          statusUrl: { type: ["string", "null"] },
          jobId: { type: ["string", "null"] },
          status: { type: ["string", "null"] },
          state: { type: ["string", "null"] }
        }
      }
    }
  }
}, async (request, reply) => {
  const reference = request.params.reference;
  // Project keys can cancel only sends created by that same project. Return
  // 404 instead of 403 so one project cannot probe another project's ids.
  if (request._projectKey) {
    const owned = sendStore.byReference(reference);
    if (!owned || owned.key_name !== request._projectKey.name) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
  }
  const decision = await cancelOne(reference);
  reply.code(decision.statusCode).send(decision.body);
});


/**
 * Lifecycle invalidation for consumer-managed notifications.
 *
 * Eve tags every depletion reminder with {source, serviceKey, notificationKind,
 * generation}. When a customer renews, Eve advances the service generation and
 * calls this endpoint; every outstanding reminder for that service key that has
 * not started yet is cancelled, and one that is already in flight is signalled
 * to stop. Transactional confirmations (created / renew) carry
 * requiresValidation:false and are therefore never matched.
 *
 * The request is idempotent on eventId: a retry after a lost response replays
 * the original answer instead of cancelling a second time. The per-service
 * generation watermark is monotonic, so a delayed invalidation that carries an
 * OLD generation can never cancel a reminder that belongs to a NEWER lifecycle.
 */
app.post("/send/invalidate", {
  schema: {
    summary: "Invalidate outstanding notifications for a service",
    description: [
      "Cancels every not-yet-started send that carries the matching",
      "`meta.source` + `meta.serviceKey`, optionally narrowed to",
      "`invalidateKinds`. Sends already started are revoked, not deleted.",
      "Idempotent on `eventId`. A `currentGeneration` lower than the",
      "watermark this gateway already recorded is refused with 409."
    ].join(" "),
    tags: ["Messaging"],
    body: {
      type: "object",
      required: ["source", "serviceKey"],
      properties: {
        source: { type: "string", minLength: 1, maxLength: 32 },
        serviceKey: { type: "string", minLength: 3, maxLength: 200 },
        currentGeneration: { type: "integer", minimum: 0 },
        invalidateKinds: {
          type: "array",
          maxItems: 16,
          items: { type: "string", maxLength: 48 }
        },
        reason: { type: "string", maxLength: 64 },
        correlationId: { type: "string", maxLength: 64 },
        eventId: { type: "string", maxLength: 200 }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          source: { type: "string" },
          serviceKey: { type: "string" },
          currentGeneration: { type: ["integer", "null"] },
          cancelledPending: { type: "integer" },
          revokedActive: { type: "integer" },
          revokedInflight: { type: "integer" },
          alreadyTerminal: { type: "integer" },
          matched: { type: "integer" },
          reason: { type: ["string", "null"] },
          correlationId: { type: ["string", "null"] },
          eventId: { type: ["string", "null"] },
          replayed: { type: "boolean" }
        }
      },
      409: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          error: {
            type: "string",
            enum: ["stale_generation", "invalidate_generation_busy"]
          },
          serviceKey: { type: "string" },
          currentGeneration: { type: ["integer", "null"] },
          receivedGeneration: { type: ["integer", "null"] },
          correlationId: { type: ["string", "null"] }
        }
      }
    }
  }
}, async (request, reply) => {
  const schema = z.object({
    source: z.string().min(1).max(32),
    serviceKey: z.string().min(3).max(200),
    currentGeneration: z.number().int().min(0).max(2147483647).optional(),
    invalidateKinds: z.array(z.string().min(1).max(48)).max(16).optional(),
    reason: z.string().max(64).optional(),
    correlationId: z.string().max(64).optional(),
    eventId: z.string().max(200).optional()
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const source = normalizeNotificationMeta(parsed.data).source;
  const serviceKey = String(parsed.data.serviceKey).trim().slice(0, NOTIFICATION_TEXT_LIMITS.serviceKey);
  const projectKeyName = request._projectKey?.name || null;

  // A project key may only invalidate a service it actually owns. An
  // unguessable serviceKey is not authorization: without this check a foreign
  // caller could advance another service's generation watermark and silently
  // deny that consumer's legitimate renewals.
  if (projectKeyName && !sendStore.ownsService(source, serviceKey, projectKeyName)) {
    reply.code(404).send({ error: "not_found" });
    return;
  }

  const outcome = await sendRevocation.invalidate({
    source,
    serviceKey,
    currentGeneration: parsed.data.currentGeneration,
    invalidateKinds: parsed.data.invalidateKinds,
    reason: parsed.data.reason || null,
    correlationId: parsed.data.correlationId || null,
    eventId: parsed.data.eventId || null,
    keyName: projectKeyName
  });
  reply.code(outcome.statusCode).send(outcome.body);
});

app.get("/admin/queue", {
  schema: {
    summary: "Send queue stats",
    description: "Returns counts of jobs by state in the send queue. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          paused: { type: "boolean" },
          manualPause: { type: "boolean" },
          powerOn: { type: "boolean" },
          activeTransport: { type: "string", enum: ["chrome", "android"] },
          android: {
            type: "object",
            properties: {
              ready: { type: "boolean" },
              waitingPhones: { type: "integer" },
              lastPullAt: { type: ["string", "null"] },
              pending: { type: "integer" },
              inflight: { type: "integer" }
            }
          },
          quietHours: {
            type: "object",
            properties: {
              active: { type: "boolean" },
              timeZone: { type: "string" },
              startHour: { type: "integer" },
              endHour: { type: "integer" },
              releaseAt: { type: ["string", "null"] }
            }
          },
          // Live BullMQ state only. Declared here because Fastify's response
          // serializer STRIPS anything the schema does not mention — an
          // undeclared additive field silently disappears on the wire.
          queue: {
            type: "object",
            properties: {
              waiting: { type: "integer" },
              active: { type: "integer" },
              delayed: { type: "integer" },
              prioritized: { type: "integer" },
              paused: { type: "integer" },
              completed: { type: "integer" },
              failed: { type: "integer" }
            }
          },
          idle: { type: "boolean", description: "True when no job is waiting or active. Historical ledger failures never affect it." },
          ledger: {
            type: "object",
            properties: {
              allTime: { type: "object", additionalProperties: { type: "integer" } },
              last24h: { type: "object", additionalProperties: { type: "integer" } }
            }
          },
          transport: { type: "object", additionalProperties: true, description: "Authoritative transport snapshot (same object /admin/overview returns)." },
          counts: {
            type: "object",
            description: "Deprecated merged shape: live BullMQ counts with ledger TOTALS for sent/unverified/failed/suppressed/cancelled. New code should read `queue` and `ledger`.",
            additionalProperties: { type: "integer" }
          }
        }
      }
    }
  }
}, async () => {
  const [qc, paused, health] = await Promise.all([
    sendQueue.counts(),
    sendQueue.isPaused(),
    transportHealth.snapshot()
  ]);
  const report = buildQueueReport({
    bullmq: qc,
    ledgerAllTime: sendStore.stats(),
    ledgerLast24h: sendStore.statsSince(Date.now() - 24 * 60 * 60 * 1000)
  });
  const android = await transportHealth.android();

  return {
    paused,
    manualPause: queueManualPause,
    powerOn: sendPowerOn,
    activeTransport: health.activeTransport,
    transport: health,
    // ── additive, unambiguous blocks ────────────────────────────────────────
    // QUEUE NOW is strictly live BullMQ state; DELIVERY OUTCOMES are durable
    // ledger rows for a stated window. Nothing historical can make an idle
    // queue look busy.
    queue: report.queue,
    idle: report.idle,
    ledger: report.ledger,
    android: {
      // Authoritative: in pull mode this is the PULL BRIDGE, never the
      // direct-push client.
      ready: Boolean(android.ready),
      state: android.state,
      reason: android.reason || null,
      configured: Boolean(android.configured),
      mode: health.mode,
      waitingPhones: Number(android.waitingPhones || 0),
      lastPullAt: android.lastPullAt || null,
      lastPullAgeMs: android.lastPullAgeMs ?? null,
      livenessMs: android.livenessMs ?? null,
      pending: Number(android.pending || 0),
      inflight: Number(android.inflight || 0)
    },
    // ── legacy shape, byte-for-byte compatible (deprecated) ─────────────────
    // Older consumers read `counts.failed` as a ledger TOTAL. That stays true
    // here; new code should read `queue` and `ledger`.
    counts: report.counts,
    quietHours: currentQuietHours()
  };
});

const sendPacingSettingsSchema = {
  type: "object",
  properties: {
    maxPerMinute: { type: "integer", minimum: 1, maximum: 60 },
    randomDelayEnabled: { type: "boolean" },
    randomExtraSeconds: { type: "integer", minimum: 0, maximum: 120 },
    minimumIntervalSeconds: { type: "number" },
    maximumIntervalSeconds: { type: "number" },
    updatedAt: { type: ["string", "null"] }
  }
};

app.get("/admin/settings/send-pacing", {
  schema: {
    summary: "Get live send pacing settings",
    description: "Returns the durable global pacing settings used by the queue worker. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          version: { type: "string" },
          settings: sendPacingSettingsSchema
        }
      }
    }
  }
}, async () => ({ version: pkg.version, settings: sendPacing.snapshot() }));

app.put("/admin/settings/send-pacing", {
  schema: {
    summary: "Update live send pacing settings",
    description: "Persists and applies global queue pacing immediately, including a job currently waiting in the pacing stage. Random delay adds a uniformly random 0..N seconds between sends. **Master token only.**",
    tags: ["Admin"],
    body: {
      type: "object",
      required: ["maxPerMinute", "randomDelayEnabled", "randomExtraSeconds"],
      properties: {
        maxPerMinute: { type: "integer", minimum: 1, maximum: 60 },
        randomDelayEnabled: { type: "boolean" },
        randomExtraSeconds: { type: "integer", minimum: 0, maximum: 120 }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          appliedImmediately: { type: "boolean" },
          version: { type: "string" },
          settings: sendPacingSettingsSchema
        }
      }
    }
  }
}, async (request, reply) => {
  const parsed = z.object({
    maxPerMinute: z.number().int().min(1).max(60),
    randomDelayEnabled: z.boolean(),
    randomExtraSeconds: z.number().int().min(0).max(120)
  }).safeParse(request.body);
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const settings = await sendPacing.update(parsed.data);
  client.refreshConversationInterval();
  emitSse({ type: "send_pacing_settings_updated", settings, at: new Date().toISOString() });
  return { ok: true, appliedImmediately: true, version: pkg.version, settings };
});

app.post("/admin/queue/pause", {
  schema: {
    summary: "Pause the send queue",
    description: "Stops new send jobs from starting; the current active job, if any, is allowed to finish. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: { ok: { type: "boolean" }, paused: { type: "boolean" }, manualPause: { type: "boolean" } }
      }
    }
  }
}, async () => {
  await setManualQueuePause(true);
  emitSse({ type: "queue_paused", reason: "manual", at: new Date().toISOString() });
  return { ok: true, paused: true, manualPause: true };
});

app.post("/admin/queue/resume", {
  schema: {
    summary: "Resume the paced send queue",
    description: "Allows queued jobs to start again under the configured send pacing limits. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: { ok: { type: "boolean" }, paused: { type: "boolean" }, manualPause: { type: "boolean" } }
      }
    }
  }
}, async () => {
  await setManualQueuePause(false);
  emitSse({ type: "queue_resumed", at: new Date().toISOString() });
  return { ok: true, paused: false, manualPause: false };
});

app.post("/admin/queue/emergency-stop", {
  schema: {
    summary: "Emergency-stop delivery and cancel all pending sends",
    description: "Immediately powers sending off, persists a manual queue pause, and cancels every waiting, paused, prioritized, or delayed send. An already active send is signalled to stop before submission, but cannot be recalled if a device has already sent it. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" }, powerOn: { type: "boolean" }, paused: { type: "boolean" }, manualPause: { type: "boolean" },
          cancelled: { type: "integer" }, active: { type: "integer", description: "Jobs already active when the stop began." }
        }
      }
    }
  }
}, async () => {
  // Set the durable kill switch before enumerating jobs. No later /send call
  // may enqueue work, and the queue is paused before cancellation begins.
  await setSendPower(false);
  await setManualQueuePause(true);
  const jobs = await sendQueue.listJobs({
    states: ["waiting", "paused", "prioritized", "delayed"],
    limit: null
  });
  let cancelled = 0;
  for (const job of jobs) {
    const result = await sendQueue.cancelPendingJob(job.id);
    if (!result.cancelled) continue;
    cancelled += 1;
    const ledger = sendStore.byJob(job.id);
    if (ledger) sendStore.markById(ledger.id, "cancelled", "cancelled_by_emergency_stop");
  }
  // Durable ledger sweep (P0): cancel remaining 'queued' rows so the boot
  // rebuild can never resurrect cancelled sends (Redis-cancel alone left a
  // restart window). Active rows are NEVER touched — already-submitted
  // messages keep their true lifecycle.
  const ledgerCancelled = sendStore.cancelAllQueued("cancelled_by_emergency_stop");
  const active = (await sendQueue.counts()).active || 0;
  emitSse({ type: "queue_emergency_stopped", cancelled, ledgerCancelled, active, at: new Date().toISOString() });
  return { ok: true, powerOn: false, paused: true, manualPause: true, cancelled, ledgerCancelled, active };
});

app.get("/admin/sends", {
  schema: {
    summary: "Send ledger (durable)",
    description: "Returns the persistent send ledger: status counts and the most recent messages with their delivery state. Survives restarts and powers the 24h de-dupe. **Master token only.**",
    tags: ["Admin"],
    querystring: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 } }
    },
    response: {
      200: {
        type: "object",
        properties: {
          stats: {
            type: "object",
            properties: {
              queued: { type: "integer" }, active: { type: "integer" }, sent: { type: "integer" },
              unverified: { type: "integer" }, failed: { type: "integer" },
              suppressed: { type: "integer" }, cancelled: { type: "integer" }
            }
          },
          sends: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                to: { type: "string" },
                requestedTo: { type: "string" },
                sentTo: { type: ["string", "null"] },
                recipientEvidence: { type: ["object", "null"] },
                conversationUrl: { type: ["string", "null"] },
                submittedOnce: { type: "boolean" },
                submittedAt: { type: ["string", "null"] },
                verificationStatus: { type: ["string", "null"] },
                verificationAttempts: { type: "integer" },
                text: { type: "string" },
                textPreview: { type: "string" },
                keyName: { type: ["string", "null"] },
                jobId: { type: ["string", "null"] },
                priority: { type: "string", enum: ["critical", "expired", "expiring", "announcement"] },
                priorityLevel: { type: "integer", enum: [1, 3, 6, 10] },
                status: { type: "string" },
                stage: { type: ["string", "null"], description: "Granular progress within an active send (opening, locating, start_chat, stuck_reloading, composer_ready, typing, sent...)" },
                attempts: { type: "integer" },
                error: { type: ["string", "null"] },
                createdAt: { type: ["string", "null"] },
                updatedAt: { type: ["string", "null"] },
                finishedAt: { type: ["string", "null"] },
                sentAt: { type: ["string", "null"] }
              }
            }
          }
        }
      }
    }
  }
}, async (request) => {
  const limit = parseLimit(request.query.limit, 100, 1000);
  const sends = sendStore.recent(limit).map((r) => {
    let result = null;
    try { result = r.result_json ? JSON.parse(r.result_json) : null; } catch { /* malformed legacy row */ }
    const submission = result?.submission || result || {};
    const priority = normalizeSendPriority(r.priority);
    return {
    id: r.id,
    to: r.to_number,
    requestedTo: result?.requestedTo || r.to_number,
    sentTo: result?.sentTo || null,
    recipientEvidence: result?.recipientEvidence || null,
    conversationUrl: result?.conversationUrl || null,
    submittedOnce: Boolean(submission.submittedOnce),
    submittedAt: submission.submittedAt || null,
    verificationStatus: submission.verificationStatus || null,
    verificationAttempts: Number(submission.verificationAttempts || 0),
    text: String(r.text || ""),
    textPreview: String(r.text || "").replace(/\s+/g, " ").slice(0, 80),
    keyName: r.key_name,
    jobId: r.job_id,
    priority: priority.name,
    priorityLevel: priority.level,
    status: r.status,
    stage: r.stage || null,
    attempts: r.attempts,
    error: r.error,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null
  }; });
  return { stats: sendStore.stats(), sends };
});

app.get("/admin/queue/jobs", {
  schema: {
    summary: "List queued send jobs",
    description: "Returns pending send jobs in actual processing order (active first, then next-to-run), with a text preview and priority. Pass `all=true` to return the complete queue; otherwise `limit` controls the visible list. **Master token only.**",
    tags: ["Admin"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        all: { type: "boolean", default: false },
        offset: { type: "integer", minimum: 0, default: 0 }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          jobs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                state: { type: "string" },
                to: { type: ["string", "null"] },
                textPreview: { type: "string" },
                keyName: { type: ["string", "null"] },
                priority: { type: "string", enum: ["critical", "expired", "expiring", "announcement"] },
                priorityLevel: { type: "integer", enum: [1, 3, 6, 10] },
                attemptsMade: { type: "integer" },
                maxAttempts: { type: "integer" },
                failedReason: { type: ["string", "null"] },
                createdAt: { type: ["string", "null"] },
                processedAt: { type: ["string", "null"] },
                finishedAt: { type: ["string", "null"] },
                delayUntil: { type: ["string", "null"] },
                deferReason: { type: ["string", "null"] },
                deferCount: { type: "integer" },
                quietHoursHeld: { type: "boolean" },
                stage: { type: ["string", "null"] },
                stageLabel: { type: ["string", "null"] },
                stageAt: { type: ["string", "null"] },
                ageMs: { type: "integer" },
                waitingForMs: { type: "integer" },
                activeForMs: { type: "integer" },
                stageForMs: { type: "integer" },
                tracking: { type: "string", enum: ["sqlite", "redis_only"] },
                diagnosis: {
                  type: "object",
                  properties: {
                    code: { type: "string" },
                    severity: { type: "string", enum: ["info", "warning", "error"] },
                    message: { type: "string" }
                  }
                }
              }
            }
          },
          delayedHighCount: { type: "integer" },
          total: { type: "integer" }
        }
      }
    }
  }
}, async (request) => {
  // P0 (operator safety, 10K-backlog incident): `all=true` returned the whole
  // queue every 8s and froze the dashboard. The dashboard no longer sends it;
  // the parameter remains for API compatibility but the response is ALWAYS
  // capped at 500 rows. Pagination: offset cursor.
  const cappedLimit = request.query.all
    ? 500
    : Math.min(parseLimit(request.query.limit, 100, 500), 500);
  const offset = Math.max(0, Number(request.query.offset) || 0);
  const [jobs, delayedHighCount, counts] = await Promise.all([
    sendQueue.listJobs({ limit: cappedLimit, offset }),
    sendQueue.countDeferredHighJobs(),
    sendQueue.counts()
  ]);
  const total = counts.waiting || 0; // counts() already folds paused+prioritized into waiting
  const nextOffset = offset + jobs.length;
  return {
    jobs: jobs.map(enrichQueueJob),
    delayedHighCount,
    total,
    hasMore: nextOffset < total,
    nextCursor: String(nextOffset),
  };
});

app.post("/admin/queue/release-delayed-high", {
  schema: {
    summary: "Release all deferred critical-priority jobs",
    description: "Moves every CRITICAL send that was previously delayed to the front of the queue for immediate processing. Preserves oldest-first order within the released batch. The route name is retained for backwards compatibility. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          released: { type: "integer" }
        }
      }
    }
  }
}, async () => {
  const results = await sendQueue.releaseDeferredHighJobs();
  for (const result of results) {
    const ledger = sendStore.byJob(result.previousId);
    if (ledger) sendStore.attachJob(ledger.id, result.id);
    if (result._data?._idempotencyKey && result._data?._bodyHash) {
      await sendQueue.setIdempotencyJob(result._data._idempotencyKey, result.id, result._data._bodyHash).catch(() => {});
    }
  }
  emitSse({
    type: "queue_delayed_high_released",
    count: results.length,
    at: new Date().toISOString()
  });
  return { ok: true, released: results.length };
});

// Eve panel compatibility endpoint. Mirrors /admin/queue/release-delayed-high
// but accepts the Eve request shape and returns { promoted: N } so the panel
// can display the count without parsing admin-specific fields.
app.post("/queue/promote-high", {
  schema: {
    summary: "Release delayed critical jobs (Eve-compatible)",
    description: "Moves every delayed CRITICAL send to the front of the queue for immediate processing. Accepts Eve's request shape and returns { promoted: N }. Authenticated API keys may call this endpoint.",
    tags: ["Messaging"],
    body: {
      type: "object",
      properties: {
        all: { type: "boolean" },
        priority: { type: "string" },
        states: { type: "array", items: { type: "string" } },
        releaseDelayed: { type: "boolean" },
        position: { type: "string" }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          promoted: { type: "integer" }
        }
      },
      404: {
        type: "object",
        properties: {
          error: { type: "string" }
        }
      }
    }
  }
}, async () => {
  const results = await sendQueue.releaseDeferredHighJobs();
  for (const result of results) {
    const ledger = sendStore.byJob(result.previousId);
    if (ledger) sendStore.attachJob(ledger.id, result.id);
    if (result._data?._idempotencyKey && result._data?._bodyHash) {
      await sendQueue.setIdempotencyJob(result._data._idempotencyKey, result.id, result._data._bodyHash).catch(() => {});
    }
  }
  emitSse({
    type: "queue_delayed_high_released",
    count: results.length,
    at: new Date().toISOString()
  });
  return { promoted: results.length };
});

app.post("/admin/queue/jobs/:id/promote", {
  schema: {
    summary: "Send a queued job first",
    description: "Moves any waiting/delayed send job to CRITICAL and to the very front for immediate processing, ahead of other waiting messages. Clears its current delay. **Master token only.**",
    tags: ["Admin"],
    params: { type: "object", properties: { id: { type: "string" } } }
  }
}, async (request, reply) => {
  const ledger = sendStore.byJob(request.params.id);
  const result = await sendQueue.promoteJob(request.params.id);
  if (!result) { reply.code(404).send({ error: "not_found" }); return; }
  if (result.promoted && ledger) sendStore.attachJob(ledger.id, result.id);
  if (result.promoted && result._data?._idempotencyKey && result._data?._bodyHash) {
    await sendQueue.setIdempotencyJob(result._data._idempotencyKey, result.id, result._data._bodyHash).catch(() => {});
  }
  const { _data, ...publicResult } = result;
  return { ok: true, ...publicResult };
});

app.delete("/admin/queue/jobs/:id", {
  schema: {
    summary: "Cancel a queued job",
    description: "Removes a pending send job from the queue. **Master token only.**",
    tags: ["Admin"],
    params: { type: "object", properties: { id: { type: "string" } } }
  }
}, async (request, reply) => {
  const ledger = sendStore.byJob(request.params.id);
  const ok = await sendQueue.removeJob(request.params.id);
  if (!ok) { reply.code(404).send({ error: "not_found" }); return; }
  if (ledger) sendStore.markById(ledger.id, "cancelled", "cancelled_by_admin");
  return { ok: true };
});

app.post("/admin/queue/jobs/bulk", {
  schema: {
    summary: "Bulk perform actions on queued jobs",
    description: "Cancels, manually completes, or changes the priority lane of multiple pending jobs. Active/terminal jobs are skipped and reported. Announcement changes respect the configured pending cap. **Master token only.**",
    tags: ["Admin"],
    body: {
      type: "object",
      required: ["ids", "action"],
      properties: {
        ids: {
          type: "array",
          minItems: 1,
          maxItems: 2000,
          uniqueItems: true,
          items: { type: "string" },
          description: "List of job/UUID IDs to perform action on"
        },
        action: {
          type: "string",
          enum: ["cancel", "complete", "priority"],
          description: "Action to perform on selected jobs."
        },
        priority: {
          type: "string",
          enum: ["critical", "expired", "expiring", "announcement"],
          description: "Required when action=priority."
        }
      }
    },
    response: {
      400: {
        type: "object",
        properties: {
          error: { type: "string", enum: ["priority_required"] },
          message: { type: "string" }
        }
      },
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          count: { type: "integer", description: "Backwards-compatible alias of processed." },
          processed: { type: "integer" },
          skipped: { type: "integer" },
          priority: { type: ["string", "null"] },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                changed: { type: "boolean" },
                reason: { type: ["string", "null"] },
                state: { type: ["string", "null"] },
                priority: { type: ["string", "null"] },
                priorityLevel: { type: ["integer", "null"] }
              }
            }
          }
        }
      }
    }
  }
}, async (request, reply) => {
  const { action } = request.body;
  const ids = [...new Set(request.body.ids.map(String))];
  if (action === "priority" && !request.body.priority) {
    reply.code(400).send({ error: "priority_required", message: "priority is required when action=priority" });
    return;
  }
  const targetPriority = action === "priority" ? normalizeSendPriority(request.body.priority) : null;
  let announcementAvailable = targetPriority?.name === "announcement"
    ? Math.max(0, ANNOUNCEMENT_PENDING_LIMIT - await sendQueue.countPendingByPriority("announcement"))
    : Infinity;
  let processed = 0;
  const results = [];

  for (const id of ids) {
    const ledger = sendStore.byJob(id);
    if (action === "priority") {
      const job = await sendQueue.getJob(id);
      const currentPriority = job ? priorityForJob(job) : null;
      if (targetPriority.name === "announcement" && currentPriority?.name !== "announcement" && announcementAvailable <= 0) {
        results.push({ id, changed: false, reason: "announcement_capacity_full", state: job ? await job.getState().catch(() => "unknown") : null, priority: currentPriority?.name || null, priorityLevel: currentPriority?.level || null });
        continue;
      }
      const result = await sendQueue.changeJobPriority(id, targetPriority.name);
      results.push({ id, ...result, reason: result.reason || null });
      if (result.changed) {
        processed += 1;
        if (ledger) sendStore.updatePriorityByJob(id, targetPriority.name);
        if (targetPriority.name === "announcement" && currentPriority?.name !== "announcement") announcementAvailable -= 1;
      }
      continue;
    }

    const result = await sendQueue.cancelPendingJob(id);
    results.push({ id, changed: result.cancelled, reason: result.reason || null, state: result.state || null, priority: null, priorityLevel: null });
    if (result.cancelled) {
      processed += 1;
      if (ledger) {
        if (action === "cancel") sendStore.markById(ledger.id, "cancelled", "cancelled_by_admin");
        if (action === "complete") sendStore.markById(ledger.id, "sent", null);
      }
      continue;
    }
    // Redis lost the job (or it never existed) but the durable ledger row still
    // says queued — cancel the ROW so boot reconciliation never re-enqueues it
    // and the operator's "cancel everything" actually empties the queue view.
    if (!ledger || ledger.status !== "queued") continue;
    if (action === "cancel") {
      sendStore.markById(ledger.id, "cancelled", "cancelled_by_admin_missing_queue_job");
      processed += 1;
      results.pop();
      results.push({ id, changed: true, reason: "ledger_row_cancelled_queue_job_missing", state: null, priority: null, priorityLevel: null });
    }
  }
  const skipped = ids.length - processed;
  emitSse({
    type: "queue_bulk_action_completed",
    action,
    priority: targetPriority?.name || null,
    count: processed,
    processed,
    skipped,
    at: new Date().toISOString()
  });
  return { ok: true, count: processed, processed, skipped, priority: targetPriority?.name || null, results };
});

// ─── API Key Management (master / dashboard only) ────────────────────────────

// Operator diagnostic: which SMS consumer keys can SEND but cannot INVALIDATE a
// stale renewal reminder. Renewal invalidation silently cannot work for such a
// key (it receives 403 project_scope_denied), which is exactly the failure that
// is invisible from the consumer side.
//
// This endpoint only REPORTS. Granting sms.invalidate stays a deliberate
// operator action (PATCH /admin/api-keys/:id); never broaden a key here.
app.get("/admin/project-key-diagnostics", {
  schema: {
    summary: "Project key capability diagnostics",
    description: "Reports SMS consumer keys that can send but lack `sms.invalidate`, so lifecycle invalidation cannot work for them. **Master token only.** Read-only: it never changes a key.",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          checked: { type: "integer" },
          missingInvalidationScope: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                scopes: { type: "array", items: { type: "string" } },
                missing: { type: "string" },
                warning: { type: "string" },
                remedy: { type: "string" }
              }
            }
          },
          healthy: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
}, async () => {
  const keys = apiKeyStore.list();
  const missing = [];
  const healthy = [];
  for (const key of keys) {
    const scopes = Array.isArray(key.scopes) ? key.scopes : [];
    const canSend = apiKeyStore.hasScope(key, "sms.send");
    const canInvalidate = apiKeyStore.hasScope(key, "sms.invalidate");
    if (canSend && !canInvalidate) {
      missing.push({
        id: key.id,
        name: key.name || "(unnamed)",
        scopes: [...scopes],
        missing: "sms.invalidate",
        warning: `project key "${key.name || key.id}" can sms.send but lacks sms.invalidate; renewal invalidation cannot work.`,
        remedy: `PATCH /admin/api-keys/${key.id} with scopes including "sms.invalidate"`
      });
    } else if (canSend) {
      healthy.push(key.name || key.id);
    }
  }
  return { ok: true, checked: keys.length, missingInvalidationScope: missing, healthy };
});

app.get("/admin/api-keys", {
  schema: {
    summary: "List API keys",
    description: "Returns all project API keys with metadata. The actual token is **never** returned here — it is only shown once at creation. **Master token only.**",
    tags: ["API Keys"],
    response: {
      200: {
        type: "object",
        properties: {
          keys: { type: "array", items: { $ref: "ApiKey#" } }
        }
      }
    }
  }
}, async () => ({ keys: apiKeyStore.list() }));

app.post("/admin/api-keys", {
  schema: {
    summary: "Create API key",
    description: [
      "Creates a new project API key. The **full token is returned only in this response** — store it immediately.",
      "",
      "The token is stored as a SHA-256 hash on disk. If lost, use the `/rotate` endpoint to generate a new one.",
      "",
      "**Master token only.**"
    ].join("\n"),
    tags: ["API Keys"],
    body: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "Human-readable project name" },
        allowedIps: {
          type: "array", items: { type: "string" }, maxItems: 30,
          description: "Allowed source IPs. Empty array = accept from any IP. Recommended: set to your server's IP."
        },
        scopes: {
          type: "array", items: { type: "string", enum: [...PROJECT_KEY_SCOPES] },
          description: "Explicit capabilities. Omit for the documented legacy messaging defaults."
        },
        rateLimit: {
          type: "object",
          properties: {
            minute: { type: "integer", minimum: 0, default: 30, description: "Max /send calls per minute (0 = unlimited)" },
            hour: { type: "integer", minimum: 0, default: 1000, description: "Max /send calls per hour (0 = unlimited)" }
          }
        }
      },
      examples: [{ name: "MyProject", allowedIps: ["1.2.3.4"], rateLimit: { minute: 5, hour: 50 } }]
    },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          key: {
            allOf: [{ $ref: "ApiKey#" }],
            properties: { token: { type: "string", description: "Full token — shown ONCE. Store it now." } }
          }
        }
      }
    }
  }
}, async (request, reply) => {
  const schema = z.object({
    name: z.string().min(1).max(64),
    allowedIps: z.array(z.string()).max(30).optional(),
    scopes: z.array(z.enum([...PROJECT_KEY_SCOPES])).max(PROJECT_KEY_SCOPES.length).optional(),
    rateLimit: z.object({
      minute: z.number().int().min(0).optional(),
      hour: z.number().int().min(0).optional()
    }).optional()
  });
  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const key = apiKeyStore.create(parsed.data);
  return { ok: true, key };
});

app.patch("/admin/api-keys/:id", {
  schema: {
    summary: "Update API key",
    description: "Update name, allowed IPs, send rate limits, or enable/disable a key. **Master token only.**",
    tags: ["API Keys"],
    params: { type: "object", properties: { id: { type: "string", description: "Key ID from list endpoint" } } },
    body: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64 },
        allowedIps: { type: "array", items: { type: "string" }, maxItems: 30 },
        scopes: { type: "array", items: { type: "string", enum: [...PROJECT_KEY_SCOPES] } },
        enabled: { type: "boolean" },
        sendRateMinute: { type: "integer", minimum: 0, maximum: 10000 },
        sendRateHour: { type: "integer", minimum: 0, maximum: 100000 }
      }
    }
  }
}, async (request, reply) => {
  const schema = z.object({
    name: z.string().min(1).max(64).optional(),
    allowedIps: z.array(z.string()).max(30).optional(),
    scopes: z.array(z.enum([...PROJECT_KEY_SCOPES])).max(PROJECT_KEY_SCOPES.length).optional(),
    enabled: z.boolean().optional(),
    sendRateMinute: z.number().int().min(0).max(10000).optional(),
    sendRateHour: z.number().int().min(0).max(100000).optional()
  });
  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const updated = apiKeyStore.update(request.params.id, parsed.data);
  if (!updated) { reply.code(404).send({ error: "not_found" }); return; }
  return { ok: true, key: updated };
});

app.post("/admin/api-keys/:id/rotate", {
  schema: {
    summary: "Rotate token",
    description: "Generates a new token for this key. **The old token is immediately invalidated.** The new token is shown only once in this response. **Master token only.**",
    tags: ["API Keys"],
    params: { type: "object", properties: { id: { type: "string" } } },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          key: {
            allOf: [{ $ref: "ApiKey#" }],
            properties: { token: { type: "string", description: "New token — shown ONCE." } }
          }
        }
      }
    }
  }
}, async (request, reply) => {
  const result = apiKeyStore.rotate(request.params.id);
  if (!result) { reply.code(404).send({ error: "not_found" }); return; }
  return { ok: true, key: result };
});

app.delete("/admin/api-keys/:id", {
  schema: {
    summary: "Delete API key",
    description: "Permanently deletes a key. Any requests using this key will immediately return 401. **Master token only.**",
    tags: ["API Keys"],
    params: { type: "object", properties: { id: { type: "string" } } }
  }
}, async (request, reply) => {
  const ok = apiKeyStore.delete(request.params.id);
  if (!ok) { reply.code(404).send({ error: "not_found" }); return; }
  return { ok: true };
});

app.get("/admin/api-logs", {
  schema: {
    summary: "Request logs",
    description: "Returns the most recent API requests made with project keys (not master token). Includes timestamp, key name, IP, method, path. **Master token only.**",
    tags: ["API Keys"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
        keyId: { type: "string", description: "Filter logs by a specific key ID" }
      }
    }
  }
}, async (request) => {
  const limit = parseLimit(request.query.limit, 100, 1000);
  const keyId = request.query.keyId || undefined;
  return { logs: await apiKeyStore.getLogs({ limit, keyId }) };
});

app.get("/admin/activity-logs", {
  schema: {
    summary: "Structured activity and action logs",
    description: "Returns categorized request and operator action logs with actor, outcome, status, duration, request ID, and filter facets. Sensitive headers and request bodies are never recorded. **Master token only.**",
    tags: ["Admin"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
        type: { type: "string", enum: ["request", "action"] },
        category: { type: "string", maxLength: 64 },
        level: { type: "string", enum: ["info", "warning", "error"] },
        actorType: { type: "string", maxLength: 32 },
        search: { type: "string", maxLength: 200 }
      }
    }
  }
}, async (request) => activityLogStore.query({
  limit: parseLimit(request.query.limit, 200, 1000),
  type: request.query.type,
  category: request.query.category,
  level: request.query.level,
  actorType: request.query.actorType,
  search: request.query.search
}));

// ─────────────────────────────────────────────────────────────────────────────

app.get("/events", {
  schema: {
    summary: "Server-Sent Events stream",
    description: [
      "Subscribe to real-time events using SSE (Server-Sent Events).",
      "",
      "**Event types:**",
      "- `conversation_changed` — a conversation's last message or unread state changed",
      "- `send_queued` — a message was accepted into the send queue",
      "- `send_processing` — the worker started sending a queued message",
      "- `send_completed` — a queued message was sent successfully (includes `jobId`)",
      "- `send_failed` — a send attempt failed (`willRetry` indicates if it will be retried)",
      "- `send_cancelled` — a queued send was cancelled before it started",
      "- `browser_recovering` — a safe pre-submit reload/reconnect started or finished",
      "- `browser_hard_restart` — Chrome and API restart was scheduled after recovery failed",
      "",
      "**Scoping:** a project API key receives only its own sends' events; the master token and dashboard sessions receive the full stream.",
      "",
      "**Usage (JavaScript):**",
      "```js",
      "const es = new EventSource('/events', { headers: { Authorization: 'Bearer gmw_...' } });",
      "es.onmessage = (e) => console.log(JSON.parse(e.data));",
      "```",
      "",
      "Connection stays open until closed by the client. Reconnect with exponential backoff."
    ].join("\n"),
    tags: ["Messaging"],
    produces: ["text/event-stream"],
    response: { 200: { type: "string", description: "SSE stream" } }
  }
}, async (request, reply) => {
  // P0 (review): same lifecycle hijack as /api/v1/sse — without it Fastify
  // double-sends and crashes the process (Eve/dashboard can trigger this).
  reply.hijack();

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  reply.raw.write(": connected\n\n");
  const scope = request._projectKey
    ? { type: "project", keyName: request._projectKey.name }
    : { type: "full" };
  sseClients.set(reply, scope);

  request.raw.on("close", () => {
    sseClients.delete(reply);
  });
  return reply;
});

}); // end app.after — routes are now registered after swagger's onRoute hook

// Crash recovery: rebuild the queue from the ledger. Any unfinished row whose
// BullMQ job is missing (e.g. Redis was wiped) is re-enqueued, so a crash can
// never lose the queue. Rows still alive in Redis are left untouched (so a plain
// API restart never double-sends).
async function reconcilePending() {
  let pending;
  try { pending = sendStore.pending(); } catch { return; }
  if (!pending.length) return;
  let restored = 0;
  for (const row of pending) {
    let alive = false;
    if (row.job_id) {
      const st = await sendQueue.jobStatus(row.job_id).catch(() => null);
      alive = st && ["waiting", "active", "delayed"].includes(st.state);
    }
    if (alive) continue;
    try {
      const priority = normalizeSendPriority(row.priority);
      const job = await sendQueue.enqueue(
        {
          to: row.to_number, text: row.text, keyId: null,
          keyName: row.key_name || "reconcile",
          priority: priority.name,
          priorityLevel: priority.level
        },
        { priority: priority.level }
      );
      sendStore.attachJob(row.id, job.id);
      restored += 1;
    } catch (error) {
      app.log.warn({ error: error.message, id: row.id }, "reconcile enqueue failed");
    }
  }
  if (restored) app.log.info(`reconciled ${restored} unfinished send(s) from the ledger into the queue`);
}

async function backfillPendingLedger() {
  const jobs = await sendQueue.pendingJobsForLedger(2000);
  let imported = 0;
  for (const job of jobs) {
    try { if (sendStore.backfillPending(job)) imported += 1; } catch (error) {
      app.log.warn({ jobId: job.jobId, error: error.message }, "pending ledger backfill failed");
    }
  }
  if (imported) app.log.info({ imported }, "backfilled Redis backlog into SQLite send ledger");
}

async function initializeBrowserAndConversationIndex({ resumeAfterWarm }) {
  // Android transport (pull mode): there is no local browser or sidebar index
  // to warm. Previously execution fell into the catch branch below and left
  // the queue paused forever after every restart — the "dead GMweb" failure.
  if (typeof client.warmConversationIndex !== "function") {
    app.log.info({ transport: client.name }, "no browser warm-up for this transport; restoring queue state");
    if (resumeAfterWarm && sendPowerOn && !queueManualPause) {
      await sendQueue.resume();
      emitSse({ type: "queue_resumed", reason: "startup_resume_no_warmup", at: new Date().toISOString() });
    }
    return;
  }
  try {
    await client.start();
    // Seed readiness before the long index lock. Without this, /ready has no
    // cached paired state and the system watchdog may restart Chrome midway
    // through a perfectly healthy sidebar warm-up.
    await client.status();
    const stats = await client.warmConversationIndex((stage) => {
      emitSse({ type: "conversation_index", stage, at: new Date().toISOString() });
    });
    app.log.info({ stats }, "conversation sidebar index ready");
    if (resumeAfterWarm) {
      if (sendPowerOn && !queueManualPause) {
        await sendQueue.resume();
        emitSse({ type: "queue_resumed", reason: "conversation_index_ready", at: new Date().toISOString() });
      } else {
        app.log.warn({ sendPowerOn, queueManualPause }, "queue stays paused by operator intent");
      }
    }
  } catch (error) {
    // Keep the queue paused: Start-chat fallback is still available after a
    // manual resume, but an automatic resume without the index would recreate
    // the slow/failure-prone behavior this warm-up is designed to prevent.
    app.log.warn({ error }, "browser/index warm-up failed; queue remains paused");
  }
}

async function main() {
  if (config.appEnv === "production" && !config.apiToken) {
    throw new Error("API_TOKEN is required when NODE_ENV=production.");
  }
  await loadSessions();
  await apiKeyStore.load();
  await sendPacing.load();
  await loadSendPower();
  await loadManualQueuePause();
  await deviceKeyStore.load();
  await client.load();
  client.refreshConversationInterval();
  // Always acquire a transient startup pause. BullMQ's persisted paused state
  // is not operator intent and must never decide whether we resume later.
  await sendQueue.pause();
  startSendWorker();
  await backfillPendingLedger().catch((error) => app.log.warn({ error: error.message }, "ledger backfill failed"));
  await reconcilePending().catch((error) => app.log.warn({ error: error.message }, "reconcile failed"));
  await app.listen({ host: config.host, port: config.port });
  initializeBrowserAndConversationIndex({ resumeAfterWarm: true });
}

let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  app.log.info({ signal }, "shutting down");
  // npm/systemd may deliver the stop signal more than once, and a wedged
  // Playwright/BullMQ promise must never consume systemd's 90s stop timeout.
  // Redis + SQLite are durable, so a bounded hard exit is recovery-safe.
  const forceExit = setTimeout(() => process.exit(0), 8000);
  // Redis owns the durable job state. Force-closing the worker lets systemd
  // recovery terminate a wedged browser action immediately; BullMQ reclaims
  // the interrupted active job after restart instead of blocking StopTimeout.
  await sendQueue.close({ force: true }).catch((error) => app.log.warn({ error }, "queue close failed"));
  try { sendStore.close(); } catch (error) { app.log.warn({ error }, "ledger close failed"); }
  if (config.browserMode === "connect") client.detachForShutdown();
  else await client.stop().catch((error) => app.log.warn({ error }, "browser stop failed"));
  await app.close().catch((error) => app.log.warn({ error }, "server close failed"));
  clearTimeout(forceExit);
  process.exit(0);
}

// Only boot (listen, start worker/browser) when run directly, not when the app
// is imported by tooling such as scripts/generate-openapi.js.
if (require.main === module) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  main().catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

module.exports = { app, deviceKeyStore, agentAuthService };
if (config.appEnv === "test") {
  module.exports.__testing = { apiKeyStore, sendQueue, sendStore };
}
