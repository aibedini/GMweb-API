"use strict";
// Domain management — Phase 1 (verification only).
//
// These tests intentionally assert what the feature CANNOT do as well as what it
// can: the API runs as the unprivileged `gmweb` user, which on the production
// host cannot write /etc/nginx, cannot write /etc/letsencrypt and cannot run
// certbot. A stored row must never be presented as a live vhost.
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const Fastify = require("fastify");

const { DomainStore, normalizeHostname, getService, upstreamFor, deriveStatus,
  SERVICE_REGISTRY } = require("../src/domainStore");
const { verifyDns, verifyRouting, certificateCovers, resolveHost } = require("../src/domainVerification");
const { registerDomainRoutes, capability, localAddresses } = require("../src/domainRoutes");

function store() { return new DomainStore(new Database(":memory:")); }

function app(domainStore, extra = {}) {
  const instance = Fastify();
  registerDomainRoutes(instance, { domainStore, ...extra });
  return instance;
}

// ── domain validation ───────────────────────────────────────────────────────

test("a valid hostname is accepted and normalized", () => {
  for (const [input, expected] of [["App.Example.COM", "app.example.com"],
    ["api.example.com.", "api.example.com"], ["  sub.example.co.uk  ", "sub.example.co.uk"]]) {
    const parsed = normalizeHostname(input);
    assert.equal(parsed.ok, true, input);
    assert.equal(parsed.normalized, expected);
  }
});

test("invalid and dangerous hostnames are rejected", () => {
  const cases = [
    ["", "empty"], ["example", "not fully qualified"], ["-bad.example.com", "leading hyphen"],
    ["bad-.example.com", "trailing hyphen"], [".example.com", "leading dot"],
    ["a..b.com", "empty label"], ["1.2.3.4", "numeric TLD"],
    ["example.com:443", "embedded port"], ["https://example.com", "scheme"],
    ["user@example.com", "userinfo"], ["exa mple.com", "space"],
    ["example.com;rm -rf /", "shell metacharacters"], ["example.com$(id)", "command substitution"],
    ["example.com`id`", "backticks"], ["example.com|cat /etc/passwd", "pipe"],
    ["../../etc/passwd", "path traversal"], ["example.com\nHost: evil", "newline injection"],
    ["a".repeat(64) + ".com", "label too long"],
  ];
  for (const [input, why] of cases) {
    const parsed = normalizeHostname(input);
    assert.equal(parsed.ok, false, `should reject (${why}): ${JSON.stringify(input)}`);
  }
});

test("wildcards are refused because DNS-01 is unavailable", () => {
  const parsed = normalizeHostname("*.example.com");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "WILDCARD_UNSUPPORTED");
  assert.match(parsed.message, /DNS-01/);
});

test("a duplicate domain is refused", () => {
  const s = store();
  assert.equal(s.create({ hostname: "a.example.com", serviceId: "main-web" }).ok, true);
  const again = s.create({ hostname: "A.EXAMPLE.COM.", serviceId: "public-api" });
  assert.equal(again.error, "DUPLICATE_DOMAIN");
});

test("an unknown service identifier is refused", () => {
  const s = store();
  assert.equal(s.create({ hostname: "a.example.com", serviceId: "not-a-service" }).error, "INVALID_SERVICE");
  // And re-assignment is refused too.
  const created = s.create({ hostname: "b.example.com", serviceId: "main-web" });
  assert.equal(s.assign(created.domain.id, "nope").error, "INVALID_SERVICE");
});

test("the upstream is never taken from user input", () => {
  // Every service resolves to the single local application upstream; a caller
  // cannot introduce an arbitrary destination (SSRF control).
  for (const id of Object.keys(SERVICE_REGISTRY)) {
    assert.equal(upstreamFor(id), "127.0.0.1:3030");
    assert.equal(SERVICE_REGISTRY[id].upstream, "127.0.0.1:3030");
  }
  assert.equal(upstreamFor("evil.example.com"), null);
  assert.equal(getService("127.0.0.1:22"), null);
});

// ── authorization ───────────────────────────────────────────────────────────

