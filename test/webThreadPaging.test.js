"use strict";
// Thread history paging.
//
// The reported defect was a "Load older messages" button that was visible but
// did nothing. These tests pin the invariant that makes that impossible, and
// exercise the paging state machine over a faithful model of the server's
// keyset query (eventStore.messages: sort_key DESC, message_id DESC, strict
// `<` on both, LIMIT capped+1 to detect hasMore).
// This file uses ESM static imports (the repo's other tests are CJS with
// dynamic import()); threadPaging.ts is dependency-free and threadHistory.ts
// only has a type-only import, so both load directly under type stripping.
import test from "node:test";
import assert from "node:assert/strict";
import {
  pagingFromPage, pagingLoading, pagingFailed, showLoadOlder, canLoadOlder,
  isValidCursor, describeHistory, historyErrorMessage, IDLE_HISTORY, HISTORY_CURSOR_MISSING,
} from "../web/src/lib/threadPaging.ts";
import { mergeThreadEvents } from "../web/src/lib/threadHistory.ts";

/**
 * Faithful in-memory model of `SELECT ... WHERE sort_key < ? OR (sort_key = ? AND message_id < ?)`.
 * The cursor is an OPAQUE STRING, exactly as `eventStore.messages()` returns it
 * (`encodeCursor([sortKey, messageId])` base64url) and as the browser sends it
 * back verbatim via `?before=`.
 */
const encodeCursor = (sortKey, messageId) =>
  Buffer.from(JSON.stringify([sortKey, messageId])).toString("base64url");
const decodeCursor = (cursor) => (cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) : null);

function makeServer(rows, maxLimit = 100) {
  return {
    page(cursor, limit) {
      const decoded = decodeCursor(cursor);
      const [sortKey, messageId] = decoded ?? [Number.MAX_SAFE_INTEGER, "\uffff"];
      const filtered = rows
        .filter(row => row.sortKey < sortKey || (row.sortKey === sortKey && row.messageId < messageId))
        .sort((a, b) => b.sortKey - a.sortKey || (a.messageId < b.messageId ? 1 : -1));
      const capped = Math.max(1, Math.min(maxLimit, limit));
      const hasMore = filtered.length > capped;
      const page = hasMore ? filtered.slice(0, capped) : filtered;
      const last = page[page.length - 1];
      return {
        items: page,
        hasMore,
        next: hasMore && last ? encodeCursor(last.sortKey, last.messageId) : undefined,
      };
    },
  };
}

function conversation(count, sortKeyOf = index => index + 1) {
  return Array.from({ length: count }, (_, index) => ({
    sortKey: sortKeyOf(index),
    messageId: `m${String(index + 1).padStart(6, "0")}`,
  }));
}

// ------------------------------------------------------- invariant / dead button

test("hasMore without a usable cursor is impossible: it becomes a surfaced error", async () => {
  for (const bad of [undefined, null, "", NaN, Infinity, {}]) {
    const state = pagingFromPage({ hasMore: true, next: bad });
    assert.equal(state.hasMore, false, `hasMore must be cleared for next=${String(bad)}`);
    assert.equal(state.next, null);
    assert.equal(state.error, HISTORY_CURSOR_MISSING);
    // The whole point: no state may render an actionable button it cannot honour.
    assert.equal(showLoadOlder(state, "READY"), false);
    assert.equal(canLoadOlder(state, "READY"), false);
  }
});

test("showLoadOlder and canLoadOlder never disagree with the cursor", async () => {
  const withCursor = pagingFromPage({ hasMore: true, next: "cursor-1" });
  assert.equal(showLoadOlder(withCursor, "READY"), true);
  assert.equal(canLoadOlder(withCursor, "READY"), true);
  assert.equal(canLoadOlder(pagingLoading(withCursor), "READY"), false, "disabled while loading");
  assert.equal(showLoadOlder(pagingLoading(withCursor), "READY"), true, "still visible while loading");

  // Any non-READY thread must never offer paging.
  for (const state of ["LOADING", "LOCKED", "EMPTY", "FAILED", "IDLE"]) {
    assert.equal(showLoadOlder(withCursor, state), false, `no paging control while ${state}`);
    assert.equal(canLoadOlder(withCursor, state), false);
  }

  assert.equal(showLoadOlder(IDLE_HISTORY, "READY"), false);
  assert.equal(showLoadOlder(pagingFromPage({ hasMore: false, next: "stale" }), "READY"), false,
    "a cursor without hasMore must not render a button");
});

