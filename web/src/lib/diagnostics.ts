import { fetchSyncDiagnostics, health, type ServerSyncDiagnostics, type SyncEvent } from "./api.ts";
import { getBrowserSyncStatus, getCursor, getProjectionCursor, type BrowserSyncStatus } from "./sync.ts";
import { getStoredDeviceIdentity, loadCryptoRecord } from "./deviceKeys.ts";
import { PWA_BUILD_VERSION, loadedScriptFile } from "./buildInfo.ts";
import { decryptMessage, receiveKeyGrants, type Decryption } from "./messageCrypto.ts";

const EVENT_TYPES = ["MESSAGE_CREATED", "MESSAGE_UPDATED", "KEY_GRANT", "CONTACTS_KEY_GRANT", "CONTACTS_SNAPSHOT", "CONTACTS_CHANGED"];

export interface WebDiagnosticReport {
  collectedAt: number;
  session: { linked: boolean; capabilities: string[]; apiVersion: string; pwaVersion: string; loadedScript: string; serviceWorker: string; online: boolean; buildMismatch: boolean };
  server: ServerSyncDiagnostics | null;
  browserSync: BrowserSyncStatus & { cursor: number; projectionCursor: number; syncLag: number | null; projectionLag: number };
  indexedDb: { total: number; byType: Record<string, number>; byCryptoVersion: Record<string, number>; nullAggregateCount: number; distinctMessageAggregateCount: number; conversationRows: number; contactRows: number };
  crypto: { browserIdentity: boolean; verifiedPrimary: boolean; primaryMatchesBrowser: boolean; messages: DecryptionCounts; keyGrants: DecryptionCounts };
  projection: { cursor: number; lag: number; rawMessageAggregates: number; rows: number; readyRows: number; lockedRows: number; failure: "PROJECTION_DIVERGENCE" | null };
  contacts: { grants: number; snapshots: number; changed: number; stored: number; grantCrypto: DecryptionCounts; payloadCrypto: DecryptionCounts; failure: "CONTACTS_NO_GRANT" | "CONTACTS_DECRYPT_FAILED" | "CONTACTS_PROJECTION_EMPTY" | null };
  selectedThread?: { aggregateHash: string; rawEvents: number; messageCreated: number; messageUpdated: number; keyGrantRelated: number; decrypted: number; locked: number; invalid: number; state: string; firstPageDurationMs: number | null; lastPageError: string | null };
  overall: "PASS" | "SYNCING" | "WARN" | "FAIL";
}

type ProjectionRow = { decodeState?: string };
export interface DecryptionCounts { decrypted: number; accepted: number; locked: number; invalid: number; reasons: Record<string, number> }

const emptyDecryptionCounts = (): DecryptionCounts => ({ decrypted: 0, accepted: 0, locked: 0, invalid: 0, reasons: {} });

function safeCryptoReason(value: string): string {
  const reason = value.toLowerCase();
  if (reason.includes("authorized key grant unavailable")) return "Authorized key grant unavailable";
  if (reason.includes("primary trust root") || reason.includes("pair again")) return "Primary trust root unavailable";
  if (reason.includes("another device")) return "Grant for another device";
  if (reason.includes("key grant signature")) return "Invalid key grant signature";
  if (reason.includes("envelope binding")) return "Envelope binding mismatch";
  if (reason.includes("cke conversation")) return "CKE conversation mismatch";
  if (reason.includes("unsupported")) return "Unsupported crypto version";
  if (reason.includes("operation") || reason.includes("authentication")) return "AEAD authentication failed";
  return "Invalid encrypted payload";
}

export function countDecryptions(values: Array<Decryption | undefined>): DecryptionCounts {
  const result = emptyDecryptionCounts();
  for (const value of values) {
    if (!value) continue;
    if (value.state === "decrypted") result.decrypted += 1;
    else if (value.state === "key-grant" && value.reason === "Authorized epoch key stored") result.accepted += 1;
    else {
      if (value.state === "invalid") result.invalid += 1;
      else if (value.state === "locked") result.locked += 1;
      const reason = safeCryptoReason(value.reason);
      result.reasons[reason] = (result.reasons[reason] || 0) + 1;
    }
  }
  return result;
}