test("every mutating route requires server-side validation and returns 4xx", async () => {
  const s = store();
  const instance = app(s);
  const post = (url, payload) => instance.inject({ method: "POST", url, payload });
  // No hostname: Fastify schema rejects it.
  assert.equal((await post("/admin/domains", { serviceId: "main-web" })).statusCode, 400);
  // Unknown service: handler rejects it.
  assert.equal((await post("/admin/domains", { hostname: "x.example.com", serviceId: "bad" })).statusCode, 400);
  // Wildcard: rejected.
  assert.equal((await post("/admin/domains", { hostname: "*.example.com", serviceId: "main-web" })).statusCode, 400);
  // Duplicate: 409.
  await post("/admin/domains", { hostname: "dup.example.com", serviceId: "main-web" });
  assert.equal((await post("/admin/domains", { hostname: "dup.example.com", serviceId: "main-web" })).statusCode, 409);
  // Unknown id: 404.
  assert.equal((await post("/admin/domains/99999/verify-dns")).statusCode, 404);
  assert.equal((await instance.inject({ method: "DELETE", url: "/admin/domains/99999" })).statusCode, 404);
  await instance.close();
});

// ── DNS ─────────────────────────────────────────────────────────────────────

const resolverWith = (map) => ({
  resolve4: async (h) => { if (map[h]?.ipv4) return map[h].ipv4; throw Object.assign(new Error("none"), { code: "ENODATA" }); },
  resolve6: async (h) => { if (map[h]?.ipv6) return map[h].ipv6; throw Object.assign(new Error("none"), { code: "ENODATA" }); },
  resolveCname: async (h) => { if (map[h]?.cname) return map[h].cname; throw Object.assign(new Error("none"), { code: "ENODATA" }); },
});

test("DNS: correct A record passes", async () => {
  const result = await verifyDns({ hostname: "a.example.com", expectedIpv4: ["203.0.113.5"],
    resolver: resolverWith({ "a.example.com": { ipv4: ["203.0.113.5"] } }) });
  assert.equal(result.status, "OK");
  assert.equal(result.errorCode, null);
});

test("DNS: a wrong target is a mismatch, not a success", async () => {
  const result = await verifyDns({ hostname: "a.example.com", expectedIpv4: ["203.0.113.5"],
    resolver: resolverWith({ "a.example.com": { ipv4: ["198.51.100.9"] } }) });
  assert.equal(result.status, "MISMATCH");
  assert.equal(result.errorCode, "DNS_TARGET_MISMATCH");
  assert.match(result.message, /198\.51\.100\.9/);
});

test("DNS: a missing record is reported as missing, never as OK", async () => {
  const result = await verifyDns({ hostname: "none.example.com", expectedIpv4: ["203.0.113.5"],
    resolver: resolverWith({}) });
  assert.equal(result.status, "MISSING");
  assert.equal(result.errorCode, "DNS_MISSING");
});

test("DNS: a lookup failure is an error, not a pass", async () => {
  const result = await verifyDns({ hostname: "t.example.com", expectedIpv4: ["203.0.113.5"],
    resolver: { resolve4: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); },
      resolve6: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); },
      resolveCname: async () => { throw Object.assign(new Error("x"), { code: "ENODATA" }); } } });
  assert.equal(result.status, "ERROR");
  assert.equal(result.errorCode, "DNS_LOOKUP_FAILED");
});

test("DNS: an IPv6-only host passes, and a CNAME is surfaced as information", async () => {
  const result = await verifyDns({ hostname: "v6.example.com", expectedIpv6: ["2001:db8::1"],
    resolver: resolverWith({ "v6.example.com": { ipv6: ["2001:db8::1"], cname: ["target.example.net"] } }) });
  assert.equal(result.status, "OK");
  assert.match(result.warnings.join(" "), /CNAME/);
});

test("DNS: an IPv4/IPv6 mismatch is a warning on an otherwise matching host", async () => {
  const result = await verifyDns({ hostname: "dual.example.com", expectedIpv4: ["203.0.113.5"],
    expectedIpv6: ["2001:db8::1"],
    resolver: resolverWith({ "dual.example.com": { ipv4: ["203.0.113.5"], ipv6: ["2001:db8::99"] } }) });
  assert.equal(result.status, "OK");
  assert.match(result.warnings.join(" "), /IPv6/);
});

