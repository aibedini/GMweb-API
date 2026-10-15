"use strict";
/**
 * Domain management (Phase 1 — VERIFICATION ONLY).
 *
 * This module deliberately CANNOT change routing or TLS. The GMweb API runs as
 * the unprivileged `gmweb` user, which on the production host cannot write
 * /etc/nginx, cannot write /etc/letsencrypt, and cannot run certbot:
 *
 *     gmweb cannot write /etc/nginx/sites-available
 *     gmweb cannot write /etc/letsencrypt/live
 *     gmweb cannot run certbot
 *     sudoers for gmweb: only systemctl start/stop vnc+novnc, restart gmweb-api,
 *                        restart gmweb-chrome
 *
 * Applying configuration needs root and therefore a separate, narrowly-scoped
 * privileged helper. Until that exists and is reviewed, this module only
 * RECORDS intent and REPORTS observed reality (DNS, TLS/SNI, HTTP reachability).
 * It must never report a domain as healthy because a row was written.
 */

/**
 * The services a domain may be assigned to.
 *
 * This is a HARD-CODED ALLOWLIST, not user input, and it is the SSRF control:
 * an assignment can only ever point at the single local application upstream.
 * On this deployment there is ONE Fastify process (127.0.0.1:3030) serving
 * several path surfaces — there is no separate admin port or public-API port,
 * so "assignment" selects a PATH SURFACE plus the auth it implies.
 */
const SERVICE_REGISTRY = Object.freeze({
  "main-web": Object.freeze({
    id: "main-web",
    label: "Main GMweb web application",
    upstream: "127.0.0.1:3030",
    pathPrefix: "/",
    publicSurface: true,
    requiresAuth: false,
    description: "PWA at /web and the operator dashboard at /dashboard.",
  }),
  "public-api": Object.freeze({
    id: "public-api",
    label: "Public API",
    upstream: "127.0.0.1:3030",
    pathPrefix: "/api",
    publicSurface: true,
    requiresAuth: true,
    description: "Versioned /api/v1 surface. Every route authenticates.",
  }),
  "admin": Object.freeze({
    id: "admin",
    label: "Admin API",
    upstream: "127.0.0.1:3030",
    pathPrefix: "/admin",
    publicSurface: false,
    requiresAuth: true,
    description: "Master-token operator surface. Should not be exposed publicly.",
  }),
});

function serviceIds() { return Object.keys(SERVICE_REGISTRY); }
function getService(id) { return SERVICE_REGISTRY[String(id || "")] || null; }

/** A DNS label: letters/digits/hyphen, no leading or trailing hyphen. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Total hostname length limit (RFC 1035). */
const MAX_HOSTNAME = 253;

/**
 * Normalize and validate a hostname.
 *
 * Returns `{ ok: true, hostname, normalized }` or `{ ok: false, code, message }`.
 *
 * SECURITY: this is the ONLY way a hostname enters the system. It is used for
 * storage, for DNS lookups, and — once the privileged helper exists — as an
 * argument. It therefore rejects anything that could be misinterpreted by a
 * shell, a resolver, or an nginx directive: no whitespace, no shell
 * metacharacters, no path separators, no leading dots or hyphens, no `..`, no
 * embedded ports, no scheme, no userinfo, no wildcards (a wildcard needs DNS-01
 * and a provider integration that does not exist here).
 */
