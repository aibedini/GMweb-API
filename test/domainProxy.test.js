"use strict";
// Domain proxy + SSL (Phase 2, spec domain-proxy-ssl-v1): routes and helper client.
// The privileged helper itself is exercised in domainHelper.test.js; here it is
// replaced by a fake so the API's decisions can be asserted in isolation.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Database = require("better-sqlite3");
const Fastify = require("fastify");

const { DomainStore } = require("../src/domainStore");
const { registerDomainRoutes } = require("../src/domainRoutes");
const { createHelperClient } = require("../src/domainPrivileged");

function store() { return new DomainStore(new Database(":memory:")); }

function fakeHelper(overrides = {}) {
  const calls = [];
  const ok = { ok: true, code: null, message: null, status: 200 };
  const helper = {
    calls,
    async capability() { return { canConfigureProxy: true, canIssueCertificate: true, canRenewCertificate: true, helper: null, reason: null }; },
    async apply(host, service) { calls.push(["apply", host, service]); return overrides.apply || ok; },
    async issue(host) { calls.push(["issue", host]); return overrides.issue || ok; },
    async remove(host) { calls.push(["remove", host]); return overrides.remove || ok; },
  };
  return helper;
}

const CERT = (host) => ({ subject: { CN: host }, subjectaltname: `DNS:${host}`, issuer: { O: "Let's Encrypt" },
  valid_to: new Date(Date.now() + 80 * 86_400_000).toUTCString(), valid_from: new Date().toUTCString() });
const fakeConnect = (certOrError) => () => {
  const socket = new EventEmitter();
  socket.setTimeout = () => {}; socket.end = () => {}; socket.destroy = () => {};
  process.nextTick(() => {
    if (certOrError instanceof Error) socket.emit("error", certOrError);
    else { socket.getPeerCertificate = () => certOrError; socket.emit("secureConnect"); }
  });
  return socket;
};
const okFetch = (status = 200) => async () => ({ status });

async function setup({ helper = fakeHelper(), host = "sms.example.com", dnsOk = true, ...extra } = {}) {
  const s = store();
  const app = Fastify();
  registerDomainRoutes(app, { domainStore: s, helper, ...extra });
  const created = await app.inject({ method: "POST", url: "/admin/domains", payload: { hostname: host, serviceId: "main-web" } });
  const id = created.json().domain.id;
  if (dnsOk) s.recordCheck(id, { dnsStatus: "OK", dnsObserved: "203.0.113.5" });
  const post = (url, payload) => app.inject({ method: "POST", url: `/admin/domains/${id}${url}`, payload });
  return { s, app, id, post, helper };
}

// ── apply ───────────────────────────────────────────────────────────────────

test("apply passes the stored hostname and service to the helper and records APPLIED", async () => {
  const t = await setup();
  const r = await t.post("/apply");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(t.helper.calls, [["apply", "sms.example.com", "main-web"]]);
  assert.equal(r.json().domain.proxy.status, "APPLIED");
  const detail = (await t.app.inject({ method: "GET", url: `/admin/domains/${t.id}` })).json();
  assert.equal(detail.operations[0].kind, "APPLY");
  assert.equal(detail.operations[0].outcome, "OK");
  await t.app.close();
});

test("a failed apply changes nothing and reports the helper's reason", async () => {
  const helper = fakeHelper({ apply: { ok: false, code: "NGINX_TEST_FAILED", message: "nginx rejected it", status: 502 } });
  const t = await setup({ helper });
  const r = await t.post("/apply");
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().error, "NGINX_TEST_FAILED");
  assert.equal(t.s.byId(t.id).proxy_status, "NONE");
  const detail = (await t.app.inject({ method: "GET", url: `/admin/domains/${t.id}` })).json();
  assert.equal(detail.operations[0].outcome, "FAILED");
  await t.app.close();
});

test("without the helper installed, apply and issue are refused honestly", async () => {
  const s = store();
  const app = Fastify();
  registerDomainRoutes(app, { domainStore: s }); // default: helper disabled
  const id = (await app.inject({ method: "POST", url: "/admin/domains", payload: { hostname: "x.example.com", serviceId: "main-web" } })).json().domain.id;
  s.recordCheck(id, { dnsStatus: "OK" });
  const apply = await app.inject({ method: "POST", url: `/admin/domains/${id}/apply` });
  assert.equal(apply.statusCode, 409);
  assert.equal(apply.json().error, "HELPER_UNAVAILABLE");
  const listed = (await app.inject({ method: "GET", url: "/admin/domains" })).json();
  assert.equal(listed.capability.canConfigureProxy, false);
  assert.equal(listed.capability.canIssueCertificate, false);
  await app.close();
});

