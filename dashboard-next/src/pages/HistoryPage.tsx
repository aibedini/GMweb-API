import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Clipboard, History, RefreshCw, Search } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SendHistoryItem, SendHistoryResponse, SendHistoryStats } from "@/lib/types";
import { useSSE } from "@/hooks/useSSE";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const FILTERS = ["all", "queued", "active", "sent", "unverified", "failed", "suppressed", "cancelled"];

function dateTime(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function statusStyle(status: string) {
  if (status === "sent") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (status === "failed") return "border-red-500/30 bg-red-500/10 text-red-300";
  if (status === "unverified") return "border-orange-500/30 bg-orange-500/10 text-orange-300";
  if (status === "active") return "border-violet-500/30 bg-violet-500/10 text-violet-300";
  if (status === "queued") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  return "border-zinc-500/30 bg-zinc-500/10 text-zinc-300";
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <Button variant="ghost" size="icon" className="h-7 w-7" title={`Copy ${label}`} aria-label={`Copy ${label}`} onClick={async () => {
    await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200);
  }}>{copied ? <Check className="size-3.5 text-emerald-400" /> : <Clipboard className="size-3.5" />}</Button>;
}

function SendRecord({ send }: { send: SendHistoryItem }) {
  const [open, setOpen] = useState(false);
  const text = send.text || send.textPreview || "(empty message)";
  const canCollapse = text.length > 220 || text.split("\n").length > 5;
  return <article className="mx-2 my-2 rounded-lg border border-border bg-background/30 px-3 py-3 shadow-sm lg:mx-0 lg:my-0 lg:rounded-none lg:border-x-0 lg:border-t-0 lg:bg-transparent lg:px-4 lg:py-4 lg:shadow-none lg:last:border-b-0">
    <div className="grid gap-4 lg:grid-cols-[170px_minmax(0,1fr)_220px]">
      <div className="space-y-2">
        <Badge variant="outline" className={cn("uppercase", statusStyle(send.status))}>{send.status}</Badge>
        <div className="flex items-center gap-1 font-mono text-sm font-semibold"><span dir="ltr">{send.to || "—"}</span>{send.to && <CopyButton value={send.to} label="number" />}</div>
        <div className="text-xs text-muted-foreground">Project <span className="font-medium text-foreground">{send.keyName || "—"}</span></div>
        <div className="text-xs text-muted-foreground">Stage <span className="text-foreground">{send.stage || "—"}</span> · attempt {send.attempts ?? 0}</div>
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-muted-foreground"><span>Message evidence</span><CopyButton value={text} label="message" /></div>
        <div dir="auto" className={cn("whitespace-pre-wrap break-words rounded-md border border-border bg-background/70 px-3 py-2.5 text-sm leading-6 shadow-inner", !open && canCollapse && "max-h-28 overflow-hidden")}>{text}</div>
        {canCollapse && <button className="mt-1.5 flex items-center gap-1 text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary" onClick={() => setOpen(!open)}>{open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}{open ? "Collapse" : "Show full message"}</button>}
        {send.error && <div className="mt-2 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="break-words">{send.error}</span></div>}
      </div>
      <div className="space-y-2 border-t border-border/70 pt-3 lg:border-t-0 lg:pt-0">
        <dl className="grid grid-cols-2 gap-2 text-[11px] lg:grid-cols-[62px_1fr] lg:gap-x-2 lg:gap-y-1">
          <div className="min-w-0 lg:contents"><dt className="font-medium text-muted-foreground">Created</dt><dd className="mt-0.5 text-foreground/80 lg:mt-0">{dateTime(send.createdAt)}</dd></div>
          <div className="min-w-0 lg:contents"><dt className="font-medium text-muted-foreground">Updated</dt><dd className="mt-0.5 text-foreground/80 lg:mt-0">{dateTime(send.updatedAt)}</dd></div>
          <div className="col-span-2 min-w-0 lg:contents"><dt className="font-medium text-muted-foreground">{send.sentAt ? "Sent" : "Finished"}</dt><dd className="mt-0.5 text-foreground/80 lg:mt-0">{dateTime(send.sentAt || send.finishedAt)}</dd></div>
        </dl>
        <dl className="grid grid-cols-[58px_1fr] gap-x-2 gap-y-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-[11px]">
          <dt className="font-medium text-muted-foreground">Send ID</dt><dd className="break-all font-mono text-foreground/80">{String(send.id)}</dd>
          <dt className="font-medium text-muted-foreground">Job ID</dt><dd className="break-all font-mono text-foreground/80">{send.jobId || "—"}</dd>
        </dl>
      </div>
    </div>
  </article>;
}

export function HistoryPage() {
  const [sends, setSends] = useState<SendHistoryItem[]>([]);
  const [stats, setStats] = useState<SendHistoryStats>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const load = useCallback(async () => {
    try {
      const data = await api<SendHistoryResponse>("/admin/sends?limit=500", { headers: { "Content-Type": "text/plain" } });
      setSends(data.sends || []); setStats(data.stats || {}); setError(""); setStaleSince(null); setUpdatedAt(Date.now());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Network error"); setStaleSince((v) => v ?? Date.now());
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 9000); return () => clearInterval(t); }, [load]);
  useSSE((e) => { if (e.type.startsWith("send_") || e.type.startsWith("queue_")) load(); }, true);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return sends.filter((s) => (status === "all" || s.status === status) && (!q || [s.to, s.text, s.textPreview, s.keyName, s.jobId, s.id, s.error, s.stage].some((v) => String(v ?? "").toLocaleLowerCase().includes(q))));
  }, [sends, query, status]);
  const count = (name: string) => stats[name] ?? sends.filter((s) => s.status === name).length;
  const summary = [["Queued", count("queued")], ["Active", count("active")], ["Sent", count("sent")], ["Unverified", count("unverified")], ["Failed", count("failed")], ["Suppressed / cancelled", count("suppressed") + count("cancelled")]] as const;
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">{summary.map(([label, value]) => <Card key={label} className="bg-card/60"><CardContent className="p-3"><div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>{label === "Suppressed / cancelled" && <div className="mt-1 text-[10px] text-muted-foreground">{count("suppressed")} suppressed · {count("cancelled")} cancelled</div>}</CardContent></Card>)}</div>
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle className="flex items-center gap-2"><History className="size-5 text-primary" />Durable send ledger</CardTitle><p className="mt-1 text-xs text-muted-foreground">“Sent” means an outgoing bubble was confirmed in Google Messages; it does not mean carrier delivery.</p></div><Button variant="secondary" size="sm" onClick={load} disabled={loading}><RefreshCw className={cn("size-4", loading && "animate-spin")} />Refresh</Button></div>
        <div className="flex flex-col gap-2 sm:flex-row"><label className="relative flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search number, project, message, error or ID…" className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary" /></label><select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary">{FILTERS.map((v) => <option key={v} value={v}>{v === "all" ? "All statuses" : v}</option>)}</select></div>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{filtered.length} of {sends.length} records</span><span>{staleSince ? <span className="text-red-300">Not updating since {dateTime(new Date(staleSince).toISOString())}</span> : updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : "Loading…"}</span></div>
        {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">Could not load send history: {error}. Existing data may be stale.</div>}
      </CardHeader>
      <CardContent className="p-0">{loading && sends.length === 0 ? <div className="p-10 text-center text-sm text-muted-foreground">Loading send history…</div> : sends.length === 0 ? <div className="p-10 text-center text-sm text-muted-foreground">No durable send records yet.</div> : filtered.length === 0 ? <div className="p-10 text-center text-sm text-muted-foreground">No records match the current filters.</div> : <div>{filtered.map((send) => <SendRecord key={String(send.id)} send={send} />)}</div>}</CardContent>
    </Card>
  </div>;
}
