import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, useMediaQuery } from "@heroui/react";
import { syncVisibleInbox, loadContactsOnDemand, listRecentEvents, listAggregateEventsPage, listContacts, listConversations, listChangedConversationHeads, getCursor, getBrowserSyncStatus, resetLocal, subscribeSyncAvailable, subscribeKeyMaintenance, type BrowserSyncStatus, type StoredContact, type StoredEvent } from "../lib/sync";
import { messagesForAggregate, reconcileConversationHead, type ConversationProjection } from "../lib/inbox";
import { createCommand, fetchCommand, fetchLinkedSessions, fetchPrimaryCommandKey, fetchPrimaryTelemetry, fetchTrustSnapshot, health, type DeviceTelemetry, type LinkedBrowserSession, type TrustSnapshot } from "../lib/api";
import { encryptCommand } from "../lib/commandCrypto";
import { getStoredDeviceIdentity, wipeDeviceKeys } from "../lib/deviceKeys";
import { clearPendingSend, loadPendingSends, savePendingSend, type PendingEncryptedSend } from "../lib/commandOutbox";
import { completeLinkedSession } from "../lib/pairing";
import { PairingScreen } from "../screens/PairingScreen";
import { PWA_BUILD_VERSION, loadedScriptFile } from "../lib/buildInfo";
import { collectWebDiagnostics, type WebDiagnosticReport } from "../lib/diagnostics";
import { MessageComposer } from "./MessageComposer";
import { applyReadConfirmation, contactTitle, phoneKey, simHelp } from "../lib/inboxActions";
import { markBrowserProjected, markBrowserRendered } from "../lib/sync/live-invalidation";
import { mergeThreadEvents, assertHistoryProgress } from "../lib/threadHistory";
import {
  EMPTY_HISTORY_TRACE, IDLE_HISTORY, canLoadOlder, describeHistory, historyErrorMessage,
  isValidCursor, pagingFailed, pagingFromPage, pagingLoading, showLoadOlder,
  type HistoryPagingState, type HistoryTrace,
} from "../lib/threadPaging";
import { selectSmsSim } from "../lib/simSelection";
import { derivePhonePresence } from "../lib/phonePresence";
import { describeSimTelemetry, classifySimRefresh, simRefreshMessage, type SimRefreshResult } from "../lib/simTelemetry";
import {
  IDLE_READ, readFailureCode, readStateKey, readSyncLabel, readSyncRetryable, readSyncTone,
  shouldAutoRead, type ReadSyncState,
} from "../lib/readSync";
import { androidError } from "../../../shared/smsStatus";

import { AppShell } from "./components/AppShell";
import { AppSidebar } from "./components/AppSidebar";
import { AppTopbar } from "./components/AppTopbar";
import { MobileBottomNav } from "./components/MobileBottomNav";
import { ConversationPane } from "./components/ConversationPane";
import { ConversationDetails } from "./components/ConversationDetails";
import { ConversationDetailsDrawer } from "./components/ConversationDetailsDrawer";
import { DeliveryDetailsDrawer } from "./components/DeliveryDetailsDrawer";
import { LinkedBrowsersDrawer } from "./components/LinkedBrowsersDrawer";
import { NewMessageView } from "./components/NewMessageView";
import { ThreadHeader } from "./components/ThreadHeader";
import { ThreadPane } from "./components/ThreadPane";
import { ThreadPlaceholder } from "./components/ThreadEmptyState";
import { SyncAlerts } from "./components/SyncAlerts";
import { DESTINATION_TITLES } from "./components/destinations";
import { withDaySeparators } from "./components/format";
import type { ConnectionState, ConversationFilter, ThreadItem, ThreadState } from "./components/types";
import { ContactsView } from "./views/ContactsView";
import { DeviceView } from "./views/DeviceView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { SecurityView } from "./views/SecurityView";
import { SettingsView } from "./views/SettingsView";

type TabKey = "inbox" | "contacts" | "connection" | "security" | "debug" | "settings";

