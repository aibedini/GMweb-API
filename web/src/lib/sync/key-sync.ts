import { fetchKeyGrantsAfter, fetchKeyring, type SyncPage } from "../api.ts";
import { receiveKeyGrants } from "../messageCrypto.ts";
import { updateSyncStatus } from "./sync-state.ts";

export async function syncKeysSafely(work: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
  const controller = new AbortController();
  const startedAt = performance.now();
  updateSyncStatus({ keyState: "REFRESHING", keyError: null, keyPhase: "starting",
    keyGrantsProcessed: 0, keyConversationsReprojected: 0, keyContactsRepaired: 0 });
  try {
    await work(controller.signal);
    updateSyncStatus({ keyState: "UP_TO_DATE", keyError: null, keyPhase: "complete",
      keyDurationMs: Math.round(performance.now() - startedAt), lastKeySyncAt: Date.now() });
    return true;
  } catch (cause) {
    updateSyncStatus({ keyState: "FAILED", keyError: cause instanceof Error ? cause.message : String(cause),
      keyDurationMs: Math.round(performance.now() - startedAt) });
    return false;
  }
}

/** Crypto and IndexedDB work has no arbitrary wall-clock deadline. */
export function boundedKeyWork(work: Promise<unknown>, _controller?: AbortController): Promise<void> {
  return work.then(() => undefined);
}

/** A stalled HTTP request is bounded independently of local key processing. */
async function keyRequest<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Key request timed out")); }, 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

interface KeySyncHost {
  conversationStore: string;
  metaNumber: (db: IDBDatabase, key: string) => Promise<number>;
  setMetaNumber: (key: string, value: number) => Promise<void>;
  requestToPromise: <T>(request: IDBRequest<T>) => Promise<T>;
  refreshConversationProjectionsInDb: (db: IDBDatabase, aggregateIds: string[]) => Promise<void>;
  repairContactsFromLocalEvents: (db: IDBDatabase) => Promise<void>;
}

export async function runKeySync(signal: AbortSignal, db: IDBDatabase, deviceId: string, host: KeySyncHost): Promise<void> {
  const { conversationStore, metaNumber, setMetaNumber, requestToPromise,
    refreshConversationProjectionsInDb, repairContactsFromLocalEvents } = host;
  updateSyncStatus({ keyPhase: "keyring request" });
  const keyring = await fetchValidatedKeyring(signal);
  const keyringKey = keyringCursorKey(deviceId);
  const previousKeyringCursor = await metaNumber(db, keyringKey);
  if (keyring.nextCursor > previousKeyringCursor) {
    updateSyncStatus({ keyPhase: "keyring import" });
    for (let offset = 0; offset < keyring.events.length; offset += 100) {
      const results = await receiveKeyGrants(keyring.events.slice(offset, offset + 100));
      signal.throwIfAborted();
      const rejectedKey = results.find(result => result.state !== "key-grant" ||
        (result.reason !== "Authorized account key stored" &&
         result.reason !== "Authorized history key stored" &&
         result.reason !== "Prior pairing history grant ignored"));
      if (rejectedKey) throw new Error(`Account keyring failed: ${"reason" in rejectedKey ? rejectedKey.reason : "unexpected result"}`);
      updateSyncStatus({ keyGrantsProcessed: offset + results.length });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    const aggregateIds = (await requestToPromise(db.transaction(conversationStore, "readonly")
      .objectStore(conversationStore).getAllKeys())).filter((key): key is string => typeof key === "string");
    for (let offset = 0; offset < aggregateIds.length; offset += 100) {
      updateSyncStatus({ keyPhase: "conversation reprojection" });
      await refreshConversationProjectionsInDb(db, aggregateIds.slice(offset, offset + 100));
      updateSyncStatus({ keyConversationsReprojected: offset + Math.min(100, aggregateIds.length - offset) });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    updateSyncStatus({ keyPhase: "contacts repair" });
    await repairContactsFromLocalEvents(db);
    updateSyncStatus({ keyContactsRepaired: 1 });
    signal.throwIfAborted();
    await setMetaNumber(keyringKey, keyring.nextCursor);
  }

  const cursorKey = grantCursorKey(deviceId);
  let cursor = await metaNumber(db, cursorKey);
  for (;;) {
    updateSyncStatus({ keyPhase: "grant request" });
    const page = await fetchValidatedGrantPage(cursor, signal);
    if (page.events.length === 0) break;
    updateSyncStatus({ keyPhase: "grant import" });
    const results = await receiveKeyGrants(page.events);
    updateSyncStatus({ keyGrantsProcessed: page.events.length });
    signal.throwIfAborted();
    const rejected = results.find(result => result.state !== "key-grant" ||
      result.reason !== "Authorized epoch key stored");
    if (rejected) throw new Error(`Key-grant bootstrap failed: ${"reason" in rejected ? rejected.reason : "unexpected result"}`);
    const acceptedAggregates = new Set<string>();
    let contactsGrantAccepted = false;
    for (let index = 0; index < page.events.length; index += 1) {
      const event = page.events[index];
      const result = results[index];
      if (result.state !== "key-grant" || result.reason !== "Authorized epoch key stored") continue;
      if (event.type === "CONTACTS_KEY_GRANT") contactsGrantAccepted = true;
      else if (event.aggregateId) acceptedAggregates.add(event.aggregateId);
    }
    if (acceptedAggregates.size > 0) {
      const projected = new Set((await requestToPromise(db.transaction(conversationStore, "readonly")
        .objectStore(conversationStore).getAllKeys())).filter((key): key is string => typeof key === "string"));
      const targets = [...acceptedAggregates].filter(id => projected.has(id));
      updateSyncStatus({ keyPhase: "conversation reprojection" });
      await refreshConversationProjectionsInDb(db, targets);
      updateSyncStatus({ keyConversationsReprojected: targets.length });
    }
    if (contactsGrantAccepted) {
      updateSyncStatus({ keyPhase: "contacts repair" });
      await repairContactsFromLocalEvents(db);
      updateSyncStatus({ keyContactsRepaired: 1 });
    }
    signal.throwIfAborted();
    cursor = page.nextCursor;
    await setMetaNumber(cursorKey, cursor);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!page.hasMore) break;
  }
}

export const keyringCursorKey = (deviceId: string) => `account_keyring_v2_cursor:${deviceId}`;
export const grantCursorKey = (deviceId: string) => `key_grant_bootstrap_v2_cursor:${deviceId}`;

export async function fetchValidatedKeyring(signal: AbortSignal): Promise<SyncPage> {
  signal.throwIfAborted();
  const page = await keyRequest(requestSignal => fetchKeyring(1000, requestSignal), signal);
  signal.throwIfAborted();
  if (page.hasMore || page.events.some(event =>
    !((event.type === "KEYRING_ENTRY" && event.cryptoVersion === 2) ||
      (event.type === "HISTORY_KEY_GRANT" && event.cryptoVersion === 3)))) {
    throw new Error("Invalid or oversized account keyring");
  }
  return page;
}

export async function fetchValidatedGrantPage(cursor: number, signal: AbortSignal): Promise<SyncPage> {
  const page = await keyRequest(requestSignal => fetchKeyGrantsAfter(cursor, 100, requestSignal), signal);
  signal.throwIfAborted();
  if (page.events.length && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor ||
    page.events.some(event => !Number.isSafeInteger(event.sequence) || event.sequence <= cursor ||
      event.sequence > page.nextCursor || (event.type !== "KEY_GRANT" && event.type !== "CONTACTS_KEY_GRANT")))) {
    throw new Error("Invalid key-grant bootstrap page");
  }
  return page;
}
