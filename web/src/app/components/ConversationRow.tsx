import { Avatar, Chip } from "@heroui/react";
import type { ConversationProjection } from "../../lib/inbox";
import { formatListTime, initialsFor } from "./format";

/**
 * §13: one conversation row — continuous list styling, no card-in-card.
 * Target height 64-72px; the row is a real `<button>` so it is keyboard
 * reachable and screen-reader labelled by its own text content.
 */
export function ConversationRow({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ConversationProjection;
  selected: boolean;
  onSelect: (conversation: ConversationProjection) => void;
}) {
  return (
    <button
      type="button"
      className={`conversation-row${selected ? " is-selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(conversation)}
    >
      <Avatar size="sm" variant="soft" color="accent">
        <Avatar.Fallback>{initialsFor(conversation.title)}</Avatar.Fallback>
      </Avatar>

      <span className="conversation-row__copy">
        <span className="conversation-row__title">
          <span className="bidi-text">{conversation.title}</span>
          {conversation.subtitle ? (
            <span className="conversation-row__subtitle bidi-text">{conversation.subtitle}</span>
          ) : null}
        </span>
        <span className="conversation-row__preview bidi-text">
          {conversation.decodeState === "locked" && !conversation.preview
            ? "Locked — waiting for a key grant"
            : conversation.preview}
        </span>
      </span>

      <span className="conversation-row__meta">
        <time className="conversation-row__time" dateTime={new Date(conversation.lastAt).toISOString()}>
          {formatListTime(conversation.lastAt)}
        </time>
        {conversation.unreadCount > 0 ? (
          <Chip size="sm" color="accent" variant="soft" aria-label={`${conversation.unreadCount} unread`}>
            <Chip.Label>{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</Chip.Label>
          </Chip>
        ) : null}
      </span>
    </button>
  );
}
