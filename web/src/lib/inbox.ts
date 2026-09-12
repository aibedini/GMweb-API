import type { StoredEvent } from "./sync";
import { acceptsContentCrypto, isContentBearingEvent } from "./eventCryptoPolicy.ts";

export interface MessagePayload {
  messageId: string;
  direction: "in" | "out";
  body: string;
  dateMs: number;
  status: number;
  address?: string;
  read?: boolean;
  /** Optional display name embedded by Android (Contacts lookup at send/receive time). */
  contactName?: string;
  /** Exact correlation for replacing the Web optimistic bubble. */
  originCommandId?: string;
  clientMessageId?: string;
}

export interface ConversationSummary {
  aggregateId: string;
  title: string;
  /** Phone number (subtitle) when the title is a contact name. */
  subtitle?: string;
  preview: string;
  lastAt: number;
  read: boolean;
  unreadCount: number;
}
/**
 * PWA read-model row (IndexedDB `conversations` store). Raw events remain the
 * source of truth; this is a derived cache that is (a) rebuilt per changed
 * aggregate after every sync page commit and (b) rebuilt once from stored
 * events after the schema migration. It replaces the old
 * `listInboxEvents(limit=100)` candidate-scan so older conversations can no
 * longer disappear when there are many threads.
 */
export interface ConversationProjection extends ConversationSummary {
  lastMessageId: string;
  lastSequence: number;
  decodeState: "ready" | "locked";
}



export interface TimelineItem {
  event: StoredEvent;
  payload: MessagePayload;
}

/**
 * Decode the legacy cryptoVersion=0 Android envelope. Version zero is NOT
 * encryption: it is UTF-8 JSON wrapped in Base64. Keeping this decoder named
 * and version-gated prevents the UI from making a false E2EE claim and gives
 * cryptoVersion>=1 a fail-closed extension point.
 */
export function decodeEventPayload(event: StoredEvent): Record<string, unknown> | null {
  if (isContentBearingEvent(event.type) && !acceptsContentCrypto(event.type, event.cryptoVersion)) return null;
  return event.cryptoVersion > 0 && event.decryption?.state === "decrypted"
    ? event.decryption.payload
    : null;
}

function messagePayload(event: StoredEvent): MessagePayload | null {
  if (!["MESSAGE_CREATED", "MESSAGE_UPDATED", "MESSAGE_STATUS_CHANGED"].includes(event.type)) return null;
  const value = decodeEventPayload(event);
  if (!value || typeof value.body !== "string") return null;
  return {
    messageId: String(value.messageId || event.eventId),
    direction: value.direction === "out" ? "out" : "in",
    body: value.body,
    dateMs: Number(value.dateMs) || event.createdAt,
    status: Number(value.status) || 0,
    address: typeof value.address === "string" ? value.address : undefined,
    read: value.read === true,
    contactName: typeof value.contactName === "string" && value.contactName.trim()
      ? value.contactName.trim()
      : undefined,
    originCommandId: typeof value.originCommandId === "string" ? value.originCommandId : undefined,
    clientMessageId: typeof value.clientMessageId === "string" ? value.clientMessageId : undefined,
  };
}

function fallbackTitle(id: string): string {
  const compact = id.replaceAll("-", "");
  return compact ? `Conversation ${compact.slice(0, 7)}` : "Unknown conversation";
}

function project(events: StoredEvent[]) {
  const threads = new Map<string, Map<string, TimelineItem>>();
  const reads = new Map<string, number>();
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (!event.aggregateId || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const id = event.aggregateId;
    const payload = messagePayload(event);
    if (payload) {
      const messages = threads.get(id) ?? new Map<string, TimelineItem>();
      messages.set(payload.messageId, { event, payload });
      threads.set(id, messages);
      continue;
    }
    const value = decodeEventPayload(event);
    if (!value) continue;
    if (event.type === "THREAD_READ") {
      reads.set(id, Number(value.readAtMs) || event.createdAt);
      continue;
    }
    if (typeof value.messageId !== "string") continue;
    const messages = threads.get(id);
    if (event.type === "MESSAGE_DELETED") messages?.delete(value.messageId);
    if (event.type === "MESSAGE_STATUS_CHANGED" && typeof value.status === "number") {
      const current = messages?.get(value.messageId);
      if (current) current.payload = { ...current.payload, status: value.status };
    }
  }
  return { threads, reads };
}

