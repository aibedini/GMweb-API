"use strict";
// Release integrity: a candidate where the API version and the generated PWA
// version differ MUST fail.
//
// This is the check that was missing when production served 0.19.1 from the API
// and 0.18.0 from /web.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyFrontendArtifacts, DEFAULT_ROOT } = require("../scripts/verify-frontend-artifacts.mjs");

function makeRoot({ version = "9.9.9", pwaVersion = "9.9.9", pwaAsset = true, dashAsset = true, buildInfo = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-release-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "gmweb-api", version }, null, 2));
  const web = path.join(dir, "public", "web-app");
  const dash = path.join(dir, "public", "dashboard-next");
  fs.mkdirSync(path.join(web, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dash, "assets"), { recursive: true });
  fs.writeFileSync(path.join(web, "version.json"), JSON.stringify({ version: pwaVersion }));
  fs.writeFileSync(path.join(web, "index.html"),
    `<!doctype html><html><head><script type="module" src="/web/assets/index-abc12345.js"></script></head></html>`);
  fs.writeFileSync(path.join(dash, "index.html"),
    `<!doctype html><html><head><script type="module" src="/app/assets/index-def67890.js"></script></head></html>`);
  if (pwaAsset) fs.writeFileSync(path.join(web, "assets", "index-abc12345.js"), "console.log(1)");
  if (dashAsset) fs.writeFileSync(path.join(dash, "assets", "index-def67890.js"), "console.log(2)");
  if (buildInfo) fs.writeFileSync(path.join(web, "build-info.json"), JSON.stringify(buildInfo));
  return dir;
}

test("case 8: the committed artifacts match package.json (this repository)", () => {
  const result = verifyFrontendArtifacts({ root: DEFAULT_ROOT });
  const pkg = JSON.parse(fs.readFileSync(path.join(DEFAULT_ROOT, "package.json"), "utf8"));
  assert.equal(result.version, pkg.version);
  assert.equal(result.ok, true, `artifacts must belong to ${pkg.version}: ${result.errors.join("; ")}`);
});

test("case 9: a stale PWA version FAILS validation", () => {
  const dir = makeRoot({ version: "0.19.1", pwaVersion: "0.18.0" });
  const result = verifyFrontendArtifacts({ root: dir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /version drift/.test(e)), result.errors.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("case 9b: an entry point referencing a missing bundle FAILS validation", () => {
  const dir = makeRoot({ version: "0.19.1", pwaVersion: "0.19.1", pwaAsset: false });
  const result = verifyFrontendArtifacts({ root: dir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /references \/web\/assets\/index-abc12345\.js but that file does not exist/.test(e)),
    result.errors.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("case 9c: a missing console build FAILS validation", () => {
  const dir = makeRoot({ version: "0.19.1", pwaVersion: "0.19.1" });
  fs.rmSync(path.join(dir, "public", "dashboard-next"), { recursive: true, force: true });
  const result = verifyFrontendArtifacts({ root: dir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Dashboard/.test(e)), result.errors.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("build provenance must agree with package.json when present", () => {
  const dir = makeRoot({
    version: "0.19.1", pwaVersion: "0.19.1",
    buildInfo: { version: "0.19.0", revision: "deadbeef", builtAt: "2026-09-14T00:00:00Z" }
  });
  const result = verifyFrontendArtifacts({ root: dir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /build-info version drift/.test(e)), result.errors.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a clean candidate passes and is quiet about absent optional provenance", () => {
  const dir = makeRoot({ version: "1.2.3", pwaVersion: "1.2.3" });
  const result = verifyFrontendArtifacts({ root: dir });
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.ok(result.warnings.some((w) => /build-info\.json absent/.test(w)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the release pipeline runs the verifier before promoting", () => {
  const deploy = fs.readFileSync(path.join(__dirname, "..", "deploy-gmweb.sh"), "utf8");
  const verifyAt = deploy.indexOf("verify-frontend-artifacts.mjs");
  const promoteAt = deploy.indexOf("Promoting exactly the revision that passed");
  assert.ok(verifyAt !== -1, "the deploy must run the verifier");
  assert.ok(promoteAt !== -1, "the promote step must exist");
  assert.ok(deploy.indexOf("build:frontends") < verifyAt, "it builds before verifying");
  const restartAt = deploy.indexOf("systemctl restart gmweb-api.service");
  assert.ok(verifyAt < restartAt, "and verifies BEFORE restarting the service");
  const manager = fs.readFileSync(path.join(__dirname, "..", "scripts", "gmweb-menu.sh"), "utf8");
  assert.ok(manager.includes("npm run build:frontends"), "the manager update path builds too");
  assert.ok(manager.includes("verify-frontend-artifacts.mjs"), "...and verifies before restarting");
});
