import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, X, RefreshCw, Pause, Play, Moon, Rocket } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { QueueCounts, QueueJob, QueueQuietHours } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSSE } from "@/hooks/useSSE";
import { cn } from "@/lib/utils";

function elapsed(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function QueuePage() {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [paused, setPaused] = useState(false);
  const [quietHours, setQuietHours] = useState<QueueQuietHours | null>(null);
  const [delayedHighCount, setDelayedHighCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [bulkPriority, setBulkPriority] = useState<QueueJob["priority"]>("expiring");

  function messageFor(err: unknown) {
    return err instanceof ApiError ? err.message : "network error";
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, j] = await Promise.all([
        api<{ counts: QueueCounts; paused: boolean; quietHours: QueueQuietHours }>("/admin/queue", { headers: { "Content-Type": "text/plain" } }),
        api<{ jobs: QueueJob[]; delayedHighCount: number }>("/admin/queue/jobs?all=true", { headers: { "Content-Type": "text/plain" } }),
      ]);
      setCounts(c.counts);
      setPaused(c.paused);
      setQuietHours(c.quietHours);
      const normalizedJobs = j.jobs.map((job) => ({ ...job, id: String(job.id) }));
      setJobs(normalizedJobs);
      setDelayedHighCount(j.delayedHighCount);
      setStaleSince(null);
      // Keep only selections that still exist in the updated list
      const validIds = new Set(normalizedJobs.map((job) => job.id));
      setSelectedJobIds((prev) => prev.map(String).filter((id) => validIds.has(id)));
    } catch (err) {
      // Background polling failure: don't yell at the user every 8s, but do
      // surface it if it persists — an expired session otherwise looks
      // exactly like "the queue is frozen" with no indication why.
      setStaleSince((prev) => prev ?? Date.now());
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [load]);

  // live nudge on send events
  useSSE((e) => {
    if (e.type.startsWith("send_") || e.type.startsWith("queue_")) load().catch(() => {});
  }, true);

  const toggleSelectJob = useCallback((id: string) => {
    const canonicalId = String(id);
    setSelectedJobIds((prev) =>
      prev.includes(canonicalId) ? prev.filter((x) => x !== canonicalId) : [...prev, canonicalId]
    );
  }, []);

  const visibleJobIds = useMemo(() => jobs.map((job) => String(job.id)), [jobs]);
  const selectedSet = useMemo(() => new Set(selectedJobIds), [selectedJobIds]);
  const visibleSelectedCount = visibleJobIds.filter((id) => selectedSet.has(id)).length;
  const isAllSelected = visibleJobIds.length > 0 && visibleSelectedCount === visibleJobIds.length;
  const isSomeSelected = visibleSelectedCount > 0 && !isAllSelected;

  const toggleSelectAll = useCallback(() => {
    setSelectedJobIds((prev) => {
      const current = new Set(prev.map(String));
      const allVisibleSelected = visibleJobIds.length > 0 && visibleJobIds.every((id) => current.has(id));
      if (allVisibleSelected) return prev.filter((id) => !visibleJobIds.includes(id));
      visibleJobIds.forEach((id) => current.add(id));
      return [...current];
    });
  }, [visibleJobIds]);

  async function performBulkAction(action: "cancel" | "complete" | "priority") {
    if (busyAction || selectedJobIds.length === 0) return;
    const actionLabel = action === "priority" ? `change priority to ${bulkPriority.toUpperCase()}` : action === "cancel" ? "cancel" : "complete";
    if (!confirm(`Are you sure you want to ${actionLabel} ${selectedJobIds.length} selected messages?`)) return;
    setBusyAction(`bulk:${action}`);
    setActionError("");
    setActionMessage("");
    try {
      const result = await api<{
        ok: boolean;
        processed: number;
        skipped: number;
        results: Array<{ id: string; changed: boolean; reason?: string | null }>;
      }>("/admin/queue/jobs/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { ids: selectedJobIds, action, ...(action === "priority" ? { priority: bulkPriority } : {}) }
      });
      const skippedIds = result.results.filter((item) => !item.changed).map((item) => String(item.id));
      setSelectedJobIds(skippedIds);
      if (result.skipped > 0) {
        setActionError(`${result.processed} changed · ${result.skipped} skipped (active, missing, terminal, or announcement capacity full).`);
      } else {
        setActionMessage(`${result.processed} selected message${result.processed === 1 ? "" : "s"} updated.`);
      }
      await load();
    } catch (err) {
      setActionError(`Bulk ${actionLabel} failed: ${messageFor(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function promote(id: string) {
    if (busyAction) return;
    setBusyAction(`promote:${id}`);
    setActionError("");
    setActionMessage("");
    try {
      await api(`/admin/queue/jobs/${id}/promote`, { method: "POST" });
      await load();
    } catch (err) {
      setActionError(`Couldn't send first: ${messageFor(err)}`);
    } finally {
      setBusyAction(null);
    }
  }
  async function cancel(id: string) {
    if (busyAction) return;
    if (!confirm("Cancel this queued message?")) return;
    setBusyAction(`cancel:${id}`);
    setActionError("");
    setActionMessage("");
    try {
      await api(`/admin/queue/jobs/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setActionError(`Couldn't cancel: ${messageFor(err)}`);
    } finally {
      setBusyAction(null);
    }
  }
  async function togglePaused() {
    if (busyAction) return;
    // Capture intent before the state can change under us — the alternative
    // (reading `paused` again after the request) is what let a stuck/slow
    // request cause a second click to resend the same action instead of the
    // opposite one.
    const target = paused ? "resume" : "pause";
    setBusyAction("toggle");
    setActionError("");
    setActionMessage("");
    try {
      await api(`/admin/queue/${target}`, { method: "POST" });
      await load();
    } catch (err) {
      setActionError(`Couldn't ${target}: ${messageFor(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function releaseDelayedHigh() {
    if (busyAction) return;
    setBusyAction("release-high");
    setActionError("");
    setActionMessage("");
    try {
      const result = await api<{ released: number }>("/admin/queue/release-delayed-high", { method: "POST" });
      if (result.released === 0) setActionError("No delayed CRITICAL messages were found.");
      await load();
    } catch (err) {
      setActionError(`Couldn't release delayed CRITICAL messages: ${messageFor(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send queue</CardTitle>
        <div className="flex items-center gap-2">
          {counts && (
            <span className="text-xs text-muted-foreground">
              {counts.waiting} waiting · {counts.active} active · {counts.failed} failed
            </span>
          )}
          <Badge variant={paused ? "warning" : "secondary"}>{paused ? "PAUSED" : "RUNNING"}</Badge>
          <Button
            size="sm"
            onClick={releaseDelayedHigh}
            disabled={delayedHighCount === 0 || busyAction !== null}
            title="Move all delayed CRITICAL messages to the front and send them now"
          >
            <Rocket className="size-4" />
            {busyAction === "release-high" ? "Releasing…" : `Send delayed CRITICAL now (${delayedHighCount})`}
          </Button>
          <Button variant="secondary" size="sm" onClick={togglePaused} disabled={busyAction !== null}>
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {busyAction === "toggle" ? "Working…" : paused ? "Resume paced" : "Pause"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => load().catch(() => {})} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
        {actionError && <div className="text-xs text-destructive">{actionError}</div>}
        {actionMessage && <div className="text-xs text-emerald-400">{actionMessage}</div>}
        {!actionError && staleSince && (
          <div className="text-xs text-destructive">
            Not updating since {new Date(staleSince).toLocaleTimeString()} — session may have expired, try reloading the page.
          </div>
        )}
        {quietHours?.active && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-amber-100">
            <Moon className="mt-0.5 size-4 shrink-0 text-amber-300" />
            <div>
              <div className="text-sm font-medium">Quiet hours are active</div>
              <div className="text-xs text-amber-100/75">
                Non-critical SMS and every delayed retry—including CRITICAL—are held until {quietHours.releaseAt ? new Date(quietHours.releaseAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "08:00"} {quietHours.timeZone}. Only fresh CRITICAL messages send immediately.
              </div>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {jobs.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Queue is empty.</div>
        ) : (
          <div className="max-h-[60vh] divide-y divide-border overflow-y-auto">
            {/* Bulk actions bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2 text-xs">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={isAllSelected}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate = isSomeSelected;
                    }
                  }}
                  onChange={toggleSelectAll}
                  className="size-4 cursor-pointer rounded border-zinc-700 bg-background/50 accent-primary text-primary focus:ring-primary"
                />
                <span className="font-medium text-muted-foreground">
                  {visibleSelectedCount} of {jobs.length} selected
                </span>
              </div>
              {selectedJobIds.length > 0 && (
                <div className="flex items-center gap-2">
                  <select
                    value={bulkPriority}
                    onChange={(event) => setBulkPriority(event.target.value as QueueJob["priority"])}
                    disabled={busyAction !== null}
                    aria-label="Priority for selected messages"
                    className="h-7 rounded-md border border-border bg-background px-2 text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="critical">CRITICAL · P1</option>
                    <option value="expired">EXPIRED · P3</option>
                    <option value="expiring">EXPIRING · P6</option>
                    <option value="announcement">ANNOUNCEMENT · P10</option>
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px] font-medium"
                    disabled={busyAction !== null}
                    onClick={() => performBulkAction("priority")}
                  >
                    {busyAction === "bulk:priority" ? "Applying…" : "Apply priority"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px] font-medium text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/10 hover:text-emerald-300"
                    disabled={busyAction !== null}
                    onClick={() => performBulkAction("complete")}
                  >
                    Set Completed
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px] font-medium text-red-400 border-red-500/20 hover:bg-red-500/10 hover:text-red-300"
                    disabled={busyAction !== null}
                    onClick={() => performBulkAction("cancel")}
                  >
                    Cancel Selected
                  </Button>
                </div>
              )}
            </div>

            {jobs.map((job) => (
              <div key={job.id} className="flex items-start gap-3 px-4 py-3">
                {/* Individual checkbox */}
                <div className="flex items-start pt-1">
                  <input
                    type="checkbox"
                    checked={selectedJobIds.includes(job.id)}
                    onChange={() => toggleSelectJob(job.id)}
                    className="size-4 cursor-pointer rounded border-zinc-700 bg-background/50 accent-primary text-primary focus:ring-primary"
                  />
                </div>
                <div className="flex w-20 shrink-0 flex-col items-start gap-1">
                  <Badge variant={job.state === "active" ? "default" : job.state === "delayed" ? "warning" : "secondary"}>
                    {job.state}
                  </Badge>
                  <Badge variant={job.priority === "critical" ? "warning" : "secondary"}>
                    {job.priority.toUpperCase()} · P{job.priorityLevel}
                  </Badge>
                  {job.quietHoursHeld && <Badge variant="warning">QUIET</Badge>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{job.to ?? "—"}</div>
                  <div className="truncate text-xs text-muted-foreground" dir="auto">
                    {job.textPreview}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {job.keyName ?? "—"}
                    {` · attempt ${job.attemptsMade + (job.state === "active" ? 1 : 0)}/${job.maxAttempts}`}
                    {job.createdAt ? ` · queued ${new Date(job.createdAt).toLocaleTimeString()}` : ""}
                    {job.processedAt ? ` · started ${new Date(job.processedAt).toLocaleTimeString()}` : ""}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    <span>in queue: {elapsed(job.waitingForMs)}</span>
                    {job.state === "active" && <span>active: {elapsed(job.activeForMs)}</span>}
                    {job.stageLabel && <span>stage: {job.stageLabel} ({elapsed(job.stageForMs)})</span>}
                    {job.quietHoursHeld && quietHours?.releaseAt ? (
                      <span>scheduled: {new Date(quietHours.releaseAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    ) : job.state === "delayed" && job.delayUntil && (
                      <span>{job.deferReason === "quiet_hours" ? "scheduled" : "retry"}: {new Date(job.delayUntil).toLocaleTimeString()}</span>
                    )}
                  </div>
                  <div
                    className={cn(
                      "mt-1 text-xs",
                      job.diagnosis.severity === "error" && "text-destructive",
                      job.diagnosis.severity === "warning" && "text-amber-400",
                      job.diagnosis.severity === "info" && "text-muted-foreground",
                    )}
                  >
                    {job.diagnosis.message}
                    {job.tracking === "redis_only" && " · legacy job (no SQLite timeline)"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => promote(job.id)}
                    disabled={job.state === "active" || busyAction !== null}
                    title="Clear any delay and send this message first"
                  >
                    <ArrowUp className="size-4" />
                    {busyAction === `promote:${job.id}` ? "Moving…" : "Send first"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => cancel(job.id)}
                    disabled={job.state === "active" || busyAction !== null}
                    title="Cancel"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
