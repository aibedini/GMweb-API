/**
 * Send readiness: ONE deterministic model that owns composer gating.
 *
 * Replaces `simHelp()`, whose single string collapsed independent facts and
 * blocked sending whenever telemetry was older than 180s — even while the phone
 * was ONLINE and the user had chosen "Phone default". That is what produced the
 * contradictory UI: a SIM selector showing "SIM 2 · IR-MCI" next to
 * "SIM needs attention / Reconnect the Primary phone".
 *
 * The four facts below are INDEPENDENT and must never be derived from each other:
 *
 *   A. phone presence        ONLINE | STALE | OFFLINE | NEVER_SEEN
 *   B. telemetry freshness   FRESH | STALE | OLD | NEVER_REPORTED
 *   C. SIM discovery         OK | NOT_REPORTED | PERMISSION_UNAVAILABLE | NO_ACTIVE_SUBSCRIPTIONS
 *   D. selection mode        PHONE_DEFAULT | EXPLICIT_SIM
 *
 * Never derive (A) from (B): stale telemetry must not make a live phone offline.
 */
import type { TelemetryFreshness } from "./deviceState.ts";
import type { PhonePresence } from "./phonePresence.ts";
import type { SimTelemetryState, SimTelemetryView } from "./simTelemetry.ts";
import { simKey } from "./simSelection.ts";
import { classifySender } from "./senderIdentity.ts";

export type SendReadiness =
  | { state: "SENDING" }
  | { state: "EMPTY_BODY" }
  | { state: "NO_RECIPIENT" }
  | { state: "NOT_REPLYABLE"; senderKind: "ALPHANUMERIC" | "UNKNOWN" }
  | { state: "SEND_CAPABILITY_MISSING" }
  | { state: "PHONE_NEVER_SEEN" }
  | { state: "READY_DEFAULT" }
  | { state: "READY_EXPLICIT"; simKey: string }
  | { state: "EXPLICIT_SIM_TELEMETRY_STALE"; simKey: string }
  | { state: "EXPLICIT_SIM_MISSING"; simKey: string }
  /**
   * A line was chosen but the phone published no `simRef` for it.
   *
   * Blocking on purpose. The phone can only resolve a `simRef`, so without one the command would have
   * to name the line by subscription id — which current Android builds deliberately do not publish and
   * would ignore. Sending anyway would dispatch on whatever line the phone considers default, i.e. a
   * different line than the one the user selected, silently. Refusing is the only reversible option.
   */
  | { state: "EXPLICIT_SIM_UNROUTABLE"; simKey: string }
  | { state: "NO_ACTIVE_SIM" };

export interface SendReadinessInput {
  draft: string;
  hasRecipient: boolean;
  /**
   * The raw sender address being replied to. An alphanumeric sender ID such as
   * PARSIANBANK is NOT a dialable destination: GMweb must never issue
   * SEND_SMS recipient="PARSIANBANK" merely because it is a visible title.
   */
  recipientAddress?: string | null;
  canSend: boolean;
  sending: boolean;
  phonePresence: PhonePresence;
  telemetryFreshness: TelemetryFreshness;
  sim: Pick<SimTelemetryView, "state" | "active">;
  /**
   * The chosen line's selection key (see `simKey`), or null for PHONE_DEFAULT.
   *
   * A KEY rather than a subscription id: the durable identity is the opaque `simRef`, and an unnamespaced
   * number could collide with one.
   */
  selectedSimKey: string | null;
}

/**
 * The routing target to put in a `SEND_SMS` command, or undefined for the phone's own default.
 *
 * PHONE_DEFAULT MUST omit any target so Android resolves the CURRENT system default at execution time:
 * resolving it in the browser to a cached value would silently change the command's meaning.
 *
 * A `simRef` is sent as `simRef`, the opaque cross-system identity Android resolves against its live
 * inventory. A legacy `sub:` key is sent as `subscriptionId`, which only an older phone will act on.
 */
