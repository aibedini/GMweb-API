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
  listCredentials,
  removeCredential,
  listAgentIdentities,
  listPushSubscriptions,
  type CredentialRow,
  type IdentityRow,
} from "../lib/security";
import {
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  removeSubscriptionFromServer,
} from "../lib/push";
import { completeLinkedSession } from "../lib/pairing";
import { PairingScreen } from "../screens/PairingScreen";

// ADR-007 §1: first-run is LINKED-DEVICE pairing, never passkey bootstrap.
// Until the user pairs (or holds a valid linked-device session), the app
// shows the QR pairing screen. Passkey stays available later behind
// Security Center (§7) — never as a first-run gate.

type TabKey = "inbox" | "sync" | "trust" | "security" | "debug";

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
  // POST-PAIR state machine (ticket): UNLINKED → PAIRING_APPROVED →
  // CERTIFICATE_VERIFIED → CREATING_LINKED_SESSION → BOOTSTRAPPING_SYNC →
  // READY. `authed` now MEANS "linked-device session cookie valid".
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [bootstrapState, setBootstrapState] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialRow[] | null>(null);
  const [identities, setIdentities] = useState<IdentityRow[] | null>(null);
  const [pushCount, setPushCount] = useState<number | null>(null);
  const [securityErr, setSecurityErr] = useState<string | null>(null);

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
      // POST-PAIR: linked state comes from the linked-device session cookie
      // (GET /api/v1/linked-session). A global passkey existing on the
      // account does NOT mean THIS browser is trusted.
      try {
        const res = await fetch("/api/v1/linked-session", { credentials: "include" });
        const st = await res.json();
        setAuthed(st.authenticated === true);
      } catch {
        setAuthed(false);
      }
    })();
  }, []);

  // SSE + sync bootstrap ONLY when linkedSessionReady — never before auth.
  useEffect(() => {
    if (!authed) return;
    void (async () => {
      try {
        setBootstrapState("BOOTSTRAPPING_SYNC");
        await syncNow();
        await refresh();
        setBootstrapState("READY");
      } catch {
        setBootstrapState(null);
      }
    })();
    // §44 realtime invalidation — narrow signal; cursor sync catches up.
    const dispose = subscribeSyncAvailable((applied) => {
      setApplied(applied);
      void refresh();
    });
    return dispose;
  }, [authed]);

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

  const conversations = useMemo(() => buildConversations(events), [events]);
  const selectedEvents = useMemo(
    () => (selected ? eventsForAggregate(events, selected) : []),
    [events, selected],
  );

  const refreshSecurity = async () => {
    setSecurityErr(null);
    try {
      setCredentials(await listCredentials());
    } catch { setCredentials(null); }
    try {
      setIdentities(await listAgentIdentities());
    } catch { setIdentities(null); }
    try {
      setPushCount((await listPushSubscriptions()).count);
    } catch { setPushCount(null); }
  };

  useEffect(() => {
    if (authed) void refreshSecurity();
  }, [authed]);

  // ADR-007 §1 state machine: UNLINKED → SHOW_QR → PAIRING_PENDING →
  // PAIRING_APPROVED → READY. The old passkey gate (authed === false →
  // "Create a passkey…") is REMOVED: passkey is optional post-pairing
  // hardening behind Security Center, never the bootstrap of trust.
  if (authed === false || authed === null) {
    return (
      <PairingScreen
        onLinked={async (link?: { pairingSessionId: string; pollSecret: string; deviceId: string; certificate: string; origin: string }) => {
          // CERTIFICATE_VERIFIED already happened in pairing.wait(). Now:
          // prove key possession → HttpOnly session → sync bootstrap.
          setBootstrapState("CREATING_LINKED_SESSION");
          try {
            if (link) {
              await completeLinkedSession(
                link.pairingSessionId, link.pollSecret, link.deviceId,
                link.certificate, link.origin,
              );
            }
            setBootstrapState("LINKED_SESSION_CREATED");
            setAuthed(true);
          } catch (e) {
            setBootstrapState(null);
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <h1 className="text-lg font-semibold">Messages</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: "var(--muted-fg)" }}>v{version}</span>
          {bootstrapState && bootstrapState !== "READY" && (
            <Chip size="sm" variant="soft">
              {bootstrapState === "CREATING_LINKED_SESSION" ? "Linking…" : "Syncing…"}
            </Chip>
          )}
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
          <Tab id="security">Security</Tab>
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

        {/* ── Security Center (§84) ───────────────────────────────────── */}
        <TabPanel id="security">
          <div className="space-y-3 py-3">
            {securityErr && (
              <p className="text-xs" style={{ color: "var(--danger)" }}>{securityErr}</p>
            )}

            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-medium">Passkeys (§21)</p>
                {!credentials && (
                  <p className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                    Sign in to view enrolled passkeys.
                  </p>
                )}
                {credentials && credentials.length === 0 && (
                  <p className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                    No passkeys enrolled yet.
                  </p>
                )}
                {credentials && credentials.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {credentials.map((c) => (
                      <li key={c.credentialId} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--border)" }}>
                        <div className="min-w-0">
                          <div className="font-mono">{c.label || c.credentialId.slice(0, 20) + "…"}</div>
                          <div style={{ color: "var(--muted-fg)" }}>
                            added {new Date(c.createdAt).toLocaleDateString()}
                            {c.lastUsedAt ? ` · last used ${new Date(c.lastUsedAt).toLocaleDateString()}` : " · never used"}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="danger"
                          onPress={() =>
                            void (async () => {
                              try {
                                await removeCredential(c.credentialId);
                                await refreshSecurity();
                              } catch (e) {
                                setSecurityErr(e instanceof Error ? e.message : "remove failed");
                              }
                            })()
                          }
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-medium">Android Agent Identities (ADR-001)</p>
                {!identities && (
                  <p className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                    Unavailable (auth required) or none enrolled.
                  </p>
                )}
                {identities && identities.length === 0 && (
                  <p className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                    No agent has enrolled per-device keys yet (agents auto-enroll on next registration).
                  </p>
                )}
                {identities && identities.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs">
                    {identities.map((i) => (
                      <li key={i.device_id} className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)" }}>
                        <span className="font-mono">{i.device_id}</span>
                        <span style={{ color: "var(--muted-fg)" }}>
                          v{i.protocol_version} · {new Date(i.registered_at).toLocaleDateString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-medium">Push Subscriptions (§89)</p>
                <p className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                  {pushCount === null
                    ? "Unavailable (auth required)."
                    : `${pushCount} device(s) registered for content-less wake-ups.`}
                </p>
              </CardContent>
            </Card>
          </div>
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
