"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");

test("PWA stores every immutable snapshot page before delta from baseline", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  const rows = Array.from({ length: 205 }, (_, index) => ({
    position: index + 1, kind: "conversation", conversationId: `v2-conv-${index}`,
    messageId: null, revision: 1, sortKey: 205 - index, tombstone: false, type: null,
    envelope: Buffer.from(`cipher-${index}`).toString("base64"), encoding: "envelope.v3",
    schemaVersion: 1, cryptoVersion: 3, lastServerSequence: index + 1,
  }));
  rows.push({ position: 206, kind: "message", conversationId: "v2-conv-0", messageId: "v2-message-0",
    type: "MESSAGE_CREATED", revision: 1, sortKey: 1, tombstone: false,
    envelope: Buffer.from("message-cipher").toString("base64"), encoding: "envelope.v3",
    schemaVersion: 1, cryptoVersion: 3, lastServerSequence: 205 });
  const page = start => ({ token: "snapshot-token", replicaGeneration: "v2-test-generation",
    snapshotVersion: 1, baselineSequence: 205, expiresAt: Date.now() + 60_000,
    contactEvents: [], rows: rows.slice(start, start + 100),
    nextCursor: start + 100 < rows.length ? Buffer.from(String(start + 100)).toString("base64url") : null,
    hasMore: start + 100 < rows.length });
  let snapshotPages = 0;
  let deltaAfter = null;
  global.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes("/linked-device/keyring") || path.includes("/linked-device/key-grants")) {
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (path.includes("/web/sync/ack")) return Response.json({ ok: true });
    if (path.includes("/web/snapshot-v2")) {
      snapshotPages += 1;
      if (options?.method === "POST") return Response.json(page(0));
      const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
      return Response.json(page(Number(Buffer.from(cursor, "base64url").toString("utf8"))));
    }
    if (path.includes("/sync?after=")) {
      deltaAfter = Number(new URL(path, "https://example.test").searchParams.get("after"));
      return Response.json(deltaAfter === 205
        ? { events: [{ sequence: 206, eventId: "late-status", aggregateId: null,
          sourceDeviceId: "phone", type: "DEVICE_STATUS_CHANGED", ciphertext: Buffer.from("opaque").toString("base64"),
          encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1, createdAt: 1 }],
          nextCursor: 206, hasMore: false, replicaGeneration: "v2-test-generation", snapshotVersion: 1 }
        : { events: [], nextCursor: deltaAfter, hasMore: false,
          replicaGeneration: "v2-test-generation", snapshotVersion: 1 });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const sync = await import("../web/src/lib/sync.ts");
    await sync.resetLocal();
    assert.equal(await sync.syncNow(), 1);
    assert.equal(snapshotPages, 3);
    assert.equal(deltaAfter, 205);
    assert.equal(await sync.getCursor(), 206);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("gmweb-messages");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise((resolve, reject) => {
      const request = db.transaction("encrypted_conversation_state", "readonly")
        .objectStore("encrypted_conversation_state").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    assert.equal(count, 205);
    assert.equal((await sync.listAggregateEventsPage("v2-conv-0")).items.length, 1);
    db.close();
  } finally {
    global.fetch = originalFetch;
  }
});

test("PWA resumes a partly committed snapshot without advancing the event cursor", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  let starts = 0;
  let continuations = 0;
  global.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes("/linked-device/keyring") || path.includes("/linked-device/key-grants")) {
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (path.includes("/web/snapshot-v2")) {
      const first = options?.method === "POST";
      if (first) starts += 1;
      else continuations += 1;
      const position = first ? 1 : 2;
      return Response.json({ token: "resume-token", replicaGeneration: "resume-generation", snapshotVersion: 1,
        baselineSequence: 2, expiresAt: Date.now() + 60_000, contactEvents: [],
        rows: [{ position, kind: "conversation", conversationId: `resume-${position}`, messageId: null,
          type: null, revision: 1, sortKey: 3 - position, tombstone: false,
          envelope: Buffer.from(`cipher-${position}`).toString("base64"), encoding: "envelope.v3",
          schemaVersion: 1, cryptoVersion: 3, lastServerSequence: position }],
        hasMore: first, nextCursor: first ? Buffer.from("1").toString("base64url") : null });
    }
    if (path.includes("/web/sync/ack")) return Response.json({ ok: true });
    if (path.includes("/sync?after=2")) return Response.json({ events: [], nextCursor: 2, hasMore: false,
      replicaGeneration: "resume-generation", snapshotVersion: 1 });
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const sync = await import("../web/src/lib/sync.ts");
    await sync.resetLocal();
    assert.equal(await sync.syncStep(1), 0);
    assert.equal(await sync.getCursor(), 0);
    assert.equal(await sync.syncNow(), 0);
    assert.equal(await sync.getCursor(), 2);
    assert.equal(starts, 1);
    assert.equal(continuations, 1);
    const local = await sync.listConversations();
    assert.deepEqual(local.items.map(row => row.aggregateId), ["resume-1", "resume-2"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("expired snapshot restarts cleanly without retaining partial rows", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  let starts = 0;
  global.fetch = async (url, options) => {
    const path = String(url);
    if (path.includes("/linked-device/keyring") || path.includes("/linked-device/key-grants")) {
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (path.includes("/web/snapshot-v2")) {
      if (options?.method !== "POST") return Response.json({ error: "snapshot_expired" }, { status: 409 });
      starts += 1;
      const old = starts === 1;
      return Response.json({ token: old ? "expired-token" : "fresh-token",
        replicaGeneration: "expiry-generation", snapshotVersion: 1,
        baselineSequence: old ? 1 : 2, expiresAt: Date.now() + 60_000, contactEvents: [],
        rows: [{ position: 1, kind: "conversation", conversationId: old ? "old-partial" : "new-complete",
          messageId: null, type: null, revision: 1, sortKey: 1, tombstone: false,
          envelope: Buffer.from("cipher").toString("base64"), encoding: "envelope.v3",
          schemaVersion: 1, cryptoVersion: 3, lastServerSequence: old ? 1 : 2 }],
        hasMore: old, nextCursor: old ? Buffer.from("1").toString("base64url") : null });
    }
    if (path.includes("/web/sync/ack")) return Response.json({ ok: true });
    if (path.includes("/sync?after=2")) return Response.json({ events: [], nextCursor: 2, hasMore: false,
      replicaGeneration: "expiry-generation", snapshotVersion: 1 });
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const sync = await import("../web/src/lib/sync.ts");
    await sync.resetLocal();
    assert.equal(await sync.syncStep(1), 0);
    assert.equal(await sync.getCursor(), 0);
    assert.equal(await sync.syncNow(), 0);
    assert.equal(starts, 2);
    assert.equal(await sync.getCursor(), 2);
    assert.deepEqual((await sync.listConversations()).items.map(row => row.aggregateId), ["new-complete"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("PWA commits encrypted snapshot before advancing to its baseline", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  global.fetch = async url => {
    const path = String(url);
    if (path.includes("/linked-session")) return Response.json({ authenticated: true, deviceId: "web" });
    if (path.includes("/linked-device/keyring") || path.includes("/linked-device/key-grants")) {
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (path.includes("/web/snapshot-v2")) return Response.json({
      token: "single-page-token", replicaGeneration: "test-replica-generation", snapshotVersion: 1,
      baselineSequence: 77, expiresAt: Date.now() + 60_000, hasMore: false, nextCursor: null, contactEvents: [],
      rows: [{ position: 1, kind: "conversation", conversationId: "opaque-c", messageId: null,
        type: null, revision: 1, sortKey: 10, tombstone: false,
        envelope: Buffer.from("opaque-cipher").toString("base64"), encoding: "envelope.v3",
        schemaVersion: 1, cryptoVersion: 3, lastServerSequence: 70 }],
    });
    if (path.includes("/web/sync/ack")) return Response.json({ ok: true });
    if (path.includes("/sync?after=77")) return Response.json({ events: [], nextCursor: 77, hasMore: false });
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const sync = await import("../web/src/lib/sync.ts");
    await sync.resetLocal();
    await sync.syncStep();
    assert.equal(await sync.getCursor(), 77);
    const page = await sync.listConversations();
    assert.equal(page.items[0].aggregateId, "opaque-c");
    assert.equal(page.items[0].decodeState, "locked");
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("gmweb-messages");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction("encrypted_conversation_state", "readonly")
        .objectStore("encrypted_conversation_state").get("opaque-c");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    assert.equal(stored.envelope.includes("opaque-cipher"), false);
    assert.equal(stored.envelope, Buffer.from("opaque-cipher").toString("base64"));
    db.close();
  } finally {
    global.fetch = originalFetch;
  }
});
