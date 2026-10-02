export interface SmsSim {
  subscriptionId: number;
  isActive: boolean;
  isDefaultSms: boolean;
  sendCapable?: boolean;
}

export function selectSmsSim<T extends SmsSim>(items: T[], savedId: number | null): T | undefined {
  const active = items.filter(item => item.isActive && item.sendCapable !== false);
  if (savedId !== null) return active.find(item => item.subscriptionId === savedId);
  return active.find(item => item.isDefaultSms) ?? active[0];
}

/** Select key that means "let the phone choose its default SMS SIM". */
export const DEFAULT_SIM_KEY = "default";

/**
 * Map the composer's SIM state onto the HeroUI `Select` value.
 *
 * `selectedSubscriptionId === null` means "no explicit subscription in the
 * command payload", and it is preserved exactly: the value becomes
 * `DEFAULT_SIM_KEY` only while Android actually reports a default SMS SIM
 * (matching the previous native `<select>` behaviour). When no default is
 * reported the resolved SIM's own id is shown instead.
 */
export function simSelectValue<T extends SmsSim>(
  sims: T[],
  selected: T | undefined,
  useDefault: boolean,
): string | null {
  const hasDefault = sims.some(sim => sim.isDefaultSms);
  if (useDefault && hasDefault) return DEFAULT_SIM_KEY;
  return selected ? String(selected.subscriptionId) : null;
}

/** Inverse of `simSelectValue`: a Select key back to the command payload id. */
export function simSelectChoice(next: string | number | null | undefined): number | null {
  if (next === null || next === undefined || next === DEFAULT_SIM_KEY) return null;
  const value = Number(next);
  return Number.isSafeInteger(value) ? value : null;
}
