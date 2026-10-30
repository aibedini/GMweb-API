/**
 * Keeps the reader's place when older messages are prepended to a thread.
 *
 * The anchor is the first MESSAGE row (a day separator can keep its key while
 * older messages of the same day are inserted beneath it). When that row is no
 * longer first but is still present, the content above it grew, and the scroll
 * position must move down by exactly how far the anchor moved.
 */
export interface ScrollAnchor {
  key: string;
  start: number;
}

export function firstMessageAnchor(
  rows: readonly { kind: string; key: string }[],
  startOf: (index: number) => number,
): ScrollAnchor | null {
  const index = rows.findIndex((row) => row.kind === "message");
  return index < 0 ? null : { key: rows[index].key, start: startOf(index) };
}

/** Pixels to add to scrollTop after `rows` replaced the rows `previous` was taken from. */
export function prependScrollDelta(
  previous: ScrollAnchor | null,
  rows: readonly { kind: string; key: string }[],
  startOf: (index: number) => number,
): number {
  if (!previous) return 0;
  const current = firstMessageAnchor(rows, startOf);
  if (!current || current.key === previous.key) return 0;
  const index = rows.findIndex((row) => row.key === previous.key);
  if (index < 0) return 0;
  return Math.max(0, startOf(index) - previous.start);
}
