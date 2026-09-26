import { getCursor } from "./sync.ts";

const KEY_PREFIX = "pending_encrypted_send_v2:";

export interface PendingEncryptedSend {
  browserDeviceId: string;
  clientMessageId: string;
  idempotencyKey: string;
  payload: string;
  targetAgentId: string;
  createdAt: number;
  commandId?: string;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

async function db(): Promise<IDBDatabase> {
  // Initialize the normal replica schema before opening a versionless handle.
  await getCursor();
  return request(indexedDB.open("gmweb-messages"));
}

export async function loadPendingSends(): Promise<PendingEncryptedSend[]> {
  const database = await db();
  try {
    const rows: PendingEncryptedSend[] = [];
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("meta", "readonly");
      const cursor = transaction.objectStore("meta").openCursor(
        IDBKeyRange.bound(KEY_PREFIX, `${KEY_PREFIX}\uffff`));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        rows.push(row.value as PendingEncryptedSend);
        row.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    return rows;
  } finally { database.close(); }
}

export async function savePendingSend(value: PendingEncryptedSend): Promise<void> {
  const database = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("meta", "readwrite");
      transaction.objectStore("meta").put(value, `${KEY_PREFIX}${value.clientMessageId}`);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

export async function clearPendingSend(clientMessageId: string): Promise<void> {
  const database = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("meta", "readwrite");
      transaction.objectStore("meta").delete(`${KEY_PREFIX}${clientMessageId}`);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
