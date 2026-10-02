/**
 * Shared presentation types.
 *
 * These describe the *view model* only. Nothing here owns business state —
 * `App.tsx` remains the orchestration/state owner and hands these shapes to the
 * presentational components.
 */

/** Application destinations. `tab` state keeps these keys. */
export type DestinationKey =
  | "inbox"
  | "contacts"
  | "connection"
  | "security"
  | "debug"
  | "settings";

export interface Destination {
  key: DestinationKey;
  label: string;
}

/** Which of the two mobile screens is showing. */
export type MobileView = "list" | "thread";

/** Thread load lifecycle, owned by `App.tsx`. */
export type ThreadState = "IDLE" | "LOADING" | "READY" | "LOCKED" | "EMPTY" | "FAILED";

/** Conversation list filter. Pinned is deliberately absent: no pin data exists. */
export type ConversationFilter = "all" | "unread";

/** Availability of the GMweb API from this browser. */
export type ConnectionState = "checking" | "connected" | "offline" | "unreachable";

/** One rendered row inside the virtualized message list. */
export type ThreadRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; item: ThreadItem };

/**
 * A single message as the thread renders it. Built from the real projection
 * (`messagesForAggregate`) plus the optimistic pending-send row; no status is
 * invented.
 */
export interface ThreadItem {
  /** Stable identity: Android messageId, falling back to the event id. */
  key: string;
  direction: "in" | "out";
  body: string;
  dateMs: number;
  /** Raw Android `status` from the decrypted payload (outgoing only). */
  status?: number;
  /** True for the optimistic local bubble that is not yet an event. */
  pending?: boolean;
  /** Local failure text for the optimistic bubble. */
  failure?: string | null;
  /** Local command lifecycle text for the optimistic bubble. */
  progress?: string | null;
  clientMessageId?: string | null;
}
