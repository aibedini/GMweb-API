import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ChevronDown, ChevronRight, Clock3,
  Filter, Gauge, MousePointerClick, RefreshCw, Search, ShieldCheck, Terminal,
} from "lucide-react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type LogType = "request" | "action";
type LogLevel = "info" | "warning" | "error";

interface ActivityRow {
  id: string;
  ts: string;
  type: LogType;
  category: string;
  level: LogLevel;
  title: string;
  method: string;
  path: string;
  statusCode: number;
  outcome: "success" | "failed";
  durationMs: number;
  actor: { type: string; name: string; id?: string | null };
  ip?: string | null;
  requestId?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
}

interface ActivityResponse {
  logs: ActivityRow[];
  total: number;
  facets: {
    categories: Record<string, number>;
    levels: Record<LogLevel, number>;
    types: Record<LogType, number>;
  };
}

const actorOptions = ["dashboard", "master", "api_key", "device", "anonymous"];

function Select({ value, onChange, label, children }: {
  value: string; onChange: (value: string) => void; label: string; children: React.ReactNode;
}) {
  return (
    <label className="relative min-w-36">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full appearance-none rounded-md border border-input bg-background/70 px-3 pr-8 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-ring"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-muted-foreground" />
    </label>
  );
}

function levelStyle(level: LogLevel) {
  if (level === "error") return { rail: "bg-red-500", dot: "bg-red-400", badge: "destructive" as const };
  if (level === "warning") return { rail: "bg-amber-500", dot: "bg-amber-400", badge: "warning" as const };
  return { rail: "bg-emerald-500", dot: "bg-emerald-400", badge: "success" as const };
}

