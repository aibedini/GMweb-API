/**
 * §41/§54 sync engine — the UI's source of truth is IndexedDB, updated
 * transactionally from /api/v1/sync pages. Realtime (SSE, Phase 4) only
 * invalidates ("sync.available"); correctness comes from the cursor.
 *
 * PR (web-01): stores raw opaque events keyed by per-account serverSequence.
 * Envelope decryption (Phase 7) plugs into applyEvent()'s single choke point
 * without touching storage or UI.
 */

import { fetchWebConversationPage, fetchWebMessagePage,
  type EncryptedConversationState, type EncryptedMessageState, type SyncEvent } from "./api.ts";
import { receiveKeyGrant, decryptMessage, type Decryption } from "./messageCrypto.ts";
import { decodeEventPayload, type ConversationProjection } from "./inbox.ts";
import { getOrCreateDeviceKeys } from "./deviceKeys.ts";
import { assertSupportedContentEvent, isContentBearingEvent } from "./eventCryptoPolicy.ts";
import { syncFailure, updateSyncStatus } from "./sync/sync-state.ts";
import { grantCursorKey, keyringCursorKey, runKeySync, syncKeysSafely } from "./sync/key-sync.ts";
import { runSnapshotBootstrap } from "./sync/snapshot-sync.ts";
import { createReplicaEngine } from "./sync/replica-sync.ts";
import { subscribeSyncAvailable as subscribeLiveInvalidation } from "./sync/live-invalidation.ts";
import { createProjectionEngine, conversationStateEvent, messageStateEvent } from "./sync/projection-engine.ts";
export { getBrowserSyncStatus } from "./sync/sync-state.ts";
export type { BrowserSyncState, BrowserSyncStatus } from "./sync/sync-state.ts";