export function detectProjectionFailure(rawAggregates: number, projectionRows: number, projectionCursor: number, syncCursor: number): "PROJECTION_DIVERGENCE" | null {
  return rawAggregates > 0 && (projectionRows === 0 || (projectionCursor >= syncCursor && projectionRows < rawAggregates * 0.8))
    ? "PROJECTION_DIVERGENCE" : null;
}

export function detectContactsFailure(eventCounts: Record<string, number>, payloadCrypto: DecryptionCounts, stored: number): WebDiagnosticReport["contacts"]["failure"] {
  const payloads = (eventCounts.CONTACTS_SNAPSHOT || 0) + (eventCounts.CONTACTS_CHANGED || 0);
  if (payloads > 0 && !eventCounts.CONTACTS_KEY_GRANT) return "CONTACTS_NO_GRANT";
  if (payloadCrypto.locked > 0 || payloadCrypto.invalid > 0) return "CONTACTS_DECRYPT_FAILED";
  if (payloads > 0 && stored === 0) return "CONTACTS_PROJECTION_EMPTY";
  return null;
}

export function diagnosticOutcome(input: { buildMismatch: boolean; projectionFailure: string | null; syncState: BrowserSyncStatus["state"]; contactsFailure: string | null; syncLag: number | null; projectionLag: number }): WebDiagnosticReport["overall"] {
  if (input.buildMismatch || input.projectionFailure || input.syncState === "FAILED") return "FAIL";
  if (input.syncState === "DEGRADED" || input.contactsFailure) return "WARN";
  if (input.syncLag === null || input.syncLag > 0 || input.projectionLag > 0 || input.syncState !== "UP_TO_DATE") return "SYNCING";
  return "PASS";
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function openMessagesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const value = indexedDB.open("gmweb-messages");
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

async function localCounts() {
  const db = await openMessagesDb();
  try {
    const byType: Record<string, number> = Object.fromEntries(EVENT_TYPES.map(type => [type, 0]));
    const byCryptoVersion: Record<string, number> = {};
    const messageAggregates = new Set<string>();
    let total = 0;
    let nullAggregateCount = 0;
    // Full counts stay exact; crypto checks use a bounded recent sample so a
    // large history cannot leave the Diagnostics screen on "Collecting…".
    const rawEvents: SyncEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("events", "readonly");
      const cursorRequest = transaction.objectStore("events").openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const event = cursor.value as SyncEvent;
        rawEvents.push(event);
        if (rawEvents.length > 1000) rawEvents.shift();
        total += 1;
        byType[event.type] = (byType[event.type] || 0) + 1;
        byCryptoVersion[String(event.cryptoVersion)] = (byCryptoVersion[String(event.cryptoVersion)] || 0) + 1;
        if (!event.aggregateId) nullAggregateCount += 1;
        else if (event.type === "MESSAGE_CREATED" || event.type === "MESSAGE_UPDATED") messageAggregates.add(event.aggregateId);
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Diagnostic scan aborted"));
    });
    const projections = db.objectStoreNames.contains("conversations")
      ? await request(db.transaction("conversations", "readonly").objectStore("conversations").getAll()) as ProjectionRow[] : [];
    const contactRows = db.objectStoreNames.contains("contacts")
      ? await request(db.transaction("contacts", "readonly").objectStore("contacts").count()) : 0;
    rawEvents.sort((a, b) => a.sequence - b.sequence);
    const grantStates = new Map<number, Decryption>();
    const grants = rawEvents.filter(event => event.cryptoVersion > 0 &&
      (event.type === "KEY_GRANT" || event.type === "CONTACTS_KEY_GRANT"));
    const grantResults = await receiveKeyGrants(grants);
    grants.forEach((event, index) => grantStates.set(event.sequence, grantResults[index]));
    const payloadStates = new Map<number, Decryption>();
    for (const event of rawEvents) {
      if (event.cryptoVersion > 0 && event.type !== "KEY_GRANT" && event.type !== "CONTACTS_KEY_GRANT")
        payloadStates.set(event.sequence, await decryptMessage(event));
    }
    const statesFor = (types: string[], grants = false) => rawEvents
      .filter(event => types.includes(event.type))
      .map(event => event.cryptoVersion === 0
        ? ({ state: "decrypted", payload: {} } as Decryption)
        : (grants ? grantStates : payloadStates).get(event.sequence));
    return {
      total, byType, byCryptoVersion, nullAggregateCount,
      distinctMessageAggregateCount: messageAggregates.size,
      conversationRows: projections.length,
      contactRows,
      readyRows: projections.filter(row => row.decodeState === "ready").length,
      lockedRows: projections.filter(row => row.decodeState === "locked").length,
      messageCrypto: countDecryptions(statesFor(["MESSAGE_CREATED", "MESSAGE_UPDATED"])),
      keyGrantCrypto: countDecryptions(statesFor(["KEY_GRANT"], true)),
      contactGrantCrypto: countDecryptions(statesFor(["CONTACTS_KEY_GRANT"], true)),
      contactPayloadCrypto: countDecryptions(statesFor(["CONTACTS_SNAPSHOT", "CONTACTS_CHANGED"])),
    };
  } finally { db.close(); }
}

