/**
 * Keeps the reader's place while they are scrolled up.
 *
 * The anchor is the first row visible at the top of the viewport and how far
 * from the top it sits. Whatever changes above it (an older page prepended,
 * rows re-measured to their real height) is undone by putting that same row
 * back at the same offset. One rule instead of a separate fix per cause.
 */
export interface ViewAnchor {
  key: string | number | bigint;
  /** Row start minus the viewport top, in list coordinates (<= 0 when partly hidden). */
  offset: number;
}

export interface MeasuredRow {
  key: string | number | bigint;
  index?: number;
  start: number;
  end: number;
}

/**
 * `viewTop` is the scroll position expressed in list coordinates. `eligible`
 * excludes rows that can move relative to their neighbours: a day separator
 * stays first when older messages of the same day are inserted under it.
 */
export function captureAnchor(
  items: readonly MeasuredRow[],
  viewTop: number,
  eligible: (item: MeasuredRow) => boolean = () => true,
): ViewAnchor | null {
  const row = items.find((item) => item.end > viewTop && eligible(item));
  return row ? { key: row.key, offset: row.start - viewTop } : null;
}

/** The scrollTop that puts the anchor row back where it was, or null if it is gone. */
export function restoreScrollTop(anchor: ViewAnchor | null, items: readonly MeasuredRow[], listTop: number): number | null {
  if (!anchor) return null;
  const row = items.find((item) => item.key === anchor.key);
  return row ? listTop + row.start - anchor.offset : null;
}
