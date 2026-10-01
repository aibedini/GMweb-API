import { calculateSmsSegments } from "../../../web/src/lib/smsSegments";
import { useSmsOptions } from "@/hooks/useSmsSend";

export function SmsOptions({ text, options }: { text: string; options: ReturnType<typeof useSmsOptions> }) {
  const count = calculateSmsSegments(text);
  return <div className="space-y-2 text-xs text-muted-foreground">
    <div className="flex flex-wrap items-center justify-between gap-2">
      {options.android && <label>Send using <select aria-label="Send using SIM" className="rounded border border-input bg-background p-2"
        value={options.selected ?? ""} onChange={event => options.setSelected(event.target.value === "" ? null : Number(event.target.value))}>
        <option value="">Default</option>
        {options.sims.map(sim => <option key={sim.subscriptionId} value={sim.subscriptionId}>
          SIM {sim.slotIndex + 1} — {sim.carrierName || sim.displayName || "Carrier unavailable"}
        </option>)}
      </select></label>}
      <span title={`${count.encoding} · ${count.units} encoding units`}>{Array.from(text).length} chars · {count.segments} SMS</span>
      <span>Ctrl+Enter / ⌘+Enter to send</span>
    </div>
    {options.problem && <p role="status">{options.problem} <button type="button" onClick={() => void options.refresh()} className="underline">Refresh SIMs</button></p>}
  </div>;
}
