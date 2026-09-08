import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CardContent, Chip, ScrollShadow, Spinner, Tab, TabList, TabPanel, Tabs } from "@heroui/react";
import { syncNow, listRecentEvents, listInboxEvents, listAggregateEvents, listContacts, listConversations, getCursor, resetLocal, subscribeSyncAvailable, syncStep, syncUntilCaughtUp, type StoredContact, type StoredEvent } from "../lib/sync";
import { messagesForAggregate, eventDecodeState, type ConversationProjection } from "../lib/inbox";
import { createCommand, fetchCommand, fetchPrimaryCommandKey, fetchPrimaryTelemetry, fetchTrustSnapshot, health, type DeviceTelemetry, type TrustSnapshot } from "../lib/api";
import { encryptCommand } from "../lib/commandCrypto";
import { listCredentials, removeCredential, listAgentIdentities, listPushSubscriptions, type CredentialRow, type IdentityRow } from "../lib/security";
import { completeLinkedSession } from "../lib/pairing";
import { PairingScreen } from "../screens/PairingScreen";
import { PWA_BUILD_VERSION, loadedScriptFile } from "../lib/buildInfo";
import { fetchPairingDiagnostics, type PairingDiagnostic } from "../lib/adminAccess";

type TabKey = "inbox" | "contacts" | "connection" | "security" | "debug";

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

function messageStatus(status: number): string {
  if (status === 64) return "failed";
  if (status === 32) return "queued";
  if (status === 0) return "delivered";
  return "sent";
}

function Avatar({ title }: { title: string }) {
  const initials = title.replace(/^Conversation\s+/, "").slice(0, 2).toUpperCase();
  return <div className="avatar" aria-hidden="true">{initials}</div>;
}

