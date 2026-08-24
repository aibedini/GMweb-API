import { useEffect, useState } from "react";
import { Play, RotateCcw, Globe, MonitorUp, MonitorX, Activity, Power, PowerOff, Smartphone, CheckCircle2, XCircle } from "lucide-react";
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
};

export function ControlsPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [powerOn, setPowerOn] = useState<boolean | null>(null);
  const [transport, setTransport] = useState<TransportState | null>(null);

  useEffect(() => {
    api<PowerResponse>("/admin/power")
      .then((r) => setPowerOn(r.powerOn))
      .catch(() => setPowerOn(null));
    api<TransportState>("/admin/transport")
      .then(setTransport)
      .catch(() => setTransport(null));
  }, []);

  async function run(action: string) {
    setBusy(action);
    setMsg("");
    try {
      const r = await api<{ ok: boolean; queued?: boolean; powerOn?: boolean }>("/admin/action", { method: "POST", body: { action } });
      if (action === "power-off" || action === "power-on") {
        setPowerOn(r.powerOn ?? action === "power-on");
      }
      setMsg(`${action}: ${r.queued ? "queued" : r.ok ? "done" : "failed"}`);
    } catch (err) {
      setMsg(`${action}: ${err instanceof Error ? err.message : "error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function switchTransport(next: TransportName) {
    if (!transport || transport.transport === next) return;
    setBusy("transport");
    setMsg("");
    try {
      await api<{ ok: boolean }>("/admin/transport", { method: "POST", body: { transport: next } });
      setTransport({ ...transport, transport: next });
      setMsg(`delivery switched to ${next}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "switch failed");
    } finally {
      setBusy(null);
    }
  }

  function TransportOption({ id, title, hint, ready, configured = true }: { id: TransportName; title: string; hint: string; ready?: boolean | null; configured?: boolean }) {
    const active = transport?.transport === id;
    return (
      <button
        type="button"
        disabled={busy !== null || active || (id === "android" && transport != null && !transport.androidConfigured)}
        onClick={() => switchTransport(id)}
        className={cn(
          "flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
          active ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
          busy !== null && !active && "opacity-60"
        )}
      >
        <div className={cn(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border",
          active ? "border-primary/30 bg-primary/15 text-primary" : "border-border bg-muted/50 text-muted-foreground"
        )}>
          <Smartphone className="size-4" />
        </div>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            {title}
            {active && <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">active</span>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{hint}</span>
          {!configured ? (
            <span className="mt-1 flex items-center gap-1 text-[11px] text-amber-400"><XCircle className="size-3" /> not configured (ANDROID_GATEWAY_*)</span>
          ) : ready != null && (
            <span className={cn("mt-1 flex items-center gap-1 text-[11px]", ready ? "text-emerald-400" : "text-red-400")}>
              {ready ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
              {ready ? "ready" : "unreachable"}
            </span>
          )}
        </span>
      </button>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Send power</CardTitle>
          <span className={cn("text-xs", powerOn === false ? "font-semibold text-destructive" : "text-muted-foreground")}>
            {powerOn === null ? "Checking…" : powerOn ? "On — messages send normally." : "OFF — no message will be sent until you power on."}
          </span>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button variant="destructive" disabled={busy !== null || powerOn === false} onClick={() => run("power-off")} className="justify-start">
            <PowerOff className="size-4" /> Power Off
          </Button>
          <Button variant="secondary" disabled={busy !== null || powerOn === true} onClick={() => run("power-on")} className="justify-start">
            <Power className="size-4" /> Power On
          </Button>
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Delivery transport</CardTitle>
          <span className="max-w-[16rem] text-right text-xs text-muted-foreground">
            {transport
              ? `via ${transport.transport === "chrome" ? "Google Messages web" : "Android gateway"}`
              : "Checking…"}
          </span>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <TransportOption
            id="chrome"
            title="Google Messages web"
            hint="Paired Chrome browser automation"
            ready={transport?.chromeReady ?? null}
          />
          <TransportOption
            id="android"
            title="Android gateway"
            hint="Messages app relay (SIM delivery)"
            ready={transport?.androidReady ?? null}
            configured={transport?.androidConfigured ?? false}
          />
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Controls</CardTitle>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          {ACTIONS.map((a) => {
            const Icon = a.icon;
            return (
              <Button key={a.id} variant="secondary" disabled={busy !== null} onClick={() => run(a.id)} className="justify-start">
                <Icon className="size-4" /> {a.label}
              </Button>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
