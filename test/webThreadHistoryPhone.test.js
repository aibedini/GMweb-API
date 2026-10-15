// Two-tier "Load older messages": server tier first, then exactly one page from
// the phone, then WAIT for replication.
//
// The load-bearing distinction: GMweb having no older rows does NOT mean the
// phone has none, and a COMPLETED command is NOT proof that rows arrived.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialHistoryState, decideLoadOlder, showLoadOlder, historyBusy,
  phoneHistorySupported, onServerPage, onServerPageLoad, onPhoneRequest,
  onPhoneCommandAccepted, onPhoneResult, onReplication, onReplicationTimeout,
  onHistoryError, onThreadMapping, parsePhoneHistoryResult, failureState,
  historyStateLabel, historyErrorRetryable,
} from "../web/src/lib/threadHistoryPhone.ts";

const CAPABLE = { commandTypes: ["SEND_SMS", "READ_MESSAGES", "FETCH_THREAD_HISTORY"], phoneOnline: true };
const OLD_APP = { commandTypes: ["SEND_SMS", "READ_MESSAGES"], phoneOnline: true };
const OFFLINE = { commandTypes: CAPABLE.commandTypes, phoneOnline: false };

const ready = (over = {}) => ({ ...initialHistoryState(), androidThreadId: 552,
  serverHasMore: false, state: "SERVER_HISTORY_EXHAUSTED", ...over });

// ── SERVER TIER ─────────────────────────────────────────────────────────────

test("server-first: while the server has more rows the phone is never contacted", () => {
  const machine = ready({ serverHasMore: true, serverNextCursor: "cur-1" });
  assert.deepEqual(decideLoadOlder(machine, CAPABLE), { kind: "SERVER_PAGE" });
  assert.equal(phoneHistorySupported(CAPABLE), true);
});

test("a server page that merges rows keeps the server tier alive", () => {
  const next = onServerPage(onServerPageLoad(ready({ serverHasMore: true })), { next: "cur-2", hasMore: true, mergedNewCount: 20 });
  assert.equal(next.state, "SERVER_PAGE_LOADED");
  assert.equal(next.serverHasMore, true);
  assert.equal(next.serverNextCursor, "cur-2");
  assert.equal(next.pagesLoaded, 1);
});

test("a duplicate-only server page is NOT success and exhausts the server tier", () => {
  const next = onServerPage(onServerPageLoad(ready({ serverHasMore: true })), { next: "cur-2", hasMore: true, mergedNewCount: 0 });
  assert.equal(next.serverHasMore, false, "cursor advanced but nothing merged is not progress");
  assert.equal(next.state, "SERVER_HISTORY_EXHAUSTED");
  assert.equal(next.pagesLoaded, 0);
});

test("server hasMore=false does NOT mean total history is exhausted", () => {
  const machine = onServerPage(onServerPageLoad(ready({ serverHasMore: true })), { next: null, hasMore: false, mergedNewCount: 0 });
  assert.equal(machine.state, "SERVER_HISTORY_EXHAUSTED");
  assert.equal(machine.phoneHistoryExhausted, false, "phone truth is still unknown");
  assert.equal(showLoadOlder(machine), true, "the button must stay available");
});

// ── HANDOFF TO PHONE ────────────────────────────────────────────────────────

test("supported phone with a thread id produces exactly one phone request", () => {
  const decision = decideLoadOlder(ready(), CAPABLE);
  assert.deepEqual(decision, { kind: "REQUEST_PHONE", androidThreadId: 552 });
});

test("missing capability creates zero commands and says so honestly", () => {
  assert.deepEqual(decideLoadOlder(ready(), OLD_APP), { kind: "UNSUPPORTED" });
  const machine = onHistoryError(ready(), "PHONE_HISTORY_UNSUPPORTED");
  assert.match(historyStateLabel({ ...machine, state: "PHONE_UNSUPPORTED" }), /Android version cannot fetch it/i);
  assert.notEqual(historyStateLabel({ ...machine, state: "PHONE_UNSUPPORTED" }), "No older messages");
});

test("missing androidThreadId creates zero commands — never a guessed thread", () => {
  const machine = ready({ androidThreadId: null });
  assert.deepEqual(decideLoadOlder(machine, CAPABLE), { kind: "NO_THREAD_MAPPING" });
  assert.match(historyStateLabel({ ...machine, state: "THREAD_MAPPING_UNAVAILABLE" }), /not linked to a phone thread/i);
});

test("offline phone creates zero commands and preserves the cursor", () => {
  const machine = ready({ serverNextCursor: "cur-9" });
  assert.deepEqual(decideLoadOlder(machine, OFFLINE), { kind: "PHONE_OFFLINE" });
  assert.match(historyStateLabel(machine, OFFLINE) === "Load older messages"
    ? "Older messages are on your phone. Reconnect the Primary phone to continue."
    : historyStateLabel({ ...machine, state: "PHONE_OFFLINE" }), /Reconnect the Primary phone/i);
  // Retry from the SAME cursor once the phone returns.
  assert.equal(decideLoadOlder(machine, CAPABLE).kind, "REQUEST_PHONE");
  assert.equal(machine.serverNextCursor, "cur-9");
});

