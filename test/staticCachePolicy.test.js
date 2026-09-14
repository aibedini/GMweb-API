"use strict";
// Static cache policy for the two SPAs.
//
// Two ways to get this wrong, both visible in the field:
//   * pinning index.html / version.json / sw.js so a released build never
//     reaches the operator;
//   * "fixing" that by disabling caching everywhere and re-downloading 500 kB
//     of hashed bundle on every navigation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { cacheControlFor, applyStaticCachePolicy, TIER } = require("../src/staticCachePolicy");

const IMMUTABLE = "public, max-age=31536000, immutable";

test("case 10: PWA entry points, version manifest and service worker revalidate", () => {
  for (const url of ["/web", "/web/", "/web/index.html", "/web/version.json", "/web/sw.js"]) {
    const decision = cacheControlFor(url);
    assert.equal(decision.tier, TIER.REVALIDATE, `${url} must not be pinned`);
    assert.equal(decision.header, "no-cache, must-revalidate");
    assert.ok(!/immutable/.test(decision.header));
  }
});

test("case 11: hashed PWA assets are immutable for a year", () => {
  for (const url of [
    "/web/assets/index-9vx9DV13.js",
    "/web/assets/index-5QrcM2DA.css",
    "/web/assets/__vite-browser-external-BIHI7g3E.js"
  ]) {
    const decision = cacheControlFor(url);
    assert.equal(decision.tier, TIER.IMMUTABLE, `${url} should be immutable`);
    assert.equal(decision.header, IMMUTABLE);
  }
});

test("case 12: the console follows the same rule (/app index vs hashed assets)", () => {
  for (const url of ["/app", "/app/", "/app/index.html"]) {
    assert.equal(cacheControlFor(url).tier, TIER.REVALIDATE, `${url} must revalidate`);
  }
  for (const url of ["/app/assets/index-Cm26E2Mz.js", "/app/assets/index-BTujBj3l.css"]) {
    assert.equal(cacheControlFor(url).tier, TIER.IMMUTABLE, `${url} should be immutable`);
    assert.equal(cacheControlFor(url).header, IMMUTABLE);
  }
});

test("query strings and fragments do not defeat the policy", () => {
  assert.equal(cacheControlFor("/web/index.html?cachebust=1").tier, TIER.REVALIDATE);
  assert.equal(cacheControlFor("/web/assets/index-9vx9DV13.js?v=2").tier, TIER.IMMUTABLE);
});

test("unhashed, non-entry files get a short cache rather than none", () => {
  const decision = cacheControlFor("/web/icons/icon-192.png");
  assert.equal(decision.tier, TIER.SHORT);
  assert.ok(/max-age=\d+/.test(decision.header));
});

test("applyStaticCachePolicy writes the header on a reply", () => {
  const headers = {};
  const tier = applyStaticCachePolicy(
    { header: (k, v) => { headers[k] = v; } },
    "/web/assets/index-9vx9DV13.js"
  );
  assert.equal(tier, TIER.IMMUTABLE);
  assert.equal(headers["Cache-Control"], IMMUTABLE);
});

test("every SPA static handler applies the policy", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  for (const fn of ["sendWebAppFile", "sendSpaFile", "sendDashboardFile"]) {
    const start = server.indexOf(`async function ${fn}(`);
    assert.ok(start !== -1, `${fn} must exist`);
    const body = server.slice(start, start + 1600);
    assert.ok(body.includes("applyStaticCachePolicy("), `${fn} must apply the cache policy`);
  }
  // ...and the routes must pass the request URL, not a hard-coded path.
  assert.ok(server.includes("sendWebAppFile(reply, request.params[\"*\"], request.url)"));
  assert.ok(server.includes("sendSpaFile(reply, request.params[\"*\"], request.url)"));
});
