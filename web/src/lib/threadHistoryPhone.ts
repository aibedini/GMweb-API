/**
 * Two-tier "Load older messages" history.
 *
 * GMweb can only page through rows it ALREADY stores. When that store is
 * exhausted the remaining history lives on the phone, and the only way to get it
 * is to ask Android for exactly one page and then wait for it to replicate back.
 *
 * TWO FACTS THAT MUST NEVER BE CONFLATED:
 *   SERVER_HISTORY_EXHAUSTED  "GMweb currently has no older rows."
 *   PHONE_HISTORY_EXHAUSTED   "Android positively says this thread has no more."
 *
 * The first does NOT imply the second. The server cursor and the phone cursor are
 * therefore SEPARATE values and must never be substituted for one another:
 *   - serverNextCursor comes from encrypted_message_state
 *   - phoneNextBefore is Android's { dateMs, providerId }
 * Putting an Android cursor into the server cursor field (or vice versa) would
 * silently page the wrong history.
 */

export type HistoryState =
  | "IDLE"
  | "LOADING_SERVER"
  | "SERVER_PAGE_LOADED"
  | "SERVER_HISTORY_EXHAUSTED"
  | "PHONE_UNSUPPORTED"
  | "THREAD_MAPPING_UNAVAILABLE"
  | "PHONE_OFFLINE"
  | "REQUESTING_PHONE_HISTORY"
  | "WAITING_PHONE_COMMAND"
  | "WAITING_REPLICATION"
  | "PHONE_PAGE_AVAILABLE"
  | "PHONE_HISTORY_EXHAUSTED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL";

/** Android's keyset cursor. Never mixed with the server cursor. */
export interface PhoneCursor { dateMs: number; providerId: number; }

export interface HistoryMachine {
  state: HistoryState;
  /** Tier 1: opaque cursor from encrypted_message_state. */
  serverNextCursor: string | number | null;
  serverHasMore: boolean;
  /** Decrypted Android Telephony thread id. Absent => we must NOT guess. */
  androidThreadId: number | null;
  /** Tier 2: Android keyset cursor for the NEXT older page. */
  phoneNextBefore: PhoneCursor | null;
  /** true / false / null = unknown. Unknown is NOT false. */
  phoneHasMore: boolean | null;
  phoneHistoryExhausted: boolean;
  activeHistoryRequestId: string | null;
  activeCommandId: string | null;
  publishedCount: number | null;
  lastErrorCode: string | null;
  /** Number of clicks that actually produced a visible page. */
  pagesLoaded: number;
}

export function initialHistoryState(): HistoryMachine {
  return { state: "IDLE", serverNextCursor: null, serverHasMore: false,
    androidThreadId: null, phoneNextBefore: null, phoneHasMore: null,
    phoneHistoryExhausted: false, activeHistoryRequestId: null, activeCommandId: null,
    publishedCount: null, lastErrorCode: null, pagesLoaded: 0 };
}

export interface HistoryContext {
  /** Runtime-advertised command types; the ONLY authority for support. */
  commandTypes: readonly string[];
  /** Whether the Primary phone is presently reachable. */
  phoneOnline: boolean;
}

/**
 * Support is decided from the CURRENT runtime capability, never from an Android
 * version string. An APK that does not advertise the type may still be online
 * and fully functional for everything else.
 */
export function phoneHistorySupported(context: HistoryContext): boolean {
  return context.commandTypes.includes("FETCH_THREAD_HISTORY");
}

/**
 * Load Older must remain visible while the phone may still hold older rows.
 * Hiding it merely because GMweb's own page is exhausted is the bug this model
 * exists to prevent.
 */
export function showLoadOlder(machine: HistoryMachine): boolean {
  if (machine.phoneHistoryExhausted) return false;
  if (machine.serverHasMore) return true;
  // Server tier exhausted: the button stays, because phone history is unknown.
  return !machine.phoneHistoryExhausted;
}

/** True while a click must be ignored: one click, at most one command. */
export function historyBusy(machine: HistoryMachine): boolean {
  return machine.state === "LOADING_SERVER" || machine.state === "REQUESTING_PHONE_HISTORY"
    || machine.state === "WAITING_PHONE_COMMAND" || machine.state === "WAITING_REPLICATION";
}

/** The decision a click resolves to. Exactly one branch always applies. */
export type LoadOlderDecision =
  | { kind: "SERVER_PAGE" }
  | { kind: "REQUEST_PHONE"; androidThreadId: number }
  | { kind: "BUSY" }
  | { kind: "END_OF_HISTORY" }
  | { kind: "UNSUPPORTED" }
  | { kind: "NO_THREAD_MAPPING" }
  | { kind: "PHONE_OFFLINE" };

export function decideLoadOlder(machine: HistoryMachine, context: HistoryContext): LoadOlderDecision {
  if (historyBusy(machine)) return { kind: "BUSY" };
  if (machine.serverHasMore) return { kind: "SERVER_PAGE" };
  if (machine.phoneHistoryExhausted) return { kind: "END_OF_HISTORY" };
  if (!phoneHistorySupported(context)) return { kind: "UNSUPPORTED" };
  if (machine.androidThreadId === null) return { kind: "NO_THREAD_MAPPING" };
  if (!context.phoneOnline) return { kind: "PHONE_OFFLINE" };
  return { kind: "REQUEST_PHONE", androidThreadId: machine.androidThreadId };
}

