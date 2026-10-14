"use strict";
/**
 * /admin/domains* — Phase 1, VERIFICATION ONLY.
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
  } = deps;
  if (!domainStore) throw new Error("registerDomainRoutes requires a domainStore");

  const limit = (request, bucket, max, windowMs) => {
    if (!checkRateLimit) return true;
    const result = checkRateLimit(request, bucket, max, windowMs);
    return result === undefined ? true : result;
  };

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
  }, async () => {
    const domains = domainStore.list().map(present);
    return { enabled, capability: capability(), domains };
  });

  app.post("/admin/domains", {
    schema: {
      summary: "Add a domain (records intent; changes nothing on the host)",
      description: "Validates and records the domain. It does NOT configure routing or issue a "
        + "certificate — that requires a privileged helper this process does not have.",
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
      next: "Run verify-dns, then verify-routing. Configuring the proxy and issuing a certificate "
        + "require the privileged helper, which is not available in this build." };
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
    schema: { summary: "Remove a domain from management", tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } } } },
  }, async (request, reply) => {
    const row = domainStore.byId(request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const result = domainStore.remove(row.id);
    domainStore.recordOperation(row.id, { kind: "REMOVE", outcome: "OK",
      detail: `${row.hostname_normalized} removed from management (no host configuration was changed).` });
    return { ok: true, removed: result.removed,
      note: "Removed from management only. Any existing proxy configuration and certificate were "
        + "NOT touched — this build has no privilege to change them." };
  });

  app.post("/admin/domains/:id/verify-dns", {
    schema: { summary: "Resolve the domain and compare it with this server", tags: ["Admin"],
      response: { 200: { type: "object", additionalProperties: true },
        404: { type: "object", properties: { error: { type: "string" } } } } },
  }, async (request, reply) => {
    if (!limit(request, "admin-domains-verify", 60, 60_000)) return reply.code(429).send({ error: "rate_limited" });
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
  }, async (request, reply) => {
    if (!limit(request, "admin-domains-verify", 60, 60_000)) return reply.code(429).send({ error: "rate_limited" });
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
