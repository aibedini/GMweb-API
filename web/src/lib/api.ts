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

/** §54 cursor sync — one page of events after `cursor`. */
export async function fetchEventsAfter(cursor: number, limit = 500): Promise<SyncPage> {
  const res = await fetch(`${API}/sync?after=${cursor}&limit=${limit}`);
  return jsonOrThrow<SyncPage>(res);
}

/** §58 command status poll — used for optimistic outgoing bubbles. */
export async function fetchCommand(id: string): Promise<CommandView | null> {
  const res = await fetch(`${API}/commands/${encodeURIComponent(id)}`);
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
  const res = await fetch(`${API}/trust/snapshot`);
  if (res.status === 404) return null;
  return jsonOrThrow<TrustSnapshot>(res);
}

export async function health(): Promise<{ ok: boolean; version: string }> {
  const res = await fetch("/health");
  return jsonOrThrow<{ ok: boolean; version: string }>(res);
}
