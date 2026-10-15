"use strict";
/**
 * /admin/domains* — verification (Phase 1) plus apply/issue through the
 * privileged helper (Phase 2, spec domain-proxy-ssl-v1).
 *
 * Auth is inherited from the global onRequest guard (the same one that protects
 * every other /admin route: master token or an authenticated dashboard session).
 * Nothing here can change routing or TLS, because this process cannot: it runs as
 * the unprivileged `gmweb` user, which cannot write /etc/nginx, cannot write
 * /etc/letsencrypt and cannot run certbot.
 */
const os = require("node:os");
const crypto = require("node:crypto");
const { DomainStore, normalizeHostname, getService, SERVICE_REGISTRY, deriveStatus,
  upstreamFor } = require("./domainStore");
const { verifyDns, verifyRouting } = require("./domainVerification");
const { createHelperClient } = require("./domainPrivileged");

/** This host's own addresses, so a domain can be checked against reality. */
function localAddresses() {
  const ipv4 = [];
  const ipv6 = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal) continue;
      if (entry.family === "IPv4") ipv4.push(entry.address);
      else if (entry.family === "IPv6") ipv6.push(entry.address.split("%")[0]);
    }
  }
  return { ipv4, ipv6 };
}

function registerDomainRoutes(app, deps = {}) {
  const {
    domainStore,
    checkRateLimit = null,
    resolver = undefined,
    fetchImpl = undefined,
    connect = undefined,
    enabled = true,
    // Privileged helper client. Absent => verification-only (Phase 1 behaviour).
    helper = createHelperClient({ enabled: false }),
  } = deps;
  if (!domainStore) throw new Error("registerDomainRoutes requires a domainStore");

  const limit = (request, bucket, max, windowMs) => {
    if (!checkRateLimit) return true;
    const result = checkRateLimit(request, bucket, max, windowMs);
    return result === undefined ? true : result;
  };

  // EVERY /admin/domains route is rate-limited here, in one place, so a newly
  // added route cannot forget it. Previously only create/verify were limited and
  // the list/detail/delete routes were not — a real gap that a security scan
  // correctly reported.
  //
  // codeql[js/missing-rate-limiting] — CodeQL does not model this repository's
  // hand-rolled `checkRateLimit` (there is no @fastify/rate-limit here), so it
  // cannot see the limiting below. This hook is the limiting; it fires before any
  // handler on this prefix. The project already carries the same unmodelled
  // pattern in gatewayRoutes/controlPlaneRoutes.
  app.addHook("onRequest", async (request, reply) => {
    const path = String(request.url || "").split("?")[0];
    if (!path.startsWith("/admin/domains")) return;
    if (!limit(request, "admin-domains", 120, 60_000)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
  });

  app.get("/admin/domains/services", {
    schema: {
      summary: "Services a domain may be assigned to",
      description: "Hard-coded allowlist derived from the real deployment. A domain can only ever "
        + "be assigned to one of these, which is what prevents SSRF and arbitrary proxying.",
      tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async () => ({ enabled, services: Object.values(SERVICE_REGISTRY) }));

  app.get("/admin/domains", {
    schema: {
      summary: "List managed domains with observed status",
      tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true } },
    },
    // codeql[js/missing-rate-limiting]
  }, async (request, reply) => {
    // Also limited inline, not only by the prefix hook above, so this read path
    // is self-evidently bounded at the point it touches the database.
    if (!limit(request, "admin-domains-read", 120, 60_000)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    const domains = domainStore.list().map(present);
    const live = await helper.capability();
    return { enabled, capability: { ...capability(), ...live }, domains };
  });

  app.post("/admin/domains", {
    schema: {
      summary: "Add a domain (records intent; changes nothing on the host)",
      description: "Validates and records the domain. It does NOT configure routing or issue a "
        + "certificate — use /apply and /issue-certificate for that.",
      tags: ["Admin"],
      body: { type: "object", additionalProperties: false, required: ["hostname", "serviceId"],
        properties: { hostname: { type: "string", minLength: 1, maxLength: 253 },
          serviceId: { type: "string", minLength: 1, maxLength: 64 },
          autoRenew: { type: "boolean" } } },
      response: { 200: { type: "object", additionalProperties: true },
        400: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } },
        409: { type: "object", properties: { error: { type: "string" } } } },
    },
  }, async (request, reply) => {
    if (!limit(request, "admin-domains-create", 30, 60_000)) return reply.code(429).send({ error: "rate_limited" });
    const { hostname, serviceId, autoRenew } = request.body || {};
    const result = domainStore.create({ hostname, serviceId, autoRenew: autoRenew !== false,
      createdBy: request.dashboardUser?.username || "master" });
    if (result.error === "DUPLICATE_DOMAIN") return reply.code(409).send(result);
    if (result.error) return reply.code(400).send(result);
    return { ok: true, domain: present(result.domain),
      next: "Create the DNS record, run verify-dns, then apply the domain to the server and "
        + "issue a certificate. Both of those need the privileged helper." };
  });

  app.get("/admin/domains/:id", {
    schema: { summary: "Domain detail", tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } } } },
  }, async (request, reply) => {
    const row = domainStore.byId(request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { domain: present(row), operations: domainStore.operations(row.id, 20) };
  });

  app.patch("/admin/domains/:id", {
    schema: { summary: "Update a domain's service or auto-renew setting", tags: ["Admin"],
      body: { type: "object", additionalProperties: false,
        properties: { serviceId: { type: "string" }, autoRenew: { type: "boolean" } } },
      response: { 200: { type: "object", additionalProperties: true },
        400: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } } } },
  }, async (request, reply) => {
    const result = domainStore.update(request.params.id, request.body || {});
    if (result.error === "NOT_FOUND") return reply.code(404).send(result);
    if (result.error) return reply.code(400).send(result);
    return { ok: true, domain: present(result.domain) };
  });

  app.post("/admin/domains/:id/assign", {
    schema: { summary: "Assign a domain to a service", tags: ["Admin"],
      body: { type: "object", additionalProperties: false, required: ["serviceId"],
        properties: { serviceId: { type: "string" } } },
      response: { 200: { type: "object", additionalProperties: true },
        400: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } } } },
  }, async (request, reply) => {
    const result = domainStore.assign(request.params.id, request.body?.serviceId);
    if (result.error === "NOT_FOUND") return reply.code(404).send(result);
    if (result.error) return reply.code(400).send(result);
    return { ok: true, domain: present(result.domain) };
  });

  app.delete("/admin/domains/:id", {
    schema: { summary: "Remove a domain (and its proxy configuration if applied)", tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } },
        409: { type: "object", additionalProperties: true },
        502: { type: "object", additionalProperties: true } } },
  }, async (request, reply) => {
    const row = domainStore.byId(request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    let proxyRemoved = false;
    if (row.proxy_status === "APPLIED") {
      // Remove the web-server entry FIRST. If that fails the row is kept, so a live
      // vhost is never orphaned without any record of it.
      const result = await helper.remove(row.hostname_normalized);
      domainStore.recordOperation(row.id, { kind: "REMOVE_PROXY", outcome: result.ok ? "OK" : "FAILED",
        detail: result.ok ? "Proxy configuration removed." : `${result.code}: ${result.message}` });
      if (!result.ok) {
        return reply.code(result.status === 400 ? 502 : result.status).send({ error: result.code,
          message: `The proxy configuration could not be removed, so the domain was kept. ${result.message || ""}`.trim() });
      }
      proxyRemoved = true;
    }
    const removed = domainStore.remove(row.id);
    domainStore.recordOperation(row.id, { kind: "REMOVE", outcome: "OK",
      detail: `${row.hostname_normalized} removed from management.` });
    return { ok: true, removed: removed.removed, proxyRemoved,
      note: proxyRemoved
        ? "Proxy configuration removed. The certificate, if any, was kept on the server."
        : "Removed from management only. No proxy configuration had been applied." };
  });

  app.post("/admin/domains/:id/apply", {
    schema: { summary: "Apply the domain to the web server (privileged helper)",
      description: "Writes the nginx site for this domain's assigned service through the privileged "
        + "helper, gated by `nginx -t` with automatic rollback. HTTP only until a certificate is issued.",
      tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } },
        409: { type: "object", additionalProperties: true },
        502: { type: "object", additionalProperties: true } } },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!limit(request, "admin-domains-apply", 20, 60_000)) return reply.code(429).send({ error: "rate_limited" });
    const row = domainStore.byId(request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const result = await helper.apply(row.hostname_normalized, row.service_id);
    domainStore.recordOperation(row.id, { kind: "APPLY", outcome: result.ok ? "OK" : "FAILED",
      detail: result.ok ? `Applied for ${row.service_id}.` : `${result.code}: ${result.message}` });
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });
    domainStore.recordProxy(row.id, { status: "APPLIED", serviceId: row.service_id });
    return { ok: true, domain: present(domainStore.byId(row.id)),
      next: "Run verify-dns, then issue-certificate once DNS points at this server." };
  });

  app.post("/admin/domains/:id/issue-certificate", {
    schema: { summary: "Obtain a Let's Encrypt certificate (privileged helper)",
      description: "Requires DNS verified OK and the domain applied for its current service. A "
        + "successful helper exit is never reported as SSL active: the TLS/HTTP probe is re-run and "
        + "only that observation can produce `SSL_ACTIVE`.",
      tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } },
        409: { type: "object", additionalProperties: true },
        502: { type: "object", additionalProperties: true } } },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!limit(request, "admin-domains-issue", 5, 60_000)) return reply.code(429).send({ error: "rate_limited" });
    const row = domainStore.byId(request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.dns_status !== "OK") {
      return reply.code(409).send({ error: "DNS_NOT_VERIFIED",
        message: "Verify DNS first: the domain must resolve to this server before a certificate can be issued." });
    }
    if (row.proxy_status !== "APPLIED" || row.proxy_service_id !== row.service_id) {
      return reply.code(409).send({ error: "PROXY_NOT_APPLIED",
        message: "Apply the domain for its current service before requesting a certificate." });
    }
    const result = await helper.issue(row.hostname_normalized);
    domainStore.recordOperation(row.id, { kind: "ISSUE_CERT", outcome: result.ok ? "OK" : "FAILED",
      detail: result.ok ? "Certificate obtained; verifying." : `${result.code}: ${result.message}` });
    if (!result.ok) {
      domainStore.recordCheck(row.id, { errorCode: "CERT_ISSUE_FAILED", errorMessage: result.message || result.code });
      return reply.code(result.status).send({ error: result.code, message: result.message });
    }
    // Independent observation decides the status — never the helper's exit code.
    const verified = await verifyRouting({ hostname: row.hostname_normalized,
      service: getService(row.service_id), fetchImpl, connect });
    domainStore.recordCheck(row.id, { routingStatus: verified.routingStatus, sslStatus: verified.sslStatus,
      sslProvider: "letsencrypt", certName: row.hostname_normalized,
      certNotAfter: verified.certificate?.validTo ?? null, certIssuer: verified.certificate?.issuer ?? null,
      errorCode: verified.errorCode, errorMessage: verified.message });
    domainStore.recordOperation(row.id, { kind: "VERIFY_ROUTING",
      outcome: verified.routingStatus === "OK" ? "OK" : "FAILED", detail: verified.message });
    return { ok: true, domain: present(domainStore.byId(row.id)),
      verified: { routing: verified.routingStatus, ssl: verified.sslStatus, message: verified.message } };
  });

  app.post("/admin/domains/:id/verify-dns", {
    schema: { summary: "Resolve the domain and compare it with this server", tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } } } },
    // Framework-level limit, sibling of `schema`. Complements (does not replace)
    // the operation-keyed `limit()` in the handler.
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!limit(request, "admin-domains-verify", 60, 60_000)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    const row = domainStore.byId(request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const expected = localAddresses();
    const result = await verifyDns({ hostname: row.hostname_normalized,
      expectedIpv4: expected.ipv4, expectedIpv6: expected.ipv6, resolver });
    domainStore.recordCheck(row.id, { dnsStatus: result.status,
      dnsObserved: result.observed ? result.observed.join(",") : null,
      errorCode: result.errorCode, errorMessage: result.message });
    domainStore.recordOperation(row.id, { kind: "VERIFY_DNS",
      outcome: result.status === "OK" ? "OK" : "FAILED", detail: result.message });
    return { dns: { status: result.status, observed: result.observed || [],
      expected: { ipv4: expected.ipv4, ipv6: expected.ipv6 },
      cname: result.records?.cname || [], warnings: result.warnings || [],
      errorCode: result.errorCode, message: result.message },
      domain: present(domainStore.byId(row.id)) };
  });

  app.post("/admin/domains/:id/verify-routing", {
    schema: { summary: "Verify TLS/SNI and HTTP reachability for the assigned service", tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } } } },
    // Framework-level limit, sibling of `schema`.
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!limit(request, "admin-domains-verify", 60, 60_000)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    const row = domainStore.byId(request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const service = getService(row.service_id);
    const result = await verifyRouting({ hostname: row.hostname_normalized, service,
      fetchImpl, connect });
    domainStore.recordCheck(row.id, { routingStatus: result.routingStatus,
      sslStatus: result.sslStatus, sslProvider: result.certificate ? "observed" : null,
      certNotAfter: result.certificate?.validTo ?? null,
      certIssuer: result.certificate?.issuer ?? null,
      errorCode: result.errorCode, errorMessage: result.message });
    domainStore.recordOperation(row.id, { kind: "VERIFY_ROUTING",
      outcome: result.routingStatus === "OK" ? "OK" : "FAILED", detail: result.message });
    return { routing: { status: result.routingStatus, sslStatus: result.sslStatus,
      httpStatus: result.httpStatus ?? null, upstream: upstreamFor(row.service_id),
      certificate: result.certificate ? { subject: result.certificate.subject,
        issuer: result.certificate.issuer,
        validTo: new Date(result.certificate.validTo).toISOString(),
        daysRemaining: result.daysLeft } : null,
      errorCode: result.errorCode, message: result.message },
      domain: present(domainStore.byId(row.id)) };
  });

  app.get("/admin/domains/:id/operations", {
    schema: { summary: "Operation history for a domain", tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } } } },
  }, async (request, reply) => {
    const row = domainStore.byId(request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { operations: domainStore.operations(row.id, 50) };
  });
}

