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

test("case 24: the staged candidate is handed to the app user BEFORE any gate runs", () => {
  // Field defect: update_app created its stage with mktemp -d, which is 0700 and
  // root-owned, while every gate below runs through run_as_app. APP_USER could
  // not even traverse the stage, so a perfectly valid candidate was rejected
  // with a bare "cd: Permission denied" and the operator saw a failed update for
  // the wrong reason. The handover MUST therefore precede the first gate.
  const body = fnBody(MENU, "update_app() {");

  const stageAt = body.indexOf('stage="$(mktemp -d');
  assert.ok(stageAt !== -1, "update_app stages the candidate with mktemp -d");

  const chmodAt = body.indexOf('chmod 755 "$stage"', stageAt);
  const chownAt = body.indexOf('chown -R "$APP_USER:$APP_USER" "$stage"', stageAt);
  assert.ok(chmodAt !== -1, "the stage root must become traversable by APP_USER");
  assert.ok(chownAt !== -1, "the stage must be owned by the validating APP_USER");

  const firstGateAt = body.indexOf('run_as_app "cd \'$stage\'', stageAt);
  assert.ok(firstGateAt !== -1, "the gates run inside the stage as APP_USER");
  assert.ok(chmodAt < firstGateAt, "chmod must precede the first gate");
  assert.ok(chownAt < firstGateAt, "chown must precede the first gate");
  assert.ok(chownAt > stageAt, "the handover happens after extraction, not before mktemp");
});

test("case 24b: the stage handover widens permissions no further than validation needs", () => {
  const body = fnBody(MENU, "update_app() {");
  const modes = [...body.matchAll(/chmod (\d{3,4}) "\$stage"/g)].map((m) => m[1]);
  assert.ok(modes.length >= 1, "the stage mode is set explicitly");
  for (const mode of modes) {
    // Octal: r=4 w=2 x=1. The write bit is 2, not 1 — 755 is r-xr-xr-x and is
    // correctly NOT group- or world-writable.
    const [owner, group, other] = mode.slice(-3).split("").map(Number);
    assert.equal(other & 2, 0, `the stage must not be world-writable (chmod ${mode})`);
    assert.equal(group & 2, 0, `the stage must not be group-writable (chmod ${mode})`);
    assert.equal(owner & 2, 2, `the validating APP_USER must be able to write the stage (chmod ${mode})`);
    assert.equal(other & 1, 1, `the stage must stay traversable for root tooling such as rsync (chmod ${mode})`);
  }
  // Consistency: the sibling migration path hands its stage over the same way,
  // so both update routes validate as the same account under the same model.
  for (const signature of ["adopt_git_checkout() {"]) {
    const sibling = fnBody(MENU, signature);
    assert.ok(/chown -R "\$APP_USER:\$APP_USER" "\$stage"/.test(sibling),
      `${signature} must also hand its stage to APP_USER`);
  }
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
