import { b64, binding, unb64 } from "./binary.ts";

/** Where in the crypto pipeline a failure happened. */
export type CommandCryptoStage =
  | "FETCH_COMMAND_KEY"
  | "IMPORT_RECIPIENT_KEY"
  | "GENERATE_EPHEMERAL"
  | "ECDH_DERIVE"
  | "HKDF_DERIVE"
  | "AES_GCM_ENCRYPT"
  | "EXPORT_EPHEMERAL";

export type CommandCryptoErrorCode =
  | "COMMAND_KEY_UNAVAILABLE"
  | "COMMAND_KEY_INVALID"
  | "COMMAND_KEY_FORMAT_UNSUPPORTED"
  | "COMMAND_CRYPTO_IMPORT_FAILED"
  | "COMMAND_CRYPTO_FAILED";

const USER_COPY: Record<CommandCryptoErrorCode, string> = {
  COMMAND_KEY_UNAVAILABLE: "Phone encryption key is unavailable.",
  COMMAND_KEY_INVALID: "Phone encryption key is invalid. Reconnect the Primary phone.",
  COMMAND_KEY_FORMAT_UNSUPPORTED: "Phone encryption key format is not supported. Update Messages and retry.",
  COMMAND_CRYPTO_IMPORT_FAILED: "Could not securely prepare this message.",
  COMMAND_CRYPTO_FAILED: "Could not securely prepare this message.",
};

/**
 * A crypto failure that carries a machine-readable code plus safe diagnostics.
 *
 * Deliberately excludes the message body, any key material, the ciphertext and
 * the recipient number: this object is safe to log and to show in diagnostics.
 */
export class CommandCryptoError extends Error {
  readonly code: CommandCryptoErrorCode;
  readonly stage: CommandCryptoStage;
  readonly errorName: string | null;
  readonly format: string | null;
  readonly decodedLength: number | null;

  constructor(input: {
    code: CommandCryptoErrorCode;
    stage: CommandCryptoStage;
    errorName?: string | null;
    format?: string | null;
    decodedLength?: number | null;
  }) {
    super(USER_COPY[input.code]);
    this.name = "CommandCryptoError";
    this.code = input.code;
    this.stage = input.stage;
    this.errorName = input.errorName ?? null;
    this.format = input.format ?? null;
    this.decodedLength = input.decodedLength ?? null;
  }

  /** Safe, greppable diagnostic line. Never contains secrets. */
  diagnostics(): string {
    const parts = [`code=${this.code}`, `stage=${this.stage}`];
    if (this.format) parts.push(`format=${this.format}`);
    if (this.decodedLength !== null) parts.push(`decodedLength=${this.decodedLength}`);
    if (this.errorName) parts.push(`error=${this.errorName}`);
    return parts.join(" ");
  }
}

export type CommandPublicKeyFormat = "spki-p256" | "raw-p256";

const RAW_P256_LENGTH = 65;
const SPKI_P256_LENGTH = 91;

function detectFormat(bytes: Uint8Array): CommandPublicKeyFormat | "unknown" {
  if (bytes.length === RAW_P256_LENGTH && bytes[0] === 0x04) return "raw-p256";
  // 0x30 = DER SEQUENCE, i.e. SubjectPublicKeyInfo.
  if (bytes.length === SPKI_P256_LENGTH && bytes[0] === 0x30) return "spki-p256";
  return "unknown";
}

/**
 * Import the phone's command encryption public key.
 *
 * Android registers this as DER SPKI (`toSpkiB64`), so SPKI is the canonical
 * current format. Raw uncompressed points are still accepted so previously
 * enrolled devices keep working — the signing-key path in `agentAuth.js` has
 * accepted both since the same migration.
 */