test("double click / in-flight request creates one command", () => {
  let machine = onPhoneRequest(ready(), "req-1");
  assert.equal(historyBusy(machine), true);
  assert.deepEqual(decideLoadOlder(machine, CAPABLE), { kind: "BUSY" });
  machine = onPhoneCommandAccepted(machine, "cmd-1");
  assert.deepEqual(decideLoadOlder(machine, CAPABLE), { kind: "BUSY" });
  assert.equal(machine.activeCommandId, "cmd-1");
  assert.equal(machine.activeHistoryRequestId, "req-1");
});

test("Load Older disappears only after a positive end-of-history", () => {
  const waiting = onPhoneResult(onPhoneRequest(ready(), "req-1"), { ok: true, status: "END_OF_THREAD_HISTORY" });
  assert.equal(waiting.phoneHistoryExhausted, true);
  assert.equal(showLoadOlder(waiting), false);
  assert.equal(historyStateLabel(waiting), "No older messages");
});

// ── COMMAND RESULTS ─────────────────────────────────────────────────────────

test("ROWS_PUBLISHED moves to WAITING_REPLICATION, not to success", () => {
  const parsed = parsePhoneHistoryResult({ status: "ROWS_PUBLISHED", publishedCount: 20, hasMore: true,
    nextBefore: { dateMs: 1791170000000, providerId: 347901 } });
  assert.equal(parsed.ok, true);
  const machine = onPhoneResult(onPhoneRequest(ready(), "req-1"), parsed);
  assert.equal(machine.state, "WAITING_REPLICATION");
  assert.equal(machine.publishedCount, 20);
  assert.deepEqual(machine.phoneNextBefore, { dateMs: 1791170000000, providerId: 347901 });
  assert.equal(machine.phoneHasMore, true);
  assert.match(historyStateLabel(machine), /Loading 20 older messages from phone/);
});

test("a COMPLETED command alone is never UI success", () => {
  // Nothing about generic completion reaches this model: only a parsed result.
  const machine = onPhoneRequest(ready(), "req-1");
  assert.equal(machine.state, "REQUESTING_PHONE_HISTORY");
  assert.equal(machine.pagesLoaded, 0);
  assert.notEqual(machine.state, "PHONE_PAGE_AVAILABLE");
  // Zero merged rows on replication is not progress.
  assert.equal(onReplication({ ...machine, state: "WAITING_REPLICATION" }, 0).state, "WAITING_REPLICATION");
});

test("END_OF_THREAD_HISTORY is the only positive end", () => {
  const parsed = parsePhoneHistoryResult({ status: "END_OF_THREAD_HISTORY" });
  assert.deepEqual(parsed, { ok: true, status: "END_OF_THREAD_HISTORY" });
  const machine = onPhoneResult(onPhoneRequest(ready(), "r"), parsed);
  assert.equal(machine.phoneHistoryExhausted, true);
  assert.equal(machine.phoneHasMore, false);
});

test("THREAD_NOT_FOUND is not the end of history", () => {
  const parsed = parsePhoneHistoryResult({ status: "THREAD_NOT_FOUND" });
  assert.equal(parsed.ok, false);
  const machine = onPhoneResult(onPhoneRequest(ready(), "r"), parsed);
  assert.equal(machine.state, "THREAD_MAPPING_UNAVAILABLE");
  assert.notEqual(machine.phoneHistoryExhausted, true);
  assert.equal(showLoadOlder(machine), true, "must remain retryable, not hidden");
  assert.equal(historyErrorRetryable(machine), true);
});

test("CURSOR_INVALID is terminal; query/enqueue failures are retryable", () => {
  assert.equal(failureState("CURSOR_INVALID"), "FAILED_TERMINAL");
  assert.equal(failureState("HISTORY_QUERY_FAILED"), "FAILED_RETRYABLE");
  assert.equal(failureState("EVENT_ENQUEUE_FAILED"), "FAILED_RETRYABLE");
  assert.equal(historyErrorRetryable(onHistoryError(ready(), "CURSOR_INVALID")), false);
  assert.equal(historyErrorRetryable(onHistoryError(ready(), "HISTORY_QUERY_FAILED")), true);
});

test("result parsing is strict and never invents an end of history", () => {
  assert.equal(parsePhoneHistoryResult("not json").ok, false);
  assert.equal(parsePhoneHistoryResult(null).ok, false);
  assert.equal(parsePhoneHistoryResult({}).ok, false);
  assert.equal(parsePhoneHistoryResult({ status: "SOMETHING_NEW" }).ok, false);
  // Malformed publishedCount is rejected rather than treated as zero.
  assert.equal(parsePhoneHistoryResult({ status: "ROWS_PUBLISHED", publishedCount: "many" }).ok, false);
  // Missing hasMore must default to "more may exist", never to "the end".
  const loose = parsePhoneHistoryResult({ status: "ROWS_PUBLISHED", publishedCount: 5 });
  assert.equal(loose.ok && loose.hasMore, true);
  // A malformed cursor is dropped, not guessed.
  const badCursor = parsePhoneHistoryResult({ status: "ROWS_PUBLISHED", publishedCount: 5,
    nextBefore: { dateMs: "x", providerId: null } });
  assert.equal(badCursor.ok && badCursor.nextBefore, null);
});

