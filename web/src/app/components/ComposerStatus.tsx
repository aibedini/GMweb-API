import { Spinner } from "@heroui/react";
import { commandFeedback, commandTone } from "../../lib/inboxActions";
import { IconCheck, IconWarning } from "./icons";

/**
 * §22: the command lifecycle as a single quiet status row instead of a raw
 * state dump. Actionable failures are surfaced separately as Alerts by the
 * composer, and transient outcomes use Toast.
 *
 * The tone classifier lives in `lib/inboxActions` so it stays unit-testable
 * without a DOM.
 */
export function ComposerStatus({ status }: { status: string | null }) {
  if (!status) return null;

  const text = commandFeedback(status) ?? status;
  const tone = commandTone(status);

  return (
    <p className={`composer-status composer-status--${tone}`} role="status">
      {tone === "pending" ? <Spinner size="sm" /> : null}
      {tone === "ok" ? <IconCheck width={14} height={14} aria-hidden /> : null}
      {tone === "failed" ? <IconWarning width={14} height={14} aria-hidden /> : null}
      <span>{text}</span>
    </p>
  );
}