// ── SSL / routing ───────────────────────────────────────────────────────────

/**
 * A certificate in the shape `tls.TLSSocket#getPeerCertificate()` actually
 * returns — `valid_from`/`valid_to`/`subjectaltname`, NOT camelCase. Getting this
 * wrong is how a mock silently tests nothing.
 */
const CERT = (over = {}) => ({
  subject: { CN: "a.example.com" },
  issuer: { O: "Let's Encrypt" },
  valid_from: new Date(Date.now() - 86_400_000).toUTCString(),
  valid_to: new Date(Date.now() + 60 * 86_400_000).toUTCString(),
  subjectaltname: "DNS:a.example.com",
  ...over,
});

/** A tls.connect stand-in that emits a chosen certificate or error. */
const fakeConnect = (certOrError) => (options) => {
  const { EventEmitter } = require("node:events");
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.end = () => {};
  socket.destroy = () => {};
  process.nextTick(() => {
    if (certOrError instanceof Error) socket.emit("error", certOrError);
    else { socket.getPeerCertificate = () => certOrError; socket.emit("secureConnect"); }
  });
  void options;
  return socket;
};

const okFetch = (status = 200) => async () => ({ status });

test("SSL: a valid certificate plus a live surface becomes ACTIVE", async () => {
  const result = await verifyRouting({ hostname: "a.example.com", service: getService("main-web"),
    connect: fakeConnect(CERT()), fetchImpl: okFetch(200) });
  assert.equal(result.routingStatus, "OK");
  assert.equal(result.sslStatus, "ACTIVE");
  assert.equal(result.errorCode, null);
});

test("SSL: a certificate that does not cover the hostname is INVALID", async () => {
  const result = await verifyRouting({ hostname: "other.example.com", service: getService("main-web"),
    connect: fakeConnect(CERT({ subject: { CN: "a.example.com" }, subjectaltname: "DNS:a.example.com" })),
    fetchImpl: okFetch(200) });
  assert.equal(result.sslStatus, "INVALID");
  assert.equal(result.errorCode, "CERT_HOSTNAME_MISMATCH");
  assert.equal(result.routingStatus, "ERROR");
});

test("SSL: an expired certificate is EXPIRED, never ACTIVE", async () => {
  const result = await verifyRouting({ hostname: "a.example.com", service: getService("main-web"),
    connect: fakeConnect(CERT({ valid_to: new Date(Date.now() - 86_400_000).toUTCString() })), fetchImpl: okFetch(200) });
  assert.equal(result.sslStatus, "EXPIRED");
  assert.equal(result.errorCode, "CERT_EXPIRED");
});

test("SSL: a TLS failure is reported, not swallowed", async () => {
  const result = await verifyRouting({ hostname: "a.example.com", service: getService("main-web"),
    connect: fakeConnect(Object.assign(new Error("handshake"), { code: "ECONNREFUSED" })),
    fetchImpl: okFetch(200) });
  assert.equal(result.sslStatus, "NONE");
  assert.equal(result.errorCode, "ROUTING_TLS_FAILED");
});

test("SSL: a valid certificate with a 5xx upstream is NOT reported healthy", async () => {
  const result = await verifyRouting({ hostname: "a.example.com", service: getService("main-web"),
    connect: fakeConnect(CERT()), fetchImpl: okFetch(502) });
  assert.equal(result.errorCode, "ROUTING_UPSTREAM_ERROR");
  assert.equal(result.sslStatus, "ISSUED_NOT_SERVING");
  assert.notEqual(result.sslStatus, "ACTIVE");
});

test("SSL: an unreachable endpoint is ISSUED_NOT_SERVING, not ACTIVE", async () => {
  const result = await verifyRouting({ hostname: "a.example.com", service: getService("main-web"),
    connect: fakeConnect(CERT()), fetchImpl: async () => { throw new Error("fetch failed"); } });
  assert.equal(result.errorCode, "ROUTING_HTTP_UNREACHABLE");
  assert.notEqual(result.sslStatus, "ACTIVE");
});