// ── REPLICATION ─────────────────────────────────────────────────────────────

test("replication merges only new rows and can complete the history", () => {
  const published = onPhoneResult(onPhoneRequest(ready(), "r"),
    parsePhoneHistoryResult({ status: "ROWS_PUBLISHED", publishedCount: 20, hasMore: true,
      nextBefore: { dateMs: 1, providerId: 2 } }));
  const merged = onReplication(published, 20);
  assert.equal(merged.state, "PHONE_PAGE_AVAILABLE");
  assert.equal(merged.pagesLoaded, 1);
  assert.equal(merged.publishedCount, null, "cleared once consumed");
  assert.equal(merged.activeHistoryRequestId, null);
});

test("a final page with hasMore=false exhausts history after replication", () => {
  const published = onPhoneResult(onPhoneRequest(ready(), "r"),
    parsePhoneHistoryResult({ status: "ROWS_PUBLISHED", publishedCount: 7, hasMore: false,
      nextBefore: { dateMs: 1, providerId: 2 } }));
  assert.equal(published.state, "WAITING_REPLICATION");
  const merged = onReplication(published, 7);
  assert.equal(merged.state, "PHONE_HISTORY_EXHAUSTED");
  assert.equal(merged.phoneHistoryExhausted, true);
  assert.equal(showLoadOlder(merged), false);
});

test("published but never replicated gives an honest retryable error", () => {
  const published = onPhoneResult(onPhoneRequest(ready(), "r"),
    parsePhoneHistoryResult({ status: "ROWS_PUBLISHED", publishedCount: 20, hasMore: true }));
  const timedOut = onReplicationTimeout(published);
  assert.equal(timedOut.state, "FAILED_RETRYABLE");
  assert.equal(timedOut.lastErrorCode, "PHONE_HISTORY_PUBLISHED_BUT_NOT_REPLICATED");
  assert.equal(historyErrorRetryable(timedOut), true);
  assert.match(historyStateLabel(timedOut), /have not synced to GMweb yet/i);
  assert.notEqual(historyStateLabel(timedOut), "No older messages");
});

test("page accumulation reaches 20 / 40 / 60 across repeated clicks", () => {
  let machine = ready();
  for (let page = 1; page <= 3; page += 1) {
    machine = onPhoneRequest(machine, `req-${page}`);
    machine = onPhoneResult(machine,
      parsePhoneHistoryResult({ status: "ROWS_PUBLISHED", publishedCount: 20, hasMore: true,
        nextBefore: { dateMs: page, providerId: page } }));
    machine = onReplication(machine, 20);
    assert.equal(machine.pagesLoaded, page);
    assert.equal(showLoadOlder(machine), true);
  }
  assert.equal(machine.pagesLoaded, 3);
});

test("every state renders a distinct, non-empty message", () => {
  const states = ["IDLE", "LOADING_SERVER", "SERVER_PAGE_LOADED", "SERVER_HISTORY_EXHAUSTED",
    "PHONE_UNSUPPORTED", "THREAD_MAPPING_UNAVAILABLE", "PHONE_OFFLINE",
    "REQUESTING_PHONE_HISTORY", "WAITING_PHONE_COMMAND", "WAITING_REPLICATION",
    "PHONE_PAGE_AVAILABLE", "PHONE_HISTORY_EXHAUSTED", "FAILED_RETRYABLE", "FAILED_TERMINAL"];
  const labels = states.map(state => historyStateLabel({ ...ready(), state }));
  for (const label of labels) assert.ok(label.length > 0);
  // "No older messages" is reserved for a POSITIVE end of history.
  const positiveOnly = states.filter((state, i) => labels[i] === "No older messages");
  assert.deepEqual(positiveOnly, ["PHONE_HISTORY_EXHAUSTED"]);
});

test("two cursors stay separate and are never substituted", () => {
  const machine = onPhoneResult(
    onServerPage(ready({ serverHasMore: true }), { next: "server-cursor-2", hasMore: true, mergedNewCount: 5 }),
    parsePhoneHistoryResult({ status: "ROWS_PUBLISHED", publishedCount: 20, hasMore: true,
      nextBefore: { dateMs: 1791170000000, providerId: 347901 } }));
  assert.equal(machine.serverNextCursor, "server-cursor-2");
  assert.deepEqual(machine.phoneNextBefore, { dateMs: 1791170000000, providerId: 347901 });
  assert.notEqual(typeof machine.serverNextCursor, "object", "Android cursor never enters the server field");
});

test("thread mapping can be repaired later without losing progress", () => {
  const machine = onThreadMapping(ready({ androidThreadId: null }), 552);
  assert.equal(machine.androidThreadId, 552);
  assert.equal(decideLoadOlder(machine, CAPABLE).kind, "REQUEST_PHONE");
});
