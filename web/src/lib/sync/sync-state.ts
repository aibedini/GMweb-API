export type BrowserSyncState = "INITIALIZING" | "FIRST_PAINT_READY" | "SYNCING_HISTORY" |
  "UP_TO_DATE" | "DEGRADED" | "FAILED";

export interface BrowserSyncStatus {
  state: BrowserSyncState;
  lastSuccessfulSyncAt: number | null;
  lastPageCount: number;
  appliedThisRun: number;
  lastErrorPhase: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

let syncStatus: BrowserSyncStatus = {
  state: "INITIALIZING",
  lastSuccessfulSyncAt: null,
  lastPageCount: 0,
  appliedThisRun: 0,
  lastErrorPhase: null,
  lastErrorCode: null,
  lastErrorMessage: null,
};

export function getBrowserSyncStatus(): BrowserSyncStatus { return { ...syncStatus }; }

export function updateSyncStatus(change: Partial<BrowserSyncStatus>): void {
  syncStatus = { ...syncStatus, ...change };
}

export function syncFailure(phase: string, cause: unknown, fatal: boolean): void {
  updateSyncStatus({
    state: fatal ? "FAILED" : "DEGRADED",
    lastErrorPhase: phase,
    lastErrorCode: cause instanceof DOMException ? cause.name : "SYNC_ERROR",
    lastErrorMessage: cause instanceof Error ? cause.message : String(cause),
  });
}
