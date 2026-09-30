import { syncFailure } from "./sync-state.ts";

export interface LiveSyncMetrics {
  connection: "CONNECTING" | "CONNECTED" | "RECONNECTING" | "OFFLINE";
  reconnectCount: number;
  lastReconnectAt: number | null;
  lastFrameAt: number | null;
  serverPublishedAt: number | null;
  browserSseReceivedAt: number | null;
  browserPullCompletedAt: number | null;
  browserProjectedAt: number | null;
  browserRenderedAt: number | null;
}
const metrics: LiveSyncMetrics = { connection: "OFFLINE", reconnectCount: 0,
  lastReconnectAt: null, lastFrameAt: null, serverPublishedAt: null,
  browserSseReceivedAt: null, browserPullCompletedAt: null,
  browserProjectedAt: null, browserRenderedAt: null };
export function getLiveSyncMetrics(): LiveSyncMetrics { return { ...metrics }; }
export function markBrowserProjected(): void { metrics.browserProjectedAt = Date.now(); }
export function markBrowserRendered(): void { metrics.browserRenderedAt = Date.now(); }

/** SSE only invalidates the durable replica cursor; frames never supply content. */
export function subscribeSyncAvailable(
  syncNow: (conversationIds?: string[]) => Promise<number>,
  onSynced: (applied: number, conversationIds?: string[]) => void,
  onRevoked: () => void,
  onSyncError?: (cause: unknown) => void,
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let connecting: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 250;
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

  const connect = () => {
    if (closed) return;
    metrics.connection = metrics.reconnectCount ? "RECONNECTING" : "CONNECTING";
    // EventSource sends cookies for same-origin automatically; withCredentials
    // additionally keeps the linked-session cookie on cross-origin/proxied setups.
    es = new EventSource("/api/v1/sse", { withCredentials: true });
    es.onopen = () => {
      metrics.connection = "CONNECTED";
      reconnectDelay = 250;
      requestSync(); // durable catch-up after any reconnect, including a missed frame
    };
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as { type?: string; newEvents?: number;
          conversationIds?: string[] | null };
        metrics.lastFrameAt = Date.now();
        if (evt.type === "device.revoked") {
          closed = true;
          es?.close();
          onRevoked();
          return;
        }
        if (evt.type === "sync.available") {
          metrics.browserSseReceivedAt = metrics.lastFrameAt;
          const published = Date.parse((evt as { at?: string }).at || "");
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
      metrics.connection = "RECONNECTING";
      metrics.reconnectCount += 1;
      metrics.lastReconnectAt = Date.now();
      void fetch("/api/v1/linked-session", { credentials: "include" })
        .then(r => r.json()).then(s => { if (s.authenticated === false) { closed = true; onRevoked(); } }).catch(() => {});
      es?.close();
      es = null;
      if (!closed && connecting === null) {
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 5_000);
        connecting = setTimeout(() => {
          connecting = null;
          connect();
        }, delay);
      }
    };
  };

  connect();
  return () => {
    closed = true;
    metrics.connection = "OFFLINE";
    if (connecting !== null) clearTimeout(connecting);
    es?.close();
  };
}
