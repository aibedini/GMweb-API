import { Alert, Button, Spinner } from "@heroui/react";
import type { DeviceTelemetry } from "../lib/api";
import { sendDisabled } from "../lib/inboxActions";
import { ComposerStatus } from "./components/ComposerStatus";
import { SimSelector } from "./components/SimSelector";
import { SmsCounter } from "./components/SmsCounter";
import { IconSend } from "./components/icons";
import { MessageTextarea } from "./MessageTextarea";

type Sim = NonNullable<DeviceTelemetry["smsSubscriptions"]>["items"][number];

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
}) {
  const disabled = sendDisabled({ draft, sending, canSend, simInstructions: help });

  const guardedSend = () => {
    if (disabled) return;
    send();
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
      />

      <div className="composer-toolbar">
        <div className="composer-options">
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
            <Button size="sm" variant="ghost" onPress={retry}>
              Refresh SIMs
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

      <p className="composer-hint">Ctrl+Enter / ⌘+Enter to send</p>
    </section>
  );
}
