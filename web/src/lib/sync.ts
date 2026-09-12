/**
 * §41/§54 sync engine — the UI's source of truth is IndexedDB, updated
 * transactionally from /api/v1/sync pages. Realtime (SSE, Phase 4) only
 * invalidates ("sync.available"); correctness comes from the cursor.
 *
 * PR (web-01): stores raw opaque events keyed by per-account serverSequence.
 * Envelope decryption (Phase 7) plugs into applyEvent()'s single choke point
 * without touching storage or UI.
 */

import { acknowledgeWebSync, fetchEventsAfter, fetchKeyGrantsAfter, fetchKeyring, fetchWebBootstrap, fetchWebConversationPage, fetchWebMessagePage, SnapshotRequiredError,
  type EncryptedConversationState, type EncryptedMessageState, type SyncEvent, type SyncPage } from "./api.ts";
import { receiveKeyGrant, receiveKeyGrants, decryptMessage, type Decryption } from "./messageCrypto.ts";
import { decodeEventPayload, conversationProjectionFromEvents, type ConversationProjection } from "./inbox.ts";
import { getOrCreateDeviceKeys } from "./deviceKeys.ts";
import { assertSupportedContentEvent, isContentBearingEvent } from "./eventCryptoPolicy.ts";

const DB_NAME = "gmweb-messages";
const DB_VERSION = 7;
const STORE_EVENTS = "events";
const STORE_META = "meta";
const STORE_CONTACTS = "contacts";
const CURSOR_KEY = "sync_cursor";
/** Derived read-model store (PWA projection). Raw events stay the truth. */
const STORE_CONVERSATIONS = "conversations";
const STORE_ENCRYPTED_CONVERSATIONS = "encrypted_conversation_state";
const STORE_ENCRYPTED_MESSAGES = "encrypted_message_state";
const PROJECTION_VERSION_KEY = "conversation_projection_version";
export const PROJECTION_CURSOR_KEY = "conversation_projection_cursor";
const REPLICA_GENERATION_KEY = "replica_generation";
const SNAPSHOT_VERSION_KEY = "snapshot_version";
const REPLICA_MIGRATION_VERSION_KEY = "replica_migration_version";
const RECONSTRUCTABLE_STATE_EVENTS = new Set([
  "MESSAGE_CREATED", "MESSAGE_UPDATED", "MESSAGE_STATUS_CHANGED", "MESSAGE_DELETED",
  "CONVERSATION_UPSERT", "CONVERSATION_UPSERTED", "CONVERSATION_DELETED", "THREAD_READ",
]);
const KEY_GRANT_CURSOR_PREFIX = "key_grant_bootstrap_v2_cursor:";
const KEYRING_CURSOR_PREFIX = "account_keyring_v2_cursor:";
const volatileContacts = new Map<string, StoredContact>();

export type BrowserSyncState = "INITIALIZING" | "FIRST_PAINT_READY" | "SYNCING_HISTORY" |
  "UP_TO_DATE" | "DEGRADED" | "FAILED";
export interface BrowserSyncStatus {
  state: BrowserSyncState;
  lastSuccessfulSyncAt: number | null;
  lastPageCount: number;
  appliedThisRun: number;
  lastErrorPhase: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}
let syncStatus: BrowserSyncStatus = {
  state: "INITIALIZING",
  lastSuccessfulSyncAt: null,
  lastPageCount: 0,
  appliedThisRun: 0,
  lastErrorPhase: null,
  lastErrorCode: null,
  lastErrorMessage: null,
};
export function getBrowserSyncStatus(): BrowserSyncStatus { return { ...syncStatus }; }
function updateSyncStatus(change: Partial<BrowserSyncStatus>) { syncStatus = { ...syncStatus, ...change }; }
function syncFailure(phase: string, cause: unknown, fatal: boolean) {
  updateSyncStatus({
    state: fatal ? "FAILED" : "DEGRADED",
    lastErrorPhase: phase,
    lastErrorCode: cause instanceof DOMException ? cause.name : "SYNC_ERROR",
    lastErrorMessage: cause instanceof Error ? cause.message : String(cause),
  });
}

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
    try {
      await bootstrapKeyGrants();
      await bootstrapEncryptedState();
      await repairConversationProjection();
      const result = await drainSync(undefined, onProgress);
      updateSyncStatus({ state: "UP_TO_DATE", lastSuccessfulSyncAt: Date.now(), lastPageCount: result.lastPageCount, appliedThisRun: result.applied });
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
    try {
      await bootstrapKeyGrants();
      await bootstrapEncryptedState();
      await repairConversationProjection();
      const result = await drainSync(maxPages, onProgress);
      updateSyncStatus({
        state: result.caughtUp ? "UP_TO_DATE" : "FIRST_PAINT_READY",
        lastSuccessfulSyncAt: Date.now(), lastPageCount: result.lastPageCount, appliedThisRun: result.applied,
      });
      return result.applied;
    } catch (cause) {
      syncFailure("INITIAL_SYNC", cause, true);
      throw cause;
    }
  });
}

