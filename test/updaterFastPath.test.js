"use strict";
// Production updater policy.
//
// These assert the DEPLOYMENT contract on the real scripts: the server must not
// act as the CI machine, expensive work must be opt-in, and the destructive
// paths (backup retention, temp pruning) must stay narrow. Static assertions
// are used deliberately: the scripts are bash, the repo has no bash test
// harness, and the updater's own `bash -n` gate covers syntax on the server.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const menu = fs.readFileSync(path.join(root, "scripts/gmweb-menu.sh"), "utf8");
const backup = fs.readFileSync(path.join(root, "scripts/gmweb-backup.sh"), "utf8");
const lib = fs.readFileSync(path.join(root, "scripts/gmweb-lib.sh"), "utf8");

/** The fast (default) validation branch only, i.e. the `else` arm. */
const fastBranch = menu.slice(menu.indexOf("FAST: `npm run check`"), menu.indexOf("t_check=$("));
/** The explicit full-mode branch. */
const fullBranch = menu.slice(menu.indexOf('if [[ "$GMWEB_UPDATE_MODE" == "full" ]]'), menu.indexOf("else\n    # FAST"));

// ── 2. fast is the default and does no CI work ───────────────────────────────

test("fast mode is the production default", () => {
  assert.match(menu, /GMWEB_UPDATE_MODE="\$\{GMWEB_UPDATE_MODE:-fast\}"/);
  assert.match(lib + menu, /GMWEB_UPDATE_MODE/);
});

test("fast mode runs only syntax + artifact validation", () => {
  assert.match(fastBranch, /npm run check/, "lightweight syntax check runs");
  assert.doesNotMatch(fastBranch, /npm test/, "fast mode must NOT run the test suite");
  assert.doesNotMatch(fastBranch, /build:frontends/, "fast mode must NOT build frontends");
  assert.doesNotMatch(fastBranch, /npm ci --include=dev/, "fast mode must NOT install dev deps");
});

test("fast mode never installs frontend dependencies", () => {
  // The whole script must not npm ci inside web/ or dashboard-next/.
  assert.doesNotMatch(menu, /npm ci[^\n]*(--prefix|cd)[^\n]*(web|dashboard-next)/);
  // Every `build:frontends` occurrence must be guarded by an explicit
  // GMWEB_UPDATE_MODE=full branch, so it can never run in the default fast path.
  let index = -1;
  let occurrences = 0;
  while ((index = menu.indexOf("build:frontends", index + 1)) !== -1) {
    occurrences += 1;
    const preceding = menu.slice(Math.max(0, index - 500), index);
    assert.match(preceding, /GMWEB_UPDATE_MODE" == "full"/,
      `build:frontends at offset ${index} is not inside a full-mode guard`);
  }
  assert.equal(occurrences, 2, "both validation sites are mode-gated");
  assert.match(fullBranch, /build:frontends/, "full mode retains the exhaustive build");
});

test("full mode keeps the exhaustive validation path", () => {
  assert.match(fullBranch, /npm ci --include=dev/);
  assert.match(fullBranch, /npm test/);
  assert.match(fullBranch, /build:frontends/);
});

test("the committed frontend artifact verifier runs in fast mode", () => {
  assert.match(menu, /verify-frontend-artifacts\.mjs/);
  const fastEnd = menu.indexOf("t_check=$(");
  assert.ok(menu.indexOf("verify-frontend-artifacts.mjs", fastEnd) > fastEnd,
    "artifact verification happens after validation, unconditionally");
});

// ── 5. dependency change detection ──────────────────────────────────────────

test("root npm ci is conditional on the dependency manifests changing", () => {
  assert.match(menu, /root_deps_changed=1/);
  assert.match(menu, /package\\\.json\|package-lock\\\.json\|npm-shrinkwrap\\\.json/);
  assert.match(menu, /Dependencies unchanged — skipped npm ci/);
  assert.match(menu, /Production dependencies changed — installing/);
  // Production install must sit inside the root_deps_changed guard.
  const guard = menu.indexOf("if (( root_deps_changed == 1 )); then");
  assert.ok(guard > 0, "the dependency guard exists");
  assert.ok(menu.indexOf("npm ci --omit=dev", guard) > guard,
    "npm ci --omit=dev only runs when the guard passes");
});

