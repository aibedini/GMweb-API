/**
 * Pure presentation formatters.
 *
 * These never mutate stored events — §16 requires date grouping to be a
 * display-only transform over the real `payload.dateMs`.
 */
import type { ThreadItem, ThreadRow } from "./types";

const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

export function formatClock(value: number): string {
  return new Date(value).toLocaleTimeString([], TIME_FORMAT);
}

/** List timestamps: clock time today, short date before that. */
export function formatListTime(value: number): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? formatClock(value)
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function formatFullTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

/** Stable per-calendar-day bucket key (local time). */
export function dayKey(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function formatDayLabel(value: number, now = Date.now()): string {
  const key = dayKey(value);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - 86_400_000)) return "Yesterday";
  return new Date(value).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Android `MessageStatus` values used by the projection.
 * The mapping is unchanged from the pre-redesign implementation — no new
 * delivery semantics are inferred at the presentation layer.
 */
export function messageStatusLabel(status: number | undefined): string | null {
  if (status === undefined) return null;
  if (status === 64) return "Failed";
  if (status === 32) return "Queued";
  if (status === 0) return "Delivered";
  return "Sent";
}

export function initialsFor(title: string): string {
  const cleaned = title.replace(/^Conversation\s+/, "").trim();
  if (!cleaned) return "?";
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && /^[\p{L}\p{N}]/u.test(words[0]) && /^[\p{L}\p{N}]/u.test(words[1])) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

export function shortId(value: string | null | undefined, length = 8): string {
  return value ? `${value.slice(0, length)}…` : "—";
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Insert day separators between messages, producing the flat row list the
 * virtualizer renders. Messages must already be sorted oldest-first.
 */
export function withDaySeparators(items: ThreadItem[]): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let previous = "";
  for (const item of items) {
    const key = dayKey(item.dateMs);
    if (key !== previous) {
      previous = key;
      rows.push({ kind: "day", key: `day-${key}`, label: formatDayLabel(item.dateMs) });
    }
    rows.push({ kind: "message", key: `msg-${item.key}`, item });
  }
  return rows;
}
