"use strict";
// Installer apt policy.
//
// Field symptom this file guards against: on Ubuntu 22.04 `apt-get install` handed the
// terminal to needrestart, which drew a whiptail "Daemons using outdated libraries /
// Which services should be restarted?" screen. The operator could not answer it (keys
// appeared as literal `^[[A^[[B`), the install stopped forever, and the next attempt
// died on the dpkg lock and half-configured packages the interruption left behind.
//
// The contract is therefore: every apt invocation in this repository runs with
// DEBIAN_FRONTEND=noninteractive + NEEDRESTART_MODE=l, never reads the terminal, is
// bounded by a dpkg lock timeout, and a previously interrupted run is repaired first.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const installer = read("install/quick-install.sh");
const legacyInstaller = read("install/ubuntu22.sh");
const dashboard = read("scripts/public-dashboard.sh");
const domainHelper = read("scripts/install-domain-helper.sh");
const uninstall = read("scripts/uninstall.sh");
const lib = read("scripts/gmweb-lib.sh");

/** Locate a usable bash without assuming it is on PATH (Windows has no `bash`). */
function bashPath() {
  const candidates = [
    process.env.GMWEB_TEST_BASH,
    process.env.BASH,
    "/bin/bash",
    "/usr/bin/bash",
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
    const probe = spawnSync(candidate, ["-c", "true"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const bash = bashPath();

// ── static contract ──────────────────────────────────────────────────────────

test("the installer exports a non-interactive apt policy before the first apt call", () => {
  // Comments above the policy block mention `apt-get`, so compare against real code only.
  const code = installer
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const firstApt = code.indexOf("apt-get");
  assert.ok(firstApt > 0, "the installer uses apt-get");
  for (const marker of [
    "export DEBIAN_FRONTEND=noninteractive",
    "export NEEDRESTART_MODE=l",
    "export APT_LISTCHANGES_FRONTEND=none",
    "export UCF_FORCE_CONFFOLD=1",
  ]) {
    const at = code.indexOf(marker);
    assert.ok(at > 0, `${marker} is present`);
    assert.ok(at < firstApt, `${marker} is set before the first apt-get call`);
  }
});

test("needrestart is pinned to list-only in both installers", () => {
  // The dialog is drawn by needrestart's apt hook, not by debconf: DEBIAN_FRONTEND
  // alone does NOT suppress it. The persisted policy is what makes the fix durable.
  assert.match(installer, /\$nrconf\{restart\} = 'l';/);
  assert.match(legacyInstaller, /\$nrconf\{restart\} = 'l';/);
  assert.match(installer, /NEEDRESTART_MODE=l/);
  assert.match(legacyInstaller, /NEEDRESTART_MODE=l/);
});

test("the menu installer never calls apt directly", () => {
  assert.doesNotMatch(installer, /logged apt-get install/);
  assert.doesNotMatch(installer, /apt-get install -y/);
  const calls = installer.match(/apt_get (install|update|purge|autoremove)/g) || [];
  assert.ok(calls.length >= 5, `all apt work goes through apt_get (found ${calls.length})`);
});

test("apt_get is bounded and never reads stdin", () => {
  const start = installer.indexOf("apt_get() {");
  assert.ok(start > 0, "the helper exists");
  const helper = installer.slice(start, installer.indexOf("\n}\n", start));
  assert.match(helper, /DPkg::Lock::Timeout=120/, "dpkg lock wait is bounded");
  assert.match(helper, /--force-confold/, "conffile prompts are answered up front");
  assert.match(helper, /<\/dev\/null/, "stdin is detached so apt cannot consume the script");
});

test("an interrupted run is repaired before apt is used again", () => {
  const repair = installer.indexOf("apt_repair() {");
  assert.ok(repair > 0, "the repair helper exists");
  const body = installer.slice(repair, installer.indexOf("\n}\n", repair));
  assert.match(body, /dpkg --configure -a/, "half-configured packages are completed");
  assert.match(body, /apt-get -y[\s\S]*?-f install/, "broken dependencies are fixed");

  const installPackages = installer.slice(installer.indexOf("install_packages() {"));
  const repairCall = installPackages.indexOf("apt_repair");
  const firstUpdate = installPackages.indexOf("apt_get update");
  assert.ok(repairCall > 0 && repairCall < firstUpdate, "repair runs before the first install");
});

test("supporting scripts install packages headlessly too", () => {
  for (const [name, text] of Object.entries({
    "scripts/public-dashboard.sh": dashboard,
    "scripts/install-domain-helper.sh": domainHelper,
    "scripts/uninstall.sh": uninstall,
  })) {
    assert.match(text, /NEEDRESTART_MODE=l/, `${name} sets the needrestart policy`);
    for (const line of text.split("\n")) {
      if (!/^\s*[^#\s][^\n]*\bapt-get\s+(install|update|purge|autoremove)/.test(line)) continue;
      assert.match(line, /<\/dev\/null/, `${name} detaches stdin: ${line.trim()}`);
    }
  }
  assert.match(lib, /NEEDRESTART_MODE=l/);
  assert.match(lib, /DPkg::Lock::Timeout=30/);
});

// ── behavioural check of the real helpers ────────────────────────────────────

test("apt_get and apt_repair behave as declared", { skip: bash ? false : "bash not available" }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-headless-apt-"));
  const toPosix = (value) => value.replace(/\\/g, "/");
  const probe = path.join(tmp, "probe.sh");
  const script = [
    "set -uo pipefail",
    'T="$1"',
    'GMWEB_INSTALL_LIB_ONLY=1 source "$2"',
    'LOG_DIR="$T/log"; INSTALL_LOG="$LOG_DIR/install.log"; mkdir -p "$LOG_DIR"',
    'export NEEDRESTART_CONF_DIR="$T/needrestart"',
    "apt-get() {",
    '  printf "%s\\n" "$*" >>"$T/apt-args"',
    '  printf "mode=%s tty=%s stdin=%s\\n" "${NEEDRESTART_MODE:-unset}" "$([[ -t 0 ]] && echo yes || echo no)" \\',
    '    "$(readlink /proc/self/fd/0 2>/dev/null || readlink /dev/stdin 2>/dev/null || echo unknown)" >>"$T/apt-env"',
    "}",
    "dpkg() {",
    '  if [[ "$1" == "--audit" ]]; then printf "Package foo is half configured\\n"; return 0; fi',
    '  printf "%s\\n" "$*" >>"$T/dpkg-calls"',
    "}",
    "pkill() { return 1; }",
    "fuser() { return 1; }",
    "apt_repair",
    "apt_get update",
    "apt_get install curl",
  ].join("\n");
  fs.writeFileSync(probe, `${script}\n`);

  const result = spawnSync(bash, [toPosix(probe), toPosix(tmp), toPosix(path.join(root, "install/quick-install.sh"))], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `probe failed: ${result.stderr}`);

  const args = fs.readFileSync(path.join(tmp, "apt-args"), "utf8").trim().split("\n");
  assert.ok(args.some((line) => line.includes(" update")), "update went through apt_get");
  assert.ok(args.some((line) => line.includes(" install curl")), "install went through apt_get");
  for (const line of args) {
    assert.ok(line.includes("-y"), `-y on: ${line}`);
    assert.ok(line.includes("DPkg::Lock::Timeout=120"), `lock bound on: ${line}`);
  }

  const env = fs.readFileSync(path.join(tmp, "apt-env"), "utf8").trim().split("\n");
  for (const line of env) {
    assert.equal(line, "mode=l tty=no stdin=/dev/null", `non-interactive environment: ${line}`);
  }

  const dpkgCalls = fs.readFileSync(path.join(tmp, "dpkg-calls"), "utf8");
  assert.match(dpkgCalls, /--configure -a/, "the interrupted dpkg state was repaired");

  const conf = fs.readFileSync(path.join(tmp, "needrestart", "99-gmweb-headless.conf"), "utf8");
  assert.match(conf, /\$nrconf\{restart\} = 'l';/);
});
