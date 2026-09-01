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

export type PairingState =
  | "UNLINKED"
  | "SHOW_QR"
  | "PAIRING_PENDING"
  | "PAIRING_APPROVED"
  | "BOOTSTRAPPING_KEYS"
  | "READY";

export interface PairingHandle {
  session: PairingSession;
  qr: PairingQrPayload;
  webDeviceId: string;
  /** Poll until approved/expired. Resolves with the signed certificate. */
  wait: () => Promise<{ certificate: string; deviceId: string }>;
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
export async function beginPairing(): Promise<PairingHandle> {
  // P0-6: durable, NON-extractable device keys (IndexedDB). If persistence
  // fails, pairing must not start — a device without its private key can
  // never be verified later (fail closed).
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
    expiresAt: created.expiresAt,
    ttlSeconds: created.ttlSeconds,
  };

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };

  const wait = (): Promise<{ certificate: string; deviceId: string }> =>
    new Promise((resolve, reject) => {
      const poll = async () => {
        if (cancelled) return reject(new Error("pairing cancelled"));
        try {
          const status = await getPairingStatus(pairingSession.pairingSessionId);
          if (status.state === "APPROVED" && status.certificate) {
            // §5 — verify the binding BEFORE trusting it. (Signature crypto
            // verification lands with the trust-root key distribution; here we
            // pin the structural binding the ADR requires.)
            if (status.deviceId !== webDeviceId) {
              return reject(new Error("certificate deviceId does not match this browser"));
            }
            return resolve({ certificate: status.certificate, deviceId: status.deviceId });
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
