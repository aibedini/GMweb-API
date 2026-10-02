import { Alert, Button } from "@heroui/react";
import type { BrowserSyncStatus } from "../../lib/sync/sync-state";

/**
 * §24: sync state surfaces.
 *
 * `UP_TO_DATE` is the quiet normal state and renders NOTHING — there is no
 * permanent green "everything is fine" banner. Only genuinely actionable
 * states get an Alert:
 *
 *   DEGRADED  → warning + Retry
 *   FAILED    → danger  + Retry
 *   keyState FAILED → separate warning + Retry
 *   offline   → handled by the connection Chip in the top bar
 */
export function SyncAlerts({
  syncStatus,
  error,
  busy,
  onRetry,
}: {
  syncStatus: BrowserSyncStatus;
  error: string | null;
  busy: boolean;
  onRetry: () => void;
}) {
  const retry = (
    <Button size="sm" variant="ghost" onPress={onRetry} isDisabled={busy}>
      Retry
    </Button>
  );

  return (
    <>
      {syncStatus.state === "DEGRADED" ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Sync needs attention</Alert.Title>
            <Alert.Description>
              {syncStatus.lastErrorMessage || "Recent conversations could not be refreshed."}
            </Alert.Description>
          </Alert.Content>
          {retry}
        </Alert>
      ) : null}

      {syncStatus.state === "FAILED" ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Conversation refresh paused</Alert.Title>
            <Alert.Description>
              {syncStatus.lastErrorMessage || "The browser could not refresh recent conversations."}
            </Alert.Description>
          </Alert.Content>
          {retry}
        </Alert>
      ) : null}

      {syncStatus.keyState === "FAILED" ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Encryption keys need a retry</Alert.Title>
            <Alert.Description>
              {syncStatus.keyError || "Recent messages remain available; locked messages stay locked."}
            </Alert.Description>
          </Alert.Content>
          {retry}
        </Alert>
      ) : null}

      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Something went wrong</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </>
  );
}