export default function App() {
  const [tab, setTab] = useState<TabKey>("inbox");
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [threadEvents, setThreadEvents] = useState<StoredEvent[]>([]);
  const [inboxEvents, setInboxEvents] = useState<StoredEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<TrustSnapshot | null>(null);
  const [version, setVersion] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [bootstrapState, setBootstrapState] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [credentials, setCredentials] = useState<CredentialRow[] | null>(null);
  const [identities, setIdentities] = useState<IdentityRow[] | null>(null);
  const [pushCount, setPushCount] = useState<number | null>(null);
  const [pairingDiagnostics, setPairingDiagnostics] = useState<PairingDiagnostic[] | null>(null);
  const [telemetry, setTelemetry] = useState<DeviceTelemetry | null>(null);
  const [contacts, setContacts] = useState<StoredContact[]>([]);
  const [contactSearch, setContactSearch] = useState("");
  // PWA projection: paginated conversation read-model (replaces the old
  // listInboxEvents(100) inbox scan).
  const [conversationPage, setConversationPage] = useState<ConversationProjection[]>([]);
  const [conversationNext, setConversationNext] = useState<{ lastAt: number; aggregateId: string } | undefined>();
  const [conversationHasMore, setConversationHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [composeRecipient, setComposeRecipient] = useState("");
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<{ body: string; at: number } | null>(null);
  const markReadSent = useRef(new Set<string>());
  const scriptFile = useMemo(() => loadedScriptFile(), []);

  const refresh = async () => {
    const [nextCursor, nextEvents, nextTrust, nextInbox, nextContacts] = await Promise.all([getCursor(), listRecentEvents(500), fetchTrustSnapshot(), listInboxEvents(), listContacts()]);
    setCursor(nextCursor);
    setEvents(nextEvents);
    setInboxEvents(nextInbox);
    setTrust(nextTrust);
    const page = await listConversations({ limit: 100 });
    setConversationPage(page.items);
    setConversationHasMore(page.hasMore);
    setConversationNext(page.next);
    setContacts(nextContacts);
  };

  const loadOlderConversations = async () => {
    if (!conversationNext || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await listConversations({ limit: 100, before: conversationNext });
      setConversationPage(prev => [...prev, ...page.items]);
      setConversationHasMore(page.hasMore);
      setConversationNext(page.next);
    } finally {
      setLoadingOlder(false);
    }
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
      .then((session) => { setAuthed(session.authenticated === true); setCapabilities(session.capabilities || []); })
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    setBootstrapState("BOOTSTRAPPING_SYNC");
    void syncStep(2)
      .then(refresh)
      .then(() => {
        setBootstrapState("READY");
        // First paint is up: pull the remaining history in the background.
        void syncUntilCaughtUp().then(() => refresh()).catch(() => {});
      })
      .catch(cause => {
        setBootstrapState("SYNC_FAILED");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    void refreshSecurity();
    const refreshTelemetry = () => void fetchPrimaryTelemetry().then(setTelemetry).catch(() => setTelemetry(null));
    refreshTelemetry();
    const telemetryTimer = window.setInterval(refreshTelemetry, 60_000);
    void fetchPairingDiagnostics().then(setPairingDiagnostics).catch(() => setPairingDiagnostics(null));
    const unsubscribe = subscribeSyncAvailable((count) => {
      setApplied(count);
      void refresh();
    }, () => {
      setAuthed(false);
      setEvents([]);
      setInboxEvents([]);
      setSelected(null);
      void resetLocal();
    });
    return () => { window.clearInterval(telemetryTimer); unsubscribe(); };
  }, [authed]);

  const contactNames = useMemo(() => new Map(contacts.map(contact => [contact.normalizedPhone, contact.displayName])), [contacts]);
  const conversations = conversationPage;
  const filteredContacts = useMemo(() => {
    const query = contactSearch.trim().toLocaleLowerCase();
    return query ? contacts.filter(contact => `${contact.displayName}\n${contact.normalizedPhone}`.toLocaleLowerCase().includes(query)) : contacts;
  }, [contacts, contactSearch]);
  const filteredConversations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return conversations;
    return conversations.filter((item) => `${item.title}\n${item.preview}`.toLocaleLowerCase().includes(query));
  }, [conversations, search]);

  useEffect(() => {
    if (!selected && conversations[0]) setSelected(conversations[0].aggregateId);
  }, [conversations, selected]);

  const selectedConversation = conversations.find((item) => item.aggregateId === selected) || null;
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setThreadEvents([]);
    if (selected && authed) void listAggregateEvents(selected).then(rows => {
      if (!cancelled) setThreadEvents(rows);
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [selected, events, authed]);
  const messages = useMemo(() => selected ? messagesForAggregate(threadEvents, selected) : [], [threadEvents, selected]);
  const selectedRecipient = messages.map(item => item.payload.address).find(Boolean) || composeRecipient;

  useEffect(() => {
    if (pendingMessage && messages.some(item => item.payload.direction === "out" &&
        item.payload.body === pendingMessage.body && item.payload.dateMs >= pendingMessage.at - 60_000)) {
      setPendingMessage(null);
    }
  }, [messages, pendingMessage]);

  const submitCommand = async (type: "SEND_SMS" | "MARK_THREAD_READ", payload: Record<string, unknown>) => {
    const idempotencyKey = crypto.randomUUID();
    const target = await fetchPrimaryCommandKey();
    const encrypted = await encryptCommand(target.encryptionPublicKey, type, idempotencyKey, { type, ...payload });
    return createCommand({ type, payload: encrypted, idempotencyKey });
  };

  useEffect(() => {
    if (!selectedConversation || selectedConversation.read || !capabilities.includes("MARK_READ") || markReadSent.current.has(selectedConversation.aggregateId)) return;
    markReadSent.current.add(selectedConversation.aggregateId);
    void submitCommand("MARK_THREAD_READ", { conversationId: selectedConversation.aggregateId })
      .catch(() => markReadSent.current.delete(selectedConversation.aggregateId));
  }, [selectedConversation, capabilities]);

  const send = async () => {
    const body = draft.trim();
    if (!body || !selectedRecipient || !capabilities.includes("SEND_MESSAGES")) return;
    setCommandStatus("queued");
    setPendingMessage({ body, at: Date.now() });
    try {
      const command = await submitCommand("SEND_SMS", { phone: selectedRecipient, body });
      setDraft("");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const state = await fetchCommand(command.commandId);
        setCommandStatus(state?.state || "queued");
        if (state && ["FAILED", "EXPIRED"].includes(state.state)) {
          setDraft(body);
          break;
        }
        if (state?.state === "COMPLETED") break;
      }
    } catch (cause) {
      setDraft(body);
      setCommandStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

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
          <span className={`connection-dot ${!online || version === "unreachable" ? "offline" : ""}`} />
          <span className="connection-label">{!online || version === "unreachable" ? "Offline" : version ? "Connected" : "Checking"}</span>
          <Button className="topbar-button" size="sm" variant="ghost" onPress={() => void pull()} isDisabled={busy}>{busy ? <Spinner size="sm" /> : "Sync"}</Button>
          <Button className="topbar-button" size="sm" variant="ghost" onPress={() => setAuthed(false)}>Lock</Button>
        </div>
      </header>

      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(key as TabKey)} className="app-tabs">
        <TabList className="tab-list" aria-label="Messages navigation">
          <Tab id="inbox">Messages{conversations.reduce((sum, item) => sum + item.unreadCount, 0) ? ` (${conversations.reduce((sum, item) => sum + item.unreadCount, 0)})` : ""}</Tab>
          <Tab id="contacts">Contacts</Tab>
          <Tab id="connection">Connection</Tab>
          <Tab id="security">Security</Tab>
          <Tab id="debug">Debug</Tab>
        </TabList>

        <TabPanel id="inbox" className="inbox-panel">
          {authed && bootstrapState === "READY" && trust === null && (
            <div className="notice" role="status">
              <span>
                <strong>No linked device approved yet.</strong>{" "}
                Encrypted history sync starts only after your Android phone approves this browser.
                Open <b>Messages → Settings → Linked devices</b>, tap <b>Link new device</b>, and scan
                the QR code shown there. Until then this page stays empty — this is not a sync error.
              </span>
              <Button size="sm" variant="ghost" onPress={() => setTab("connection")}>Connection status</Button>
            </div>
          )}
          <div className="inbox-layout">
            <aside className="conversation-pane">
              <div className="pane-heading"><div><p className="eyebrow">Inbox</p><h1>Conversations</h1></div><Chip size="sm" variant="soft">{conversations.length}</Chip></div>
              <label className="search-box"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search messages" aria-label="Search messages" /></label>
              <ScrollShadow className="conversation-list">
                {filteredConversations.map((item) => (
                  <button key={item.aggregateId} className={`conversation-row ${selected === item.aggregateId ? "selected" : ""}`} onClick={() => setSelected(item.aggregateId)}>
                    <Avatar title={item.title} />
                    <span className="conversation-copy"><span className="conversation-title">{item.title}{item.subtitle ? ` · ${item.subtitle}` : ""}</span><span className="conversation-preview">{item.preview}</span></span>
                    <span className="conversation-meta"><time>{formatTime(item.lastAt)}</time>{item.unreadCount > 0 && <Chip size="sm">{item.unreadCount}</Chip>}</span>
                  </button>
                ))}
                {filteredConversations.length === 0 && <div className="empty-list"><span>✦</span><p>{conversations.length ? "No matching conversations" : inboxEvents.some(event => event.decryption?.state === "locked") ? "Messages are locked. Check Security for key access." : "Waiting for messages from Android"}</p></div>}
              </ScrollShadow>
              {conversationHasMore && (
                <Button size="sm" variant="ghost" className="load-older" onPress={() => void loadOlderConversations()} isDisabled={loadingOlder}>
                  {loadingOlder ? "Loading…" : "Load older conversations"}
                </Button>
              )}
            </aside>

            <main className="message-pane">
              {selectedConversation ? (
                <>
                  <div className="message-header"><Avatar title={selectedConversation.title} /><div><h2>{selectedConversation.title}</h2><p>{selectedConversation.subtitle ? `${selectedConversation.subtitle} · ` : ""}Synced from Android · {shortId(selectedConversation.aggregateId)}</p></div></div>
                  <ScrollShadow className="message-scroll">
                    <div className="message-day"><span>Message history</span></div>
                    {messages.map(({ event, payload }) => (
                      <div key={event.sequence} className={`message-line ${payload.direction}`}>
                        <div className="message-bubble"><p>{payload.body}</p><span>{formatTime(payload.dateMs)}{payload.direction === "out" ? ` · ${messageStatus(payload.status)}` : ""}</span></div>
                      </div>
                    ))}
                    {pendingMessage && (
                      <div className="message-line out">
                        <div className="message-bubble"><p>{pendingMessage.body}</p><span>{formatTime(pendingMessage.at)} · {commandStatus || "queued"}</span></div>
                      </div>
                    )}
                    {messages.length === 0 && (
                      <div className="empty-conversation"><div className="empty-icon">↻</div><h3>No readable message body yet</h3><p>This thread only contains older status events. New Android message events appear here as normal chat bubbles.</p></div>
                    )}
                  </ScrollShadow>
                  <div className="composer-disabled">
                    <input value={draft} onChange={event => setDraft(event.target.value)} placeholder={selectedRecipient ? "Text message" : "Choose a contact"} disabled={!selectedRecipient || !capabilities.includes("SEND_MESSAGES")} />
                    <span>{draft.length} chars · {draft.length <= 160 ? "SMS" : draft.length <= 480 ? `${Math.ceil(draft.length / 153)} parts` : "MMS"}</span>
                    <Button size="sm" onPress={() => void send()} isDisabled={!draft.trim() || !selectedRecipient || !capabilities.includes("SEND_MESSAGES")}>Send</Button>
                    {commandStatus && <Chip size="sm" variant="soft">{commandStatus}</Chip>}
                  </div>
                </>
              ) : (
                <div className="empty-conversation"><div className="empty-icon">✦</div><h3>{composeRecipient ? contactNames.get(composeRecipient) || composeRecipient : "New message"}</h3><p>{composeRecipient || "Choose a conversation or contact."}</p>{composeRecipient && <div className="composer-disabled"><input value={draft} onChange={event => setDraft(event.target.value)} placeholder="Text message" /><span>{draft.length} chars · {draft.length <= 160 ? "SMS" : draft.length <= 480 ? `${Math.ceil(draft.length / 153)} parts` : "MMS"}</span><Button size="sm" onPress={() => void send()} isDisabled={!draft.trim() || !capabilities.includes("SEND_MESSAGES")}>Send</Button>{commandStatus && <Chip size="sm" variant="soft">{commandStatus}</Chip>}</div>}</div>
              )}
            </main>
          </div>
        </TabPanel>

        <TabPanel id="contacts" className="content-panel">
          <div className="page-title"><p className="eyebrow">Phone book</p><h1>Contacts</h1><p>End-to-end encrypted contacts synced from the Primary Android device.</p></div>
          <label className="search-box"><span aria-hidden="true">⌕</span><input value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="Search names or numbers" aria-label="Search contacts" /></label>
          <div className="security-list">
            {filteredContacts.map(contact => (
              <button key={contact.normalizedPhone} type="button" onClick={() => { setComposeRecipient(contact.normalizedPhone); setSelected(null); setTab("inbox"); }}><Card><CardContent className="security-row"><div><strong>{contact.displayName}</strong><p>{contact.normalizedPhone}</p></div>{contact.starred && <Chip size="sm" variant="soft">Starred</Chip>}</CardContent></Card></button>
            ))}
            {filteredContacts.length === 0 && <div className="empty-list"><span>✦</span><p>{contacts.length ? "No matching contacts" : "Waiting for encrypted contacts from Android"}</p></div>}
          </div>
        </TabPanel>

        <TabPanel id="connection" className="content-panel">
          <div className="page-title"><p className="eyebrow">System</p><h1>Connection</h1><p>Live state of the PWA, Android sync and trust registry.</p></div>
          <div className="status-grid">
            <Card><CardContent className="status-card"><span>API</span><strong>{version}</strong><Chip size="sm" color={version === "unreachable" ? "danger" : "success"} variant="soft">{version === "unreachable" ? "offline" : "healthy"}</Chip></CardContent></Card>
            <Card><CardContent className="status-card"><span>PWA build</span><strong>{PWA_BUILD_VERSION}</strong><small>{scriptFile}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Sync cursor</span><strong>{cursor}</strong><small>{applied === null ? "Ready" : `${applied} new event(s)`}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Trust sequence</span><strong>{trust?.trustSequence ?? "—"}</strong><small>{trust ? "Android trust root present" : "Not published"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Payload protection</span><strong>{inboxEvents.some(event => event.decryption?.state === "decrypted") ? "E2EE locally decrypted" : events.length ? "See payload diagnostics" : "No payloads received"}</strong><small>Legacy v0 is plaintext. Encrypted messages require an authorized key grant. Missing keys stay locked; failed authentication is reported as corrupt.</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Linked session</span><strong>Authenticated</strong><small>Latest stored sequence: {events[0]?.sequence ?? 0}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Android battery</span><strong>{telemetry?.battery?.level == null ? "—" : `${telemetry.battery.level}%${telemetry.battery.isCharging ? " · charging" : ""}`}</strong><small>{telemetry?.device ? `${telemetry.device.manufacturer} ${telemetry.device.model}` : "Waiting for telemetry"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Android outbox</span><strong>{telemetry?.sync?.outboxDepth ?? "—"}</strong><small>{telemetry?.sync?.deadLetterCount ? `${telemetry.sync.deadLetterCount} dead letter` : "No dead letters"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Android network</span><strong>{telemetry?.network?.isConnected ? "Connected" : telemetry ? "Offline" : "—"}</strong><small>{telemetry?.network?.networkType || "Waiting for telemetry"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Android app</span><strong>{telemetry?.app?.versionName || "—"}</strong><small>{telemetry?.receivedAt ? `Last report ${formatTime(telemetry.receivedAt)}` : "Never reported"}</small></CardContent></Card>
          </div>
          {bootstrapState && bootstrapState !== "READY" && <div className="notice">Finishing secure session setup: {bootstrapState}</div>}
          {error && <div className="notice danger">{error}</div>}
        </TabPanel>

        <TabPanel id="security" className="content-panel">
          <div className="page-title"><p className="eyebrow">Protection</p><h1>Security</h1><p>Credentials and identities visible to this linked browser.</p></div>
          <div className="security-list">
            <Card><CardContent className="security-row"><div><strong>Message encryption</strong><p>{inboxEvents.filter(event => event.decryption?.state === "decrypted").length} decrypted · {inboxEvents.filter(event => event.decryption?.state === "locked").length} locked · {inboxEvents.filter(event => event.decryption?.state === "invalid").length} invalid</p><p>Key grants come from your primary phone. Older browser identities may need Lock → Reset browser identity and pair again. Legacy plaintext cannot be protected retroactively.</p></div></CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Passkeys</strong><p>{credentials === null ? "Dashboard authentication required" : `${credentials.length} enrolled credential(s)`}</p></div>{credentials?.map((credential) => <Button key={credential.credentialId} size="sm" variant="ghost" onPress={() => void removeCredential(credential.credentialId).then(refreshSecurity)}>Remove {credential.label || shortId(credential.credentialId)}</Button>)}</CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Android identities</strong><p>{identities === null ? "Unavailable" : `${identities.length} registered device(s)`}</p></div><Chip size="sm" variant="soft">{identities?.length ?? 0}</Chip></CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Private push</strong><p>Notifications contain no sender or message text.</p></div><Chip size="sm" variant="soft">{pushCount ?? 0} subscription(s)</Chip></CardContent></Card>
          </div>
        </TabPanel>

        <TabPanel id="debug" className="content-panel">
          <div className="page-title"><p className="eyebrow">Diagnostics</p><h1>Debug</h1><p>Raw protocol details live here instead of inside the Inbox.</p></div>
          <div className="debug-actions"><Button variant="secondary" onPress={() => void pull()} isDisabled={busy}>Sync now</Button><Button variant="ghost" onPress={() => void resetLocal().then(refresh)}>Reset local ciphertext</Button></div>
          <Card><CardContent className="security-row"><div><strong>Projection</strong><p>cursor {cursor} · sync {error ? "failed" : "HTTP 200"} · grants {events.filter(event => event.type === "KEY_GRANT" || event.type === "CONTACTS_KEY_GRANT").length} · contacts {contacts.length} · decrypt failures {events.filter(event => event.decryption?.state === "invalid").length}</p></div></CardContent></Card>
          <Card><CardContent className="debug-list">{events.slice(0, 40).map((event) => <div key={event.sequence}><code>#{event.sequence}</code><span>{event.type}</span><Chip size="sm" variant="soft" color={eventDecodeState(event) === "Invalid/corrupt payload" ? "danger" : "warning"}>{eventDecodeState(event)}</Chip></div>)}</CardContent></Card>
          <Card><CardContent className="debug-list">{pairingDiagnostics?.slice(0, 20).map((entry) => <div key={entry.id}><code>{entry.statusCode}</code><span>{entry.details?.pairing?.stage || entry.title}</span><small>{entry.details?.pairing?.reason || entry.path}</small></div>)}{pairingDiagnostics?.length === 0 && <p>No pairing diagnostics.</p>}</CardContent></Card>
        </TabPanel>
      </Tabs>
    </div>
  );
}
