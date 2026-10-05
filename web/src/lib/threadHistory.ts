import type { StoredEvent } from "./sync.ts";

export function mergeThreadEvents(previous: StoredEvent[], incoming: StoredEvent[]): StoredEvent[] {
  return [...new Map([...previous, ...incoming].map(event => [event.eventId, event])).values()]
    .sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
}

export function assertHistoryProgress<T extends { items: unknown[]; hasMore: boolean; next?: string | number }>(
  requested: string | number, page: T,
): void {
  if (page.hasMore && (page.next === undefined || page.next === requested || page.items.length === 0))
    throw new Error("PAGINATION_STALLED");
}

/**
 * PRODUCTION BUG this fixes: "Load older messages" was visibly clickable and
 * did nothing.
 *
 * `assertHistoryProgress` only proved the CURSOR advanced. `mergeThreadEvents`
 * dedupes by `eventId`, so a page whose rows the client already held advanced
 * the cursor, passed that assertion, and merged to ZERO new messages — the
 * button stayed, the UI did not change, and the click looked dead.
 *
 * Success must be proven by the MERGE, not by the cursor:
 *   - reaching the end (hasMore === false) is progress, or
 *   - at least one NEW unique message was merged.
 * Anything else is a duplicate-only page and must be surfaced, never swallowed.
 */
export function assertHistoryMergeProgress<T extends { items: unknown[]; hasMore: boolean; next?: string | number }>(
  requested: string | number, page: T, mergedNewCount: number,
): void {
  if (!page.hasMore) return;
  if (mergedNewCount > 0) return;
  if (page.items.length === 0) throw new Error("PAGINATION_STALLED");
  if (page.next === undefined || page.next === requested) throw new Error("PAGINATION_STALLED");
  throw new Error("PAGINATION_DUPLICATE_PAGE");
}
