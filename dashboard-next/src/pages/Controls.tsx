import { useCallback, useEffect, useState } from "react";
import {
  Play, RotateCcw, Globe, MonitorUp, MonitorX, Activity, Power, PowerOff,
  Smartphone, CheckCircle2, XCircle, AlertTriangle, Loader2,
  RefreshCw, ArrowLeftRight, Inbox, Send as SendIcon
} from "lucide-react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ACTIONS = [
  { id: "browser-start", label: "Start Browser", icon: Play },
  { id: "browser-restart", label: "Restart Browser", icon: RotateCcw },
  { id: "restart-chrome", label: "Restart Chrome", icon: Globe },
  { id: "vnc-on", label: "VNC On", icon: MonitorUp },
  { id: "vnc-off", label: "VNC Off", icon: MonitorX },
  { id: "smoke", label: "Smoke Test", icon: Activity },
] as const;

type PowerResponse = { ok: boolean; powerOn: boolean; changedAt: string };
type TransportName = "chrome" | "android";
type TransportState = {
  ok: boolean;
  transport: TransportName;
  available: string[];
  chromeReady: boolean;
  androidReady: boolean;
  androidConfigured: boolean;
  androidMode?: "pull" | "push";
  androidDevices?: number;
  androidPending?: number;
  androidInflight?: number;
};

