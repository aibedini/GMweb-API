/**
 * Read-state synchronisation.
 *
 * Two facts are genuinely different and were previously conflated into one
 * human string:
 *
 *   - the Web UI has marked the thread read (optimistic, instant)
 *   - the Primary phone has confirmed it (authoritative, asynchronous)
 *
 * Local read must win IMMEDIATELY so opening an unread conversation behaves
 * like a messaging app; the phone round-trip then refines the status. Logic
 * branches on `state`, never on rendered copy.
 */

export type ReadSyncState =
  | { state: "IDLE" }
  /** Cleared in the UI; no command issued yet. */
  | { state: "READ_LOCAL"; sequence: number }
  /** Command being created/encrypted. */
  | { state: "SYNCING"; sequence: number; commandId: string | null }
  /** Command durable; the phone has not confirmed. */
  | { state: "WAITING_FOR_PHONE"; sequence: number; commandId: string }
  /** Authoritative confirmation from the phone. */
  | { state: "CONFIRMED"; sequence: number }
  | { state: "FAILED"; sequence: number; errorCode: string; commandId: string | null };

export const IDLE_READ: ReadSyncState = { state: "IDLE" };

/**
 * Deduplication key. One in-flight command per
 * (conversation, readThroughSequence) — rapidly opening/closing/switching
 * threads must never create a command storm.
 */
export function readStateKey(aggregateId: string, sequence: number): string {
  return `${aggregateId}:${sequence}`;
}

/** Short, contextual copy. Failures are the only state that deserves an alarm. */
export function readSyncLabel(state: ReadSyncState): string | null {
  switch (state.state) {
    case "IDLE": return null;
    case "READ_LOCAL": return "Read locally";
    case "SYNCING": return "Read · syncing to phone";
    case "WAITING_FOR_PHONE": return "Read · waiting for phone";
    case "CONFIRMED": return "Read";
    case "FAILED": return "Read sync failed";
  }
}

export function readSyncTone(state: ReadSyncState): "none" | "muted" | "ok" | "failed" {
  switch (state.state) {
    case "IDLE": return "none";
    case "CONFIRMED": return "ok";
    case "FAILED": return "failed";
    default: return "muted";
  }
}

export function readSyncRetryable(state: ReadSyncState): boolean {
  return state.state === "FAILED";
}

/**
 * §12.1: auto-read is only allowed when the user can actually be said to have
 * read the thread. Every condition must hold.
 */
export function shouldAutoRead(input: {
  tabActive: boolean;
  hasSelection: boolean;
  threadReady: boolean;
  readyThreadIdMatches: boolean;
  documentVisible: boolean;
  canMarkRead: boolean;
  lastSequence: number;
  confirmedSequence: number;
  alreadyInFlight: boolean;
}): boolean {
  if (input.alreadyInFlight) return false;
  if (!input.tabActive) return false;
  if (!input.hasSelection) return false;
  if (!input.canMarkRead) return false;
  if (!input.documentVisible) return false;
  if (!input.threadReady || !input.readyThreadIdMatches) return false;
  return input.lastSequence > input.confirmedSequence;
}

/**
 * §9/§23: distinguish "the phone is simply not reachable yet" from a real
 * failure, without inventing success.
 */
export function readFailureCode(cause: unknown): string {
  const value = cause instanceof Error
    ? cause.message
    : typeof cause === "string" && cause
      ? cause
      : "";
  if (!value) return "READ_FAILED";
  if (/offline|unreachable|not connected/i.test(value)) return "PHONE_OFFLINE";
  if (/expired/i.test(value)) return "READ_EXPIRED";
  if (/read_pending/i.test(value)) return "READ_PHONE_PENDING";
  return value;
}
