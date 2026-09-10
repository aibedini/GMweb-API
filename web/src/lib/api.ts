/**
 * Typed client for the GMweb Control Plane API (/api/v1 — TechSpec §51–58).
 * Opaque payloads stay opaque: this layer never opens envelopes (ADR-002;
 * decryption lands in Phase 7 behind the crypto review).
 */

const API = "/api/v1";

export interface SyncEvent {
  sequence: number;
  eventId: string;
  type: string;
  aggregateId: string | null;
  messageId?: string | null;
  revision?: number;
  sortKey?: number;
  sourceDeviceId: string | null;
  /** base64 opaque envelope bytes — NOT decoded here (Phase 7). */
  ciphertext: string;
  encoding: string;
  schemaVersion: number;
  cryptoVersion: number;
  createdAt: number;
}

export interface SyncPage {
  events: SyncEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export interface EncryptedConversationState {
  conversationId: string;
  tombstone?: boolean;
  revision: number;
  sortKey: number;
  envelope: string;
  encoding: string;
  schemaVersion: number;
  cryptoVersion: number;
  lastServerSequence: number;
}

export interface EncryptedMessageState extends EncryptedConversationState {
  messageId: string;
  type: string;
  tombstone: boolean;
}

export interface WebBootstrapPage {
  protocolVersion: number;
  snapshotVersion: number;
  highWatermark: number;
  conversations: EncryptedConversationState[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TrustSnapshot {
  accountId: string;
  trustSequence: number;
  rootPublicKey: string;
  snapshot: unknown;
  updatedAt: number;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** §54 cursor sync — one page of events after `cursor`. Linked-session cookie auth. */
export async function fetchEventsAfter(cursor: number, limit = 500): Promise<SyncPage> {
  const res = await fetch(`${API}/sync?after=${cursor}&limit=${limit}`, { credentials: "include" });
  return jsonOrThrow<SyncPage>(res);
}

export async function fetchWebBootstrap(limit = 100): Promise<WebBootstrapPage> {
  const res = await fetch(`${API}/web/bootstrap?limit=${limit}`, { credentials: "include", cache: "no-store" });
  return jsonOrThrow<WebBootstrapPage>(res);
}

export async function fetchWebConversationPage(cursor?: string, limit = 100) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  const res = await fetch(`${API}/web/conversations?${query}`,
    { credentials: "include", cache: "no-store" });
  return jsonOrThrow<{ conversations: EncryptedConversationState[]; nextCursor: string | null; hasMore: boolean }>(res);
}

export async function fetchWebMessagePage(conversationId: string, before?: string, limit = 50) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  const res = await fetch(`${API}/web/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
    { credentials: "include", cache: "no-store" });
  return jsonOrThrow<{ messages: EncryptedMessageState[]; nextCursor: string | null; hasMore: boolean }>(res);
}

/** Read only opaque grant envelopes ahead of the main cursor during initial recovery. */
export async function fetchKeyGrantsAfter(cursor: number, limit = 1000): Promise<SyncPage> {
  const res = await fetch(`${API}/linked-device/key-grants?after=${cursor}&limit=${limit}`, { credentials: "include" });
  return jsonOrThrow<SyncPage>(res);
}

/** Browser-bound v2 capability keys and v3 history key, outside the message cursor. */
export async function fetchKeyring(limit = 1000): Promise<SyncPage> {
  const res = await fetch(`${API}/linked-device/keyring?limit=${limit}`, { credentials: "include" });
  return jsonOrThrow<SyncPage>(res);
}

/** §58 command status poll — used for optimistic outgoing bubbles. */
export async function fetchCommand(id: string): Promise<CommandView | null> {
  const res = await fetch(`${API}/commands/${encodeURIComponent(id)}`, { credentials: "include" });
  if (res.status === 404) return null;
  return jsonOrThrow<CommandView>(res);
}

export interface CommandView {
  id: string;
  type: string;
  state: string;
  createdAt: number;
  acceptedAt: number | null;
  completedAt: number | null;
  result: string | null;
}

/** §51/§52 trust snapshot — who is approved, per Android's signature. */
export async function fetchTrustSnapshot(): Promise<TrustSnapshot | null> {
  const res = await fetch(`${API}/trust/snapshot`, { credentials: "include" });
  if (res.status === 404) return null;
  return jsonOrThrow<TrustSnapshot>(res);
}

export async function health(): Promise<{ ok: boolean; version: string }> {
  const res = await fetch("/health");
  return jsonOrThrow<{ ok: boolean; version: string }>(res);
}

export async function fetchPrimaryCommandKey(): Promise<{ deviceId: string; encryptionPublicKey: string }> {
  const res = await fetch(`${API}/linked-device/command-key`, { credentials: "include" });
  return jsonOrThrow(res);
}

export async function createCommand(body: {
  type: "SEND_SMS" | "MARK_THREAD_READ";
  payload: string;
  idempotencyKey: string;
}): Promise<{ commandId: string; state: string; created: boolean }> {
  const res = await fetch(`${API}/commands`, {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1 }),
  });
  return jsonOrThrow(res);
}

export interface DeviceTelemetry {
  timestamp: number;
  receivedAt: number;
  battery?: { level?: number; isCharging?: boolean; chargingSource?: string };
  sync?: { outboxDepth?: number; deadLetterCount?: number; trustOutboxDepth?: number };
  network?: { isConnected?: boolean; networkType?: string };
  trust?: { approvedDevicesCount?: number; trustSequence?: number };
  app?: { versionName?: string; versionCode?: number; uptimeMs?: number };
  device?: { manufacturer?: string; model?: string; androidVersion?: string };
}

export async function fetchPrimaryTelemetry(): Promise<DeviceTelemetry | null> {
  const res = await fetch(`${API}/linked-device/telemetry`, { credentials: "include" });
  return (await jsonOrThrow<{ telemetry: DeviceTelemetry | null }>(res)).telemetry;
}

export interface ServerSyncDiagnostics {
  total: number;
  maxSequence: number;
  countsByType: Array<{ type: string; count: number }>;
  countsByCryptoVersion: Array<{ cryptoVersion: number; count: number }>;
  distinctAggregateCount: number;
  nullAggregateCount: number;
}

export async function fetchSyncDiagnostics(): Promise<ServerSyncDiagnostics> {
  const res = await fetch(`${API}/linked-device/sync-diagnostics`, { credentials: "include" });
  return jsonOrThrow<ServerSyncDiagnostics>(res);
}