import { DB_NAME, DB_VERSION, STORE_EVENTS, STORE_META, STORE_CONTACTS, CURSOR_KEY, STORE_CONVERSATIONS, STORE_ENCRYPTED_CONVERSATIONS, STORE_ENCRYPTED_MESSAGES, PROJECTION_CURSOR_KEY, SNAPSHOT_TOKEN_KEY, SNAPSHOT_BASELINE_KEY, SNAPSHOT_COMPLETE_KEY, REPLICA_MIGRATION_VERSION_KEY, RECONSTRUCTABLE_STATE_EVENTS } from "./sync/schema.ts";
export { PROJECTION_CURSOR_KEY } from "./sync/schema.ts";
const { refreshConversationProjectionsInDb, repairConversationProjectionGap, ensureConversationProjectionRebuilt } = createProjectionEngine({
  requestToPromise, txDone, metaNumber, contactsFromDb, decryptForDisplay,
});
const volatileContacts = new Map<string, StoredContact>();

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const versionEvent = event as IDBVersionChangeEvent;
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const store = db.createObjectStore(STORE_EVENTS, { keyPath: "sequence" });
        store.createIndex("by_aggregate", "aggregateId");
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      if (!db.objectStoreNames.contains(STORE_CONTACTS)) {
        db.createObjectStore(STORE_CONTACTS, { keyPath: "normalizedPhone" });
      } else if (versionEvent.oldVersion < 6) {
        // v5 persisted decrypted contact/address data. v6 keeps contacts only
        // in memory and reconstructs them from encrypted raw events.
        req.transaction!.objectStore(STORE_CONTACTS).clear();
      }
      // PWA projection store (v4): derived per-conversation read model.
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        const conversations = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: "aggregateId" });
        conversations.createIndex("by_last_at", ["lastAt", "aggregateId"]);
      }
      if (!db.objectStoreNames.contains(STORE_ENCRYPTED_CONVERSATIONS)) {
        const snapshots = db.createObjectStore(STORE_ENCRYPTED_CONVERSATIONS, { keyPath: "conversationId" });
        snapshots.createIndex("by_sort", ["sortKey", "conversationId"]);
      }
      if (!db.objectStoreNames.contains(STORE_ENCRYPTED_MESSAGES)) {
        const messages = db.createObjectStore(STORE_ENCRYPTED_MESSAGES, { keyPath: "messageId" });
        messages.createIndex("by_conversation_sort", ["conversationId", "sortKey", "messageId"]);
      }

      const events = req.transaction!.objectStore(STORE_EVENTS);
      if (!events.indexNames.contains("by_type_sequence")) events.createIndex("by_type_sequence", ["type", "sequence"]);
      if (!events.indexNames.contains("by_aggregate_sequence")) events.createIndex("by_aggregate_sequence", ["aggregateId", "sequence"]);
      if (versionEvent.oldVersion < 7) {
        // v7 is a security boundary: decrypted projections are never carried
        // across the upgrade and cached data-plane deltas are replayed only
        // from the encrypted server replica. Browser identity stores are not touched.
        req.transaction!.objectStore(STORE_CONVERSATIONS).clear();
        req.transaction!.objectStore(STORE_CONTACTS).clear();
        const cursor = events.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const event = row.value as SyncEvent;
          if (isContentBearingEvent(event.type) && event.cryptoVersion === 0) row.delete();
          row.continue();
        };
        const meta = req.transaction!.objectStore(STORE_META);
        meta.put(0, CURSOR_KEY);
        meta.put(0, PROJECTION_CURSOR_KEY);
        meta.put(7, REPLICA_MIGRATION_VERSION_KEY);
      }
    };
    req.onsuccess = async () => {
      const db = req.result;
      try {
        await ensureConversationProjectionRebuilt(db);
      } catch (e) {
        db.close();
        dbPromise = null;
        reject(e);
        return;
      }
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const req = fn(t);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function getCursor(): Promise<number> {
  const v = await tx([STORE_META], "readonly", (t) =>
    t.objectStore(STORE_META).get(CURSOR_KEY) as IDBRequest<number | undefined>,
  );
  return v ?? 0;
}

export async function getProjectionCursor(): Promise<number> {
  const v = await tx([STORE_META], "readonly", (t) =>
    t.objectStore(STORE_META).get(PROJECTION_CURSOR_KEY) as IDBRequest<number | undefined>,
  );
  return v ?? 0;
}

/** Independent durable positions; neither key cursor advances the event cursor. */
export async function getReplicationProgress(deviceId: string): Promise<{
  snapshotComplete: boolean; snapshotBaseline: number; keyringCursor: number; grantCursor: number;
}> {
  const db = await openDb();
  const [snapshotComplete, snapshotBaseline, keyringCursor, grantCursor] = await Promise.all([
    metaValue<boolean>(db, SNAPSHOT_COMPLETE_KEY),
    metaNumber(db, SNAPSHOT_BASELINE_KEY),
    metaNumber(db, keyringCursorKey(deviceId)),
    metaNumber(db, grantCursorKey(deviceId)),
  ]);
  return { snapshotComplete: snapshotComplete === true, snapshotBaseline, keyringCursor, grantCursor };
}

/** §43: apply pages transactionally until the server says hasMore=false. */
let runningSync: Promise<number> | null = null;
function serializeSync(run: () => Promise<number>): Promise<number> {
  // Serialize manual pulls and SSE invalidations: an older request must never
  // overwrite a newer cursor after it completes out of order.
  if (!runningSync) runningSync = run().finally(() => { runningSync = null; });
  return runningSync;
}

export function syncNow(onProgress?: (applied: number) => void): Promise<number> {
  updateSyncStatus({ state: "SYNCING_HISTORY", appliedThisRun: 0, lastErrorPhase: null, lastErrorCode: null, lastErrorMessage: null });
  return serializeSync(async () => {
    let keySyncDegraded = false;
    try {
      // Key availability is deliberately independent from replica durability.
      // A missing/unavailable key must leave ciphertext replication healthy so
      // the browser can catch up and retry projection after the grant arrives.
      keySyncDegraded = !(await syncKeysSafely(bootstrapKeyGrants));
      await bootstrapEncryptedState();
      await repairConversationProjection();
      const result = await drainSync(undefined, onProgress);
      updateSyncStatus({ state: keySyncDegraded || result.keyDegraded ? "DEGRADED" : "UP_TO_DATE", lastSuccessfulSyncAt: Date.now(), lastPageCount: result.lastPageCount, appliedThisRun: result.applied });
      return result.applied;
    } catch (cause) {
      syncFailure("SYNC", cause, false);
      throw cause;
    }
  });
}

/**
 * Progressive browser bootstrap: fetch/commit a bounded number of pages (default
 * 2) so the first Inbox paint never waits for the whole archive, then continue
 * catching up in the background via syncUntilCaughtUp() / SSE invalidations.
 */
export function syncStep(maxPages = 2, onProgress?: (applied: number) => void): Promise<number> {
  updateSyncStatus({ state: "INITIALIZING", appliedThisRun: 0, lastErrorPhase: null, lastErrorCode: null, lastErrorMessage: null });
  return serializeSync(async () => {
    let keySyncDegraded = false;
    try {
      keySyncDegraded = !(await syncKeysSafely(bootstrapKeyGrants));
      const snapshotComplete = await bootstrapEncryptedState(false, maxPages);
      if (!snapshotComplete) {
        updateSyncStatus({ state: keySyncDegraded ? "DEGRADED" : "FIRST_PAINT_READY", lastPageCount: 0, appliedThisRun: 0 });
        return 0;
      }
      await repairConversationProjection();
      const result = await drainSync(maxPages, onProgress);
      updateSyncStatus({
        state: keySyncDegraded || result.keyDegraded ? "DEGRADED" : (result.caughtUp ? "UP_TO_DATE" : "FIRST_PAINT_READY"),
        lastSuccessfulSyncAt: Date.now(), lastPageCount: result.lastPageCount, appliedThisRun: result.applied,
      });
      return result.applied;
    } catch (cause) {
      syncFailure("INITIAL_SYNC", cause, true);
      throw cause;
    }
  });
}

/**
 * Run key/bootstrap synchronization without making it a prerequisite for the
 * encrypted replica. The return value is intentionally boolean so callers can
 * surface a degraded key state while continuing event ingestion.
 */

/** Catch-up synonym of syncNow() kept for call-site readability. */
export function syncUntilCaughtUp(onProgress?: (applied: number) => void): Promise<number> {
  return syncNow(onProgress);
}

const { drainSync } = createReplicaEngine({ getCursor, openDb, metaValue, setMetaNumber,
  bootstrapEncryptedState, refreshConversationProjections, applyContacts, compactLocalContentEvents });

export interface StoredEvent extends SyncEvent { decryption?: Decryption }

async function decryptForDisplay(events: SyncEvent[]): Promise<StoredEvent[]> {
  const result: StoredEvent[] = [];
  for (const event of events) {
    if (isContentBearingEvent(event.type)) {
      try {
        assertSupportedContentEvent(event);
      } catch {
        result.push({ ...event, decryption: { state: "invalid", reason: "Unsupported encrypted content event" } });
        continue;
      }
    }
    if (event.cryptoVersion > 0) result.push({ ...event, decryption: (event.type === "KEY_GRANT" || event.type === "CONTACTS_KEY_GRANT" || event.type === "KEYRING_ENTRY" || event.type === "HISTORY_KEY_GRANT")
      ? await receiveKeyGrant(event) : await decryptMessage(event) });
    else result.push({ ...event, decryption: { state: "invalid", reason: "Unsupported plaintext event" } });
  }
  return result;
}

/** Load one selected thread through its index, including history outside the recent window. */
export async function listAggregateEvents(aggregateId: string): Promise<StoredEvent[]> {
  const events = await tx([STORE_EVENTS], "readonly", t => t.objectStore(STORE_EVENTS)
    .index("by_aggregate").getAll(aggregateId)) as SyncEvent[];
  return decryptForDisplay(events);
}

export interface AggregatePage {
  /** Newest-first page of one thread (older history via next). */
  items: StoredEvent[];
  hasMore: boolean;
  /** Oldest server sequence in this page — cursor for "load older". */
  next?: number | string;
}

function decodeStateCursor(value?: string): [number, string] | null {
  if (!value) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(base64));
    return Array.isArray(parsed) && Number.isSafeInteger(parsed[0]) && typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]] : null;
  } catch { return null; }
}