test("SSL: an expiring certificate is ACTIVE but flagged for renewal", async () => {
  const result = await verifyRouting({ hostname: "a.example.com", service: getService("main-web"),
    connect: fakeConnect(CERT({ valid_to: new Date(Date.now() + 10 * 86_400_000).toUTCString() })), fetchImpl: okFetch(200) });
  assert.equal(result.sslStatus, "ACTIVE");
  assert.equal(result.errorCode, "CERT_RENEWAL_REQUIRED");
  assert.equal(result.renewalDue, true);
});

test("certificateCovers handles SAN lists, CN fallback and wildcards", () => {
  assert.equal(certificateCovers({ subject: "x", subjectAltNames: "DNS:a.example.com, DNS:b.example.com" }, "b.example.com"), true);
  assert.equal(certificateCovers({ subject: "a.example.com", subjectAltNames: null }, "a.example.com"), true);
  assert.equal(certificateCovers({ subject: "a.example.com", subjectAltNames: null }, "b.example.com"), false);
  assert.equal(certificateCovers({ subject: "x", subjectAltNames: "DNS:*.example.com" }, "a.example.com"), true);
  assert.equal(certificateCovers({ subject: "x", subjectAltNames: "DNS:*.example.com" }, "example.com"), false);
  assert.equal(certificateCovers(null, "a.example.com"), false);
});

// ── status truthfulness ─────────────────────────────────────────────────────

test("a stored row alone never yields SSL_ACTIVE", () => {
  assert.equal(deriveStatus({ dns_status: "OK", routing_status: "UNKNOWN", ssl_status: "UNKNOWN" }), "READY_FOR_SSL");
  assert.equal(deriveStatus({ dns_status: "UNKNOWN", routing_status: "UNKNOWN", ssl_status: "UNKNOWN" }), "PENDING_DNS");
  assert.equal(deriveStatus({ dns_status: "OK", routing_status: "OK", ssl_status: "UNKNOWN" }), "READY_FOR_SSL");
  assert.equal(deriveStatus({ dns_status: "OK", routing_status: "OK", ssl_status: "ACTIVE" }), "SSL_ACTIVE");
});

test("an error is never masked by a stale success", () => {
  assert.equal(deriveStatus({ last_error_code: "DNS_TARGET_MISMATCH", dns_status: "OK",
    routing_status: "OK", ssl_status: "ACTIVE" }), "DNS_INVALID");
  assert.equal(deriveStatus({ last_error_code: "ROUTING_UPSTREAM_ERROR", dns_status: "OK",
    routing_status: "OK", ssl_status: "ACTIVE" }), "ROUTING_ERROR");
  assert.equal(deriveStatus({ last_error_code: "CERT_HOSTNAME_MISMATCH" }), "SSL_INVALID");
});

// ── capability + no privilege claims ────────────────────────────────────────

test("the API reports that it cannot configure routing or issue certificates", async () => {
  const cap = capability();
  assert.equal(cap.canVerifyDns, true);
  assert.equal(cap.canVerifyRouting, true);
  assert.equal(cap.canConfigureProxy, false);
  assert.equal(cap.canIssueCertificate, false);
  assert.equal(cap.canRenewCertificate, false);
  assert.match(cap.reason, /unprivileged/);

  const instance = app(store());
  const listed = await instance.inject({ method: "GET", url: "/admin/domains" });
  const body = listed.json();
  assert.equal(body.capability.canConfigureProxy, false);
  assert.equal(body.capability.canIssueCertificate, false);
  await instance.close();
});

test("adding a domain says what did NOT happen", async () => {
  const instance = app(store());
  const response = await instance.inject({ method: "POST", url: "/admin/domains",
    payload: { hostname: "new.example.com", serviceId: "main-web" } });
  const body = response.json();
  assert.equal(response.statusCode, 200);
  assert.match(body.next, /privileged helper/);
  assert.equal(body.domain.status, "PENDING_DNS");
  assert.notEqual(body.domain.status, "SSL_ACTIVE");
  await instance.close();
});

