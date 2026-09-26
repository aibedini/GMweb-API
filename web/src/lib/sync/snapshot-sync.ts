import { continueWebSnapshot, startWebSnapshot, SnapshotRequiredError, type SyncEvent, type WebSnapshotPage } from "../api.ts";
import { STORE_EVENTS, STORE_META, CURSOR_KEY, STORE_CONVERSATIONS, STORE_ENCRYPTED_CONVERSATIONS, STORE_ENCRYPTED_MESSAGES, PROJECTION_CURSOR_KEY, REPLICA_GENERATION_KEY, SNAPSHOT_VERSION_KEY, SNAPSHOT_TOKEN_KEY, SNAPSHOT_CURSOR_KEY, SNAPSHOT_BASELINE_KEY, SNAPSHOT_COMPLETE_KEY, SNAPSHOT_STARTED_AT_KEY, SNAPSHOT_LAST_PAGE_AT_KEY, SNAPSHOT_LAST_PAGE_MS_KEY, SNAPSHOT_PAGE_COUNT_KEY, SNAPSHOT_POSITION_KEY, REPLICA_MIGRATION_VERSION_KEY, RECONSTRUCTABLE_STATE_EVENTS } from "./schema.ts";

interface SnapshotHost {
  openDb: () => Promise<IDBDatabase>;
  metaValue: <T>(db: IDBDatabase, key: string) => Promise<T | undefined>;
  txDone: (transaction: IDBTransaction) => Promise<void>;
  repairContactsFromLocalEvents: (db: IDBDatabase) => Promise<void>;
}

export async function runSnapshotBootstrap(host: SnapshotHost, force = false, maxPages = Infinity): Promise<boolean> {
  const { openDb, metaValue, txDone, repairContactsFromLocalEvents } = host;
  const db = await openDb();
  const storedComplete = await metaValue<boolean>(db, SNAPSHOT_COMPLETE_KEY);
  const storedGeneration = await metaValue<string>(db, REPLICA_GENERATION_KEY);
  const storedSnapshotVersion = await metaValue<number>(db, SNAPSHOT_VERSION_KEY);
  if (!force && storedComplete === true && storedGeneration && Number.isSafeInteger(storedSnapshotVersion)) return true;
  let token = force ? null : await metaValue<string>(db, SNAPSHOT_TOKEN_KEY);
  let cursor = force ? null : await metaValue<string>(db, SNAPSHOT_CURSOR_KEY);
  let baseline = force ? null : await metaValue<number>(db, SNAPSHOT_BASELINE_KEY);
  let expectedGeneration = force ? null : storedGeneration;
  let expectedVersion = force ? null : storedSnapshotVersion;
  const pageLimit = 100;
  for (let fetched = 0; fetched < Math.max(1, maxPages); fetched++) {
    const pageStartedAt = Date.now();
    let page: WebSnapshotPage;
    let firstPage = !token || !cursor;
    try {
      page = token && cursor
        ? await continueWebSnapshot(token, cursor, pageLimit)
        : await startWebSnapshot(pageLimit);
    } catch (cause) {
      if (!(cause instanceof SnapshotRequiredError)) throw cause;
      token = null;
      cursor = null;
      baseline = null;
      expectedGeneration = null;
      expectedVersion = null;
      page = await startWebSnapshot(pageLimit);
      firstPage = true;
    }
    assertValidSnapshotPage(page, { token, cursor, baseline, expectedGeneration, expectedVersion, pageLimit });
    const pageCount = firstPage ? 1 : (await metaValue<number>(db, SNAPSHOT_PAGE_COUNT_KEY) ?? 0) + 1;
    const previousPosition = firstPage ? 0 : (await metaValue<number>(db, SNAPSHOT_POSITION_KEY) ?? 0);
    const transaction = db.transaction(
      [STORE_EVENTS, STORE_ENCRYPTED_CONVERSATIONS, STORE_ENCRYPTED_MESSAGES, STORE_CONVERSATIONS, STORE_META], "readwrite");
    if (firstPage) {
      transaction.objectStore(STORE_ENCRYPTED_CONVERSATIONS).clear();
      transaction.objectStore(STORE_ENCRYPTED_MESSAGES).clear();
      transaction.objectStore(STORE_CONVERSATIONS).clear();
      const oldEvents = transaction.objectStore(STORE_EVENTS).openCursor();
      oldEvents.onsuccess = () => {
        const eventCursor = oldEvents.result;
        if (!eventCursor) return;
        if (RECONSTRUCTABLE_STATE_EVENTS.has((eventCursor.value as SyncEvent).type) ||
            ["CONTACTS_SNAPSHOT", "CONTACTS_CHANGED"].includes((eventCursor.value as SyncEvent).type)) eventCursor.delete();
        eventCursor.continue();
      };
      for (const event of page.contactEvents ?? []) transaction.objectStore(STORE_EVENTS).put(event);
    }
    for (const row of page.rows) {
      if (row.kind === "conversation") transaction.objectStore(STORE_ENCRYPTED_CONVERSATIONS).put(row);
      else transaction.objectStore(STORE_ENCRYPTED_MESSAGES).put(row);
    }
    const meta = transaction.objectStore(STORE_META);
    meta.put(page.token, SNAPSHOT_TOKEN_KEY);
    meta.put(page.nextCursor, SNAPSHOT_CURSOR_KEY);
    meta.put(page.baselineSequence, SNAPSHOT_BASELINE_KEY);
    meta.put(page.replicaGeneration, REPLICA_GENERATION_KEY);
    meta.put(page.snapshotVersion, SNAPSHOT_VERSION_KEY);
    meta.put(!page.hasMore, SNAPSHOT_COMPLETE_KEY);
    if (firstPage) {
      meta.put(pageStartedAt, SNAPSHOT_STARTED_AT_KEY);
    }
    meta.put(Date.now(), SNAPSHOT_LAST_PAGE_AT_KEY);
    meta.put(Date.now() - pageStartedAt, SNAPSHOT_LAST_PAGE_MS_KEY);
    meta.put(pageCount, SNAPSHOT_PAGE_COUNT_KEY);
    meta.put(page.rows.at(-1)?.position ?? previousPosition, SNAPSHOT_POSITION_KEY);
    if (firstPage && page.hasMore) {
      meta.put(0, CURSOR_KEY);
      meta.put(0, PROJECTION_CURSOR_KEY);
    }
    if (!page.hasMore) {
      meta.put(page.baselineSequence, CURSOR_KEY);
      meta.put(page.baselineSequence, PROJECTION_CURSOR_KEY);
      meta.put(7, REPLICA_MIGRATION_VERSION_KEY);
    }
    await txDone(transaction);
    token = page.token;
    cursor = page.nextCursor;
    baseline = page.baselineSequence;
    expectedGeneration = page.replicaGeneration;
    expectedVersion = page.snapshotVersion;
    if (!page.hasMore) {
      await repairContactsFromLocalEvents(db);
      return true;
    }
  }
  return false;
}

