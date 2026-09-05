/**
 * ADR-007 P0-6 — durable, non-extractable web device keys.
 *
 * Contract:
 *  - Private keys are generated with extractable=false (WebCrypto forbids
 *    exporting them; TechSpec requirement).
 *  - Public keys are exported and stored alongside (needed for the QR
 *    transcript + certificate verification).
 *  - CryptoKey objects are persisted in IndexedDB — the browser lets us
 *    store non-extractable CryptoKeys directly, so the private key NEVER
 *    leaves the storage in any form.
 *  - If persistence fails, keygen is treated as failed: the caller must NOT
 *    show a QR / approve a device that could later lose its keys (§ "Browser
 *    storage was cleared" → re-pairing).
 */

const DB_NAME = "gmweb-pairing";
const STORE = "device-keys";
const KEY_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB put failed"));
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB get failed"));
  });
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface DeviceKeys {
  deviceId: string;
  signingPrivateKey: CryptoKey; // non-extractable
  signingPublicKey: CryptoKey;
  signingPublicKeyB64: string;
  encryptionPrivateKey: CryptoKey; // non-extractable
  encryptionPublicKey: CryptoKey;
  encryptionPublicKeyB64: string;
  createdAt: number;
  keyVersion: number;
}

let loadingKeys: Promise<DeviceKeys> | null = null;
/** Coalesce StrictMode/concurrent callers so one browser never shows mismatched keys. */
export function getOrCreateDeviceKeys(): Promise<DeviceKeys> {
  if (!loadingKeys) {
    const load = typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request("gmweb-device-keys", loadOrCreateDeviceKeys)
      : loadOrCreateDeviceKeys();
    loadingKeys = Promise.resolve(load).then(keys => keys).finally(() => { loadingKeys = null; });
  }
  return loadingKeys;
}

async function loadOrCreateDeviceKeys(): Promise<DeviceKeys> {
  const db = await openDb();
  try {
  const existing = await idbGet<DeviceKeys>(db, "primary");
  if (existing) {
    if (!existing.signingPrivateKey || !existing.encryptionPrivateKey ||
        existing.signingPrivateKey.extractable || existing.encryptionPrivateKey.extractable ||
        existing.keyVersion !== KEY_VERSION) throw new Error("Stored device keys are invalid; reset and pair again");
    return existing;
  }

  // Non-extractable private keys — WebCrypto throws on exportKey for them.
  const signing = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false, // extractable = false (P0-6)
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const encryption = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false, // extractable = false (P0-6)
    ["deriveKey", "deriveBits"],
  )) as CryptoKeyPair;

  const signingPublicKeyB64 = b64(await crypto.subtle.exportKey("raw", signing.publicKey));
  const encryptionPublicKeyB64 = b64(await crypto.subtle.exportKey("raw", encryption.publicKey));

  const keys: DeviceKeys = {
    deviceId: crypto.randomUUID(),
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    signingPublicKeyB64,
    encryptionPrivateKey: encryption.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPublicKeyB64,
    createdAt: Date.now(),
    keyVersion: KEY_VERSION,
  };

  // Persistence is MANDATORY (P0-6): a device that cannot durably hold its
  // private key must never be paired — it would be un-verifiable later.
  await idbPut(db, "primary", keys);
  return keys;
  } finally { db.close(); }
}

/** True when the browser still holds the key material it was paired with. */
export async function hasDurableKeys(): Promise<boolean> {
  try {
    const db = await openDb();
    const existing = await idbGet<DeviceKeys>(db, "primary");
    return Boolean(existing?.signingPrivateKey && existing.keyVersion === KEY_VERSION);
  } catch {
    return false;
  }
}

/** Destroy local keys (≡ browser un-trusts itself; server revoke is separate). */
export async function wipeDeviceKeys(): Promise<void> {
  await loadingKeys?.catch(() => {});
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete("primary");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
  });
}

export async function saveCryptoRecord(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try { await idbPut(db, key, value); } finally { db.close(); }
}

export async function loadCryptoRecord<T>(key: string): Promise<T | null> {
  const db = await openDb();
  try { return await idbGet<T>(db, key); } finally { db.close(); }
}
