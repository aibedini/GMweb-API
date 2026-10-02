/**
 * Primary-phone presence.
 *
 * The browser being able to reach the GMweb API proves NOTHING about the
 * Android phone. Presence must come from the phone's own server-side receipt
 * time, so this module deliberately takes the server's `receivedAt` (when the
 * API last accepted telemetry), never an Android wall-clock timestamp.
 *
 * Thresholds are centralised here rather than sprinkled through components.
 */

export type PhonePresence = "ONLINE" | "STALE" | "OFFLINE" | "NEVER_SEEN";

/** Telemetry cadence is ~60s, so one missed report is still healthy. */
export const PHONE_ONLINE_MS = 90_000;
export const PHONE_STALE_MS = 180_000;

/**
 * @param receivedAt server receipt time of the newest telemetry (ms epoch), or
 *        null/undefined when the phone has never reported.
 * @param now injectable for tests.
 */
export function derivePhonePresence(
  receivedAt: number | null | undefined,
  now: number = Date.now(),
): PhonePresence {
  if (receivedAt === null || receivedAt === undefined) return "NEVER_SEEN";
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) return "NEVER_SEEN";
  // A future timestamp is clock skew, not evidence of a live phone: clamp it
  // rather than reporting a negative age.
  const age = Math.max(0, now - receivedAt);
  if (age <= PHONE_ONLINE_MS) return "ONLINE";
  if (age <= PHONE_STALE_MS) return "STALE";
  return "OFFLINE";
}

export function phonePresenceLabel(presence: PhonePresence): string {
  switch (presence) {
    case "ONLINE": return "Online";
    case "STALE": return "Stale";
    case "OFFLINE": return "Offline";
    default: return "Never connected";
  }
}

/** Compact, human age. Deliberately coarse — this is not a stopwatch. */
export function formatAge(from: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** "Online · last seen 18 sec ago" / "Never connected". */
export function describePhone(receivedAt: number | null | undefined, now: number = Date.now()): string {
  const presence = derivePhonePresence(receivedAt, now);
  if (presence === "NEVER_SEEN") return "Never connected";
  return `${phonePresenceLabel(presence)} · last seen ${formatAge(receivedAt as number, now)}`;
}

/** True when an Android-dependent action cannot succeed right now. */
export function phoneBlocksRemoteAction(presence: PhonePresence): boolean {
  return presence === "OFFLINE" || presence === "NEVER_SEEN";
}
