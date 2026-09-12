"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("../shared/event-crypto-policy-v1.json");
const serverPolicy = require("../src/eventCryptoPolicy");

test("server and Web event crypto policies match the shared fixture", async () => {
  assert.deepEqual(serverPolicy.policy, fixture);
  const web = await import("../web/src/lib/eventCryptoPolicy.ts");
  assert.deepEqual(web.CONTENT_CRYPTO_VERSIONS, fixture.contentBearing);
  assert.deepEqual(web.KEY_CRYPTO_VERSIONS, fixture.controlKey);
});