function encodeStateCursor(sortKey: number, messageId: string): string {
  return btoa(JSON.stringify([sortKey, messageId])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function cachedMessagePage(db: IDBDatabase, aggregateId: string, before: string | undefined, limit: number): Promise<AggregatePage> {
  const decoded = decodeStateCursor(before);
  const upper: [string, number, string] = decoded
    ? [aggregateId, decoded[0], decoded[1]]
    : [aggregateId, Number.MAX_SAFE_INTEGER, "\uffff"];
  const range = IDBKeyRange.bound([aggregateId, Number.MIN_SAFE_INTEGER, ""], upper, false, Boolean(decoded));
  const rows: EncryptedMessageState[] = [];
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_ENCRYPTED_MESSAGES, "readonly");
    const request = transaction.objectStore(STORE_ENCRYPTED_MESSAGES)
      .index("by_conversation_sort").openCursor(range, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit + 1) return;
      rows.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await decryptForDisplay(page.map(messageStateEvent)),
    hasMore,
    next: hasMore && last ? encodeStateCursor(last.sortKey, last.messageId) : undefined,
  };
}

/**
 * P1: paged thread reads via the [aggregateId, sequence] index instead of a
 * getAll() of the whole conversation. Newest ~200 first; pass
 * { beforeSequence } (the previous page's `next`) to walk further back.
 */
