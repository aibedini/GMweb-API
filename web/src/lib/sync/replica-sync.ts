import { acknowledgeWebSync, fetchEventsAfter, SnapshotRequiredError, type EncryptedConversationState, type EncryptedMessageState, type SyncPage } from "../api.ts";
import { receiveKeyGrants, decryptMessage } from "../messageCrypto.ts";
import { decodeEventPayload } from "../inbox.ts";
import { assertSupportedContentEvent } from "../eventCryptoPolicy.ts";
import { boundedKeyWork } from "./key-sync.ts";
import { syncFailure } from "./sync-state.ts";
import { STORE_EVENTS, STORE_META, STORE_ENCRYPTED_CONVERSATIONS, STORE_ENCRYPTED_MESSAGES, CURSOR_KEY, PROJECTION_CURSOR_KEY, REPLICA_GENERATION_KEY, SNAPSHOT_VERSION_KEY } from "./schema.ts";

interface DrainResult { applied: number; lastPageCount: number; caughtUp: boolean; keyDegraded: boolean }
export function createReplicaEngine(host: {
  getCursor: () => Promise<number>;
  openDb: () => Promise<IDBDatabase>;
  metaValue: <T>(db: IDBDatabase, key: string) => Promise<T | undefined>;
  setMetaNumber: (key: string, value: number) => Promise<void>;
  bootstrapEncryptedState: (force?: boolean, maxPages?: number) => Promise<boolean>;
  refreshConversationProjections: (aggregateIds: string[]) => Promise<void>;
  applyContacts: (payload: Record<string, unknown>) => Promise<void>;
  compactLocalContentEvents: (db: IDBDatabase, throughSequence: number) => Promise<void>;
}) {
  const { getCursor, openDb, metaValue, setMetaNumber, bootstrapEncryptedState,
    refreshConversationProjections, applyContacts, compactLocalContentEvents } = host;
  async function drainSync(maxPages?: number, onProgress?: (applied: number) => void): Promise<DrainResult> {
    let cursor = await getCursor();
    const db = await openDb();
    let replicaGeneration = await metaValue<string>(db, REPLICA_GENERATION_KEY);
    let snapshotVersion = await metaValue<number>(db, SNAPSHOT_VERSION_KEY);
    let applied = 0;
    let pages = 0;
    let lastPageCount = 0;
    let keyDegraded = false;
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
        replicaGeneration = await metaValue<string>(db, REPLICA_GENERATION_KEY);
        snapshotVersion = await metaValue<number>(db, SNAPSHOT_VERSION_KEY);
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
      if (page.events.length === 0) {
        if (replicaGeneration && Number.isSafeInteger(snapshotVersion)) {
          await acknowledgeWebSync(cursor, replicaGeneration, snapshotVersion!);
        }
        return { applied, lastPageCount, caughtUp: true, keyDegraded };
      }
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor ||
          page.events.some(ev => !Number.isSafeInteger(ev.sequence) || ev.sequence <= cursor || ev.sequence > page.nextCursor)) {
        throw new Error("Invalid sync page: non-advancing cursor or event sequence");
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
      // Raw ciphertext and its cursor are durable before any fallible key work.
      // The next key bootstrap or projection repair can retry from stored events.
      try {
        const grantEvents = page.events.filter(event =>
          (event.cryptoVersion === 1 && (event.type === "KEY_GRANT" || event.type === "CONTACTS_KEY_GRANT")) ||
          (event.cryptoVersion === 2 && event.type === "KEYRING_ENTRY") ||
          (event.cryptoVersion === 3 && event.type === "HISTORY_KEY_GRANT"));
        if (grantEvents.length > 0 || page.events.some(event =>
          event.type === "CONTACTS_SNAPSHOT" || event.type === "CONTACTS_CHANGED")) {
          await boundedKeyWork((async () => {
            const grants = await receiveKeyGrants(grantEvents);
            if (grants.some(result => result.state === "invalid" || result.state === "locked")) {
              throw new Error("Key grant could not be installed");
            }
            for (const event of page.events) {
              if ((event.cryptoVersion === 1 || event.cryptoVersion === 2) &&
                  (event.type === "CONTACTS_SNAPSHOT" || event.type === "CONTACTS_CHANGED")) {
                const decoded = await decryptMessage(event);
                if (decoded.state === "decrypted") await applyContacts(decoded.payload);
              }
            }
          })());
        }
      } catch (cause) {
        keyDegraded = true;
        syncFailure("KEY_SYNC", cause, false);
      }
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
      if (!page.hasMore) return { applied, lastPageCount, caughtUp: true, keyDegraded };
      if (maxPages !== undefined && pages >= maxPages) return { applied, lastPageCount, caughtUp: false, keyDegraded };
    }
  }
  return { drainSync };
}
