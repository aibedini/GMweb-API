#!/usr/bin/env node
// Release-integrity check for the generated front-ends.
//
// The production incident this exists for: the API was on 0.19.1 while the
// served PWA was still 0.18.0, because nothing ever rebuilt public/web-app and
// nothing ever compared the two. A release candidate where the API version and
// the generated PWA version differ MUST fail.
//
// Used by:
//   * npm test                    (committed artifacts are verified current)
//   * npm run build:frontends     (after building)
//   * deploy-gmweb.sh             (BEFORE anything is promoted or restarted)
//
// Artifact policy (documented in docs/DEPLOYMENT.md): generated bundles ARE
// committed (so a fresh clone can serve /web and /app) AND they are verified to
// belong to the current revision on every test run and every deployment, which
// additionally rebuilds them for the exact candidate SHA.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(here, "..");

const APP_TARGETS = [
  { name: "PWA", dir: ["public", "web-app"], base: "/web/", requiresVersion: true },
  { name: "Dashboard", dir: ["public", "dashboard-next"], base: "/app/", requiresVersion: false }
];

function htmlRefs(htmlPath, base) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const refs = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1];
    if (!url.startsWith(base)) continue;
    refs.add(url);
  }
  return [...refs];
}

/**
 * @returns {{ok: boolean, version: string, errors: string[], warnings: string[]}}
 */
export function verifyFrontendArtifacts({ root = DEFAULT_ROOT, expectedVersion = null } = {}) {
  const errors = [];
  const warnings = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = String(expectedVersion || pkg.version);

  for (const target of APP_TARGETS) {
    const dir = path.join(root, ...target.dir);
    const indexHtml = path.join(dir, "index.html");
    if (!fs.existsSync(indexHtml)) {
      errors.push(`${target.name}: ${path.relative(root, indexHtml)} is missing — the ${target.name} was never built`);
      continue;
    }
    // Every same-origin asset the entry point references must exist: a hashed
    // bundle that 404s is a white screen, and a *stale* entry point pointing at
    // a deleted bundle is exactly how a half-built release serves.
    for (const ref of htmlRefs(indexHtml, target.base)) {
      const file = path.join(dir, ref.slice(target.base.length));
      if (!fs.existsSync(file)) {
        errors.push(`${target.name}: index.html references ${ref} but that file does not exist`);
      }
    }
    if (target.requiresVersion) {
      const manifestPath = path.join(dir, "version.json");
      if (!fs.existsSync(manifestPath)) {
        errors.push(`${target.name}: ${path.relative(root, manifestPath)} is missing`);
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        errors.push(`${target.name}: version.json is not valid JSON`);
        continue;
      }
      if (String(manifest?.version || "") !== version) {
        errors.push(
          `${target.name} version drift: version.json says ${JSON.stringify(manifest?.version ?? null)} ` +
          `but package.json says ${version} — the front-end was not rebuilt for this revision`
        );
      }
    }
  }

  // Optional build provenance: when present it must agree with package.json.
  const infoPath = path.join(root, "public", "web-app", "build-info.json");
  if (fs.existsSync(infoPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      if (info?.version && String(info.version) !== version) {
        errors.push(`PWA build-info version drift: ${info.version} != ${version}`);
      }
    } catch {
      warnings.push("PWA: build-info.json present but unreadable");
    }
  } else {
    warnings.push("PWA: build-info.json absent (built before provenance was added)");
  }

  return { ok: errors.length === 0, version, errors, warnings };
}

function main() {
  const result = verifyFrontendArtifacts({});
  for (const warning of result.warnings) console.warn(`warn: ${warning}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`FAIL: ${error}`);
    console.error(`\nfrontend artifacts do NOT match package.json version ${result.version}`);
    process.exit(1);
  }
  console.log(`frontend artifacts OK — API and generated front-ends are both ${result.version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
