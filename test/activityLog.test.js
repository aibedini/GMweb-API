const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ActivityLogStore, classify } = require("../src/activityLog");

test("classifies operational routes and mutating actions", () => {
  assert.deepEqual(classify("/admin/queue/pause", "POST"), { category: "messaging", type: "action" });
  assert.deepEqual(classify("/admin/api-keys", "GET"), { category: "security", type: "request" });
  assert.deepEqual(classify("/browser/restart", "POST"), { category: "browser", type: "action" });
  assert.deepEqual(classify("/api/v1/pairing/approve", "POST"), { category: "pairing", type: "action" });
  assert.deepEqual(classify("/api/v1/agent/identity", "POST"), { category: "pairing", type: "action" });
});

test("stores structured rows and returns filtered facets", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gmweb-activity-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ActivityLogStore(path.join(dir, "activity.jsonl"));

  await store.append({ method: "GET", path: "/health", statusCode: 200, durationMs: 3.7, actor: { type: "anonymous", name: "Health check" } });
  await store.append({ method: "POST", path: "/admin/queue/pause", statusCode: 204, durationMs: 18, actor: { type: "dashboard", name: "operator" } });
  await store.append({ method: "POST", path: "/send", statusCode: 429, durationMs: 7, actor: { type: "api_key", name: "CRM", id: "key-1" } });

  const actions = await store.query({ type: "action" });
  assert.equal(actions.total, 2);
  assert.equal(actions.logs[0].level, "warning");
  assert.equal(actions.logs[0].outcome, "failed");
  assert.equal(actions.logs[1].category, "messaging");
  assert.deepEqual(actions.facets.types, { request: 1, action: 2 });
  assert.equal(actions.facets.categories.messaging, 2);

  const searched = await store.query({ search: "CRM", actorType: "api_key" });
  assert.equal(searched.total, 1);
  assert.equal(searched.logs[0].actor.id, "key-1");
});
