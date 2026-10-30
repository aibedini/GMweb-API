/**
 * Whether the thread view follows the newest message.
 *
 * The view is pinned by default and stays pinned through anything that is not
 * the reader scrolling UP: content growing, rows being re-measured, the pane
 * shrinking when a status line appears, the browser clamping scrollTop. Only an
 * upward scroll away from the bottom unpins; returning near the bottom pins again.
 */
export const PIN_THRESHOLD_PX = 48;

export function nextPinned(
  pinned: boolean,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  previousScrollTop: number,
): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  if (distance <= PIN_THRESHOLD_PX) return true;
  if (metrics.scrollTop < previousScrollTop - 1) return false;
  return pinned;
}

/** A new newest row arrived in the same thread (not a thread switch, not a prepend). */
export function appendedNewest(previousLastKey: string | null, rows: readonly { key: string }[]): boolean {
  const last = rows[rows.length - 1]?.key ?? null;
  if (!previousLastKey || !last || last === previousLastKey) return false;
  return rows.some((row) => row.key === previousLastKey);
}
