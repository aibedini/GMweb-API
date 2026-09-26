import { fetchKeyGrantsAfter, fetchKeyring, type SyncPage } from "../api.ts";
import { receiveKeyGrants } from "../messageCrypto.ts";
import { syncFailure } from "./sync-state.ts";

export async function syncKeysSafely(work: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
  const controller = new AbortController();
  try {
    await boundedKeyWork(work(controller.signal), controller);
    return true;
  } catch (cause) {
    syncFailure("KEY_SYNC", cause, false);
    return false;
  }
}

export function boundedKeyWork(work: Promise<unknown>, controller?: AbortController): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller?.abort();
        reject(new Error("Key processing timed out"));
      }, 2_000);
    }),
  ]).then(() => undefined).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
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
  const keyring = await fetchValidatedKeyring(signal);
  const keyringKey = keyringCursorKey(deviceId);
  const previousKeyringCursor = await metaNumber(db, keyringKey);
  if (keyring.nextCursor > previousKeyringCursor) {
    const keyringResults = await receiveKeyGrants(keyring.events);
    signal.throwIfAborted();
    const rejectedKey = keyringResults.find(result => result.state !== "key-grant" ||
      (result.reason !== "Authorized account key stored" &&
       result.reason !== "Authorized history key stored"));
    if (rejectedKey) throw new Error(`Account keyring failed: ${"reason" in rejectedKey ? rejectedKey.reason : "unexpected result"}`);

    const aggregateIds = (await requestToPromise(db.transaction(conversationStore, "readonly")
      .objectStore(conversationStore).getAllKeys())).filter((key): key is string => typeof key === "string");
    await refreshConversationProjectionsInDb(db, aggregateIds);
    await repairContactsFromLocalEvents(db);
    signal.throwIfAborted();
    await setMetaNumber(keyringKey, keyring.nextCursor);
  }

  const cursorKey = grantCursorKey(deviceId);
  let cursor = await metaNumber(db, cursorKey);
  const acceptedAggregates = new Set<string>();
  let contactsGrantAccepted = false;
  for (;;) {
    const page = await fetchValidatedGrantPage(cursor, signal);
    if (page.events.length === 0) break;
    const results = await receiveKeyGrants(page.events);
    signal.throwIfAborted();
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
    const projected = new Set((await requestToPromise(db.transaction(conversationStore, "readonly")
      .objectStore(conversationStore).getAllKeys())).filter((key): key is string => typeof key === "string"));
    await refreshConversationProjectionsInDb(db, [...acceptedAggregates].filter(id => projected.has(id)));
  }
  if (contactsGrantAccepted) await repairContactsFromLocalEvents(db);
  signal.throwIfAborted();
  await setMetaNumber(cursorKey, cursor);
}

export const keyringCursorKey = (deviceId: string) => `account_keyring_v2_cursor:${deviceId}`;
export const grantCursorKey = (deviceId: string) => `key_grant_bootstrap_v2_cursor:${deviceId}`;

export async function fetchValidatedKeyring(signal: AbortSignal): Promise<SyncPage> {
  signal.throwIfAborted();
  const page = await fetchKeyring(1000, signal);
  signal.throwIfAborted();
  if (page.hasMore || page.events.some(event =>
    !((event.type === "KEYRING_ENTRY" && event.cryptoVersion === 2) ||
      (event.type === "HISTORY_KEY_GRANT" && event.cryptoVersion === 3)))) {
    throw new Error("Invalid or oversized account keyring");
  }
  return page;
}

export async function fetchValidatedGrantPage(cursor: number, signal: AbortSignal): Promise<SyncPage> {
  const page = await fetchKeyGrantsAfter(cursor, 1000, signal);
  signal.throwIfAborted();
  if (page.events.length && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor ||
    page.events.some(event => !Number.isSafeInteger(event.sequence) || event.sequence <= cursor ||
      event.sequence > page.nextCursor || (event.type !== "KEY_GRANT" && event.type !== "CONTACTS_KEY_GRANT")))) {
    throw new Error("Invalid key-grant bootstrap page");
  }
  return page;
}