export function ControlsPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [powerOn, setPowerOn] = useState<boolean | null>(null);
  const [transport, setTransport] = useState<TransportState | null>(null);

  const loadTransport = useCallback(() => {
    api<TransportState>("/admin/transport").then(setTransport).catch(() => setTransport(null));
  }, []);

  useEffect(() => {
    api<PowerResponse>("/admin/power").then((r) => setPowerOn(r.powerOn)).catch(() => setPowerOn(null));
    loadTransport();
    // Live-refresh transport state so device connections / queue depth stay current.
    const t = setInterval(loadTransport, 5000);
    return () => clearInterval(t);
  }, [loadTransport]);

  async function run(action: string) {
    setBusy(action);
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; queued?: boolean; powerOn?: boolean }>("/admin/action", { method: "POST", body: { action } });
      if (action === "power-off" || action === "power-on") setPowerOn(r.powerOn ?? action === "power-on");
      setMsg({ kind: "ok", text: `${action}: ${r.queued ? "queued" : r.ok ? "done" : "failed"}` });
    } catch (err) {
      setMsg({ kind: "err", text: `${action}: ${err instanceof Error ? err.message : "error"}` });
    } finally {
      setBusy(null);
    }
  }

  async function switchTransport(next: TransportName) {
    if (!transport || transport.transport === next || busy) return;
    setBusy("transport");
    setMsg(null);
    try {
      await api<{ ok: boolean }>("/admin/transport", { method: "POST", body: { transport: next } });
      setTransport({ ...transport, transport: next });
      setMsg({ kind: "ok", text: `Delivery switched to ${next === "chrome" ? "Google Messages web" : "Android gateway"}` });
      loadTransport();
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "switch failed" });
    } finally {
      setBusy(null);
    }
  }

  const active = transport?.transport;
  const pullMode = transport?.androidMode !== "push";

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* Send power */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Send power</CardTitle>
            <p className={cn("mt-1 text-xs", powerOn === false ? "font-medium text-destructive" : "text-muted-foreground")}>
              {powerOn === null ? "Checking…" : powerOn ? "On — messages send normally." : "OFF — nothing sends until you power on."}
            </p>
          </div>
          <span className={cn(
            "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
            powerOn ? "bg-emerald-500/15 text-emerald-400" : "bg-destructive/15 text-destructive"
          )}>
            <span className={cn("size-1.5 rounded-full", powerOn ? "bg-emerald-400" : "bg-destructive")} />
            {powerOn === null ? "…" : powerOn ? "Live" : "Halted"}
          </span>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button variant="destructive" disabled={busy !== null || powerOn === false} onClick={() => run("power-off")}>
            <PowerOff className="size-4" /> Power Off
          </Button>
          <Button variant="secondary" disabled={busy !== null || powerOn === true} onClick={() => run("power-on")}>
            <Power className="size-4" /> Power On
          </Button>
        </CardContent>
      </Card>

      {/* Delivery transport */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ArrowLeftRight className="size-4 text-primary" /> Delivery transport
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              How outgoing SMS is delivered. Switching takes effect immediately and is remembered across restarts.
            </p>
          </div>
          <button
            onClick={loadTransport}
            className="text-muted-foreground transition-colors hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="size-4" />
          </button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <TransportCard
              icon={Globe}
              title="Google Messages web"
              subtitle="Chrome automation on this server"
              active={active === "chrome"}
              busy={busy === "transport"}
              onClick={() => switchTransport("chrome")}
              status={
                transport == null ? { tone: "muted", label: "Checking…" }
                : transport.chromeReady ? { tone: "ok", label: "Paired & ready" }
                : { tone: "warn", label: "Not paired — open Browser / scan QR" }
              }
            />
            <TransportCard
              icon={Smartphone}
              title="Android gateway"
              subtitle="Messages app · real SIM delivery"
              active={active === "android"}
              busy={busy === "transport"}
              onClick={() => switchTransport("android")}
              status={
                transport == null ? { tone: "muted", label: "Checking…" }
                : !transport.androidConfigured
                  ? { tone: "warn", label: pullMode ? "No device key set on server" : "ANDROID_GATEWAY_* not set" }
                  : transport.androidReady ? { tone: "ok", label: pullMode ? "Device connected" : "Phone reachable" }
                  : { tone: "warn", label: pullMode ? "Waiting for a device" : "Phone unreachable" }
              }
            />
          </div>

          {/* Android gateway detail — always visible so the user knows the wiring */}
          {transport && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
              <div className="mb-2 flex items-center gap-2 font-medium">
                <Smartphone className="size-3.5 text-muted-foreground" />
                Android gateway
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {pullMode ? "pull mode" : "push mode"}
                </span>
              </div>
              {pullMode ? (
                <>
                  <p className="leading-relaxed text-muted-foreground">
                    The phone dials out to this server and picks up messages — no tunnel or static IP needed.
                  </p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <Stat icon={Smartphone} label="Devices" value={transport.androidDevices ?? 0} tone={(transport.androidDevices ?? 0) > 0 ? "ok" : "muted"} />
                    <Stat icon={Inbox} label="Waiting" value={transport.androidPending ?? 0} tone={(transport.androidPending ?? 0) > 0 ? "warn" : "muted"} />
                    <Stat icon={SendIcon} label="Sending" value={transport.androidInflight ?? 0} tone={(transport.androidInflight ?? 0) > 0 ? "ok" : "muted"} />
                  </div>
                  {!transport.androidConfigured && (
                    <p className="mt-2 flex items-start gap-1.5 text-amber-400">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      <span>Set <code className="rounded bg-background px-1">GMWEB_ANDROID_DEVICE_KEY</code> in the server's <code className="rounded bg-background px-1">.env</code>, then point the Messages app at this server's HTTPS URL.</span>
                    </p>
                  )}
                  {transport.androidConfigured && (transport.androidDevices ?? 0) === 0 && (
                    <p className="mt-2 flex items-start gap-1.5 text-muted-foreground">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-400" />
                      <span>Key is set but no device is polling yet. In the Messages app → Gateway → paste this server's URL and enable the gateway.</span>
                    </p>
                  )}
                </>
              ) : (
                <p className="leading-relaxed text-muted-foreground">
                  Push mode: this server connects out to the phone at a fixed URL (needs a tunnel / static address).
                  Configure <code className="rounded bg-background px-1">ANDROID_GATEWAY_BASE_URL</code> and <code className="rounded bg-background px-1">ANDROID_GATEWAY_API_KEY</code>.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* System controls */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <CardTitle>System controls</CardTitle>
          {msg && (
            <span className={cn("truncate text-xs", msg.kind === "ok" ? "text-emerald-400" : "text-destructive")}>{msg.text}</span>
          )}
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {ACTIONS.map((a) => {
            const Icon = a.icon;
            const isBusy = busy === a.id;
            return (
              <Button key={a.id} variant="secondary" disabled={busy !== null} onClick={() => run(a.id)} className="justify-start">
                {isBusy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />} {a.label}
              </Button>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

type Tone = "ok" | "warn" | "muted";

function TransportCard({
  icon: Icon, title, subtitle, active, busy, onClick, status,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  active: boolean;
  busy: boolean;
  onClick: () => void;
  status: { tone: Tone; label: string };
}) {
  const StatusIcon = status.tone === "ok" ? CheckCircle2 : status.tone === "warn" ? AlertTriangle : XCircle;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={active || busy}
      className={cn(
        "group relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-all",
        active
          ? "border-primary bg-primary/10 shadow-sm"
          : "border-border hover:border-primary/40 hover:bg-accent cursor-pointer",
        busy && "opacity-60"
      )}
    >
      <div className="flex items-center justify-between">
        <div className={cn(
          "flex size-9 items-center justify-center rounded-lg border",
          active ? "border-primary/30 bg-primary/15 text-primary" : "border-border bg-muted/50 text-muted-foreground group-hover:text-foreground"
        )}>
          <Icon className="size-4" />
        </div>
        {active ? (
          <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
            Active
          </span>
        ) : (
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            Switch →
          </span>
        )}
      </div>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <div className={cn(
        "flex items-center gap-1.5 text-[11px]",
        status.tone === "ok" ? "text-emerald-400" : status.tone === "warn" ? "text-amber-400" : "text-muted-foreground"
      )}>
        <StatusIcon className="size-3" />
        {status.label}
      </div>
    </button>
  );
}

function Stat({
  icon: Icon, label, value, tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone: Tone;
}) {
  return (
    <div className="rounded-md border border-border bg-background/50 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3" /> {label}
      </div>
      <div className={cn(
        "mt-0.5 text-lg font-semibold tabular-nums",
        tone === "ok" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : "text-foreground"
      )}>
        {value}
      </div>
    </div>
  );
}
