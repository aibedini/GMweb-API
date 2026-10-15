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
  /** Building the encrypted MARK_THREAD_READ command. */
  | { state: "PREPARING_COMMAND"; sequence: number }
  /** Durable on the server, not yet delivered to the phone. */
  | { state: "QUEUED"; sequence: number; commandId: string }
  /** The phone has the command; still pending. */
  | { state: "WAITING_FOR_PHONE"; sequence: number; commandId: string }
  /** The phone acknowledged and is working on it. */
  | { state: "PHONE_ACCEPTED"; sequence: number; commandId: string }
  | { state: "EXECUTING"; sequence: number; commandId: string }
  /** Authoritative confirmation from the phone. */
  | { state: "CONFIRMED"; sequence: number }
  | { state: "FAILED"; sequence: number; errorCode: string; commandId: string | null }
  | { state: "EXPIRED"; sequence: number; commandId: string | null };

export const IDLE_READ: ReadSyncState = { state: "IDLE" };

/**
 * Command states that are NOT terminal. A command in any of these is durable and
 * still may complete — it must never be reported to the user as a failure.
 *
 * Production bug this fixes: after a fixed ~30s observation window the UI threw
 * `read_pending` and rendered "Read sync failed" while the command was still
 * QUEUED. Pending is not failure.
 */
export const NON_TERMINAL_COMMAND_STATES = Object.freeze([
  "QUEUED", "DELIVERED_TO_AGENT", "ACCEPTED_BY_AGENT", "EXECUTING",
]);

export function isTerminalCommandState(commandState: string | null | undefined): boolean {
  return commandState === "COMPLETED" || commandState === "FAILED" || commandState === "EXPIRED";
}

/** True while the read is still legitimately in flight. */
export function readStillPending(state: ReadSyncState): boolean {
  return state.state === "PREPARING_COMMAND" || state.state === "QUEUED"
    || state.state === "WAITING_FOR_PHONE" || state.state === "PHONE_ACCEPTED"
    || state.state === "EXECUTING";
}

/**
 * Map a durable command state onto the read state machine.
 *
 * `COMPLETED` is the ONLY state that confirms the phone wrote the thread read.
 * A non-terminal state keeps waiting; only FAILED/EXPIRED are terminal failures.
 */
export function readStateForCommand(
  commandState: string | null | undefined,
  sequence: number,
  commandId: string,
): ReadSyncState {
  switch (commandState) {
    case "COMPLETED": return { state: "CONFIRMED", sequence };
    case "FAILED": return { state: "FAILED", sequence, errorCode: "READ_PHONE_REJECTED", commandId };
    case "EXPIRED": return { state: "EXPIRED", sequence, commandId };
    case "ACCEPTED_BY_AGENT": return { state: "PHONE_ACCEPTED", sequence, commandId };
    case "EXECUTING": return { state: "EXECUTING", sequence, commandId };
    case "DELIVERED_TO_AGENT": return { state: "WAITING_FOR_PHONE", sequence, commandId };
    default: return { state: "QUEUED", sequence, commandId };
  }
}

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
    case "PREPARING_COMMAND": return "Read · syncing to phone";
    case "QUEUED": return "Read · waiting for phone";
    case "WAITING_FOR_PHONE": return "Read · waiting for phone";
    case "PHONE_ACCEPTED": return "Read · accepted by phone";
    case "EXECUTING": return "Read · phone is updating";
    case "CONFIRMED": return "Read";
    case "FAILED": return "Read sync failed";
    case "EXPIRED": return "Read sync expired";
  }
}

export function readSyncTone(state: ReadSyncState): "none" | "muted" | "ok" | "failed" {
  switch (state.state) {
    case "IDLE": return "none";
    case "CONFIRMED": return "ok";
    case "FAILED":
    case "EXPIRED": return "failed";
    default: return "muted";
  }
}

export function readSyncRetryable(state: ReadSyncState): boolean {
  return state.state === "FAILED" || state.state === "EXPIRED";
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
/**
 * §P7: a read failure must always carry a machine-readable cause. A generic
 * "Read sync failed" with no reason is not diagnosable.
 */
export const READ_FAILURE_CODES = Object.freeze([
  "READ_COMMAND_KEY_UNAVAILABLE",
  "READ_COMMAND_CRYPTO_INVALID",
  "READ_COMMAND_CREATE_FAILED",
  "READ_COMMAND_EXPIRED",
  "READ_PHONE_REJECTED",
  "READ_MAPPING_MISSING",
  "READ_PROVIDER_WRITE_FAILED",
  "READ_EVENT_PUBLISH_FAILED",
]);

export function readFailureCode(cause: unknown): string {
  const value = cause instanceof Error
    ? cause.message
    : typeof cause === "string" && cause
      ? cause
      : "";
  if (!value) return "READ_SYNC_FAILED";
  // Structured crypto/key errors keep their own precise identity.
  if (/^COMMAND_KEY_UNAVAILABLE$/.test(value)) return "READ_COMMAND_KEY_UNAVAILABLE";
  if (/^COMMAND_KEY_(INVALID|FORMAT_UNSUPPORTED)$/.test(value)) return "READ_COMMAND_CRYPTO_INVALID";
  if (/^COMMAND_CRYPTO/.test(value)) return "READ_COMMAND_CRYPTO_INVALID";
  if (/^COMMAND_CREATE_FAILED$/.test(value)) return "READ_COMMAND_CREATE_FAILED";
  if (/expired/i.test(value)) return "READ_COMMAND_EXPIRED";
  if (/mapping/i.test(value)) return "READ_MAPPING_MISSING";
  if (/provider|thread/i.test(value)) return "READ_PROVIDER_WRITE_FAILED";
  if (/publish|event/i.test(value)) return "READ_EVENT_PUBLISH_FAILED";
  if (/offline|unreachable|not connected/i.test(value)) return "READ_PHONE_OFFLINE";
  return value;
}