test("capability follows the helper", async () => {
  const t = await setup();
  const listed = (await t.app.inject({ method: "GET", url: "/admin/domains" })).json();
  assert.equal(listed.capability.canConfigureProxy, true);
  assert.equal(listed.capability.canIssueCertificate, true);
  await t.app.close();
});

// ── service change => STALE ─────────────────────────────────────────────────

test("assigning a different service after apply marks the proxy STALE and blocks issuance", async () => {
  const t = await setup();
  await t.post("/apply");
  const assigned = await t.post("/assign", { serviceId: "public-api" });
  assert.equal(assigned.json().domain.proxy.status, "STALE");
  const issue = await t.post("/issue-certificate");
  assert.equal(issue.statusCode, 409);
  assert.equal(issue.json().error, "PROXY_NOT_APPLIED");
  assert.equal(t.helper.calls.filter((c) => c[0] === "issue").length, 0);
  // Re-applying brings it back in sync.
  await t.post("/apply");
  assert.deepEqual(t.helper.calls.at(-1), ["apply", "sms.example.com", "public-api"]);
  const detail = (await t.app.inject({ method: "GET", url: `/admin/domains/${t.id}` })).json();
  assert.equal(detail.domain.proxy.status, "APPLIED");
  await t.app.close();
});

// ── issue ───────────────────────────────────────────────────────────────────

test("issuing is refused until DNS is verified and the proxy is applied", async () => {
  const noDns = await setup({ dnsOk: false });
  await noDns.post("/apply");
  const a = await noDns.post("/issue-certificate");
  assert.equal(a.statusCode, 409);
  assert.equal(a.json().error, "DNS_NOT_VERIFIED");
  await noDns.app.close();

  const notApplied = await setup();
  const b = await notApplied.post("/issue-certificate");
  assert.equal(b.statusCode, 409);
  assert.equal(b.json().error, "PROXY_NOT_APPLIED");
  assert.equal(notApplied.helper.calls.length, 0, "the helper was never invoked");
  await notApplied.app.close();
});

test("SSL_ACTIVE comes from the independent probe, not from the helper's success", async () => {
  // Helper says ok, but the host does not actually serve a valid certificate.
  const bad = await setup({ connect: fakeConnect(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })), fetchImpl: okFetch(200) });
  await bad.post("/apply");
  const r1 = await bad.post("/issue-certificate");
  assert.equal(r1.statusCode, 200);
  assert.notEqual(r1.json().domain.status, "SSL_ACTIVE");
  assert.notEqual(r1.json().domain.ssl.status, "ACTIVE");
  await bad.app.close();

  // Same helper outcome, probe confirms a covering certificate and a live surface.
  const good = await setup({ connect: fakeConnect(CERT("sms.example.com")), fetchImpl: okFetch(200) });
  await good.post("/apply");
  const r2 = await good.post("/issue-certificate");
  assert.equal(r2.json().domain.status, "SSL_ACTIVE");
  assert.equal(r2.json().domain.ssl.status, "ACTIVE");
  assert.equal(r2.json().domain.ssl.provider, "letsencrypt");
  await good.app.close();
});

test("a certificate for the wrong name never produces SSL_ACTIVE", async () => {
  const t = await setup({ connect: fakeConnect(CERT("other.example.net")), fetchImpl: okFetch(200) });
  await t.post("/apply");
  const r = await t.post("/issue-certificate");
  assert.notEqual(r.json().domain.status, "SSL_ACTIVE");
  await t.app.close();
});

test("a failed issuance is surfaced, recorded, and is not SSL_ACTIVE", async () => {
  const helper = fakeHelper({ issue: { ok: false, code: "CERTBOT_FAILED", message: "Challenge failed for domain", status: 502 } });
  const t = await setup({ helper });
  await t.post("/apply");
  const r = await t.post("/issue-certificate");
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().error, "CERTBOT_FAILED");
  const domain = (await t.app.inject({ method: "GET", url: `/admin/domains/${t.id}` })).json();
  assert.equal(domain.domain.lastError.code, "CERT_ISSUE_FAILED");
  assert.notEqual(domain.domain.status, "SSL_ACTIVE");
  assert.equal(domain.operations[0].kind, "ISSUE_CERT");
  assert.equal(domain.operations[0].outcome, "FAILED");
  await t.app.close();
});