export function LogsPage() {
  const [data, setData] = useState<ActivityResponse>({ logs: [], total: 0, facets: { categories: {}, levels: { info: 0, warning: 0, error: 0 }, types: { request: 0, action: 0 } } });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [type, setType] = useState("");
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [actorType, setActorType] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    const query = new URLSearchParams({ limit: "300" });
    if (type) query.set("type", type);
    if (category) query.set("category", category);
    if (level) query.set("level", level);
    if (actorType) query.set("actorType", actorType);
    if (search) query.set("search", search);
    try {
      setData(await api<ActivityResponse>(`/admin/activity-logs?${query}`));
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load activity logs");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [actorType, category, level, search, type]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const averageLatency = useMemo(() => data.logs.length
    ? Math.round(data.logs.reduce((sum, row) => sum + row.durationMs, 0) / data.logs.length)
    : 0, [data.logs]);
  const incidents = (data.facets.levels.warning || 0) + (data.facets.levels.error || 0);
  const categories = Object.entries(data.facets.categories).sort((a, b) => b[1] - a[1]);

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    setSearch(searchInput.trim());
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            <span className="relative flex size-2"><span className={cn("absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50", (!autoRefresh || error) && "hidden")} /><span className={cn("relative inline-flex size-2 rounded-full", error ? "bg-red-500" : autoRefresh ? "bg-emerald-500" : "bg-slate-500")} /></span>
            {error ? "Telemetry stale" : autoRefresh ? "Live telemetry" : "Refresh paused"}
            {lastUpdated && <span className="normal-case tracking-normal text-muted-foreground">· updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Activity intelligence</h1>
          <p className="mt-1 text-sm text-muted-foreground">Requests, operator actions, failures and timing in one audit trail.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setAutoRefresh((value) => !value)} aria-pressed={autoRefresh}>
            <Activity className="size-4" /> Auto {autoRefresh ? "on" : "off"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Recorded events", value: data.total, icon: Terminal, tone: "text-blue-400" },
          { label: "Operator actions", value: data.facets.types.action || 0, icon: MousePointerClick, tone: "text-violet-400" },
          { label: "Warnings + errors", value: incidents, icon: AlertTriangle, tone: incidents ? "text-amber-400" : "text-emerald-400" },
          { label: "Average latency", value: `${averageLatency} ms`, icon: Gauge, tone: "text-cyan-400" },
        ].map((stat) => (
          <Card key={stat.label} className="bg-card/70">
            <CardContent className="flex items-center justify-between p-4">
              <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{stat.label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{stat.value}</p></div>
              <stat.icon className={cn("size-5", stat.tone)} />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="gap-4 border-b border-border bg-muted/20">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4 text-primary" /> Audit stream</CardTitle>
            <div className="flex rounded-lg border border-border bg-background/60 p-1">
              {[{ id: "", label: "All activity" }, { id: "action", label: "Actions" }, { id: "request", label: "Requests" }].map((tab) => (
                <button key={tab.id} onClick={() => setType(tab.id)} className={cn("rounded-md px-3 py-1.5 text-xs font-medium transition", type === tab.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>{tab.label}</button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <form onSubmit={submitSearch} className="relative min-w-56 flex-1">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input aria-label="Search logs" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search route, actor, IP or request ID…" className="pl-9" />
            </form>
            <Select label="Category" value={category} onChange={setCategory}><option value="">All categories</option>{categories.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}</Select>
            <Select label="Severity" value={level} onChange={setLevel}><option value="">All severity</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></Select>
            <Select label="Actor" value={actorType} onChange={setActorType}><option value="">All actors</option>{actorOptions.map((actor) => <option key={actor} value={actor}>{actor.replace("_", " ")}</option>)}</Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error && data.logs.length > 0 && (
            <div className="m-3 flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"><span>Refresh failed; showing the last successful snapshot. {error}</span><Button variant="secondary" size="sm" onClick={() => load()}>Retry</Button></div>
          )}
          {error && data.logs.length === 0 ? (
            <div className="m-4 flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"><span>{error}</span><Button variant="secondary" size="sm" onClick={() => load()}>Retry</Button></div>
          ) : loading && data.logs.length === 0 ? (
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><RefreshCw className="size-4 animate-spin" /> Loading activity trail…</div>
          ) : data.logs.length === 0 ? (
            <div className="flex h-52 flex-col items-center justify-center text-center"><Filter className="mb-3 size-8 text-muted-foreground/50" /><p className="font-medium">No activity matches these filters</p><p className="mt-1 text-sm text-muted-foreground">New requests and actions will appear here automatically.</p></div>
          ) : (
            <div className="max-h-[65vh] overflow-y-auto">
              {data.logs.map((row) => {
                const style = levelStyle(row.level);
                const open = expanded === row.id;
                return (
                  <div key={row.id} className="relative border-b border-border last:border-0">
                    <span className={cn("absolute inset-y-0 left-0 w-0.5", style.rail)} />
                    <button onClick={() => setExpanded(open ? null : row.id)} className="grid w-full grid-cols-[20px_78px_1fr_auto] items-center gap-3 px-4 py-3 text-left transition hover:bg-muted/30 md:grid-cols-[20px_88px_110px_1fr_150px_70px_76px]">
                      {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                      <span className="font-mono text-[11px] text-muted-foreground">{new Date(row.ts).toLocaleTimeString([], { hour12: false })}</span>
                      <Badge variant={row.type === "action" ? "default" : "secondary"} className="hidden w-fit md:inline-flex">{row.type}</Badge>
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2"><span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} /><span className="truncate text-sm font-medium">{row.title}</span><Badge variant="outline" className="hidden shrink-0 capitalize lg:inline-flex">{row.category}</Badge><Badge variant={style.badge} className="hidden shrink-0 capitalize xl:inline-flex">{row.level}</Badge></span>
                        <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{row.method} {row.path}</span>
                        <span className="mt-1 flex gap-2 text-[11px] text-muted-foreground md:hidden"><span className="capitalize">{row.category}</span><span>·</span><span>{row.actor?.name || "Anonymous"}</span><span>·</span><span className={row.outcome === "failed" ? "text-amber-400" : "text-emerald-400"}>{row.outcome}</span></span>
                      </span>
                      <span className="hidden truncate text-xs text-muted-foreground md:block">{row.actor?.name || "Anonymous"}</span>
                      <span className={cn("font-mono text-xs font-semibold", row.statusCode >= 400 ? "text-amber-400" : "text-emerald-400")}>{row.statusCode}</span>
                      <span className="hidden text-right font-mono text-[11px] text-muted-foreground md:block">{row.durationMs} ms</span>
                    </button>
                    {open && (
                      <div className="border-t border-border/60 bg-background/45 px-5 py-4">
                        <div className="grid gap-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
                          <div><p className="text-muted-foreground">Exact time</p><p className="mt-1 font-mono">{new Date(row.ts).toLocaleString()}</p></div>
                          <div><p className="text-muted-foreground">Actor / IP</p><p className="mt-1">{row.actor?.name} <span className="font-mono text-muted-foreground">· {row.actor?.type}{row.actor?.id ? `:${row.actor.id}` : ""} · {row.ip || "—"}</span></p></div>
                          <div><p className="text-muted-foreground">Request ID</p><p className="mt-1 truncate font-mono">{row.requestId || "—"}</p></div>
                          <div><p className="text-muted-foreground">Category / outcome</p><p className="mt-1 capitalize">{row.type} · {row.category} · <span className={row.outcome === "failed" ? "text-amber-400" : "text-emerald-400"}>{row.outcome}</span></p></div>
                        </div>
                        <div className="mt-4 grid gap-3 xl:grid-cols-2">
                          <div className="rounded-md border border-border bg-card/50 p-3"><p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Matched route</p><p className="mb-3 break-all font-mono text-[11px]">{String(row.details?.route || row.path)}</p><p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Event details</p><pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80">{JSON.stringify(row.details || {}, null, 2)}</pre></div>
                          <div className="rounded-md border border-border bg-card/50 p-3"><p className="mb-2 flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground"><Clock3 className="size-3" /> Client context</p><p className="break-all font-mono text-[11px] text-foreground/80">{row.userAgent || "No user-agent recorded"}</p></div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
