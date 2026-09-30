import { Button } from "@heroui/react";
import type { DeviceTelemetry } from "../lib/api";
import { calculateSmsSegments } from "../lib/smsSegments";
import { commandFeedback } from "../lib/inboxActions";

type Sim = NonNullable<DeviceTelemetry["smsSubscriptions"]>["items"][number];
export function MessageComposer({ draft, onDraft, sims, selected, onSim, help, retry, send,
  sending, canSend, status }: {
  draft: string; onDraft: (value: string) => void; sims: Sim[]; selected?: Sim;
  onSim: (id: number) => void; help: string | null; retry: () => void;
  send: () => void; sending: boolean; canSend: boolean; status: string | null;
}) {
  const segments = calculateSmsSegments(draft);
  return <section className="message-composer" aria-label="Write a message">
    <textarea aria-label="Message" dir="auto" value={draft} onChange={event => onDraft(event.target.value)}
      placeholder="Write a message…" rows={2} />
    <div className="composer-toolbar">
      <div className="composer-options">
        {sims.length > 0 && <label className="composer-sim">Send using
          <select aria-label="Send using SIM" value={selected?.subscriptionId ?? ""}
            onChange={event => onSim(Number(event.target.value))}>
            <option value="" disabled>Choose SIM</option>
            {sims.map(sim => <option key={sim.subscriptionId} value={sim.subscriptionId}>
              SIM {sim.slotIndex + 1} · {sim.displayName || sim.carrierName || "Active SIM"}
            </option>)}
          </select>
        </label>}
        <span className="composer-count">{segments.segments} SMS · {segments.remaining} characters left</span>
      </div>
      <Button className="composer-send" onPress={send}
        isDisabled={sending || !canSend || !draft.trim() || Boolean(help)}>{sending ? "Sending…" : "Send message"}</Button>
    </div>
    {help && <div className="composer-help" role="status"><span>{help}</span><Button size="sm" variant="ghost" onPress={retry}>Refresh SIMs</Button></div>}
    {!canSend && <p className="composer-help">Sending access is required. Approve this browser on your Primary phone.</p>}
    {status && <p className="composer-status" role="status">{commandFeedback(status)}</p>}
  </section>;
}
