import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { Overview, QueueStatus, TransportState } from "@/lib/types";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function StatePill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm font-medium", ok ? "text-emerald-400" : "text-red-400")}>
      {ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
      {label}
    </span>
  );
}

function bytes(value = 0) {
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function ResourceBar({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
      <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

function shortAge(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return null;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

/**
 * Labels come from the server's explicit state, never from a transport display
 * string. "Stale" (a configured device that went quiet) and "unconfigured" (no
 * device key at all) are different operator problems and must read differently.
 */
function deliveryLabel(state: TransportState | undefined, active: "chrome" | "android", ready: boolean): string {
  if (ready) return active === "android" ? "Phone ready" : "Paired";
  switch (state) {
    case "unconfigured": return "Device key not set";
    case "stale": return active === "android" ? "No recent pull" : "Not paired";
    case "push_unreachable": return "Gateway unreachable";
    case "not_paired": return "Not paired";
    default: return "Not ready";
  }
}

function bridgeLabel(state: TransportState | undefined, ready: boolean): string {
  if (ready) return "Connected";
  switch (state) {
    case "unconfigured": return "Device key not set";
    case "stale": return "No recent pull";
    case "push_unreachable": return "Unreachable";
    default: return "Unknown";
  }
}

function webAppLabel(state: string | undefined, ok: boolean | undefined, matchesApi: boolean | undefined): string {
  switch (state) {
    case "current": return "Current";
    case "version_mismatch": return "Version mismatch";
    case "pwa_assets_missing": return "Assets missing";
    case "pwa_not_built": return "Not built";
    case "pwa_manifest_invalid": return "Manifest invalid";
    default: return ok && matchesApi ? "Current" : "Not built";
  }
}

export function OverviewPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [o, q] = await Promise.all([
        api<Overview>("/admin/overview", { headers: { "Content-Type": "text/plain" } }),
        api<QueueStatus>("/admin/queue", { headers: { "Content-Type": "text/plain" } }),
      ]);
      setOv(o);
      setQueue(q);
    } catch {
      /* shown via state */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const transport = ov?.transport;
  const activeTransport: "chrome" | "android" = transport?.activeTransport === "android" ? "android" : "chrome";
  // Delivery and Device bridge are two readings of the SAME snapshot, so they
  // cannot contradict each other on one refresh.
  const paired = Boolean(transport?.ready ?? ov?.readiness?.ready);
  const bridgeReady = paired;
  const svc = (name: string) => ov?.services?.find((s) => s.name === name)?.active === "active";
  const apiOk = ov?.ok ?? false;
  const chromeOk = svc("gmweb-chrome.service");
  const automationOk = chromeOk && ov?.browserAutomation?.ok !== false;
  const vncOk = ov?.vnc?.ready ?? false;
  const system = ov?.system;
  const webApp = ov?.webApp;

  const pullAge = shortAge(transport?.lastPullAgeMs);
  const lastPull = transport?.lastPullAt ? new Date(transport.lastPullAt).toLocaleTimeString() : null;

  const metrics = [
    {
      k: "Delivery",
      node: <StatePill ok={paired} label={deliveryLabel(transport?.state, activeTransport, paired)} />,
      sub: activeTransport === "android"
        ? `Android gateway${transport?.mode ? ` · ${transport.mode} mode` : ""} · SIM delivery`
        : "Google Messages web · Chrome"
    },
    { k: "API", node: <StatePill ok={apiOk} label={apiOk ? "Healthy" : "Down"} />, sub: `v${ov?.version ?? "—"} · :3030` },
    {
      k: "Web PWA",
      node: <StatePill ok={Boolean(webApp?.ok)} label={webAppLabel(webApp?.state, webApp?.ok, webApp?.matchesApi)} />,
      sub: webApp?.ok
        ? `v${webApp.version} · ${webApp.script ?? "—"}${webApp.revision ? ` · ${webApp.revision.slice(0, 7)}` : ""}`
        : `${webApp?.reason ?? webApp?.state ?? "pwa_not_built"} · /web`,
    },
    activeTransport === "android"
      ? {
          k: "Device bridge",
          node: <StatePill ok={bridgeReady} label={bridgeLabel(transport?.state, bridgeReady)} />,
          sub: bridgeReady
            ? [
                lastPull ? `last pull ${lastPull}` : null,
                transport?.waitingPhones ? `${transport.waitingPhones} device polling` : null
              ].filter(Boolean).join(" · ") || "phone long-polls /gateway/pull"
            : `${transport?.reason ?? "no_recent_device_pull"}${pullAge ? ` · last pull ${pullAge}` : ""}`
        }
      : {
          k: "Chrome automation",
          node: <StatePill ok={automationOk} label={!chromeOk ? "Stopped" : ov?.browserAutomation?.ok === false ? "Hung" : "Healthy"} />,
          sub: `${ov?.browserAutomation?.code ?? "not checked"}${ov?.browserAutomation?.latencyMs ? ` · ${ov.browserAutomation.latencyMs}ms` : ""}`
        },
    { k: "VNC", node: <StatePill ok={vncOk} label={vncOk ? "On" : "Off"} />, sub: "pairing console (chrome only)" },
  ];

  // QUEUE NOW is live BullMQ state. Delivery OUTCOMES are durable ledger rows
  // for a stated window. They are never merged: an all-time failure total must
  // never read as "the queue is currently failing".
  const queueNow = queue?.queue;
  const outcomes = queue?.ledger?.last24h;
  const allTime = queue?.ledger?.allTime;
  // Backend is the single source of truth for "idle": it accounts for delayed,
  // prioritized and paused jobs too. Recomputing it here would silently drift.
  const liveIdle = queue?.idle ?? false;
  const queueCards: Array<{ k: string; v: number; tone: string }> = [
    { k: "Waiting", v: queueNow?.waiting ?? 0, tone: "text-amber-400" },
    { k: "Active", v: queueNow?.active ?? 0, tone: "text-primary" },
    { k: "Delayed", v: queueNow?.delayed ?? 0, tone: "text-sky-400" },
    { k: "Prioritized", v: queueNow?.prioritized ?? 0, tone: "text-violet-400" },
    { k: "Held (paused)", v: queueNow?.paused ?? 0, tone: "text-zinc-400" },
  ];
  const outcomeCards: Array<{ k: string; v: number; tone: string }> = [
    { k: "Sent", v: outcomes?.sent ?? 0, tone: "text-emerald-400" },
    { k: "Failed", v: outcomes?.failed ?? 0, tone: "text-red-400" },
    { k: "Unverified", v: outcomes?.unverified ?? 0, tone: "text-amber-400" },
    { k: "Superseded", v: outcomes?.superseded ?? 0, tone: "text-zinc-400" },
    { k: "Cancelled", v: outcomes?.cancelled ?? 0, tone: "text-zinc-500" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {metrics.map((m) => (
          <SpotlightCard key={m.k} className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{m.k}</div>
            <div className="mt-2">{m.node}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground" title={m.sub}>{m.sub}</div>
          </SpotlightCard>
        ))}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">System resources</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <SpotlightCard className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">CPU</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{system?.cpu.usagePercent?.toFixed(1) ?? "—"}%</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {system ? `${system.cpu.cores} cores · load ${system.cpu.load1.toFixed(2)} (${system.cpu.loadPercent.toFixed(0)}%)` : "—"}
            </div>
            <ResourceBar value={system?.cpu.usagePercent ?? 0} tone={(system?.cpu.usagePercent ?? 0) > 90 ? "bg-red-500" : "bg-primary"} />
          </SpotlightCard>
          <SpotlightCard className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Memory</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{system?.memory.usagePercent?.toFixed(1) ?? "—"}%</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {system ? `${bytes(system.memory.usedBytes)} / ${bytes(system.memory.totalBytes)} · ${bytes(system.memory.availableBytes)} available` : "—"}
            </div>
            <ResourceBar value={system?.memory.usagePercent ?? 0} tone={(system?.memory.usagePercent ?? 0) > 90 ? "bg-red-500" : "bg-emerald-500"} />
          </SpotlightCard>
          <SpotlightCard className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Swap</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{system?.swap.usagePercent?.toFixed(1) ?? "—"}%</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {system ? `${bytes(system.swap.usedBytes)} / ${bytes(system.swap.totalBytes)}` : "—"}
            </div>
            <ResourceBar value={system?.swap.usagePercent ?? 0} tone="bg-amber-500" />
          </SpotlightCard>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Queue now</h2>
          <span className="text-xs text-muted-foreground">live BullMQ state</span>
          {queue?.paused
            ? <Badge variant="warning">paused</Badge>
            : liveIdle && <Badge variant="success">idle</Badge>}
          {queue?.powerOn === false && <Badge variant="warning">power off</Badge>}
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {queueCards.map((c) => (
            <SpotlightCard key={c.k} className="p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.k}</div>
              <div className={cn("mt-2 text-3xl font-semibold tabular-nums", c.tone)}>
                <AnimatedNumber value={c.v} />
              </div>
            </SpotlightCard>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Delivery outcomes — last 24 hours</h2>
          <span className="text-xs text-muted-foreground">
            {allTime
              ? `all-time ${allTime.sent} sent · ${allTime.failed} failed`
              : "durable ledger"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {outcomeCards.map((c) => (
            <SpotlightCard key={c.k} className="p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.k}</div>
              <div className={cn("mt-2 text-3xl font-semibold tabular-nums", c.tone)}>
                <AnimatedNumber value={c.v} />
              </div>
            </SpotlightCard>
          ))}
        </div>
      </div>
    </div>
  );
}
