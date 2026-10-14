"use strict";
/**
 * Domain verification — OBSERVED truth only.
 *
 * Everything here answers "what is actually true right now?" and may therefore
 * report failure. Nothing here may report success on the basis of stored intent.
 *
 * All network access is injectable so the logic is testable without touching
 * real DNS or real TLS endpoints.
 */
const dns = require("node:dns").promises;
const tls = require("node:tls");

/** Days before expiry at which renewal becomes the operator's problem. */
const RENEWAL_WINDOW_DAYS = 30;

/**
 * Resolve a hostname's A, AAAA and CNAME records.
 *
 * A missing record type is NOT an error — it is reported as an empty list, so a
 * v4-only host is not treated as broken.
 */
async function resolveHost(hostname, resolver = dns) {
  const out = { ipv4: [], ipv6: [], cname: [], errors: [] };
  try { out.ipv4 = await resolver.resolve4(hostname); }
  catch (error) { if (error.code !== "ENODATA" && error.code !== "ENOTFOUND") out.errors.push(`A:${error.code}`); }
  try { out.ipv6 = await resolver.resolve6(hostname); }
  catch (error) { if (error.code !== "ENODATA" && error.code !== "ENOTFOUND") out.errors.push(`AAAA:${error.code}`); }
  try { out.cname = await resolver.resolveCname(hostname); }
  catch { /* a CNAME is optional and mutually exclusive with A/AAAA */ }
  return out;
}

/**
 * Verify that a hostname resolves to THIS server.
 *
 * A CNAME is followed implicitly by the resolver, so a host that CNAMEs to the
 * server resolves to the server's address and passes. What must NOT pass is a
 * host pointing somewhere else — that is the `DNS_TARGET_MISMATCH` case, and it
 * is the single most common reason certificate issuance fails.
 */
async function verifyDns({ hostname, expectedIpv4 = [], expectedIpv6 = [], resolver = dns }) {
  let records;
  try {
    records = await resolveHost(hostname, resolver);
  } catch (error) {
    return { status: "ERROR", errorCode: "DNS_LOOKUP_FAILED",
      message: `DNS lookup failed: ${error.code || error.message}`, records: null };
  }
  if (records.errors.length && !records.ipv4.length && !records.ipv6.length) {
    return { status: "ERROR", errorCode: "DNS_LOOKUP_FAILED",
      message: `DNS lookup failed (${records.errors.join(", ")}).`, records };
  }
  const observed = [...records.ipv4, ...records.ipv6];
  if (observed.length === 0) {
    return { status: "MISSING", errorCode: "DNS_MISSING",
      message: `${hostname} has no A or AAAA record. Add one pointing at this server.`, records };
  }
  // A match on either family is sufficient; a mismatch on the other family is
  // surfaced as a warning rather than a hard failure, because dual-stack hosts
  // frequently publish one family late.
  const v4Match = records.ipv4.some((address) => expectedIpv4.includes(address));
  const v6Match = records.ipv6.some((address) => expectedIpv6.includes(address));
  const familyMatch = v4Match || v6Match;
  if (!familyMatch) {
    return { status: "MISMATCH", errorCode: "DNS_TARGET_MISMATCH",
      message: `${hostname} resolves to ${observed.join(", ")}, which is not this server `
        + `(${[...expectedIpv4, ...expectedIpv6].join(", ") || "no expected address configured"}).`,
      records, observed };
  }
  const warnings = [];
  if (records.ipv4.length && !v4Match && expectedIpv4.length) {
    warnings.push(`IPv4 ${records.ipv4.join(", ")} does not match this server's IPv4.`);
  }
  if (records.ipv6.length && !v6Match && expectedIpv6.length) {
    warnings.push(`IPv6 ${records.ipv6.join(", ")} does not match this server's IPv6.`);
  }
  if (records.cname.length) warnings.push(`Resolved via CNAME (${records.cname.join(", ")}).`);
  return { status: "OK", errorCode: null, message: null, records, observed, warnings };
}

/**
 * Read the certificate a server presents for a given SNI hostname.
 *
 * Rejects rather than resolving when the handshake fails. `rejectUnauthorized`
 * is left at its secure default: this probe must never learn to ignore a bad
 * certificate, or it would report a broken endpoint as healthy.
 */