export function commandSimTarget(
  selectedSimKey: string | null,
): { simRef: string } | { subscriptionId: number } | undefined {
  if (selectedSimKey === null) return undefined;
  if (selectedSimKey.startsWith("ref:")) {
    const simRef = selectedSimKey.slice("ref:".length);
    return simRef.length > 0 ? { simRef } : undefined;
  }
  if (selectedSimKey.startsWith("sub:")) {
    const value = Number(selectedSimKey.slice("sub:".length));
    return Number.isSafeInteger(value) ? { subscriptionId: value } : undefined;
  }
  return undefined;
}

export function deriveSendReadiness(input: SendReadinessInput): SendReadiness {
  if (input.sending) return { state: "SENDING" };
  if (input.draft.trim().length === 0) return { state: "EMPTY_BODY" };
  if (!input.hasRecipient) return { state: "NO_RECIPIENT" };
  // Replyability is a property of the SENDER, not of the UI. An alphanumeric
  // sender ID is displayable but not addressable, so it must block sending
  // rather than silently dispatch an undeliverable SMS.
  if (input.recipientAddress !== undefined && input.recipientAddress !== null) {
    const identity = classifySender(input.recipientAddress);
    if (identity.kind === "ALPHANUMERIC" || identity.kind === "UNKNOWN") {
      return { state: "NOT_REPLYABLE", senderKind: identity.kind };
    }
  }
  if (!input.canSend) return { state: "SEND_CAPABILITY_MISSING" };
  // Only a phone that has never authenticated at all is unusable. OFFLINE and
  // STALE still allow a durable command to be queued for later claim.
  if (input.phonePresence === "NEVER_SEEN") return { state: "PHONE_NEVER_SEEN" };

  const selected = input.selectedSimKey;
  if (selected === null) {
    // PHONE_DEFAULT: a stale SIM snapshot must NOT block sending.
    if (input.telemetryFreshness === "FRESH"
        && input.sim.state === "NO_ACTIVE_SUBSCRIPTIONS") {
      // Authoritative and current: the phone really has no active SMS SIM.
      return { state: "NO_ACTIVE_SIM" };
    }
    return { state: "READY_DEFAULT" };
  }

  // A chosen line can only be routed by a handle the phone understands. Without one there is nothing
  // to send, and falling through to the default would dispatch on a line the user did not pick.
  if (commandSimTarget(selected) === undefined) {
    return { state: "EXPLICIT_SIM_UNROUTABLE", simKey: selected };
  }

  // EXPLICIT: strict. Fresh telemetry, chosen line still present.
  if (input.telemetryFreshness !== "FRESH") {
    return { state: "EXPLICIT_SIM_TELEMETRY_STALE", simKey: selected };
  }
  if (!input.sim.active.some(sim => simKey(sim) === selected)) {
    return { state: "EXPLICIT_SIM_MISSING", simKey: selected };
  }
  return { state: "READY_EXPLICIT", simKey: selected };
}

/** Blocking states. Everything else may send. */
export function sendBlocked(readiness: SendReadiness): boolean {
  switch (readiness.state) {
    case "READY_DEFAULT":
    case "READY_EXPLICIT":
      return false;
    default:
      return true;
  }
}

/**
 * Which surface a notice belongs to.
 *
 * PRODUCTION BUG this fixes: MessageComposer rendered EVERY notice inside a
 * hard-coded "SIM needs attention" alert with a "Refresh SIMs" button, so an
 * empty draft produced "SIM needs attention / Write a message first." — a
 * composer validation problem presented as a SIM fault.
 *
 * Only SIM_KIND states may claim a SIM problem or offer a SIM refresh.
 */
export type SendNoticeKind = "COMPOSER" | "PERMISSION" | "PHONE" | "SIM";

export interface SendNotice {
  kind: SendNoticeKind;
  /** Alert title. Never "SIM needs attention" for a non-SIM problem. */
  title: string;
  tone: "info" | "warning" | "danger";
  message: string;
  /** False when the notice is purely informational and sending is allowed. */
  blocking: boolean;
  /** True only where refreshing SIM data could actually help. */
  offersSimRefresh: boolean;
}

export function isSimNotice(notice: SendNotice | null): boolean {
  return notice?.kind === "SIM";
}

