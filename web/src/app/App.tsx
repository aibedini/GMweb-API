import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CardContent, Chip, Spinner, Tab, TabList, TabPanel, Tabs } from "@heroui/react";
import { syncVisibleInbox, loadContactsOnDemand, listRecentEvents, listAggregateEventsPage, listContacts, listConversations, listChangedConversationHeads, getCursor, getBrowserSyncStatus, resetLocal, subscribeSyncAvailable, subscribeKeyMaintenance, type BrowserSyncStatus, type StoredContact, type StoredEvent } from "../lib/sync";
import { messagesForAggregate, reconcileConversationHead, type ConversationProjection } from "../lib/inbox";
import { createCommand, fetchCommand, fetchLinkedSessions, fetchPrimaryCommandKey, fetchPrimaryTelemetry, fetchTrustSnapshot, health, type DeviceTelemetry, type LinkedBrowserSession, type TrustSnapshot } from "../lib/api";
import { encryptCommand } from "../lib/commandCrypto";
import { getStoredDeviceIdentity } from "../lib/deviceKeys";
import { clearPendingSend, loadPendingSends, savePendingSend, type PendingEncryptedSend } from "../lib/commandOutbox";
import { completeLinkedSession } from "../lib/pairing";
import { PairingScreen } from "../screens/PairingScreen";
import { PWA_BUILD_VERSION, loadedScriptFile } from "../lib/buildInfo";
import { collectWebDiagnostics, formatWebDiagnostics, type WebDiagnosticReport } from "../lib/diagnostics";
import { useVirtualizer } from "@tanstack/react-virtual";
import { calculateSmsSegments } from "../lib/smsSegments";
import { markBrowserProjected, markBrowserRendered } from "../lib/sync/live-invalidation";
import { mergeThreadEvents, assertHistoryProgress } from "../lib/threadHistory";
import { selectSmsSim } from "../lib/simSelection";

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

async function ensurePendingCommandId(pending: PendingEncryptedSend): Promise<string> {
  if (pending.commandId) return pending.commandId;
  const command = await createCommand({ type: "SEND_SMS", payload: pending.payload,
    idempotencyKey: pending.idempotencyKey, targetAgentId: pending.targetAgentId });
  await savePendingSend({ ...pending, commandId: command.commandId });
  return command.commandId;
}