function normalizeHostname(input) {
  if (typeof input !== "string") {
    return { ok: false, code: "INVALID_HOSTNAME", message: "Hostname must be a string." };
  }
  // Lowercase and strip a single trailing root dot; nothing else is rewritten.
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) {
    return { ok: false, code: "INVALID_HOSTNAME", message: "Hostname is empty." };
  }
  if (trimmed.length > MAX_HOSTNAME) {
    return { ok: false, code: "INVALID_HOSTNAME", message: `Hostname exceeds ${MAX_HOSTNAME} characters.` };
  }
  if (trimmed.includes("*")) {
    return { ok: false, code: "WILDCARD_UNSUPPORTED",
      message: "Wildcard certificates require DNS-01 and a configured DNS provider, which is not available." };
  }
  // Anything outside [a-z0-9.-] is rejected outright: this is what keeps shell
  // metacharacters, slashes, colons, '@', quotes and newlines out permanently.
  if (!/^[a-z0-9.-]+$/.test(trimmed)) {
    return { ok: false, code: "INVALID_HOSTNAME",
      message: "Hostname may contain only letters, digits, dots and hyphens." };
  }
  if (trimmed.includes("..")) {
    return { ok: false, code: "INVALID_HOSTNAME", message: "Hostname contains an empty label." };
  }
  if (trimmed.startsWith(".") || trimmed.startsWith("-") || trimmed.endsWith("-") || trimmed.endsWith(".")) {
    return { ok: false, code: "INVALID_HOSTNAME", message: "Hostname may not start or end with a dot or hyphen." };
  }
  const labels = trimmed.split(".");
  if (labels.length < 2) {
    return { ok: false, code: "INVALID_HOSTNAME", message: "Hostname must be fully qualified (example.com)." };
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      return { ok: false, code: "INVALID_HOSTNAME", message: `Invalid label "${label}".` };
    }
  }
  // A purely numeric TLD (e.g. 1.2.3.4) is an address, not a hostname.
  if (/^\d+$/.test(labels[labels.length - 1])) {
    return { ok: false, code: "INVALID_HOSTNAME", message: "Hostname may not end in a numeric label." };
  }
  return { ok: true, hostname: trimmed, normalized: trimmed };
}

/** The upstream a domain routes to. Always from the registry, never user input. */
function upstreamFor(serviceId) {
  const service = getService(serviceId);
  return service ? service.upstream : null;
}

