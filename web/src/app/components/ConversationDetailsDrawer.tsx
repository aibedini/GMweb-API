import { Drawer, useMediaQuery } from "@heroui/react";
import type { DeviceTelemetry } from "../../lib/api";
import type { ConversationProjection } from "../../lib/inbox";
import type { BrowserSyncStatus } from "../../lib/sync/sync-state";
import { ConversationDetails } from "./ConversationDetails";

/**
 * §26: below 1440px the details panel becomes a Drawer (right on desktop,
 * bottom on phones). It reuses the same `ConversationDetails` body as the
 * permanent panel so the two can never drift.
 */
export function ConversationDetailsDrawer({
  isOpen,
  onOpenChange,
  conversation,
  capabilities,
  syncStatus,
  telemetry,
  lastOutgoingStatus,
  lastOutgoingAt,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: ConversationProjection | null;
  capabilities: string[];
  syncStatus: BrowserSyncStatus;
  telemetry: DeviceTelemetry | null;
  lastOutgoingStatus: number | null;
  lastOutgoingAt: number | null;
}) {
  const isMobile = useMediaQuery("(max-width: 767px)", { defaultValue: false });
  if (!conversation) return null;

  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Drawer.Content placement={isMobile ? "bottom" : "right"}>
        <Drawer.Dialog>
          <Drawer.CloseTrigger />
          <Drawer.Header>
            <Drawer.Heading>Conversation details</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body className="p-0">
            <ConversationDetails
              conversation={conversation}
              capabilities={capabilities}
              syncStatus={syncStatus}
              telemetry={telemetry}
              lastOutgoingStatus={lastOutgoingStatus}
              lastOutgoingAt={lastOutgoingAt}
            />
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
