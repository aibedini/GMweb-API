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

export function simHelp(telemetry: { receivedAt: number; smsSubscriptions?: { available: boolean } } | null,
  selectedAvailable: boolean, now = Date.now()): string | null {
  if (!telemetry) return "Waiting for your phone. Open Messages on the Primary phone and check its connection.";
  if (now - telemetry.receivedAt > 180_000) return "Your phone's SIM information is out of date. Reconnect the Primary phone, then retry.";
  if (!telemetry.smsSubscriptions) return "Your phone has not reported its SIMs. Update Messages on the Primary phone and check Phone permission.";
  if (!telemetry.smsSubscriptions.available) return "Allow Phone permission for Messages on the Primary phone, then retry.";
  if (!selectedAvailable) return "Choose an active SMS SIM on your phone, then retry. Your saved SIM may no longer be available.";
  return null;
}

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
    LOCAL_OUTBOX_FAILED: "Could not save the send locally. Check browser storage and retry.",
    COMMAND_CREATE_FAILED: "Could not confirm the send request. Retry will reuse the saved request.",
    COMMAND_POLL_FAILED: "Could not check the request. Its outcome is still unknown; reconnect to check.",
    COMMAND_FAILED: "The phone could not complete this send. Check the phone before retrying.",
    COMMAND_EXPIRED: "The send request expired. Reconnect the phone before retrying.",
  };
  return messages[status] || androidError(status);
}
