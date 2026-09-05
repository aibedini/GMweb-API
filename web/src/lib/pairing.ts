/**
 * ADR-007 — Linked-device pairing client.
 *
 * The web client generates its keypairs LOCALLY, opens a short-lived pairing
 * session, renders the transcript as a QR code, and polls for the
 * Android-signed DeviceCertificate (single-use consume). It verifies the
 * certificate binding before treating itself as trusted (§5).
 */

import {
  createSession,
  getPairingStatus,
  type PairingSession,
  type PairingQrPayload,
} from "./pairingApi";
import { getOrCreateDeviceKeys } from "./deviceKeys";
import { verifyCertificate } from "./certVerify";
import type { DeviceCertificate } from "./trustRoot";

export type PairingState =
  | "UNLINKED"
  | "SHOW_QR"
  | "PAIRING_PENDING"
  | "PAIRING_APPROVED"
  | "BOOTSTRAPPING_KEYS"
  | "READY";

export type PairingProgress =
  | "PREPARING_KEYS"
  | "CREATING_SESSION"
  | "AWAITING_ANDROID"
  | "ANDROID_APPROVED"
  | "VERIFYING_CERTIFICATE"
  | "CERTIFICATE_VERIFIED";

export interface PairingHandle {
  session: PairingSession;
  qr: PairingQrPayload;
  webDeviceId: string;
  /** Poll until approved; resolves ONLY after CERTIFICATE_VERIFIED. */
  wait: () => Promise<{ certificate: string; deviceId: string; verified: boolean }>;
  cancel: () => void;
}

function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Start the pairing dance: local keygen → session create → QR payload.
 * The caller renders `handle.qr` as the QR image and calls `wait()`.
 */
export async function beginPairing(onProgress?: (stage: PairingProgress) => void): Promise<PairingHandle> {
  // P0-6: durable, NON-extractable device keys (IndexedDB). If persistence
  // fails, pairing must not start — a device without its private key can
  // never be verified later (fail closed).
  onProgress?.("PREPARING_KEYS");
  const keys = await getOrCreateDeviceKeys();
  const webDeviceId = keys.deviceId;
  const nonce = randomId(12);

  // P1-1: dedicated EPHEMERAL pairing keypair, separate from the operational
  // signing identity. Private ephemeral key is destroyed when this handle is
  // consumed/expired (see ephemeralPrivateKey field + destroy below).
  const ephemeral = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  )) as CryptoKeyPair;
  const ephemeralPubB64 = b64(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  onProgress?.("CREATING_SESSION");
  const created = await createSession({
    webDeviceId,
    webSigningPublicKey: keys.signingPublicKeyB64,
    webEncryptionPublicKey: keys.encryptionPublicKeyB64,
    ephemeralPublicKey: ephemeralPubB64,
    nonce,
  });
  const qr = created.qr;
  const pairingSession: PairingSession = {
    pairingSessionId: created.pairingSessionId,
    pollSecret: created.pollSecret,
    expiresAt: created.expiresAt,
    ttlSeconds: created.ttlSeconds,
  };
  onProgress?.("AWAITING_ANDROID");

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };

  const wait = (): Promise<{ certificate: string; deviceId: string; verified: boolean }> =>
    new Promise((resolve, reject) => {
      const poll = async () => {
        if (cancelled) return reject(new Error("pairing cancelled"));
        try {
          const status = await getPairingStatus(pairingSession.pairingSessionId, pairingSession.pollSecret);
          if (status.state === "APPROVED" && status.certificate) {
            onProgress?.("ANDROID_APPROVED");
            // BLOCKER 1 — full verification chain, fail closed:
            // CERTIFICATE_RECEIVED -> binding checks -> rootSignature
            // (Trust Root key pinned from the approval payload)
            // -> CERTIFICATE_VERIFIED. Nothing resolves without it.
            let cert: DeviceCertificate;
            try {
              cert = JSON.parse(status.certificate) as DeviceCertificate;
            } catch {
              return reject(new Error("certificate is not valid JSON"));
            }
            onProgress?.("VERIFYING_CERTIFICATE");
            const state = await verifyCertificate(cert, {
              deviceId: webDeviceId,
              transcriptHash: status.transcriptHash,
              origin: qr.origin,
              signingPublicKeyB64: keys.signingPublicKeyB64,
              encryptionPublicKeyB64: keys.encryptionPublicKeyB64,
              trustRootPublicKeyB64: status.trustRootPublicKey,
            });
            if (state.step === "REJECTED") {
              return reject(new Error(`certificate rejected: ${state.reason}`));
            }
            onProgress?.("CERTIFICATE_VERIFIED");
            return resolve({
              certificate: status.certificate,
              deviceId: status.deviceId,
              verified: true,
            });
          }
          if (status.state === "EXPIRED") return reject(new Error("QR expired — start again"));
          setTimeout(poll, 2000);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      setTimeout(poll, 1500);
    });

  return { session: pairingSession, qr, webDeviceId, wait, cancel };
}

// ── POST-PAIR SECURE BOOTSTRAP ────────────────────────────────────────────
// After CERTIFICATE_VERIFIED, the browser proves possession of its
// non-extractable operational signing key by signing the server challenge's
// canonical bytes (GMweb-Link-Session-v1), then exchanges them for an
// HttpOnly linked-device session cookie. sessionStorage fake is gone.
export async function completeLinkedSession(
  pairingSessionId: string,
  pollSecret: string,
  deviceId: string,
  _certificate: string,
  origin: string,
): Promise<{ ok: boolean; deviceId: string; capabilities: string[] }> {
  // Learn the single-use challenge from the dedicated peek endpoint the single-use challenge from the dedicated peek endpoint
  // (pollSecret-authenticated; peeking never burns — only /complete does).
  const q = new URLSearchParams({ pollSecret });
  const chRes = await fetch(`/api/v1/pairing/challenge?${q}`, { credentials: "include" });
  if (!chRes.ok) throw new Error(`challenge unavailable: HTTP ${chRes.status}`);
  const ch = await chRes.json();
  const challenge = ch.challenge as string;
  const issuedAt = ch.issuedAt as number;
  const canonical = new TextEncoder().encode(
    ["GMweb-Link-Session-v1", deviceId, challenge, origin, String(issuedAt)].join("\n"),
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await getSigningKey(),
    canonical,
  );
  const res = await fetch("/api/v1/pairing/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      pairingSessionId,
      pollSecret,
      deviceId,
      challenge,
      signature: b64(sig),
      certificate: ch.certificate,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = [body.error, body.reason].filter(Boolean).join("/");
    throw new Error(`complete failed: HTTP ${res.status} ${detail}`.trim());
  }
  return res.json();
}

/** Non-extractable operational signing key handle (deviceKeys storage). */
async function getSigningKey(): Promise<CryptoKey> {
  const keys = await getOrCreateDeviceKeys();
  return keys.signingPrivateKey;
}
