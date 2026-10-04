/**
 * Pure binary/text helpers shared by the crypto modules.
 *
 * Extracted from `messageCrypto.ts` so that `commandCrypto.ts` no longer pulls
 * in the HPKE suite and device-key storage just to encrypt a command. That
 * dependency is what made the command-encryption path impossible to test in
 * isolation — which is how a raw-vs-SPKI recipient-key mismatch shipped.
 */

const encoder = new TextEncoder();

export function b64(value: Uint8Array): string {
  return btoa(Array.from(value, b => String.fromCharCode(b)).join(""));
}

export function unb64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

/** Domain-separated AEAD binding, byte-identical to the Android construction. */
export function binding(domain: string, ...fields: string[]): Uint8Array<ArrayBuffer> {
  return encoder.encode([domain, ...fields.map(v => b64(encoder.encode(v)))].join("\n"));
}

export { encoder };
