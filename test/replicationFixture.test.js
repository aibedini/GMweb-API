"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("replication v3 fixture pins the Android and GMweb wire contract", () => {
  const web = fs.readFileSync(path.join(__dirname, "..", "shared", "messages-web-replication-v3.json"));
  const fixture = JSON.parse(web);
  assert.equal(fixture.protocolVersion, 3);
  assert.equal(fixture.priority.maxPendingBackfill, 2000);
});
