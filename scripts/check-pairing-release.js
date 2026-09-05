#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const REQUIRED_STEPS = ["fresh_apk", "primary_enrollment", "clean_browser", "qr_scan",
  "android_metadata", "biometric_approval", "web_certificate_verification", "challenge_signature",
  "linked_cookie", "sync", "encrypted_history", "full_history_grant", "from_now_on_denied",
  "browser_reload", "server_restart", "still_linked", "phone_revoke", "browser_unauthorized",
  "revoked_no_new_epochs", "ciphertext_only_server"];
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fingerprint() {
  const hash = crypto.createHash("sha256");
  function visit(relative) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) throw new Error(`Missing release input: ${relative}`);
    if (fs.statSync(file).isDirectory()) {
      for (const child of fs.readdirSync(file).sort()) visit(`${relative}/${child}`);
    } else {
      hash.update(relative + "\0"); hash.update(fs.readFileSync(file)); hash.update("\0");
    }
  }
  for (const input of ["src", "shared", "public/web-app", "public/dashboard-next", "package.json", "package-lock.json"]) visit(input);
  return hash.digest("hex");
}
function validate(report, { serverSha256, apkSha256, fixtureSha256 }) {
  if (report.kind !== "physical-phone-pairing-e2e" || report.physicalDevice !== true ||
      !report.tester || !report.deviceModel || !report.androidVersion || !report.browserVersion)
    throw new Error("A named tester and a physical phone/browser report are required");
  if (report.serverSha256 !== serverSha256 || report.apkSha256 !== apkSha256 || report.fixtureSha256 !== fixtureSha256)
    throw new Error("E2E evidence does not match these release artifacts");
  let previous = 0;
  for (const name of REQUIRED_STEPS) {
    const step = report.steps?.[name];
    const time = Date.parse(step?.at);
    if (step?.passed !== true || !step.evidence || !Number.isFinite(time) || time < previous || time > Date.now() + 60000)
      throw new Error(`Missing/invalid physical E2E evidence: ${name}`);
    previous = time;
  }
}
function main() {
  if (process.argv[2] === "--fingerprint") {
    console.log(JSON.stringify({ serverSha256: fingerprint(), fixtureSha256: sha256(fs.readFileSync(path.join(root, "shared/pairing-protocol-v1.json"))) }, null, 2));
    return;
  }
  const [reportFile, apkFile] = process.argv.slice(2);
  if (!reportFile || !apkFile) throw new Error("Release blocked: provide physical E2E report and tested APK paths");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  validate(report, { serverSha256: fingerprint(), apkSha256: sha256(fs.readFileSync(apkFile)),
    fixtureSha256: sha256(fs.readFileSync(path.join(root, "shared/pairing-protocol-v1.json"))) });
  console.log("Physical pairing E2E gate passed for these exact release artifacts.");
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { REQUIRED_STEPS, validate, fingerprint };
