"use strict";
// Release integrity: an unvalidated candidate can NEVER become the live
// checkout (Invariant A).
//
// The old manager path pulled the LIVE checkout to the new revision and only
// then built/validated it, so a failed front-end build left a live checkout that
// no build had ever validated — and the next restart would boot it. These
// assertions pin the ORDER, not just the presence of commands: a script that
// contains "npm run build:frontends" AFTER the promotion is exactly the bug.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MENU = fs.readFileSync(path.join(__dirname, "..", "scripts", "gmweb-menu.sh"), "utf8");
const DEPLOY = fs.readFileSync(path.join(__dirname, "..", "deploy-gmweb.sh"), "utf8");

function fnBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `${signature} must exist`);
  // Up to the next top-level function definition.
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n[a-zA-Z_][a-zA-Z0-9_]*\(\) \{/);
  return source.slice(start, next === -1 ? source.length : start + signature.length + next);
}

function assertOrder(body, markers, label) {
  let cursor = -1;
  for (const marker of markers) {
    const at = body.indexOf(marker, cursor + 1);
    assert.ok(at !== -1, `${label}: missing "${marker}"`);
    assert.ok(at > cursor, `${label}: "${marker}" appears out of order`);
    cursor = at;
  }
}

test("case 1-5: the manager validates the candidate BEFORE touching the live checkout", () => {
  const body = fnBody(MENU, "update_app() {");
  assertOrder(body, [
    "flock -n 9",                     // one updater at a time
    "rev-parse FETCH_HEAD",           // candidate pinned once
    'archive "$candidate"',           // staged outside the live checkout
    "npm run build:frontends",        // built there
    "verify-frontend-artifacts.mjs",  // verified there
    "pause_and_drain_queue",          // ONLY NOW is delivery paused
    "merge --ff-only '$candidate'",   // the first live mutation
    'restart "$API_SERVICE"'
  ], "update_app");
});

test("case 1: the live checkout is never pulled before validation", () => {
  const body = fnBody(MENU, "update_app() {");
  assert.equal(/pull --ff-only/.test(body), false,
    "update_app must not pull the live checkout; it fetches + stages + merges the pinned SHA");
  // A failed candidate must say so and leave the live revision alone.
  assert.ok(/Candidate validation FAILED/.test(body));
  assert.ok(/live checkout is unchanged/.test(body));
  assert.ok(body.includes("${old_sha:0:7}"), "the old SHA is reported to the operator");
});

test("case 6: a second updater exits with update_already_running", () => {
  const body = fnBody(MENU, "update_app() {");
  assert.ok(body.includes("update_already_running"), "the lock message is contractual");
  assert.ok(/flock -n 9/.test(body), "non-blocking: it must not wait");
});

test("case 8: promotion failure rolls back source AND artifacts together", () => {
  const body = fnBody(MENU, "update_app() {");
  assert.ok(/reset --hard '\$old_sha'/.test(body), "git reset restores source and committed artifacts as one pair");
  assert.ok(/Rolling back to/.test(body));
  assert.ok(/npm ci --omit=dev/.test(body), "production dependencies are restored too");
});

test("case 9-10: a manually paused queue is never auto-resumed, a running one is", () => {
  const body = fnBody(MENU, "update_app() {");
  const pauses = body.match(/UPDATE_QUEUE_WAS_PAUSED/g) || [];
  assert.ok(pauses.length >= 1, "the pre-existing pause state is remembered");
  assert.ok(/\[\[ "\$UPDATE_QUEUE_WAS_PAUSED" == "true" \]\] \|\| queue_control resume/.test(body),
    "resume happens only when WE paused it");
  // The pause helper itself records the prior state before pausing.
  const helper = fnBody(MENU, "pause_and_drain_queue() {");
  assert.ok(helper.indexOf("queue_control pause") > helper.indexOf("UPDATE_QUEUE_WAS_PAUSED="),
    "the prior state is recorded BEFORE pausing");
});

test("case 7: adoption validates the staged release before replacing the install", () => {
  const body = fnBody(MENU, "adopt_git_checkout() {");
  assertOrder(body, [
    "git clone",
    "npm ci --include=dev",
    "npm run check",
    "npm test",
    "npm run build:frontends",
    "verify-frontend-artifacts.mjs",
    'pause_and_drain_queue',
    'mv "$APP_DIR" "$previous"'
  ], "adopt_git_checkout");
  assert.ok(body.includes("npm ci --omit=dev"), "production deps are installed after the swap");
});

test("case 23: deploy-gmweb.sh keeps the same ordering guarantees", () => {
  assertOrder(DEPLOY, [
    'git archive "$CANDIDATE"',                 // staged, live untouched
    "npm run build:frontends",                  // built AND verified in the stage
    "Promoting exactly the revision that passed",
    "Verifying the LIVE artifacts before restarting anything",
    "systemctl restart gmweb-api.service"
  ], "deploy-gmweb.sh");
  // The candidate SHA is pinned once and never re-fetched mid-flight.
  const fetchAt = DEPLOY.indexOf("git fetch origin main");
  const candidateAt = DEPLOY.indexOf('CANDIDATE=$(git rev-parse FETCH_HEAD)');
  assert.ok(fetchAt !== -1 && candidateAt > fetchAt);
  assert.equal(DEPLOY.indexOf("git fetch", candidateAt), -1, "no second fetch after pinning");
  // A successful deploy gates on the served PWA agreeing with the API.
  assert.ok(DEPLOY.includes("served /web references"), "post-deploy asset check must exist");
});
