import { Button, Spinner } from "@heroui/react";
import { IconChat, IconLock, IconWarning } from "./icons";
import type { ThreadState } from "./types";

/**
 * §42: polished empty/loading/failure states. No ASCII or emoji decoration.
 */
export function ThreadEmptyState({
  state,
  error,
  onRetry,
}: {
  state: ThreadState;
  error: string | null;
  onRetry: () => void;
}) {
  if (state === "LOADING") {
    return (
      <div className="empty-block">
        <Spinner size="md" />
        <h3>Loading messages…</h3>
      </div>
    );
  }

  if (state === "LOCKED") {
    return (
      <div className="empty-block">
        <span className="empty-block__icon">
          <IconLock width={20} height={20} aria-hidden />
        </span>
        <h3>Messages are encrypted</h3>
        <p>Waiting for an authorized key from your Primary phone.</p>
      </div>
    );
  }

  if (state === "EMPTY") {
    return (
      <div className="empty-block">
        <span className="empty-block__icon">
          <IconChat width={20} height={20} aria-hidden />
        </span>
        <h3>No messages in this conversation</h3>
        <p>Anything you send or receive will appear here.</p>
      </div>
    );
  }

  if (state === "FAILED") {
    return (
      <div className="empty-block" role="alert">
        <span className="empty-block__icon">
          <IconWarning width={20} height={20} aria-hidden />
        </span>
        <h3>Unable to load messages</h3>
        <p>{error || "The thread page read failed."}</p>
        <Button size="sm" variant="secondary" onPress={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  return null;
}

/** §42: no conversation selected on desktop. */
export function ThreadPlaceholder({ composeRecipient }: { composeRecipient?: string | null }) {
  return (
    <div className="empty-block">
      <span className="empty-block__icon">
        <IconChat width={20} height={20} aria-hidden />
      </span>
      <h3>{composeRecipient ? "Start a conversation" : "Select a conversation"}</h3>
      <p>
        {composeRecipient
          ? `Enter a message below to send it to ${composeRecipient}.`
          : "Choose a conversation from the list or start a new message."}
      </p>
    </div>
  );
}