test("without a privileged helper no route can apply configuration or issue a certificate", async () => {
  const instance = app(store());
  const created = await instance.inject({ method: "POST", url: "/admin/domains",
    payload: { hostname: "r.example.com", serviceId: "main-web" } });
  const id = created.json().domain.id;
  for (const url of [`/admin/domains/${id}/ssl/issue`, `/admin/domains/${id}/ssl/renew`,
    `/admin/domains/${id}/configure`]) {
    const response = await instance.inject({ method: "POST", url });
    assert.equal(response.statusCode, 404, `${url} must not exist`);
  }
  // Phase 2 routes exist but refuse to act when the helper is not available.
  for (const url of [`/admin/domains/${id}/apply`, `/admin/domains/${id}/issue-certificate`]) {
    const response = await instance.inject({ method: "POST", url });
    assert.ok([409].includes(response.statusCode), `${url} -> ${response.statusCode}`);
  }
  await instance.close();
});

test("responses never contain key material or filesystem paths", async () => {
  const s = store();
  const instance = app(s);
  await instance.inject({ method: "POST", url: "/admin/domains",
    payload: { hostname: "k.example.com", serviceId: "main-web" } });
  const listed = await instance.inject({ method: "GET", url: "/admin/domains" });
  const text = listed.payload;
  for (const forbidden of ["PRIVATE KEY", "privkey", "/etc/letsencrypt", "/etc/nginx", "API_TOKEN"]) {
    assert.equal(text.includes(forbidden), false, `response must not contain ${forbidden}`);
  }
  await instance.close();
});

// ── operations history ──────────────────────────────────────────────────────

test("verification is recorded as operation history", async () => {
  const s = store();
  const own = localAddresses().ipv4[0];
  const instance = app(s, { resolver: resolverWith({ "o.example.com": { ipv4: [own] } }) });
  const created = await instance.inject({ method: "POST", url: "/admin/domains",
    payload: { hostname: "o.example.com", serviceId: "main-web" } });
  const id = created.json().domain.id;
  await instance.inject({ method: "POST", url: `/admin/domains/${id}/verify-dns` });
  const ops = (await instance.inject({ method: "GET", url: `/admin/domains/${id}/operations` })).json();
  assert.equal(ops.operations[0].kind, "VERIFY_DNS");
  assert.equal(ops.operations[0].outcome, "OK");
  await instance.close();
});

test("a failed verification records the failure, and does not overwrite it later", async () => {
  const s = store();
  const instance = app(s, { resolver: resolverWith({}) });
  const created = await instance.inject({ method: "POST", url: "/admin/domains",
    payload: { hostname: "f.example.com", serviceId: "main-web" } });
  const id = created.json().domain.id;
  const verified = (await instance.inject({ method: "POST", url: `/admin/domains/${id}/verify-dns` })).json();
  assert.equal(verified.dns.status, "MISSING");
  assert.equal(verified.domain.status, "PENDING_DNS");
  assert.equal(verified.domain.lastError.code, "DNS_MISSING");
  await instance.close();
});

test("removal states that no host configuration was changed", async () => {
  const s = store();
  const instance = app(s);
  const created = await instance.inject({ method: "POST", url: "/admin/domains",
    payload: { hostname: "d.example.com", serviceId: "main-web" } });
  const id = created.json().domain.id;
  const removed = (await instance.inject({ method: "DELETE", url: `/admin/domains/${id}` })).json();
  assert.equal(removed.ok, true);
  assert.match(removed.note, /No proxy configuration had been applied/);
  await instance.close();
});

// ── persistence + migration ─────────────────────────────────────────────────

test("the schema is created and survives a reopen (migration is idempotent)", () => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "gmweb-dom-"));
  const file = require("node:path").join(dir, "cp.db");
  let db = new Database(file);
  let s = new DomainStore(db);
  s.create({ hostname: "p.example.com", serviceId: "main-web" });
  db.close();
  db = new Database(file);
  s = new DomainStore(db); // must not throw on an existing schema
  assert.equal(s.list().length, 1);
  assert.equal(s.byHostname("P.EXAMPLE.COM").hostname_normalized, "p.example.com");
  db.close();
  require("node:fs").rmSync(dir, { recursive: true, force: true });
});