export function buildConversations(events: StoredEvent[], contacts: Map<string, string> = new Map()): ConversationSummary[] {
  const { threads, reads } = project(events);
  const summaries: ConversationSummary[] = [];
  for (const [aggregateId, messages] of threads) {
    const latest = [...messages.values()].sort((a, b) =>
      b.payload.dateMs - a.payload.dateMs || b.event.sequence - a.event.sequence)[0];
    if (!latest) continue;
    const address = latest.payload.address || undefined;
    const named = (address ? contacts.get(address) : undefined) || latest.payload.contactName || undefined;
    const unreadCount = [...messages.values()].filter(item => item.payload.direction === "in" &&
      !item.payload.read && item.payload.dateMs > (reads.get(aggregateId) ?? 0)).length;
    summaries.push({
      aggregateId,
      title: named || address || fallbackTitle(aggregateId),
      ...(named && address ? { subtitle: address } : {}),
      preview: latest.payload.body || "Empty message",
      lastAt: latest.payload.dateMs,
      read: unreadCount === 0,
      unreadCount,
    });
  }
  return summaries.sort((a, b) => b.lastAt - a.lastAt || a.aggregateId.localeCompare(b.aggregateId));
}

export function messagesForAggregate(events: StoredEvent[], aggregateId: string): TimelineItem[] {
  return [...(project(events).threads.get(aggregateId)?.values() ?? [])]
    .sort((a, b) => a.payload.dateMs - b.payload.dateMs || a.event.sequence - b.event.sequence);
}

export function eventDecodeState(event: StoredEvent): string {
  // Version metadata alone is not evidence of encryption or successful decryption.
  if (Number.isSafeInteger(event.cryptoVersion) && event.cryptoVersion > 0) {
    if (event.decryption?.state === "decrypted") return "Encrypted + decrypted";
    if (event.decryption?.state === "key-grant") return "Key grant";
    if (event.decryption?.state === "invalid") return "Invalid/corrupt payload";
    return event.decryption?.reason ? `Locked: ${event.decryption.reason}` : "Locked/unsupported crypto version";
  }
  return "Rejected plaintext/unsupported content event";
}

/**
 * Build the read-model row for ONE aggregate from its full local event set.
 * Null when the aggregate has no decodable/decrypted message content at all
 * (e.g. a conversation that was fully deleted). Locked ciphertext still yields
 * a row (decodeState: "locked") so the conversation never silently vanishes
 * from the Inbox before its key grant arrives.
 */
export function conversationProjectionFromEvents(
  events: StoredEvent[],
  aggregateId: string,
  contacts: Map<string, string> = new Map(),
): ConversationProjection | null {
  const forAggregate = events.filter((event) => event.aggregateId === aggregateId);
  const summaries = buildConversations(forAggregate, contacts);
  if (summaries.length > 0) {
    const summary = summaries.find((item) => item.aggregateId === aggregateId) ?? summaries[0];
    const timeline = messagesForAggregate(forAggregate, aggregateId);
    const last = timeline[timeline.length - 1];
    const decodeState: "ready" | "locked" = last
      ? eventDecodeState(last.event).startsWith("Locked") ? "locked" : "ready"
      : "ready";
    return {
      ...summary,
      lastMessageId: last?.payload.messageId ?? summary.aggregateId,
      lastSequence: last?.event.sequence ?? 0,
      decodeState,
    };
  }
  // Nothing decodable yet — but if the aggregate still holds ciphertext that
  // might decrypt once a KEY_GRANT arrives, keep a locked row visible. A
  // fully-deleted conversation (delete newer than every message) yields null.
  const newestDeleted = Math.max(0, ...forAggregate
    .filter((event) => event.type === "MESSAGE_DELETED")
    .map((event) => event.sequence));
  const newestMessage = [...forAggregate]
    .filter((event) => event.type === "MESSAGE_CREATED" || event.type === "MESSAGE_UPDATED")
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (!newestMessage || newestMessage.sequence <= newestDeleted) return null;
  return {
    aggregateId,
    title: "Encrypted message",
    preview: "Locked — waiting for a key grant from your phone",
    lastAt: newestMessage.createdAt,
    read: true,
    unreadCount: 0,
    lastMessageId: newestMessage.eventId,
    lastSequence: newestMessage.sequence,
    decodeState: "locked",
  };
}