/**
 * Contextual copy. A warning that does not block must never read like a fault,
 * and nothing may tell the user to reconnect a phone that is ONLINE.
 */
export function sendReadinessNotice(readiness: SendReadiness): SendNotice | null {
  switch (readiness.state) {
    case "READY_DEFAULT":
    case "READY_EXPLICIT":
    case "SENDING":
      return null;
    // Composer validation: no alert at all — Send is simply disabled.
    case "EMPTY_BODY":
    case "NO_RECIPIENT":
      return null;
    // The sender is displayable but not addressable. This is a RECIPIENT
    // problem, not a SIM or phone problem, so it gets its own honest notice.
    case "NOT_REPLYABLE":
      return { kind: "COMPOSER", title: "Replies unavailable", tone: "info",
        message: "This sender ID is not a phone number, so it cannot receive a reply.",
        blocking: true, offersSimRefresh: false };
    // The composer already renders a dedicated, security-worded alert for a
    // missing SEND_MESSAGES capability; do not duplicate it here.
    case "SEND_CAPABILITY_MISSING":
      return null;
    case "PHONE_NEVER_SEEN":
      return { kind: "PHONE", title: "Phone unavailable", tone: "danger",
        message: "No Primary phone has connected yet. Pair your phone, then retry.",
        blocking: true, offersSimRefresh: false };
    case "NO_ACTIVE_SIM":
      return { kind: "SIM", title: "SIM needs attention", tone: "danger",
        message: "No active SMS SIM was detected. Insert an active SIM or check Phone permission.",
        blocking: true, offersSimRefresh: true };
    case "EXPLICIT_SIM_TELEMETRY_STALE":
      return { kind: "SIM", title: "SIM needs attention", tone: "warning",
        message: "This SIM was reported previously, but the SIM list is outdated. "
          + "Refresh SIM information before sending from a specific SIM, or use Phone default.",
        blocking: true, offersSimRefresh: true };
    case "EXPLICIT_SIM_MISSING":
      return { kind: "SIM", title: "SIM needs attention", tone: "warning",
        message: "Previously selected SIM is no longer active. Choose another SIM or use Phone default.",
        blocking: true, offersSimRefresh: true };
    case "EXPLICIT_SIM_UNROUTABLE":
      // Blocking, and explicit about why: sending would otherwise leave on a line the user did not
      // choose, since the phone cannot be told which one they meant.
      return { kind: "SIM", title: "SIM cannot be addressed", tone: "danger",
        message: "The phone did not publish an addressable identity for the selected SIM, so it cannot "
          + "be told which line to use. Refresh SIM information, or use Phone default.",
        blocking: true, offersSimRefresh: true };
  }
}

/**
 * Informational freshness note for PHONE_DEFAULT: sending stays enabled, but the
 * cached SIM list must not be presented as current.
 */
export function defaultModeFreshnessNotice(
  telemetryFreshness: TelemetryFreshness,
  displaySimLabel: string | null,
): SendNotice | null {
  if (telemetryFreshness === "FRESH") return null;
  const base = telemetryFreshness === "NEVER_REPORTED"
    ? "This phone has not reported SIM information yet."
    : "SIM information is outdated.";
  return {
    kind: "SIM",
    title: "SIM information is outdated",
    tone: "info",
    blocking: false,
    offersSimRefresh: true,
    message: displaySimLabel
      ? `${base} Last reported default: ${displaySimLabel}. Sending uses whatever default the phone has at that moment.`
      : `${base} Sending uses whatever default the phone has at that moment.`,
  };
}

/** True when the SIM list must be labelled as not-current in the selector. */
export function simListIsHistorical(freshness: TelemetryFreshness): boolean {
  return freshness !== "FRESH";
}

export function simDiscoveryLabel(state: SimTelemetryState): string | null {
  switch (state) {
    case "OK": return null;
    case "NOT_REPORTED": return "SIM list not reported";
    case "PERMISSION_UNAVAILABLE": return "Phone permission required";
    case "NO_ACTIVE_SUBSCRIPTIONS": return "No active SIM";
  }
}
