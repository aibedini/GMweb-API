import { Avatar, Chip } from "@heroui/react";
import type { ConversationProjection } from "../../lib/inbox";
import type { BrowserSyncStatus } from "../../lib/sync/sync-state";
import type { DeviceTelemetry } from "../../lib/api";
import { formatFullTimestamp, formatListTime, initialsFor, messageStatusLabel, shortId } from "./format";
import { syncLabel } from "./SyncIndicator";

/**
 * §26 / §6: conversation details.
 *
 * Renders ONLY information that exists in the current data model. There is no
 * fabricated contact metadata, no fake presence and no invented capabilities.
 */
export function ConversationDetails({
  conversation,
  capabilities,
  syncStatus,
  telemetry,
  lastOutgoingStatus,
  lastOutgoingAt,
}: {
  conversation: ConversationProjection;
  capabilities: string[];
  syncStatus: BrowserSyncStatus;
  telemetry: DeviceTelemetry | null;
  lastOutgoingStatus: number | null;
  lastOutgoingAt: number | null;
}) {
  const activeSims = telemetry?.smsSubscriptions?.items.filter((sim) => sim.isActive) ?? [];
  const canSend = capabilities.includes("SEND_MESSAGES");
  const canMarkRead = capabilities.includes("MARK_READ");
  const canReadContacts = capabilities.includes("CONTACTS_READ");

  return (
    <div className="scroll-region" style={{ flex: "1 1 auto", minHeight: 0 }}>
      <div className="details-identity">
        <Avatar size="lg" variant="soft" color="accent">
          <Avatar.Fallback>{initialsFor(conversation.title)}</Avatar.Fallback>
        </Avatar>
        <div className="details-identity__title bidi-text">{conversation.title}</div>
        {conversation.subtitle ? (
          <div className="details-identity__subtitle bidi-text">{conversation.subtitle}</div>
        ) : null}
        <Chip size="sm" variant="soft" color={conversation.read ? "default" : "accent"}>
          <Chip.Label>
            {conversation.unreadCount > 0 ? `${conversation.unreadCount} unread` : "Read"}
          </Chip.Label>
        </Chip>
      </div>

      <section className="details-section">
        <span className="details-section__label">Conversation</span>
        <dl className="details-list">
          <dt>Aggregate id</dt>
          <dd title={conversation.aggregateId}>{shortId(conversation.aggregateId)}</dd>
          <dt>Last message</dt>
          <dd>{formatFullTimestamp(conversation.lastAt)}</dd>
          <dt>Sequence</dt>
          <dd>{conversation.lastSequence}</dd>
          <dt>Decode state</dt>
          <dd>{conversation.decodeState === "ready" ? "Decrypted locally" : "Locked — awaiting key"}</dd>
        </dl>
      </section>

      <section className="details-section">
        <span className="details-section__label">Device &amp; SIM</span>
        <dl className="details-list">
          <dt>Sync state</dt>
          <dd>{syncLabel(syncStatus.state)}</dd>
          <dt>Phone</dt>
          <dd>
            {telemetry?.device
              ? `${telemetry.device.manufacturer ?? ""} ${telemetry.device.model ?? ""}`.trim() || "Reported"
              : "Waiting for telemetry"}
          </dd>
          <dt>Active SMS SIMs</dt>
          <dd>{telemetry?.smsSubscriptions ? String(activeSims.length) : "Not reported"}</dd>
          <dt>Telemetry received</dt>
          <dd>{telemetry?.receivedAt ? formatListTime(telemetry.receivedAt) : "Never"}</dd>
        </dl>
      </section>

      <section className="details-section">
        <span className="details-section__label">Delivery</span>
        <dl className="details-list">
          <dt>Last outgoing</dt>
          <dd>{lastOutgoingStatus === null ? "None in this thread" : messageStatusLabel(lastOutgoingStatus)}</dd>
          <dt>Last outgoing time</dt>
          <dd>{lastOutgoingAt ? formatListTime(lastOutgoingAt) : "—"}</dd>
        </dl>
      </section>

      <section className="details-section">
        <span className="details-section__label">Security</span>
        <dl className="details-list">
          <dt>Send messages</dt>
          <dd>{canSend ? "Approved" : "Not approved"}</dd>
          <dt>Mark read on phone</dt>
          <dd>{canMarkRead ? "Approved" : "Not approved"}</dd>
          <dt>Read contacts</dt>
          <dd>{canReadContacts ? "Approved" : "Not approved"}</dd>
          <dt>Encryption keys</dt>
          <dd>{syncStatus.keyState}</dd>
        </dl>
        {capabilities.length === 0 ? (
          <p className="details-section__label" style={{ textTransform: "none", letterSpacing: 0 }}>
            This linked browser has no approved capabilities yet.
          </p>
        ) : null}
      </section>
    </div>
  );
}