// ── 7/8. backup decision + schema marker ────────────────────────────────────

test("the schema marker exists with the documented initial value", () => {
  const marker = fs.readFileSync(path.join(root, "schema/data-schema.version"), "utf8").trim();
  assert.equal(marker, "1");
});

test("backup defaults to auto and honours always/never", () => {
  assert.match(menu, /GMWEB_UPDATE_BACKUP="\$\{GMWEB_UPDATE_BACKUP:-auto\}"/);
  assert.match(menu, /always\) backup_decision=yes/);
  assert.match(menu, /never\)\s+backup_decision=no/);
  assert.match(menu, /GMWEB_UPDATE_BACKUP=never — skipping a required backup/);
});

test("backup is required on schema change, missing marker, or risky file", () => {
  assert.match(menu, /old release has no schema marker/);
  assert.match(menu, /data-schema\.version \$schema_old/);
  // Conservative persistence/schema file pattern.
  assert.match(menu, /store\|Store\|database\|Database\|migration\|schema/);
  assert.match(menu, /persistence-sensitive file changed without a schema bump/);
  assert.match(menu, /DB backup: SKIPPED — \$\{backup_reason\}/);
});

test("the updater never creates legacy full-directory snapshots", () => {
  assert.doesNotMatch(menu, /gmweb-backups\/pre-/);
  assert.doesNotMatch(menu, /rsync[^\n]*--delete[^\n]*browser-profile/);
});

// ── 9/9A. compression + zstd bootstrap ──────────────────────────────────────

test("zstd is preferred with a gzip fallback", () => {
  assert.match(backup, /gmweb-\$stamp\.tar\.zst/);
  assert.match(backup, /zstd -T0 -1 -q -o/);
  assert.match(backup, /gmweb-\$stamp\.tar\.gz/);
  assert.match(backup, /zstd unavailable; using gzip fallback/);
});

test("zstd bootstrap is shared and installs at most once", () => {
  // One implementation, in the lib, sourced by both scripts.
  assert.match(lib, /^ensure_zstd\(\)/m);
  assert.match(lib, /apt-get[\s\S]{0,120}--no-install-recommends zstd/, "exactly one install site");
  assert.equal((lib.match(/--no-install-recommends zstd/g) || []).length, 1, "one install site");
  assert.doesNotMatch(menu, /apt-get[^\n]*install/, "the menu never installs packages itself");
  assert.match(backup, /source "\$SCRIPT_DIR\/gmweb-lib\.sh"/);
  // Bounded apt lock so an update can never hang on dpkg.
  assert.match(lib, /DPkg::Lock::Timeout=30/);
});

test("a zstd failure never fails the update", () => {
  assert.match(lib, /Could not install zstd; backup will use gzip fallback/);
  // Backup failures are non-fatal for the update.
  assert.match(menu, /Pre-promotion backup did not complete; continuing/);
});

