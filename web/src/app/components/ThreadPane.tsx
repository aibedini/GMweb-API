import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, Spinner } from "@heroui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MessageBubble } from "./MessageBubble";
import { MessageDaySeparator } from "./MessageDaySeparator";
import { ThreadEmptyState } from "./ThreadEmptyState";
import type { ThreadItem, ThreadRow, ThreadState } from "./types";
import { captureAnchor, restoreScrollTop, type ViewAnchor } from "../../lib/threadScrollAnchor";
import { appendedNewest, nextPinned } from "../../lib/threadStickToBottom";

/**
 * §15/§49: the message list stays virtualized.
 *
 * `rows` is the flattened message list with day separators already inserted,
 * so separators are measured like any other row and no second scroll
 * container appears. `scrollRef` is owned by `App.tsx` because the send /
 * history logic needs to read and preserve scroll position.
 */
export function ThreadPane({
  scrollRef,
  threadId = null,
  rows,
  state,
  error,
  onRetryThread,
  header,
  notices,
  composer,
  hasMore,
  loadingOlder,
  historyFailed = false,
  onLoadOlder,
  onOpenStatus,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  threadId?: string | null;
  rows: ThreadRow[];
  state: ThreadState;
  error: string | null;
  onRetryThread: () => void;
  header: ReactNode;
  notices?: ReactNode;
  composer: ReactNode;
  hasMore: boolean;
  loadingOlder: boolean;
  historyFailed?: boolean;
  onLoadOlder: () => void;
  onOpenStatus?: (item: ThreadItem) => void;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const effectiveRef = scrollRef ?? localRef;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => effectiveRef.current,
    estimateSize: (index) => (rows[index]?.kind === "day" ? 40 : 62),
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
    // Scroll writes happen inside layout effects; a synchronous flush there is
    // a React error and is not needed for correctness.
    useFlushSync: false,
  });
  // Position is kept by the reading anchor below; a second, independent
  // correction from the virtualizer would fight it.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  // Follow the newest message unless the reader scrolled up themselves; while
  // they are up, keep the row they are reading exactly where it is.
  const pinned = useRef(true);
  const reading = useRef<ViewAnchor | null>(null);
  const lastScrollTop = useRef(0);
  const lastRowKey = useRef<string | null>(null);
  const smoothUntil = useRef(0);
  // The scrollTop this component last wrote; the scroll event it causes is not
  // the reader moving and must not re-capture the anchor (row heights may have
  // been re-measured in between, which would pick the wrong row).
  const writtenTop = useRef<number | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  const listTop = useCallback((element: HTMLDivElement) => {
    const list = element.querySelector(".thread-virtual");
    if (!list) return 0;
    return list.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
  }, []);

  const capture = useCallback(() => {
    const element = effectiveRef.current;
    if (!element) return;
    reading.current = captureAnchor(virtualizer.measurementsCache, element.scrollTop - listTop(element),
      (item) => rows[item.index ?? -1]?.kind === "message");
  }, [effectiveRef, listTop, virtualizer, rows]);

  const settle = useCallback((smooth = false) => {
    const element = effectiveRef.current;
    if (!element) return;
    if (pinned.current) {
      if (smooth) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
      else element.scrollTop = element.scrollHeight;
    } else {
      const top = restoreScrollTop(reading.current, virtualizer.measurementsCache, listTop(element));
      if (top !== null && Math.abs(top - element.scrollTop) >= 1) {
        element.scrollTop = top;
        writtenTop.current = element.scrollTop;
      }
    }
    lastScrollTop.current = element.scrollTop;
  }, [effectiveRef, listTop, virtualizer]);

  useLayoutEffect(() => {
    pinned.current = true;
    reading.current = null;
    lastRowKey.current = null;
    setAwayFromBottom(false);
  }, [threadId]);

  // Before paint on every row change: a new newest row while pinned scrolls
  // smoothly; anything else snaps back to the bottom or to the reading anchor.
  useLayoutEffect(() => {
    if (state !== "READY") return;
    const appended = appendedNewest(lastRowKey.current, rows);
    lastRowKey.current = rows[rows.length - 1]?.key ?? null;
    if (appended && pinned.current) {
      smoothUntil.current = performance.now() + 600;
      settle(true);
    } else {
      settle(false);
    }
  }, [rows, state, settle]);

  // Size changes that are not row changes: rows measured to their real
  // height, the status line above the list, the window resizing.
  useEffect(() => {
    const element = effectiveRef.current;
    if (!element || state !== "READY" || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => settle(pinned.current && performance.now() < smoothUntil.current));
    observer.observe(element);
    const content = element.querySelector(".thread-virtual");
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [state, effectiveRef, settle]);

  const jumpToLatest = () => {
    pinned.current = true;
    setAwayFromBottom(false);
    smoothUntil.current = performance.now() + 600;
    settle(true);
  };

  return (
    <section className="thread-pane" aria-label="Conversation">
      {header}

      {notices ? <div className="thread-notices">{notices}</div> : null}

      <div
        ref={effectiveRef}
        className="thread-scroll scroll-region"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (writtenTop.current !== null && Math.abs(element.scrollTop - writtenTop.current) < 1) {
            writtenTop.current = null;
            return;
          }
          writtenTop.current = null;
          pinned.current = nextPinned(pinned.current, element, lastScrollTop.current);
          lastScrollTop.current = element.scrollTop;
          setAwayFromBottom(!pinned.current);
          if (!pinned.current) capture();
          if (hasMore && !loadingOlder && !historyFailed && event.currentTarget.scrollTop < 120) onLoadOlder();
        }}
      >
        {state === "READY" ? (
          // Fixed height in every state, so swapping button / spinner / end
          // marker never shifts the messages below it.
          <div className="thread-load-more" role="status" aria-live="polite">
            {loadingOlder ? (
              <span className="thread-load-more__status">
                <Spinner size="sm" />
                Loading older messages…
              </span>
            ) : hasMore ? (
              <Button size="sm" variant="tertiary" onPress={onLoadOlder}>
                Load older messages
              </Button>
            ) : (
              <span className="thread-load-more__end">Start of conversation</span>
            )}
          </div>
        ) : null}

        {state === "READY" ? (
          <div className="thread-virtual" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{
                    position: "absolute",
                    insetInline: 0,
                    top: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.kind === "day" ? (
                    <MessageDaySeparator label={row.label} />
                  ) : (
                    <MessageBubble item={row.item} onOpenStatus={onOpenStatus} />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <ThreadEmptyState state={state} error={error} onRetry={onRetryThread} />
        )}

        {state === "READY" && awayFromBottom ? (
          <div className="thread-jump">
            <Button
              size="sm"
              variant="secondary"
              onPress={jumpToLatest}
            >
              Jump to latest
            </Button>
          </div>
        ) : null}
      </div>

      {composer}
    </section>
  );
}
