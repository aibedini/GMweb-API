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

export type SendReadiness =
  | { state: "SENDING" }
  | { state: "EMPTY_BODY" }
  | { state: "NO_RECIPIENT" }
  | { state: "SEND_CAPABILITY_MISSING" }
  | { state: "PHONE_NEVER_SEEN" }
  | { state: "READY_DEFAULT" }
  | { state: "READY_EXPLICIT"; subscriptionId: number }
  | { state: "EXPLICIT_SIM_TELEMETRY_STALE"; subscriptionId: number }
  | { state: "EXPLICIT_SIM_MISSING"; subscriptionId: number }
  | { state: "NO_ACTIVE_SIM" };

export interface SendReadinessInput {
  draft: string;
  hasRecipient: boolean;
  canSend: boolean;
  sending: boolean;
  phonePresence: PhonePresence;
  telemetryFreshness: TelemetryFreshness;
  sim: Pick<SimTelemetryView, "state" | "active">;
  /** null === PHONE_DEFAULT. */
  selectedSubscriptionId: number | null;
}

/** The explicit subscription id to put in the command, if any. */
export function commandSubscriptionId(selectedSubscriptionId: number | null): number | undefined {
  // PHONE_DEFAULT must OMIT subscriptionId so Android resolves the CURRENT
  // system default at execution time. Resolving it in Web to a cached id would
  // silently change the command's semantics.
  return selectedSubscriptionId === null ? undefined : selectedSubscriptionId;
}

export function deriveSendReadiness(input: SendReadinessInput): SendReadiness {
  if (input.sending) return { state: "SENDING" };
  if (input.draft.trim().length === 0) return { state: "EMPTY_BODY" };
  if (!input.hasRecipient) return { state: "NO_RECIPIENT" };
  if (!input.canSend) return { state: "SEND_CAPABILITY_MISSING" };
  // Only a phone that has never authenticated at all is unusable. OFFLINE and
  // STALE still allow a durable command to be queued for later claim.
  if (input.phonePresence === "NEVER_SEEN") return { state: "PHONE_NEVER_SEEN" };

  const selected = input.selectedSubscriptionId;
  if (selected === null) {
    // PHONE_DEFAULT: a stale SIM snapshot must NOT block sending.
    if (input.telemetryFreshness === "FRESH"
        && input.sim.state === "NO_ACTIVE_SUBSCRIPTIONS") {
      // Authoritative and current: the phone really has no active SMS SIM.
      return { state: "NO_ACTIVE_SIM" };
    }
    return { state: "READY_DEFAULT" };
  }

  // EXPLICIT: strict. Fresh telemetry, subscription still present.
  if (input.telemetryFreshness !== "FRESH") {
    return { state: "EXPLICIT_SIM_TELEMETRY_STALE", subscriptionId: selected };
  }
  if (!input.sim.active.some(sim => sim.subscriptionId === selected)) {
    return { state: "EXPLICIT_SIM_MISSING", subscriptionId: selected };
  }
  return { state: "READY_EXPLICIT", subscriptionId: selected };
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
