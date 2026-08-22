import { useEffect, useState } from "react";
import { Play, RotateCcw, Globe, MonitorUp, MonitorX, Activity, Power, PowerOff } from "lucide-react";
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

export function ControlsPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [powerOn, setPowerOn] = useState<boolean | null>(null);

  useEffect(() => {
    api<PowerResponse>("/admin/power")
      .then((r) => setPowerOn(r.powerOn))
      .catch(() => setPowerOn(null));
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
