export const DB_NAME = "gmweb-messages";
export const DB_VERSION = 7;
export const STORE_EVENTS = "events";
export const STORE_META = "meta";
export const STORE_CONTACTS = "contacts";
export const CURSOR_KEY = "sync_cursor";
/** Derived read-model store (PWA projection). Raw events stay the truth. */
export const STORE_CONVERSATIONS = "conversations";
export const STORE_ENCRYPTED_CONVERSATIONS = "encrypted_conversation_state";
export const STORE_ENCRYPTED_MESSAGES = "encrypted_message_state";
export const PROJECTION_VERSION_KEY = "conversation_projection_version";
export const PROJECTION_CURSOR_KEY = "conversation_projection_cursor";
export const REPLICA_GENERATION_KEY = "replica_generation";
export const SNAPSHOT_VERSION_KEY = "snapshot_version";
export const SNAPSHOT_TOKEN_KEY = "snapshot_token_v2";
export const SNAPSHOT_CURSOR_KEY = "snapshot_cursor_v2";
export const SNAPSHOT_BASELINE_KEY = "snapshot_baseline_v2";
export const SNAPSHOT_COMPLETE_KEY = "snapshot_complete_v2";
export const SNAPSHOT_STARTED_AT_KEY = "snapshot_started_at_v2";
export const SNAPSHOT_LAST_PAGE_AT_KEY = "snapshot_last_page_at_v2";
export const SNAPSHOT_LAST_PAGE_MS_KEY = "snapshot_last_page_ms_v2";
export const SNAPSHOT_PAGE_COUNT_KEY = "snapshot_page_count_v2";
export const SNAPSHOT_POSITION_KEY = "snapshot_position_v2";
export const REPLICA_MIGRATION_VERSION_KEY = "replica_migration_version";
export const RECONSTRUCTABLE_STATE_EVENTS = new Set([
  "MESSAGE_CREATED", "MESSAGE_UPDATED", "MESSAGE_STATUS_CHANGED", "MESSAGE_DELETED",
  "CONVERSATION_UPSERT", "CONVERSATION_UPSERTED", "CONVERSATION_DELETED", "THREAD_READ",
]);