// ── phone command result ────────────────────────────────────────────────────

export type PhoneHistoryStatus =
  | "ROWS_PUBLISHED"
  | "END_OF_THREAD_HISTORY"
  | "THREAD_NOT_FOUND"
  | "CURSOR_INVALID"
  | "HISTORY_QUERY_FAILED"
  | "EVENT_ENQUEUE_FAILED";

export type PhoneHistoryParse =
  | { ok: true; status: "ROWS_PUBLISHED"; publishedCount: number; hasMore: boolean;
      nextBefore: PhoneCursor | null }
  | { ok: true; status: "END_OF_THREAD_HISTORY" }
  | { ok: false; code: PhoneHistoryStatus }
  | { ok: false; code: "RESULT_UNPARSEABLE" };

function validCursor(value: unknown): PhoneCursor | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { dateMs?: unknown; providerId?: unknown };
  const dateMs = Number(raw.dateMs);
  const providerId = Number(raw.providerId);
  if (!Number.isSafeInteger(dateMs) || !Number.isSafeInteger(providerId)) return null;
  return { dateMs, providerId };
}

/**
 * Strictly validate Android's history command result.
 *
 * A generic command state of COMPLETED is NEVER proof that GMweb now has rows:
 * COMPLETED only means the page was durably placed in Android's replication
 * path. Only ROWS_PUBLISHED (followed by real replication) means data exists.
 */
export function parsePhoneHistoryResult(raw: unknown): PhoneHistoryParse {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return { ok: false, code: "RESULT_UNPARSEABLE" }; }
  }
  if (!value || typeof value !== "object") return { ok: false, code: "RESULT_UNPARSEABLE" };
  const result = value as Record<string, unknown>;
  const status = typeof result.status === "string" ? result.status : null;

  if (status === "END_OF_THREAD_HISTORY") return { ok: true, status };
  if (status === "ROWS_PUBLISHED") {
    const publishedCount = Number(result.publishedCount);
    if (!Number.isSafeInteger(publishedCount) || publishedCount < 0) {
      return { ok: false, code: "RESULT_UNPARSEABLE" };
    }
    // hasMore absent is "unknown", which is represented as true so we never
    // claim the end of history on missing data.
    const hasMore = typeof result.hasMore === "boolean" ? result.hasMore : true;
    return { ok: true, status, publishedCount, hasMore, nextBefore: validCursor(result.nextBefore) };
  }
  const known: PhoneHistoryStatus[] = ["THREAD_NOT_FOUND", "CURSOR_INVALID",
    "HISTORY_QUERY_FAILED", "EVENT_ENQUEUE_FAILED"];
  if (status && (known as string[]).includes(status)) {
    return { ok: false, code: status as PhoneHistoryStatus };
  }
  return { ok: false, code: "RESULT_UNPARSEABLE" };
}

/** Retryable vs terminal classification for each failure code. */
export function failureState(code: string): HistoryState {
  switch (code) {
    case "THREAD_NOT_FOUND":
      // The mapping is stale, NOT the end of history.
      return "THREAD_MAPPING_UNAVAILABLE";
    case "CURSOR_INVALID":
      // A protocol error; retrying the same cursor cannot help.
      return "FAILED_TERMINAL";
    case "HISTORY_QUERY_FAILED":
    case "EVENT_ENQUEUE_FAILED":
    case "RESULT_UNPARSEABLE":
    case "PHONE_HISTORY_PUBLISHED_BUT_NOT_REPLICATED":
    case "PHONE_HISTORY_TIMEOUT":
    case "SERVER_PAGE_FAILED":
      return "FAILED_RETRYABLE";
    default:
      return "FAILED_RETRYABLE";
  }
}

// ── reducers ────────────────────────────────────────────────────────────────

export function onServerPageLoad(machine: HistoryMachine): HistoryMachine {
  return { ...machine, state: "LOADING_SERVER", lastErrorCode: null };
}

/**
 * A server page landed. `hasMore` describes ONLY the server tier.
 * Zero merged rows while the server still claims more is NOT success and is
 * reported as PAGINATION_DUPLICATE_PAGE by assertHistoryMergeProgress.
 */
export function onServerPage(machine: HistoryMachine, page: {
  next: string | number | null; hasMore: boolean; mergedNewCount: number;
}): HistoryMachine {
  const serverHasMore = page.hasMore && page.mergedNewCount > 0;
  return { ...machine,
    state: serverHasMore ? "SERVER_PAGE_LOADED" : "SERVER_HISTORY_EXHAUSTED",
    serverNextCursor: page.next, serverHasMore,
    pagesLoaded: page.mergedNewCount > 0 ? machine.pagesLoaded + 1 : machine.pagesLoaded };
}

