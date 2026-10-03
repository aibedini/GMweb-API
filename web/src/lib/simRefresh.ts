/**
 * "Refresh SIMs" orchestration.
 *
 * A refresh is NOT "re-read the last telemetry we already have" — that is what
 * the old button did, and it could never refresh anything. It is:
 *
 *   ask the phone (durable encrypted command) to re-report device telemetry
 *   → wait for the phone to ACK
 *   → then PROVE the server actually stored a newer report
 *
 * `receivedAt > baselineReceivedAt` is the only proof of success. A durable
 * command reaching COMPLETED only proves Android believes its POST succeeded.
 */
import type { DeviceTelemetry, LinkedDeviceStatus } from "./api.ts";
import { authoritativePhonePresence } from "./deviceState.ts";
import type { PhonePresence } from "./phonePresence.ts";

/** The protocol name. It carries device + SIM + permission state, not just SIM. */
export const REFRESH_COMMAND_TYPE = "REFRESH_DEVICE_TELEMETRY";

export const TELEMETRY_POLL_INTERVAL_MS = 500;
/** Max wait for a NEW telemetry row after the command completes. */
export const TELEMETRY_POLL_TIMEOUT_MS = 10_000;
/** Max total wait for the whole user action. */
export const REFRESH_TIMEOUT_MS = 15_000;

export type SimRefreshState =
  | { state: "IDLE" }
  | { state: "REQUESTING" }
  | { state: "WAITING_FOR_PHONE"; commandId: string }
  | { state: "WAITING_FOR_TELEMETRY"; commandId: string; baselineReceivedAt: number | null }
  | { state: "UPDATED"; receivedAt: number }
  | { state: "PHONE_OFFLINE" }
  | { state: "PHONE_STALE" }
  | { state: "UNSUPPORTED" }
  | { state: "COMMAND_FAILED"; errorCode: string }
  | { state: "TIMED_OUT" }
  | { state: "FAILED"; errorCode: string };

export const IDLE_SIM_REFRESH: SimRefreshState = { state: "IDLE" };

/**
 * Capability-based feature detection. NEVER infer support from versionName.
 *
 * PRIORITY: live runtime metadata first, telemetry only as a fallback.
 *
 * This ordering is the fix for a bootstrap deadlock. The PWA used to require
 * `telemetry.capabilities.commandTypes` before sending
 * REFRESH_DEVICE_TELEMETRY — but stale telemetry is exactly what that command
 * exists to repair. An upgraded phone could genuinely support the command while
 * GMweb kept reading an old pre-capability snapshot and refusing to ask.
 *
 * So: if the LIVE runtime advertises it, allow the refresh even when telemetry
 * is old, missing or pre-capability.
 *
 * An older telemetry snapshot is only trustworthy while it is still FRESH; a
 * stale one must not be used to claim support either way.
 */
export function supportsRemoteRefresh(
  deviceStatus?: LinkedDeviceStatus | null,
  telemetry?: DeviceTelemetry | null,
): boolean {
  const live = deviceStatus?.runtime?.commandTypes;
  if (Array.isArray(live)) {
    // An explicit live answer is authoritative, including "no".
    if (live.includes(REFRESH_COMMAND_TYPE)) return true;
    if (deviceStatus?.runtime?.receivedAt) return false;
  }
  // Fallback: telemetry, but only while it still describes the running phone.
  if (deviceStatus?.telemetry?.state && deviceStatus.telemetry.state !== "FRESH") return false;
  const list = telemetry?.capabilities?.commandTypes;
  if (!Array.isArray(list)) return false;
  return list.includes(REFRESH_COMMAND_TYPE);
}

