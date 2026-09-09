import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CardContent, Chip, ScrollShadow, Spinner, Tab, TabList, TabPanel, Tabs } from "@heroui/react";
import { syncNow, listRecentEvents, listAggregateEventsPage, listContacts, listConversations, getCursor, getBrowserSyncStatus, resetLocal, subscribeSyncAvailable, syncStep, syncUntilCaughtUp, type BrowserSyncStatus, type StoredContact, type StoredEvent } from "../lib/sync";
import { messagesForAggregate, type ConversationProjection } from "../lib/inbox";
import { createCommand, fetchCommand, fetchPrimaryCommandKey, fetchPrimaryTelemetry, fetchSyncDiagnostics, fetchTrustSnapshot, health, type DeviceTelemetry, type ServerSyncDiagnostics, type TrustSnapshot } from "../lib/api";
import { encryptCommand } from "../lib/commandCrypto";
import { listCredentials, removeCredential, listPushSubscriptions, type CredentialRow } from "../lib/security";
import { completeLinkedSession } from "../lib/pairing";
import { PairingScreen } from "../screens/PairingScreen";
import { PWA_BUILD_VERSION, loadedScriptFile } from "../lib/buildInfo";
import { collectWebDiagnostics, formatWebDiagnostics, type WebDiagnosticReport } from "../lib/diagnostics";

