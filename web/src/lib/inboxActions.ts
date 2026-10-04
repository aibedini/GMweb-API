import type { ConversationProjection } from "./inbox.ts";
import { androidError } from "../../../shared/smsStatus.ts";

export function phoneKey(value: string): string {
  const digits = value.replace(/[۰-۹]/g, char => String(char.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, char => String(char.charCodeAt(0) - 1632)).replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) return `98${digits.slice(1)}`;
  return digits.startsWith("00") ? digits.slice(2) : digits;
}

export function contactTitle(row: ConversationProjection, names: Map<string, string>): ConversationProjection {
  const phone = row.subtitle || row.title;
  const title = names.get(phoneKey(phone));
  return title ? { ...row, title, subtitle: phone } : row;
}

export function applyReadConfirmation(row: ConversationProjection, confirmedSequence: number): ConversationProjection {
  return row.lastSequence <= confirmedSequence ? { ...row, read: true, unreadCount: 0 } : row;
}

// The legacy `simHelp()` lived here. It was REMOVED from send gating because it
// collapsed independent facts into one blocking string and treated telemetry
// older than 180s as a global blocker — including for "Phone default", which
// does not depend on the SIM list at all. Structured readiness now lives in
// web/src/lib/sendReadiness.ts (deriveSendReadiness / sendReadinessNotice).

export function commandFeedback(status: string | null): string | null {
  if (!status) return null;
  const messages: Record<string, string> = {
    EMPTY_BODY: "Write a message first.", NO_RECIPIENT: "Choose a recipient first.",
    SEND_CAPABILITY_MISSING: "This browser cannot send. Approve sending access on your Primary phone.",
    SIM_STATE_UNAVAILABLE: "SIM information is not ready. Follow the phone instructions above.",
    SELECTED_SIM_UNAVAILABLE: "The selected SIM is unavailable. Choose an active SIM and retry.",
    BROWSER_IDENTITY_UNAVAILABLE: "Browser identity is unavailable. Link this browser again.",
    DEVICE_COMMAND_KEY_UNAVAILABLE: "The phone's encryption key is unavailable. Check its connection.",
    ENCRYPTION_FAILED: "Could not encrypt this message. Your draft is saved; retry.",
    // Command crypto failures, mapped explicitly so a key-format problem is
    // never reported as a generic encryption error. Raw WebCrypto exception
    // text is deliberately never shown.
    COMMAND_KEY_UNAVAILABLE: "Phone encryption key is unavailable.",
    COMMAND_KEY_INVALID: "Phone encryption key is invalid. Reconnect the Primary phone.",
    COMMAND_KEY_FORMAT_UNSUPPORTED: "Phone encryption key format is not supported. Update Messages and retry.",
    COMMAND_CRYPTO_IMPORT_FAILED: "Could not securely prepare this message.",
    COMMAND_CRYPTO_FAILED: "Could not securely prepare this message.",
    LOCAL_OUTBOX_FAILED: "Could not save the send locally. Check browser storage and retry.",
    COMMAND_CREATE_FAILED: "Could not confirm the send request. Retry will reuse the saved request.",
    COMMAND_POLL_FAILED: "Could not check the request. Its outcome is still unknown; reconnect to check.",
    COMMAND_FAILED: "The phone could not complete this send. Check the phone before retrying.",
    COMMAND_EXPIRED: "The send request expired. Reconnect the phone before retrying.",
  };
  return messages[status] || androidError(status);
}

/** Presentation tone for the authoritative command lifecycle (§22). */
export type CommandTone = "pending" | "ok" | "failed";

export function commandTone(status: string): CommandTone {
  const value = status.toLowerCase();
  if (/(failed|expired|unavailable|missing|empty_body|no_recipient|needs retry)/.test(value)) {
    return "failed";
  }
  if (/(delivered|sent|completed)/.test(value) && !/waiting/.test(value)) return "ok";
  return "pending";
}

export interface ComposerSendGate {
  draft: string;
  sending: boolean;
  /** `SEND_MESSAGES` capability from the linked session. */
  canSend: boolean;
  /** BLOCKING notice from the structured send-readiness model, if any. */
  simInstructions: string | null;
}

/**
 * The single send-enablement rule for the composer.
 *
 * Both the Send button's disabled state and the keyboard shortcut guard use
 * this, so the button and the shortcut can never disagree.
 *
 * `simInstructions` now carries the BLOCKING notice from
 * `deriveSendReadiness()`; PHONE_DEFAULT freshness warnings are informational
 * and deliberately do not arrive here.
 */
export function sendDisabled(gate: ComposerSendGate): boolean {
  return gate.sending || !gate.canSend || gate.draft.trim().length === 0 || Boolean(gate.simInstructions);
}

