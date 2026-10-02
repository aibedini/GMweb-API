import { syncFailure } from "./sync-state.ts";

/**
 * Realtime transport state.
 *
 * `CONNECTED` is only claimed while frames are actually arriving — see
 * `STALE`. `AUTH_FAILED` is terminal for this session (the linked cookie was
 * rejected); everything else retries.
 */
export type LiveConnectionState =
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "STALE"
  | "AUTH_FAILED"
  | "OFFLINE";

export interface LiveSyncMetrics {
  connection: LiveConnectionState;
  reconnectCount: number;
  lastReconnectAt: number | null;
  lastFrameAt: number | null;
  /** Last observable `data:` heartbeat from the server. */
  lastHeartbeatAt: number | null;
  connectedAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  serverPublishedAt: number | null;
  browserSseReceivedAt: number | null;
  browserPullCompletedAt: number | null;
  browserProjectedAt: number | null;
  browserRenderedAt: number | null;
}

/**
 * The server heartbeats every 20s. Two missed beats plus slack means the
 * channel is no longer trustworthy, so the UI must stop claiming "Live".
 */
export const SSE_HEARTBEAT_MS = 20_000;
export const SSE_STALE_AFTER_MS = 50_000;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 20_000;
const STALENESS_POLL_MS = 5_000;

const metrics: LiveSyncMetrics = {
  connection: "OFFLINE",
  reconnectCount: 0,
  lastReconnectAt: null,
  lastFrameAt: null,
  lastHeartbeatAt: null,
  connectedAt: null,
  lastErrorAt: null,
  lastError: null,
  serverPublishedAt: null,
  browserSseReceivedAt: null,
  browserPullCompletedAt: null,
  browserProjectedAt: null,
  browserRenderedAt: null,
};

export function getLiveSyncMetrics(): LiveSyncMetrics {
  return { ...metrics };
}

export function markBrowserProjected(): void {
  metrics.browserProjectedAt = Date.now();
}

export function markBrowserRendered(): void {
  metrics.browserRenderedAt = Date.now();
}

/** True when the realtime channel can be trusted to deliver invalidations. */
export function isRealtimeHealthy(now = Date.now()): boolean {
  if (metrics.connection !== "CONNECTED") return false;
  const last = metrics.lastHeartbeatAt ?? metrics.lastFrameAt ?? metrics.connectedAt;
  return last !== null && now - last <= SSE_STALE_AFTER_MS;
}

/**
 * Bounded exponential backoff with full jitter.
 *
 * Without jitter every tab that lost the stream at the same moment (a deploy,
 * a proxy restart) retries in lockstep and stampedes the API.
 */
export function reconnectDelayFor(attempt: number, random: () => number = Math.random): number {
  const capped = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
  return Math.round(capped / 2 + random() * (capped / 2));
}

/**
 * SSE only invalidates the durable replica cursor; frames never supply content.
 *
 * Contract preserved from the original implementation:
 *   - burst invalidations coalesce into one in-flight sync + at most one rerun
 *   - every (re)connect performs a durable catch-up, so a lost frame is always
 *     recovered from the cursor
 *
 * Added: observable heartbeats, staleness detection, jittered backoff and
 * catch-up on tab resume / reconnect-to-network / focus.
 */
