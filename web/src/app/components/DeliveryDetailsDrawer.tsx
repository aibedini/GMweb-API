import { Drawer, useMediaQuery } from "@heroui/react";
import { formatFullTimestamp, messageStatusLabel } from "./format";
import type { ThreadItem } from "./types";

/**
 * §23: delivery details.
 *
 * Only stages the local model can actually evidence are reported. GMweb
 * acceptance is explicitly NOT presented as SMS submission or carrier
 * delivery, and every stage without evidence reads "Not confirmed" — no
 * invented timestamps or fabricated tick marks.
 */
export function DeliveryDetailsDrawer({
  isOpen,
  onOpenChange,
  item,
  messageId,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  item: ThreadItem | null;
  messageId?: string | null;
}) {
  const isMobile = useMediaQuery("(max-width: 767px)", { defaultValue: false });
  const status = item && !item.pending ? messageStatusLabel(item.status) : null;

  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Drawer.Content placement={isMobile ? "bottom" : "right"}>
        <Drawer.Dialog>
          <Drawer.CloseTrigger />
          <Drawer.Header>
            <Drawer.Heading>Delivery details</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body>
            {item ? (
              <dl className="details-list">
                <dt>Android status</dt>
                <dd>{status ?? "Not confirmed"}</dd>

                <dt>Observed this session</dt>
                <dd>{item.progress ?? "Not confirmed"}</dd>

                <dt>Local encrypted outbox</dt>
                <dd>{item.pending ? "Queued locally" : "Not confirmed"}</dd>

                <dt>Accepted by GMweb</dt>
                <dd>{item.progress?.startsWith("Accepted") ? item.progress : "Not confirmed"}</dd>

                <dt>Pulled by phone</dt>
                <dd>{item.progress === "Pulled by phone" ? "Confirmed" : "Not confirmed"}</dd>

                <dt>Submitted to carrier</dt>
                <dd>Not confirmed</dd>

                <dt>Carrier delivery evidence</dt>
                <dd>{item.status === 0 ? "Delivered" : "Not confirmed"}</dd>

                <dt>Message id</dt>
                <dd>{messageId || item.key}</dd>

                <dt>Client message id</dt>
                <dd>{item.clientMessageId ?? "—"}</dd>

                <dt>Timestamp</dt>
                <dd>{formatFullTimestamp(item.dateMs)}</dd>
              </dl>
            ) : (
              <p>No message selected.</p>
            )}

            <p className="mt-4 text-xs text-muted">
              GMweb accepting a command is not proof that the SMS was submitted or delivered. Stages the
              browser cannot evidence are reported as not confirmed.
            </p>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
