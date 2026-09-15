"use strict";
// The Spec Kit governance gate is a CI required check, so it has to be proven
// to FAIL when the repository drifts - a gate that only ever passes is worse
// than no gate, because it is trusted.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-spec-kit-governance.mjs");

function run(statusPath) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, statusPath].filter(Boolean),
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

function statusFixture(overrides = {}) {
  return JSON.stringify({
    status: "ok",
    default_integration: "dsh",
    installed_integrations: ["dsh"],
    missing_managed_files: 0,
    modified_managed_files: 0,
    invalid_manifest_paths: 0,
    findings: [],
    manifests: { dsh: { readable: true, tracked_files: 10 }, speckit: { readable: true, tracked_files: 12 } },
    ...overrides,
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-speckit-gov-"));
const write = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

describe("Spec Kit governance gate", () => {
  test("a healthy repository passes against a real integration-status report", () => {
    const result = run(write("ok.json", statusFixture()));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Spec Kit governance OK/);
    assert.match(result.stdout, /constitution v\d/);
    assert.match(result.stdout, /extension bug v[\d.]+ enabled, 3 command/);
    assert.match(result.stdout, /extension assess v[\d.]+ enabled, 5 command/);
  });

  for (const [label, overrides, expected] of [
    ["a non-ok integration status", { status: "error" }, /integration status is "error"/],
    ["a non-dsh default integration", { default_integration: "claude" }, /default integration is "claude"/],
    ["missing managed files", { missing_managed_files: 2 }, /2 managed Spec Kit file\(s\) are missing/],
    ["locally modified managed files", { modified_managed_files: 1 }, /1 managed Spec Kit file\(s\) were modified/],
    ["invalid manifest paths", { invalid_manifest_paths: 3 }, /3 manifest path\(s\) are invalid/],
    ["a reported health finding", { findings: [{ code: "x" }] }, /reported 1 finding/],
  ]) {
    test(`fails on ${label}`, () => {
      const result = run(write(`bad-${label.replace(/\W+/g, "-")}.json`, statusFixture(overrides)));
      assert.equal(result.code, 1, "the gate must exit non-zero");
      assert.match(result.stderr, expected);
      assert.match(result.stderr, /Spec Kit governance FAILED/);
    });
  }

  test("fails when the CLI step produced no report at all", () => {
    const result = run(undefined);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no integration-status JSON was supplied/);
  });

  test("fails when the report is not valid JSON", () => {
    const result = run(write("garbage.json", "{not json"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not valid JSON/);
  });
});
