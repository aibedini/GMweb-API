#!/usr/bin/env node
// Canonical front-end build for GMweb-API.
//
//   npm run build:frontends
//
// Builds BOTH SPA artefacts, in dependency order, from their lockfiles:
//
//   dashboard-next/  -> public/dashboard-next   (served at /app)
//   web/             -> public/web-app          (served at /web)
//
// then VERIFIES that what landed on disk belongs to this package.json version.
// Deployments call exactly this, so a server can never serve a bundle from a
// previous revision while the API reports the new one.
//
// npm ci (not npm install): a deployment must build the LOCKED tree, and a
// lockfile that disagrees with package.json has to fail loudly.
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { verifyFrontendArtifacts, DEFAULT_ROOT } from "./verify-frontend-artifacts.mjs";

const APPS = [
  { dir: "dashboard-next", label: "React console (/app)" },
  { dir: "web", label: "PWA (/web)" }
];

function runNpm(args, cwd) {
  // .cmd shims need a shell on Windows; the deployment target is Linux.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed in ${cwd} (exit ${result.status})`);
  }
}

function main() {
  const root = DEFAULT_ROOT;
  const started = Date.now();
  for (const app of APPS) {
    const cwd = path.join(root, app.dir);
    console.log(`\n=== building ${app.label} (${app.dir}) ===`);
    runNpm(["ci"], cwd);
    runNpm(["run", "build"], cwd);
  }

  const result = verifyFrontendArtifacts({ root });
  for (const warning of result.warnings) console.warn(`warn: ${warning}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`FAIL: ${error}`);
    console.error("\nbuild produced artifacts that do not belong to this revision; refusing to continue");
    process.exit(1);
  }
  console.log(`\nfront-ends built and verified for version ${result.version} in ${Math.round((Date.now() - started) / 1000)}s`);
}

main();
