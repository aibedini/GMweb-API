import { decodeEventPayload } from "../inbox.ts";
import type { StoredEvent } from "../sync.ts";

/**
 * The sticky SIM a conversation is pinned to, as the BROWSER understands it.
 *
 * `simRef` is an opaque, keyed token minted by Android (`sim:v1:<32 hex>`). The browser can display
 * and forward it but can never invert it into a subscription id, and the server never sees it at all —
 * it travels only inside the encrypted conversation payload.
 */
export interface PreferredSim {
  simRef: string;
  displayName?: string;
  carrierName?: string;
  slotIndex?: number;
}

/**
 * The three states a conversation can be in, and they are NOT interchangeable.
 *
 * ```text
 * absentField  legacy / no-update -> leave whatever is already known alone
 * null         authoritative clear -> the user returned to the phone default
 * value        authoritative set
 * ```
 *
 * The distinction is the whole reason this is not simply `PreferredSim | null`. A `null` return from a
 * "latest wins" reducer cannot distinguish "this event cleared it" from "this event did not mention
 * it", and collapsing them means an ordinary message-driven upsert — which carries no `preferredSim`
 * at all — would silently unpin a conversation the user had chosen a line for.
 */
export type PreferredSimState =
  | { kind: "absent" }
  | { kind: "cleared" }
  | { kind: "set"; value: PreferredSim };

export const ABSENT: PreferredSimState = { kind: "absent" };
export const CLEARED: PreferredSimState = { kind: "cleared" };

/** The simRef format Android mints. Anything else is not a reference we can forward. */
const SIM_REF_PATTERN = /^sim:v1:[0-9a-f]{32}$/;

/**
 * Build the state from one decrypted conversation payload.
 *
 * Returns [ABSENT] for a payload that does not mention the field — including the common case of a
 * message-driven upsert, which is exactly why callers must not treat absent as "clear".
 *
 * A malformed `simRef` is treated as ABSENT rather than as a clear: it is a value we cannot use, not an
 * instruction to unpin. Reporting it as a clear would let a corrupt payload destroy a preference.
 */
export function preferredSimStateFromPayload(
  payload: Record<string, unknown> | null | undefined,
): PreferredSimState {
  if (!payload || !("preferredSim" in payload)) return ABSENT;
  const raw = payload["preferredSim"];
  if (raw === null) return CLEARED;
  if (typeof raw !== "object" || Array.isArray(raw)) return ABSENT;
  const record = raw as Record<string, unknown>;
  const simRef = typeof record.simRef === "string" ? record.simRef : "";
  if (!SIM_REF_PATTERN.test(simRef)) return ABSENT;
  return {
    kind: "set",
    value: {
      simRef,
      ...(typeof record.displayName === "string" && record.displayName.trim()
        ? { displayName: record.displayName.trim() } : {}),
      ...(typeof record.carrierName === "string" && record.carrierName.trim()
        ? { carrierName: record.carrierName.trim() } : {}),
      ...(Number.isInteger(record.slotIndex) && (record.slotIndex as number) >= 0
        ? { slotIndex: record.slotIndex as number } : {}),
    },
  };
}

/**
 * The conversation's sticky SIM, folded from its whole local event history.
 *
 * ## Precedence
 *
 * The NEWEST `CONVERSATION_UPSERTED` that actually mentions the field wins. An event that omits it
 * leaves the previous answer standing, which is what makes a normal message upsert unable to unpin the
 * conversation. A later explicit `null` clears it.
 *
 * ## Why the fold is over events rather than one row
 *
 * The replica keeps the newest encrypted envelope per conversation, but "newest" is a message-driven
 * upsert as often as not. Folding over the ordered history is what lets an older preference survive
 * those, and it keeps working after a snapshot rebuild.
 */
export function preferredSimFromEvents(
  events: StoredEvent[],
  aggregateId: string,
): PreferredSimState {
  const relevant = events
    .filter((event) =>
      event.aggregateId === aggregateId &&
      (event.type === "CONVERSATION_UPSERTED" || event.type === "CONVERSATION_UPSERT"))
    .sort((a, b) => a.sequence - b.sequence);

  let state: PreferredSimState = ABSENT;
  for (const event of relevant) {
    const payload = decodeEventPayload(event);
    // An event we cannot decode tells us nothing; it must not be read as a clear.
    if (!payload) continue;
    const next = preferredSimStateFromPayload(payload);
    if (next.kind !== "absent") state = next;
  }
  return state;
}

/**
 * Whether a runtime that advertised `commandTypes` can accept a sticky-SIM change.
 *
 * Android advertises what it can actually execute, so this is a capability question and never a
 * version guess. A phone that does not advertise the command must not be sent it, because the command
 * would fail terminally and the browser would have shown the user a change that never happened.
 */
export function runtimeSupportsPreferredSim(commandTypes: readonly string[] | null | undefined): boolean {
  return Array.isArray(commandTypes) && commandTypes.includes("SET_CONVERSATION_PREFERRED_SIM");
}
