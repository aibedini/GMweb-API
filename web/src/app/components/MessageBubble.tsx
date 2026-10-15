import { formatClock, messageStatusLabel } from "./format";
import type { ThreadItem } from "./types";

/**
 * §15: one message bubble.
 *
 * `dir="auto"` plus `unicode-bidi: plaintext` (in `styles/messaging.css`) keeps
 * Persian, English, mixed and multi-line SMS rendered correctly while the
 * application shell stays LTR.
 *
 * §23: the outgoing status is the only clickable part of the bubble and opens
 * the delivery-evidence drawer. Incoming messages show the timestamp only.
 */
export function MessageBubble({
  item,
  onOpenStatus,
}: {
  item: ThreadItem;
  onOpenStatus?: (item: ThreadItem) => void;
}) {
  const outgoing = item.direction === "out";
  const statusLabel = item.pending ? null : messageStatusLabel(item.status);
  const pendingLabel = item.failure ?? item.progress ?? "Sending…";
  const statusText = item.pending ? pendingLabel : statusLabel;

  const className = [
    "message-bubble",
    item.pending ? "message-bubble--pending" : "",
    item.failure ? "message-bubble--failed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`message-row${outgoing ? " message-row--out" : ""}`}>
      <div className={className}>
        <p className="message-bubble__body" dir="auto">
          {item.body}
        </p>
        <span className="message-bubble__meta">
          <time dateTime={new Date(item.dateMs).toISOString()}>{formatClock(item.dateMs)}</time>
          {outgoing && statusText ? (
            <>
              <span aria-hidden="true">·</span>
              {item.pending || !onOpenStatus ? (
                <span>{statusText}</span>
              ) : (
                <button
                  type="button"
                  className="message-bubble__status"
                  onClick={() => onOpenStatus(item)}
                  aria-label={`Delivery status: ${statusText}. Show delivery details`}
                >
                  {statusText}
                </button>
              )}
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
