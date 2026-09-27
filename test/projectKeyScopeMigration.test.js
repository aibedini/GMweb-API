"use strict";
// The API-key scope migration that adding `transport:read` requires.
//
// Why this exists: `normalizeProjectKeyScopes` applies the defaults only when a
// key has NO scopes array. A key persisted by the previous release carries an
// explicit array of the OLD defaults, so adding `transport:read` to
// DEFAULT_PROJECT_KEY_SCOPES does not reach it and the consumer's health probe is
// answered with project_scope_denied - the exact failure the scope was added to
// fix. The previous test only covered a key with no scopes field at all, which is
// not what production has.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ApiKeyStore } = require("../src/apiKeys");
const {
  DEFAULT_PROJECT_KEY_SCOPES,
  PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES,
  PROJECT_KEY_SCOPES,
  requiredProjectKeyScope,
} = require("../src/projectKeyScopes");

const TRANSPORT_READ = "transport:read";
const HEALTH_PATH = "/eve/v1/transport-health";

/** The hook's project-key decision, mirrored from src/server.js. */
function projectKeyDecision(store, key, method, url) {
  const requiredScope = requiredProjectKeyScope(method, url);
  if (!requiredScope || !store.hasScope(key, requiredScope)) {
    return { status: 403, error: "project_scope_denied", requiredScope };
  }
  return { status: 200 };
}

