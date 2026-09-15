#!/usr/bin/env node
"use strict";

// Deterministic Spec Kit governance gate.
//
// This runs in CI and must never depend on an LLM: it validates repository
// STATE only. It is deliberately independent of the Specify CLI's human output
// - the machine-readable inputs are
//   * `specify integration status --json`, produced by the real pinned CLI, and
//   * the on-disk extension registry, because Spec Kit 1.0.6 has NO --json flag
//     for `specify extension list` (verified: the CLI exits 2 with
//     "No such option: --json"). Parsing its prose output would be the guess
//     this file exists to avoid.
//
// Usage: node scripts/check-spec-kit-governance.mjs [integration-status.json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}
function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf8"));
}
function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// 1. The integration must be installed, healthy and UNMODIFIED.
const statusPath = process.argv[2];
if (!statusPath) {
  failures.push("no integration-status JSON was supplied (the CLI step did not run)");
} else {
  let status;
  try {
    status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch (error) {
    failures.push(`integration status was not valid JSON: ${error.message}`);
  }
  if (status) {
    check(status.status === "ok", `integration status is "${status.status}", expected "ok"`);
    check(status.default_integration === "dsh", `default integration is "${status.default_integration}", expected "dsh"`);
    check(Array.isArray(status.installed_integrations) && status.installed_integrations.includes("dsh"),
      "dsh is not in installed_integrations");
    check(status.missing_managed_files === 0, `${status.missing_managed_files} managed Spec Kit file(s) are missing`);
    check(status.modified_managed_files === 0, `${status.modified_managed_files} managed Spec Kit file(s) were modified locally`);
    check(status.invalid_manifest_paths === 0, `${status.invalid_manifest_paths} manifest path(s) are invalid`);
    check(status.manifests?.dsh?.readable === true, "the dsh manifest is not readable");
    check(status.manifests?.speckit?.readable === true, "the speckit manifest is not readable");
    const findings = status.findings || [];
    check(findings.length === 0, `integration health reported ${findings.length} finding(s): ${JSON.stringify(findings)}`);
    notes.push(`integration ${status.default_integration}, tracked files: dsh=${status.manifests?.dsh?.tracked_files}, speckit=${status.manifests?.speckit?.tracked_files}`);
  }
}

// 2. The first-party extensions must be installed AND enabled. The registry is
//    the authoritative machine-readable record.
const REQUIRED_EXTENSIONS = ["bug", "assess"];
const registry = readJson(".specify/extensions/.registry");
for (const name of REQUIRED_EXTENSIONS) {
  const entry = registry.extensions?.[name];
  check(Boolean(entry), `the "${name}" extension is not registered`);
  if (entry) {
    check(entry.enabled === true, `the "${name}" extension is registered but disabled`);
    const commands = entry.registered_commands?.dsh || [];
    check(commands.length > 0, `the "${name}" extension registers no dsh commands`);
    notes.push(`extension ${name} v${entry.version} enabled, ${commands.length} command(s)`);
  }
}
const extensionsYml = fs.readFileSync(path.join(ROOT, ".specify/extensions.yml"), "utf8");
for (const name of REQUIRED_EXTENSIONS) {
  check(new RegExp(`^\\s*-\\s*${name}\\s*$`, "m").test(extensionsYml),
    `${name} is missing from .specify/extensions.yml`);
}

// 3. The constitution must be real, not the shipped template.
const CONSTITUTION = ".specify/memory/constitution.md";
check(exists(CONSTITUTION), `${CONSTITUTION} is missing`);
if (exists(CONSTITUTION)) {
  const constitution = fs.readFileSync(path.join(ROOT, CONSTITUTION), "utf8");
  const template = fs.readFileSync(path.join(ROOT, ".specify/templates/constitution-template.md"), "utf8");
  check(constitution.trim() !== template.trim(), "the constitution is still the unmodified template");

  // Template tokens look like [PROJECT_NAME] / [PRINCIPLE_1_NAME]. The real
  // constitution deliberately contains none of them.
  const placeholders = [...new Set((constitution.match(/\[[A-Z][A-Z0-9_]{2,}\]/g) || []))];
  check(placeholders.length === 0, `the constitution still contains template placeholders: ${placeholders.join(", ")}`);

  const version = constitution.match(/^\*\*Version\*\*:\s*(\S+)/m)?.[1];
  check(Boolean(version), "the constitution does not declare a version");
  const principles = (constitution.match(/^### [IVXL]+\./gm) || []).length;
  check(principles >= 10, `the constitution declares only ${principles} principles`);
  notes.push(`constitution v${version}, ${principles} principles`);
}

// 4. AGENTS.md must keep the mandatory policy. The managed block is the
//    contract; if it disappears the workflow silently stops being enforced.
const AGENTS = "AGENTS.md";
check(exists(AGENTS), `${AGENTS} is missing`);
if (exists(AGENTS)) {
  const agents = fs.readFileSync(path.join(ROOT, AGENTS), "utf8");
  check(agents.includes("BEGIN MANAGED: SPEC_KIT_REPOSITORY_POLICY"),
    "AGENTS.md lost the managed Spec Kit policy block");
  check(/Spec-Driven Development \(Spec Kit\) is mandatory/.test(agents),
    "AGENTS.md no longer declares the Spec Kit workflow mandatory");
  check(agents.includes("/speckit-bug-assess") && agents.includes("/speckit-bug-fix") && agents.includes("/speckit-bug-test"),
    "AGENTS.md no longer documents the assess -> fix -> test bug workflow");
  check(agents.includes("/speckit-specify") && agents.includes("/speckit-converge"),
    "AGENTS.md no longer documents the specify -> ... -> converge feature workflow");
  check(/MUST NOT be declared complete merely because unit tests pass/.test(agents),
    "AGENTS.md lost the definition-of-done rule about unit tests not being sufficient");
  check(agents.includes("## Codebase Memory is mandatory"),
    "AGENTS.md lost the mandatory Codebase Memory section");
  check(agents.includes("## API contract"),
    "AGENTS.md lost the API/OpenAPI contract-sync section");
}

// 5. The skills the policy tells agents to invoke must exist.
const REQUIRED_SKILLS = ["speckit-specify", "speckit-plan", "speckit-tasks", "speckit-analyze",
  "speckit-implement", "speckit-converge", "speckit-bug-assess", "speckit-bug-fix",
  "speckit-bug-test", "speckit-constitution"];
for (const skill of REQUIRED_SKILLS) {
  check(exists(path.join(".dsh", "skills", skill, "SKILL.md")), `.dsh/skills/${skill}/SKILL.md is missing`);
}

// 6. Existing Spec Kit history is an input to the process, not disposable.
check(exists(path.join("specs", "001-final-hardening", "spec.md")),
  "specs/001-final-hardening/spec.md is missing; existing Spec Kit history must not be deleted");

for (const note of notes) console.log(`  - ${note}`);
if (failures.length) {
  console.error("\nSpec Kit governance FAILED:");
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log("\nSpec Kit governance OK.");