/** Catch-up synonym of syncNow() kept for call-site readability. */
export function syncUntilCaughtUp(onProgress?: (applied: number) => void): Promise<number> {
  return syncNow(onProgress);
}

interface DrainResult { applied: number; lastPageCount: number; caughtUp: boolean }
async function drainSync(maxPages?: number, onProgress?: (applied: number) => void): Promise<DrainResult> {
  let cursor = await getCursor();
  const db = await openDb();
  let replicaGeneration = await metaValue<string>(db, REPLICA_GENERATION_KEY);
  let snapshotVersion = await metaValue<number>(db, SNAPSHOT_VERSION_KEY);
  let applied = 0;
  let pages = 0;
  let lastPageCount = 0;
  const pendingAggregates = new Set<string>();
  let projectionThrough = cursor;
  const flushProjection = async () => {
    if (pendingAggregates.size > 0) {
      await refreshConversationProjections([...pendingAggregates]);
      pendingAggregates.clear();
    }
    await setMetaNumber(PROJECTION_CURSOR_KEY, projectionThrough);
  };
  for (;;) {
    let page: SyncPage;
    try {
      page = await fetchEventsAfter(cursor);
    } catch (cause) {
      if (!(cause instanceof SnapshotRequiredError)) throw cause;
      await bootstrapEncryptedState(true);
      cursor = await getCursor();
      projectionThrough = cursor;
      continue;
    }
    if (page.replicaGeneration && (page.replicaGeneration !== replicaGeneration ||
        page.snapshotVersion !== snapshotVersion)) {
      await bootstrapEncryptedState(true);
      cursor = await getCursor();
      projectionThrough = cursor;
      replicaGeneration = await metaValue<string>(db, REPLICA_GENERATION_KEY);
      snapshotVersion = await metaValue<number>(db, SNAPSHOT_VERSION_KEY);
      continue;
    }
    for (const event of page.events) assertSupportedContentEvent(event);
    lastPageCount = page.events.length;
    // Observability (Phase 2) — browser console trace of each sync page.
    try {
      let incoming = 0;
      let outgoing = 0;
      for (const ev of page.events) {
        const payload = decodeEventPayload(ev);
        if (payload?.direction === "in") incoming += 1;
        else if (payload?.direction === "out") outgoing += 1;
      }
      // eslint-disable-next-line no-console
      console.info(`sync_fetched cursor=${cursor} events=${page.events.length} incoming=${incoming} outgoing=${outgoing}`);
    } catch {
      /* best-effort diagnostics only */
    }
    if (page.events.length === 0) return { applied, lastPageCount, caughtUp: true };
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor ||
        page.events.some(ev => !Number.isSafeInteger(ev.sequence) || ev.sequence <= cursor || ev.sequence > page.nextCursor)) {
      throw new Error("Invalid sync page: non-advancing cursor or event sequence");
    }
    await receiveKeyGrants(page.events.filter(event =>
      (event.cryptoVersion === 1 && (event.type === "KEY_GRANT" || event.type === "CONTACTS_KEY_GRANT")) ||
      (event.cryptoVersion === 2 && event.type === "KEYRING_ENTRY") ||
      (event.cryptoVersion === 3 && event.type === "HISTORY_KEY_GRANT")));
    for (const event of page.events) {
      if ((event.cryptoVersion === 1 || event.cryptoVersion === 2) &&
          (event.type === "CONTACTS_SNAPSHOT" || event.type === "CONTACTS_CHANGED")) {
        const decoded = await decryptMessage(event);
        if (decoded.state === "decrypted") await applyContacts(decoded.payload);
      }
    }
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([STORE_EVENTS, STORE_META, STORE_ENCRYPTED_CONVERSATIONS, STORE_ENCRYPTED_MESSAGES], "readwrite");
      const store = t.objectStore(STORE_EVENTS);
      for (const ev of page.events) {
        store.put(ev); // keyed by server sequence — idempotent replay-safe
        if (["CONVERSATION_UPSERTED", "CONVERSATION_UPSERT", "CONVERSATION_DELETED"].includes(ev.type) && ev.aggregateId) {
          const states = t.objectStore(STORE_ENCRYPTED_CONVERSATIONS);
          const next = { conversationId: ev.aggregateId, tombstone: ev.type === "CONVERSATION_DELETED",
            revision: ev.revision ?? 1,
            sortKey: ev.sortKey ?? ev.createdAt, envelope: ev.ciphertext, encoding: ev.encoding,
            schemaVersion: ev.schemaVersion, cryptoVersion: ev.cryptoVersion,
            lastServerSequence: ev.sequence };
          const get = states.get(ev.aggregateId);
          get.onsuccess = () => {
            const old = get.result as EncryptedConversationState | undefined;
            if (!old || next.revision > old.revision ||
                (next.revision === old.revision && next.lastServerSequence > old.lastServerSequence)) states.put(next);
          };
        }
        if (ev.messageId && ev.aggregateId && ["MESSAGE_CREATED", "MESSAGE_UPDATED", "MESSAGE_STATUS_CHANGED", "MESSAGE_DELETED"].includes(ev.type)) {
          const states = t.objectStore(STORE_ENCRYPTED_MESSAGES);
          const next = { messageId: ev.messageId, conversationId: ev.aggregateId, type: ev.type,
            tombstone: ev.type === "MESSAGE_DELETED", revision: ev.revision ?? 1,
            sortKey: ev.sortKey ?? ev.createdAt, envelope: ev.ciphertext, encoding: ev.encoding,
            schemaVersion: ev.schemaVersion, cryptoVersion: ev.cryptoVersion,
            lastServerSequence: ev.sequence };
          const get = states.get(ev.messageId);
          get.onsuccess = () => {
            const old = get.result as EncryptedMessageState | undefined;
            if (!old || next.revision > old.revision ||
                (next.revision === old.revision && next.lastServerSequence > old.lastServerSequence)) states.put(next);
          };
        }
      }
      t.objectStore(STORE_META).put(page.nextCursor, CURSOR_KEY);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error("Sync transaction aborted"));
    });
    if (page.replicaGeneration && Number.isSafeInteger(page.snapshotVersion)) {
      await acknowledgeWebSync(page.nextCursor, page.replicaGeneration, page.snapshotVersion!);
    }
    await compactLocalContentEvents(db, page.nextCursor - 10_000);
    // PWA projection (P0): after the page commits, refresh ONLY the changed
    // conversations — never rebuild the whole inbox.
    const changedAggregates = [...new Set(page.events
      .map((ev) => ev.aggregateId)
      .filter((id): id is string => typeof id === "string" && id.length > 0))];
    for (const id of changedAggregates) pendingAggregates.add(id);
    projectionThrough = page.nextCursor;
    applied += page.events.length;
    cursor = page.nextCursor;
    onProgress?.(applied);
    pages += 1;
    const stopping = !page.hasMore || (maxPages !== undefined && pages >= maxPages);
    if (pages % 10 === 0 || stopping) await flushProjection();
    if (!page.hasMore) return { applied, lastPageCount, caughtUp: true };
    if (maxPages !== undefined && pages >= maxPages) return { applied, lastPageCount, caughtUp: false };
  }
}

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
  if (localPage.items.length >= limit ||
      (typeof navigator !== "undefined" && !navigator.onLine && localPage.items.length > 0)) {
    return localPage;
  }
  if (typeof navigator !== "undefined" && navigator.onLine) {
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

async function aggregateIdsInSequenceRange(db: IDBDatabase, after: number, through: number): Promise<string[]> {
  if (through <= after) return [];
  const ids = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_EVENTS, "readonly");
    const req = transaction.objectStore(STORE_EVENTS).openCursor(IDBKeyRange.bound(after, through, true, false));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const id = (cursor.value as SyncEvent).aggregateId;
      if (typeof id === "string" && id.length > 0) ids.add(id);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Projection repair scan aborted"));
  });
  return [...ids];
}

