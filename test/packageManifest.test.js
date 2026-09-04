const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../package.json");

test("server runtime plugins are production dependencies", () => {
  assert.equal(manifest.dependencies["@fastify/cookie"], "^11.1.2");
});
