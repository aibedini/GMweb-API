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

export interface Overview {
  ok: boolean;
  version: string;
  readiness?: { ready: boolean; status?: Record<string, unknown> };
  transport?: { name?: string; mode?: string | null; transport?: string; paired?: boolean; reason?: string | null; androidReady?: boolean; lastPullAt?: string | null };
  browserAutomation?: { ok: boolean | null; code: string; latencyMs?: number; error?: string };
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
  sendRateMinute: number;
  sendRateHour: number;
  createdAt: string;
  lastUsedAt: string | null;
  requestCount: number;
  enabled: boolean;
  tokenPreview: string;
}
