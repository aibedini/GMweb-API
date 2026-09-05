import type { StoredEvent } from "./sync";

export interface MessagePayload {
  messageId: string;
  direction: "in" | "out";
  body: string;
  dateMs: number;
  status: number;
  address?: string;
}

export interface ConversationSummary {
  aggregateId: string;
  title: string;
  preview: string;
  lastAt: number;
}

export interface TimelineItem {
  event: StoredEvent;
  payload: MessagePayload;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Decode the legacy cryptoVersion=0 Android envelope. Version zero is NOT
 * encryption: it is UTF-8 JSON wrapped in Base64. Keeping this decoder named
 * and version-gated prevents the UI from making a false E2EE claim and gives
 * cryptoVersion>=1 a fail-closed extension point.
 */
export function decodeEventPayload(event: StoredEvent): Record<string, unknown> | null {
  try {
    if (event.encoding !== "envelope.v1" || event.cryptoVersion !== 0) return null;
    const envelopeText = new TextDecoder().decode(decodeBase64(event.ciphertext));
    const envelope = JSON.parse(envelopeText) as { ciphertextB64?: string; encoding?: string; cryptoVersion?: number };
    if (envelope.cryptoVersion !== 0 || envelope.encoding !== "application/json" || !envelope.ciphertextB64) return null;
    return JSON.parse(new TextDecoder().decode(decodeBase64(envelope.ciphertextB64))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function messagePayload(event: StoredEvent): MessagePayload | null {
  if (event.type !== "MESSAGE_CREATED" && event.type !== "MESSAGE_UPDATED") return null;
  const value = decodeEventPayload(event);
  if (!value || typeof value.body !== "string") return null;
  return {
    messageId: String(value.messageId || event.eventId),
    direction: value.direction === "out" ? "out" : "in",
    body: value.body,
    dateMs: Number(value.dateMs) || event.createdAt,
    status: Number(value.status) || 0,
    address: typeof value.address === "string" ? value.address : undefined,
  };
}

function fallbackTitle(id: string): string {
  const compact = id.replaceAll("-", "");
  return compact ? `Conversation ${compact.slice(0, 7)}` : "Unknown conversation";
}

export function buildConversations(events: StoredEvent[]): ConversationSummary[] {
  const byAggregate = new Map<string, ConversationSummary>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const aggregateId = event.aggregateId || "(no aggregate)";
    const payload = messagePayload(event);
    const current = byAggregate.get(aggregateId) || {
      aggregateId,
      title: fallbackTitle(aggregateId),
      preview: "Activity received from Android",
      lastAt: 0,
    };
    current.lastAt = payload?.dateMs || event.createdAt;
    if (payload) {
      current.preview = payload.body || "Empty message";
      if (payload.address) current.title = payload.address;
    }
    byAggregate.set(aggregateId, current);
  }
  return [...byAggregate.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export function messagesForAggregate(events: StoredEvent[], aggregateId: string): TimelineItem[] {
  return events
    .filter((event) => (event.aggregateId || "(no aggregate)") === aggregateId)
    .map((event) => ({ event, payload: messagePayload(event) }))
    .filter((item): item is TimelineItem => item.payload !== null)
    .sort((a, b) => a.payload.dateMs - b.payload.dateMs);
}

export function eventDecodeState(event: StoredEvent): "readable" | "encrypted" | "invalid" {
  if (event.cryptoVersion > 0) return "encrypted";
  return decodeEventPayload(event) ? "readable" : "invalid";
}
