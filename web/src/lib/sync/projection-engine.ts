import type { EncryptedConversationState, EncryptedMessageState, SyncEvent } from "../api.ts";
import { conversationProjectionFromEvents } from "../inbox.ts";
import { STORE_EVENTS, STORE_META, STORE_CONVERSATIONS, STORE_ENCRYPTED_CONVERSATIONS, CURSOR_KEY, PROJECTION_VERSION_KEY, PROJECTION_CURSOR_KEY } from "./schema.ts";

export function conversationStateEvent(row: EncryptedConversationState): SyncEvent {
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

export function messageStateEvent(row: EncryptedMessageState): SyncEvent {
  return {
    ...conversationStateEvent(row),
    eventId: `state:${row.messageId}:${row.revision}`,
    type: row.type,
    messageId: row.messageId,
  };
}

/** Derived projection maintenance; raw events and browser identity are untouched. */
export function createProjectionEngine(host: {
  requestToPromise: <T>(request: IDBRequest<T>) => Promise<T>;
  txDone: (transaction: IDBTransaction) => Promise<void>;
  metaNumber: (db: IDBDatabase, key: string) => Promise<number>;
  contactsFromDb: (db: IDBDatabase) => Promise<{ normalizedPhone: string; displayName: string }[]>;
  decryptForDisplay: (events: SyncEvent[]) => Promise<SyncEvent[]>;
}) {
  const { requestToPromise, txDone, metaNumber, contactsFromDb, decryptForDisplay } = host;
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
  return { refreshConversationProjectionsInDb, repairConversationProjectionGap, ensureConversationProjectionRebuilt };
}
