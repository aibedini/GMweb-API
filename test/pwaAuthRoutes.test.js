"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const cookie = require("@fastify/cookie");
const Database = require("better-sqlite3");
const linkedSessions = require("../src/linkedSessions");
const { PwaAccessTokenStore } = require("../src/pwaAccessTokens");
const { registerPwaAuthRoutes, registerPwaTokenAdminRoutes } = require("../src/pwaAuthRoutes");

async function makeApp({ allowed = true } = {}) {
  const app = Fastify({ logger: false });
  const db = new Database(":memory:");
  const pwaAccessTokens = new PwaAccessTokenStore(db);
  await app.register(cookie);
  registerPwaAuthRoutes(app, {
    pwaAccessTokens,
    linkedSessions,
    checkRateLimit: () => ({ allowed, retryAfterSeconds: 30 }),
  });
  registerPwaTokenAdminRoutes(app, { pwaAccessTokens, linkedSessions });
  await app.ready();
  return { app, db, pwaAccessTokens };
}

test("dashboard creates a hashed, expiring PWA token and only returns plaintext once", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const created = await app.inject({
    method: "POST",
    url: "/admin/pwa-access-tokens",
    payload: { label: "Mahna laptop", expiresInMinutes: 10 },
  });
  assert.equal(created.statusCode, 200, created.body);
  const token = created.json().token;
  assert.match(token.token, /^pwa_[A-Za-z0-9_-]{40,}$/);
  const row = db.prepare("SELECT * FROM pwa_access_tokens WHERE id = ?").get(token.id);
  assert.ok(Buffer.isBuffer(row.token_hash));
  assert.equal(JSON.stringify(row).includes(token.token), false);

  const listed = await app.inject({ method: "GET", url: "/admin/pwa-access-tokens" });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().tokens[0].token, undefined);
  assert.equal(listed.json().tokens[0].status, "READY");
});

test("one-time PWA token is exchanged for a restricted HttpOnly session", async (t) => {
  const { app, db, pwaAccessTokens } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const issued = pwaAccessTokens.create({ label: "test" });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/pwa/token-login",
    payload: { token: issued.token },
    headers: { "user-agent": "pwa-test" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().access, "ONE_TIME_PWA_TOKEN");
  const setCookie = String(response.headers["set-cookie"] || "");
  assert.match(setCookie, /^gmweb_linked_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const rawToken = setCookie.match(/^gmweb_linked_session=([^;]+)/)?.[1];
  const session = linkedSessions.resolve(rawToken);
  assert.ok(session);
  assert.deepEqual(session.capabilities, ["READ_MESSAGES", "READ_PAIRING_DIAGNOSTICS"]);

  const replay = await app.inject({ method: "POST", url: "/api/v1/pwa/token-login", payload: { token: issued.token } });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.headers["set-cookie"], undefined);
});

test("master and project tokens are rejected by the PWA access endpoint", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  for (const token of ["test-master-token", "gmw_project_secret"]) {
    const response = await app.inject({ method: "POST", url: "/api/v1/pwa/token-login", payload: { token } });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "unauthorized", reason: "invalid_or_expired_pwa_token" });
    assert.doesNotMatch(response.body, new RegExp(token));
  }
});

test("revoking a consumed access token also revokes its browser session", async (t) => {
  const { app, db, pwaAccessTokens } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const issued = pwaAccessTokens.create({ label: "revoke me" });
  const login = await app.inject({
    method: "POST", url: "/api/v1/pwa/token-login", payload: { token: issued.token }, headers: { "user-agent": "revoke-test" },
  });
  const rawSession = String(login.headers["set-cookie"]).match(/^gmweb_linked_session=([^;]+)/)?.[1];
  assert.ok(linkedSessions.resolve(rawSession));
  const revoked = await app.inject({ method: "DELETE", url: `/admin/pwa-access-tokens/${issued.id}` });
  assert.equal(revoked.statusCode, 200);
  assert.equal(linkedSessions.resolve(rawSession), null);
});

test("PWA token login is rate limited before token verification", async (t) => {
  const { app, db, pwaAccessTokens } = await makeApp({ allowed: false });
  t.after(async () => { await app.close(); db.close(); });
  const issued = pwaAccessTokens.create();
  const response = await app.inject({ method: "POST", url: "/api/v1/pwa/token-login", payload: { token: issued.token } });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().retryAfterSeconds, 30);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(pwaAccessTokens.list()[0].status, "READY");
});
