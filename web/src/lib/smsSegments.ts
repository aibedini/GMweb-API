/** Default alphabet and extension table of 3GPP TS 23.038. */
const GSM_BASIC = new Set(Array.from(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
));
const GSM_EXTENSION = new Set(Array.from("\f^{}\\[~]|€"));

export interface SmsSegments {
  encoding: "GSM-7" | "Unicode";
  units: number;
  segments: number;
  perSegment: number;
  remaining: number;
}

export function calculateSmsSegments(text: string): SmsSegments {
  const characters = Array.from(text);
  const gsm = characters.every(character => GSM_BASIC.has(character) || GSM_EXTENSION.has(character));
  const costs = characters.map(character => gsm ? (GSM_EXTENSION.has(character) ? 2 : 1) : character.length);
  const units = costs.reduce((sum, cost) => sum + cost, 0);
  const single = gsm ? 160 : 70;
  const multipart = gsm ? 153 : 67;
  if (units === 0) return { encoding: "GSM-7", units: 0, segments: 0, perSegment: single, remaining: single };
  if (units <= single) return { encoding: gsm ? "GSM-7" : "Unicode", units, segments: 1,
    perSegment: single, remaining: single - units };
  let segments = 1;
  let inPart = 0;
  for (const cost of costs) {
    if (inPart + cost > multipart) { segments += 1; inPart = 0; }
    inPart += cost;
  }
  return { encoding: gsm ? "GSM-7" : "Unicode", units, segments,
    perSegment: multipart, remaining: multipart - inPart };
}
