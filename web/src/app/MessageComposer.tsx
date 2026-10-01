import { Button } from "@heroui/react";
import type { DeviceTelemetry } from "../lib/api";
import { calculateSmsSegments } from "../lib/smsSegments";
import { commandFeedback } from "../lib/inboxActions";
import { MessageTextarea } from "./MessageTextarea";

type Sim = NonNullable<DeviceTelemetry["smsSubscriptions"]>["items"][number];
export function MessageComposer({ draft, onDraft, sims, selected, onSim, help, retry, send,
  sending, canSend, status, useDefault }: {
  draft: string; onDraft: (value: string) => void; sims: Sim[]; selected?: Sim;
  onSim: (id: number | null) => void; help: string | null; retry: () => void; useDefault: boolean;
  send: () => void; sending: boolean; canSend: boolean; status: string | null;
}) {
  const segments = calculateSmsSegments(draft);
  return <section className="message-composer" aria-label="Write a message">
    <MessageTextarea value={draft} onChange={onDraft} onSend={() => { if (!sending && canSend && !help) send(); }}
      disabled={sending} placeholder="Write a message…" />
    <div className="composer-toolbar">
      <div className="composer-options">
        {sims.length > 0 && <label className="composer-sim">Send using
          <select aria-label="Send using SIM" value={useDefault && sims.some(sim => sim.isDefaultSms) ? "" : selected?.subscriptionId ?? ""}
            onChange={event => onSim(event.target.value === "" ? null : Number(event.target.value))}>
            <option value="" disabled={!sims.some(sim => sim.isDefaultSms)}>{sims.some(sim => sim.isDefaultSms) ? "Default" : "Choose SIM"}</option>
            {sims.map(sim => <option key={sim.subscriptionId} value={sim.subscriptionId}>
            SIM {sim.slotIndex + 1} — {sim.carrierName || sim.displayName || "Carrier unavailable"}{sim.isDefaultSms ? " (Default)" : ""}
            </option>)}
          </select>
        </label>}
        <span className="composer-count" title={`${segments.encoding} · ${segments.units} encoding units`}>{Array.from(draft).length} chars · {segments.segments} SMS</span>
      </div>
      <Button className="composer-send" onPress={send}
        isDisabled={sending || !canSend || !draft.trim() || Boolean(help)}>{sending ? "Sending…" : "Send message"}</Button>
    </div>
    {help && <div className="composer-help" role="status"><span>{help}</span><Button size="sm" variant="ghost" onPress={retry}>Refresh SIMs</Button></div>}
    <p className="composer-help">Ctrl+Enter / ⌘+Enter to send</p>
    {!canSend && <p className="composer-help">Sending access is required. Approve this browser on your Primary phone.</p>}
    {status && <p className="composer-status" role="status">{commandFeedback(status)}</p>}
  </section>;
}
