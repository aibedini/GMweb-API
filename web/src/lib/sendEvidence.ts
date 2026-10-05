/**
 * Send evidence: one status model for a send, with explicit precedence.
 *
 * PRODUCTION INCIDENT (real screenshot): the sent bubble showed "Delivered"
 * while the composer footer still showed "Queued" with a spinner. That must be
 * impossible.
 *
 * Root cause: TWO independent writers owned one UI slot with no precedence.
 *   1. carrier/message evidence (App.tsx send-evidence effect) — HIGH truth, but
 *      it only ran when the evidence happened to be inside the CURRENTLY
 *      RENDERED thread (`messages.find(payload.clientMessageId === id)`), so it
 *      silently did nothing whenever the row was not loaded.
 *   2. the command-lifecycle poll — LOW truth, but unconditional: it called
 *      setCommandStatus(...) once per second and overwrote the slot.
 * Last-write-wins, so a stale "Queued" command view could outlive true
 * "Delivered" evidence.
 *
 * The fix is NOT to hide the command view. It is to give ONE model both inputs
 * and make precedence explicit and total, so the higher-truth source wins no
 * matter what order the two writers run in — and to RECORD the divergence
 * instead of discarding it.
 */

export type SendEvidenceState =
  | "LOCAL_QUEUED"
  | "SERVER_QUEUED"
  | "PHONE_CLAIMED"
  | "PHONE_ACCEPTED"
  | "SENT"
  | "DELIVERED"
  | "FAILED";

/** Where the rendered status came from. Highest applicable source wins. */
export type SendEvidenceSource = "message" | "command" | "local";

export interface SendEvidenceView {
  /** What the user sees. */
  text: string;
  state: SendEvidenceState;
  source: SendEvidenceSource;
  /** True once no further progress is expected; clears the spinner. */
  terminal: boolean;
  /** True while the user should still see progress. */
  pending: boolean;
}

/**
 * Precedence, highest first:
 *   authoritative carrier evidence (FAILED / DELIVERED)
 *   > SENT
 *   > PHONE_ACCEPTED / PHONE_CLAIMED
 *   > command lifecycle (SERVER_QUEUED)
 *   > local pending (LOCAL_QUEUED)
 *
 * Message evidence always outranks the command lifecycle: the command endpoint
 * describes what the PHONE was asked to do, the message row describes what the
 * CARRIER did. Only one of those is delivery truth.
 */
const RANK: Record<SendEvidenceState, number> = {
  FAILED: 70,
  DELIVERED: 60,
  SENT: 50,
  PHONE_ACCEPTED: 40,
  PHONE_CLAIMED: 35,
  SERVER_QUEUED: 20,
  LOCAL_QUEUED: 10
};

export const TERMINAL_EVIDENCE: readonly SendEvidenceState[] = ["DELIVERED", "FAILED"];

/**
 * Maps the Android message status integer to an evidence state.
 * Mirrors messageStatusLabel(): 0 Delivered, 32 Queued, 64 Failed, else Sent.
 */
export function evidenceStateForStatus(status: number | undefined | null): SendEvidenceState | null {
  if (status === undefined || status === null) return null;
  if (status === 64) return "FAILED";
  if (status === 0) return "DELIVERED";
  if (status === 32) return "SERVER_QUEUED";
  return "SENT";
}

const LABEL: Record<SendEvidenceState, string> = {
  FAILED: "Failed",
  DELIVERED: "Delivered",
  SENT: "Sent",
  PHONE_ACCEPTED: "Submitting",
  PHONE_CLAIMED: "Pulled by phone",
  SERVER_QUEUED: "Queued",
  LOCAL_QUEUED: "Queued locally"
};

export const EVIDENCE_TEXT: Readonly<Record<SendEvidenceState, string>> = LABEL;

/** Best-effort classification of an existing commandStatus string. */
export function commandStateForText(commandStatus: string | null | undefined): SendEvidenceState | null {
  if (!commandStatus) return null;
  const text = commandStatus.trim();
  if (!text) return null;
  if (/^(Delivered|Failed|Sent)$/i.test(text)) return evidenceStateForStatus(
    text.toLowerCase() === "delivered" ? 0 : text.toLowerCase() === "failed" ? 64 : 1);
  if (/pulled by phone|delivered_to_agent/i.test(text)) return "PHONE_CLAIMED";
  if (/submitting|accepted_by_agent|executing/i.test(text)) return "PHONE_ACCEPTED";
  if (/queued locally|preparing|encrypting/i.test(text)) return "LOCAL_QUEUED";
  if (/queued|waiting for phone|accepted by gmweb|command completed/i.test(text)) return "SERVER_QUEUED";
  // Anything else is a failure code or an unclassified command state.
  return /FAILED|EXPIRED|_FAILED$/.test(text) ? null : null;
}

export interface ResolveSendStatusInput {
  /** Evidence from the carrier/message row, if the row is available. */
  evidenceStatus?: number | null;
  /** The command-lifecycle string currently known, if any. */
  commandStatus?: string | null;
}

/**
 * Resolve the single status to render.
 *
 * `evidenceStatus` (message row) outranks `commandStatus` (command lifecycle)
 * ALWAYS, when present. This is what makes "Delivered bubble + Queued footer"
 * unrepresentable: the footer is derived from the same inputs as the bubble.
 */
export function resolveSendStatus(input: ResolveSendStatusInput): SendEvidenceView {
  const evidence = evidenceStateForStatus(input.evidenceStatus);
  const command = commandStateForText(input.commandStatus);

  let state: SendEvidenceState;
  let source: SendEvidenceSource;
  if (evidence && (!command || RANK[evidence] >= RANK[command])) {
    state = evidence;
    source = "message";
  } else if (command) {
    state = command;
    source = "command";
  } else if (input.commandStatus) {
    // An unclassified command string is still better than nothing.
    return { text: input.commandStatus, state: "SERVER_QUEUED", source: "command",
      terminal: false, pending: true };
  } else if (evidence) {
    state = evidence;
    source = "message";
  } else {
    return { text: "", state: "LOCAL_QUEUED", source: "local", terminal: false, pending: false };
  }

  const terminal = TERMINAL_EVIDENCE.includes(state);
  return { text: LABEL[state], state, source, terminal, pending: !terminal };
}

export interface SendDivergence {
  code: "SEND_COMMAND_EVIDENCE_DIVERGENCE";
  commandState: SendEvidenceState | null;
  evidenceState: SendEvidenceState;
  commandStatus: string | null;
}

/**
 * A divergence is carrier evidence that has ALREADY settled while the command
 * lifecycle still claims the send is queued or in flight. Privacy-safe: no
 * phone number, no body, no ciphertext — callers hash the ids.
 */
export function detectSendDivergence(input: ResolveSendStatusInput): SendDivergence | null {
  const evidence = evidenceStateForStatus(input.evidenceStatus);
  if (!evidence || !TERMINAL_EVIDENCE.includes(evidence)) return null;
  const command = commandStateForText(input.commandStatus);
  if (command && RANK[command] >= RANK[evidence]) return null;
  return { code: "SEND_COMMAND_EVIDENCE_DIVERGENCE", commandState: command,
    evidenceState: evidence, commandStatus: input.commandStatus ?? null };
}

/** Short, non-reversible hash for diagnostics. Not a security boundary. */
export function diagnosticHash(value: string | null | undefined): string | null {
  if (!value) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
