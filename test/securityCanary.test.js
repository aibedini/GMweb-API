"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");
const { EventStore } = require("../src/eventStore");

function representations(value) {
  return new Set([
    value,
    Buffer.from(value).toString("base64"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]);
}

test("security canary leaves no plaintext representation in server or browser replicas", async () => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const phone = `+98999${crypto.randomInt(1000000, 9999999)}`;
  const body = `SECURITY_CANARY_SMS_${nonce}`;
  const eventId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ phone, body, messageId })), cipher.final(), cipher.getAuthTag(),
  ]);
  const b64 = value => Buffer.from(value).toString("base64");
  const envelope = Buffer.from(JSON.stringify({
    v: 3, kind: "message", eventId, type: "MESSAGE_CREATED", conversationId,
    iv: b64(iv), ciphertext: b64(ciphertext),
    historyWrapIv: b64(crypto.randomBytes(12)), historyWrappedDek: b64(crypto.randomBytes(48)),
    liveWrapIv: b64(crypto.randomBytes(12)), liveWrappedDek: b64(crypto.randomBytes(48)),
  }));

  const lines = [];
  const sqlite = new Database(":memory:");
  const store = new EventStore(sqlite, { log: line => lines.push(line), debug: line => lines.push(line) });
  store.ingestBatch({ accountId: "canary", sourceDeviceId: "android", events: [{
    eventId, messageId, type: "MESSAGE_CREATED", conversationId,
    payload: envelope, encoding: "envelope.v3", schemaVersion: 1, cryptoVersion: 3,
  }] });
  const metadata = store.replicaMetadata("canary");
  const syncPage = store.after("canary", 0);
  const serverRepresentations = [sqlite.serialize().toString("latin1"), JSON.stringify(syncPage), lines.join("\n")];

  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const path = String(url);
    if (/\/linked-device\/(?:key-grants|keyring)/.test(path)) {
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (path.includes("/web/bootstrap")) return Response.json({
      protocolVersion: 3, ...metadata, highWatermark: 0, contactEvents: [],
      conversations: [], nextCursor: null, hasMore: false,
    });
    if (path.includes("/web/sync/ack") && options?.method === "POST") return Response.json({ ok: true });
    if (path.includes("/sync?after=0")) return Response.json(syncPage);
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const sync = await import("../web/src/lib/sync.ts");
    await sync.syncStep();
    const browserDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open("gmweb-messages");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await Promise.all(["events", "encrypted_message_state", "conversations"].map(name =>
      new Promise((resolve, reject) => {
        const request = browserDb.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })));
    browserDb.close();
    const inspected = [...serverRepresentations, JSON.stringify(stored)];
    for (const secret of [phone, body]) {
      for (const encoded of representations(secret)) {
        assert.equal(inspected.some(value => value.includes(encoded)), false);
      }
    }
  } finally {
    global.fetch = originalFetch;
    sqlite.close();
  }
});
