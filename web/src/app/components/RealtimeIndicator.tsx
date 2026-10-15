import { useEffect, useState } from "react";
import { Chip, Tooltip } from "@heroui/react";
import {
  getLiveSyncMetrics,
  isRealtimeHealthy,
  SSE_HEARTBEAT_MS,
  type LiveSyncMetrics,
} from "../../lib/sync/live-invalidation";
import { IconStatusDot } from "./icons";

/**
 * The live metrics live in a plain module (the sync engine owns them, not
 * React). This hook only mirrors them for display — it never drives
 * correctness, and it performs no network work.
 */
export function useLiveSyncMetrics(intervalMs = 2_000): LiveSyncMetrics {
  const [metrics, setMetrics] = useState<LiveSyncMetrics>(() => getLiveSyncMetrics());
  useEffect(() => {
    const timer = window.setInterval(() => setMetrics(getLiveSyncMetrics()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return metrics;
}

type Tone = "success" | "warning" | "danger" | "default";

const PRESENTATION: Record<LiveSyncMetrics["connection"], { label: string; color: Tone; detail: string }> = {
  CONNECTING: { label: "Connecting", color: "default", detail: "Opening the realtime channel…" },
  CONNECTED: { label: "Live", color: "success", detail: "Realtime invalidations are arriving." },
  RECONNECTING: { label: "Reconnecting", color: "warning", detail: "Realtime dropped; retrying with backoff. Catch-up runs on reconnect." },
  // A stream whose frames stopped arriving is NOT live, even though the socket
  // looks open — this is the state that used to masquerade as "Connected".
  STALE: { label: "Stale", color: "warning", detail: "No realtime frames recently. Updates are falling back to catch-up." },
  AUTH_FAILED: { label: "Not authorised", color: "danger", detail: "This browser's linked session was rejected." },
  OFFLINE: { label: "Offline", color: "danger", detail: "The realtime channel is closed." },
};

/**
 * §7: the realtime channel is its own status axis, separate from the API and
 * from the phone. It never reports "Live" without a recent server frame.
 */
export function RealtimeIndicator() {
  const metrics = useLiveSyncMetrics();
  const presentation = PRESENTATION[metrics.connection];
  const healthy = isRealtimeHealthy();

  return (
    <Tooltip delay={300} closeDelay={80}>
      <Tooltip.Trigger>
        <Chip
          size="sm"
          variant="soft"
          color={healthy ? presentation.color : presentation.color}
          role="status"
          aria-label={`Realtime: ${presentation.label}`}
        >
          <IconStatusDot width={7} height={7} aria-hidden />
          <Chip.Label>{presentation.label}</Chip.Label>
        </Chip>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {presentation.detail}
        {metrics.reconnectCount > 0 ? ` · ${metrics.reconnectCount} reconnect(s)` : ""}
        {` · heartbeat every ${SSE_HEARTBEAT_MS / 1000}s`}
      </Tooltip.Content>
    </Tooltip>
  );
}