// ── delete ordering ─────────────────────────────────────────────────────────

test("removing an applied domain removes its proxy first and keeps the row if that fails", async () => {
  const failing = fakeHelper({ remove: { ok: false, code: "NGINX_TEST_FAILED", message: "no", status: 502 } });
  const t = await setup({ helper: failing });
  await t.post("/apply");
  const r = await t.app.inject({ method: "DELETE", url: `/admin/domains/${t.id}` });
  assert.equal(r.statusCode, 502);
  assert.ok(t.s.byId(t.id), "the row was kept so the live vhost is not orphaned");
  await t.app.close();

  const good = await setup();
  await good.post("/apply");
  const ok = await good.app.inject({ method: "DELETE", url: `/admin/domains/${good.id}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().proxyRemoved, true);
  assert.deepEqual(good.helper.calls.at(-1), ["remove", "sms.example.com"]);
  assert.equal(good.s.byId(good.id) ?? null, null);
  await good.app.close();
});

test("removing a never-applied domain does not call the helper", async () => {
  const t = await setup();
  const r = await t.app.inject({ method: "DELETE", url: `/admin/domains/${t.id}` });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().proxyRemoved, false);
  assert.equal(t.helper.calls.length, 0);
  await t.app.close();
});

test("unknown routes from Phase 1 stay absent", async () => {
  const t = await setup();
  for (const url of ["/ssl/issue", "/ssl/renew", "/configure"]) {
    assert.equal((await t.post(url)).statusCode, 404, url);
  }
  await t.app.close();
});

test("responses never expose filesystem paths or key material", async () => {
  const t = await setup({ connect: fakeConnect(CERT("sms.example.com")), fetchImpl: okFetch(200) });
  await t.post("/apply");
  const issued = await t.post("/issue-certificate");
  const text = issued.payload + (await t.app.inject({ method: "GET", url: "/admin/domains" })).payload;
  for (const forbidden of ["PRIVATE KEY", "privkey", "/etc/letsencrypt", "/etc/nginx"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  await t.app.close();
});

// ── helper client ───────────────────────────────────────────────────────────

function execStub(handler) {
  const calls = [];
  const exec = (file, args, options, cb) => {
    calls.push({ file, args, options });
    Promise.resolve(handler(args, options, calls.length)).then(({ error = null, stdout = "", stderr = "" }) => cb(error, stdout, stderr));
  };
  exec.calls = calls;
  return exec;
}
const OK_LINE = JSON.stringify({ ok: true, action: "apply", hostname: "sms.example.com" });
const clientWith = (handler, extra = {}) => {
  const exec = execStub(handler);
  const client = createHelperClient({ exec, exists: () => true, platform: "linux", helperPath: "/usr/local/sbin/gmweb-domain-helper", ...extra });
  return { client, exec };
};

test("client runs sudo -n with an argv array, no shell, minimal env", async () => {
  const { client, exec } = clientWith(async (args) => (args.includes("-l") ? {} : { stdout: OK_LINE + "\n" }));
  const r = await client.apply("SMS.Example.com", "main-web");
  assert.equal(r.ok, true);
  const call = exec.calls.at(-1);
  assert.equal(call.file, "sudo");
  assert.deepEqual(call.args, ["-n", "/usr/local/sbin/gmweb-domain-helper", "apply", "sms.example.com", "main-web"]);
  assert.equal(call.options.shell, false);
  assert.deepEqual(Object.keys(call.options.env).sort(), ["LANG", "PATH"]);
  assert.ok(call.options.timeout > 0 && call.options.maxBuffer > 0);
});

test("client refuses hostile input before any process is spawned", async () => {
  const { client, exec } = clientWith(async () => ({ stdout: OK_LINE }));
  for (const host of ["a;id.example.com", "x y.example.com", "../x", "*.example.com", "", "a.example.com\n--flag"]) {
    const r = await client.apply(host, "main-web");
    assert.equal(r.ok, false, host);
    assert.equal(r.status, 400);
  }
  assert.equal((await client.apply("ok.example.com", "main-web; id")).ok, false);
  assert.equal((await client.issue("bad host")).ok, false);
  assert.equal((await client.remove("../etc")).ok, false);
  assert.equal(exec.calls.length, 0);
});

test("client maps helper failures to stable codes and statuses", async () => {
  const fail = (code, message = "m") => async (args) => (args.includes("-l") ? {} : { error: Object.assign(new Error("x"), { code: 3 }), stdout: JSON.stringify({ ok: false, code, message }) });
  assert.deepEqual((({ ok, code, status }) => ({ ok, code, status }))(await clientWith(fail("SERVER_NAME_IN_USE")).client.apply("a.example.com", "main-web")), { ok: false, code: "SERVER_NAME_IN_USE", status: 409 });
  assert.equal((await clientWith(fail("NGINX_TEST_FAILED")).client.apply("a.example.com", "main-web")).status, 502);
  assert.equal((await clientWith(fail("lower-case-garbage")).client.apply("a.example.com", "main-web")).code, "HELPER_FAILED");
});

test("a zero exit with unparseable output is a failure, never a success", async () => {
  const { client } = clientWith(async (args) => (args.includes("-l") ? {} : { stdout: "all good!" }));
  const r = await client.apply("a.example.com", "main-web");
  assert.equal(r.ok, false);
  assert.equal(r.code, "HELPER_FAILED");
});

test("a non-zero exit is a failure even if the output claims ok", async () => {
  const { client } = clientWith(async (args) => (args.includes("-l") ? {} : { error: new Error("exit 1"), stdout: OK_LINE }));
  assert.equal((await client.apply("a.example.com", "main-web")).ok, false);
});

test("a timeout is reported as such", async () => {
  const { client } = clientWith(async (args) => (args.includes("-l") ? {} : { error: Object.assign(new Error("t"), { killed: true }) }));
  const r = await client.issue("a.example.com");
  assert.equal(r.code, "HELPER_TIMEOUT");
  assert.equal(r.status, 504);
});

test("helper messages are truncated and stripped of filesystem paths and control characters", async () => {
  const message = "failed at /etc/letsencrypt/live/a.example.com/privkey.pem \u0007\u001b[31m" + "x".repeat(900);
  const { client } = clientWith(async (args) => (args.includes("-l") ? {} : { error: new Error("e"), stdout: JSON.stringify({ ok: false, code: "CERTBOT_FAILED", message }) }));
  const r = await client.issue("a.example.com");
  assert.ok(r.message.length <= 300);
  assert.doesNotMatch(r.message, /letsencrypt|privkey|\u0007|\u001b/);
});

test("calls are serialised: a second call waits for the first", async () => {
  let active = 0; let maxActive = 0;
  const { client } = clientWith(async (args) => {
    if (args.includes("-l")) return {};
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    return { stdout: OK_LINE };
  });
  await Promise.all([client.apply("a.example.com", "main-web"), client.apply("b.example.com", "main-web"), client.remove("c.example.com")]);
  assert.equal(maxActive, 1);
});

test("unavailable states are explicit: not installed, sudo denied, wrong platform, disabled", async () => {
  const mk = (extra, handler = async () => ({})) => clientWith(handler, extra).client;
  assert.equal((await mk({ exists: () => false }).capability()).helper, "HELPER_NOT_INSTALLED");
  assert.equal((await mk({}, async () => ({ error: new Error("no") })).capability()).helper, "SUDO_NOT_PERMITTED");
  assert.equal((await mk({ platform: "win32" }).capability()).helper, "UNSUPPORTED_PLATFORM");
  assert.equal((await mk({ enabled: false }).capability()).helper, "DISABLED");
  const cap = await mk({ exists: () => false }).capability();
  assert.equal(cap.canConfigureProxy, false);
  assert.equal(cap.canIssueCertificate, false);
  assert.match(cap.reason, /install-domain-helper/);
});

test("the sudo probe is cached briefly", async () => {
  let t = 1_000_000;
  const { client, exec } = clientWith(async () => ({}), { now: () => t });
  await client.capability(); await client.capability();
  assert.equal(exec.calls.length, 1);
  t += 61_000;
  await client.capability();
  assert.equal(exec.calls.length, 2);
});

test("the configured ACME e-mail is passed only when well-formed", async () => {
  const withEmail = clientWith(async (args) => (args.includes("-l") ? {} : { stdout: OK_LINE }), { acmeEmail: "ops@example.com" });
  await withEmail.client.issue("a.example.com");
  assert.deepEqual(withEmail.exec.calls.at(-1).args.slice(-2), ["a.example.com", "ops@example.com"]);
  const bad = clientWith(async (args) => (args.includes("-l") ? {} : { stdout: OK_LINE }), { acmeEmail: "x; rm -rf /" });
  await bad.client.issue("a.example.com");
  assert.equal(bad.exec.calls.at(-1).args.at(-1), "a.example.com");
});