test("backup retention keeps one own snapshot and preserves unrelated files", () => {
  assert.match(backup, /KEEP="\$\{KEEP:-1\}"/);
  // Recognises both of its own formats.
  assert.match(backup, /gmweb-\*\.tar\.gz/);
  assert.match(backup, /gmweb-\*\.tar\.zst/);
  // Scoped to the gmweb- prefix, so other files in the directory survive.
  assert.doesNotMatch(backup, /rm -f -- "\$BACKUP_DIR\/\*/);
  assert.doesNotMatch(backup, /rm -rf "\$BACKUP_DIR"/);
});

// ── 10. queue drain ─────────────────────────────────────────────────────────

test("queue drain defaults to a short bounded wait with progress", () => {
  assert.match(menu, /UPDATE_DRAIN_TIMEOUT_SECONDS="\$\{UPDATE_DRAIN_TIMEOUT_SECONDS:-20\}"/);
  assert.match(menu, /Drain \$\{waited\}s — active=\$active waiting=\$waiting/);
  assert.match(menu, /Queue drained safely in \$\{waited\}s/);
  assert.match(menu, /Update postponed: active send still running after/);
  assert.match(menu, /sleep 1/, "polls every second");
  // A timeout must resume a queue the updater itself paused.
  const timeout = menu.indexOf("Update postponed:");
  assert.ok(menu.indexOf("queue_control resume", timeout) > timeout);
});

test("WAITING jobs are not drained, only the active send is awaited", () => {
  assert.match(menu, /Only the ACTIVE send must finish; WAITING jobs stay durable/);
  assert.match(menu, /if \(\( active == 0 \)\)/);
});

// ── 13. temp cleanup stays narrow ───────────────────────────────────────────

test("only updater-owned stale temp dirs are pruned", () => {
  assert.match(menu, /-maxdepth 1 -type d -name 'gmweb-update\.\*' -mmin \+120/);
  // Never a broad /tmp removal.
  assert.doesNotMatch(menu, /rm -rf \/tmp\/\*/);
  assert.doesNotMatch(menu, /rm -rf \/tmp["'\s]/);
  // The current run's stage is protected by an exact-prefix case.
  assert.match(menu, /case "\$stage" in \/tmp\/gmweb-update\.\*\)/);
});

// ── 12. disk telemetry ──────────────────────────────────────────────────────

test("disk telemetry helpers exist and are used", () => {
  assert.match(lib, /gmweb_disk_used_bytes\(\)/);
  assert.match(lib, /gmweb_fmt_bytes\(\)/);
  assert.match(menu, /gmweb_disk_used_bytes/);
});

// ── 18. stash behaviour preserved ───────────────────────────────────────────

test("operator changes are still stashed, never discarded", () => {
  assert.match(menu, /stash push --include-untracked/);
  assert.match(menu, /Local changes and generated files saved in Git stash/);
});

// ── 17. rollback preserved ──────────────────────────────────────────────────

test("rollback still resets source, artifacts and health", () => {
  assert.match(menu, /Rolling back to/);
  assert.match(menu, /git -C '\$APP_DIR' reset --hard/);
  assert.match(menu, /git clean -fd public\/web-app public\/dashboard-next/);
});

// ── silent-update regression: dubious ownership + permanent stderr redirect ──

test("update_app trusts the checkout before any root-side git call", () => {
  const body = menu.slice(menu.indexOf("update_app() {"));
  const trust = body.indexOf("safe.directory");
  assert.ok(trust > 0, "update_app must add the checkout to safe.directory");
  assert.ok(trust < body.indexOf("git -C \"$APP_DIR\" rev-parse HEAD"), "trust must precede the first root-side git call");
  assert.ok(trust > body.indexOf("chown -R"), "trust is needed because of the chown above it");
});

test("the update lock never leaves stderr permanently redirected", () => {
  // `exec 9>file 2>/dev/null` makes the 2>/dev/null permanent for the whole script.
  assert.doesNotMatch(menu, /^\s*exec\s+\d>[^\n]*\s2>\/dev\/null/m);
  assert.match(menu, /\{ exec 9>\/run\/lock\/gmweb-update\.lock; \} 2>\/dev\/null/);
});

test("a bare exec with a trailing 2>/dev/null really does silence later stderr", { skip: process.platform === "win32" && "needs a POSIX bash" }, () => {
  const { spawnSync } = require("node:child_process");
  const run = (script) => spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const bad = run('exec 9>/dev/null 2>/dev/null; echo oops >&2');
  const good = run('{ exec 9>/dev/null; } 2>/dev/null; echo oops >&2');
  assert.equal(bad.stderr, "", "the old form hides stderr");
  assert.match(good.stderr, /oops/, "the grouped form keeps stderr");
});

// ── domain helper is installed/refreshed by the updater, never fatally ───────

test("the updater installs the domain helper after a healthy promotion and never fails on it", () => {
  const fn = menu.slice(menu.indexOf("ensure_domain_helper() {"), menu.indexOf("update_app() {"));
  assert.match(fn, /GMWEB_DOMAIN_HELPER:-auto/, "has an opt-out");
  assert.match(fn, /install-domain-helper\.sh/);
  assert.match(fn, /--with-packages/, "first install also brings nginx and certbot");
  assert.match(fn, /cmp -s/, "an installed but outdated helper is refreshed");
  assert.match(fn, /return 0\s*\n\}/, "always succeeds");
  const call = menu.indexOf("ensure_domain_helper || true");
  assert.ok(call > menu.indexOf("Updated to $candidate_short"), "runs only after the post-deploy version check passed");
  assert.ok(call < menu.indexOf("Post-deploy version check failed"), "inside the success branch, before any rollback path");
});
