import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useSSE, type SseEvent } from "./useSSE";
import { sendStatusLabel, type SendStatus } from "../../../shared/smsStatus";

export interface SmsCapabilities {
  available: boolean; stale: boolean; sendSmsPermission: boolean | null; isDefaultSmsApp: boolean | null;
  items: Array<{ subscriptionId: number; slotIndex: number; carrierName: string; displayName: string;
    isActive: boolean; isDefaultSms: boolean; sendCapable: boolean | null }>;
}
export function useSmsOptions() {
  const [capabilities, setCapabilities] = useState<SmsCapabilities | null>(null);
  const [android, setAndroid] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>("Checking sending connection…");
  const refresh = useCallback(async () => {
    try {
      const [caps, transport] = await Promise.all([api<SmsCapabilities>("/admin/sms-capabilities"),
        api<{ activeTransport: string }>("/admin/transport")]);
      setCapabilities(caps); setAndroid(transport.activeTransport === "android"); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not check SIMs. Retry."); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const sims = capabilities?.items.filter(sim => sim.isActive && sim.sendCapable !== false) || [];
  const sim = selected === null ? sims.find(item => item.isDefaultSms) : sims.find(item => item.subscriptionId === selected);
  const problem = error || (!android ? null : !capabilities?.available ? "SIM information unavailable. Reconnect the Primary phone." :
    capabilities.sendSmsPermission === false ? "SEND_SMS permission missing" : capabilities.isDefaultSmsApp === false ? "Phone is not default SMS app" :
    !sim ? "Selected SIM unavailable. Choose an active SIM." : null);
  return { capabilities, android, sims, sim, selected, setSelected, problem, refresh };
}
export function useSmsSend(onChanged?: () => void, onEvent?: (event: SseEvent) => void) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [clientMessageId, setClientMessageId] = useState<string | null>(null);
  const [outgoing, setOutgoing] = useState<{ to: string; text: string; clientMessageId: string } | null>(null);
  const inFlight = useRef(false);
  const observation = useRef(0);
  const last = useRef<{ signature: string; id: string; accepted: boolean } | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = async () => {
    if (!requestId) return;
    const expected = observation.current;
    try { const state = await api<SendStatus>(`/send/status/${encodeURIComponent(requestId)}`);
      if (expected !== observation.current) return;
      setStatus(sendStatusLabel(state)); onChanged?.();
    } catch (cause) { if (expected === observation.current) setStatus(`Status unavailable · ${cause instanceof Error ? cause.message : "Reconnect to check"}`); }
  };
  useSSE(event => {
    onEvent?.(event);
    if (event.type === "connected" || (requestId && event.requestId === requestId) || (clientMessageId && event.clientMessageId === clientMessageId))
      void refreshRef.current();
  }, true);
  useEffect(() => {
    if (!requestId) return;
    void refreshRef.current();
    const timer = window.setInterval(() => void refreshRef.current(), 30_000);
    return () => clearInterval(timer);
  }, [requestId]);
  const send = async (to: string, text: string, options: { subscriptionId?: number; priority?: string } = {}) => {
    if (inFlight.current || !to.trim() || !text.trim()) return false;
    inFlight.current = true; setBusy(true); setStatus("Sending…");
    observation.current += 1; setRequestId(null);
    const signature = JSON.stringify({ to, text, ...options });
    const id = last.current?.signature === signature && !last.current.accepted ? last.current.id : crypto.randomUUID();
    last.current = { signature, id, accepted: false }; setClientMessageId(id);
    setOutgoing({ to, text, clientMessageId: id });
    try {
      const response = await api<SendStatus>("/send", { method: "POST", body: { to, text, ...options, clientMessageId: id } });
      if (!response.requestId) throw new Error("Send response has no stable identity. Retry reuses this message.");
      last.current.accepted = true; setRequestId(response.requestId);
      setStatus(response.status === "queued" || response.status === "deferred" ? "Queued" : "Checking phone outcome…"); return true;
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Request outcome unknown. Retry reuses this message."); return false; }
    finally { inFlight.current = false; setBusy(false); }
  };
  return { send, busy, status, requestId, clientMessageId, outgoing };
}
