/**
 * The ONE place phone liveness is decided on the client.
 *
 * Production bug this prevents: the top bar read presence from the authoritative
 * server status while `refreshSims()` re-derived it from `telemetry.receivedAt`,
 * so a 3-day-old telemetry record made the composer claim
 * "Primary phone is offline" while the phone was demonstrably online.
 *
 * Liveness and telemetry freshness are different facts. The server observes
 * authenticated phone activity, so its answer always wins; the local derivation
 * exists only for the case where that endpoint is unreachable.
 */
import type { DeviceTelemetry, LinkedDeviceStatus } from "./api.ts";
import { derivePhonePresence, type PhonePresence } from "./phonePresence.ts";

export function authoritativePhonePresence(
  deviceStatus: LinkedDeviceStatus | null | undefined,
  telemetry: DeviceTelemetry | null | undefined,
): PhonePresence {
  const reported = deviceStatus?.phone?.state;
  if (reported) return reported as PhonePresence;
  // Fallback ONLY when GET /api/v1/linked-device/status is unavailable.
  return derivePhonePresence(telemetry?.receivedAt ?? null);
}

/**
 * Server-reported telemetry freshness, with a local age-based fallback so the
 * UI still behaves when the status endpoint is down.
 */
export type TelemetryFreshness = "FRESH" | "STALE" | "OLD" | "NEVER_REPORTED";

export function authoritativeTelemetryFreshness(
  deviceStatus: LinkedDeviceStatus | null | undefined,
  telemetry: DeviceTelemetry | null | undefined,
  now: number = Date.now(),
): TelemetryFreshness {
  const reported = deviceStatus?.telemetry?.state;
  if (reported) return reported as TelemetryFreshness;
  const receivedAt = telemetry?.receivedAt;
  if (!Number.isFinite(receivedAt)) return "NEVER_REPORTED";
  const age = Math.max(0, now - Number(receivedAt));
  if (age <= 90_000) return "FRESH";
  if (age <= 24 * 3600_000) return "STALE";
  return "OLD";
}

/** True when the phone is reachable enough to be expected to answer a command. */
export function phoneCanReceiveCommands(presence: PhonePresence): boolean {
  return presence === "ONLINE" || presence === "STALE";
}
