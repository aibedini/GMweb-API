/**
 * Inbox data layer (§49) — derives conversations from the opaque event
 * store. Envelope bytes stay opaque (Rule 6); until Phase 7 decryption, the
 * Inbox shows aggregate identities + event activity, and the Conversation
 * view shows the event timeline per aggregate. Decrypted bodies plug into
 * renderMessage() at the single Phase 7 choke point.
 */

import type { StoredEvent } from "./sync";

export interface ConversationSummary {
  aggregateId: string;
  eventCount: number;
  lastSequence: number;
  lastAt: number;
  lastType: string;
}

export function buildConversations(events: StoredEvent[]): ConversationSummary[] {
  const byAggregate = new Map<string, ConversationSummary>();
  for (const ev of events) {
    const key = ev.aggregateId || "(no aggregate)";
    const cur = byAggregate.get(key);
    if (!cur) {
      byAggregate.set(key, {
        aggregateId: key,
        eventCount: 1,
        lastSequence: ev.sequence,
        lastAt: ev.createdAt,
        lastType: ev.type,
      });
    } else {
      cur.eventCount++;
      if (ev.sequence > cur.lastSequence) {
        cur.lastSequence = ev.sequence;
        cur.lastAt = ev.createdAt;
        cur.lastType = ev.type;
      }
    }
  }
  return [...byAggregate.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export function eventsForAggregate(events: StoredEvent[], aggregateId: string): StoredEvent[] {
  return events
    .filter((e) => (e.aggregateId || "(no aggregate)") === aggregateId)
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * Phase 7 choke point: today renders the envelope metadata honestly; the
 * AEAD decryption swap lands here without touching UI code.
 */
export function renderMessage(_event: StoredEvent): string {
  return "🔒 encrypted payload (decryption in Phase 7)";
}