export async function listAggregateEventsPage(
  aggregateId: string,
  options: { limit?: number; beforeSequence?: number; beforeState?: string } = {},
): Promise<AggregatePage> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 200));
  const db = await openDb();
  const localPage = await cachedMessagePage(db, aggregateId, options.beforeState, limit);
  const hasV2Snapshot = Boolean(await metaValue<string>(db, SNAPSHOT_TOKEN_KEY));
  if (hasV2Snapshot && localPage.items.length > 0) return localPage;
  if (localPage.items.length >= limit ||
      (typeof navigator !== "undefined" && !navigator.onLine && localPage.items.length > 0)) {
    return localPage;
  }
  if (!hasV2Snapshot && typeof navigator !== "undefined" && navigator.onLine) {
    const remote = await fetchWebMessagePage(aggregateId, options.beforeState, Math.min(100, limit));
    const write = db.transaction(STORE_ENCRYPTED_MESSAGES, "readwrite");
    const states = write.objectStore(STORE_ENCRYPTED_MESSAGES);
    for (const row of remote.messages) states.put(row);
    await txDone(write);
    return {
      items: await decryptForDisplay(remote.messages.map(messageStateEvent)),
      hasMore: remote.hasMore,
      next: remote.nextCursor ?? undefined,
    };
  }
  const cached: EncryptedMessageState[] = [];
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_ENCRYPTED_MESSAGES, "readonly");
    const index = transaction.objectStore(STORE_ENCRYPTED_MESSAGES).index("by_conversation_sort");
    const request = index.openCursor(
      IDBKeyRange.bound([aggregateId, -Infinity, ""], [aggregateId, Infinity, "\uffff"]), "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || cached.length >= Math.min(100, limit)) return;
      cached.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  if (cached.length > 0) return { items: await decryptForDisplay(cached.map(messageStateEvent)), hasMore: false };
  const range = options.beforeSequence === undefined
    ? IDBKeyRange.bound([aggregateId, -Infinity], [aggregateId, Infinity])
    : IDBKeyRange.upperBound([aggregateId, options.beforeSequence], true);
  const rows: SyncEvent[] = [];
  let hasMore = false;
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_EVENTS, "readonly");
    const index = t.objectStore(STORE_EVENTS).index("by_aggregate_sequence");
    const req = index.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (rows.length < limit) {
        rows.push(cursor.value as SyncEvent);
        cursor.continue();
      } else {
        hasMore = true;
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("Aggregate paging aborted"));
    req.onerror = () => reject(req.error);
  });
  const oldest = rows[rows.length - 1];
  return {
    items: await decryptForDisplay(rows),
    hasMore,
    next: hasMore && oldest ? oldest.sequence : undefined,
  };
}