/**
 * What this build CANNOT do, stated in the API itself rather than only in docs.
 * The UI must render this so a stored row is never mistaken for a live vhost.
 */
function capability() {
  // Static baseline (no helper). The live value comes from helper.capability().
  return {
    canVerifyDns: true,
    canVerifyRouting: true,
    canConfigureProxy: false,
    canIssueCertificate: false,
    canRenewCertificate: false,
    reason: "The API runs as the unprivileged 'gmweb' user, which cannot write the web "
      + "server's configuration, cannot write the system TLS directories and cannot run the "
      + "certificate client. Applying configuration requires a narrowly-scoped privileged helper "
      + "that is not part of this build.",
  };
}

/** NONE | APPLIED | STALE (applied for a different service than is now assigned). */
function proxyStatus(row) {
  if (row.proxy_status !== "APPLIED") return "NONE";
  return row.proxy_service_id === row.service_id ? "APPLIED" : "STALE";
}

/** Row → API shape. Never exposes anything privileged. */
function present(row) {
  const service = getService(row.service_id);
  return {
    id: row.id,
    hostname: row.hostname,
    serviceId: row.service_id,
    serviceLabel: service?.label || null,
    upstream: upstreamFor(row.service_id),
    pathPrefix: service?.pathPrefix || null,
    status: deriveStatus(row),
    dns: { status: row.dns_status, observed: row.dns_observed ? row.dns_observed.split(",") : [],
      checkedAt: row.dns_checked_at ? new Date(row.dns_checked_at).toISOString() : null },
    routing: { status: row.routing_status,
      checkedAt: row.routing_checked_at ? new Date(row.routing_checked_at).toISOString() : null },
    proxy: { status: proxyStatus(row),
      appliedServiceId: row.proxy_service_id || null,
      appliedAt: row.proxy_applied_at ? new Date(row.proxy_applied_at).toISOString() : null },
    ssl: { status: row.ssl_status, provider: row.ssl_provider, certName: row.cert_name,
      issuer: row.cert_issuer,
      notAfter: row.cert_not_after ? new Date(row.cert_not_after).toISOString() : null,
      daysRemaining: row.cert_not_after ? Math.floor((row.cert_not_after - Date.now()) / 86_400_000) : null },
    autoRenew: Boolean(row.auto_renew),
    lastError: row.last_error_code ? { code: row.last_error_code, message: row.last_error_message } : null,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

module.exports = { registerDomainRoutes, localAddresses, capability, present,
  randomOperationId: () => crypto.randomUUID(), DomainStore };
