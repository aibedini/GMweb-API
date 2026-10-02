import { useRef, type RefObject } from "react";
import { Button, Skeleton, Tooltip } from "@heroui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConversationProjection } from "../../lib/inbox";
import { ConversationFilters } from "./ConversationFilters";
import { ConversationRow } from "./ConversationRow";
import { ConversationSearch } from "./ConversationSearch";
import { IconCompose } from "./icons";
import type { ConversationFilter } from "./types";

function RowSkeleton() {
  return (
    <div className="conversation-skeleton">
      <Skeleton className="size-10 rounded-xl" />
      <div className="flex min-w-0 flex-col gap-2">
        <Skeleton className="h-3 w-2/3 rounded-md" />
        <Skeleton className="h-3 w-full rounded-md" />
      </div>
    </div>
  );
}

/**
 * §13: conversation pane.
 *
 * Owns the conversation virtualizer (a view concern) and the scroll container.
 * Pagination stays exactly as before: `onLoadMore` fires within 180px of the
 * bottom and the explicit footer button remains available.
 */
export function ConversationPane({
  conversations,
  totalConversations,
  selectedId,
  onSelect,
  search,
  onSearch,
  searchInputRef,
  filter,
  onFilter,
  unreadTotal,
  loading,
  emptyMessage,
  hasMore,
  loadingMore,
  onLoadMore,
  onCompose,
}: {
  conversations: ConversationProjection[];
  totalConversations: number;
  selectedId: string | null;
  onSelect: (conversation: ConversationProjection) => void;
  search: string;
  onSearch: (value: string) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  filter: ConversationFilter;
  onFilter: (filter: ConversationFilter) => void;
  unreadTotal: number;
  loading: boolean;
  emptyMessage: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onCompose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 68,
    overscan: 8,
    getItemKey: (index) => conversations[index]?.aggregateId ?? index,
  });

  return (
    <aside className="conversation-pane" aria-label="Conversations">
      <div className="pane-bar">
        <div className="pane-bar__title">
          <strong>Messages</strong>
          <span>
            {totalConversations} conversation{totalConversations === 1 ? "" : "s"} loaded
          </span>
        </div>
        <Tooltip delay={350} closeDelay={80}>
          <Tooltip.Trigger>
            <Button variant="primary" isIconOnly aria-label="New message" onPress={onCompose}>
              <IconCompose width={17} height={17} aria-hidden />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>New message</Tooltip.Content>
        </Tooltip>
      </div>

      <div className="pane-tools">
        <ConversationSearch value={search} onChange={onSearch} inputRef={searchInputRef} />
        <ConversationFilters value={filter} onChange={onFilter} unreadTotal={unreadTotal} />
      </div>

      <div
        ref={scrollRef}
        className="conversation-list scroll-region"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (
            hasMore &&
            !loadingMore &&
            element.scrollHeight - element.scrollTop - element.clientHeight < 180
          ) {
            onLoadMore();
          }
        }}
      >
        {loading ? (
          <>
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </>
        ) : conversations.length === 0 ? (
          <div className="empty-block empty-block--inline">
            <p>{emptyMessage}</p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const conversation = conversations[virtualRow.index];
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
                  <ConversationRow
                    conversation={conversation}
                    selected={selectedId === conversation.aggregateId}
                    onSelect={onSelect}
                  />
                </div>
              );
            })}
          </div>
        )}

        {hasMore ? (
          <div className="list-footer">
            <Button
              size="sm"
              variant="tertiary"
              onPress={onLoadMore}
              isDisabled={loadingMore}
              aria-label="Load older conversations"
            >
              {loadingMore ? "Loading…" : "Load older conversations"}
            </Button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
