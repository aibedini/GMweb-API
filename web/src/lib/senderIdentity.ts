/**
 * SMS sender identity.
 *
 * PRODUCTION BUG this fixes: branded / alphanumeric SMS senders were run through
 * digits-only phone normalization, so:
 *
 *   PARSIANBANK  -> ""        (and ResalatBank, Google, BANK_OTP all -> "" too,
 *                              i.e. FOUR distinct senders collapsed to ONE
 *                              empty identity)
 *   Ssh3-652     -> "3652"    (corrupted; can also collide with a real code)
 *   S10 R180     -> "10180"
 *
 * An SMS sender is NOT necessarily a phone number. Android and carriers use
 * phone numbers, alphanumeric sender IDs (A2P/branded), and short codes, and
 * each must keep its own stable identity.
 *
 * The raw provider value is preserved verbatim and never rewritten.
 */

export type SenderKind = "PHONE" | "ALPHANUMERIC" | "SHORT_CODE" | "UNKNOWN";

export interface SenderIdentity {
  /** The provider's value, EXACTLY as received. Never normalized. */
  rawAddress: string | null;
  kind: SenderKind;
  /**
   * Typed namespace key, safe to use for identity/dedup. `null` only for
   * UNKNOWN. Distinct senders can never collide:
   *   phone:989121234567 / alpha:parsianbank / short:3000
   */
  canonicalAddress: string | null;
  /** What to show when no better label (contact name) exists. */
  displayValue: string | null;
  /** Whether GMweb may address an SMS to this sender. */
  replyable: boolean;
}

/** Converts Persian/Arabic-Indic digits to ASCII. Phone numbers only. */
export function toAsciiDigits(value: string): string {
  return value.replace(/[\u06F0-\u06F9]/g, ch => String(ch.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, ch => String(ch.charCodeAt(0) - 0x0660));
}

/**
 * Canonical phone key, matching the established local-number convention
 * (`09xxxxxxxxx` and `+989xxxxxxxxx` must be the same subscriber).
 */
function canonicalPhone(raw: string): string | null {
  const ascii = toAsciiDigits(raw).trim();
  const digits = ascii.replace(/\D/g, "");
  if (!digits) return null;
  if (/^09\d{9}$/.test(digits)) return `98${digits.slice(1)}`;
  return digits.startsWith("00") ? digits.slice(2) : digits;
}

/** A conservative short-code bound: below any national subscriber number. */
const SHORT_CODE_MAX_DIGITS = 6;
/** Minimum digits before a numeric sender is treated as a phone number. */
const PHONE_MIN_DIGITS = 7;

/**
 * Classify a raw SMS sender.
 *
 * UNKNOWN is reserved for genuinely absent/unusable data. "Not a phone number"
 * is NOT unknown — it is an alphanumeric sender ID or a short code.
 */
export function classifySender(raw: string | null | undefined): SenderIdentity {
  const rawAddress = typeof raw === "string" ? raw : null;
  const trimmed = (rawAddress ?? "").trim();
  if (!trimmed) {
    return { rawAddress: rawAddress || null, kind: "UNKNOWN", canonicalAddress: null,
      displayValue: null, replyable: false };
  }

  const ascii = toAsciiDigits(trimmed);
  const digits = ascii.replace(/\D/g, "");
  const hasLetters = /[A-Za-z]/.test(ascii);

  if (hasLetters) {
    // Alphanumeric sender ID (PARSIANBANK, ResalatBank, Ssh3-652, Google).
    // Preserve the display value EXACTLY; case-fold only the identity key so
    // branding case is never lost from the UI.
    return { rawAddress: trimmed, kind: "ALPHANUMERIC",
      canonicalAddress: `alpha:${ascii.toLowerCase()}`,
      displayValue: trimmed, replyable: false };
  }

  if (!digits) {
    // Non-letter, non-digit (punctuation-only). Not usable as an identity.
    return { rawAddress: trimmed, kind: "UNKNOWN", canonicalAddress: null,
      displayValue: null, replyable: false };
  }

  // Numeric-only sender: phone number or short code.
  const isPhoneShaped = /^\+?\d+$/.test(ascii.replace(/[\s()\-.]/g, ""));
  if (isPhoneShaped && digits.length >= PHONE_MIN_DIGITS) {
    const canonical = canonicalPhone(ascii);
    if (canonical) {
      return { rawAddress: trimmed, kind: "PHONE", canonicalAddress: `phone:${canonical}`,
        displayValue: trimmed, replyable: true };
    }
  }

  if (digits.length <= SHORT_CODE_MAX_DIGITS) {
    return { rawAddress: trimmed, kind: "SHORT_CODE", canonicalAddress: `short:${digits}`,
      displayValue: trimmed, replyable: true };
  }

  // Long numeric string that is not phone-shaped (e.g. a concatenated
  // operator ID). Keep a stable identity rather than inventing a phone.
  return { rawAddress: trimmed, kind: "ALPHANUMERIC", canonicalAddress: `alpha:${ascii.toLowerCase()}`,
    displayValue: trimmed, replyable: false };
}

/** True only for a real phone number, i.e. contact lookup is meaningful. */
export function isPhoneSender(raw: string | null | undefined): boolean {
  return classifySender(raw).kind === "PHONE";
}

/**
 * The identity key to use for dedup/identity purposes.
 *
 * Never returns an empty string for a present sender, so branded senders cannot
 * collapse into a shared blank identity the way `phoneKey()` did.
 */
export function senderKey(raw: string | null | undefined): string | null {
  return classifySender(raw).canonicalAddress;
}

/**
 * Lowercased haystack for search. Includes the raw value verbatim, so
 * "parsian", "PARSIANBANK", "Resalat" and "Ssh3" all match.
 */
export function senderSearchText(raw: string | null | undefined): string {
  const identity = classifySender(raw);
  return [identity.rawAddress, identity.canonicalAddress]
    .filter(Boolean).join(" ").toLowerCase();
}

/** True when the query matches this sender's raw or canonical form. */
export function senderMatches(raw: string | null | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return senderSearchText(raw).includes(needle);
}