type TabKey = "inbox" | "contacts" | "connection" | "security" | "debug";
type ThreadState = "IDLE" | "LOADING" | "READY" | "LOCKED" | "EMPTY" | "FAILED";

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
  const [threadNext, setThreadNext] = useState<number | undefined>();
  const [threadHasMore, setThreadHasMore] = useState(false);
  const [loadingOlderThread, setLoadingOlderThread] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<TrustSnapshot | null>(null);
  const [version, setVersion] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [bootstrapState, setBootstrapState] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<BrowserSyncStatus>(getBrowserSyncStatus());
  const [serverStats, setServerStats] = useState<ServerSyncDiagnostics | null>(null);
  const [threadState, setThreadState] = useState<ThreadState>("IDLE");
  const [threadFirstPageMs, setThreadFirstPageMs] = useState<number | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadReload, setThreadReload] = useState(0);
  const [webDiagnostics, setWebDiagnostics] = useState<WebDiagnosticReport | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [credentials, setCredentials] = useState<CredentialRow[] | null>(null);
  const [pushCount, setPushCount] = useState<number | null>(null);
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
    const [nextCursor, nextEvents, nextTrust, nextContacts, nextServerStats] = await Promise.all([
      getCursor(), listRecentEvents(500), fetchTrustSnapshot(), listContacts(), fetchSyncDiagnostics().catch(() => null),
    ]);
    setCursor(nextCursor);
    setEvents(nextEvents);
    setTrust(nextTrust);
    setServerStats(nextServerStats);
    setSyncStatus(getBrowserSyncStatus());
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
    const [nextCredentials, pushes] = await Promise.all([
      listCredentials().catch(() => null),
      listPushSubscriptions().catch(() => null),
    ]);
    setCredentials(nextCredentials);
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
        setBootstrapState("FIRST_PAINT_READY");
        setSyncStatus(getBrowserSyncStatus());
        if (getBrowserSyncStatus().state === "UP_TO_DATE") return;
        void syncUntilCaughtUp((count) => {
          if (count % 10_000 === 0) void refresh();
        })
          .then(refresh)
          .then(() => {
            setBootstrapState("UP_TO_DATE");
            setSyncStatus(getBrowserSyncStatus());
          })
          .catch(cause => {
            setBootstrapState("DEGRADED");
            setSyncStatus(getBrowserSyncStatus());
            setError(cause instanceof Error ? cause.message : String(cause));
          });
      })
      .catch(cause => {
        setBootstrapState("FAILED");
        setSyncStatus(getBrowserSyncStatus());
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    void refreshSecurity();
    const refreshTelemetry = () => void fetchPrimaryTelemetry().then(setTelemetry).catch(() => setTelemetry(null));
    refreshTelemetry();
    const telemetryTimer = window.setInterval(refreshTelemetry, 60_000);
    const unsubscribe = subscribeSyncAvailable((count) => {
      setApplied(count);
      setSyncStatus(getBrowserSyncStatus());
      void refresh();
    }, () => {
      setAuthed(false);
      setEvents([]);
      setSelected(null);
      void resetLocal();
    }, cause => {
      setSyncStatus(getBrowserSyncStatus());
      setError(cause instanceof Error ? cause.message : String(cause));
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
    setThreadError(null);
    if (!selected || !authed) {
      setThreadState("IDLE");
      return () => { cancelled = true; };
    }
    setThreadState("LOADING");
    const startedAt = performance.now();
    void listAggregateEventsPage(selected, { limit: 200 }).then(page => {
      if (cancelled) return;
      setThreadFirstPageMs(Math.round(performance.now() - startedAt));
      setThreadEvents(page.items);
      setThreadHasMore(page.hasMore);
      setThreadNext(page.next);
      const rawMessages = page.items.filter(event => event.type === "MESSAGE_CREATED" || event.type === "MESSAGE_UPDATED");
      const readable = messagesForAggregate(page.items, selected);
      if (readable.length > 0) setThreadState("READY");
      else if (rawMessages.some(event => event.decryption?.state === "locked")) setThreadState("LOCKED");
      else if (rawMessages.some(event => event.decryption?.state === "invalid")) {
        setThreadState("FAILED");
        setThreadError("Message decryption failed");
      } else setThreadState("EMPTY");
    }).catch(cause => {
      if (cancelled) return;
      setThreadFirstPageMs(Math.round(performance.now() - startedAt));
      setThreadState("FAILED");
      setThreadError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [selected, events, authed, threadReload]);
  const loadOlderThread = async () => {
    if (!selected || threadNext === undefined || loadingOlderThread) return;
    setLoadingOlderThread(true);
    try {
      const page = await listAggregateEventsPage(selected, { limit: 200, beforeSequence: threadNext });
      setThreadEvents(prev => [...prev, ...page.items]);
      setThreadHasMore(page.hasMore);
      setThreadNext(page.next);
    } catch (cause) {
      setThreadError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoadingOlderThread(false); }
  };
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
      setSyncStatus(getBrowserSyncStatus());
    } finally {
      setBusy(false);
    }
  };

  const runDiagnostics = async () => {
    setDiagnosticsBusy(true);
    try {
      setWebDiagnostics(await collectWebDiagnostics(selected ? {
        aggregateId: selected,
        events: threadEvents,
        state: threadState,
        firstPageDurationMs: threadFirstPageMs,
        lastPageError: threadError,
      } : undefined));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const serverTypeCount = (type: string) =>
    serverStats?.countsByType.find(row => row.type === type)?.count ?? 0;
  let syncBanner = `Syncing message history… ${syncStatus.appliedThisRun} event(s) applied`;
  if (serverStats) syncBanner = `Syncing message history… cursor ${cursor} / ${serverStats.maxSequence}`;
  if (syncStatus.state === "UP_TO_DATE") syncBanner = "Messages are up to date";
  if (syncStatus.state === "DEGRADED" || syncStatus.state === "FAILED") syncBanner = `Sync paused after sequence ${cursor}`;
  let emptyInboxMessage = "Browser has not downloaded message history.";
  if (serverStats && serverTypeCount("MESSAGE_CREATED") === 0) emptyInboxMessage = "No message events have reached GMweb yet.";
  else if (cursor > 0 && events.some(event => event.decryption?.state === "locked")) emptyInboxMessage = "Messages downloaded but are waiting for keys.";
  else if (cursor > 0) emptyInboxMessage = "Conversation projection is being repaired.";

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
          <div className={`notice ${syncStatus.state === "DEGRADED" || syncStatus.state === "FAILED" ? "danger" : ""}`} role="status">
            <span>{syncBanner}</span>
            {(syncStatus.state === "DEGRADED" || syncStatus.state === "FAILED") &&
              <Button size="sm" variant="ghost" onPress={() => void pull()}>Retry</Button>}
          </div>
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
                {filteredConversations.length === 0 && <div className="empty-list"><span>✦</span><p>{conversations.length ? "No matching conversations" : emptyInboxMessage}</p></div>}
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
                  {threadHasMore && (
                    <Button size="sm" variant="ghost" className="load-older-thread" onPress={() => void loadOlderThread()} isDisabled={loadingOlderThread}>
                      {loadingOlderThread ? "Loading…" : "Load older messages"}
                    </Button>
                  )}
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
                    {threadState === "LOADING" && <div className="empty-conversation"><Spinner /><h3>Loading messages…</h3></div>}
                    {threadState === "LOCKED" && <div className="empty-conversation"><div className="empty-icon">↻</div><h3>Messages are encrypted</h3><p>The browser is waiting for an authorized key.</p></div>}
                    {threadState === "EMPTY" && <div className="empty-conversation"><div className="empty-icon">✦</div><h3>No messages in this conversation.</h3></div>}
                    {threadState === "FAILED" && <div className="empty-conversation"><div className="empty-icon">!</div><h3>Unable to load messages</h3><p>{threadError || "Thread page read failed"}</p><Button size="sm" onPress={() => setThreadReload(value => value + 1)}>Retry</Button></div>}
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
            {filteredContacts.length === 0 && <div className="empty-list"><span>✦</span><p>{contacts.length
              ? "No matching contacts"
              : !capabilities.includes("CONTACTS_READ")
                ? "Contacts access was not approved for this linked browser. Re-link or re-approve this browser."
                : serverTypeCount("CONTACTS_SNAPSHOT") === 0 && serverTypeCount("CONTACTS_CHANGED") === 0
                  ? "No encrypted contact events have reached GMweb yet."
                  : "Contacts downloaded but are waiting for a key or projection."}</p></div>}
          </div>
        </TabPanel>

        <TabPanel id="connection" className="content-panel">
          <div className="page-title"><p className="eyebrow">System</p><h1>Connection</h1><p>Live state of the PWA, Android sync and trust registry.</p></div>
          <div className="status-grid">
            <Card><CardContent className="status-card"><span>API</span><strong>{version}</strong><Chip size="sm" color={version === "unreachable" ? "danger" : "success"} variant="soft">{version === "unreachable" ? "offline" : "healthy"}</Chip></CardContent></Card>
            <Card><CardContent className="status-card"><span>PWA build</span><strong>{PWA_BUILD_VERSION}</strong><small>{scriptFile}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Sync cursor</span><strong>{cursor}</strong><small>{applied === null ? "Ready" : `${applied} new event(s)`}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Trust sequence</span><strong>{trust?.trustSequence ?? "—"}</strong><small>{trust ? "Android-signed registry available" : "Waiting for first Android trust statement"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Payload protection</span><strong>{events.some(event => event.decryption?.state === "decrypted") ? "E2EE locally decrypted" : events.length ? "See payload diagnostics" : "No payloads received"}</strong><small>Encrypted messages require an authorized key grant. Missing keys stay locked; failed authentication is reported as corrupt.</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Linked session</span><strong>Authenticated</strong><small>Latest stored sequence: {events[0]?.sequence ?? 0}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Android battery</span><strong>{telemetry?.battery?.level == null ? "—" : `${telemetry.battery.level}%${telemetry.battery.isCharging ? " · charging" : ""}`}</strong><small>{telemetry?.device ? `${telemetry.device.manufacturer} ${telemetry.device.model}` : "Waiting for telemetry"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Android outbox</span><strong>{telemetry?.sync?.outboxDepth ?? "—"}</strong><small>{telemetry?.sync?.deadLetterCount ? `${telemetry.sync.deadLetterCount} dead letter` : "No dead letters"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Android network</span><strong>{telemetry?.network?.isConnected ? "Connected" : telemetry ? "Offline" : "—"}</strong><small>{telemetry?.network?.networkType || "Waiting for telemetry"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Android app</span><strong>{telemetry?.app?.versionName || "—"}</strong><small>{telemetry?.receivedAt ? `Last report ${formatTime(telemetry.receivedAt)}` : "Never reported"}</small></CardContent></Card>
          </div>
          {bootstrapState && syncStatus.state !== "UP_TO_DATE" && <div className="notice">Secure session: {bootstrapState}</div>}
          {error && <div className="notice danger">{error}</div>}
        </TabPanel>

        <TabPanel id="security" className="content-panel">
          <div className="page-title"><p className="eyebrow">Protection</p><h1>Security</h1><p>Credentials and identities visible to this linked browser.</p></div>
          <div className="security-list">
            <Card><CardContent className="security-row"><div><strong>Message encryption</strong><p>{events.filter(event => event.decryption?.state === "decrypted").length} recent decrypted · {events.filter(event => event.decryption?.state === "locked").length} recent locked · {events.filter(event => event.decryption?.state === "invalid").length} recent invalid</p><p>Open Debug for full local aggregate counts. Key grants come from your primary phone.</p></div></CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Passkeys</strong><p>{credentials === null ? "Dashboard authentication required" : `${credentials.length} enrolled credential(s)`}</p></div>{credentials?.map((credential) => <Button key={credential.credentialId} size="sm" variant="ghost" onPress={() => void removeCredential(credential.credentialId).then(refreshSecurity)}>Remove {credential.label || shortId(credential.credentialId)}</Button>)}</CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Android trust registry</strong><p>{trust ? `Verified root published at sequence ${trust.trustSequence}` : "Waiting for the primary phone's first signed trust statement"}</p></div><Chip size="sm" variant="soft">{trust ? "Ready" : "Pending"}</Chip></CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Private push</strong><p>Notifications contain no sender or message text.</p></div><Chip size="sm" variant="soft">{pushCount ?? 0} subscription(s)</Chip></CardContent></Card>
          </div>
        </TabPanel>

        <TabPanel id="debug" className="content-panel">
          <div className="page-title"><p className="eyebrow">Diagnostics</p><h1>Web message diagnostics</h1><p>Privacy-safe counts across server, browser storage, crypto and projection.</p></div>
          <div className="debug-actions">
            <Button variant="secondary" onPress={() => void runDiagnostics()} isDisabled={diagnosticsBusy}>{diagnosticsBusy ? "Collecting…" : "Run diagnostics"}</Button>
            <Button variant="ghost" onPress={() => webDiagnostics && void navigator.clipboard.writeText(formatWebDiagnostics(webDiagnostics))} isDisabled={!webDiagnostics}>Copy diagnostic report</Button>
            <Button variant="ghost" onPress={() => void pull()} isDisabled={busy}>Retry sync</Button>
          </div>
          {webDiagnostics && <div className="status-grid">
            <Card><CardContent className="status-card"><span>Server</span><strong>{webDiagnostics.session.linked && webDiagnostics.server ? "PASS" : "FAIL"}</strong><small>{webDiagnostics.server?.total ?? "Unavailable"} events · max sequence {webDiagnostics.server?.maxSequence ?? "—"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Browser Sync</span><strong>{webDiagnostics.browserSync.state === "UP_TO_DATE" ? "PASS" : webDiagnostics.browserSync.state === "FAILED" ? "FAIL" : webDiagnostics.browserSync.state === "DEGRADED" ? "WARN" : "SYNCING"}</strong><small>cursor {webDiagnostics.browserSync.cursor} · lag {webDiagnostics.browserSync.syncLag ?? "unknown"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>IndexedDB</span><strong>PASS</strong><small>{webDiagnostics.indexedDb.total} raw events · {webDiagnostics.indexedDb.distinctMessageAggregateCount} message aggregates</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Crypto</span><strong>{webDiagnostics.crypto.messages.invalid || webDiagnostics.crypto.keyGrants.invalid ? "FAIL" : webDiagnostics.crypto.messages.locked ? "WARN" : "PASS"}</strong><small>{webDiagnostics.crypto.messages.decrypted} decrypted · {webDiagnostics.crypto.messages.locked} locked · {webDiagnostics.crypto.messages.invalid} invalid<br />Grant probe: {webDiagnostics.crypto.keyGrants.accepted} accepted · {Object.keys(webDiagnostics.crypto.keyGrants.reasons).join(", ") || "no rejection"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Projection</span><strong>{webDiagnostics.projection.failure ? "FAIL" : webDiagnostics.projection.lag ? "SYNCING" : "PASS"}</strong><small>{webDiagnostics.projection.failure || `${webDiagnostics.projection.rows} rows`} · cursor {webDiagnostics.projection.cursor} · lag {webDiagnostics.projection.lag}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Contacts</span><strong>{webDiagnostics.contacts.failure ? "WARN" : "PASS"}</strong><small>{webDiagnostics.contacts.failure || `${webDiagnostics.contacts.stored} rows`} · {webDiagnostics.contacts.grants} grants · {webDiagnostics.contacts.snapshots} snapshots</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Selected Thread</span><strong>{!webDiagnostics.selectedThread ? "PASS" : webDiagnostics.selectedThread.state === "FAILED" ? "FAIL" : webDiagnostics.selectedThread.state === "LOADING" ? "SYNCING" : webDiagnostics.selectedThread.state === "LOCKED" ? "WARN" : "PASS"}</strong><small>{webDiagnostics.selectedThread ? `${webDiagnostics.selectedThread.state} · ${webDiagnostics.selectedThread.decrypted} decrypted · ${webDiagnostics.selectedThread.locked} locked` : "Select a conversation"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Build / Service Worker</span><strong>{webDiagnostics.session.buildMismatch ? "BUILD_MISMATCH" : "PASS"}</strong><small>{webDiagnostics.session.pwaVersion} · {webDiagnostics.session.loadedScript} · {webDiagnostics.session.serviceWorker}</small></CardContent></Card>
          </div>}
          {webDiagnostics && <div className={`notice ${webDiagnostics.overall === "FAIL" ? "danger" : ""}`}>Overall: {webDiagnostics.overall}</div>}
        </TabPanel>
      </Tabs>
    </div>
  );
}
