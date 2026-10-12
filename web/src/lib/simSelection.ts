export interface SmsSim {
  /**
   * The opaque, keyed identity minted by Android. This is the DURABLE handle and the key SIM selection
   * is routed by: it survives a refresh, and it is what the phone can resolve to a real line at send
   * time.
   */
  simRef?: string;
  /**
   * The platform subscription id, when this build still reports one.
   *
   * EPHEMERAL. Current Android builds deliberately do not publish it — a subscription id is reassigned
   * when SIMs move — so nothing may depend on it being present. It is kept for older phones only.
   */
  subscriptionId?: number;
  isActive: boolean;
  isDefaultSms: boolean;
  sendCapable?: boolean;
  /**
   * Display fields. Present on the wire item; declared here (rather than only on the API type) so the
   * label helpers can be generic over anything that carries a SIM identity.
   */
  slotIndex: number;
  displayName: string;
  carrierName: string;
}

/**
 * The key a SIM is selected and compared by, as a string.
 *
 * ## Why the key is `simRef` and not `subscriptionId`
 *
 * Selection has to survive a page refresh and identify the same physical line after a card swap.
 * `simRef` does both: Android derives it from the subscription with a device-local key, so it is stable
 * for that install and cannot be inverted back into a subscription id. `subscriptionId` does neither —
 * it is a small integer that the platform reassigns, and current Android builds no longer publish it.
 *
 * Falls back to the subscription id ONLY when no ref exists, so an older phone keeps working. The
 * returned key is namespaced by which source produced it, because an unnamespaced key could collide:
 * the string "5" from a legacy id must never be mistaken for a `simRef`.
 *
 * Returns null for a SIM with no usable identity, which callers must treat as "cannot be selected"
 * rather than as a match.
 */
export function simKey(sim: SmsSim | undefined | null): string | null {
  if (!sim) return null;
  if (typeof sim.simRef === "string" && sim.simRef.length > 0) return `ref:${sim.simRef}`;
  if (typeof sim.subscriptionId === "number" && Number.isSafeInteger(sim.subscriptionId)) {
    return `sub:${sim.subscriptionId}`;
  }
  return null;
}

/** True when the SIM can be selected at all (it has an identity we can route by). */
export function isSelectableSim(sim: SmsSim): boolean {
  return simKey(sim) !== null;
}

/** A human label for a SIM, used everywhere one is named. */
export function simLabel(sim: Pick<SmsSim, "slotIndex" | "carrierName" | "displayName">): string {
  const carrier = sim.carrierName || sim.displayName || "Carrier unavailable";
  return `SIM ${sim.slotIndex + 1} · ${carrier}`;
}

/**
 * The label for a STICKY preference, matched against the live SIM list by its opaque ref.
 *
 * Returns null when the pinned line is not currently present. The preference is real and still set on
 * the phone, so the caller must say that rather than present it as unset — a preference that outlives
 * the card is exactly the case worth showing, because the user replaced a SIM and still needs to know
 * which line an older conversation is pinned to.
 */
export function simLabelForRef<T extends SmsSim>(
  sims: T[],
  simRef: string | undefined,
): string | null {
  if (!simRef) return null;
  const match = sims.find(sim => sim.simRef === simRef);
  return match ? simLabel(match) : null;
}

export function selectSmsSim<T extends SmsSim>(items: T[], savedKey: string | null): T | undefined {
  const active = items.filter(item => item.isActive && item.sendCapable !== false);
  if (savedKey !== null) {
    const match = active.find(item => simKey(item) === savedKey);
    // An explicit selection that no longer resolves returns undefined rather than falling back to
    // another line: silently substituting a different SIM is exactly the misroute this guards against.
    if (match) return match;
    return undefined;
  }
  return active.find(item => item.isDefaultSms) ?? active[0];
}

/** Select key that means "let the phone choose its default SMS SIM". */
export const DEFAULT_SIM_KEY = "default";

/**
 * Map the composer's SIM state onto the HeroUI `Select` value.
 *
 * The "no explicit preference" case is preserved exactly: the value becomes [DEFAULT_SIM_KEY] only
 * while Android actually reports a default SMS SIM. When no default is reported the resolved SIM's own
 * key is shown instead, so the control never claims a default the phone did not name.
 */
export function simSelectValue<T extends SmsSim>(
  sims: T[],
  selected: T | undefined,
  useDefault: boolean,
): string | null {
  const hasDefault = sims.some(sim => sim.isDefaultSms);
  if (useDefault && hasDefault) return DEFAULT_SIM_KEY;
  return simKey(selected);
}

/**
 * Inverse of [simSelectValue]: a Select key back to the identity the command payload carries.
 *
 * Returns the `simRef` string when the choice is a real `simRef`, and the legacy numeric subscription id
 * when the key came from one. `null` means "no explicit line", which is what makes Android resolve its
 * own default — deliberately NOT a SIM the browser picked.
 */
export function simSelectChoice(
  next: string | number | null | undefined,
): { simRef: string } | { subscriptionId: number } | null {
  if (next === null || next === undefined || next === DEFAULT_SIM_KEY) return null;
  const raw = String(next);
  if (raw.startsWith("ref:")) {
    const simRef = raw.slice("ref:".length);
    return simRef.length > 0 ? { simRef } : null;
  }
  if (raw.startsWith("sub:")) {
    const value = Number(raw.slice("sub:".length));
    return Number.isSafeInteger(value) ? { subscriptionId: value } : null;
  }
  // A bare value from a legacy caller that still passes a raw id.
  const value = Number(raw);
  return Number.isSafeInteger(value) ? { subscriptionId: value } : null;
}
