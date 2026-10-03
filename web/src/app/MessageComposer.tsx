import { Suspense, lazy, useRef, useState } from "react";
import { Alert, Button, Spinner } from "@heroui/react";
import type { DeviceTelemetry } from "../lib/api";
import { sendDisabled } from "../lib/inboxActions";
import { insertEmoji } from "../lib/emojiInsert";
import { ComposerStatus } from "./components/ComposerStatus";
import { SimSelector } from "./components/SimSelector";
import { SmsCounter } from "./components/SmsCounter";
import { IconSend, IconSmile } from "./components/icons";
import { MessageTextarea } from "./MessageTextarea";

type Sim = NonNullable<DeviceTelemetry["smsSubscriptions"]>["items"][number];

// The picker (and its emoji table) is a separate chunk: it must cost nothing
// until the user actually opens it.
const LazyEmojiPicker = lazy(() => import("./components/EmojiPicker"));

/**
 * §17/§21: the composer.
 *
 * Every existing capability is preserved: multiline draft, SIM selection,
 * SMS segment calculation, send button, SIM help, keyboard send shortcut and
 * the `sending` / `canSend` / `draft.trim()` / `help` guards. Only the visual
 * implementation moved to HeroUI.
 */
export function MessageComposer({
  draft,
  onDraft,
  sims,
  selected,
  onSim,
  help,
  retry,
  send,
  sending,
  canSend,
  status,
  useDefault,
  refreshNotice,
  refreshing,
}: {
  draft: string;
  onDraft: (value: string) => void;
  sims: Sim[];
  selected?: Sim;
  onSim: (id: number | null) => void;
  help: string | null;
  retry: () => void;
  useDefault: boolean;
  send: () => void;
  sending: boolean;
  canSend: boolean;
  status: string | null;
  /** Outcome of a user-initiated SIM refresh; never fakes success. */
  refreshNotice?: string | null;
  /** True while a refresh command is in flight; blocks duplicate enqueues. */
  refreshing?: boolean;
}) {
  const disabled = sendDisabled({ draft, sending, canSend, simInstructions: help });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

  const guardedSend = () => {
    if (disabled) return;
    send();
  };

  /** §16/§19: insert exactly at the caret and restore focus + caret. */
  const onPickEmoji = (emoji: string) => {
    const node = textareaRef.current;
    const { value: next, caret } = insertEmoji(
      draft, node?.selectionStart ?? null, node?.selectionEnd ?? null, emoji,
    );
    onDraft(next);
    // Wait for React to commit the new value before moving the caret.
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(caret, caret);
    });
  };

  return (
    <section className="message-composer-shell" aria-label="Write a message">
      <MessageTextarea
        value={draft}
        onChange={onDraft}
        onSend={guardedSend}
        disabled={sending}
        placeholder="Type a message…"
        className="message-composer__textarea"
        textareaRef={textareaRef}
      />

      <div className="composer-toolbar">
        <div className="composer-options">
          {/*
            A composer-local overlay rather than a portalled HeroUI Popover:
            RAC's popover moves focus onto its own dialog, which pulls the
            caret out of the draft after every insertion. An overlay that never
            takes focus keeps the textarea focused, so the caret the user left
            survives — and Escape / outside-click still close it explicitly.
          */}
          <div className="emoji-anchor">
            <Button
              variant="ghost"
              isIconOnly
              aria-label="Choose emoji"
              aria-haspopup="dialog"
              aria-expanded={emojiOpen}
              onPress={() => setEmojiOpen(open => !open)}
            >
              <IconSmile width={18} height={18} aria-hidden />
            </Button>

            {emojiOpen ? (
              <>
                <div
                  className="emoji-backdrop"
                  aria-hidden="true"
                  onClick={() => setEmojiOpen(false)}
                />
                <div
                  className="emoji-popover-panel"
                  role="dialog"
                  aria-label="Choose emoji"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setEmojiOpen(false);
                      textareaRef.current?.focus();
                    }
                  }}
                >
                  <Suspense fallback={<div className="emoji-picker__loading"><Spinner size="sm" /></div>}>
                    <LazyEmojiPicker onPick={onPickEmoji} />
                  </Suspense>
                </div>
              </>
            ) : null}
          </div>

          <SimSelector sims={sims} selected={selected} onSim={onSim} useDefault={useDefault} />
          <SmsCounter draft={draft} />
        </div>

        <Button
          className="composer-send"
          variant="primary"
          aria-label={sending ? "Sending message" : "Send message"}
          isDisabled={disabled}
          onPress={send}
        >
          {sending ? <Spinner size="sm" /> : <IconSend width={16} height={16} aria-hidden />}
          <span>{sending ? "Sending…" : "Send"}</span>
        </Button>
      </div>

      {help ? (
        <div className="mt-2">
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>SIM needs attention</Alert.Title>
              <Alert.Description>{help}</Alert.Description>
            </Alert.Content>
            <Button size="sm" variant="ghost" onPress={retry} isDisabled={refreshing === true}>
              {refreshing ? "Refreshing…" : "Refresh SIMs"}
            </Button>
          </Alert>
        </div>
      ) : null}

      {!canSend ? (
        <div className="mt-2">
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Sending is not approved for this browser</Alert.Title>
              <Alert.Description>
                Approve sending access for this browser on your Primary phone, then retry.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        </div>
      ) : null}

      <ComposerStatus status={status} />

      {refreshNotice ? (
        <p className="composer-hint composer-hint--notice" role="status">{refreshNotice}</p>
      ) : null}

      <p className="composer-hint">Ctrl+Enter / ⌘+Enter to send</p>
    </section>
  );
}
