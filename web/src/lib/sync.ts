/**
 * §41/§54 sync engine — the UI's source of truth is IndexedDB, updated
 * transactionally from /api/v1/sync pages. Realtime (SSE, Phase 4) only
 * invalidates ("sync.available"); correctness comes from the cursor.
 *
 * PR (web-01): stores raw opaque events keyed by per-account serverSequence.
 * Envelope decryption (Phase 7) plugs into applyEvent()'s single choke point
 * without touching storage or UI.
 */

import { fetchEventsAfter, type SyncEvent } from "./api.ts";
import { receiveKeyGrant, decryptMessage, type Decryption } from "./messageCrypto.ts";

const DB_NAME = "gmweb-messages";
const DB_VERSION = 2;
const STORE_EVENTS = "events";
const STORE_META = "meta";
const CURSOR_KEY = "sync_cursor";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const store = db.createObjectStore(STORE_EVENTS, { keyPath: "sequence" });
        store.createIndex("by_aggregate", "aggregateId");
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      const events = req.transaction!.objectStore(STORE_EVENTS);
      if (!events.indexNames.contains("by_type_sequence")) events.createIndex("by_type_sequence", ["type", "sequence"]);
    };
    req.onsuccess = () => resolve(req.result);
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

/** §43: apply pages transactionally until the server says hasMore=false. */
let runningSync: Promise<number> | null = null;
export function syncNow(onProgress?: (applied: number) => void): Promise<number> {
  // Serialize manual pulls and SSE invalidations: an older request must never
  // overwrite a newer cursor after it completes out of order.
  if (!runningSync) runningSync = drainSync(onProgress).finally(() => { runningSync = null; });
  return runningSync;
}

async function drainSync(onProgress?: (applied: number) => void): Promise<number> {
  let cursor = await getCursor();
  let applied = 0;
  for (;;) {
    const page = await fetchEventsAfter(cursor);
    if (page.events.length === 0) break;
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor ||
        page.events.some(ev => !Number.isSafeInteger(ev.sequence) || ev.sequence <= cursor || ev.sequence > page.nextCursor)) {
      throw new Error("Invalid sync page: non-advancing cursor or event sequence");
    }
    for (const event of page.events) {
      if (event.cryptoVersion === 1 && event.type === "KEY_GRANT") await receiveKeyGrant(event);
    }
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([STORE_EVENTS, STORE_META], "readwrite");
      const store = t.objectStore(STORE_EVENTS);
      for (const ev of page.events) {
        store.put(ev); // keyed by server sequence — idempotent replay-safe
      }
      t.objectStore(STORE_META).put(page.nextCursor, CURSOR_KEY);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error("Sync transaction aborted"));
    });
    applied += page.events.length;
    cursor = page.nextCursor;
    onProgress?.(applied);
    if (!page.hasMore) break;
  }
  return applied;
}

export interface StoredEvent extends SyncEvent { decryption?: Decryption }

async function decryptForDisplay(events: SyncEvent[]): Promise<StoredEvent[]> {
  const result: StoredEvent[] = [];
  for (const event of events) {
    if (event.cryptoVersion > 0) result.push({ ...event, decryption: event.type === "KEY_GRANT"
      ? await receiveKeyGrant(event) : await decryptMessage(event) });
    else result.push(event);
  }
  return result;
}

/** Load one selected thread through its index, including history outside the recent window. */
export async function listAggregateEvents(aggregateId: string): Promise<StoredEvent[]> {
  const events = await tx([STORE_EVENTS], "readonly", t => t.objectStore(STORE_EVENTS)
    .index("by_aggregate").getAll(aggregateId)) as SyncEvent[];
  return decryptForDisplay(events);
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

/** Dev/self-check hook used by the Debug screen. */
export async function resetLocal(): Promise<void> {
  await runningSync?.catch(() => {});
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_EVENTS, STORE_META], "readwrite");
    t.objectStore(STORE_EVENTS).clear();
    t.objectStore(STORE_META).clear();
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
export function subscribeSyncAvailable(onSynced: (applied: number) => void, onRevoked: () => void): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let connecting: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    es = new EventSource("/api/v1/sse");
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
            .catch(() => {
              /* cursor sync retries on the next signal or manual pull */
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
