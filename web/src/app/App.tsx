import { useEffect, useMemo, useState } from "react";
import { Button, Card, CardContent, Chip, ScrollShadow, Spinner, Tab, TabList, TabPanel, Tabs } from "@heroui/react";
import { syncNow, listRecentEvents, getCursor, resetLocal, subscribeSyncAvailable, type StoredEvent } from "../lib/sync";
import { buildConversations, messagesForAggregate, eventDecodeState } from "../lib/inbox";
import { fetchTrustSnapshot, health, type TrustSnapshot } from "../lib/api";
import { listCredentials, removeCredential, listAgentIdentities, listPushSubscriptions, type CredentialRow, type IdentityRow } from "../lib/security";
import { completeLinkedSession } from "../lib/pairing";
import { PairingScreen } from "../screens/PairingScreen";
import { PWA_BUILD_VERSION, loadedScriptFile } from "../lib/buildInfo";
import { fetchPairingDiagnostics, type PairingDiagnostic } from "../lib/adminAccess";

type TabKey = "inbox" | "connection" | "security" | "debug";

function shortId(value: string | null | undefined) {
  return value ? `${value.slice(0, 8)}…` : "—";
}

function formatTime(value: number) {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function Avatar({ title }: { title: string }) {
  const initials = title.replace(/^Conversation\s+/, "").slice(0, 2).toUpperCase();
  return <div className="avatar" aria-hidden="true">{initials}</div>;
}

export default function App() {
  const [tab, setTab] = useState<TabKey>("inbox");
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<TrustSnapshot | null>(null);
  const [version, setVersion] = useState("");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [bootstrapState, setBootstrapState] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [credentials, setCredentials] = useState<CredentialRow[] | null>(null);
  const [identities, setIdentities] = useState<IdentityRow[] | null>(null);
  const [pushCount, setPushCount] = useState<number | null>(null);
  const [pairingDiagnostics, setPairingDiagnostics] = useState<PairingDiagnostic[] | null>(null);
  const scriptFile = useMemo(() => loadedScriptFile(), []);

  const refresh = async () => {
    const [nextCursor, nextEvents, nextTrust] = await Promise.all([getCursor(), listRecentEvents(500), fetchTrustSnapshot()]);
    setCursor(nextCursor);
    setEvents(nextEvents);
    setTrust(nextTrust);
  };

  const refreshSecurity = async () => {
    const [nextCredentials, nextIdentities, pushes] = await Promise.all([
      listCredentials().catch(() => null),
      listAgentIdentities().catch(() => null),
      listPushSubscriptions().catch(() => null),
    ]);
    setCredentials(nextCredentials);
    setIdentities(nextIdentities);
    setPushCount(pushes?.count ?? null);
  };

  useEffect(() => {
    void health().then((value) => setVersion(value.version)).catch(() => setVersion("unreachable"));
    void fetch("/api/v1/linked-session", { credentials: "include" })
      .then((response) => response.json())
      .then((session) => setAuthed(session.authenticated === true))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    setBootstrapState("BOOTSTRAPPING_SYNC");
    void syncNow().then(refresh).then(() => setBootstrapState("READY")).catch(() => setBootstrapState(null));
    void refreshSecurity();
    void fetchPairingDiagnostics().then(setPairingDiagnostics).catch(() => setPairingDiagnostics(null));
    return subscribeSyncAvailable((count) => {
      setApplied(count);
      void refresh();
    }, () => {
      setAuthed(false);
      setEvents([]);
      setSelected(null);
      void resetLocal();
    });
  }, [authed]);

  const conversations = useMemo(() => buildConversations(events), [events]);
  const filteredConversations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return conversations;
    return conversations.filter((item) => `${item.title}\n${item.preview}`.toLocaleLowerCase().includes(query));
  }, [conversations, search]);

  useEffect(() => {
    if (!selected && conversations[0]) setSelected(conversations[0].aggregateId);
  }, [conversations, selected]);

  const selectedConversation = conversations.find((item) => item.aggregateId === selected) || null;
  const messages = useMemo(() => selected ? messagesForAggregate(events, selected) : [], [events, selected]);

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      const count = await syncNow();
      setApplied(count);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (authed === false || authed === null) {
    return (
      <PairingScreen
        apiVersion={version || "checking"}
        pwaVersion={PWA_BUILD_VERSION}
        scriptFile={scriptFile}
        onLinked={async (link) => {
          if (!link) throw new Error("Pairing approval context is missing");
          setBootstrapState("CREATING_LINKED_SESSION");
          await completeLinkedSession(link.pairingSessionId, link.pollSecret, link.deviceId, link.certificate, link.origin);
          const probe = await fetch("/api/v1/linked-session", { credentials: "include" });
          const session = await probe.json().catch(() => ({}));
          if (!probe.ok || session.authenticated !== true) throw new Error("Linked session cookie was not established");
          setAuthed(true);
        }}
        onRecoveryLinked={async () => {
          const probe = await fetch("/api/v1/linked-session", { credentials: "include" });
          const session = await probe.json().catch(() => ({}));
          if (!probe.ok || session.authenticated !== true) throw new Error("Restricted PWA session cookie was not established");
          setAuthed(true);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">M</div>
        <div className="brand-copy"><strong>Messages</strong><span>GMweb companion</span></div>
        <div className="topbar-actions">
          <span className="version-pill" title={`${scriptFile} · cursor ${cursor}`}>v{version || "…"}</span>
          <span className={`connection-dot ${version === "unreachable" ? "offline" : ""}`} />
          <span className="connection-label">{version === "unreachable" ? "Offline" : "Connected"}</span>
          <Button className="topbar-button" size="sm" variant="ghost" onPress={() => void pull()} isDisabled={busy}>{busy ? <Spinner size="sm" /> : "Sync"}</Button>
          <Button className="topbar-button" size="sm" variant="ghost" onPress={() => setAuthed(false)}>Lock</Button>
        </div>
      </header>

      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(key as TabKey)} className="app-tabs">
        <TabList className="tab-list" aria-label="Messages navigation">
          <Tab id="inbox">Messages</Tab>
          <Tab id="connection">Connection</Tab>
          <Tab id="security">Security</Tab>
          <Tab id="debug">Debug</Tab>
        </TabList>

        <TabPanel id="inbox" className="inbox-panel">
          <div className="inbox-layout">
            <aside className="conversation-pane">
              <div className="pane-heading"><div><p className="eyebrow">Inbox</p><h1>Conversations</h1></div><Chip size="sm" variant="soft">{conversations.length}</Chip></div>
              <label className="search-box"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search messages" aria-label="Search messages" /></label>
              <ScrollShadow className="conversation-list">
                {filteredConversations.map((item) => (
                  <button key={item.aggregateId} className={`conversation-row ${selected === item.aggregateId ? "selected" : ""}`} onClick={() => setSelected(item.aggregateId)}>
                    <Avatar title={item.title} />
                    <span className="conversation-copy"><span className="conversation-title">{item.title}</span><span className="conversation-preview">{item.preview}</span></span>
                    <span className="conversation-meta"><time>{formatTime(item.lastAt)}</time></span>
                  </button>
                ))}
                {filteredConversations.length === 0 && <div className="empty-list"><span>✦</span><p>{conversations.length ? "No matching conversations" : "Waiting for messages from Android"}</p></div>}
              </ScrollShadow>
            </aside>

            <main className="message-pane">
              {selectedConversation ? (
                <>
                  <div className="message-header"><Avatar title={selectedConversation.title} /><div><h2>{selectedConversation.title}</h2><p>Synced from Android · {shortId(selectedConversation.aggregateId)}</p></div></div>
                  <ScrollShadow className="message-scroll">
                    <div className="message-day"><span>Message history</span></div>
                    {messages.map(({ event, payload }) => (
                      <div key={event.sequence} className={`message-line ${payload.direction}`}>
                        <div className="message-bubble"><p>{payload.body}</p><span>{formatTime(payload.dateMs)}{payload.direction === "out" ? " · Sent" : ""}</span></div>
                      </div>
                    ))}
                    {messages.length === 0 && (
                      <div className="empty-conversation"><div className="empty-icon">↻</div><h3>No readable message body yet</h3><p>This thread only contains older status events. New Android message events appear here as normal chat bubbles.</p></div>
                    )}
                  </ScrollShadow>
                  <div className="composer-disabled"><span>Messages are read-only in this release</span><Chip size="sm" variant="soft" color="success">Synced</Chip></div>
                </>
              ) : (
                <div className="empty-conversation"><div className="empty-icon">✦</div><h3>Your messages, without the debug noise</h3><p>Select a conversation when Android sync data arrives.</p></div>
              )}
            </main>
          </div>
        </TabPanel>

        <TabPanel id="connection" className="content-panel">
          <div className="page-title"><p className="eyebrow">System</p><h1>Connection</h1><p>Live state of the PWA, Android sync and trust registry.</p></div>
          <div className="status-grid">
            <Card><CardContent className="status-card"><span>API</span><strong>{version}</strong><Chip size="sm" color={version === "unreachable" ? "danger" : "success"} variant="soft">{version === "unreachable" ? "offline" : "healthy"}</Chip></CardContent></Card>
            <Card><CardContent className="status-card"><span>PWA build</span><strong>{PWA_BUILD_VERSION}</strong><small>{scriptFile}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Sync cursor</span><strong>{cursor}</strong><small>{applied === null ? "Ready" : `${applied} new event(s)`}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Trust sequence</span><strong>{trust?.trustSequence ?? "—"}</strong><small>{trust ? "Android trust root present" : "Not published"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Payload protection</span><strong>{events.some((event) => event.cryptoVersion === 0) ? "Legacy v0" : "Encrypted"}</strong><small>{events.some((event) => event.cryptoVersion === 0) ? "Readable envelope; browser E2EE is not active" : "Browser key required"}</small></CardContent></Card>
          </div>
          {bootstrapState && bootstrapState !== "READY" && <div className="notice">Finishing secure session setup: {bootstrapState}</div>}
          {error && <div className="notice danger">{error}</div>}
        </TabPanel>

        <TabPanel id="security" className="content-panel">
          <div className="page-title"><p className="eyebrow">Protection</p><h1>Security</h1><p>Credentials and identities visible to this linked browser.</p></div>
          <div className="security-list">
            <Card><CardContent className="security-row"><div><strong>Passkeys</strong><p>{credentials === null ? "Dashboard authentication required" : `${credentials.length} enrolled credential(s)`}</p></div>{credentials?.map((credential) => <Button key={credential.credentialId} size="sm" variant="ghost" onPress={() => void removeCredential(credential.credentialId).then(refreshSecurity)}>Remove {credential.label || shortId(credential.credentialId)}</Button>)}</CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Android identities</strong><p>{identities === null ? "Unavailable" : `${identities.length} registered device(s)`}</p></div><Chip size="sm" variant="soft">{identities?.length ?? 0}</Chip></CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Private push</strong><p>Notifications contain no sender or message text.</p></div><Chip size="sm" variant="soft">{pushCount ?? 0} subscription(s)</Chip></CardContent></Card>
          </div>
        </TabPanel>

        <TabPanel id="debug" className="content-panel">
          <div className="page-title"><p className="eyebrow">Diagnostics</p><h1>Debug</h1><p>Raw protocol details live here instead of inside the Inbox.</p></div>
          <div className="debug-actions"><Button variant="secondary" onPress={() => void pull()} isDisabled={busy}>Sync now</Button><Button variant="ghost" onPress={() => void resetLocal().then(refresh)}>Reset local ciphertext</Button></div>
          <Card><CardContent className="debug-list">{events.slice(0, 40).map((event) => <div key={event.sequence}><code>#{event.sequence}</code><span>{event.type}</span><Chip size="sm" variant="soft" color={eventDecodeState(event) === "readable" ? "success" : eventDecodeState(event) === "encrypted" ? "accent" : "danger"}>{eventDecodeState(event)}</Chip></div>)}</CardContent></Card>
          <Card><CardContent className="debug-list">{pairingDiagnostics?.slice(0, 20).map((entry) => <div key={entry.id}><code>{entry.statusCode}</code><span>{entry.details?.pairing?.stage || entry.title}</span><small>{entry.details?.pairing?.reason || entry.path}</small></div>)}{pairingDiagnostics?.length === 0 && <p>No pairing diagnostics.</p>}</CardContent></Card>
        </TabPanel>
      </Tabs>
    </div>
  );
}