/** Select message-bearing threads without KEY_GRANT/status traffic displacing the Inbox. */
export async function listInboxEvents(limit = 100): Promise<StoredEvent[]> {
  const db = await openDb();
  const candidates: SyncEvent[] = [];
  for (const type of ["MESSAGE_CREATED", "MESSAGE_UPDATED"]) {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_EVENTS, "readonly");
      const range = IDBKeyRange.bound([type, 0], [type, Number.MAX_SAFE_INTEGER]);
      const req = t.objectStore(STORE_EVENTS).index("by_type_sequence").openCursor(range, "prev");
      let count = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        candidates.push(cursor.value);
        if (++count < limit) cursor.continue();
      };
      t.oncomplete = () => resolve();
      t.onabort = () => reject(t.error);
      req.onerror = () => reject(req.error);
    });
  }
  const ids = new Set(candidates.map(row => row.aggregateId).filter((id): id is string => !!id));
  const rows: StoredEvent[] = [];
  for (const id of ids) rows.push(...await listAggregateEvents(id));
  return rows;
}

export async function listRecentEvents(limit = 100): Promise<StoredEvent[]> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid event limit");
  if (limit === 0) return [];
  const db = await openDb();
  const events = await new Promise<StoredEvent[]>((resolve, reject) => {
    const t = db.transaction([STORE_EVENTS], "readonly");
    const rows: StoredEvent[] = [];
    const req = t.objectStore(STORE_EVENTS).openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || rows.length === limit) return;
      rows.push(cursor.value as StoredEvent);
      if (rows.length < limit) cursor.continue();
    };
    t.oncomplete = () => resolve(rows);
    t.onabort = () => reject(t.error ?? new Error("Event read aborted"));
    req.onerror = () => reject(req.error);
  });
  return decryptForDisplay(events);
}

export interface StoredContact {
  normalizedPhone: string;
  displayName: string;
  starred: boolean;
  photoThumbBase64?: string | null;
  lastUpdateMs: number;
}

async function applyContacts(payload: Record<string, unknown>): Promise<void> {
  const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
  const deleted = Array.isArray(payload.deleted) ? payload.deleted : [];
  if (payload.replaceAll === true && Number(payload.chunkIndex) === 0) volatileContacts.clear();
  for (const value of contacts) {
    if (!value || typeof value !== "object") continue;
    const row = value as Partial<StoredContact>;
    if (typeof row.normalizedPhone === "string" && typeof row.displayName === "string") {
      volatileContacts.set(row.normalizedPhone, row as StoredContact);
    }
  }
  for (const phone of deleted) if (typeof phone === "string") volatileContacts.delete(phone);
}

// ── PWA conversation projection (read-model, derived from raw events) ──────

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Transaction aborted"));
  });
}

function metaNumber(db: IDBDatabase, key: string): Promise<number> {
  return requestToPromise(db.transaction(STORE_META, "readonly").objectStore(STORE_META).get(key))
    .then(value => typeof value === "number" && Number.isSafeInteger(value) ? value : 0);
}

async function compactLocalContentEvents(db: IDBDatabase, throughSequence: number): Promise<void> {
  if (throughSequence <= 0) return;
  const transaction = db.transaction(STORE_EVENTS, "readwrite");
  const request = transaction.objectStore(STORE_EVENTS).openCursor(IDBKeyRange.upperBound(throughSequence));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (RECONSTRUCTABLE_STATE_EVENTS.has((cursor.value as SyncEvent).type)) cursor.delete();
    cursor.continue();
  };
  await txDone(transaction);
}

function metaValue<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return requestToPromise(db.transaction(STORE_META, "readonly").objectStore(STORE_META).get(key))
    .then(value => value as T | undefined);
}

async function setMetaNumber(key: string, value: number): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(STORE_META, "readwrite");
  transaction.objectStore(STORE_META).put(value, key);
  await txDone(transaction);
}

