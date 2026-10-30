"use strict";
// A gateway's HTML error page must never be pasted into the UI as the message.
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../web/src/lib/api.ts");
const NGINX = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center><h1>502 Bad Gateway</h1></center></body></html>";

test("gateway HTML becomes one readable sentence", async () => {
  const { describeHttpFailure } = await load();
  const text = describeHttpFailure(502, NGINX);
  assert.doesNotMatch(text, /</);
  assert.match(text, /not responding \(HTTP 502\)/);
});

test("JSON error fields are kept, raw bodies are bounded", async () => {
  const { describeHttpFailure } = await load();
  assert.equal(describeHttpFailure(400, '{"error":"bad_cursor"}'), "bad_cursor (HTTP 400)");
  assert.equal(describeHttpFailure(409, { message: "Snapshot required" }), "Snapshot required (HTTP 409)");
  assert.equal(describeHttpFailure(500, ""), "Request failed (HTTP 500).");
  assert.ok(describeHttpFailure(500, "x".repeat(5000)).length < 200);
  assert.match(describeHttpFailure(401, "<html>denied</html>"), /session was rejected \(HTTP 401\)/);
});