export async function importCommandPublicKey(
  publicKeyB64: string,
  format?: CommandPublicKeyFormat | null,
): Promise<CryptoKey> {
  // IIFE so the inferred (non-widened) Uint8Array type survives for WebCrypto.
  const bytes = (() => {
    try {
      return unb64(publicKeyB64);
    } catch (cause) {
      throw new CommandCryptoError({
        code: "COMMAND_KEY_INVALID", stage: "IMPORT_RECIPIENT_KEY",
        errorName: cause instanceof Error ? cause.name : null,
      });
    }
  })();
  if (bytes.length === 0) {
    throw new CommandCryptoError({ code: "COMMAND_KEY_UNAVAILABLE", stage: "IMPORT_RECIPIENT_KEY" });
  }

  const declared = format === "spki-p256" || format === "raw-p256" ? format : null;
  const detected = detectFormat(bytes);
  // Explicit format wins; absent format falls back to sniffing for
  // backward compatibility with servers that do not send one.
  const effective = declared ?? (detected === "unknown" ? null : detected);

  if (!effective) {
    throw new CommandCryptoError({
      code: "COMMAND_KEY_FORMAT_UNSUPPORTED", stage: "IMPORT_RECIPIENT_KEY",
      format: detected, decodedLength: bytes.length,
    });
  }
  // A declared format that contradicts the bytes is a protocol error, not
  // something to silently work around.
  if (declared && detected !== "unknown" && declared !== detected) {
    throw new CommandCryptoError({
      code: "COMMAND_KEY_INVALID", stage: "IMPORT_RECIPIENT_KEY",
      format: `${declared}/${detected}`, decodedLength: bytes.length,
    });
  }

  try {
    return await crypto.subtle.importKey(
      effective === "spki-p256" ? "spki" : "raw",
      bytes,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch (cause) {
    throw new CommandCryptoError({
      code: "COMMAND_CRYPTO_IMPORT_FAILED", stage: "IMPORT_RECIPIENT_KEY",
      format: effective, decodedLength: bytes.length,
      errorName: cause instanceof Error ? cause.name : null,
    });
  }
}

function wrap(cause: unknown, stage: CommandCryptoStage, code: CommandCryptoErrorCode = "COMMAND_CRYPTO_FAILED") {
  if (cause instanceof CommandCryptoError) return cause;
  return new CommandCryptoError({ code, stage, errorName: cause instanceof Error ? cause.name : null });
}

/**
 * Encrypt a command to Android's non-exportable operational ECDH key.
 *
 * The envelope format is unchanged (`v`, `kind`, `ephemeralPublicKey` as a RAW
 * uncompressed point, `iv`, `ciphertext`) — only the RECIPIENT key import was
 * wrong, and only that is fixed here.
 */
export async function encryptCommand(
  publicKeyB64: string,
  type: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  format?: CommandPublicKeyFormat | null,
): Promise<string> {
  const recipient = await importCommandPublicKey(publicKeyB64, format);
  let ephemeral: CryptoKeyPair;
  try {
    ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  } catch (cause) {
    throw wrap(cause, "GENERATE_EPHEMERAL");
  }

  const shared = await (async () => {
    try {
      return new Uint8Array(await crypto.subtle.deriveBits(
        { name: "ECDH", public: recipient }, ephemeral.privateKey, 256,
      ));
    } catch (cause) {
      throw wrap(cause, "ECDH_DERIVE");
    }
  })();

  const aad = binding("GMweb-command-v1", type, idempotencyKey);
  let key: CryptoKey;
  try {
    const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    shared.fill(0);
    key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: aad },
      material, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
    );
  } catch (cause) {
    shared.fill(0);
    throw wrap(cause, "HKDF_DERIVE");
  }

  let ephemeralPublicKey: Uint8Array;
  try {
    ephemeralPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  } catch (cause) {
    throw wrap(cause, "EXPORT_EPHEMERAL");
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  let ciphertext: Uint8Array;
  try {
    ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      key, new TextEncoder().encode(JSON.stringify(payload)),
    ));
  } catch (cause) {
    throw wrap(cause, "AES_GCM_ENCRYPT");
  }

  const envelope = { v: 1, kind: "command", ephemeralPublicKey: b64(ephemeralPublicKey), iv: b64(iv), ciphertext: b64(ciphertext) };
  return b64(new TextEncoder().encode(JSON.stringify(envelope)));
}
