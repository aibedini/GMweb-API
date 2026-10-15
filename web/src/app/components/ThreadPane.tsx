import { useRef, type ReactNode, type RefObject } from "react";
import { Button } from "@heroui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MessageBubble } from "./MessageBubble";
import { MessageDaySeparator } from "./MessageDaySeparator";
import { ThreadEmptyState } from "./ThreadEmptyState";
import type { ThreadItem, ThreadRow, ThreadState } from "./types";

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
  rows,
  state,
  error,
  onRetryThread,
  header,
  notices,
  composer,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onOpenStatus,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  rows: ThreadRow[];
  state: ThreadState;
  error: string | null;
  onRetryThread: () => void;
  header: ReactNode;
  notices?: ReactNode;
  composer: ReactNode;
  hasMore: boolean;
  loadingOlder: boolean;
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
  });

  return (
    <section className="thread-pane" aria-label="Conversation">
      {header}

      {notices ? <div className="thread-notices">{notices}</div> : null}

      <div
        ref={effectiveRef}
        className="thread-scroll scroll-region"
        onScroll={(event) => {
          if (hasMore && !loadingOlder && event.currentTarget.scrollTop < 80) onLoadOlder();
        }}
      >
        {hasMore ? (
          <div className="thread-load-more">
            <Button size="sm" variant="tertiary" onPress={onLoadOlder} isDisabled={loadingOlder}>
              {loadingOlder ? "Loading older messages…" : "Load older messages"}
            </Button>
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
      </div>

      {composer}
    </section>
  );
}
