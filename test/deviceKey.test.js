const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DeviceKeyStore } = require("../src/deviceKey");

test("device key falls back to env, then persists generated keys", async () => {
  const filePath = path.join(os.tmpdir(), `dk-${Date.now()}.json`);
  const fromEnv = new DeviceKeyStore({ filePath, envValue: "devk_from_env_123456" });
  await fromEnv.load();
  assert.equal(fromEnv.configured, true);
  assert.equal(fromEnv.key, "devk_from_env_123456");
  assert.equal(fromEnv.source, "env");
  assert.match(fromEnv.preview(), /^devk_…3456$/);

  const none = new DeviceKeyStore({ filePath: path.join(os.tmpdir(), `dk2-${Date.now()}.json`), envValue: "" });
  await none.load();
  assert.equal(none.configured, false);
  assert.equal(none.preview(), null);

  const fresh = new DeviceKeyStore({ filePath, envValue: "" });
  await fresh.load();
  assert.equal(fresh.configured, false); // no file, no env -> unconfigured
  const key = await fresh.generate();
  assert.ok(key.startsWith("devk_"));
  assert.equal(fresh.source, "file");

  // Reload from disk: persisted key wins.
  const reloaded = new DeviceKeyStore({ filePath, envValue: "devk_other" });
  await reloaded.load();
  assert.equal(reloaded.key, key);

  // Short keys are rejected on set().
  await assert.rejects(() => fresh.set("short"), /key_too_short/);
  await fs.rm(filePath, { force: true });
});
