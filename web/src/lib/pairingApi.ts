/**
 * ADR-007 — pairing HTTP surface (mirrors GMweb /api/v1/pairing/*).
 */

export interface PairingSession {
  pairingSessionId: string;
  pollSecret: string;
  expiresAt: number;
  ttlSeconds: number;
}

export interface PairingQrPayload {
  version: number;
  protocol: string;
  apiOrigin: string;
  webOrigin: string;
  transcriptHash: string;
  pairingSessionId: string;
  webDeviceId: string;
  webSigningPublicKey: string;
  webEncryptionPublicKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  origin: string;
  expiresAt: number;
  /** Present only when the creating browser has dashboard/admin authority. */
}

export interface CreateSessionResponse extends PairingSession {
  qr: PairingQrPayload;
}

export type PairingStatus =
  | { state: "PENDING"; expiresAt: number }
  | { state: "EXPIRED" }
  | { state: "APPROVED"; certificate: string; deviceId: string; transcriptHash: string; trustRootPublicKey: string; approvedAt: number };

export async function createSession(transcript: {
  webDeviceId: string;
  webSigningPublicKey: string;
  webEncryptionPublicKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  origin?: string;
}): Promise<CreateSessionResponse> {
  const res = await fetch("/api/v1/pairing/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(transcript),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `session HTTP ${res.status}`);
  }
  return res.json();
}

export async function getPairingStatus(
  pairingSessionId: string,
  pollSecret: string,
): Promise<PairingStatus> {
  const res = await fetch(
    `/api/v1/pairing/status?pairingSessionId=${encodeURIComponent(pairingSessionId)}&pollSecret=${encodeURIComponent(pollSecret)}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `status HTTP ${res.status}`);
  }
  return res.json();
}
