import { Button, Spinner, Tooltip } from "@heroui/react";
import type { BrowserSyncStatus } from "../../lib/sync/sync-state";
import { IconSync } from "./icons";

/** Human label for the durable browser sync state. */
export function syncLabel(state: BrowserSyncStatus["state"]): string {
  switch (state) {
    case "UP_TO_DATE":
      return "Up to date";
    case "DEGRADED":
      return "Sync degraded";
    case "FAILED":
      return "Sync failed";
    case "SYNCING_HISTORY":
      return "Syncing history";
    case "FIRST_PAINT_READY":
      return "Loading recent";
    default:
      return "Starting";
  }
}

/**
 * §24: `UP_TO_DATE` is the quiet normal state — no banner, just a sync action.
 * Refreshing shows a spinner. Degraded/failed states surface as Alerts in the
 * caller, not here.
 */
export function SyncIndicator({
  status,
  busy,
  onSync,
  compact = false,
}: {
  status: BrowserSyncStatus;
  busy: boolean;
  onSync: () => void;
  compact?: boolean;
}) {
  const refreshing = busy || status.state === "SYNCING_HISTORY" || status.keyState === "REFRESHING";
  const label = refreshing ? "Syncing" : syncLabel(status.state);
  const detail =
    status.lastSuccessfulSyncAt === null
      ? "No successful sync yet in this browser"
      : `Last successful sync ${new Date(status.lastSuccessfulSyncAt).toLocaleTimeString()}`;

  return (
    <Tooltip delay={300} closeDelay={100}>
      <Tooltip.Trigger>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly={compact}
          aria-label={refreshing ? "Syncing conversation history" : "Sync conversation history"}
          isDisabled={busy}
          onPress={onSync}
        >
          {refreshing ? <Spinner size="sm" /> : <IconSync width={16} height={16} aria-hidden />}
          {!compact && <span>{label}</span>}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>{refreshing ? "Syncing conversation history…" : `${label} · ${detail}`}</Tooltip.Content>
    </Tooltip>
  );
}
