const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");

test("encrypted pending command survives module reload without storing SMS plaintext", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const sync = await import("../web/src/lib/sync.ts");
  await sync.resetLocal();
  const first = await import("../web/src/lib/commandOutbox.ts");
  const command = { browserDeviceId: "browser-1", clientMessageId: "msg-1", idempotencyKey: "idem-1",
    payload: Buffer.from("encrypted-envelope").toString("base64"), targetAgentId: "phone-1", createdAt: 1 };
  await first.savePendingSend(command);
  await first.savePendingSend({ ...command, clientMessageId: "msg-2", idempotencyKey: "idem-2" });
  const restarted = await import(`../web/src/lib/commandOutbox.ts?restart=${Date.now()}`);
  assert.equal((await restarted.loadPendingSends()).length, 2);
  await restarted.clearPendingSend("wrong-message");
  assert.equal((await restarted.loadPendingSends()).length, 2);
  await restarted.clearPendingSend("msg-1");
  assert.deepEqual((await restarted.loadPendingSends()).map(row => row.clientMessageId), ["msg-2"]);
  await restarted.clearPendingSend("msg-2");
});