function safeError(value: string | null): string | null {
  if (!value) return null;
  if (/Invalid sync page/i.test(value)) return "Invalid sync page";
  const http = value.match(/HTTP\s+\d{3}/i)?.[0];
  return http || "Sync operation failed";
}

async function shortHash(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest.slice(0, 6)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface SelectedThreadDiagnosticInput {
  aggregateId: string;
  events: Array<{ type: string; cryptoVersion: number; decryption?: { state: string } }>;
  state: string;
  firstPageDurationMs: number | null;
  lastPageError: string | null;
}

export async function collectWebDiagnostics(selected?: SelectedThreadDiagnosticInput): Promise<WebDiagnosticReport> {
  // Opening through sync.ts first guarantees the current schema and performs
  // any pending projection repair before the read-only diagnostic scan.
  const [cursor, projectionCursor] = await Promise.all([getCursor(), getProjectionCursor()]);
  const [sessionResponse, api, server, local, identity, pinned, registration] = await Promise.all([
    fetch("/api/v1/linked-session", { credentials: "include" }).then(response => response.json()).catch(() => ({})),
    health().catch(() => ({ ok: false, version: "unreachable" })),
    fetchSyncDiagnostics().catch(() => null),
    localCounts(), getStoredDeviceIdentity(),
    loadCryptoRecord<{ deviceId: string; encryptionPublicKey: string }>("verified-primary").catch(() => null),
    navigator.serviceWorker?.getRegistration().catch(() => undefined),
  ]);
  const runtime = getBrowserSyncStatus();
  const projectionLag = Math.max(0, cursor - projectionCursor);
  const syncLag = server ? Math.max(0, server.maxSequence - cursor) : null;
  const projectionFailure = detectProjectionFailure(local.distinctMessageAggregateCount, local.conversationRows, projectionCursor, cursor);
  const contactsFailure = detectContactsFailure(local.byType, local.contactPayloadCrypto, local.contactRows);
  const primaryMatchesBrowser = Boolean(identity && pinned && pinned.deviceId === identity.deviceId &&
    pinned.encryptionPublicKey === identity.encryptionPublicKeyB64);
  const buildMismatch = api.version !== PWA_BUILD_VERSION;
  const overall = diagnosticOutcome({ buildMismatch, projectionFailure, syncState: runtime.state, contactsFailure, syncLag, projectionLag });
  const report: WebDiagnosticReport = {
    collectedAt: Date.now(),
    session: {
      linked: sessionResponse.authenticated === true,
      capabilities: Array.isArray(sessionResponse.capabilities) ? sessionResponse.capabilities.map(String) : [],
      apiVersion: api.version, pwaVersion: PWA_BUILD_VERSION, loadedScript: loadedScriptFile(),
      serviceWorker: registration?.active ? "ACTIVE" : registration ? "INSTALLING" : "NONE",
      online: navigator.onLine, buildMismatch,
    },
    server,
    browserSync: { ...runtime, lastErrorMessage: safeError(runtime.lastErrorMessage), cursor, projectionCursor, syncLag, projectionLag },
    indexedDb: {
      total: local.total, byType: local.byType, byCryptoVersion: local.byCryptoVersion,
      nullAggregateCount: local.nullAggregateCount, distinctMessageAggregateCount: local.distinctMessageAggregateCount,
      conversationRows: local.conversationRows, contactRows: local.contactRows,
    },
    crypto: {
      browserIdentity: Boolean(identity), verifiedPrimary: Boolean(pinned), primaryMatchesBrowser,
      messages: local.messageCrypto, keyGrants: local.keyGrantCrypto,
    },
    projection: {
      cursor: projectionCursor, lag: projectionLag, rawMessageAggregates: local.distinctMessageAggregateCount,
      rows: local.conversationRows, readyRows: local.readyRows, lockedRows: local.lockedRows, failure: projectionFailure,
    },
    contacts: {
      grants: local.byType.CONTACTS_KEY_GRANT || 0, snapshots: local.byType.CONTACTS_SNAPSHOT || 0,
      changed: local.byType.CONTACTS_CHANGED || 0, stored: local.contactRows,
      grantCrypto: local.contactGrantCrypto, payloadCrypto: local.contactPayloadCrypto, failure: contactsFailure,
    },
    overall,
  };
  if (selected) report.selectedThread = {
    aggregateHash: await shortHash(selected.aggregateId), rawEvents: selected.events.length,
    messageCreated: selected.events.filter(event => event.type === "MESSAGE_CREATED").length,
    messageUpdated: selected.events.filter(event => event.type === "MESSAGE_UPDATED").length,
    keyGrantRelated: selected.events.filter(event => event.type === "KEY_GRANT").length,
    decrypted: selected.events.filter(event => event.cryptoVersion === 0 || event.decryption?.state === "decrypted").length,
    locked: selected.events.filter(event => event.decryption?.state === "locked").length,
    invalid: selected.events.filter(event => event.decryption?.state === "invalid").length,
    state: selected.state, firstPageDurationMs: selected.firstPageDurationMs,
    lastPageError: safeError(selected.lastPageError),
  };
  return report;
}

export function formatWebDiagnostics(report: WebDiagnosticReport): string {
  const type = (name: string) => report.indexedDb.byType[name] || 0;
  const reasons = (label: string, values: Record<string, number>) => Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${label} ${reason} ${count}`);
  return [
    "WEB MESSAGE DIAGNOSTICS",
    `Linked session             ${report.session.linked ? "PASS" : "FAIL"}`,
    `API / PWA build            ${report.session.apiVersion} / ${report.session.pwaVersion}${report.session.buildMismatch ? " FAIL" : " PASS"}`,
    `Server max sequence        ${report.server?.maxSequence ?? "unavailable"}`,
    `Browser cursor             ${report.browserSync.cursor}`,
    `Sync lag                   ${report.browserSync.syncLag ?? "unknown"}`,
    `Sync state                 ${report.browserSync.state}`,
    `Projection cursor          ${report.projection.cursor}`,
    `Projection lag             ${report.projection.lag}`,
    `Raw MESSAGE_CREATED        ${type("MESSAGE_CREATED")}`,
    `Raw KEY_GRANT              ${type("KEY_GRANT")}`,
    `Message decrypted          ${report.crypto.messages.decrypted}`,
    `Message locked             ${report.crypto.messages.locked}`,
    `Message invalid            ${report.crypto.messages.invalid}`,
    ...reasons("Message reason", report.crypto.messages.reasons),
    `KEY_GRANT accepted         ${report.crypto.keyGrants.accepted}`,
    ...reasons("KEY_GRANT reason", report.crypto.keyGrants.reasons),
    `Raw message aggregates     ${report.projection.rawMessageAggregates}`,
    `Conversation rows          ${report.projection.rows}`,
    `Contacts grants            ${report.contacts.grants}`,
    `Contacts snapshots         ${report.contacts.snapshots}`,
    `Contacts stored            ${report.contacts.stored}`,
    `Contacts decrypted         ${report.contacts.payloadCrypto.decrypted}`,
    `Contacts locked            ${report.contacts.payloadCrypto.locked}`,
    `Contacts invalid           ${report.contacts.payloadCrypto.invalid}`,
    ...reasons("Contacts reason", report.contacts.payloadCrypto.reasons),
    ...(report.selectedThread ? [`Selected thread            ${report.selectedThread.state} ${report.selectedThread.aggregateHash}`] : []),
    `Overall                    ${report.overall}`,
  ].join("\n");
}
