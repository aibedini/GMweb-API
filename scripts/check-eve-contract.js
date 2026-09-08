#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const peerRoot = path.resolve(process.argv[2] || "eve-contract-peer");
const localContract = require("../shared/eve-gmweb-contract-v1.json");
const peerContractPath = path.join(peerRoot, "shared", "eve-gmweb-contract-v1.json");
const peerContract = JSON.parse(fs.readFileSync(peerContractPath, "utf8"));
assert.deepEqual(peerContract, localContract, "Eve and GMweb contract fixtures differ");

const eveSource = fs.readFileSync(path.join(peerRoot, "panel", "jobs", "messaging.py"), "utf8");
for (const fragment of [
  "/send/capacity",
  '/send",',
  "/send/cancel/",
  "/send/status/",
  "Idempotency-Key",
]) {
  assert.ok(eveSource.includes(fragment), `Eve consumer no longer contains ${fragment}`);
}

console.log("Eve and GMweb compatibility contract is synchronized.");