export function onThreadMapping(machine: HistoryMachine, androidThreadId: number | null): HistoryMachine {
  return { ...machine, androidThreadId };
}

export function onPhoneRequest(machine: HistoryMachine, requestId: string): HistoryMachine {
  return { ...machine, state: "REQUESTING_PHONE_HISTORY",
    activeHistoryRequestId: requestId, activeCommandId: null, lastErrorCode: null };
}

export function onPhoneCommandAccepted(machine: HistoryMachine, commandId: string): HistoryMachine {
  return { ...machine, state: "WAITING_PHONE_COMMAND", activeCommandId: commandId };
}

/**
 * Apply Android's result.
 *
 * ROWS_PUBLISHED moves to WAITING_REPLICATION — deliberately NOT to success,
 * because the rows are in Android's replication path, not in GMweb yet.
 */
export function onPhoneResult(machine: HistoryMachine, parsed: PhoneHistoryParse): HistoryMachine {
  if (!parsed.ok) {
    return { ...machine, state: failureState(parsed.code), lastErrorCode: parsed.code,
      activeHistoryRequestId: null, activeCommandId: null };
  }
  if (parsed.status === "END_OF_THREAD_HISTORY") {
    // The ONLY positive proof that Android has no more history.
    return { ...machine, state: "PHONE_HISTORY_EXHAUSTED", phoneHistoryExhausted: true,
      phoneHasMore: false, activeHistoryRequestId: null, activeCommandId: null,
      lastErrorCode: null };
  }
  return { ...machine, state: "WAITING_REPLICATION", publishedCount: parsed.publishedCount,
    phoneNextBefore: parsed.nextBefore ?? machine.phoneNextBefore,
    phoneHasMore: parsed.hasMore, lastErrorCode: null };
}

/** Replication observed: new decrypted rows actually arrived for this thread. */
export function onReplication(machine: HistoryMachine, mergedNewCount: number): HistoryMachine {
  if (mergedNewCount <= 0) return machine;
  const exhausted = machine.phoneHasMore === false && machine.publishedCount !== null;
  return { ...machine,
    state: exhausted ? "PHONE_HISTORY_EXHAUSTED" : "PHONE_PAGE_AVAILABLE",
    phoneHistoryExhausted: exhausted,
    pagesLoaded: machine.pagesLoaded + 1,
    activeHistoryRequestId: null, activeCommandId: null, publishedCount: null };
}

/** Published rows never arrived. Honest, retryable — never "no older messages". */
export function onReplicationTimeout(machine: HistoryMachine): HistoryMachine {
  return { ...machine, state: "FAILED_RETRYABLE",
    lastErrorCode: "PHONE_HISTORY_PUBLISHED_BUT_NOT_REPLICATED",
    activeHistoryRequestId: null, activeCommandId: null };
}

export function onHistoryError(machine: HistoryMachine, code: string): HistoryMachine {
  return { ...machine, state: failureState(code), lastErrorCode: code,
    activeHistoryRequestId: null, activeCommandId: null };
}

// ── UI copy ─────────────────────────────────────────────────────────────────

/**
 * Every state maps to a distinct, honest message. "No older messages" is only
 * ever shown for a POSITIVE end-of-history, never for unsupported/offline.
 */
export function historyStateLabel(machine: HistoryMachine, context?: HistoryContext): string {
  switch (machine.state) {
    case "LOADING_SERVER": return "Loading older messages…";
    case "REQUESTING_PHONE_HISTORY": return "Checking phone for older messages…";
    case "WAITING_PHONE_COMMAND": return "Asking your phone for older messages…";
    case "WAITING_REPLICATION":
      return machine.publishedCount
        ? `Loading ${machine.publishedCount} older messages from phone…`
        : "Loading older messages from phone…";
    case "PHONE_HISTORY_EXHAUSTED": return "No older messages";
    case "PHONE_UNSUPPORTED":
      return "More history may exist on your phone, but this Android version cannot fetch it.";
    case "THREAD_MAPPING_UNAVAILABLE":
      return "This conversation is not linked to a phone thread yet. Retry once it syncs.";
    case "PHONE_OFFLINE":
      return "Older messages are on your phone. Reconnect the Primary phone to continue.";
    case "FAILED_TERMINAL": return "Older messages could not be loaded.";
    case "FAILED_RETRYABLE":
      if (machine.lastErrorCode === "PHONE_HISTORY_PUBLISHED_BUT_NOT_REPLICATED") {
        return "Your phone fetched older messages, but they have not synced to GMweb yet.";
      }
      return "Older messages could not be loaded.";
    case "SERVER_HISTORY_EXHAUSTED":
    case "IDLE":
    case "SERVER_PAGE_LOADED":
    case "PHONE_PAGE_AVAILABLE":
    default:
      return context && !phoneHistorySupported(context)
        ? "Older phone history requires a newer Android app."
        : "Load older messages";
  }
}

export function historyErrorRetryable(machine: HistoryMachine): boolean {
  return machine.state === "FAILED_RETRYABLE" || machine.state === "PHONE_OFFLINE"
    || machine.state === "THREAD_MAPPING_UNAVAILABLE";
}
