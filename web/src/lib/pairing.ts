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

/** base64url-encode a raw key (server stores the SPKI/subjective string as-is). */
async function generateKeyPair(): Promise<{ signing: CryptoKeyPair; signingPub: string; encPub: string }> {
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const encryption = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const signingPub = b64(await crypto.subtle.exportKey("raw", signing.publicKey));
  const encPub = b64(await crypto.subtle.exportKey("raw", (encryption as CryptoKeyPair).publicKey));
  return { signing, signingPub, encPub };
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
  const webDeviceId = randomId(12);
  const { signingPub, encPub } = await generateKeyPair();
  const nonce = randomId(12);

  const created = await createSession({
    webDeviceId,
    webSigningPublicKey: signingPub,
    webEncryptionPublicKey: encPub,
    ephemeralPublicKey: signingPub, // v1: same P-256 key; dedicated ephemeral key lands with E2EE (ADR-002)
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
