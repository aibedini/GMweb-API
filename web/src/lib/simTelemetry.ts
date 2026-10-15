/**
 * SIM telemetry interpretation.
 *
 * The current UI collapsed four genuinely different phone states into one
 * "SIM needs attention" line. They mean different things and need different
 * copy â€” and one of them (no active subscription) is not an error at all.
 */
import type { DeviceTelemetry } from "./api.ts";
import { formatAge, type PhonePresence } from "./phonePresence.ts";
import type { TelemetryFreshness } from "./deviceState.ts";

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

/**
 * The copy matrix. Phone liveness, telemetry freshness and SIM discovery are
 * three separate facts and are never collapsed.
 *
 * The production bug: an ONLINE phone with old telemetry produced
 * "Primary phone is offline. SIM information cannot be refreshed." â€” blaming
 * liveness for a freshness problem.
 */
export function simStatusCopy(
  phonePresence: PhonePresence,
  freshness: TelemetryFreshness,
  discovery: SimTelemetryState,
  now: number = Date.now(),
  receivedAt: number | null = null,
): string {
  // Liveness dominates: if we genuinely cannot reach the phone, say only that.
  if (phonePresence === "OFFLINE" || phonePresence === "NEVER_SEEN") {
    return "Primary phone is offline. Reconnect the phone to refresh SIM information.";
  }
  if (phonePresence === "STALE") {
    return "Primary phone connection is stale. Waiting for a fresh device report.";
  }
  // From here the phone IS online: never blame liveness again.
  if (freshness === "NEVER_REPORTED") {
    return "Primary phone is online. SIM information has not been reported yet.";
  }
  // A stale report is the dominant fact: we cannot tell whether its contents
  // are still true, so "outdated" beats any discovery detail it carries.
  if (freshness !== "FRESH") {
    return "Primary phone is online. SIM information is outdated.";
  }
  if (discovery === "PERMISSION_UNAVAILABLE") {
    return "Phone access is required to read SIM information.";
  }
  if (discovery === "NO_ACTIVE_SUBSCRIPTIONS") {
    return "No active SMS SIM was detected.";
  }
  if (discovery === "NOT_REPORTED") {
    return "Primary phone is online. SIM information has not been reported yet.";
  }
  return receivedAt === null
    ? "SIM information is up to date."
    : `SIM data updated ${formatAge(receivedAt, now)}.`;
}

export function describeSimTelemetry(
  telemetry: DeviceTelemetry | null,
  now: number = Date.now(),
  phonePresence: PhonePresence = "ONLINE",
  freshness?: TelemetryFreshness,
): SimTelemetryView {
  const ageMs = telemetry && Number.isFinite(telemetry.receivedAt)
    ? Math.max(0, now - telemetry.receivedAt) : null;
  const stale = ageMs !== null && ageMs > 180_000;
  const subscriptions = telemetry?.smsSubscriptions;
  const active = subscriptions?.items.filter(sim => sim.isActive && sim.sendCapable !== false) ?? [];

  // Derive freshness locally only when the caller did not supply the server's.
  const resolved: TelemetryFreshness = freshness ?? (
    !telemetry || ageMs === null ? "NEVER_REPORTED"
      : ageMs <= 90_000 ? "FRESH"
        : ageMs <= 24 * 3600_000 ? "STALE" : "OLD");

  const state: SimTelemetryState = !subscriptions ? "NOT_REPORTED"
    : !subscriptions.available ? "PERMISSION_UNAVAILABLE"
      : active.length === 0 ? "NO_ACTIVE_SUBSCRIPTIONS" : "OK";

  return {
    state, active, stale, ageMs,
    copy: simStatusCopy(phonePresence, resolved, state, now, telemetry?.receivedAt ?? null),
  };
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

