const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ApiKeyStore } = require("../src/apiKeys");
const {
  DEFAULT_PROJECT_KEY_SCOPES,
  requiredProjectKeyScope,
} = require("../src/projectKeyScopes");
const contract = require("../shared/eve-gmweb-contract-v1.json");

function concretePath(value) {
  return value.replace("{requestId}", "request-1");
}

test("GMweb production routes retain the Eve compatibility contract", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  assert.doesNotMatch(source, /legacy_send_retired/);
  for (const endpoint of contract.endpoints) {
    const routePath = endpoint.path.replace("{requestId}", ":reference");
    assert.ok(
      source.includes(`app.${endpoint.method.toLowerCase()}("${routePath}"`),
      `missing production route ${endpoint.method} ${routePath}`,
    );
    assert.equal(
      requiredProjectKeyScope(endpoint.method, concretePath(endpoint.path)),
      endpoint.scope,
    );
  }
});

test("production Fastify accepts Eve /send and denies unscoped commands", async (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousApiToken = process.env.API_TOKEN;
  process.env.NODE_ENV = "test";
  process.env.API_TOKEN = "contract-master-token";
  const queueModulePath = require.resolve("../src/queue");
  const previousQueueModule = require.cache[queueModulePath];
  class ContractQueue {
    async close() {}
  }
  require.cache[queueModulePath] = {
    id: queueModulePath,
    filename: queueModulePath,
    loaded: true,
    exports: { SendQueue: ContractQueue, QUEUE_NAME: "gmweb-send" },
    children: [],
    paths: [],
  };
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousApiToken === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = previousApiToken;
    if (previousQueueModule) require.cache[queueModulePath] = previousQueueModule;
    else delete require.cache[queueModulePath];
  });

  const { app, __testing } = require("../src/server");
  assert.equal(require("../src/config").apiToken, "contract-master-token");
  const { apiKeyStore, sendQueue, sendStore } = __testing;
  apiKeyStore.save = () => Promise.resolve();
  const key = apiKeyStore.create({
    name: "eve-runtime-contract",
    scopes: contract.projectKeyDefaults.scopes,
    rateLimit: {
      minute: contract.projectKeyDefaults.ingressRatePerMinute,
      hour: contract.projectKeyDefaults.ingressRatePerHour,
    },
  });
  assert.equal(apiKeyStore.findByToken(key.token)?.name, "eve-runtime-contract");
  assert.equal(apiKeyStore.hasScope(apiKeyStore.findByToken(key.token), "commands.create"), false);

  sendQueue.reserveIdempotency = async () => "OK";
  sendQueue.enqueue = async () => ({ id: "contract-job" });
  sendQueue.setIdempotencyJob = async () => {};
  sendQueue.queuePositionForPriority = async () => 0;
  sendStore.create = () => 1;
  sendStore.requestId = () => "contract-request";
  sendStore.attachJob = () => {};

  await app.ready();
  t.after(async () => {
    await app.close();
    await sendQueue.close();
    sendStore.close();
  });

  const headers = {
    authorization: `Bearer ${key.token}`,
    "idempotency-key": "eve-contract-idempotency",
  };
  const response = await app.inject({
    method: "POST",
    url: "/send",
    headers,
    payload: { to: "+989121234567", text: "contract", priority: "critical" },
  });
  assert.equal(response.statusCode, 202, response.payload);
  assert.equal(response.json().status, "queued");

  const denied = await app.inject({
    method: "POST",
    url: "/api/v1/commands",
    headers,
    payload: {
      type: "SEND_SMS",
      payload: "Y29udHJhY3Q=",
      encoding: "envelope.v1",
      schemaVersion: 1,
      cryptoVersion: 1,
      idempotencyKey: "eve-must-not-create-command",
    },
  });
  assert.equal(denied.statusCode, 403, denied.payload);
  assert.equal(denied.json().error, "project_scope_denied");
});

test("legacy keys are migrated to least-privilege scopes and aligned ingress limits", () => {
  const store = new ApiKeyStore("unused", "unused");
  store.save = () => Promise.resolve();
  const created = store.create({ name: "eve-contract" });
  assert.equal(created.sendRateMinute, contract.projectKeyDefaults.ingressRatePerMinute);
  assert.equal(created.sendRateHour, contract.projectKeyDefaults.ingressRatePerHour);
  for (const scope of contract.projectKeyDefaults.scopes) {
    assert.ok(created.scopes.includes(scope));
  }
  assert.deepEqual(created.scopes, [...DEFAULT_PROJECT_KEY_SCOPES]);
  assert.equal(store.hasScope(created, "commands.create"), false);

  const commandKey = store.create({ name: "command-client", scopes: ["commands.create"] });
  assert.equal(store.hasScope(commandKey, "commands.create"), true);
  assert.equal(store.hasScope(commandKey, "sms.send"), false);
});

test("loading a pre-scope key grants no command capability", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gmweb-key-scope-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const keysFile = path.join(dir, "keys.json");
  await fsp.writeFile(keysFile, JSON.stringify({
    legacy: {
      tokenHash: "not-used-in-this-test",
      tokenPreviewStored: "gmw_old...",
      name: "legacy",
      allowedIps: [],
      enabled: true,
    },
  }));
  const store = new ApiKeyStore(keysFile, path.join(dir, "logs.jsonl"));
  await store.load();
  const key = store.list()[0];
  assert.deepEqual(key.scopes, [...DEFAULT_PROJECT_KEY_SCOPES]);
  assert.equal(store.hasScope(key, "commands.create"), false);
  assert.equal(store.hasScope(key, "commands.read"), false);
});
