import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  Chip,
  ScrollShadow,
  Separator,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "@heroui/react";
import { syncNow, listRecentEvents, getCursor, resetLocal, subscribeSyncAvailable, type StoredEvent } from "../lib/sync";
import { buildConversations, eventsForAggregate, renderMessage } from "../lib/inbox";
import { fetchTrustSnapshot, health, type TrustSnapshot } from "../lib/api";
import {
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  removeSubscriptionFromServer,
} from "../lib/push";
import { fetchAuthStatus, passkeyLogin, type AuthStatus } from "../lib/auth";

type TabKey = "inbox" | "sync" | "trust" | "debug";

const TYPE_COLOR: Record<string, "default" | "success" | "warning" | "danger" | "accent"> = {
  MESSAGE_CREATED: "accent",
  MESSAGE_STATUS_CHANGED: "warning",
  MESSAGE_DELETED: "danger",
  THREAD_READ: "success",
};

export default function App() {
  const [tab, setTab] = useState<TabKey>("inbox");
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<TrustSnapshot | null>(null);
  const [version, setVersion] = useState<string>("");
  const [pushState, setPushState] = useState<string>("");
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = async () => {
    setCursor(await getCursor());
    setEvents(await listRecentEvents(300));
    setTrust(await fetchTrustSnapshot());
  };

  useEffect(() => {
    void (async () => {
      try {
        setVersion((await health()).version);
      } catch {
        setVersion("unreachable");
      }
      try {
        const s = await fetchAuthStatus();
        setAuthStatus(s);
        // A passkey session cookie from a previous ceremony still counts:
        // the guarded /api/v1/trust/snapshot 404-vs-200 doubles as our probe.
        setAuthed(s.next === "authentication" ? null : false);
      } catch {
        setAuthed(false);
      }
      await refresh();
    })();
    // §44 realtime invalidation — narrow signal; cursor sync catches up.
    const dispose = subscribeSyncAvailable((applied) => {
      setApplied(applied);
      void refresh();
    });
    return dispose;
  }, []);

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await syncNow();
      setApplied(n);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await passkeyLogin();
      setAuthed(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const conversations = useMemo(() => buildConversations(events), [events]);
  const selectedEvents = useMemo(
    () => (selected ? eventsForAggregate(events, selected) : []),
    [events, selected],
  );

  // Passkey gate — §21 passkey-first. Bootstrap shown with its own copy via
  // the same Login pane (server declares next step).
  if (authed === false) {
    return (
      <div className="flex h-full items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col gap-4 p-6">
            <h1 className="text-2xl font-semibold">Messages</h1>
            <p className="text-sm" style={{ color: "var(--muted-fg)" }}>
              {authStatus?.next === "registration"
                ? "First run: create a passkey on this device to secure the account (§21)."
                : "Sign in with your passkey — no password, ever."}
            </p>
            <Button
              size="lg"
              variant="primary"
              isDisabled={busy}
              onPress={() => void login()}
            >
              {busy
                ? "Waiting for authenticator…"
                : authStatus?.next === "registration"
                  ? "Set up this device (passkey)"
                  : "Continue with Passkey"}
            </Button>
            {error && (
              <p className="text-xs" style={{ color: "var(--danger)" }}>
                {error}
              </p>
            )}
            <p className="text-xs" style={{ color: "var(--muted-fg)" }}>
              TOTP / recovery fallback lands with the Security Center screens.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <h1 className="text-lg font-semibold">Messages</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: "var(--muted-fg)" }}>v{version}</span>
          <Chip size="sm" variant="soft" color={cursor > 0 ? "success" : "default"}>
            cursor {cursor}
          </Chip>
          <Button size="sm" variant="tertiary" onPress={() => void pull()} isDisabled={busy}>
            {busy ? <Spinner size="sm" /> : "Sync"}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setAuthed(false)}>
            Lock
          </Button>
        </div>
      </header>

      <Tabs
        selectedKey={tab}
        onSelectionChange={(k) => setTab(k as TabKey)}
        className="px-4 pt-2"
      >
        <TabList>
          <Tab id="inbox">Inbox</Tab>
          <Tab id="sync">Sync</Tab>
          <Tab id="trust">Trust</Tab>
          <Tab id="debug">Debug</Tab>
        </TabList>

        {/* ── Inbox (§48/§49) ──────────────────────────────────────────── */}
        <TabPanel id="inbox">
          <div className="flex min-h-0 gap-3 py-3" style={{ height: "calc(100vh - 170px)" }}>
            {/* Conversation list */}
            <ScrollShadow className="w-72 shrink-0 rounded-xl border" style={{ borderColor: "var(--border)" }}>
              {conversations.length === 0 && (
                <p className="p-4 text-xs" style={{ color: "var(--muted-fg)" }}>
                  No conversations yet — events arrive from the Android agent.
                </p>
              )}
              {conversations.map((c) => (
                <button
                  key={c.aggregateId}
                  onClick={() => setSelected(c.aggregateId)}
                  className="w-full border-b px-3 py-2 text-left hover:opacity-80"
                  style={{
                    borderColor: "var(--border)",
                    background: selected === c.aggregateId ? "var(--card)" : "transparent",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium" title={c.aggregateId}>
                      {c.aggregateId}
                    </span>
                    <Chip size="sm" variant="soft" color={TYPE_COLOR[c.lastType] || "default"}>
                      {c.eventCount}
                    </Chip>
                  </div>
                  <div className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                    #{c.lastSequence} · {c.lastType}
                  </div>
                </button>
              ))}
            </ScrollShadow>

            {/* Conversation timeline (§49) */}
            <Card className="min-w-0 flex-1">
              <CardContent className="flex h-full flex-col">
                {!selected && (
                  <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--muted-fg)" }}>
                    Select a conversation to view its event timeline.
                  </div>
                )}
                {selected && (
                  <>
                    <div className="flex items-center justify-between border-b pb-2" style={{ borderColor: "var(--border)" }}>
                      <span className="truncate text-sm font-semibold" title={selected}>
                        {selected}
                      </span>
                      <Chip size="sm" variant="soft" color="accent">
                        {selectedEvents.length} events
                      </Chip>
                    </div>
                    <ScrollShadow className="min-h-0 flex-1 py-2">
                      {selectedEvents.map((ev) => (
                        <div key={ev.sequence} className="mb-2 flex justify-end">
                          <div
                            className="max-w-[80%] rounded-2xl px-3 py-2 text-xs"
                            style={{ background: "var(--accent)", color: "white" }}
                          >
                            <div className="mb-1 font-mono opacity-80">#{ev.sequence} · {ev.type}</div>
                            {renderMessage(ev)}
                          </div>
                        </div>
                      ))}
                    </ScrollShadow>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabPanel>

        {/* ── Sync ─────────────────────────────────────────────────────── */}
        <TabPanel id="sync">
          <div className="space-y-3 py-3">
            <Card>
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium">Cursor sync (§54)</p>
                  <p className="text-xs" style={{ color: "var(--muted-fg)" }}>
                    local cursor: <code>{cursor}</code> — opaque ciphertext events
                  </p>
                </div>
                <Button variant="primary" onPress={() => void pull()} isDisabled={busy}>
                  {busy ? "Syncing…" : "Sync now"}
                </Button>
              </CardContent>
            </Card>
            {applied !== null && (
              <p className="text-xs" style={{ color: "var(--ok)" }}>applied {applied} event(s) transactionally</p>
            )}
            {error && (
              <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>
            )}
            <Separator />
            <ScrollShadow className="max-h-96 rounded-xl border" style={{ borderColor: "var(--border)" }}>
              {events.slice(0, 30).map((ev) => (
                <div key={ev.sequence} className="border-b px-3 py-2 text-xs last:border-b-0" style={{ borderColor: "var(--border)" }}>
                  <div className="flex justify-between">
                    <span className="font-mono font-semibold">#{ev.sequence}</span>
                    <Chip size="sm" variant="soft" color={TYPE_COLOR[ev.type] || "default"}>{ev.type}</Chip>
                  </div>
                  <div className="truncate font-mono" style={{ color: "var(--muted-fg)" }}>
                    {ev.ciphertext.slice(0, 44)}…
                  </div>
                </div>
              ))}
            </ScrollShadow>
          </div>
        </TabPanel>

        {/* ── Trust ───────────────────────────────────────────────────── */}
        <TabPanel id="trust">
          <Card className="my-3">
            <CardContent className="p-4">
              <p className="text-sm font-medium">Signed Trust Registry (ADR-001)</p>
              {!trust && (
                <p className="mt-2 text-xs" style={{ color: "var(--muted-fg)" }}>
                  No snapshot yet — the Android trust root has not published one.
                </p>
              )}
              {trust && (
                <dl className="mt-3 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <dt style={{ color: "var(--muted-fg)" }}>trustSequence</dt>
                    <dd className="font-mono">{trust.trustSequence}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt style={{ color: "var(--muted-fg)" }}>rootPublicKey</dt>
                    <dd className="truncate font-mono" title={trust.rootPublicKey}>
                      {trust.rootPublicKey.slice(0, 24)}…
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt style={{ color: "var(--muted-fg)" }}>updatedAt</dt>
                    <dd className="font-mono">{new Date(trust.updatedAt).toLocaleString()}</dd>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>
        </TabPanel>

        {/* ── Debug ───────────────────────────────────────────────────── */}
        <TabPanel id="debug">
          <div className="space-y-3 py-3">
            <Card>
              <CardContent className="p-4 text-sm">
                <p className="font-medium">Web Push (§45)</p>
                <p className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                  Content-less wake-ups only (§30 default). Permission is requested
                  only by this explicit click.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onPress={() =>
                      void (async () => {
                        setPushState("…");
                        try {
                          if (!pushSupported()) { setPushState("unsupported browser"); return; }
                          const res = await fetch("/api/v1/push/public-key");
                          const { publicKey } = (await res.json()) as { publicKey: string };
                          const sub = await subscribeToPush(publicKey);
                          if (!sub) { setPushState("permission denied / unsupported"); return; }
                          const ok = await fetch("/api/v1/push/subscribe", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(sub.toJSON()),
                          }).then((r) => r.ok);
                          setPushState(ok ? "subscribed ✓" : "subscribe upload failed");
                        } catch (e) {
                          setPushState(e instanceof Error ? e.message : "error");
                        }
                      })()
                    }
                  >
                    Enable push
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onPress={() =>
                      void (async () => {
                        const reg = await navigator.serviceWorker?.getRegistration("/web/");
                        const sub = await reg?.pushManager.getSubscription();
                        if (sub) {
                          await removeSubscriptionFromServer(sub.endpoint);
                          await unsubscribeFromPush();
                        }
                        setPushState("unsubscribed");
                      })()
                    }
                  >
                    Disable
                  </Button>
                </div>
                {pushState && <p className="mt-2 text-xs" style={{ color: "var(--ok)" }}>{pushState}</p>}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 text-sm">
                <p className="font-medium">Local store</p>
                <p className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                  IndexedDB «gmweb-messages» — events + cursor. Server sequences are
                  the truth; reset never loses data.
                </p>
                <Button
                  size="sm"
                  variant="danger"
                  className="mt-3"
                  onPress={() => void (async () => { await resetLocal(); await refresh(); setApplied(null); })()}
                >
                  Reset local cache
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabPanel>
      </Tabs>
    </div>
  );
}
