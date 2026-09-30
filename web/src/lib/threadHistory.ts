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
