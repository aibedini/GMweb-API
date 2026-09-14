"use strict";
// Static asset cache policy — ONE place, so /web and /app cannot drift apart.
//
// Two failure modes this prevents:
//   * an app shell (index.html / version.json / sw.js) pinned in a browser or
//     CDN, so a released build never reaches the operator;
//   * content-hashed bundles re-downloaded on every navigation because someone
//     "fixed" caching by disabling it globally.
//
// Vite emits content-hashed file names, so those are safe to pin forever:
// changing a byte changes the name.

const IMMUTABLE_MAX_AGE = 31536000; // 1 year
const SHORT_MAX_AGE = 3600;         // 1 hour: unhashed, but not an entry point

// /web/assets/index-9vx9DV13.js, /app/assets/index-5QrcM2DA.css
const HASHED_ASSET = /\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/;

// Everything that tells a browser a NEW build exists must be revalidated.
const REVALIDATE_FILES = [
  /\/index\.html$/,
  /\/version\.json$/,
  /\/build-info\.json$/,
  /\/sw\.js$/,
  /\/manifest\.webmanifest$/
];

/**
 * A path whose last segment has no file extension is an SPA ROUTE: it is served
 * from index.html, so it must revalidate exactly like index.html itself.
 * Without this, `/web` (no trailing slash) was cached for an hour and a
 * released build could keep serving the previous shell.
 */
function looksLikeSpaRoute(pathname) {
  if (pathname.endsWith("/")) return true;
  const last = pathname.split("/").pop() || "";
  if (!last) return true;
  return !/\.[A-Za-z0-9]+$/.test(last);
}

const TIER = Object.freeze({
  IMMUTABLE: "immutable",
  REVALIDATE: "revalidate",
  SHORT: "short"
});

function normalizePath(pathname) {
  const raw = String(pathname || "");
  const withoutQuery = raw.split("?")[0].split("#")[0];
  return withoutQuery || "/";
}

function isHashedAsset(pathname) {
  return HASHED_ASSET.test(normalizePath(pathname));
}

function mustRevalidate(pathname) {
  const clean = normalizePath(pathname);
  if (looksLikeSpaRoute(clean)) return true;
  return REVALIDATE_FILES.some((pattern) => pattern.test(clean));
}

/** @returns {{tier: string, header: string}} */
function cacheControlFor(pathname) {
  if (isHashedAsset(pathname)) {
    return { tier: TIER.IMMUTABLE, header: `public, max-age=${IMMUTABLE_MAX_AGE}, immutable` };
  }
  if (mustRevalidate(pathname)) {
    // no-cache means "revalidate before using a cached copy" — exactly right for
    // the shell, the version manifest and the service worker.
    return { tier: TIER.REVALIDATE, header: "no-cache, must-revalidate" };
  }
  return { tier: TIER.SHORT, header: `public, max-age=${SHORT_MAX_AGE}` };
}

/** Apply the policy to a Fastify reply. Returns the tier (useful in tests). */
function applyStaticCachePolicy(reply, pathname) {
  const decision = cacheControlFor(pathname);
  reply.header("Cache-Control", decision.header);
  return decision.tier;
}

module.exports = {
  TIER,
  IMMUTABLE_MAX_AGE,
  SHORT_MAX_AGE,
  HASHED_ASSET,
  looksLikeSpaRoute,
  cacheControlFor,
  applyStaticCachePolicy,
  isHashedAsset,
  mustRevalidate
};
