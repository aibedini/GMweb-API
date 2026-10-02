import type { ConversationFilter } from "./types";

const FILTERS: Array<{ id: ConversationFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
];

/**
 * §13: All / Unread only. There is no "Pinned" filter because no pin data
 * exists in the current data model and fake state is not allowed.
 */
export function ConversationFilters({
  value,
  onChange,
  unreadTotal,
}: {
  value: ConversationFilter;
  onChange: (value: ConversationFilter) => void;
  unreadTotal: number;
}) {
  return (
    <div className="conversation-filters" role="group" aria-label="Filter conversations">
      {FILTERS.map((filter) => (
        <button
          key={filter.id}
          type="button"
          className="conversation-filters__item"
          aria-pressed={value === filter.id}
          onClick={() => onChange(filter.id)}
        >
          <span>{filter.label}</span>
          {filter.id === "unread" && unreadTotal > 0 ? (
            <span className="conversation-filters__count">{unreadTotal > 99 ? "99+" : unreadTotal}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