test("localAddresses returns this host's own addresses only", () => {
  const addresses = localAddresses();
  assert.equal(Array.isArray(addresses.ipv4), true);
  assert.equal(Array.isArray(addresses.ipv6), true);
  assert.equal(addresses.ipv4.includes("127.0.0.1"), false, "loopback is not a public target");
});

test("resolveHost tolerates a missing record type without failing the lookup", async () => {
  const records = await resolveHost("v4.example.com", resolverWith({ "v4.example.com": { ipv4: ["203.0.113.5"] } }));
  assert.deepEqual(records.ipv4, ["203.0.113.5"]);
  assert.deepEqual(records.ipv6, []);
  assert.deepEqual(records.errors, []);
});

// ── certificate validation must stay ENABLED ────────────────────────────────

test("the TLS probe never disables certificate validation", async () => {
  // REGRESSION GUARD. An earlier revision passed `rejectUnauthorized: false` so it
  // could inspect an invalid certificate; a security scanner flagged that as
  // "disabling certificate validation" and it was the wrong trade. The precise
  // reason is now derived from the TLS error code instead.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "domainVerification.js"), "utf8");
  // Strip comments first: the file legitimately MENTIONS rejectUnauthorized in the
  // comment documenting its removal, and that must not trip the guard.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(code.includes("rejectUnauthorized"), false,
    "the probe must rely on the secure default rather than override it");

  let seen = null;
  const { probeCertificate } = require("../src/domainVerification");
  const { EventEmitter } = require("node:events");
  const spy = (options) => {
    seen = options;
    const socket = new EventEmitter();
    socket.setTimeout = () => {}; socket.end = () => {}; socket.destroy = () => {};
    process.nextTick(() => { socket.getPeerCertificate = () => CERT(); socket.emit("secureConnect"); });
    return socket;
  };
  await probeCertificate({ hostname: "a.example.com", connect: spy });
  assert.equal(seen.servername, "a.example.com", "SNI must be requested");
  assert.notEqual(seen.rejectUnauthorized, false);
});

test("TLS failures are mapped to precise reasons instead of a generic error", () => {
  const { classifyTlsError } = require("../src/domainVerification");
  const cases = [
    ["CERT_HAS_EXPIRED", "EXPIRED", "CERT_EXPIRED"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "INVALID", "CERT_HOSTNAME_MISMATCH"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNTRUSTED", "CERT_UNTRUSTED"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "UNTRUSTED", "CERT_UNTRUSTED"],
    ["ECONNREFUSED", "NONE", "ROUTING_TLS_FAILED"],
  ];
  for (const [code, sslStatus, errorCode] of cases) {
    const result = classifyTlsError(Object.assign(new Error("x"), { code }));
    assert.equal(result.sslStatus, sslStatus, code);
    assert.equal(result.errorCode, errorCode, code);
    assert.ok(result.message.length > 0, code);
  }
});

test("an untrusted certificate is UNTRUSTED, never reported as healthy", async () => {
  const result = await verifyRouting({ hostname: "a.example.com", service: getService("main-web"),
    connect: fakeConnect(Object.assign(new Error("untrusted"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })),
    fetchImpl: okFetch(200) });
  assert.equal(result.sslStatus, "UNTRUSTED");
  assert.equal(result.errorCode, "CERT_UNTRUSTED");
  assert.equal(result.routingStatus, "ERROR");
});

test("every /admin/domains route is rate-limited by one shared hook", async () => {
  const seen = [];
  const instance = app(store(), { checkRateLimit: (request, bucket) => { seen.push(bucket); return true; } });
  await instance.inject({ method: "GET", url: "/admin/domains" });
  await instance.inject({ method: "GET", url: "/admin/domains/services" });
  await instance.inject({ method: "POST", url: "/admin/domains",
    payload: { hostname: "rl.example.com", serviceId: "main-web" } });
  assert.ok(seen.includes("admin-domains"),
    "the shared hook must limit every domains route, including list and services");
  await instance.close();
});

test("a rate-limited caller is refused with 429", async () => {
  const instance = app(store(), { checkRateLimit: () => false });
  const response = await instance.inject({ method: "GET", url: "/admin/domains" });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error, "rate_limited");
  await instance.close();
});