async function contactsFromDb(db: IDBDatabase): Promise<StoredContact[]> {
  void db;
  return [...volatileContacts.values()];
}






function bootstrapEncryptedState(force = false, maxPages = Infinity): Promise<boolean> {
  return runSnapshotBootstrap({ openDb, metaValue, txDone, repairContactsFromLocalEvents }, force, maxPages);
}

async function eventsByType(db: IDBDatabase, type: string): Promise<SyncEvent[]> {
  const range = IDBKeyRange.bound([type, 0], [type, Number.MAX_SAFE_INTEGER]);
  return await requestToPromise(db.transaction(STORE_EVENTS, "readonly")
    .objectStore(STORE_EVENTS).index("by_type_sequence").getAll(range)) as SyncEvent[];
}

async function repairContactsFromLocalEvents(db: IDBDatabase): Promise<void> {
  const rows = [
    ...await eventsByType(db, "CONTACTS_SNAPSHOT"),
    ...await eventsByType(db, "CONTACTS_CHANGED"),
  ].sort((left, right) => left.sequence - right.sequence);
  for (const event of rows) {
    const payload = event.cryptoVersion > 0
      ? await decryptMessage(event).then(result => result.state === "decrypted" ? result.payload : null)
      : decodeEventPayload(event);
    if (payload) await applyContacts(payload);
  }
}

/**
 * A newly linked browser can sit behind several historical device backfills.
 * Pull only the already-authorized opaque grant events first, install grants
 * addressed to this browser, then retry local projections. The normal sync
 * cursor remains the sole raw-event cursor and is never advanced here.
 */
async function bootstrapKeyGrants(signal: AbortSignal): Promise<void> {
  const db = await openDb();
  const deviceId = (await getOrCreateDeviceKeys()).deviceId;
  await runKeySync(signal, db, deviceId, { conversationStore: STORE_CONVERSATIONS,
    metaNumber, setMetaNumber, requestToPromise, refreshConversationProjectionsInDb,
    repairContactsFromLocalEvents });
}


export async function repairConversationProjection(): Promise<void> {
  await repairConversationProjectionGap(await openDb());
}

/**
 * Recompute the derived row for exactly the given aggregates. Called after
 * every sync-page commit (only the changed aggregates) and once during the
 * one-time schema migration. Idempotent.
 */