async function refreshConversationProjectionsInDb(db: IDBDatabase, aggregateIds: string[]): Promise<void> {
  const encryptedCount = await requestToPromise(db.transaction(STORE_ENCRYPTED_CONVERSATIONS, "readonly")
    .objectStore(STORE_ENCRYPTED_CONVERSATIONS).count());
  if (encryptedCount > 0) return;
  const contactMap = new Map((await contactsFromDb(db)).map(contact => [contact.normalizedPhone, contact.displayName]));
  for (const aggregateId of aggregateIds) {
    const rows = await requestToPromise(db.transaction(STORE_EVENTS, "readonly")
      .objectStore(STORE_EVENTS).index("by_aggregate").getAll(aggregateId)) as SyncEvent[];
    const row = conversationProjectionFromEvents(await decryptForDisplay(rows), aggregateId, contactMap);
    const transaction = db.transaction(STORE_CONVERSATIONS, "readwrite");
    if (row) transaction.objectStore(STORE_CONVERSATIONS).put(row);
    else transaction.objectStore(STORE_CONVERSATIONS).delete(aggregateId);
    await txDone(transaction);
  }
}

function conversationStateEvent(row: EncryptedConversationState): SyncEvent {
  return {
    sequence: row.lastServerSequence,
    eventId: `snapshot:${row.conversationId}:${row.revision}`,
    type: "CONVERSATION_UPSERTED",
    aggregateId: row.conversationId,
    sourceDeviceId: null,
    ciphertext: row.envelope,
    encoding: row.encoding,
    schemaVersion: row.schemaVersion,
    cryptoVersion: row.cryptoVersion,
    createdAt: row.sortKey,
    revision: row.revision,
    sortKey: row.sortKey,
  };
}