export default function App() {
  const [tab, setTab] = useState<TabKey>("inbox");
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [threadEvents, setThreadEvents] = useState<StoredEvent[]>([]);
  const [threadNext, setThreadNext] = useState<number | string | undefined>();
  const [threadHasMore, setThreadHasMore] = useState(false);
  const [loadingOlderThread, setLoadingOlderThread] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyLoadingRef = useRef(false);
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
  const [threadState, setThreadState] = useState<ThreadState>("IDLE");
  const [threadFirstPageMs, setThreadFirstPageMs] = useState<number | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadReload, setThreadReload] = useState(0);
  const [webDiagnostics, setWebDiagnostics] = useState<WebDiagnosticReport | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [telemetry, setTelemetry] = useState<DeviceTelemetry | null>(null);
  const [linkedBrowsers, setLinkedBrowsers] = useState<LinkedBrowserSession[]>([]);
  const [showLinkedBrowsers, setShowLinkedBrowsers] = useState(false);
  const [contacts, setContacts] = useState<StoredContact[]>([]);
  const [contactSearch, setContactSearch] = useState("");
  const [contactsBusy, setContactsBusy] = useState(false);
  const [contactsProgress, setContactsProgress] = useState(0);
  const [contactsCheckedAt, setContactsCheckedAt] = useState<number | null>(null);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [visibleContactCount, setVisibleContactCount] = useState(100);
  // PWA projection: paginated conversation read-model (replaces the old
  // listInboxEvents(100) inbox scan).
  const [conversationPage, setConversationPage] = useState<ConversationProjection[]>([]);
  const [selectedConversationCache, setSelectedConversationCache] = useState<ConversationProjection | null>(null);
  const [conversationNext, setConversationNext] = useState<string | { lastAt: number; aggregateId: string } | undefined>();
  const [conversationHasMore, setConversationHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState<number | null>(() => {
    const saved = window.localStorage.getItem("gmweb:selected-sms-subscription");
    return saved !== null && Number.isSafeInteger(Number(saved)) ? Number(saved) : null;
  });
  const [composeRecipient, setComposeRecipient] = useState("");
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<{ clientMessageId: string; body: string; recipient: string; at: number } | null>(null);
  const markReadSent = useRef(new Set<string>());
  const lastThreadSelection = useRef<string | null>(null);
  const recoveringSend = useRef(false);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const hasLoadedOlderConversations = useRef(false);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const scriptFile = useMemo(() => loadedScriptFile(), []);
  const refreshTelemetry = () => void fetchPrimaryTelemetry().then(value => {
    setTelemetry(value);
  }).catch(() => setTelemetry(null));

  const refresh = async () => {
    const [nextCursor, nextEvents, nextTrust, nextContacts] = await Promise.all([
      getCursor(), listRecentEvents(500), fetchTrustSnapshot(), listContacts(),
    ]);
    setCursor(nextCursor);
    setEvents(nextEvents);
    setTrust(nextTrust);
    setSyncStatus(getBrowserSyncStatus());
    const page = await listConversations({ limit: 100 });
    markBrowserProjected();
    setConversationPage(prev => prev.length > 100
      ? [...new Map([...prev, ...page.items].map(item => [item.aggregateId, item])).values()]
        .sort((a, b) => b.lastAt - a.lastAt || a.aggregateId.localeCompare(b.aggregateId))
      : page.items);
    requestAnimationFrame(() => markBrowserRendered());
    setConversationHasMore(prev => hasLoadedOlderConversations.current ? prev : page.hasMore);
    setConversationNext(prev => hasLoadedOlderConversations.current ? prev : page.next);
    setContacts(nextContacts);
  };

  const refreshCached = async () => {
    const [nextCursor, nextEvents, nextContacts, page] = await Promise.all([
      getCursor(), listRecentEvents(500), listContacts(), listConversations({ limit: 100 }),
    ]);
    setCursor(nextCursor);
    setEvents(nextEvents);
    setContacts(nextContacts);
    setConversationPage(prev => prev.length > 100
      ? [...new Map([...prev, ...page.items].map(item => [item.aggregateId, item])).values()]
        .sort((a, b) => b.lastAt - a.lastAt || a.aggregateId.localeCompare(b.aggregateId))
      : page.items);
    setConversationHasMore(prev => hasLoadedOlderConversations.current ? prev : page.hasMore);
    setConversationNext(prev => hasLoadedOlderConversations.current ? prev : page.next);
  };

  const refreshChanged = async (ids: string[]) => {
    const changed = await listChangedConversationHeads(ids);
    const removed = new Set(changed.removed);
    setConversationPage(previous => {
      const merged = new Map(previous.filter(row => !removed.has(row.aggregateId))
        .map(row => [row.aggregateId, row]));
      for (const row of changed.items) merged.set(row.aggregateId, row);
      return [...merged.values()].sort((a, b) => b.lastAt - a.lastAt || a.aggregateId.localeCompare(b.aggregateId));
    });
    markBrowserProjected();
    requestAnimationFrame(() => markBrowserRendered());
    setSyncStatus(getBrowserSyncStatus());
  };

  const loadOlderConversations = async () => {
    if (!conversationNext || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await listConversations({ limit: 100, before: conversationNext });
      hasLoadedOlderConversations.current = true;
      setConversationPage(prev => {
        const merged = new Map([...prev, ...page.items].map(item => [item.aggregateId, item]));
        return [...merged.values()].sort((a, b) => b.lastAt - a.lastAt || a.aggregateId.localeCompare(b.aggregateId));
      });
      setConversationHasMore(page.hasMore);
      setConversationNext(page.next);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const refreshContacts = async () => {
    if (contactsBusy) return;
    setContactsBusy(true);
    setContactsError(null);
    setContactsProgress(0);
    try {
      await loadContactsOnDemand(setContactsProgress);
      setContacts(await listContacts());
      setContactsCheckedAt(Date.now());
    } catch (cause) {
      setContactsError(cause instanceof Error ? cause.message : String(cause));
    } finally { setContactsBusy(false); }
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
    const authConfirmedAt = performance.now();
    void refreshCached()
      .then(() => {
        setBootstrapState("FIRST_PAINT_READY");
        performance.mark("gmweb-auth-to-cached-paint");
        console.info(`web_warm_start authToCachedPaintMs=${Math.round(performance.now() - authConfirmedAt)}`);
        return syncVisibleInbox();
      })
      .then(refresh)
      .then(() => {
        setSyncStatus(getBrowserSyncStatus());
        setBootstrapState(getBrowserSyncStatus().state === "UP_TO_DATE" ? "UP_TO_DATE" : "DEGRADED");
      })
      .catch(cause => {
        setBootstrapState("FAILED");
        setSyncStatus(getBrowserSyncStatus());
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    refreshTelemetry();
    const telemetryTimer = window.setInterval(refreshTelemetry, 60_000);
    const refreshLinkedBrowsers = () => void fetchLinkedSessions().then(setLinkedBrowsers).catch(() => setLinkedBrowsers([]));
    refreshLinkedBrowsers();
    const linkedBrowsersTimer = window.setInterval(refreshLinkedBrowsers, 60_000);
    const refreshVisible = () => void syncVisibleInbox().then(changed => {
      setSyncStatus(getBrowserSyncStatus());
      if (changed) { setApplied(changed); setThreadReload(value => value + 1); void refresh(); }
    }).catch(cause => {
      setSyncStatus(getBrowserSyncStatus());
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    const visibleTimer = window.setInterval(refreshVisible, 30_000);
    const unsubscribe = subscribeSyncAvailable((count, ids) => {
      setApplied(count);
      setSyncStatus(getBrowserSyncStatus());
      setThreadReload(value => value + 1);
      void (ids?.length ? refreshChanged(ids) : refresh());
    }, () => {
      setAuthed(false);
      setEvents([]);
      setSelected(null);
      void resetLocal();
    }, cause => {
      setSyncStatus(getBrowserSyncStatus());
      setError(cause instanceof Error ? cause.message : String(cause));
    }, syncVisibleInbox);
    const unsubscribeKeys = subscribeKeyMaintenance(() => {
      setSyncStatus(getBrowserSyncStatus());
      setThreadReload(value => value + 1);
      void refresh();
    });
    return () => { window.clearInterval(telemetryTimer); window.clearInterval(linkedBrowsersTimer); window.clearInterval(visibleTimer); unsubscribe(); unsubscribeKeys(); };
  }, [authed]);

  useEffect(() => {
    if (!authed || tab !== "contacts") return;
    void refreshContacts();
  }, [authed, tab]);

  const contactNames = useMemo(() => new Map(contacts.map(contact => [contact.normalizedPhone, contact.displayName])), [contacts]);
  const conversations = useMemo(() => reconcileConversationHead(conversationPage, selected,
    selected ? messagesForAggregate(threadEvents, selected).at(-1) : undefined),
    [conversationPage, selected, threadEvents]);
  const filteredContacts = useMemo(() => {
    const query = contactSearch.trim().toLocaleLowerCase();
    return query ? contacts.filter(contact => `${contact.displayName}\n${contact.normalizedPhone}`.toLocaleLowerCase().includes(query)) : contacts;
  }, [contacts, contactSearch]);
  const recipientMatches = useMemo(() => {
    const query = recipientSearch.trim().toLocaleLowerCase();
    if (!query) return contacts.slice(0, 30);
    return contacts.filter(contact => `${contact.displayName}\n${contact.normalizedPhone}`.toLocaleLowerCase().includes(query)).slice(0, 30);
  }, [contacts, recipientSearch]);
  const selectRecipient = (phone: string) => {
    setComposeRecipient(phone);
    const matching = conversations.find(item => item.subtitle === phone || item.title === phone);
    setSelected(matching?.aggregateId ?? null);
    if (matching) setSelectedConversationCache(matching);
    setComposeOpen(false);
    setRecipientSearch("");
    setTab("inbox");
  };
  const filteredConversations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return conversations;
    return conversations.filter((item) => `${item.title}\n${item.preview}`.toLocaleLowerCase().includes(query));
  }, [conversations, search]);

  useEffect(() => {
    if (window.innerWidth > 720 && !selected && !composeRecipient && !composeOpen && conversations[0]) setSelected(conversations[0].aggregateId);
  }, [conversations, selected, composeRecipient, composeOpen]);

  const selectedConversation = conversations.find((item) => item.aggregateId === selected) ||
    (selectedConversationCache?.aggregateId === selected ? selectedConversationCache : null);
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
    setThreadError(null);
    if (lastThreadSelection.current !== selected) setHistoryError(null);
    if (!selected || !authed) {
      lastThreadSelection.current = null;
      setThreadEvents([]);
      setThreadState("IDLE");
      return () => { cancelled = true; };
    }
    const sameThread = lastThreadSelection.current === selected;
    lastThreadSelection.current = selected;
    const scroll = messageScrollRef.current;
    const stickToBottom = !sameThread || !scroll ||
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    if (!sameThread) { setThreadEvents([]); setThreadState("LOADING"); }
    const startedAt = performance.now();
    void listAggregateEventsPage(selected, { limit: 10 }).then(page => {
      if (cancelled) return;
      if (page.hasMore && page.next === undefined) {
        setHistoryError("PAGINATION_STALLED");
        setThreadHasMore(false);
      }
      setThreadFirstPageMs(Math.round(performance.now() - startedAt));
      if (sameThread && !stickToBottom) {
        setThreadEvents(previous => mergeThreadEvents(previous, page.items));
      } else {
        setThreadEvents(page.items);
        setThreadHasMore(page.hasMore && page.next !== undefined);
        setThreadNext(page.next);
        requestAnimationFrame(() => {
          const pane = messageScrollRef.current;
          if (pane) pane.scrollTop = pane.scrollHeight;
        });
      }
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
    if (!selected || threadNext === undefined || historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setLoadingOlderThread(true);
    setHistoryError(null);
    try {
      const requestedCursor = threadNext;
      const page = await listAggregateEventsPage(selected, {
        limit: 20,
        ...(typeof requestedCursor === "string" ? { beforeState: requestedCursor } : { beforeSequence: requestedCursor }),
      });
      if (page.items.some(event => event.decryption?.state === "invalid")) throw new Error("DECRYPTION_FAILED");
      assertHistoryProgress(requestedCursor, page);
      const scroll = messageScrollRef.current;
      const previousHeight = scroll?.scrollHeight ?? 0;
      setThreadEvents(prev => mergeThreadEvents(prev, page.items));
      requestAnimationFrame(() => {
        if (scroll) scroll.scrollTop += scroll.scrollHeight - previousHeight;
      });
      setThreadHasMore(page.hasMore);
      setThreadNext(page.next);
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "HISTORY_PAGE_FAILED");
    } finally { historyLoadingRef.current = false; setLoadingOlderThread(false); }
  };
  const messages = useMemo(() => selected ? messagesForAggregate(threadEvents, selected) : [], [threadEvents, selected]);
  const conversationVirtualizer = useVirtualizer({
    count: filteredConversations.length,
    getScrollElement: () => conversationScrollRef.current,
    estimateSize: () => 76,
    overscan: 8,
    getItemKey: index => filteredConversations[index]?.aggregateId ?? index,
  });
  const messageVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => messageScrollRef.current,
    estimateSize: () => 72,
    overscan: 12,
    getItemKey: index => messages[index]?.payload.messageId ?? messages[index]?.event.eventId ?? index,
  });
  const selectedRecipient = composeRecipient || messages.map(item => item.payload.address).find(Boolean);
  const smsSegments = useMemo(() => calculateSmsSegments(draft), [draft]);
  const activeSims = telemetry?.smsSubscriptions?.items.filter(sim => sim.isActive) ?? [];
  const chosenSim = selectSmsSim(activeSims, selectedSubscriptionId);
  const simAvailable = Boolean(telemetry?.smsSubscriptions?.available && chosenSim);
  const showSimSelector = activeSims.length > 1 ||
    (selectedSubscriptionId !== null && !chosenSim && activeSims.length > 0);
  const chooseSim = (id: number) => {
    setSelectedSubscriptionId(id);
    window.localStorage.setItem("gmweb:selected-sms-subscription", String(id));
  };

  useEffect(() => {
    if (pendingMessage && messages.some(item =>
      item.payload.clientMessageId === pendingMessage.clientMessageId)) {
      setPendingMessage(null);
    }
  }, [messages, pendingMessage]);

  const submitCommand = async (type: "SEND_SMS" | "MARK_THREAD_READ", payload: Record<string, unknown>) => {
    const idempotencyKey = crypto.randomUUID();
    const target = await fetchPrimaryCommandKey();
    const encrypted = await encryptCommand(target.encryptionPublicKey, type, idempotencyKey, { type, ...payload });
    return createCommand({ type, payload: encrypted, idempotencyKey, targetAgentId: target.deviceId });
  };

  useEffect(() => {
    if (!selectedConversation || selectedConversation.read || !capabilities.includes("MARK_READ") || markReadSent.current.has(selectedConversation.aggregateId)) return;
    markReadSent.current.add(selectedConversation.aggregateId);
    void submitCommand("MARK_THREAD_READ", { conversationId: selectedConversation.aggregateId })
      .catch(() => markReadSent.current.delete(selectedConversation.aggregateId));
  }, [selectedConversation, capabilities]);

  const send = async () => {
    const body = draft.trim();
    if (!body) { setCommandStatus("EMPTY_BODY"); return; }
    if (!selectedRecipient) { setCommandStatus("NO_RECIPIENT"); return; }
    if (!capabilities.includes("SEND_MESSAGES")) { setCommandStatus("SEND_CAPABILITY_MISSING"); return; }
    if (!simAvailable) { setCommandStatus(!telemetry?.smsSubscriptions ? "SIM_STATE_UNAVAILABLE" : "SELECTED_SIM_UNAVAILABLE"); return; }
    if (recoveringSend.current) return;
    recoveringSend.current = true;
    const clientMessageId = commandStatus !== "COMPLETED" && !commandStatus?.startsWith("Command completed") &&
      pendingMessage?.body === body && pendingMessage.recipient === selectedRecipient
      ? pendingMessage.clientMessageId : crypto.randomUUID();
    setCommandStatus("Preparing send…");
    setPendingMessage({ clientMessageId, body, recipient: selectedRecipient, at: Date.now() });
    let failureCode = "COMMAND_CREATE_FAILED";
    try {
      const identity = await getStoredDeviceIdentity();
      if (!identity) { failureCode = "BROWSER_IDENTITY_UNAVAILABLE"; throw new Error(failureCode); }
      const pendingRows = (await loadPendingSends()).filter(row => row.browserDeviceId === identity.deviceId);
      const existing = pendingRows.find(row =>
        row.clientMessageId === clientMessageId && row.browserDeviceId === identity.deviceId);
      if (!existing && pendingRows.length > 0) {
        setPendingMessage(null);
        setCommandStatus("Previous send pending; waiting for phone");
        return;
      }
      let pending: PendingEncryptedSend | undefined = existing;
      if (!pending) {
        const idempotencyKey = crypto.randomUUID();
        failureCode = "DEVICE_COMMAND_KEY_UNAVAILABLE";
        const target = await fetchPrimaryCommandKey();
        setCommandStatus("Encrypting…");
        failureCode = "ENCRYPTION_FAILED";
        const payload = await encryptCommand(target.encryptionPublicKey, "SEND_SMS", idempotencyKey,
          { type: "SEND_SMS", phone: selectedRecipient, body, clientMessageId,
            ...(chosenSim ? { subscriptionId: chosenSim.subscriptionId } : {}) });
        pending = { browserDeviceId: identity.deviceId, clientMessageId, idempotencyKey, payload,
          targetAgentId: target.deviceId, createdAt: Date.now() };
        failureCode = "LOCAL_OUTBOX_FAILED";
        await savePendingSend(pending); // durable encrypted retry identity before HTTP
        setCommandStatus("Queued locally");
      }
      failureCode = "COMMAND_CREATE_FAILED";
      const commandId = await ensurePendingCommandId(pending);
      setCommandStatus("Accepted by GMweb; waiting for phone");
      if (!existing) setDraft("");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        failureCode = "COMMAND_POLL_FAILED";
        const state = await fetchCommand(commandId);
        setCommandStatus(state?.state === "COMPLETED" ? "Command completed; waiting for Android evidence" :
          state?.state === "FAILED" ? "COMMAND_FAILED" : state?.state === "EXPIRED" ? "COMMAND_EXPIRED" :
          "Waiting for phone");
        if (state && ["FAILED", "EXPIRED"].includes(state.state)) {
          if (!existing) setDraft(body);
          setPendingMessage(null);
          await clearPendingSend(pending.clientMessageId);
          break;
        }
        if (state?.state === "COMPLETED") {
          await clearPendingSend(pending.clientMessageId);
          break;
        }
      }
    } catch {
      // A lost response may follow a committed command. Retain the encrypted
      // envelope and identity so the next retry cannot create a second SMS.
      setCommandStatus(failureCode);
    } finally {
      recoveringSend.current = false;
    }
  };

  useEffect(() => {
    if (!authed) return;
    let recovering = false;
    const recover = () => void Promise.all([loadPendingSends(), getStoredDeviceIdentity()]).then(async ([pendingRows, identity]) => {
      if (recovering) return;
      recovering = true;
      try {
        for (const pending of pendingRows) {
          if (recoveringSend.current) return;
          if (pending.browserDeviceId !== identity?.deviceId) continue;
          setCommandStatus("Recovering pending send");
          try {
            const commandId = await ensurePendingCommandId(pending);
            const state = await fetchCommand(commandId);
          setCommandStatus(state?.state === "COMPLETED" ? "Command completed; waiting for Android evidence" :
            state?.state === "FAILED" ? "COMMAND_FAILED" : state?.state === "EXPIRED" ? "COMMAND_EXPIRED" :
            "Waiting for phone");
            if (state && ["COMPLETED", "FAILED", "EXPIRED"].includes(state.state))
              await clearPendingSend(pending.clientMessageId);
          } catch {
            setCommandStatus("Pending send needs retry");
            return;
          }
        }
      } finally { recovering = false; }
    }).catch(() => { recovering = false; setCommandStatus("Pending send needs retry"); });
    recover();
    const timer = window.setInterval(recover, 30_000);
    return () => window.clearInterval(timer);
  }, [authed]);

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      const count = await syncVisibleInbox();
      setApplied(count);
      setThreadReload(value => value + 1);
      if (tab === "contacts") await refreshContacts();
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
        lastPageError: historyError || threadError,
      } : undefined));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  let syncBanner = "Refreshing recent conversations…";
  if (syncStatus.state === "UP_TO_DATE") syncBanner = "Recent conversations are up to date";
  if (syncStatus.state === "DEGRADED") syncBanner = "Recent conversations need attention";
  if (syncStatus.state === "FAILED") syncBanner = "Conversation refresh paused";
  const emptyInboxMessage = "No recent conversations are available yet.";

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
          <Button className="topbar-button" size="sm" variant="ghost" aria-label="Linked browsers" onPress={() => setShowLinkedBrowsers(value => !value)}>👁 {linkedBrowsers.filter(row => row.onlineNow).length}</Button>
          <Button className="topbar-button" size="sm" variant="ghost" onPress={() => void pull()} isDisabled={busy}>{busy ? <Spinner size="sm" /> : "Sync"}</Button>
          <Button className="topbar-button" size="sm" variant="ghost" onPress={() => setAuthed(false)}>Lock</Button>
        </div>
      </header>
      {showLinkedBrowsers && <section className="linked-browser-panel" aria-label="Linked browser sessions">
        <div className="linked-browser-title"><strong>Linked browsers</strong><Button size="sm" variant="ghost" onPress={() => setShowLinkedBrowsers(false)}>Close</Button></div>
        {linkedBrowsers.length === 0 && <p>No linked browsers are currently visible.</p>}
        {linkedBrowsers.map((row, index) => <div className="linked-browser-row" key={`${row.deviceId}-${index}`}><strong>{row.onlineNow ? "● Online" : "○ Inactive"} · {shortId(row.deviceId)}</strong><span>{row.ip || "IP unavailable"}</span><small>{row.userAgent || "Browser unknown"}</small><small>Last seen: {new Date(row.lastSeenAt).toLocaleString()}</small><small>Last data request: {row.lastDataAt ? new Date(row.lastDataAt).toLocaleString() : "No data request observed"}</small><small>Last durable sync: {row.lastSyncAt ? new Date(row.lastSyncAt).toLocaleString() : "No sync acknowledgement"}</small></div>)}
      </section>}

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
          {syncStatus.keyState === "FAILED" && <div className="key-sync-note" role="status">Encryption keys need a retry. Recent messages remain available. <Button size="sm" variant="ghost" onPress={() => void pull()}>Retry</Button></div>}
          <div className={`inbox-layout ${selected || composeRecipient || composeOpen ? "mobile-thread" : "mobile-list"}`}>
            <aside className="conversation-pane">
              <div className="pane-heading"><div><p className="eyebrow">Inbox</p><h1>Conversations</h1></div><Chip size="sm" variant="soft">{conversations.length} loaded</Chip></div>
              <Button className="compose-button" size="sm" onPress={() => { setComposeOpen(true); setSelected(null); setComposeRecipient(""); setRecipientSearch(""); }}>＋ Compose</Button>
              <label className="search-box"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search messages" aria-label="Search messages" /></label>
              <div ref={conversationScrollRef} className="conversation-list" onScroll={(event) => {
                const element = event.currentTarget;
                if (conversationHasMore && !loadingOlder &&
                    element.scrollHeight - element.scrollTop - element.clientHeight < 180) void loadOlderConversations();
              }}>
                <div style={{ height: conversationVirtualizer.getTotalSize(), position: "relative" }}>
                  {conversationVirtualizer.getVirtualItems().map(virtualRow => {
                    const item = filteredConversations[virtualRow.index];
                    return <button key={item.aggregateId} ref={conversationVirtualizer.measureElement} data-index={virtualRow.index}
                      style={{ position: "absolute", width: "100%", transform: "translateY(" + virtualRow.start + "px)" }}
                      className={`conversation-row ${selected === item.aggregateId ? "selected" : ""}`} onClick={() => { setComposeOpen(false); setComposeRecipient(""); setSelected(item.aggregateId); setSelectedConversationCache(item); }}>
                        <Avatar title={item.title} />
                        <span className="conversation-copy"><span className="conversation-title">{item.title}{item.subtitle ? ` · ${item.subtitle}` : ""}</span><span className="conversation-preview">{item.preview}</span></span>
                        <span className="conversation-meta"><time>{formatTime(item.lastAt)}</time>{item.unreadCount > 0 && <Chip size="sm">{item.unreadCount}</Chip>}</span>
                      </button>;
                  })}
                </div>
                {filteredConversations.length === 0 && <div className="empty-list"><span>✦</span><p>{conversations.length ? "No matching conversations" : emptyInboxMessage}</p></div>}
              </div>
              {conversationHasMore && (
                <Button size="sm" variant="ghost" className="load-older" onPress={() => void loadOlderConversations()} isDisabled={loadingOlder}>
                  {loadingOlder ? "Loading…" : "Load older conversations"}
                </Button>
              )}
            </aside>

            <main className="message-pane">
              {composeOpen ? (
                <><div className="message-header"><button className="mobile-back" onClick={() => { setComposeOpen(false); setSelected(null); }}>←</button><div><h2>New message</h2><p>Choose a contact or enter a phone number</p></div></div>
                  <div className="recipient-picker">
                    <label className="search-box"><span aria-hidden="true">⌕</span><input autoFocus value={recipientSearch} onChange={event => setRecipientSearch(event.target.value)} placeholder="Search contacts or type a number" aria-label="Recipient" /></label>
                    {/^\+?[0-9\s()-]{3,}$/.test(recipientSearch.trim()) && <button className="recipient-row" onClick={() => selectRecipient(recipientSearch.replace(/[^+0-9]/g, ""))}>Send to {recipientSearch.trim()}</button>}
                    <div className="recipient-results">{recipientMatches.map(contact => <button key={contact.normalizedPhone} className="recipient-row" onClick={() => selectRecipient(contact.normalizedPhone)}><Avatar title={contact.displayName} /><span><strong>{contact.displayName}</strong><small>{contact.normalizedPhone}</small></span><span aria-hidden="true">✉</span></button>)}</div>
                  </div></>
              ) : selectedConversation ? (
                <>
                  <div className="message-header"><button className="mobile-back" onClick={() => { setSelected(null); setComposeRecipient(""); }}>←</button><Avatar title={selectedConversation.title} /><div><h2>{selectedConversation.title}</h2><p>{selectedConversation.subtitle ? `${selectedConversation.subtitle} · ` : ""}Synced from Android · {shortId(selectedConversation.aggregateId)}</p></div></div>
                  {threadHasMore && (
                    <Button size="sm" variant="ghost" className="load-older-thread" onPress={() => void loadOlderThread()} isDisabled={loadingOlderThread}>
                      {loadingOlderThread ? "Loading…" : "Load older messages"}
                    </Button>
                  )}
                  {historyError && <div role="alert" className="history-error">{historyError} <Button size="sm" onPress={() => void loadOlderThread()}>Retry</Button></div>}
                  <div ref={messageScrollRef} className="message-scroll" onScroll={(event) => {
                    if (threadHasMore && !loadingOlderThread && event.currentTarget.scrollTop < 80) void loadOlderThread();
                  }}>
                    <div className="message-day"><span>Message history</span></div>
                    <div style={{ height: messageVirtualizer.getTotalSize(), position: "relative" }}>
                      {messageVirtualizer.getVirtualItems().map(virtualRow => {
                        const { payload } = messages[virtualRow.index];
                        return <div key={payload.messageId} ref={messageVirtualizer.measureElement} data-index={virtualRow.index}
                          style={{ position: "absolute", width: "100%", transform: "translateY(" + virtualRow.start + "px)" }}
                          className={`message-line ${payload.direction}`}>
                            <div className="message-bubble"><p dir="auto">{payload.body}</p><span>{formatTime(payload.dateMs)}{payload.direction === "out" ? ` · ${messageStatus(payload.status)}` : ""}</span></div>
                          </div>;
                      })}
                    </div>
                    {pendingMessage && (
                      <div className="message-line out">
                        <div className="message-bubble"><p dir="auto">{pendingMessage.body}</p><span>{formatTime(pendingMessage.at)} · {commandStatus || "queued"}</span></div>
                      </div>
                    )}
                    {threadState === "LOADING" && <div className="empty-conversation"><Spinner /><h3>Loading messages…</h3></div>}
                    {threadState === "LOCKED" && <div className="empty-conversation"><div className="empty-icon">↻</div><h3>Messages are encrypted</h3><p>The browser is waiting for an authorized key.</p></div>}
                    {threadState === "EMPTY" && <div className="empty-conversation"><div className="empty-icon">✦</div><h3>No messages in this conversation.</h3></div>}
                    {threadState === "FAILED" && <div className="empty-conversation"><div className="empty-icon">!</div><h3>Unable to load messages</h3><p>{threadError || "Thread page read failed"}</p><Button size="sm" onPress={() => setThreadReload(value => value + 1)}>Retry</Button></div>}
                  </div>
                  <div className="composer-disabled">
                    <input dir="auto" value={draft} onChange={event => setDraft(event.target.value)} placeholder={selectedRecipient ? "Text message" : "Choose a contact"} />
                    <span className="sms-segments">{smsSegments.encoding} · {smsSegments.units} units · {smsSegments.segments} SMS · {smsSegments.remaining} left</span>
                    {showSimSelector ? <select className="sim-select" aria-label="Send using SIM" value={chosenSim?.subscriptionId ?? ""} onChange={event => chooseSim(Number(event.target.value))}><option value="" disabled>Choose SIM</option>{activeSims.map(sim => <option key={sim.subscriptionId} value={sim.subscriptionId}>SIM {sim.slotIndex + 1} · {sim.displayName || sim.carrierName}</option>)}</select> : activeSims.length === 1 ? <span className="sim-label">SIM {activeSims[0].slotIndex + 1} · {activeSims[0].displayName || activeSims[0].carrierName}</span> : <span className="sim-label">{telemetry?.smsSubscriptions ? "No active SMS SIM available" : "SIM information unavailable"} <button onClick={refreshTelemetry}>Retry</button></span>}
                    <Button size="sm" onPress={() => void send()} isDisabled={recoveringSend.current}>Send</Button>
                    {commandStatus && <Chip size="sm" variant="soft">{commandStatus}</Chip>}
                  </div>
                </>
              ) : (
                <><div className="message-header"><button className="mobile-back" onClick={() => { setComposeRecipient(""); setSelected(null); }}>←</button><div><h2>{composeRecipient ? contactNames.get(composeRecipient) || composeRecipient : "New message"}</h2><p>{composeRecipient || "Choose a conversation or contact."}</p></div></div><div className="empty-conversation"><div className="empty-icon">✦</div><h3>{composeRecipient ? "Start a conversation" : "Choose a conversation or compose a message"}</h3></div>{composeRecipient && <div className="composer-disabled"><input dir="auto" value={draft} onChange={event => setDraft(event.target.value)} placeholder="Text message" /><span className="sms-segments">{smsSegments.encoding} · {smsSegments.units} units · {smsSegments.segments} SMS · {smsSegments.remaining} left</span>{showSimSelector ? <select className="sim-select" aria-label="Send using SIM" value={chosenSim?.subscriptionId ?? ""} onChange={event => chooseSim(Number(event.target.value))}><option value="" disabled>Choose SIM</option>{activeSims.map(sim => <option key={sim.subscriptionId} value={sim.subscriptionId}>SIM {sim.slotIndex + 1} · {sim.displayName || sim.carrierName}</option>)}</select> : activeSims.length === 1 ? <span className="sim-label">SIM {activeSims[0].slotIndex + 1} · {activeSims[0].displayName || activeSims[0].carrierName}</span> : <span className="sim-label">{telemetry?.smsSubscriptions ? "No active SMS SIM available" : "SIM information unavailable"} <button onClick={refreshTelemetry}>Retry</button></span>}<Button size="sm" onPress={() => void send()} isDisabled={recoveringSend.current}>Send</Button>{commandStatus && <Chip size="sm" variant="soft">{commandStatus}</Chip>}</div>}</>
              )}
            </main>
          </div>
        </TabPanel>

        <TabPanel id="contacts" className="content-panel" onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollHeight - element.scrollTop - element.clientHeight < 240)
            setVisibleContactCount(count => Math.min(count + 100, filteredContacts.length));
        }}>
          <div className="page-title"><p className="eyebrow">Phone book</p><h1>Contacts</h1><p>End-to-end encrypted contacts synced from the Primary Android device.</p></div>
          <div className="contact-sync-status" role="status">
            <span>{contactsBusy ? `Syncing encrypted contacts… ${contactsProgress} event(s) checked`
              : contactsError ? contactsError : `${contacts.length} contacts ready${contactsCheckedAt ? ` · checked ${formatTime(contactsCheckedAt)}` : ""}`}</span>
            <Button size="sm" variant="ghost" onPress={() => void refreshContacts()} isDisabled={contactsBusy}>
              {contactsBusy ? <Spinner size="sm" /> : "Sync contacts"}
            </Button>
          </div>
          <label className="search-box"><span aria-hidden="true">⌕</span><input value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="Search names or numbers" aria-label="Search contacts" /></label>
          <div className="contact-list">
            {filteredContacts.slice(0, visibleContactCount).map(contact => (
              <button className="contact-row" key={contact.normalizedPhone} type="button" onClick={() => selectRecipient(contact.normalizedPhone)}><Avatar title={contact.displayName} /><span className="contact-copy"><strong>{contact.displayName}</strong><small>{contact.normalizedPhone}</small></span>{contact.starred && <span title="Starred">★</span>}<span className="contact-sms" aria-label="Send SMS" title="Send SMS">✉</span></button>
            ))}
            {filteredContacts.length > visibleContactCount && <Button size="sm" variant="ghost"
              onPress={() => setVisibleContactCount(count => count + 100)}>Load more contacts</Button>}
            {filteredContacts.length === 0 && <div className="empty-list"><span>✦</span><p>{contacts.length
              ? "No matching contacts"
              : !capabilities.includes("CONTACTS_READ")
                ? "Contacts access was not approved for this linked browser. Re-link or re-approve this browser."
                : "No contacts are available yet; phone sync or a contact key grant may be pending."}</p></div>}
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
            <Card><CardContent className="security-row"><div><strong>Message encryption</strong><p>{threadEvents.filter(event => event.decryption?.state === "decrypted").length} open-thread decrypted · {threadEvents.filter(event => event.decryption?.state === "locked").length} open-thread locked · {threadEvents.filter(event => event.decryption?.state === "invalid").length} open-thread invalid</p><p>Messages load when a conversation is opened. Key grants come from your primary phone.</p></div></CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Passkeys</strong><p>Manage dashboard passkeys in the GMweb dashboard.</p></div></CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Android trust registry</strong><p>{trust ? `Verified root published at sequence ${trust.trustSequence}` : "Waiting for the primary phone's first signed trust statement"}</p></div><Chip size="sm" variant="soft">{trust ? "Ready" : "Pending"}</Chip></CardContent></Card>
            <Card><CardContent className="security-row"><div><strong>Private push</strong><p>Notifications contain no sender or message text.</p></div></CardContent></Card>
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
            <Card><CardContent className="status-card"><span>Browser Sync</span><strong>{webDiagnostics.browserSync.state === "UP_TO_DATE" ? "PASS" : webDiagnostics.browserSync.state === "FAILED" ? "FAIL" : webDiagnostics.browserSync.state === "DEGRADED" ? "WARN" : "SYNCING"}</strong><small>{webDiagnostics.replicaProgress?.lazyMode ? `on-demand · observed sequence ${webDiagnostics.browserSync.cursor}` : `cursor ${webDiagnostics.browserSync.cursor} · lag ${webDiagnostics.browserSync.syncLag ?? "unknown"} · snapshot ${webDiagnostics.replicaProgress?.snapshotComplete ? "complete" : `loading ${webDiagnostics.replicaProgress?.snapshotPosition ?? 0} rows / ${webDiagnostics.replicaProgress?.snapshotPageCount ?? 0} pages`}`} · keyring {webDiagnostics.replicaProgress?.keyringCursor ?? "unknown"} · grants {webDiagnostics.replicaProgress?.grantCursor ?? "unknown"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Encryption keys</span><strong>{webDiagnostics.browserSync.keyState}</strong><small>{webDiagnostics.browserSync.keyError || `Last successful refresh ${webDiagnostics.browserSync.lastKeySyncAt ? formatTime(webDiagnostics.browserSync.lastKeySyncAt) : "pending"}`}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Live updates</span><strong>{webDiagnostics.liveSync.connection}</strong><small>{webDiagnostics.liveSync.reconnectCount} reconnects · last frame {webDiagnostics.liveSync.lastFrameAt ? formatTime(webDiagnostics.liveSync.lastFrameAt) : "none"} · server → render {webDiagnostics.liveSync.serverPublishedAt && webDiagnostics.liveSync.browserRenderedAt ? `${Math.max(0, webDiagnostics.liveSync.browserRenderedAt - webDiagnostics.liveSync.serverPublishedAt)} ms` : "not measured"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>IndexedDB</span><strong>PASS</strong><small>{webDiagnostics.indexedDb.total} raw events · {webDiagnostics.indexedDb.distinctMessageAggregateCount} message aggregates</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Crypto</span><strong>{webDiagnostics.crypto.messages.invalid || webDiagnostics.crypto.keyGrants.invalid ? "FAIL" : webDiagnostics.crypto.messages.locked ? "WARN" : "PASS"}</strong><small>{webDiagnostics.crypto.messages.decrypted} decrypted · {webDiagnostics.crypto.messages.locked} locked · {webDiagnostics.crypto.messages.invalid} invalid<br />Grant probe: {webDiagnostics.crypto.keyGrants.accepted} accepted · {Object.keys(webDiagnostics.crypto.keyGrants.reasons).join(", ") || "no rejection"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Projection</span><strong>{webDiagnostics.projection.failure ? "FAIL" : webDiagnostics.projection.lag ? "SYNCING" : "PASS"}</strong><small>{webDiagnostics.projection.failure || `${webDiagnostics.projection.rows} rows`} · cursor {webDiagnostics.projection.cursor} · lag {webDiagnostics.projection.lag}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Contacts</span><strong>{webDiagnostics.contacts.failure ? "WARN" : "PASS"}</strong><small>{webDiagnostics.contacts.failure || `${webDiagnostics.contacts.stored} rows`} · {webDiagnostics.contacts.grants} grants · {webDiagnostics.contacts.snapshots} snapshots</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Selected Thread</span><strong>{!webDiagnostics.selectedThread ? "PASS" : webDiagnostics.selectedThread.state === "FAILED" ? "FAIL" : webDiagnostics.selectedThread.state === "LOADING" ? "SYNCING" : webDiagnostics.selectedThread.state === "LOCKED" ? "WARN" : "PASS"}</strong><small>{webDiagnostics.selectedThread ? `${webDiagnostics.selectedThread.state} · ${webDiagnostics.selectedThread.decrypted} decrypted · ${webDiagnostics.selectedThread.locked} locked` : "Select a conversation"}</small></CardContent></Card>
            <Card><CardContent className="status-card"><span>Build / Service Worker</span><strong>{webDiagnostics.session.buildMismatch ? "BUILD_MISMATCH" : "PASS"}</strong><small>{webDiagnostics.session.pwaVersion} · loaded {webDiagnostics.session.loadedScript} · served {webDiagnostics.session.servedScript ?? "unknown"} · revision {webDiagnostics.session.buildRevision ?? "unknown"} · {webDiagnostics.session.serviceWorker}</small></CardContent></Card>
          </div>}
          {webDiagnostics && <div className={`notice ${webDiagnostics.overall === "FAIL" ? "danger" : ""}`}>Overall: {webDiagnostics.overall}</div>}
        </TabPanel>
      </Tabs>
    </div>
  );
}
