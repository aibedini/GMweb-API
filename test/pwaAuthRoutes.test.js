"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const cookie = require("@fastify/cookie");
const linkedSessions = require("../src/linkedSessions");
const { registerPwaAuthRoutes, tokensMatch } = require("../src/pwaAuthRoutes");

async function makeApp({ token = "gmw_test_secret", allowed = true } = {}) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  registerPwaAuthRoutes(app, {
    apiToken: token,
    linkedSessions,
    checkRateLimit: () => ({ allowed, retryAfterSeconds: 30 }),
  });
  await app.ready();
  return app;
}

test("constant-time token helper accepts only the configured token", () => {
  assert.equal(tokensMatch("gmw_secret", "gmw_secret"), true);
  assert.equal(tokensMatch("gmw_wrong", "gmw_secret"), false);
  assert.equal(tokensMatch("", "gmw_secret"), false);
});

test("admin token is exchanged for a restricted HttpOnly PWA session", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/pwa/token-login",
    payload: { token: "gmw_test_secret" },
    headers: { "user-agent": "pwa-test" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().access, "ADMIN_TOKEN_RECOVERY");
  const setCookie = String(response.headers["set-cookie"] || "");
  assert.match(setCookie, /^gmweb_linked_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);

  const rawToken = setCookie.match(/^gmweb_linked_session=([^;]+)/)?.[1];
  const session = linkedSessions.resolve(rawToken);
  assert.ok(session);
  assert.deepEqual(session.capabilities, [
    "READ_MESSAGES",
    "SEND_MESSAGES",
    "READ_PAIRING_DIAGNOSTICS",
  ]);
});

test("invalid token is rejected without issuing a cookie or leaking the submitted value", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/pwa/token-login",
    payload: { token: "do-not-log-this" },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.deepEqual(response.json(), { error: "unauthorized", reason: "invalid_admin_token" });
  assert.doesNotMatch(response.body, /do-not-log-this/);
});

test("admin-token recovery endpoint is rate limited", async (t) => {
  const app = await makeApp({ allowed: false });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/pwa/token-login",
    payload: { token: "gmw_test_secret" },
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().retryAfterSeconds, 30);
  assert.equal(response.headers["set-cookie"], undefined);
});