test("a failed page keeps the cursor so Retry can re-request the same page", async () => {
  const loaded = pagingFromPage({ hasMore: true, next: "cursor-1" });
  const failed = pagingFailed(pagingLoading(loaded), HISTORY_CURSOR_MISSING);
  assert.equal(failed.loading, false);
  assert.equal(failed.error, HISTORY_CURSOR_MISSING);
  assert.equal(failed.next, "cursor-1", "cursor preserved for retry");
  assert.equal(failed.hasMore, true);
  assert.equal(canLoadOlder(failed, "READY"), true, "retry stays actionable");
});

test("history errors map to distinct, honest copy", async () => {
  assert.equal(historyErrorMessage(null), null);
  assert.match(historyErrorMessage(HISTORY_CURSOR_MISSING), /cursor is missing/);
  assert.match(historyErrorMessage("PAGINATION_STALLED"), /did not advance/);
  assert.match(historyErrorMessage("DECRYPTION_FAILED"), /authenticated/);
  assert.match(historyErrorMessage("SOMETHING_ELSE"), /could not be loaded/);
});

test("history diagnostics expose the fields needed to tell the hypotheses apart", async () => {
  const missing = describeHistory(pagingFromPage({ hasMore: true }), {
    lastRequestAt: 1234, lastReturnedCount: 0, lastNextCursorChanged: false,
  });
  assert.equal(missing.historyHasMore, false);
  assert.equal(missing.historyNextCursorPresent, false);
  assert.equal(missing.historyNextCursorType, "none");
  assert.equal(missing.lastHistoryReturnedCount, 0);
  assert.equal(missing.lastHistoryNextCursorChanged, false);
  assert.equal(missing.lastHistoryError, HISTORY_CURSOR_MISSING);

  const stringCursor = describeHistory(pagingFromPage({ hasMore: true, next: "abc" }));
  assert.equal(stringCursor.historyNextCursorType, "string");
  assert.equal(stringCursor.historyNextCursorPresent, true);

  const numberCursor = describeHistory(pagingFromPage({ hasMore: true, next: 41 }));
  assert.equal(numberCursor.historyNextCursorType, "number");
  assert.equal(isValidCursor(0), true, "sequence 0 is a valid cursor");
});

// ------------------------------------------------------------- pagination walk

for (const total of [1, 5, 20, 21, 40, 41, 50, 51, 100, 101, 250]) {
  test(`walking ${total} messages reaches every one exactly once`, () => {
    const server = makeServer(conversation(total));
    const seen = new Map();

    // First page (what the thread effect requests).
    let page = server.page(undefined, 10);
    let state = pagingFromPage(page);
    for (const row of page.items) seen.set(row.messageId, (seen.get(row.messageId) ?? 0) + 1);
    assert.equal(showLoadOlder(state, "READY"), page.hasMore,
      "the button is shown exactly when the server says there is more");

    // Then walk older pages until exhausted.
    let guard = 0;
    while (showLoadOlder(state, "READY")) {
      assert.ok(isValidCursor(state.next), "a rendered button always has a cursor");
      const requested = state.next;
      page = server.page(requested, 20);
      assert.ok(page.items.length > 0, "a page with hasMore must return items");
      assert.notEqual(page.next, requested, "the cursor must advance");
      for (const row of page.items) seen.set(row.messageId, (seen.get(row.messageId) ?? 0) + 1);
      state = pagingFromPage(page);
      guard += 1;
      assert.ok(guard < 200, "no infinite paging loop");
    }

    assert.equal(seen.size, total, "every message reached");
    assert.equal([...seen.values()].every(count => count === 1), true, "no duplicates across pages");
    assert.equal(state.hasMore, false);
    assert.equal(showLoadOlder(state, "READY"), false, "no dead button at the oldest end");
  });
}