export function subscribeSyncAvailable(
  syncNow: (conversationIds?: string[]) => Promise<number>,
  onSynced: (applied: number, conversationIds?: string[]) => void,
  onRevoked: () => void,
  onSyncError?: (cause: unknown) => void,
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let connecting: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let syncing = false;
  let dirty = false;
  let pendingIds: Set<string> | null = null;

  const requestSync = (conversationIds?: string[]) => {
    if (!dirty) pendingIds = conversationIds?.length ? new Set(conversationIds) : null;
    else if (!conversationIds?.length) pendingIds = null;
    else if (pendingIds) for (const id of conversationIds) pendingIds.add(id);
    if (pendingIds && pendingIds.size > 20) pendingIds = null;
    dirty = true;
    if (syncing || closed) return;
    syncing = true;
    void (async () => {
      try {
        while (dirty && !closed) {
          const ids = pendingIds ? [...pendingIds] : undefined;
          dirty = false;
          pendingIds = null;
          const applied = await syncNow(ids);
          metrics.browserPullCompletedAt = Date.now();
          if (applied > 0) onSynced(applied, ids);
        }
      } catch (cause) {
        syncFailure("SSE_SYNC", cause, false);
        onSyncError?.(cause);
      } finally {
        syncing = false;
        if (dirty && !closed) {
          const queued = pendingIds ? [...pendingIds] : undefined;
          dirty = false;
          requestSync(queued);
        }
      }
    })();
  };

  const scheduleReconnect = () => {
    if (closed || connecting !== null) return;
    const delay = reconnectDelayFor(attempts);
    connecting = setTimeout(() => {
      connecting = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed) return;
    metrics.connection = attempts ? "RECONNECTING" : "CONNECTING";
    // EventSource sends cookies for same-origin automatically; withCredentials
    // additionally keeps the linked-session cookie on cross-origin/proxied setups.
    es = new EventSource("/api/v1/sse", { withCredentials: true });
    es.onopen = () => {
      metrics.connection = "CONNECTED";
      metrics.connectedAt = Date.now();
      metrics.lastError = null;
      attempts = 0;
      requestSync(); // durable catch-up after any reconnect, including a missed frame
    };
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as {
          type?: string; newEvents?: number; conversationIds?: string[] | null; at?: string;
        };
        metrics.lastFrameAt = Date.now();
        if (evt.type === "heartbeat") {
          metrics.lastHeartbeatAt = metrics.lastFrameAt;
          // A heartbeat proves the channel recovered even if `onopen` never
          // fired again on this EventSource instance.
          if (metrics.connection === "STALE") metrics.connection = "CONNECTED";
          return;
        }
        if (evt.type === "device.revoked") {
          closed = true;
          es?.close();
          onRevoked();
          return;
        }
        if (evt.type === "sync.available") {
          metrics.browserSseReceivedAt = metrics.lastFrameAt;
          const published = Date.parse(evt.at || "");
          metrics.serverPublishedAt = Number.isFinite(published) ? published : null;
          requestSync(Array.isArray(evt.conversationIds) && evt.conversationIds.length &&
            evt.conversationIds.every(id => typeof id === "string" && id.length <= 128)
            ? evt.conversationIds : undefined);
        }
      } catch {
        /* ignore malformed frames — the cursor is the truth */
      }
    };
    // Bound retry delay; every successful connection performs durable catch-up.
    es.onerror = () => {
      metrics.lastErrorAt = Date.now();
      metrics.lastError = "SSE_ERROR";
      metrics.reconnectCount += 1;
      metrics.lastReconnectAt = Date.now();
      attempts += 1;
      es?.close();
      es = null;
      void fetch("/api/v1/linked-session", { credentials: "include" })
        .then(r => r.json())
        .then(s => {
          if (s.authenticated === false) {
            closed = true;
            metrics.connection = "AUTH_FAILED";
            onRevoked();
            return;
          }
          metrics.connection = "RECONNECTING";
          scheduleReconnect();
        })
        .catch(() => {
          metrics.connection = "RECONNECTING";
          scheduleReconnect();
        });
    };
  };

  // A suspended tab keeps a dead EventSource object: the browser froze the
  // connection but never reported an error. Any of these events means "we may
  // have missed invalidations", so run a durable catch-up immediately instead
  // of waiting for the next frame.
  const catchUpNow = () => {
    if (closed) return;
    if (es === null) {
      scheduleReconnect();
    } else if (metrics.connection === "STALE") {
      metrics.reconnectCount += 1;
      metrics.lastReconnectAt = Date.now();
      attempts += 1;
      es.close();
      es = null;
      scheduleReconnect();
    }
    requestSync();
  };

  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") catchUpNow();
  };
  const onOnline = () => catchUpNow();
  const onFocus = () => catchUpNow();
  const onPageShow = () => catchUpNow();

  const staleWatch = setInterval(() => {
    if (closed) return;
    if (metrics.connection === "CONNECTED") {
      const last = metrics.lastHeartbeatAt ?? metrics.lastFrameAt ?? metrics.connectedAt;
      if (last !== null && Date.now() - last > SSE_STALE_AFTER_MS) {
        metrics.connection = "STALE";
        metrics.lastError = "SSE_STALE";
        metrics.lastErrorAt = Date.now();
      }
    }
  }, STALENESS_POLL_MS);
  staleWatch.unref?.();

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
  }

  connect();

  return () => {
    closed = true;
    metrics.connection = "OFFLINE";
    clearInterval(staleWatch);
    if (connecting !== null) clearTimeout(connecting);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
    }
    es?.close();
  };
}
