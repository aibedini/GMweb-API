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
  keyState: "IDLE" | "REFRESHING" | "UP_TO_DATE" | "FAILED";
  keyError: string | null;
  lastKeySyncAt: number | null;
  keyPhase: string;
  keyGrantsProcessed: number;
  keyConversationsReprojected: number;
  keyContactsRepaired: number;
  keyDurationMs: number | null;
}

let syncStatus: BrowserSyncStatus = {
  state: "INITIALIZING",
  lastSuccessfulSyncAt: null,
  lastPageCount: 0,
  appliedThisRun: 0,
  lastErrorPhase: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  keyState: "IDLE",
  keyError: null,
  lastKeySyncAt: null,
  keyPhase: "idle",
  keyGrantsProcessed: 0,
  keyConversationsReprojected: 0,
  keyContactsRepaired: 0,
  keyDurationMs: null,
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
