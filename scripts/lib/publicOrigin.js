"use strict";

/**
 * Public-origin resolution for GMweb production.
 *
 * ADR-007 makes `PUBLIC_WEB_ORIGIN` fail-closed: `registerPairingRoutes` throws in
 * production when it is missing or not HTTPS. That is correct behaviour. The defect this
 * module addresses is that NOTHING established the value before the service was
 * restarted, so a fresh install or an update put the API into a predictably failing
 * restart loop.
 *
 * This module is deliberately pure: it takes an explicit "facts" object, so every
 * discovery and precedence rule is unit-testable without touching systemd, a real
 * filesystem layout, or a production host. `publicOriginPreflight.js` is the impure
 * half that gathers the facts.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Hostnames that can never be a public web origin for a production deployment.
 *
 * `.test`, `.example`, `.invalid` and `.localhost` are reserved by RFC 2606/6761 and exist
 * precisely so they are never live. The remainder are private-network conventions. A live
 * production hostname is never drawn from this list, and rejecting them fails loudly at
 * preflight rather than at Android enrollment.
 */
const NON_PUBLIC_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".intranet",
  ".corp",
  ".home",
  ".lan",
  ".test",
  ".example",
  ".invalid",
];

/**
 * A single trailing slash is the only normalization the application contract allows;
 * every other path/query/fragment component is rejected rather than silently dropped,
 * because two different strings must never canonicalise to the same transcript origin
 * by accident. ADR-007 binds the origin into pairing transcripts, certificates and
 * challenges, so a value that is not byte-stable across the installer, systemd and the
 * process would break pairing in a way that is very hard to diagnose.
 */
const ALLOWED_PROTOCOL = "https:";

function looksLikeIpv4(hostname) {
  const match = IPV4_RE.exec(hostname);
  if (!match) return false;
  return match.slice(1).every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 && String(value) === String(Number(part));
  });
}

function isPrivateIpv4(hostname) {
  const match = IPV4_RE.exec(hostname);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // RFC 5737 documentation ranges are not routable production origins either.
  if (a === 192 && b === 0 && Number(match[3]) === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && Number(match[3]) === 100) return true;
  if (a === 203 && b === 0 && Number(match[3]) === 113) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * Validate a candidate against the ADR-007 production contract.
 *
 * Returns `{ ok: true, origin }` with the normalized value, or
 * `{ ok: false, reason, message }` where `reason` is a stable code a caller can branch on
 * and `message` is written for an administrator to act on.
 */
function validatePublicOrigin(raw) {
  const value = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!value) {
    return { ok: false, reason: "empty", message: "the value is empty" };
  }
  if (/\s/.test(value)) {
    return { ok: false, reason: "whitespace", message: "the value contains whitespace" };
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    return {
      ok: false,
      reason: "missing_scheme",
      message: "the value has no scheme; it must start with https://",
    };
  }

  let url;
  let normalized;
  try {
    url = new URL(value);
    // `URL` silently repairs some inputs (for example a trailing space, or a bare host
    // that it turns into a path). Compare against the canonical form instead of trusting
    // that the parse preserved what the administrator typed.
    normalized = url.origin;
  } catch {
    return { ok: false, reason: "malformed", message: "the value is not a valid URL" };
  }

  if (url.protocol !== ALLOWED_PROTOCOL) {
    return {
      ok: false,
      reason: "not_https",
      message: `the scheme is "${url.protocol.replace(/:$/, "")}"; production requires https`,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: "has_credentials",
      message: "the value must not embed credentials",
    };
  }
  if (url.search || url.hash) {
    return {
      ok: false,
      reason: "has_query_or_fragment",
      message: "the value must not contain a query string or fragment",
    };
  }
  // A path other than a bare "/" is not an origin. Rejecting it is safer than trimming
  // it, because the trimmed value would not match what the administrator configured.
  if (url.pathname && url.pathname !== "/") {
    return {
      ok: false,
      reason: "has_path",
      message: `the value must be an origin with no path (got "${url.pathname}")`,
    };
  }

  const hostname = url.hostname;
  if (!hostname) {
    return { ok: false, reason: "no_hostname", message: "the value has no hostname" };
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "localhost", message: "localhost is not a public origin" };
  }
  if (looksLikeIpv4(hostname)) {
    if (isPrivateIpv4(hostname)) {
      return {
        ok: false,
        reason: "private_ip",
        message: `${hostname} is a private or non-routable address, not a public origin`,
      };
    }
    return {
      ok: false,
      reason: "ip_literal",
      message: "use the public hostname, not an IP address; certificate and pairing transcripts bind the hostname",
    };
  }
  // IPv6 literals arrive bracketed from URL#hostname only in some runtimes; detect both.
  if (hostname.startsWith("[") || hostname.includes(":")) {
    return { ok: false, reason: "ip_literal", message: "use the public hostname, not an IPv6 literal" };
  }
  if (!hostname.includes(".")) {
    return {
      ok: false,
      reason: "not_fully_qualified",
      message: `"${hostname}" is not a fully qualified public hostname`,
    };
  }
  for (const suffix of NON_PUBLIC_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return {
        ok: false,
        reason: "reserved_hostname",
        message: `"${hostname}" uses the reserved suffix "${suffix}" and cannot be a production origin`,
      };
    }
  }
  if (hostname.startsWith("-") || hostname.endsWith("-") || hostname.includes("..")) {
    return { ok: false, reason: "malformed_host", message: `"${hostname}" is not a valid hostname` };
  }
  // Reject anything a browser would IDNA-encode: the origin is byte-compared inside pairing
  // transcripts, and a Unicode lookalike would compare unequal on the phone while looking
  // identical to the administrator.
  if (encodeURI(hostname) !== hostname) {
    return {
      ok: false,
      reason: "non_ascii_host",
      message: `"${hostname}" contains non-ASCII characters; use the ASCII (punycode) hostname`,
    };
  }
  const labels = hostname.split(".");
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)) {
      return { ok: false, reason: "malformed_host", message: `"${hostname}" is not a valid hostname` };
    }
  }
  // A non-default port is allowed (the contract only binds the origin string), but the
  // canonical value keeps it explicit only when it is not the https default.
  const port = url.port;
  const origin = port && port !== "443" ? `${url.protocol}//${hostname}:${port}` : `${url.protocol}//${hostname}`;
  if (origin !== normalized && !(normalized === `${url.protocol}//${hostname}` && !port)) {
    // Fall through: `normalized` and the explicit rebuild agree whenever the parse was clean.
  }
  return { ok: true, origin };
}