/** Existing projection status mapping — unchanged (§15/§23). */
function messageStatus(status: number): string {
  if (status === 64) return "failed";
  if (status === 32) return "queued";
  if (status === 0) return "delivered";
  return "sent";
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
  // History paging is ONE value so `hasMore` and its cursor can never drift
  // apart (see lib/threadPaging.ts for the invariant).
  const [history, setHistory] = useState<HistoryPagingState>(IDLE_HISTORY);
  const historyTrace = useRef<HistoryTrace>(EMPTY_HISTORY_TRACE);
  const historyLoadingRef = useRef(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<TrustSnapshot | null>(null);
  const [version, setVersion] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [browserDeviceId, setBrowserDeviceId] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [readSync, setReadSync] = useState<ReadSyncState>(IDLE_READ);
  const [readRetry, setReadRetry] = useState(0);
  const [readConfirmations, setReadConfirmations] = useState<Record<string, number>>({});
  const [viewedReadThrough, setViewedReadThrough] = useState<Record<string, number>>({});
  const [pageVisible, setPageVisible] = useState(document.visibilityState === "visible");
  const [bootstrapState, setBootstrapState] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<BrowserSyncStatus>(getBrowserSyncStatus());
  const [threadState, setThreadState] = useState<ThreadState>("IDLE");
  const [readyThreadId, setReadyThreadId] = useState<string | null>(null);
  const [threadFirstPageMs, setThreadFirstPageMs] = useState<number | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadReload, setThreadReload] = useState(0);
  const [webDiagnostics, setWebDiagnostics] = useState<WebDiagnosticReport | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>("all");
  const [composeOpen, setComposeOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [telemetry, setTelemetry] = useState<DeviceTelemetry | null>(null);
  const [linkedBrowsers, setLinkedBrowsers] = useState<LinkedBrowserSession[]>([]);
  const [showLinkedBrowsers, setShowLinkedBrowsers] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [deliveryItem, setDeliveryItem] = useState<ThreadItem | null>(null);
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
  const [sending, setSending] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<{ clientMessageId: string; body: string; recipient: string; at: number; failure?: string } | null>(null);
  const sendEvidence = useRef<{ clientMessageId: string; status: string } | null>(null);
  const observedSendStatus = (id: string) => sendEvidence.current?.clientMessageId === id ? sendEvidence.current.status : null;
  // Keyed by `conversationId:readThroughSequence`: at most ONE live
  // MARK_THREAD_READ observation per read-through, so switching threads
  // rapidly cannot produce a command storm.
  const readInFlight = useRef(new Set<string>());
  const contactsLoading = useRef(false);
  const lastThreadSelection = useRef<string | null>(null);
  const recoveringSend = useRef(false);
  const loadingOlderRef = useRef(false);
  const hasLoadedOlderConversations = useRef(false);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const conversationSearchRef = useRef<HTMLInputElement>(null);
  const scriptFile = useMemo(() => loadedScriptFile(), []);

  // Layout capability only. Visual breakpoints live in CSS (§38) so the shell
  // never depends on a JS breakpoint for correctness.
  const isWideViewport = useMediaQuery("(min-width: 768px)", { defaultValue: true });

  const [simRefresh, setSimRefresh] = useState<SimRefreshResult>({ outcome: "IDLE", message: null });

  const refreshTelemetry = () => void fetchPrimaryTelemetry().then(value => {
    setTelemetry(value);
  }).catch(() => setTelemetry(null));

  /**
   * §20: user-initiated SIM refresh. Compares the phone's report timestamp
   * before and after, and reports "nothing newer" rather than a fake success.
   */
  const refreshSims = async () => {
    const previousReceivedAt = telemetry?.receivedAt ?? null;
    setSimRefresh(simRefreshMessage("CHECKING"));
    try {
      const next = await fetchPrimaryTelemetry();
      setTelemetry(next);
      const presence = derivePhonePresence(next?.receivedAt ?? null);
      const outcome = classifySimRefresh({
        previousReceivedAt, nextReceivedAt: next?.receivedAt ?? null, presence,
      });
      setSimRefresh(simRefreshMessage(outcome));
    } catch {
      setSimRefresh(simRefreshMessage("FAILED"));
    }
  };

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
    if (contactsLoading.current || !capabilities.includes("CONTACTS_READ")) return;
    contactsLoading.current = true;
    setContactsBusy(true);
    setContactsError(null);
    setContactsProgress(0);
    try {
      await loadContactsOnDemand(setContactsProgress);
      setContacts(await listContacts());
      setContactsCheckedAt(Date.now());
    } catch (cause) {
      setContactsError(cause instanceof Error ? cause.message : String(cause));
    } finally { contactsLoading.current = false; setContactsBusy(false); }
  };

  useEffect(() => {
    void health().then((value) => setVersion(value.version)).catch(() => setVersion("unreachable"));
    void fetch("/api/v1/linked-session", { credentials: "include" })
      .then((response) => response.json())
      .then((session) => { setAuthed(session.authenticated === true); setCapabilities(session.capabilities || []); setBrowserDeviceId(session.deviceId || null); })
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
      void refreshContacts();
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
      void refreshContacts();
    });
    return () => { window.clearInterval(telemetryTimer); window.clearInterval(linkedBrowsersTimer); window.clearInterval(visibleTimer); unsubscribe(); unsubscribeKeys(); };
  }, [authed]);

  useEffect(() => {
    if (!authed || !capabilities.includes("CONTACTS_READ")) return;
    void refreshContacts();
  }, [authed, capabilities, tab]);

  useEffect(() => {
    const visible = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);

  // §31: Ctrl/Cmd+K focuses conversation search. Never hijacks a text field,
  // textarea, select or contenteditable region.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if (tab !== "inbox") return;
      event.preventDefault();
      conversationSearchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab]);

  const contactNames = useMemo(() => new Map(contacts.map(contact => [phoneKey(contact.normalizedPhone), contact.displayName])), [contacts]);
  const conversations = useMemo(() => reconcileConversationHead(conversationPage, selected,
    selected ? messagesForAggregate(threadEvents, selected).at(-1) : undefined)
      .map(row => contactTitle(applyReadConfirmation(row, Math.max(readConfirmations[row.aggregateId] ?? -1,
        viewedReadThrough[row.aggregateId] ?? -1)), contactNames)),
    [conversationPage, selected, threadEvents, contactNames, readConfirmations, viewedReadThrough]);
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
  const unreadTotal = useMemo(() => conversations.reduce((sum, item) => sum + item.unreadCount, 0), [conversations]);
  const filteredConversations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const base = conversationFilter === "unread"
      ? conversations.filter(item => item.unreadCount > 0)
      : conversations;
    if (!query) return base;
    return base.filter((item) => `${item.title}\n${item.preview}`.toLocaleLowerCase().includes(query));
  }, [conversations, search, conversationFilter]);

  useEffect(() => {
    if (isWideViewport && !selected && !composeRecipient && !composeOpen && conversations[0]) setSelected(conversations[0].aggregateId);
  }, [conversations, selected, composeRecipient, composeOpen, isWideViewport]);

  const selectedConversation = conversations.find((item) => item.aggregateId === selected) ||
    (selectedConversationCache?.aggregateId === selected ? contactTitle(selectedConversationCache, contactNames) : null);
  const rawSelectedConversation = conversationPage.find(row => row.aggregateId === selected) ||
    (selectedConversationCache?.aggregateId === selected ? selectedConversationCache : null);
  const needsPhoneRead = Boolean(selectedConversation && rawSelectedConversation && !rawSelectedConversation.read &&
    (readConfirmations[selectedConversation.aggregateId] ?? -1) < selectedConversation.lastSequence);
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
    if (lastThreadSelection.current !== selected) {
      setHistory(IDLE_HISTORY);
      historyTrace.current = EMPTY_HISTORY_TRACE;
    }
    if (!selected || !authed) {
      lastThreadSelection.current = null;
      setThreadEvents([]);
      setHistory(IDLE_HISTORY);
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
      setReadyThreadId(selected);
      setThreadFirstPageMs(Math.round(performance.now() - startedAt));
      if (sameThread && !stickToBottom) {
        // Merging newer arrivals must NOT rewind the user's deep history
        // cursor, but the invariant still has to hold afterwards.
        setThreadEvents(previous => mergeThreadEvents(previous, page.items));
        setHistory(previous => (!previous.hasMore || isValidCursor(previous.next)
          ? previous
          : pagingFromPage({ hasMore: false })));
      } else {
        setThreadEvents(page.items);
        // One atomic derivation for the whole (hasMore, next) pair.
        setHistory(pagingFromPage(page));
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
    const cursor = history.next;
    // Guarded by the same predicate that gates rendering: if this is true the
    // control was rendered, so a silent no-op is impossible by construction.
    if (!selected || !canLoadOlder(history, threadState) || !isValidCursor(cursor) ||
        historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setHistory(pagingLoading);
    try {
      const requestedCursor = cursor;
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
      historyTrace.current = {
        lastRequestAt: Date.now(),
        lastReturnedCount: page.items.length,
        lastNextCursorChanged: page.next !== requestedCursor,
      };
      setHistory(pagingFromPage(page));
    } catch (cause) {
      historyTrace.current = {
        ...historyTrace.current, lastRequestAt: Date.now(), lastReturnedCount: 0, lastNextCursorChanged: false,
      };
      setHistory(previous => pagingFailed(previous, cause instanceof Error ? cause.message : "HISTORY_PAGE_FAILED"));
    } finally { historyLoadingRef.current = false; }
  };
  const messages = useMemo(() => selected ? messagesForAggregate(threadEvents, selected) : [], [threadEvents, selected]);
  const selectedRecipient = composeRecipient || messages.map(item => item.payload.address).find(Boolean);
  const activeSims = telemetry?.smsSubscriptions?.items.filter(sim => sim.isActive && sim.sendCapable !== false) ?? [];
  const chosenSim = selectSmsSim(activeSims, selectedSubscriptionId);
  const simInstructions = simHelp(telemetry, Boolean(chosenSim));
  const simAvailable = !simInstructions;
  const chooseSim = (id: number | null) => {
    setSelectedSubscriptionId(id);
    if (id === null) window.localStorage.removeItem("gmweb:selected-sms-subscription");
    else window.localStorage.setItem("gmweb:selected-sms-subscription", String(id));
  };

  useEffect(() => {
    const clientId = pendingMessage?.clientMessageId || sendEvidence.current?.clientMessageId;
    const matched = clientId && messages.find(item => item.payload.clientMessageId === clientId);
    if (matched) {
      sendEvidence.current = { clientMessageId: clientId, status: messageStatus(matched.payload.status) };
      setCommandStatus(sendEvidence.current.status);
      if (pendingMessage) setPendingMessage(null);
    }
  }, [messages, pendingMessage]);

  const submitCommand = async (type: "SEND_SMS" | "MARK_THREAD_READ", payload: Record<string, unknown>) => {
    const idempotencyKey = crypto.randomUUID();
    const target = await fetchPrimaryCommandKey();
    const encrypted = await encryptCommand(target.encryptionPublicKey, type, idempotencyKey, { type, ...payload });
    return createCommand({ type, payload: encrypted, idempotencyKey, targetAgentId: target.deviceId });
  };

  // §12.1: opening an unread conversation clears the Web unread UI FIRST, then
  // the phone is asked to confirm in the background.
  useEffect(() => {
    if (!selectedConversation) { setReadSync(IDLE_READ); return; }
    const { aggregateId, lastSequence } = selectedConversation;
    const confirmedSequence = Math.max(
      readConfirmations[aggregateId] ?? -1,
      viewedReadThrough[aggregateId] ?? -1,
    );
    const key = readStateKey(aggregateId, lastSequence);
    const auto = shouldAutoRead({
      tabActive: tab === "inbox",
      hasSelection: Boolean(selected),
      threadReady: threadState === "READY",
      readyThreadIdMatches: readyThreadId === selected,
      documentVisible: pageVisible,
      canMarkRead: capabilities.includes("MARK_READ"),
      lastSequence,
      confirmedSequence,
      alreadyInFlight: readInFlight.current.has(key),
    });
    if (!auto) {
      // Already read (locally or confirmed) -> reflect the authoritative state
      // instead of leaving a stale "syncing" label behind.
      if (lastSequence <= confirmedSequence && !readInFlight.current.has(key)) {
        setReadSync({ state: "CONFIRMED", sequence: lastSequence });
      }
      return;
    }

    // Optimistic local read-through happens BEFORE any network work, so the
    // badge, the row styling and the global unread total clear immediately.
    setViewedReadThrough(previous => ({
      ...previous, [aggregateId]: Math.max(previous[aggregateId] ?? -1, lastSequence),
    }));
    readInFlight.current.add(key);
    setReadSync({ state: "SYNCING", sequence: lastSequence, commandId: null });

    void (async () => {
      let commandId: string | null = null;
      try {
        const command = await submitCommand("MARK_THREAD_READ", { conversationId: aggregateId });
        commandId = command.commandId;
        // Durable on the server: from here on the phone owns confirmation.
        setReadSync({ state: "WAITING_FOR_PHONE", sequence: lastSequence, commandId: command.commandId });
        for (let i = 0; i < 30; i++) {
          await new Promise(resolve => window.setTimeout(resolve, 1000));
          const view = await fetchCommand(command.commandId);
          if (view?.state === "COMPLETED") {
            setReadConfirmations(previous => ({
              ...previous, [aggregateId]: Math.max(previous[aggregateId] ?? -1, lastSequence),
            }));
            readInFlight.current.delete(key);
            setReadSync({ state: "CONFIRMED", sequence: lastSequence });
            return;
          }
          if (view && ["FAILED", "EXPIRED"].includes(view.state)) throw new Error(view.result || view.state);
        }
        throw new Error("read_pending");
      } catch (cause) {
        readInFlight.current.delete(key);
        setReadSync({
          state: "FAILED", sequence: lastSequence,
          errorCode: readFailureCode(cause), commandId,
        });
      }
    })();
  }, [selected, selectedConversation?.lastSequence, needsPhoneRead, readyThreadId, threadState,
      tab, capabilities, readRetry, pageVisible]);

  const signOut = async () => {
    setSigningOut(true);
    try {
      const response = await fetch("/api/v1/linked-session", { method: "DELETE", credentials: "include" });
      if (!response.ok && response.status !== 401) throw new Error("Could not unlink this browser. Check your connection and retry.");
      setAuthed(false);
      await resetLocal();
      await wipeDeviceKeys();
      window.localStorage.removeItem("gmweb:selected-sms-subscription");
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign out failed. Retry."); }
    finally { setSigningOut(false); }
  };

  const send = async () => {
    const body = draft;
    if (!body.trim()) { setCommandStatus("EMPTY_BODY"); return; }
    if (!selectedRecipient) { setCommandStatus("NO_RECIPIENT"); return; }
    if (!capabilities.includes("SEND_MESSAGES")) { setCommandStatus("SEND_CAPABILITY_MISSING"); return; }
    if (!simAvailable) { setCommandStatus(!telemetry?.smsSubscriptions ? "SIM_STATE_UNAVAILABLE" : "SELECTED_SIM_UNAVAILABLE"); return; }
    if (recoveringSend.current || sending) return;
    recoveringSend.current = true;
    setSending(true);
    const clientMessageId = commandStatus !== "COMPLETED" && !commandStatus?.startsWith("Command completed") &&
      pendingMessage?.body === body && !pendingMessage.failure && pendingMessage.recipient === selectedRecipient
      ? pendingMessage.clientMessageId : crypto.randomUUID();
    setCommandStatus("Preparing send…");
    sendEvidence.current = null;
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
      if (!existing) setDraft(current => current === body ? "" : current);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        failureCode = "COMMAND_POLL_FAILED";
        const state = await fetchCommand(commandId);
        setCommandStatus(observedSendStatus(clientMessageId) || (state?.state === "COMPLETED" ? "Command completed; waiting for Android evidence" :
          state?.state === "FAILED" ? (state.result || "COMMAND_FAILED") : state?.state === "EXPIRED" ? "COMMAND_EXPIRED" :
    state?.state === "DELIVERED_TO_AGENT" ? "Pulled by phone" : ["ACCEPTED_BY_AGENT", "EXECUTING"].includes(state?.state || "") ? "Submitting" : "Queued"));
        if (state && ["FAILED", "EXPIRED"].includes(state.state)) {
          if (!existing) setDraft(body);
          setPendingMessage(current => current?.clientMessageId === clientMessageId ? { ...current,
            failure: state.state === "FAILED" ? `Failed · ${androidError(state.result || "Phone did not report a reason")}` : "Request expired; phone outcome unconfirmed" } : current);
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
      setCommandStatus(observedSendStatus(clientMessageId) || failureCode);
    } finally {
      recoveringSend.current = false;
      setSending(false);
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
          setCommandStatus(observedSendStatus(pending.clientMessageId) || (state?.state === "COMPLETED" ? "Command completed; waiting for Android evidence" :
            state?.state === "FAILED" ? (state.result || "COMMAND_FAILED") : state?.state === "EXPIRED" ? "COMMAND_EXPIRED" :
    state?.state === "DELIVERED_TO_AGENT" ? "Pulled by phone" : ["ACCEPTED_BY_AGENT", "EXECUTING"].includes(state?.state || "") ? "Submitting" : "Queued"));
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
        lastPageError: history.error || threadError,
        // §32: enough to tell "no deeper history on the phone" apart from
        // "the client lost its cursor" in the field.
        history: describeHistory(history, historyTrace.current),
      } : undefined, {
        phonePresence,
        phoneTelemetryAgeMs: telemetry?.receivedAt == null ? null : Math.max(0, Date.now() - telemetry.receivedAt),
        simState: simTelemetry.state,
        simActiveCount: simTelemetry.active.length,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  /* ------------------------------------------------------------ view model */

  const connection: ConnectionState = !online
    ? "offline"
    : version === "unreachable"
      ? "unreachable"
      : version
        ? "connected"
        : "checking";
  const connectionDetail = `GMweb API ${version || "checking"} · browser ${online ? "online" : "offline"}`;

  const threadItems = useMemo<ThreadItem[]>(() => {
    const items: ThreadItem[] = messages.map(item => ({
      key: item.payload.messageId || item.event.eventId,
      direction: item.payload.direction,
      body: item.payload.body,
      dateMs: item.payload.dateMs,
      status: item.payload.status,
      clientMessageId: item.payload.clientMessageId ?? null,
    }));
    if (pendingMessage && pendingMessage.recipient === selectedRecipient) {
      items.push({
        key: `pending-${pendingMessage.clientMessageId}`,
        direction: "out",
        body: pendingMessage.body,
        dateMs: pendingMessage.at,
        pending: true,
        failure: pendingMessage.failure ?? null,
        progress: commandStatus,
        clientMessageId: pendingMessage.clientMessageId,
      });
    }
    return items;
  }, [messages, pendingMessage, selectedRecipient, commandStatus]);

  const threadRows = useMemo(() => withDaySeparators(threadItems), [threadItems]);

  const lastOutgoing = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].payload.direction === "out") {
        return { status: messages[index].payload.status, at: messages[index].payload.dateMs };
      }
    }
    return { status: null, at: null };
  }, [messages]);

  const payloadState = events.some(event => event.decryption?.state === "decrypted")
    ? "E2EE locally decrypted"
    : events.length
      ? "See payload diagnostics"
      : "No payloads received";

  // §8: presence is derived from the phone's SERVER receipt time, never from
  // the browser being able to reach the API. These are independent facts.
  const phonePresence = derivePhonePresence(telemetry?.receivedAt ?? null);
  const simTelemetry = describeSimTelemetry(telemetry, Date.now(), phonePresence);

  const conversationsLoading = conversationPage.length === 0 && bootstrapState === "BOOTSTRAPPING_SYNC";
  const emptyInboxMessage = conversations.length === 0 ? "No conversations yet" : "No matching conversations";
  const mobileView = selected || composeOpen || composeRecipient ? "thread" : "list";
  // §6/§40: the bottom navigation is only dropped on a TRUE phone-sized
  // viewport, where the full-screen thread genuinely needs the room. On a
  // tablet the list and thread are side by side and navigation stays.
  const hideBottomNav = !isWideViewport && tab === "inbox" && mobileView === "thread";
  const destination = DESTINATION_TITLES[tab];
  const linkedOnlineCount = linkedBrowsers.filter(row => row.onlineNow).length;

  const navigate = (key: TabKey) => setTab(key);

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
          setCapabilities(session.capabilities || []);
          setBrowserDeviceId(session.deviceId || null);
          setAuthed(true);
        }}
        onRecoveryLinked={async () => {
          const probe = await fetch("/api/v1/linked-session", { credentials: "include" });
          const session = await probe.json().catch(() => ({}));
          if (!probe.ok || session.authenticated !== true) throw new Error("Restricted PWA session cookie was not established");
          setCapabilities(session.capabilities || []);
          setBrowserDeviceId(session.deviceId || null);
          setAuthed(true);
        }}
      />
    );
  }

  /* --------------------------------------------------------------- actions */

  const openConversation = (conversation: ConversationProjection) => {
    setComposeOpen(false);
    setComposeRecipient("");
    setSelected(conversation.aggregateId);
    setSelectedConversationCache(conversation);
  };

  const openComposer = () => {
    setComposeOpen(true);
    setSelected(null);
    setComposeRecipient("");
    setRecipientSearch("");
  };

  const leaveThread = () => {
    setSelected(null);
    setComposeRecipient("");
    setComposeOpen(false);
  };

  const syncAlerts = (
    <SyncAlerts syncStatus={syncStatus} error={error} busy={busy} onRetry={() => void pull()} />
  );

  const composer = (
    <MessageComposer
      draft={draft}
      onDraft={setDraft}
      sims={activeSims}
      selected={chosenSim}
      onSim={chooseSim}
      help={simInstructions}
      retry={() => void refreshSims()}
      refreshNotice={simRefresh.message}
      send={() => void send()}
      sending={sending}
      canSend={capabilities.includes("SEND_MESSAGES")}
      status={commandStatus}
      useDefault={selectedSubscriptionId === null}
    />
  );

  const threadNotices = (
    <>
      {capabilities.includes("MARK_READ") && selectedConversation ? (
        <div className="read-status-row" role="status">
          <span className={`read-status-row__label read-status-row__label--${readSyncTone(readSync)}`}>
            {readSyncLabel(readSync) ?? "Read"}
          </span>
          {readSyncRetryable(readSync) ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                readInFlight.current.delete(
                  readStateKey(selectedConversation.aggregateId, selectedConversation.lastSequence),
                );
                setReadRetry(value => value + 1);
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {history.error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Could not load older messages</Alert.Title>
            <Alert.Description>{historyErrorMessage(history.error)}</Alert.Description>
          </Alert.Content>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={!canLoadOlder(history, threadState)}
            onPress={() => void loadOlderThread()}
          >
            Retry
          </Button>
        </Alert>
      ) : null}
    </>
  );

  /* ---------------------------------------------------------------- views */

  const inboxView = (
    <div
      className={`messaging-layout${selectedConversation ? "" : " messaging-layout--no-details"}`}
      data-mobile-view={mobileView}
    >
      <ConversationPane
        conversations={filteredConversations}
        totalConversations={conversations.length}
        selectedId={selected}
        onSelect={openConversation}
        search={search}
        onSearch={setSearch}
        searchInputRef={conversationSearchRef}
        filter={conversationFilter}
        onFilter={setConversationFilter}
        unreadTotal={unreadTotal}
        loading={conversationsLoading}
        emptyMessage={emptyInboxMessage}
        hasMore={conversationHasMore}
        loadingMore={loadingOlder}
        onLoadMore={() => void loadOlderConversations()}
        onCompose={openComposer}
      />

      {composeOpen ? (
        <NewMessageView
          recipientSearch={recipientSearch}
          onRecipientSearch={setRecipientSearch}
          matches={recipientMatches}
          contactsAvailable={contacts.length > 0}
          contactsAccessMissing={!capabilities.includes("CONTACTS_READ")}
          onPickRecipient={selectRecipient}
          onBack={leaveThread}
        />
      ) : selectedConversation ? (
        <ThreadPane
          scrollRef={messageScrollRef}
          rows={threadRows}
          state={threadState}
          error={threadError}
          onRetryThread={() => setThreadReload(value => value + 1)}
          header={
            <ThreadHeader
              title={selectedConversation.title}
              subtitle={[
                selectedConversation.subtitle,
                `Synced from Android · ${selectedConversation.aggregateId.slice(0, 8)}…`,
              ]
                .filter(Boolean)
                .join(" · ")}
              phone={selectedConversation.subtitle ?? selectedConversation.title}
              onBack={leaveThread}
              onDetails={() => setShowDetails(true)}
            />
          }
          notices={threadNotices}
          composer={composer}
          hasMore={showLoadOlder(history, threadState)}
          loadingOlder={history.loading}
          onLoadOlder={() => void loadOlderThread()}
          onOpenStatus={(item) => {
            setDeliveryItem(item);
            setDeliveryOpen(true);
          }}
        />
      ) : (
        <section className="thread-pane" aria-label="Conversation">
          <ThreadHeader
            title={composeRecipient ? contactNames.get(phoneKey(composeRecipient)) || composeRecipient : "New message"}
            subtitle={composeRecipient || "Choose a conversation or contact."}
            onBack={leaveThread}
          />
          <div className="thread-scroll scroll-region">
            <ThreadPlaceholder composeRecipient={composeRecipient} />
          </div>
          {composeRecipient ? composer : null}
        </section>
      )}

      {selectedConversation ? (
        <aside className="details-pane" aria-label="Conversation details">
          <div className="details-pane__head">
            <span className="details-section__label">Conversation details</span>
          </div>
          <ConversationDetails
            conversation={selectedConversation}
            capabilities={capabilities}
            syncStatus={syncStatus}
            telemetry={telemetry}
            lastOutgoingStatus={lastOutgoing.status}
            lastOutgoingAt={lastOutgoing.at}
          />
        </aside>
      ) : null}
    </div>
  );

  return (
    <AppShell
      sidebar={<AppSidebar active={tab} unreadTotal={unreadTotal} onNavigate={navigate} />}
      topbar={
        <AppTopbar
          title={destination.title}
          subtitle={destination.subtitle}
          connection={connection}
          connectionDetail={connectionDetail}
          phonePresence={phonePresence}
          phoneReceivedAt={telemetry?.receivedAt ?? null}
          phoneModel={
            telemetry?.device
              ? `${telemetry.device.manufacturer ?? ""} ${telemetry.device.model ?? ""}`.trim() || null
              : null
          }
          syncStatus={syncStatus}
          syncBusy={busy}
          onSync={() => void pull()}
          linkedOnlineCount={linkedOnlineCount}
          onOpenLinkedBrowsers={() => setShowLinkedBrowsers(true)}
          onOpenSettings={() => setTab("settings")}
          onSignOut={() => void signOut()}
          signingOut={signingOut}
        />
      }
      alerts={syncAlerts}
      bottomNav={
        hideBottomNav ? undefined : (
          <MobileBottomNav active={tab} unreadTotal={unreadTotal} onNavigate={navigate} />
        )
      }
    >
      {tab === "inbox" ? inboxView : null}

      {tab === "contacts" ? (
        <ContactsView
          contacts={filteredContacts}
          total={contacts.length}
          search={contactSearch}
          onSearch={setContactSearch}
          visibleCount={visibleContactCount}
          onShowMore={() => setVisibleContactCount(count => Math.min(count + 100, filteredContacts.length))}
          busy={contactsBusy}
          progress={contactsProgress}
          checkedAt={contactsCheckedAt}
          error={contactsError}
          onRefresh={() => void refreshContacts()}
          canReadContacts={capabilities.includes("CONTACTS_READ")}
          onPick={selectRecipient}
        />
      ) : null}

      {tab === "connection" ? (
        <DeviceView
          apiVersion={version || "checking"}
          pwaVersion={PWA_BUILD_VERSION}
          scriptFile={scriptFile}
          cursor={cursor}
          appliedEvents={applied}
          latestSequence={events[0]?.sequence ?? 0}
          trust={trust}
          telemetry={telemetry}
          syncStatus={syncStatus}
          bootstrapState={bootstrapState}
          error={error}
          payloadState={payloadState}
          phonePresence={phonePresence}
          simView={simTelemetry}
        />
      ) : null}

      {tab === "security" ? (
        <SecurityView
          decrypted={threadEvents.filter(event => event.decryption?.state === "decrypted").length}
          locked={threadEvents.filter(event => event.decryption?.state === "locked").length}
          invalid={threadEvents.filter(event => event.decryption?.state === "invalid").length}
          trust={trust}
          keyState={syncStatus.keyState}
          keyError={syncStatus.keyError}
          browserIdentity={webDiagnostics ? webDiagnostics.crypto.browserIdentity : null}
          verifiedPrimary={webDiagnostics ? webDiagnostics.crypto.verifiedPrimary : null}
        />
      ) : null}

      {tab === "debug" ? (
        <DiagnosticsView
          report={webDiagnostics}
          busy={diagnosticsBusy}
          syncBusy={busy}
          onRun={() => void runDiagnostics()}
          onRetrySync={() => void pull()}
        />
      ) : null}

      {tab === "settings" ? (
        <SettingsView
          apiVersion={version || "checking"}
          pwaVersion={PWA_BUILD_VERSION}
          scriptFile={scriptFile}
          buildRevision={webDiagnostics?.session.buildRevision ?? null}
          linkedOnlineCount={linkedOnlineCount}
          linkedTotal={linkedBrowsers.length}
          onOpenLinkedBrowsers={() => setShowLinkedBrowsers(true)}
          onOpenDiagnostics={() => setTab("debug")}
          onSignOut={() => void signOut()}
          signingOut={signingOut}
        />
      ) : null}

      <LinkedBrowsersDrawer
        isOpen={showLinkedBrowsers}
        onOpenChange={setShowLinkedBrowsers}
        sessions={linkedBrowsers}
        browserDeviceId={browserDeviceId}
        signingOut={signingOut}
        onUnlink={() => void signOut()}
      />

      <DeliveryDetailsDrawer
        isOpen={deliveryOpen}
        onOpenChange={setDeliveryOpen}
        item={deliveryItem}
        messageId={deliveryItem?.key}
      />

      <ConversationDetailsDrawer
        isOpen={showDetails}
        onOpenChange={setShowDetails}
        conversation={selectedConversation}
        capabilities={capabilities}
        syncStatus={syncStatus}
        telemetry={telemetry}
        lastOutgoingStatus={lastOutgoing.status}
        lastOutgoingAt={lastOutgoing.at}
      />
    </AppShell>
  );
}