class DomainStore {
  constructor(db) {
    this.db = db;
    // Inline migration, matching the existing convention (src/sendStore.js) —
    // this repository has no migrations directory.
    db.exec(`
      CREATE TABLE IF NOT EXISTS domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname TEXT NOT NULL,
        hostname_normalized TEXT NOT NULL UNIQUE,
        service_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING_DNS',
        dns_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        dns_checked_at INTEGER,
        dns_observed TEXT,
        ssl_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        ssl_provider TEXT,
        cert_name TEXT,
        cert_not_after INTEGER,
        cert_issuer TEXT,
        routing_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        routing_checked_at INTEGER,
        auto_renew INTEGER NOT NULL DEFAULT 1,
        last_error_code TEXT,
        last_error_message TEXT,
        last_operation_id TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // Additive columns are applied the same way the rest of the codebase does it,
    // so an existing database upgrades in place without a data rewrite.
    for (const clause of [
      "ALTER TABLE domains ADD COLUMN cert_issuer TEXT",
      "ALTER TABLE domains ADD COLUMN routing_status TEXT NOT NULL DEFAULT 'UNKNOWN'",
      "ALTER TABLE domains ADD COLUMN routing_checked_at INTEGER",
      // Phase 2: what the privileged helper last applied, and for which service,
      // so a later service change is visible as STALE rather than "applied".
      "ALTER TABLE domains ADD COLUMN proxy_status TEXT NOT NULL DEFAULT 'NONE'",
      "ALTER TABLE domains ADD COLUMN proxy_service_id TEXT",
      "ALTER TABLE domains ADD COLUMN proxy_applied_at INTEGER",
    ]) {
      try { db.exec(clause); } catch { /* already present */ }
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_domains_service ON domains(service_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_domains_status ON domains(status)");
    // Operation history. Kept separate from the domain row so a failed attempt is
    // never overwritten by a later success — the operator needs to see both.
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT,
        at INTEGER NOT NULL
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_domain_operations_domain ON domain_operations(domain_id, at DESC)");
    // NOTE: private keys are NEVER stored here. Only a cert NAME that refers to
    // /etc/letsencrypt/live/<name>, which root owns and this process cannot read.
  }

  /** Append an operation. Never stores secrets, paths or key material. */
  recordOperation(domainId, { kind, outcome, detail = null }) {
    const row = this.byId(domainId);
    if (!row) return { error: "NOT_FOUND" };
    this.db.prepare("INSERT INTO domain_operations (domain_id, kind, outcome, detail, at) VALUES (?,?,?,?,?)")
      .run(row.id, String(kind).slice(0, 40), String(outcome).slice(0, 20),
        detail ? String(detail).slice(0, 500) : null, Date.now());
    this.db.prepare("UPDATE domains SET last_operation_id=? WHERE id=?")
      .run(String(this.db.prepare("SELECT MAX(id) AS id FROM domain_operations WHERE domain_id=?").get(row.id).id), row.id);
    return { ok: true };
  }

  operations(domainId, limit = 50) {
    const row = this.byId(domainId);
    if (!row) return [];
    const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.db.prepare("SELECT kind, outcome, detail, at FROM domain_operations WHERE domain_id=? ORDER BY at DESC, id DESC LIMIT ?")
      .all(row.id, capped)
      .map((entry) => ({ kind: entry.kind, outcome: entry.outcome, detail: entry.detail,
        at: new Date(entry.at).toISOString() }));
  }

  byId(id) {
    const value = Number(id);
    if (!Number.isSafeInteger(value)) return null;
    return this.db.prepare("SELECT * FROM domains WHERE id=?").get(value) || null;
  }

  byHostname(hostname) {
    const normalized = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!normalized) return null;
    return this.db.prepare("SELECT * FROM domains WHERE hostname_normalized=?").get(normalized) || null;
  }

  list() {
    return this.db.prepare("SELECT * FROM domains ORDER BY hostname_normalized ASC").all();
  }

  create({ hostname, serviceId, createdBy = null, autoRenew = true }) {
    const parsed = normalizeHostname(hostname);
    if (!parsed.ok) return { error: parsed.code, message: parsed.message };
    const service = getService(serviceId);
    if (!service) return { error: "INVALID_SERVICE", message: `Unknown service "${serviceId}".` };
    if (this.byHostname(parsed.normalized)) {
      return { error: "DUPLICATE_DOMAIN", message: `${parsed.normalized} is already managed.` };
    }
    // A hostname may back exactly one service. Re-using one would silently
    // rewrite an existing production route, so it is refused rather than merged.
    const now = Date.now();
    const info = this.db.prepare(`INSERT INTO domains
      (hostname, hostname_normalized, service_id, status, dns_status, ssl_status, routing_status,
       auto_renew, created_by, created_at, updated_at)
      VALUES (@hostname,@normalized,@serviceId,'PENDING_DNS','UNKNOWN','UNKNOWN','UNKNOWN',@autoRenew,@createdBy,@now,@now)`)
      .run({ hostname: parsed.hostname, normalized: parsed.normalized, serviceId: service.id,
        autoRenew: autoRenew ? 1 : 0, createdBy, now });
    return { ok: true, domain: this.byId(info.lastInsertRowid) };
  }

  /** Re-assign the service. Refuses an unknown service; records intent only. */
  assign(id, serviceId, { updatedBy = null } = {}) {
    const row = this.byId(id);
    if (!row) return { error: "NOT_FOUND" };
    const service = getService(serviceId);
    if (!service) return { error: "INVALID_SERVICE", message: `Unknown service "${serviceId}".` };
    this.db.prepare("UPDATE domains SET service_id=?, status='READY_FOR_SSL', updated_at=? WHERE id=?")
      .run(service.id, Date.now(), row.id);
    void updatedBy;
    return { ok: true, domain: this.byId(row.id) };
  }

  update(id, patch = {}) {
    const row = this.byId(id);
    if (!row) return { error: "NOT_FOUND" };
    const fields = [];
    const values = { id: row.id, now: Date.now() };
    if (patch.autoRenew !== undefined) { fields.push("auto_renew=@autoRenew"); values.autoRenew = patch.autoRenew ? 1 : 0; }
    if (patch.serviceId !== undefined) {
      const service = getService(patch.serviceId);
      if (!service) return { error: "INVALID_SERVICE", message: `Unknown service "${patch.serviceId}".` };
      fields.push("service_id=@serviceId"); values.serviceId = service.id;
    }
    if (!fields.length) return { error: "NO_CHANGES" };
    this.db.prepare(`UPDATE domains SET ${fields.join(", ")}, updated_at=@now WHERE id=@id`).run(values);
    return { ok: true, domain: this.byId(row.id) };
  }

  remove(id) {
    const row = this.byId(id);
    if (!row) return { error: "NOT_FOUND" };
    this.db.prepare("DELETE FROM domains WHERE id=?").run(row.id);
    return { ok: true, removed: row.hostname_normalized };
  }

  /** Record the outcome of a privileged proxy action. `status`: APPLIED | NONE. A failed action changes nothing: the helper rolls back, so the previous state still holds. */
  recordProxy(id, { status, serviceId = null }) {
    const row = this.byId(id);
    if (!row) return { error: "NOT_FOUND" };
    if (!["APPLIED", "NONE"].includes(status)) return { error: "INVALID_STATUS" };
    const now = Date.now();
    if (status === "APPLIED") {
      this.db.prepare("UPDATE domains SET proxy_status='APPLIED', proxy_service_id=?, proxy_applied_at=?, updated_at=? WHERE id=?")
        .run(serviceId || row.service_id, now, now, row.id);
    } else if (status === "NONE") {
      this.db.prepare("UPDATE domains SET proxy_status='NONE', proxy_service_id=NULL, proxy_applied_at=NULL, updated_at=? WHERE id=?")
        .run(now, row.id);
    }
    return { ok: true, domain: this.byId(row.id) };
  }

  /** Persist an observation. Always the OBSERVED truth, never an assumption. */
  recordCheck(id, { dnsStatus, dnsObserved, routingStatus, sslStatus, sslProvider,
    certName, certNotAfter, certIssuer, errorCode, errorMessage, operationId } = {}) {
    const row = this.byId(id);
    if (!row) return { error: "NOT_FOUND" };
    const now = Date.now();
    this.db.prepare(`UPDATE domains SET
        dns_status=COALESCE(@dnsStatus, dns_status),
        dns_observed=COALESCE(@dnsObserved, dns_observed),
        dns_checked_at=CASE WHEN @dnsStatus IS NULL THEN dns_checked_at ELSE @now END,
        routing_status=COALESCE(@routingStatus, routing_status),
        routing_checked_at=CASE WHEN @routingStatus IS NULL THEN routing_checked_at ELSE @now END,
        ssl_status=COALESCE(@sslStatus, ssl_status),
        ssl_provider=COALESCE(@sslProvider, ssl_provider),
        cert_name=COALESCE(@certName, cert_name),
        cert_not_after=COALESCE(@certNotAfter, cert_not_after),
        cert_issuer=COALESCE(@certIssuer, cert_issuer),
        last_error_code=@errorCode,
        last_error_message=@errorMessage,
        last_operation_id=COALESCE(@operationId, last_operation_id),
        status=@status,
        updated_at=@now
      WHERE id=@id`).run({
      id: row.id, now,
      dnsStatus: dnsStatus ?? null, dnsObserved: dnsObserved ?? null,
      routingStatus: routingStatus ?? null, sslStatus: sslStatus ?? null,
      sslProvider: sslProvider ?? null, certName: certName ?? null,
      certNotAfter: certNotAfter ?? null, certIssuer: certIssuer ?? null,
      errorCode: errorCode ?? null, errorMessage: errorMessage ?? null,
      operationId: operationId ?? null,
      status: deriveStatus({ ...row, dns_status: dnsStatus ?? row.dns_status,
        routing_status: routingStatus ?? row.routing_status, ssl_status: sslStatus ?? row.ssl_status,
        last_error_code: errorCode ?? null }),
    });
    return { ok: true, domain: this.byId(row.id) };
  }
}

/**
 * The single derived status shown to the operator.
 *
 * Ordering is deliberate: an ERROR is never masked by a stale success, and
 * "SSL_ACTIVE" requires an OBSERVED routing success — never merely a stored row.
 */
function deriveStatus(row) {
  if (!row) return "CONFIGURATION_ERROR";
  if (row.last_error_code) {
    // A MISSING record is the normal "you have not added the DNS yet" state, so it
    // is PENDING_DNS. A record that exists but points elsewhere is DNS_INVALID —
    // conflating the two would tell an operator their DNS is wrong when they
    // simply have not created it.
    if (row.last_error_code === "DNS_MISSING") return "PENDING_DNS";
    if (["DNS_NOT_RESOLVING", "DNS_TARGET_MISMATCH", "DNS_LOOKUP_FAILED"].includes(row.last_error_code)) return "DNS_INVALID";
    if (String(row.last_error_code).startsWith("ROUTING_")) return "ROUTING_ERROR";
    if (row.last_error_code === "CERT_EXPIRED") return "EXPIRED";
    if (row.last_error_code === "CERT_RENEWAL_REQUIRED") return "RENEWAL_REQUIRED";
    if (row.last_error_code === "CERT_HOSTNAME_MISMATCH") return "SSL_INVALID";
    return "CONFIGURATION_ERROR";
  }
  if (row.dns_status !== "OK") return "PENDING_DNS";
  if (row.routing_status !== "OK") return "READY_FOR_SSL";
  if (row.ssl_status !== "ACTIVE") return "READY_FOR_SSL";
  return "SSL_ACTIVE";
}

module.exports = { DomainStore, normalizeHostname, getService, serviceIds,
  SERVICE_REGISTRY, upstreamFor, deriveStatus };
