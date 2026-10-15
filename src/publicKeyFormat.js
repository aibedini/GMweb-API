"use strict";

/**
 * P-256 public-key wire formats.
 *
 * Backwards-compatibility bug this centralises (production, confirmed):
 * Android v3.4.x registers keys as **DER SubjectPublicKeyInfo** (`toSpkiB64`),
 * but `web/src/lib/commandCrypto.ts` imported the command key with
 * WebCrypto `"raw"`, which expects an uncompressed point (`0x04||X||Y`).
 * The browser therefore threw `DataError: Invalid keyData` and the composer
 * reported "Could not encrypt this message."
 *
 * `agentAuth.js` had already handled BOTH formats for the SIGNING key — the
 * migration was simply only half applied. This module gives both paths one
 * implementation and lets the wire carry an explicit format so nobody has to
 * guess from byte length ever again.
 */

/** The fixed SPKI header for a P-256 uncompressed public key. */
const SPKI_P256_PREFIX = "3059301306072a8648ce3d020106082a8648ce3d030107034200";

const RAW_P256_LENGTH = 65;
const SPKI_P256_LENGTH = 91;

/** Wraps a raw `0x04||X||Y` point into a DER SPKI buffer. */
function toSpkiDer(rawPoint) {
  return Buffer.concat([Buffer.from(SPKI_P256_PREFIX, "hex"), rawPoint]);
}

/**
 * Detect the wire format of a base64 P-256 public key.
 *
 * @returns {{ok: true, format: "spki-p256"|"raw-p256", bytes: Buffer}
 *          | {ok: false, error: string, bytes: Buffer|null}}
 */
function classifyPublicKey(base64) {
  if (typeof base64 !== "string" || !base64) {
    return { ok: false, error: "empty_key", bytes: null };
  }
  let bytes;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return { ok: false, error: "invalid_base64", bytes: null };
  }
  if (bytes.length === 0) return { ok: false, error: "empty_key", bytes: null };

  if (bytes.length === RAW_P256_LENGTH && bytes[0] === 0x04) {
    return { ok: true, format: "raw-p256", bytes };
  }
  if (bytes.length === SPKI_P256_LENGTH && bytes.toString("hex").startsWith(SPKI_P256_PREFIX)) {
    return { ok: true, format: "spki-p256", bytes };
  }
  // A DER-looking blob for the wrong curve/algorithm is distinguishable from
  // random junk, and both must be rejected rather than silently accepted.
  if (bytes[0] === 0x30) return { ok: false, error: "unsupported_der_spki", bytes };
  if (bytes[0] === 0x04) return { ok: false, error: "invalid_point_length", bytes };
  return { ok: false, error: "unrecognised_key_format", bytes };
}

module.exports = {
  SPKI_P256_PREFIX,
  RAW_P256_LENGTH,
  SPKI_P256_LENGTH,
  toSpkiDer,
  classifyPublicKey,
};