async function withKeyFile(keys, run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gmweb-scope-migration-"));
  const keysFile = path.join(dir, "keys.json");
  await fsp.writeFile(keysFile, JSON.stringify(keys));
  try {
    await run(keysFile, path.join(dir, "logs.jsonl"));
  } finally {
    // ApiKeyStore.save() completes its tmp+rename asynchronously. On Windows,
    // directory removal can briefly race the open handle after assertions
    // finish; a bounded retry makes cleanup deterministic without changing
    // what the migration test proves.
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** A persisted key as the previous release wrote it. */
function persistedKey(id, scopes) {
  const key = {
    tokenHash: "hash-" + id,
    tokenPreviewStored: "gmw_old...",
    name: id,
    allowedIps: [],
    enabled: true,
  };
  if (scopes !== undefined) key.scopes = scopes;
  return key;
}

async function readScopes(keysFile, id) {
  const parsed = JSON.parse(await fsp.readFile(keysFile, "utf8"));
  return parsed[id].scopes;
}

/**
 * load() persists fire-and-forget, and save() swallows a failed rename
 * (`.catch(() => {})`, see src/apiKeys.js). Reading the destination while the
 * atomic tmp+rename is in flight can make that rename fail on Windows - so a
 * tight polling loop here would DESTROY the very write it is checking, and the
 * swallowed error would make it look like load() never persisted. Let the write
 * settle without touching the file, then read once.
 */
async function scopesAfterPersist(keysFile, id) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return readScopes(keysFile, id);
}

describe("scope migration for keys persisted by the previous release", () => {
  test("the previous default set is exactly the seven documented scopes", () => {
    assert.deepEqual([...PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES], [
      "sms.send", "sms.status", "sms.cancel", "sms.capacity", "sms.invalidate",
      "conversations.read", "events.read",
    ]);
    // The current defaults are that set PLUS the new scope, one scope at a time.
    assert.deepEqual(
      [...DEFAULT_PROJECT_KEY_SCOPES].filter((s) => !PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES.includes(s)),
      [TRANSPORT_READ]);
  });

  // ── A ─────────────────────────────────────────────────────────────────────
  test("A: a key with exactly the previous defaults gains transport:read", async () => {
    await withKeyFile({ old: persistedKey("old", [...PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES]) },
      async (keysFile, logsFile) => {
        const store = new ApiKeyStore(keysFile, logsFile);
        await store.load();
        const key = store.list()[0];
        assert.ok(key.scopes.includes(TRANSPORT_READ), key.scopes.join(","));
        assert.equal(store.hasScope(key, TRANSPORT_READ), true);
      });
  });

  test("A2: the migration is order-insensitive and deduplicating", async () => {
    const shuffled = [...PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES].reverse();
    shuffled.push(shuffled[0]); // a duplicate must not defeat the comparison
    await withKeyFile({ old: persistedKey("old", shuffled) },
      async (keysFile, logsFile) => {
        const store = new ApiKeyStore(keysFile, logsFile);
        await store.load();
        const key = store.list()[0];
        assert.ok(key.scopes.includes(TRANSPORT_READ));
        assert.equal(new Set(key.scopes).size, key.scopes.length, "no duplicates");
      });
  });

  // ── B ─────────────────────────────────────────────────────────────────────
  test("B: the migration is persisted and survives a reload", async () => {
    await withKeyFile({ old: persistedKey("old", [...PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES]) },
      async (keysFile, logsFile) => {
        const first = new ApiKeyStore(keysFile, logsFile);
        await first.load();
        const onDisk = await scopesAfterPersist(keysFile, "old");
        assert.ok(onDisk.includes(TRANSPORT_READ), "load() must persist the migration");

        const second = new ApiKeyStore(keysFile, logsFile);
        await second.load();
        const key = second.list()[0];
        assert.ok(key.scopes.includes(TRANSPORT_READ));
        assert.equal(new Set(key.scopes).size, key.scopes.length, "no duplicates on reload");
      });
  });

  test("B2: reloading repeatedly is idempotent", async () => {
    await withKeyFile({ old: persistedKey("old", [...PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES]) },
      async (keysFile, logsFile) => {
        let scopes = null;
        for (let round = 0; round < 3; round += 1) {
          const store = new ApiKeyStore(keysFile, logsFile);
          await store.load();
          scopes = store.list()[0].scopes;
        }
        assert.deepEqual([...scopes].sort(), [...DEFAULT_PROJECT_KEY_SCOPES].sort());
      });
  });

  // ── C ─────────────────────────────────────────────────────────────────────
  test("C: a restricted key is never widened", async () => {
    await withKeyFile({
      restricted: persistedKey("restricted", ["sms.send"]),
      pair: persistedKey("pair", ["sms.send", "sms.status"]),
    }, async (keysFile, logsFile) => {
      const store = new ApiKeyStore(keysFile, logsFile);
      await store.load();
      for (const key of store.list()) {
        assert.equal(key.scopes.includes(TRANSPORT_READ), false, key.name);
        assert.equal(store.hasScope(key, TRANSPORT_READ), false);
      }
      assert.deepEqual(store.list().find((k) => k.name === "restricted").scopes, ["sms.send"]);
    });
  });

  // ── D ─────────────────────────────────────────────────────────────────────
  test("D: a custom set of the same size is untouched", async () => {
    // Same length as the previous defaults, but NOT the previous defaults:
    // events.read traded for commands.read. A size check alone would migrate it.
    const custom = [...PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES.filter((s) => s !== "events.read"),
      "commands.read"];
    await withKeyFile({ custom: persistedKey("custom", custom) },
      async (keysFile, logsFile) => {
        const store = new ApiKeyStore(keysFile, logsFile);
        await store.load();
        assert.deepEqual([...store.list()[0].scopes].sort(), [...custom].sort());
        assert.equal(store.hasScope(store.list()[0], TRANSPORT_READ), false);
      });
  });

  test("D2: an explicit full set that is not the old default is untouched", async () => {
    const extra = [...PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES, "commands.read"];
    await withKeyFile({ extra: persistedKey("extra", extra) },
      async (keysFile, logsFile) => {
        const store = new ApiKeyStore(keysFile, logsFile);
        await store.load();
        // It already had more than the defaults, so an operator chose it.
        assert.equal(store.hasScope(store.list()[0], TRANSPORT_READ), false);
      });
  });

  test("a key with no scopes field still gets the current defaults", async () => {
    await withKeyFile({ bare: persistedKey("bare", undefined) },
      async (keysFile, logsFile) => {
        const store = new ApiKeyStore(keysFile, logsFile);
        await store.load();
        assert.deepEqual([...store.list()[0].scopes].sort(),
          [...DEFAULT_PROJECT_KEY_SCOPES].sort());
        assert.equal(store.hasScope(store.list()[0], TRANSPORT_READ), true);
      });
  });

  test("a newly created key has transport:read", () => {
    const store = new ApiKeyStore("unused", "unused");
    store.save = () => Promise.resolve();
    const key = store.create({ name: "fresh" });
    assert.ok(key.scopes.includes(TRANSPORT_READ));
    assert.equal(store.hasScope(key, TRANSPORT_READ), true);
  });

  // ── E and F: what the auth hook does with each key ────────────────────────
  test("E: a migrated old-default key is authorised on the health route", async () => {
    await withKeyFile({ old: persistedKey("old", [...PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES]) },
      async (keysFile, logsFile) => {
        const store = new ApiKeyStore(keysFile, logsFile);
        await store.load();
        const decision = projectKeyDecision(store, store.list()[0], "GET", HEALTH_PATH);
        assert.equal(decision.status, 200, JSON.stringify(decision));
      });
  });

  test("F: a restricted key is denied with the missing scope named", async () => {
    await withKeyFile({ restricted: persistedKey("restricted", ["sms.send"]) },
      async (keysFile, logsFile) => {
        const store = new ApiKeyStore(keysFile, logsFile);
        await store.load();
        const decision = projectKeyDecision(store, store.list()[0], "GET", HEALTH_PATH);
        assert.equal(decision.status, 403);
        assert.equal(decision.error, "project_scope_denied");
        assert.equal(decision.requiredScope, TRANSPORT_READ);
      });
  });

  test("the migrated scope is a grantable, declared scope", () => {
    assert.ok(PROJECT_KEY_SCOPES.includes(TRANSPORT_READ));
    assert.ok(DEFAULT_PROJECT_KEY_SCOPES.includes(TRANSPORT_READ));
  });
});
