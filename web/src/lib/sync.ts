/**
 * §41/§54 sync engine — the UI's source of truth is IndexedDB, updated
 * transactionally from /api/v1/sync pages. Realtime (SSE, Phase 4) only
 * invalidates ("sync.available"); correctness comes from the cursor.
 *
 * PR (web-01): stores raw opaque events keyed by per-account serverSequence.
 * Envelope decryption (Phase 7) plugs into applyEvent()'s single choke point
 * without touching storage or UI.
 */

import { fetchEventsAfter, type SyncEvent } from "./api";

const DB_NAME = "gmweb-messages";
const DB_VERSION = 1;
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

async function putCursor(value: number): Promise<void> {
  await tx([STORE_META], "readwrite", (t) => t.objectStore(STORE_META).put(value, CURSOR_KEY) as unknown as IDBRequest<undefined>);
}

/** Applies ONE event; the single choke point where Phase 7 decrypts. */
function applyEvent(_event: SyncEvent): void {
  // web-01 stores the opaque event only; the Inbox screen lists aggregates.
}

/** §43: apply pages transactionally until the server says hasMore=false. */
export async function syncNow(onProgress?: (applied: number) => void): Promise<number> {
  let cursor = await getCursor();
  let applied = 0;
  for (let guard = 0; guard < 20; guard++) {
    const page = await fetchEventsAfter(cursor);
    if (page.events.length === 0) break;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([STORE_EVENTS, STORE_META], "readwrite");
      const store = t.objectStore(STORE_EVENTS);
      for (const ev of page.events) {
        store.put(ev); // keyed by server sequence — idempotent replay-safe
        applyEvent(ev);
      }
      t.objectStore(STORE_META).put(page.nextCursor, CURSOR_KEY);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    applied += page.events.length;
    cursor = page.nextCursor;
    onProgress?.(applied);
    if (!page.hasMore) break;
  }
  await putCursor(cursor);
  return applied;
}

export interface StoredEvent extends SyncEvent {}

export async function listRecentEvents(limit = 100): Promise<StoredEvent[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE_EVENTS], "readonly");
    const req = t.objectStore(STORE_EVENTS).getAll(null, limit);
    req.onsuccess = () => resolve((req.result as StoredEvent[]).slice(-limit).reverse());
    req.onerror = () => reject(req.error);
  });
}

/** Dev/self-check hook used by the Debug screen. */
export async function resetLocal(): Promise<void> {
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
export function subscribeSyncAvailable(onSynced: (applied: number) => void): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let connecting: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    es = new EventSource("/api/v1/sse");
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as { type?: string; newEvents?: number };
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
