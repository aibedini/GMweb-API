export type PhaseErrorClass = "HISTORY" | "KEY" | "EVENT" | "UNKNOWN" | null;

export function phaseErrorClass(phase: string | null): PhaseErrorClass {
  if (!phase) return null;
  if (phase === "INITIAL_SYNC") return "HISTORY";
  if (phase === "KEY_SYNC") return "KEY";
  if (phase === "SYNC" || phase === "SSE_SYNC") return "EVENT";
  return "UNKNOWN";
}

export function safeSyncError(value: string | null): string | null {
  if (!value) return null;
  if (/Invalid sync page/i.test(value)) return "Invalid sync page";
  const http = value.match(/HTTP\s+\d{3}/i)?.[0];
  return http || "Sync operation failed";
}
