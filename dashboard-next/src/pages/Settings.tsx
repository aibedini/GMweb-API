import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, Clock3, Gauge, Loader2, Save, Shuffle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SendPacingSettings = {
  maxPerMinute: number;
  randomDelayEnabled: boolean;
  randomExtraSeconds: number;
  minimumIntervalSeconds: number;
  maximumIntervalSeconds: number;
  updatedAt: string | null;
};

type SettingsResponse = {
  version: string;
  settings: SendPacingSettings;
};

export function SettingsPage() {
  const [maxPerMinute, setMaxPerMinute] = useState("4");
  const [randomDelayEnabled, setRandomDelayEnabled] = useState(false);
  const [randomExtraSeconds, setRandomExtraSeconds] = useState("0");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    api<SettingsResponse>("/admin/settings/send-pacing", { headers: { "Content-Type": "text/plain" } })
      .then(({ settings }) => {
        setMaxPerMinute(String(settings.maxPerMinute));
        setRandomDelayEnabled(settings.randomDelayEnabled);
        setRandomExtraSeconds(String(settings.randomExtraSeconds));
        setSavedAt(settings.updatedAt);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load send settings."))
      .finally(() => setLoading(false));
  }, []);

  const preview = useMemo(() => {
    const rate = Math.min(60, Math.max(1, Number(maxPerMinute) || 1));
    const random = randomDelayEnabled ? Math.min(120, Math.max(0, Number(randomExtraSeconds) || 0)) : 0;
    const minimum = Math.ceil((600 / rate)) / 10;
    return { rate, random, minimum, maximum: Math.round((minimum + random) * 10) / 10 };
  }, [maxPerMinute, randomDelayEnabled, randomExtraSeconds]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await api<SettingsResponse & { ok: boolean; appliedImmediately: boolean }>("/admin/settings/send-pacing", {
        method: "PUT",
        body: {
          maxPerMinute: Number(maxPerMinute),
          randomDelayEnabled,
          randomExtraSeconds: Number(randomExtraSeconds)
        }
      });
      setMaxPerMinute(String(result.settings.maxPerMinute));
      setRandomDelayEnabled(result.settings.randomDelayEnabled);
      setRandomExtraSeconds(String(result.settings.randomExtraSeconds));
      setSavedAt(result.settings.updatedAt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save send settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="flex min-h-[240px] items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
      <form onSubmit={save}>
        <Card className="overflow-hidden">
          <CardHeader className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent">
            <div>
              <CardTitle>Send pacing</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">Control global queue throughput without restarting the service.</p>
            </div>
            <div className="flex size-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
              <Gauge className="size-5" />
            </div>
          </CardHeader>
          <CardContent className="space-y-6 p-5">
            <div className="grid gap-3 sm:grid-cols-[1fr_150px] sm:items-center">
              <div>
                <Label htmlFor="max-per-minute" className="text-sm font-medium">Maximum messages per minute</Label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Messages are spread evenly across the minute instead of being sent as a burst.</p>
              </div>
              <div className="relative">
                <Input
                  id="max-per-minute"
                  type="number"
                  min={1}
                  max={60}
                  required
                  value={maxPerMinute}
                  onChange={(event) => setMaxPerMinute(event.target.value)}
                  className="h-11 pr-16 text-right font-mono text-base"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">/ min</span>
              </div>
            </div>

            <div className="h-px bg-border" />

            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border", randomDelayEnabled ? "border-violet-400/30 bg-violet-400/10 text-violet-300" : "border-border bg-muted/50 text-muted-foreground")}>
                    <Shuffle className="size-4" />
                  </div>
                  <div>
                    <Label htmlFor="random-delay" className="text-sm font-medium">Random extra delay</Label>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Add a different human-like pause between each pair of messages.</p>
                  </div>
                </div>
                <button
                  id="random-delay"
                  type="button"
                  role="switch"
                  aria-checked={randomDelayEnabled}
                  onClick={() => setRandomDelayEnabled((value) => !value)}
                  className={cn("relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", randomDelayEnabled ? "border-primary bg-primary" : "border-border bg-muted")}
                >
                  <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform", randomDelayEnabled ? "translate-x-5" : "translate-x-0.5")} />
                </button>
              </div>

              <div className={cn("grid gap-3 rounded-lg border px-4 py-3 transition-colors sm:grid-cols-[1fr_150px] sm:items-center", randomDelayEnabled ? "border-violet-400/20 bg-violet-400/5" : "border-border bg-muted/20 opacity-60")}>
                <div>
                  <Label htmlFor="random-seconds">Maximum random addition</Label>
                  <p className="mt-1 text-xs text-muted-foreground">A random value from 0 to this number is added each time.</p>
                </div>
                <div className="relative">
                  <Input
                    id="random-seconds"
                    type="number"
                    min={0}
                    max={120}
                    required
                    disabled={!randomDelayEnabled}
                    value={randomExtraSeconds}
                    onChange={(event) => setRandomExtraSeconds(event.target.value)}
                    className="h-10 pr-12 text-right font-mono"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">sec</span>
                </div>
              </div>
            </div>

            {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {savedAt && <><CheckCircle2 className="size-4 text-emerald-400" /> Last saved {new Date(savedAt).toLocaleTimeString()}</>}
              </div>
              <Button type="submit" disabled={saving} className="min-w-32">
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {saving ? "Applying…" : "Save & apply"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>

      <Card className="h-fit overflow-hidden">
        <CardHeader>
          <CardTitle>Effective timing</CardTitle>
          <Clock3 className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="space-y-5 p-5">
          <div>
            <div className="text-3xl font-semibold tabular-nums">{preview.rate}<span className="ml-1 text-sm font-normal text-muted-foreground">messages/min</span></div>
            <p className="mt-1 text-xs text-muted-foreground">Global limit for every queued message.</p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">Base interval</span><span className="font-mono">{preview.minimum}s</span></div>
            <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">Random addition</span><span className="font-mono">{randomDelayEnabled ? `0–${preview.random}s` : "Off"}</span></div>
            <div className="flex items-center justify-between border-t border-border pt-2 text-xs font-medium"><span>Actual interval</span><span className="font-mono text-primary">{preview.minimum}{preview.maximum !== preview.minimum ? `–${preview.maximum}` : ""}s</span></div>
          </div>
          <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3 text-xs leading-relaxed text-emerald-200/80">
            Save applies immediately—even if the next message is already waiting in the pacing stage.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
