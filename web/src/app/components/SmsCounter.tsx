import { calculateSmsSegments } from "../../lib/smsSegments";

/**
 * §18: SMS segment counter.
 *
 * Reports the real output of `calculateSmsSegments`. The only presentation
 * mapping is the encoding label: the library distinguishes GSM-7 from
 * everything else, and non-GSM-7 SMS is encoded as UCS-2 per 3GPP TS 23.038 —
 * so "Unicode" is displayed as "UCS-2" rather than being mislabelled GSM-7.
 *
 * Hidden when the draft is empty so the toolbar stays quiet.
 */
export function SmsCounter({ draft }: { draft: string }) {
  if (!draft) return null;

  const segments = calculateSmsSegments(draft);
  const characters = Array.from(draft).length;
  const encoding = segments.encoding === "GSM-7" ? "GSM-7" : "UCS-2";
  const title = `${encoding} · ${segments.units} encoding unit(s) · ${segments.perSegment} per segment · ${segments.remaining} remaining in the last segment`;

  return (
    <span className="composer-counter" title={title}>
      <span className="composer-counter__full">
        {characters} chars · {encoding} · {segments.segments} SMS
      </span>
      <span className="composer-counter__compact">
        {encoding} · {segments.segments} SMS
      </span>
    </span>
  );
}
