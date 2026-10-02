/**
 * Thread history paging state.
 *
 * The previous implementation kept `hasMore`, `next` and `loading` as three
 * independent `useState` values updated from different branches of the thread
 * effect. That makes an inconsistent pair
 *
 *     hasMore === true  &&  next === null
 *
 * representable — and in that state the UI still rendered an actionable
 * "Load older messages" button whose handler immediately returned because the
 * cursor was missing. A dead button is worse than no button.
 *
 * This module owns the invariant instead:
 *
 *   - `hasMore` may only be true when a usable cursor exists.
 *   - the pair is always derived from ONE page result, atomically.
 *   - an impossible page (`hasMore` with no cursor) becomes a surfaced,
 *     recoverable error rather than a silent no-op.
 *
 * Everything here is pure and unit-tested.
 */

export interface HistoryPagingState {
  hasMore: boolean;
  /** Cursor for the next "load older" request, or null when there is none. */
  next: string | number | null;
  loading: boolean;
  /** Machine-readable code (never a human sentence). */
  error: string | null;
}

/** Page shape returned by `listAggregateEventsPage`. */
export interface HistoryPageLike {
  hasMore: boolean;
  next?: string | number;
}

export const IDLE_HISTORY: HistoryPagingState = {
  hasMore: false, next: null, loading: false, error: null,
};

/** Error code surfaced when the server claims more history but sends no cursor. */
export const HISTORY_CURSOR_MISSING = "HISTORY_CURSOR_MISSING";

export function isValidCursor(next: unknown): next is string | number {
  return (typeof next === "string" && next.length > 0) ||
    (typeof next === "number" && Number.isFinite(next));
}

/**
 * Derive the ONLY legal paging state from a page result.
 *
 * A page that reports `hasMore` without a usable cursor is a protocol
 * violation: we must not claim more history is loadable.
 */
export function pagingFromPage(page: HistoryPageLike): HistoryPagingState {
  const next = page.next;
  if (page.hasMore && !isValidCursor(next)) {
    return { hasMore: false, next: null, loading: false, error: HISTORY_CURSOR_MISSING };
  }
  return {
    hasMore: Boolean(page.hasMore) && isValidCursor(next),
    next: isValidCursor(next) ? next : null,
    loading: false,
    error: null,
  };
}

/** Begin a load: preserves the cursor, clears the previous error. */
export function pagingLoading(state: HistoryPagingState): HistoryPagingState {
  return { ...state, loading: true, error: null };
}

/** A failed load keeps the cursor so the user can retry the same page. */
export function pagingFailed(state: HistoryPagingState, errorCode: string): HistoryPagingState {
  return { ...state, loading: false, error: errorCode };
}

/**
 * True when the "Load older messages" control may be RENDERED at all.
 * Requires a READY thread so a half-loaded/failed thread never offers paging.
 */
export function showLoadOlder(state: HistoryPagingState, threadState: string): boolean {
  return threadState === "READY" && state.hasMore && isValidCursor(state.next);
}

/** True when the rendered control is actionable right now. */
export function canLoadOlder(state: HistoryPagingState, threadState: string): boolean {
  return showLoadOlder(state, threadState) && !state.loading;
}

/** §32: everything needed to tell the two failure hypotheses apart in the field. */
export interface HistoryDiagnostics {
  historyHasMore: boolean;
  historyNextCursorPresent: boolean;
  historyNextCursorType: "string" | "number" | "none";
  lastHistoryRequestAt: number | null;
  lastHistoryReturnedCount: number;
  /** False when a request returned the same cursor it was given (a stall). */
  lastHistoryNextCursorChanged: boolean;
  lastHistoryError: string | null;
}

export interface HistoryTrace {
  lastRequestAt: number | null;
  lastReturnedCount: number;
  lastNextCursorChanged: boolean;
}

export const EMPTY_HISTORY_TRACE: HistoryTrace = {
  lastRequestAt: null, lastReturnedCount: 0, lastNextCursorChanged: false,
};

export function describeHistory(
  state: HistoryPagingState,
  trace: HistoryTrace = EMPTY_HISTORY_TRACE,
): HistoryDiagnostics {
  return {
    historyHasMore: state.hasMore,
    historyNextCursorPresent: isValidCursor(state.next),
    historyNextCursorType:
      typeof state.next === "string" ? "string" : typeof state.next === "number" ? "number" : "none",
    lastHistoryRequestAt: trace.lastRequestAt,
    lastHistoryReturnedCount: trace.lastReturnedCount,
    lastHistoryNextCursorChanged: trace.lastNextCursorChanged,
    lastHistoryError: state.error,
  };
}

/**
 * Human copy for a paging error. Distinct codes keep distinct causes.
 */
export function historyErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === HISTORY_CURSOR_MISSING) {
    return "Older messages could not be loaded. The history cursor is missing.";
  }
  if (code === "PAGINATION_STALLED") {
    return "Older messages could not be loaded. The history did not advance.";
  }
  if (code === "DECRYPTION_FAILED") {
    return "Older messages could not be loaded. Some could not be authenticated.";
  }
  return "Older messages could not be loaded.";
}
