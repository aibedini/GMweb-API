export const CONTENT_CRYPTO_VERSIONS: Readonly<Record<string, readonly number[]>> = {
  MESSAGE_CREATED: [1, 2, 3],
  MESSAGE_UPDATED: [1, 2, 3],
  MESSAGE_STATUS_CHANGED: [1, 2, 3],
  MESSAGE_DELETED: [1, 2, 3],
  CONVERSATION_UPSERT: [3],
  CONVERSATION_UPSERTED: [3],
  CONVERSATION_DELETED: [3],
  THREAD_READ: [1, 2, 3],
  CONTACTS_SNAPSHOT: [1, 2],
  CONTACTS_CHANGED: [1, 2],
};

export const KEY_CRYPTO_VERSIONS: Readonly<Record<string, readonly number[]>> = {
  KEY_GRANT: [1],
  CONTACTS_KEY_GRANT: [1],
  KEYRING_ENTRY: [2],
  HISTORY_KEY_GRANT: [3],
};

export function isContentBearingEvent(type: string): boolean {
  return Object.hasOwn(CONTENT_CRYPTO_VERSIONS, type);
}

export function acceptsContentCrypto(type: string, cryptoVersion: number): boolean {
  return CONTENT_CRYPTO_VERSIONS[type]?.includes(cryptoVersion) === true;
}

export function assertSupportedContentEvent(event: { type: string; cryptoVersion: number }): void {
  if (isContentBearingEvent(event.type) && !acceptsContentCrypto(event.type, event.cryptoVersion)) {
    throw new Error("Unsupported encrypted content event");
  }
}