function probeCertificate({ hostname, port = 443, timeoutMs = 10_000, connect = tls.connect }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    let socket;
    try {
      socket = connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false });
    } catch (error) {
      reject(error); return;
    }
    socket.setTimeout(timeoutMs, () => {
      try { socket.destroy(); } catch { /* ignore */ }
      finish(reject, Object.assign(new Error("TLS handshake timed out"), { code: "TLS_TIMEOUT" }));
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      try { socket.end(); } catch { /* ignore */ }
      if (!cert || !cert.valid_to) {
        finish(reject, Object.assign(new Error("No peer certificate presented"), { code: "NO_CERT" }));
        return;
      }
      finish(resolve, {
        subject: cert.subject?.CN || null,
        issuer: cert.issuer?.O || cert.issuer?.CN || null,
        validFrom: new Date(cert.valid_from).getTime(),
        validTo: new Date(cert.valid_to).getTime(),
        subjectAltNames: cert.subjectaltname || null,
        fingerprint256: cert.fingerprint256 || null,
      });
    });
  });
}

/** Does the certificate actually cover this hostname? */
function certificateCovers(certificate, hostname) {
  if (!certificate) return false;
  const cn = String(certificate.subject || "").toLowerCase();
  const san = String(certificate.subjectAltNames || "")
    .split(",").map((entry) => entry.trim().replace(/^DNS:/i, "").toLowerCase()).filter(Boolean);
  const names = san.length ? san : (cn ? [cn] : []);
  const target = String(hostname || "").toLowerCase();
  return names.some((name) => name === target || (name.startsWith("*.") && target.endsWith(name.slice(1))));
}

/**
 * Verify routing and TLS for a managed domain.
 *
 * SSL is ACTIVE only when ALL of these hold:
 *   1. the host answers over HTTPS,
 *   2. the presented certificate covers the hostname,
 *   3. the certificate is not expired,
 *   4. the assigned path surface answers with a non-5xx status.
 *
 * A stored row, a successful DNS lookup, or a Certbot exit code is NOT evidence
 * and can never produce SSL_ACTIVE here.
 */
async function verifyRouting({ hostname, service, fetchImpl = globalThis.fetch, connect,
  now = Date.now(), timeoutMs = 10_000 }) {
  if (!service) {
    return { routingStatus: "ERROR", sslStatus: "UNKNOWN", errorCode: "INVALID_SERVICE",
      message: "No service is assigned." };
  }
  let certificate;
  try {
    certificate = await probeCertificate({ hostname, connect, timeoutMs });
  } catch (error) {
    return { routingStatus: "ERROR", sslStatus: "NONE", errorCode: "ROUTING_TLS_FAILED",
      message: `TLS handshake with ${hostname}:443 failed: ${error.code || error.message}` };
  }
  if (!certificateCovers(certificate, hostname)) {
    return { routingStatus: "ERROR", sslStatus: "INVALID", errorCode: "CERT_HOSTNAME_MISMATCH",
      message: `The certificate presented for ${hostname} does not cover it `
        + `(subject "${certificate.subject}", SAN "${certificate.subjectAltNames || "none"}").`,
      certificate };
  }
  if (certificate.validTo <= now) {
    return { routingStatus: "ERROR", sslStatus: "EXPIRED", errorCode: "CERT_EXPIRED",
      message: `The certificate for ${hostname} expired on ${new Date(certificate.validTo).toISOString()}.`,
      certificate };
  }

  // HTTP reachability of the assigned surface. Credentials are never sent: this
  // is a liveness probe, and a 401/403 still proves the surface is served.
  let status = null;
  let httpError = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl(`https://${hostname}${service.pathPrefix === "/" ? "/" : service.pathPrefix}`,
      { method: "GET", redirect: "manual", signal: controller.signal });
    clearTimeout(timer);
    status = response.status;
  } catch (error) {
    httpError = error.code || error.message;
  }
  const daysLeft = Math.floor((certificate.validTo - now) / 86_400_000);
  if (httpError) {
    return { routingStatus: "ERROR", sslStatus: "ISSUED_NOT_SERVING", errorCode: "ROUTING_HTTP_UNREACHABLE",
      message: `TLS is valid but https://${hostname}${service.pathPrefix} did not respond: ${httpError}`,
      certificate, daysLeft };
  }
  if (status >= 500) {
    return { routingStatus: "ERROR", sslStatus: "ISSUED_NOT_SERVING", errorCode: "ROUTING_UPSTREAM_ERROR",
      message: `https://${hostname}${service.pathPrefix} returned ${status} from the upstream.`,
      certificate, daysLeft, httpStatus: status };
  }
  const renewalDue = daysLeft <= RENEWAL_WINDOW_DAYS;
  return { routingStatus: "OK", sslStatus: "ACTIVE",
    errorCode: renewalDue ? "CERT_RENEWAL_REQUIRED" : null,
    message: renewalDue ? `Certificate expires in ${daysLeft} days.` : null,
    certificate, daysLeft, httpStatus: status, renewalDue };
}

module.exports = { resolveHost, verifyDns, probeCertificate, certificateCovers,
  verifyRouting, RENEWAL_WINDOW_DAYS };