function messageStateEvent(row: EncryptedMessageState): SyncEvent {
  return {
    ...conversationStateEvent(row),
    eventId: `state:${row.messageId}:${row.revision}`,
    type: row.type,
    messageId: row.messageId,
  };
}

async function bootstrapEncryptedState(force = false): Promise<void> {
  const db = await openDb();
  const storedGeneration = await metaValue<string>(db, REPLICA_GENERATION_KEY);
  const storedSnapshotVersion = await metaValue<number>(db, SNAPSHOT_VERSION_KEY);
  if (!force && storedGeneration && Number.isSafeInteger(storedSnapshotVersion)) return;
  const page = await fetchWebBootstrap(101);
  if (page.protocolVersion !== 3 || !page.replicaGeneration ||
      !Number.isSafeInteger(page.snapshotVersion) ||
      !Number.isSafeInteger(page.minimumAvailableSequence) ||
      !Number.isSafeInteger(page.highWatermark)) {
    throw new Error("Unsupported encrypted bootstrap response");
  }
  const generationChanged = Boolean(storedGeneration && storedGeneration !== page.replicaGeneration);
  const transaction = db.transaction(
    [STORE_EVENTS, STORE_ENCRYPTED_CONVERSATIONS, STORE_ENCRYPTED_MESSAGES, STORE_CONVERSATIONS, STORE_META], "readwrite");
  const snapshots = transaction.objectStore(STORE_ENCRYPTED_CONVERSATIONS);
  snapshots.clear();
  transaction.objectStore(STORE_ENCRYPTED_MESSAGES).clear();
  transaction.objectStore(STORE_CONVERSATIONS).clear();
  if (generationChanged) {
    const oldEvents = transaction.objectStore(STORE_EVENTS).openCursor();
    oldEvents.onsuccess = () => {
      const cursor = oldEvents.result;
      if (!cursor) return;
      if (RECONSTRUCTABLE_STATE_EVENTS.has((cursor.value as SyncEvent).type) ||
          ["CONTACTS_SNAPSHOT", "CONTACTS_CHANGED"].includes((cursor.value as SyncEvent).type)) cursor.delete();
      cursor.continue();
    };
  }
  for (const event of page.contactEvents ?? []) transaction.objectStore(STORE_EVENTS).put(event);
  for (const row of page.conversations) snapshots.put(row);
  const meta = transaction.objectStore(STORE_META);
  meta.put(page.highWatermark, CURSOR_KEY);
  meta.put(page.highWatermark, PROJECTION_CURSOR_KEY);
  meta.put(page.replicaGeneration, REPLICA_GENERATION_KEY);
  meta.put(page.snapshotVersion, SNAPSHOT_VERSION_KEY);
  meta.put(7, REPLICA_MIGRATION_VERSION_KEY);
  await txDone(transaction);
  await repairContactsFromLocalEvents(db);
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
async function bootstrapKeyGrants(): Promise<void> {
  const db = await openDb();
  const deviceId = (await getOrCreateDeviceKeys()).deviceId;
  const keyring = await fetchKeyring();
  if (keyring.hasMore || keyring.events.some(event =>
    !((event.type === "KEYRING_ENTRY" && event.cryptoVersion === 2) ||
      (event.type === "HISTORY_KEY_GRANT" && event.cryptoVersion === 3)))) {
    throw new Error("Invalid or oversized account keyring");
  }
  const keyringCursorKey = `${KEYRING_CURSOR_PREFIX}${deviceId}`;
  const previousKeyringCursor = await metaNumber(db, keyringCursorKey);
  if (keyring.nextCursor > previousKeyringCursor) {
    const keyringResults = await receiveKeyGrants(keyring.events);
    const rejectedKey = keyringResults.find(result => result.state !== "key-grant" ||
      (result.reason !== "Authorized account key stored" &&
       result.reason !== "Authorized history key stored"));
    if (rejectedKey) throw new Error(`Account keyring failed: ${"reason" in rejectedKey ? rejectedKey.reason : "unexpected result"}`);

    const aggregateIds = (await requestToPromise(db.transaction(STORE_CONVERSATIONS, "readonly")
      .objectStore(STORE_CONVERSATIONS).getAllKeys())).filter((key): key is string => typeof key === "string");
    await refreshConversationProjectionsInDb(db, aggregateIds);
    await repairContactsFromLocalEvents(db);
    await setMetaNumber(keyringCursorKey, keyring.nextCursor);
  }

  const cursorKey = `${KEY_GRANT_CURSOR_PREFIX}${deviceId}`;
  let cursor = await metaNumber(db, cursorKey);
  const acceptedAggregates = new Set<string>();
  let contactsGrantAccepted = false;
  for (;;) {
    const page = await fetchKeyGrantsAfter(cursor);
    if (page.events.length === 0) break;
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor ||
        page.events.some(event => !Number.isSafeInteger(event.sequence) || event.sequence <= cursor ||
          event.sequence > page.nextCursor || (event.type !== "KEY_GRANT" && event.type !== "CONTACTS_KEY_GRANT"))) {
      throw new Error("Invalid key-grant bootstrap page");
    }
    const results = await receiveKeyGrants(page.events);
    const rejected = results.find(result => result.state !== "key-grant" ||
      result.reason !== "Authorized epoch key stored");
    if (rejected) throw new Error(`Key-grant bootstrap failed: ${"reason" in rejected ? rejected.reason : "unexpected result"}`);
    for (let index = 0; index < page.events.length; index += 1) {
      const event = page.events[index];
      const result = results[index];
      if (result.state !== "key-grant" || result.reason !== "Authorized epoch key stored") continue;
      if (event.type === "CONTACTS_KEY_GRANT") contactsGrantAccepted = true;
      else if (event.aggregateId) acceptedAggregates.add(event.aggregateId);
    }
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  if (acceptedAggregates.size > 0) {
    const projected = new Set((await requestToPromise(db.transaction(STORE_CONVERSATIONS, "readonly")
      .objectStore(STORE_CONVERSATIONS).getAllKeys())).filter((key): key is string => typeof key === "string"));
    await refreshConversationProjectionsInDb(db, [...acceptedAggregates].filter(id => projected.has(id)));
  }
  if (contactsGrantAccepted) await repairContactsFromLocalEvents(db);
  await setMetaNumber(cursorKey, cursor);
}

async function repairConversationProjectionGap(db: IDBDatabase): Promise<void> {
  const [cursor, projectionCursor] = await Promise.all([
    metaNumber(db, CURSOR_KEY), metaNumber(db, PROJECTION_CURSOR_KEY),
  ]);
  if (projectionCursor >= cursor) return;
  const ids = await aggregateIdsInSequenceRange(db, projectionCursor, cursor);
  await refreshConversationProjectionsInDb(db, ids);
  const transaction = db.transaction(STORE_META, "readwrite");
  transaction.objectStore(STORE_META).put(cursor, PROJECTION_CURSOR_KEY);
  await txDone(transaction);
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
    if (options.before && navigator.onLine) {
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
 * One-time migration rebuild: after the schema moves to v4, recompute the
 * whole projection from locally stored events. Raw events, the cursor and the
 * browser identity/crypto keys are never touched. Idempotent (meta marker).
 */
async function ensureConversationProjectionRebuilt(db: IDBDatabase): Promise<void> {
  const versionReq = db.transaction(STORE_META, "readonly")
    .objectStore(STORE_META).get(PROJECTION_VERSION_KEY) as IDBRequest<number | undefined>;
  const version = await requestToPromise(versionReq);
  if (version !== undefined) return;

  const keyReq = db.transaction(STORE_EVENTS, "readonly")
    .objectStore(STORE_EVENTS).index("by_aggregate").getAllKeys() as IDBRequest<IDBValidKey[]>;
  const keys = await requestToPromise(keyReq);
  const ids = [...new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))];

  const contactMap = new Map((await contactsFromDb(db)).map((contact) => [contact.normalizedPhone, contact.displayName]));

  for (let offset = 0; offset < ids.length; offset += 50) {
    for (const aggregateId of ids.slice(offset, offset + 50)) {
      const getReq = db.transaction(STORE_EVENTS, "readonly")
        .objectStore(STORE_EVENTS).index("by_aggregate").getAll(aggregateId) as IDBRequest<SyncEvent[]>;
      const events = await decryptForDisplay(await requestToPromise(getReq));
      const row = conversationProjectionFromEvents(events, aggregateId, contactMap);
      const transaction = db.transaction(STORE_CONVERSATIONS, "readwrite");
      const store = transaction.objectStore(STORE_CONVERSATIONS);
      if (row) store.put(row);
      else store.delete(aggregateId);
      await txDone(transaction);
    }
  }
  const rebuiltThrough = await metaNumber(db, CURSOR_KEY);
  const metaTx = db.transaction(STORE_META, "readwrite");
  metaTx.objectStore(STORE_META).put(1, PROJECTION_VERSION_KEY);
  metaTx.objectStore(STORE_META).put(rebuiltThrough, PROJECTION_CURSOR_KEY);
  await txDone(metaTx);
}


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
  let closed = false;
  let es: EventSource | null = null;
  let connecting: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    // EventSource sends cookies for same-origin automatically; withCredentials
    // additionally keeps the linked-session cookie on cross-origin/proxied setups.
    es = new EventSource("/api/v1/sse", { withCredentials: true });
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as { type?: string; newEvents?: number };
        if (evt.type === "device.revoked") {
          closed = true;
          es?.close();
          onRevoked();
          return;
        }
        if (evt.type === "sync.available") {
          void syncNow()
            .then((applied) => {
              if (applied > 0) onSynced(applied);
            })
            .catch((cause) => {
              syncFailure("SSE_SYNC", cause, false);
              onSyncError?.(cause);
            });
        }
      } catch {
        /* ignore malformed frames — the cursor is the truth */
      }
    };
    // EventSource retries on its own; we only rebuild after a hard close.
    es.onerror = () => {
      void fetch("/api/v1/linked-session", { credentials: "include" })
        .then(r => r.json()).then(s => { if (s.authenticated === false) { closed = true; onRevoked(); } }).catch(() => {});
      es?.close();
      es = null;
      if (!closed && connecting === null) {
        connecting = setTimeout(() => {
          connecting = null;
          connect();
        }, 5_000);
      }
    };
  };

  connect();
  return () => {
    closed = true;
    if (connecting !== null) clearTimeout(connecting);
    es?.close();
  };
}