/** Which source granted (or denied) remote refresh, for honest UI copy. */
export function remoteRefreshEvidence(
  deviceStatus?: LinkedDeviceStatus | null,
  telemetry?: DeviceTelemetry | null,
): "RUNTIME" | "TELEMETRY" | "NONE" {
  const live = deviceStatus?.runtime?.commandTypes;
  if (Array.isArray(live) && live.includes(REFRESH_COMMAND_TYPE)) return "RUNTIME";
  if (deviceStatus?.runtime?.receivedAt) return "NONE";
  if (deviceStatus?.telemetry?.state && deviceStatus.telemetry.state !== "FRESH") return "NONE";
  const list = telemetry?.capabilities?.commandTypes;
  return Array.isArray(list) && list.includes(REFRESH_COMMAND_TYPE) ? "TELEMETRY" : "NONE";
}

/** Success rule: a strictly newer SERVER receipt time, or first-ever report. */
export function telemetryAdvanced(
  baselineReceivedAt: number | null,
  next: Pick<DeviceTelemetry, "receivedAt"> | null | undefined,
): boolean {
  const receivedAt = next?.receivedAt;
  if (!Number.isFinite(receivedAt)) return false;
  if (baselineReceivedAt === null) return true;
  return Number(receivedAt) > baselineReceivedAt;
}

export function simRefreshInFlight(state: SimRefreshState): boolean {
  return state.state === "REQUESTING" || state.state === "WAITING_FOR_PHONE"
    || state.state === "WAITING_FOR_TELEMETRY";
}

export function simRefreshSucceeded(state: SimRefreshState): boolean {
  return state.state === "UPDATED";
}

/** Concise, honest copy. Never claims an update that did not happen. */
export function simRefreshCopy(state: SimRefreshState): string | null {
  switch (state.state) {
    case "IDLE": return null;
    case "REQUESTING": return "Requesting a fresh device report…";
    case "WAITING_FOR_PHONE": return "Waiting for the phone to accept the request…";
    case "WAITING_FOR_TELEMETRY": return "Waiting for a new device report…";
    case "UPDATED": return "SIM information updated.";
    case "PHONE_OFFLINE": return "Primary phone is offline. Reconnect the phone to refresh SIM information.";
    case "PHONE_STALE": return "Primary phone connection is stale. Waiting for a fresh device report.";
    case "UNSUPPORTED": return "Remote SIM refresh is not supported by this Android build.";
    case "COMMAND_FAILED": return "The phone rejected the refresh request.";
    case "TIMED_OUT": return "The phone did not answer in time.";
    case "FAILED": return "SIM information could not be refreshed.";
  }
}

/** Maps a durable command state to a terminal refresh failure, if any. */
export function refreshFailureForCommand(commandState: string | null | undefined): string | null {
  if (commandState === "FAILED") return "COMMAND_FAILED";
  if (commandState === "EXPIRED") return "EXPIRED";
  return null;
}

/**
 * STEP 3 + STEP 4 of the refresh flow, extracted so the decision is one
 * testable place rather than scattered state updates.
 *
 * A command is enqueued ONLY when the phone can plausibly receive it AND the
 * phone advertises the capability. An offline phone must never be handed a
 * command that will sit until it expires.
 */
export type SimRefreshPlan =
  | { action: "OFFLINE"; presence: PhonePresence }
  | { action: "UNSUPPORTED"; presence: PhonePresence }
  | { action: "PROCEED"; presence: PhonePresence; baselineReceivedAt: number | null };

export function planSimRefresh(
  deviceStatus: LinkedDeviceStatus | null | undefined,
  telemetry: DeviceTelemetry | null | undefined,
): SimRefreshPlan {
  const presence = authoritativePhonePresence(deviceStatus, telemetry);
  if (presence === "OFFLINE" || presence === "NEVER_SEEN") return { action: "OFFLINE", presence };
  // Capability-based feature detection; never a version comparison. Live
  // runtime metadata outranks stale telemetry so a stale snapshot cannot
  // deadlock the very command that would fix it.
  if (!supportsRemoteRefresh(deviceStatus, telemetry)) return { action: "UNSUPPORTED", presence };
  return { action: "PROCEED", presence, baselineReceivedAt: telemetry?.receivedAt ?? null };
}