function snapshotCursorPosition(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const decoded = atob(base64);
    const position = Number(decoded);
    return Number.isSafeInteger(position) && position >= 0 && String(position) === decoded ? position : NaN;
  } catch {
    return NaN;
  }
}

interface SnapshotExpectations {
  token: string | null | undefined;
  cursor: string | null | undefined;
  baseline: number | null | undefined;
  expectedGeneration: string | null | undefined;
  expectedVersion: number | null | undefined;
  pageLimit: number;
}

export function assertValidSnapshotPage(page: WebSnapshotPage, options: SnapshotExpectations): void {
  const { token, cursor, baseline, expectedGeneration, expectedVersion, pageLimit } = options;
  if (!page.token || !page.replicaGeneration || !Number.isSafeInteger(page.snapshotVersion) ||
      !Number.isSafeInteger(page.baselineSequence) || !Number.isSafeInteger(page.expiresAt) ||
      !Array.isArray(page.rows) || page.rows.length > pageLimit ||
      page.hasMore !== Boolean(page.nextCursor) || (page.hasMore && page.rows.length === 0) ||
      (token && page.token !== token) ||
      (baseline != null && page.baselineSequence !== baseline) ||
      (expectedGeneration && page.replicaGeneration !== expectedGeneration) ||
      (expectedVersion != null && page.snapshotVersion !== expectedVersion)) {
    throw new Error("Invalid encrypted snapshot page");
  }
  const previousPosition = snapshotCursorPosition(cursor);
  if (!Number.isSafeInteger(previousPosition) || page.rows.some((row, index) =>
    row.position !== previousPosition + index + 1 ||
    (row.kind !== "conversation" && row.kind !== "message") ||
    (row.kind === "message" && !row.messageId))) {
    throw new Error("Invalid encrypted snapshot position");
  }
  if (page.hasMore && snapshotCursorPosition(page.nextCursor) !== previousPosition + page.rows.length) {
    throw new Error("Invalid encrypted snapshot cursor");
  }
}
