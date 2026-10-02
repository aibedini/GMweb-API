/**
 * SIM telemetry interpretation.
 *
 * The current UI collapsed four genuinely different phone states into one
 * "SIM needs attention" line. They mean different things and need different
 * copy — and one of them (no active subscription) is not an error at all.
 */
import type { DeviceTelemetry } from "./api.ts";
import { formatAge, type PhonePresence } from "./phonePresence.ts";

export type SimTelemetryState =
  /** `smsSubscriptions` is absent: the phone has not published compatible SIM telemetry. */
  | "NOT_REPORTED"
  /** `available === false`: the phone cannot enumerate SIMs (permission/state). */
  | "PERMISSION_UNAVAILABLE"
  /** `available === true`, zero items: the phone reports no active SMS subscription. */
  | "NO_ACTIVE_SUBSCRIPTIONS"
  /** Populated and usable. */
  | "OK";

export interface SimTelemetryView {
  state: SimTelemetryState;
  /** Active, send-capable subscriptions. */
  active: NonNullable<DeviceTelemetry["smsSubscriptions"]>["items"];
  /** True when the phone snapshot is old enough that it must be labelled stale. */
  stale: boolean;
  ageMs: number | null;
  /** Concise user-facing copy; never claims freshness it does not have. */
  copy: string;
}

export function describeSimTelemetry(
  telemetry: DeviceTelemetry | null,
  now: number = Date.now(),
  phonePresence: PhonePresence = "ONLINE",
): SimTelemetryView {
  if (!telemetry) {
    return { state: "NOT_REPORTED", active: [], stale: false, ageMs: null,
      copy: "SIM information has not been reported by the phone." };
  }
  const ageMs = Number.isFinite(telemetry.receivedAt) ? Math.max(0, now - telemetry.receivedAt) : null;
  const stale = ageMs !== null && ageMs > 180_000;
  const subscriptions = telemetry.smsSubscriptions;
  const active = subscriptions?.items.filter(sim => sim.isActive && sim.sendCapable !== false) ?? [];

  if (!subscriptions) {
    return { state: "NOT_REPORTED", active, stale, ageMs,
      copy: "SIM information has not been reported by the phone." };
  }
  if (!subscriptions.available) {
    return { state: "PERMISSION_UNAVAILABLE", active, stale, ageMs,
      copy: "Phone access is required to read SIM information." };
  }
  if (active.length === 0) {
    return { state: "NO_ACTIVE_SUBSCRIPTIONS", active, stale, ageMs,
      copy: "No active SMS SIM was detected." };
  }
  if (phonePresence === "OFFLINE" || phonePresence === "NEVER_SEEN") {
    return { state: "OK", active, stale: true, ageMs,
      copy: `Primary phone is offline. SIM information cannot be refreshed.${
        ageMs === null ? "" : ` Last SIM data received ${formatAge(telemetry.receivedAt, now)}.`}` };
  }
  return { state: "OK", active, stale, ageMs,
    copy: stale
      ? `SIM information is outdated (${formatAge(telemetry.receivedAt, now)}).`
      : `SIM data updated ${formatAge(telemetry.receivedAt, now)}.` };
}

/**
 * A remembered SIM selection is only usable while that subscription is still
 * present in FRESH telemetry. Silently falling back to another SIM would send
 * an SMS from a SIM the user did not choose, so this returns a distinct state.
 */
export function validateSelectedSim(
  selectedSubscriptionId: number | null,
  active: SimTelemetryView["active"],
  stale: boolean,
): { state: "DEFAULT" | "ACTIVE" | "STALE" | "MISSING"; message: string | null } {
  if (selectedSubscriptionId === null) return { state: "DEFAULT", message: null };
  const match = active.find(sim => sim.subscriptionId === selectedSubscriptionId);
  if (!match) {
    return { state: "MISSING",
      message: "Previously selected SIM is no longer active. Choose an active SIM and retry." };
  }
  if (stale) {
    return { state: "STALE",
      message: "The selected SIM comes from an outdated report. Refresh before sending." };
  }
  return { state: "ACTIVE", message: null };
}

/**
 * §20: "Refresh SIMs" must never fake success.
 *
 * GMweb can only re-read the last telemetry the phone published; there is no
 * Android-side command to force re-enumeration yet (see ANDROID_DEPENDENCY).
 * So the honest outcomes are "a newer report arrived" or "no newer report
 * arrived" — never a green "refreshed" tick.
 */
export type SimRefreshOutcome =
  | "IDLE" | "CHECKING" | "UPDATED" | "NO_NEW" | "PHONE_OFFLINE" | "STALE" | "FAILED";

export interface SimRefreshResult {
  outcome: SimRefreshOutcome;
  message: string | null;
}

export function simRefreshMessage(outcome: SimRefreshOutcome): SimRefreshResult {
  switch (outcome) {
    case "IDLE":
      return { outcome, message: null };
    case "CHECKING":
      return { outcome, message: "Checking for a newer SIM report…" };
    case "UPDATED":
      return { outcome, message: "SIM information updated." };
    case "NO_NEW":
      return { outcome,
        message: "No newer SIM report has been received from the phone." };
    case "PHONE_OFFLINE":
      return { outcome, message: "Primary phone is offline. SIM information cannot be refreshed." };
    case "STALE":
      return { outcome, message: "Primary phone connection is stale. Waiting for a fresh SIM report." };
    case "FAILED":
      return { outcome, message: "SIM information could not be refreshed." };
  }
}

/**
 * Decide the outcome of a user-initiated refresh by comparing the report the
 * phone has published before and after the refetch. A refetch that returns the
 * SAME `receivedAt` has learned nothing and must not be presented as success.
 */
export function classifySimRefresh(input: {
  previousReceivedAt: number | null;
  nextReceivedAt: number | null;
  presence: PhonePresence;
}): SimRefreshOutcome {
  if (input.presence === "OFFLINE" || input.presence === "NEVER_SEEN") return "PHONE_OFFLINE";
  if (input.nextReceivedAt === null || input.nextReceivedAt === undefined) return "NO_NEW";
  if (input.previousReceivedAt === null) return "UPDATED";
  if (input.nextReceivedAt > input.previousReceivedAt) return "UPDATED";
  // Same report: honest "nothing new", and flag a stale phone separately.
  return input.presence === "STALE" ? "STALE" : "NO_NEW";
}
