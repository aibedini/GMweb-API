#!/usr/bin/env node
"use strict";

// Cross-repository contract guard: GMweb is the provider, Eve is the consumer.
//
// This check used to grep Eve's messaging.py for literal endpoint paths such as
// "/send/capacity". Eve legitimately moved endpoint resolution into the shared
// contract module - messaging.py now calls
// gmweb_contract.endpoint_path('send_capacity') - so the grep failed while the
// two contract fixtures were in perfect agreement. The assertion was testing an
// implementation detail that the contract itself now owns, and it made CI red
// on every pull request for a non-defect.
//
// What is actually worth guaranteeing across the boundary:
//   1. the two fixture files are byte-identical;
//   2. Eve resolves GMweb endpoints THROUGH that fixture, not by hard-coding;
//   3. every endpoint key Eve resolves is defined by the fixture;
//   4. the lifecycle-critical endpoints are among the ones Eve resolves;
//   5. the shared contract module owns the Idempotency-Key header name.
//
// The verification core is exported so tests can drive it with synthetic
// inputs; the CLI wrapper keeps CI usage unchanged.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Endpoints whose loss breaks the send lifecycle rather than a cosmetic
// feature. Keys are defined in shared/eve-gmweb-contract-v1.json.
const REQUIRED_CONSUMER_KEYS = ["send", "send_capacity", "send_cancel", "post_invalidate", "send_status"];

function endpointKeysReferencedBy(eveSource) {
  const keys = new Set();
  // Full-line comments are stripped first: a commented-out call must not be
  // able to satisfy the guard. Matching stays prefix-agnostic so an aliased
  // import still counts, and key validity is enforced separately.
  const code = String(eveSource)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  for (const match of code.matchAll(/endpoint_path\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
    keys.add(match[1]);
  }
  return keys;
}

/** Throws (via assert) when the consumer no longer honours the shared contract. */
function verifyEveConsumer({ localContract, eveSource, contractModuleSource }) {
  const contractKeys = new Set((localContract.endpoints || []).map((endpoint) => endpoint.key));
  assert.ok(contractKeys.size > 0, "the GMweb contract must declare endpoints");

  assert.ok(/gmweb_contract/.test(eveSource),
    "Eve must import and use the shared gmweb_contract module rather than calling GMweb paths directly");

  const referenced = endpointKeysReferencedBy(eveSource);
  assert.ok(referenced.size > 0,
    "Eve no longer resolves any GMweb endpoint through the shared contract");

  for (const key of referenced) {
    assert.ok(contractKeys.has(key),
      `Eve resolves contract endpoint key "${key}" which GMweb does not define`);
  }

  for (const key of REQUIRED_CONSUMER_KEYS) {
    assert.ok(contractKeys.has(key),
      `the GMweb contract no longer defines the "${key}" endpoint`);
    assert.ok(referenced.has(key),
      `Eve no longer resolves the "${key}" endpoint through the shared contract`);
  }

  assert.ok(/idempotency_key\s*=/.test(eveSource),
    "Eve must send a stable idempotency key on the send path");
  assert.ok(/Idempotency-Key/.test(contractModuleSource),
    "the shared contract module must own the Idempotency-Key header name");

  return { referenced: [...referenced].sort() };
}

function verifyFixtures(localContract, peerContract) {
  assert.deepEqual(peerContract, localContract, "Eve and GMweb contract fixtures differ");
}

function readPeerSources(peerRoot) {
  return {
    peerContract: JSON.parse(
      fs.readFileSync(path.join(peerRoot, "shared", "eve-gmweb-contract-v1.json"), "utf8")),
    eveSource: fs.readFileSync(path.join(peerRoot, "panel", "jobs", "messaging.py"), "utf8"),
    contractModuleSource: fs.readFileSync(
      path.join(peerRoot, "panel", "services", "gmweb_contract.py"), "utf8"),
  };
}

if (require.main === module) {
  const peerRoot = path.resolve(process.argv[2] || "eve-contract-peer");
  const localContract = require("../shared/eve-gmweb-contract-v1.json");
  const { peerContract, eveSource, contractModuleSource } = readPeerSources(peerRoot);

  verifyFixtures(localContract, peerContract);
  const { referenced } = verifyEveConsumer({ localContract, eveSource, contractModuleSource });
  console.log(
    `Eve and GMweb compatibility contract is synchronized (Eve resolves: ${referenced.join(", ")}).`);
}

module.exports = {
  verifyEveConsumer,
  verifyFixtures,
  endpointKeysReferencedBy,
  readPeerSources,
  REQUIRED_CONSUMER_KEYS,
};