export async function refreshConversationProjections(aggregateIds: string[]): Promise<void> {
  const unique = [...new Set(aggregateIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return;
  await refreshConversationProjectionsInDb(await openDb(), unique);
}

export interface ConversationPage {
  items: ConversationProjection[];
  hasMore: boolean;
  /** Cursor for the next page ("load older"). */
  next?: { lastAt: number; aggregateId: string };
}

/**
 * Paginated conversation read from the projection store. Replaces the old
 * `listInboxEvents(limit=100)` candidate scan, so 1000+ conversations stay
 * reachable instead of older ones silently disappearing from the Inbox.
 */
export async function listConversations(
  options: { limit?: number; before?: { lastAt: number; aggregateId: string } } = {},
): Promise<ConversationPage> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const db = await openDb();
  const encryptedCount = await requestToPromise(
    db.transaction(STORE_ENCRYPTED_CONVERSATIONS, "readonly")
      .objectStore(STORE_ENCRYPTED_CONVERSATIONS).count());
  if (encryptedCount > 0) {
    if (options.before && navigator.onLine && !(await metaValue<string>(db, SNAPSHOT_TOKEN_KEY))) {
      const raw = btoa(JSON.stringify([options.before.lastAt, options.before.aggregateId]))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      const remote = await fetchWebConversationPage(raw, Math.min(200, limit + 1));
      const write = db.transaction(STORE_ENCRYPTED_CONVERSATIONS, "readwrite");
      for (const row of remote.conversations) write.objectStore(STORE_ENCRYPTED_CONVERSATIONS).put(row);
      await txDone(write);
    }
    const encrypted: EncryptedConversationState[] = [];
    let hasMore = false;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_ENCRYPTED_CONVERSATIONS, "readonly");
      const index = transaction.objectStore(STORE_ENCRYPTED_CONVERSATIONS).index("by_sort");
      const range = options.before
        ? IDBKeyRange.upperBound([options.before.lastAt, options.before.aggregateId], true)
        : null;
      const request = index.openCursor(range, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (encrypted.length < limit) { encrypted.push(cursor.value); cursor.continue(); }
        else hasMore = true;
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const items: ConversationProjection[] = [];
    for (const row of encrypted) {
      if (row.tombstone) continue;
      const event = conversationStateEvent(row);
      const decrypted = await decryptMessage(event);
      if (decrypted.state !== "decrypted") {
        items.push({ aggregateId: row.conversationId, title: "Encrypted message",
          preview: "Locked — waiting for the history key", lastAt: row.sortKey,
          read: true, unreadCount: 0, lastMessageId: row.conversationId,
          lastSequence: row.lastServerSequence, decodeState: "locked" });
        continue;
      }
      const value = decrypted.payload;
      const address = typeof value.address === "string" ? value.address : "";
      const displayName = typeof value.displayName === "string" ? value.displayName : address;
      items.push({
        aggregateId: row.conversationId,
        title: displayName || "Unknown conversation",
        ...(displayName && address && displayName !== address ? { subtitle: address } : {}),
        preview: typeof value.lastMessagePreview === "string" ? value.lastMessagePreview : "",
        lastAt: Number(value.lastMessageAt) || row.sortKey,
        read: Number(value.unreadCount) === 0,
        unreadCount: Math.max(0, Number(value.unreadCount) || 0),
        lastMessageId: row.conversationId,
        lastSequence: row.lastServerSequence,
        decodeState: "ready",
      });
    }
    const last = items.at(-1);
    return { items, hasMore, next: hasMore && last
      ? { lastAt: last.lastAt, aggregateId: last.aggregateId } : undefined };
  }
  const items: ConversationProjection[] = [];
  let hasMore = false;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_CONVERSATIONS, "readonly");
    const index = transaction.objectStore(STORE_CONVERSATIONS).index("by_last_at");
    const range = options.before
      ? IDBKeyRange.upperBound([options.before.lastAt, options.before.aggregateId], true)
      : null;
    const req = index.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (items.length < limit) {
        items.push(cursor.value as ConversationProjection);
        cursor.continue();
      } else {
        hasMore = true;
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Conversation list aborted"));
    req.onerror = () => reject(req.error);
  });
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    next: hasMore && last ? { lastAt: last.lastAt, aggregateId: last.aggregateId } : undefined,
  };
}

/**
 * List transient contacts reconstructed from encrypted local events.
 */


export async function listContacts(): Promise<StoredContact[]> {
  const rows = [...volatileContacts.values()];
  return rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Dev/self-check hook used by the Debug screen. */
export async function resetLocal(): Promise<void> {
  await runningSync?.catch(() => {});
  volatileContacts.clear();
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_EVENTS, STORE_META, STORE_CONTACTS, STORE_CONVERSATIONS,
      STORE_ENCRYPTED_CONVERSATIONS, STORE_ENCRYPTED_MESSAGES], "readwrite");
    t.objectStore(STORE_EVENTS).clear();
    t.objectStore(STORE_META).clear();
    t.objectStore(STORE_CONTACTS).clear();
    t.objectStore(STORE_CONVERSATIONS).clear();
    t.objectStore(STORE_ENCRYPTED_CONVERSATIONS).clear();
    t.objectStore(STORE_ENCRYPTED_MESSAGES).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/**
 * §44: subscribe to the control plane's NARROW invalidation signal.
 * The stream never carries message content — on every {type:"sync.available"}
 * we re-run syncNow() with the durable cursor. The browser's EventSource
 * auto-reconnects; backoff is its job, correctness is ours.
 *
 * Returns a disposer (for React effects / StrictMode double-mount).
 */
export function subscribeSyncAvailable(
  onSynced: (applied: number) => void,
  onRevoked: () => void,
  onSyncError?: (cause: unknown) => void,
): () => void {
  return subscribeLiveInvalidation(syncNow, onSynced, onRevoked, onSyncError);
}