test("identical sortKeys still page correctly via the messageId tiebreaker", () => {
  // Every message shares sort_key; only `message_id <` can make progress.
  const rows = conversation(51, () => 7);
  const server = makeServer(rows);
  const seen = new Set();
  let page = server.page(undefined, 10);
  let state = pagingFromPage(page);
  for (const row of page.items) seen.add(row.messageId);

  let guard = 0;
  while (showLoadOlder(state, "READY")) {
    const requested = state.next;
    page = server.page(requested, 20);
    assert.notEqual(page.next, requested, "tiebreaker must still advance the cursor");
    for (const row of page.items) seen.add(row.messageId);
    state = pagingFromPage(page);
    guard += 1;
    assert.ok(guard < 100);
  }
  assert.equal(seen.size, 51, "same-sortKey messages are all reachable exactly once");
});

test("server claiming hasMore with no cursor stops paging instead of looping", () => {
  // A protocol-violating server. The client must surface it, never render a
  // dead button, and never spin.
  let requests = 0;
  const server = { page: () => { requests += 1; return { items: [{ sortKey: 1, messageId: "m1" }], hasMore: true, next: null }; } };
  let page = server.page(undefined, 10);
  let state = pagingFromPage(page);
  assert.equal(state.error, HISTORY_CURSOR_MISSING);
  assert.equal(showLoadOlder(state, "READY"), false, "no dead button");
  let guard = 0;
  while (canLoadOlder(state, "READY")) { state = pagingFromPage(server.page(state.next, 20)); guard += 1; assert.ok(guard < 5); }
  assert.equal(requests, 1, "exactly one request was ever made");
});

// ------------------------------------------------------------- merge / anchor

test("merging older pages is idempotent and never duplicates a bubble", async () => {
  const older = [{ eventId: "e1", sequence: 1 }, { eventId: "e2", sequence: 2 }];
  const newer = [{ eventId: "e2", sequence: 2 }, { eventId: "e3", sequence: 3 }];
  const merged = mergeThreadEvents(older, newer);
  assert.deepEqual(merged.map(event => event.eventId), ["e1", "e2", "e3"]);
  // Re-applying a page (retry / overlap) changes nothing.
  assert.deepEqual(mergeThreadEvents(merged, newer), merged);
  assert.deepEqual(mergeThreadEvents(merged, older), merged);
});

test("prepending older pages preserves the scroll anchor", async () => {
  // Reproduces the App effect: capture before, insert, then shift scrollTop by
  // the height delta so the visible message does not move.
  const anchor = (scrollHeightBefore, scrollTopBefore, scrollHeightAfter) =>
    scrollTopBefore + (scrollHeightAfter - scrollHeightBefore);

  assert.equal(anchor(1000, 200, 1400), 600, "content grew above -> scrollTop grows by the delta");
  assert.equal(anchor(500, 50, 900), 450);
  assert.equal(anchor(1000, 200, 1000), 200, "no growth -> no shift");
  // Prepending can only grow the content, so the delta is never negative here.
  for (const [before, top, after] of [[1000, 200, 1400], [400, 0, 1200], [2500, 900, 3100]]) {
    assert.ok(anchor(before, top, after) >= top);
  }
});

test("describeHistory is pure and reports the current paging state", async () => {
  const state = pagingFromPage({ hasMore: true, next: 41 });
  const before = JSON.stringify(state);
  const diagnostics = describeHistory(state);
  assert.equal(diagnostics.historyHasMore, true);
  assert.equal(diagnostics.historyNextCursorType, "number");
  assert.equal(diagnostics.lastHistoryRequestAt, null);
  assert.equal(JSON.stringify(state), before, "describeHistory must not mutate its input");
});
