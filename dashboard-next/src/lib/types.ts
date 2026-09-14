export interface SessionInfo {
  passwordRequired: boolean;
  passwordAuthenticated: boolean;
  authenticated: boolean;
  csrfToken: string | null;
  expiresAt: string | null;
}

export interface ReadyStatus {
  ready?: boolean;
  status?: {
    paired?: boolean;
    running?: boolean;
    url?: string;
    title?: string;
    hint?: string;
    qrVisible?: boolean;
    signInVisible?: boolean;
  };
}

/**
 * Deterministic transport vocabulary from the server. Business logic keys off
 * THESE values, never off transport display strings like "android-pull".
 */
export type TransportState =
  | "connected"
  | "stale"
  | "unconfigured"
  | "push_unreachable"
  | "not_paired"
  | "unknown";

export interface TransportPeer {
  configured?: boolean;
  ready?: boolean;
  state?: TransportState;
  reason?: string | null;
}

/** One authoritative snapshot, shared by /admin/overview and /admin/transport. */
export interface TransportHealth {
  activeTransport: "chrome" | "android";
  mode: "pull" | "push" | null;
  configured: boolean;
  ready: boolean;
  state: TransportState;
  reason: string | null;
  lastPullAt: string | null;
  lastPullAgeMs: number | null;
  livenessMs: number;
  waitingPhones: number;
  pending: number;
  inflight: number;
  revokedInflight: number;
  tombstones: number;
  alternatives?: Record<string, TransportPeer | null>;
  // legacy aliases (kept for older consumers)
  name?: string;
  paired?: boolean;
  transport?: string;
  androidReady?: boolean;
  androidReason?: string | null;
}

/** Live BullMQ state only — never a historical total. */
export interface QueueNow {
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  paused: number;
  completed: number;
  failed: number;
  manualPause?: boolean;
  powerOn?: boolean;
}

/** Durable delivery outcomes for a stated window. */
export interface LedgerOutcomes {
  sent: number;
  unverified: number;
  failed: number;
  suppressed: number;
  cancelled: number;
  superseded: number;
  total?: number;
  revokedInflight?: number;
}

export interface QueueStatus {
  paused: boolean;
  /** Backend SSOT: no outstanding live work (waiting+active+delayed+prioritized+paused === 0). */
  idle?: boolean;
  /** active > 0 */
  executing?: boolean;
  outstanding?: number;
  manualPause?: boolean;
  powerOn?: boolean;
  activeTransport?: "chrome" | "android";
  transport?: TransportHealth;
  queue: QueueNow;
  ledger: { allTime: LedgerOutcomes; last24h: LedgerOutcomes };
  /** @deprecated legacy merged shape; use `queue` + `ledger`. */
  counts: QueueCounts & Record<string, number>;
  quietHours?: QueueQuietHours;
}

export interface Overview {
  ok: boolean;
  version: string;
  readiness?: { ready: boolean; status?: Record<string, unknown> };
  transport?: TransportHealth;
  queue?: QueueNow;
  idle?: boolean;
  ledger?: { allTime: LedgerOutcomes; last24h: LedgerOutcomes };
  browserAutomation?: { ok: boolean | null; code: string; latencyMs?: number; error?: string };
  webApp?: {
    ok: boolean;
    state?: "current" | "version_mismatch" | "pwa_assets_missing" | "pwa_not_built" | "pwa_manifest_invalid";
    reason?: string | null;
    version: string | null;
    revision?: string | null;
    script: string | null;
    styles?: string[];
    missingAssets?: string[];
    matchesApi: boolean;
    builtAt: string | null;
    path: string;
  };
  system?: {
    cpu: { cores: number; usagePercent: number; load1: number; load5: number; load15: number; loadPercent: number };
    memory: { totalBytes: number; availableBytes: number; usedBytes: number; usagePercent: number };
    swap: { totalBytes: number; usedBytes: number; usagePercent: number };
    uptimeSeconds: number;
  };
  vnc?: { ready?: boolean };
  services?: Array<{ name: string; active: string; enabled: string }>;
}

export interface QueueCounts {
  waiting: number;
  paused: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  sent: number;
  suppressed: number;
}

export interface QueueQuietHours {
  active: boolean;
  timeZone: string;
  startHour: number;
  endHour: number;
  releaseAt: string | null;
}

export interface QueueJob {
  id: string;
  state: string;
  to: string | null;
  textPreview: string;
  keyName: string | null;
  priority: "critical" | "expired" | "expiring" | "announcement";
  priorityLevel: 1 | 3 | 6 | 10;
  attemptsMade: number;
  maxAttempts: number;
  failedReason: string | null;
  createdAt: string | null;
  processedAt: string | null;
  finishedAt: string | null;
  delayUntil: string | null;
  deferReason: string | null;
  deferCount: number;
  quietHoursHeld: boolean;
  stage: string | null;
  stageLabel: string | null;
  stageAt: string | null;
  ageMs: number;
  waitingForMs: number;
  activeForMs: number;
  stageForMs: number;
  tracking: "sqlite" | "redis_only";
  diagnosis: {
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
  };
}

export interface SendHistoryStats {
  queued?: number;
  active?: number;
  sent?: number;
  unverified?: number;
  failed?: number;
  suppressed?: number;
  cancelled?: number;
  [status: string]: number | undefined;
}

export interface SendHistoryItem {
  id: string | number;
  to: string | null;
  requestedTo?: string | null;
  sentTo?: string | null;
  recipientEvidence?: Record<string, unknown> | null;
  conversationUrl?: string | null;
  submittedOnce?: boolean;
  submittedAt?: string | null;
  verificationStatus?: string | null;
  verificationAttempts?: number;
  text: string;
  textPreview?: string;
  keyName: string | null;
  priority?: "critical" | "expired" | "expiring" | "announcement";
  priorityLevel?: 1 | 3 | 6 | 10;
  jobId: string | null;
  status: string;
  stage: string | null;
  attempts: number;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  sentAt: string | null;
}

export interface SendHistoryResponse {
  stats: SendHistoryStats;
  sends: SendHistoryItem[];
}

export interface Conversation {
  id: string;
  href: string;
  title: string;
  snippet: string;
  timestamp: string;
  unread?: boolean;
  unreadCount?: number;
}

export interface Message {
  index: number;
  type: "message" | "timestamp";
  direction?: "in" | "out";
  text: string;
}

export interface ApiKey {
  id: string;
  name: string;
  allowedIps: string[];
  scopes: string[];
  sendRateMinute: number;
  sendRateHour: number;
  createdAt: string;
  lastUsedAt: string | null;
  requestCount: number;
  enabled: boolean;
  tokenPreview: string;
}