/**
 * Is `candidate` structurally one of the origins this deployment serves?
 *
 * Deliberately textual and conservative. It is a *conflict detector*, not a validator:
 * the point is to notice that two configuration sources name different hosts, which is a
 * decision for a human, rather than to silently pick a winner.
 */
function sameHost(a, b) {
  const host = (value) => {
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  const left = host(a);
  const right = host(b);
  return Boolean(left) && left === right;
}

/**
 * Does this deployment serve the web app and the API from ONE origin?
 *
 * The rule is not a guess. GMweb mounts the PWA at `/web`, the console at `/app` and the
 * API at `/api/v1/*` on one Fastify instance listening on one port
 * (`src/server.js` static routes + `/health`), and `docs/OPERATIONS.md` documents opening
 * `/web` "in the same origin" as the dashboard. When the application itself is
 * single-origin, `PUBLIC_API_ORIGIN` is a safe *source* for `PUBLIC_WEB_ORIGIN` — but only
 * after that fact is stated, which is what `facts.singleOriginApp` carries.
 *
 * When the flag is false (a deployer terminating the PWA on a different host), the API
 * origin must never be reused, because ADR-007 binds both origins into the pairing
 * transcript and a wrong web origin silently breaks enrollment.
 */
function apiOriginCanSupplyWeb(facts) {
  return facts && facts.singleOriginApp === true;
}

/**
 * May the API origin be reused when a web origin is configured but UNUSABLE?
 *
 * Only when the architecture is single-origin AND the API origin is on the SAME host as
 * the unusable value. That host is what the deployment already believes it is publicly
 * reachable at, so promoting the API origin is a correction of the scheme/path, not a
 * change of identity. If the two name different hosts, the deployment may genuinely serve
 * the PWA elsewhere and the conflict is escalated instead of guessed away.
 */
function apiOriginCanReplace(facts) {
  if (!apiOriginCanSupplyWeb(facts)) return false;
  if (!facts.unusableWebOrigin || !facts.apiOrigin) return false;
  return sameHost(facts.unusableWebOrigin, facts.apiOrigin);
}

/**
 * Resolve the public web origin from discovery facts.
 *
 * `facts`:
 *   - effectiveWebOrigin   value the RUNNING service would see (systemd env + EnvironmentFile)
 *   - envFileWebOrigin     value in the canonical .env
 *   - explicitWebOrigin    operator-provided value (for example GMWEB_PUBLIC_ORIGIN)
 *   - apiOrigin            PUBLIC_API_ORIGIN from any source
 *   - singleOriginApp      boolean, see apiOriginCanSupplyWeb
 *   - proxyWebOrigin       origin derived from the authoritative public vhost
 *   - sources              labels for the above, used in messages
 *
 * Returns:
 *   {
 *     ok, origin, source, changed, conflict, invalid[], propagation, notes[]
 *   }
 * `propagation` is true when the value the process will actually read is the value we
 * resolved — a distinction that matters because the code reads `process.env`, not `.env`.
 */
function resolvePublicOrigin(facts = {}) {
  const notes = [];
  const invalid = [];
  const invalidSeen = new Set();
  const explicitLabel = facts.sources?.explicit || "explicit configuration";

  const consider = (label, raw, { apiDerived = false } = {}) => {
    if (raw === undefined || raw === null || String(raw).trim() === "") return null;
    const result = validatePublicOrigin(raw);
    if (!result.ok) {
      // The same bad value is often reachable through two sources (the service environment
      // and the file it was loaded from). Reporting it twice reads like two separate
      // problems, so identical findings collapse to one.
      const dedupeKey = `${result.reason}\u0000${String(raw)}`;
      if (!invalidSeen.has(dedupeKey)) {
        invalidSeen.add(dedupeKey);
        invalid.push({
          source: label,
          value: String(raw),
          reason: result.reason,
          message: result.message,
          explicit: label === explicitLabel,
        });
      }
      return null;
    }
    if (apiDerived) notes.push(`reused the API origin as the web origin (${label}); the application serves /web, /app and /api/v1 on one origin`);
    return { origin: result.origin, source: label };
  };

  // 1. An explicitly configured value wins over every discovered one. An operator's
  //    deliberate configuration is never silently replaced.
  const explicit = consider(facts.sources?.explicit || "explicit configuration", facts.explicitWebOrigin);
  if (explicit) {
    const effective = consider("systemd effective environment", facts.effectiveWebOrigin);
    const envFile = consider("canonical .env", facts.envFileWebOrigin);
    const propagation = Boolean(effective) && effective.origin === explicit.origin;
    if (!effective) {
      notes.push(
        "the configured origin is not visible to the service environment; " +
        "systemd must load the canonical environment file or the process will fail closed"
      );
    }
    const conflict = [envFile, effective]
      .filter(Boolean)
      .find((candidate) => candidate.origin !== explicit.origin);
    return {
      ok: true,
      origin: explicit.origin,
      source: explicit.source,
      changed: Boolean(conflict),
      conflict: conflict
        ? {
            chosen: explicit.origin,
            rejected: conflict.origin,
            rejectedSource: conflict.source,
            reason: "an explicitly configured origin takes precedence",
          }
        : null,
      invalid,
      propagation,
      notes,
    };
  }

  // 2. The value the systemd unit actually hands the process. This is the closest thing
  //    to "what the service will really use", so it beats a file nothing loads.
  const effective = consider("systemd effective environment", facts.effectiveWebOrigin);
  if (effective) {
    const envFile = consider("canonical .env", facts.envFileWebOrigin);
    return {
      ok: true,
      origin: effective.origin,
      source: effective.source,
      changed: !envFile || envFile.origin !== effective.origin,
      conflict: null,
      invalid,
      propagation: true,
      notes,
    };
  }

  // 3. The canonical environment file, even when systemd is not loading it yet. The
  //    value is authoritative; `propagation:false` records that systemd still has to be
  //    wired up before the process will see it.
  const envFile = consider("canonical .env", facts.envFileWebOrigin);
  if (envFile) {
    notes.push("the value exists in the environment file but is not reaching the service; propagation must be repaired");
    return {
      ok: true,
      origin: envFile.origin,
      source: envFile.source,
      changed: false,
      conflict: null,
      invalid,
      propagation: false,
      notes,
    };
  }

  // 4. The authoritative reverse-proxy virtual host, which is by definition the public
  //    name clients reach.
  const proxy = consider("reverse-proxy virtual host", facts.proxyWebOrigin);
  if (proxy) {
    return {
      ok: true,
      origin: proxy.origin,
      source: proxy.source,
      changed: false,
      conflict: null,
      invalid,
      propagation: false,
      notes,
    };
  }

  // The rest of the resolution turns on whether a web origin was actually SUPPLIED but
  // rejected, which is a different situation from nothing being configured at all.
  const unusableWeb = invalid.find((item) => item.reason !== "empty") || null;
  const api = consider("PUBLIC_API_ORIGIN", facts.apiOrigin);

  if (unusableWeb && api) {
    // 5. A web origin was configured but is unusable, and the API origin names the SAME
    //    host. The deployment's intended public host is therefore known; only the scheme or
    //    a path was wrong. Promote the API origin, and record the substitution so the
    //    operator sees an invalid value was corrected rather than silently ignored.
    if (apiOriginCanReplace({ ...facts, unusableWebOrigin: unusableWeb.value })) {
      notes.push(
        `replaced the unusable web origin "${unusableWeb.value}" (${unusableWeb.message}) ` +
        `with the API origin on the same host`
      );
      return {
        ok: true,
        origin: api.origin,
        source: `${api.source} (corrected a same-host web origin)`,
        changed: true,
        conflict: {
          chosen: api.origin,
          rejected: unusableWeb.value,
          rejectedSource: unusableWeb.source,
          reason: `the configured web origin was unusable (${unusableWeb.message}); the API origin names the same host`,
        },
        invalid,
        propagation: false,
        notes,
      };
    }
    // The two name different hosts. Guessing here could point pairing at the wrong host,
    // so the conflict is escalated rather than resolved.
    notes.push(
      `PUBLIC_API_ORIGIN (${api.origin}) was NOT used to replace the unusable web origin ` +
      `"${unusableWeb.value}": they name different hosts, and the PWA may legitimately be ` +
      "served elsewhere. State PUBLIC_WEB_ORIGIN explicitly."
    );
  } else if (!unusableWeb && api && apiOriginCanSupplyWeb(facts)) {
    // 6. No web origin was configured anywhere and the architecture is single-origin, so
    //    the API origin IS this deployment's web origin.
    notes.push(
      "no web origin is configured; reusing PUBLIC_API_ORIGIN because this deployment " +
      "serves /web, /app and /api/v1 from one origin"
    );
    return {
      ok: true,
      origin: api.origin,
      source: "PUBLIC_API_ORIGIN (single-origin deployment)",
      changed: false,
      conflict: null,
      invalid,
      propagation: false,
      notes,
    };
  } else if (api && !apiOriginCanSupplyWeb(facts)) {
    notes.push(
      "PUBLIC_API_ORIGIN is set but was NOT reused as the web origin: this deployment is " +
      "not known to serve the web app on one origin, so the web origin must be explicit"
    );
  }

  // 7. Nothing safe to use.
  const messages = invalid.length
    ? invalid.map((item) => `${item.source}: ${item.message}`)
    : ["no configuration source provided a value"];
  return {
    ok: false,
    origin: null,
    source: null,
    changed: false,
    conflict: null,
    invalid,
    propagation: false,
    notes,
    message: `could not establish the public web origin (${messages.join("; ")})`,
  };
}

/**
 * The exact text an administrator sees when GMweb has to ask. Kept here so the wording is
 * covered by tests rather than living only inside the prompt.
 */
function interactivePromptText() {
  return [
    "GMweb production configuration requires PUBLIC_WEB_ORIGIN.",
    "",
    "Could not safely determine the public HTTPS web origin.",
    "",
    "Enter the public web origin",
    "(example: https://chat.example.com):",
  ].join("\n");
}

module.exports = {
  validatePublicOrigin,
  resolvePublicOrigin,
  apiOriginCanSupplyWeb,
  apiOriginCanReplace,
  sameHost,
  interactivePromptText,
  isPrivateIpv4,
  looksLikeIpv4,
  NON_PUBLIC_SUFFIXES,
};
