// "Load older messages" must never be a dead control.
//
// PRODUCTION BUG: the button was visibly clickable and did nothing. The handler
// proved progress by the CURSOR, not by the MERGE. mergeThreadEvents dedupes by
// eventId, so a page whose rows the client already held advanced the cursor,
// passed assertHistoryProgress, merged to ZERO new messages, and left the UI
// unchanged — CLICK -> NOTHING.
import test from "node:test";
import assert from "node:assert/strict";
import { assertHistoryProgress, assertHistoryMergeProgress, mergeThreadEvents } from "../web/src/lib/threadHistory.ts";
import { pagingFromPage, showLoadOlder, canLoadOlder, isValidCursor } from "../web/src/lib/threadPaging.ts";

const event = (id) => ({ eventId: id, sequence: Number(id.replace(/\D/g, "")) });

// ------------------------------------------------ merge-progress assertion

test("the merge must prove progress, not the cursor", () => {
  // A page that adds new unique rows is progress.
  assert.doesNotThrow(() => assertHistoryMergeProgress("c1", { items: [event("e1")], hasMore: true, next: "c2" }, 1));
  // Reaching the end IS progress, even with zero new rows.
  assert.doesNotThrow(() => assertHistoryMergeProgress("c1", { items: [event("e1")], hasMore: false, next: undefined }, 0));

  // THE PRODUCTION BUG: cursor advanced, rows returned, nothing merged.
  assert.throws(
    () => assertHistoryMergeProgress("c1", { items: [event("e1"), event("e2")], hasMore: true, next: "c2" }, 0),
    /PAGINATION_DUPLICATE_PAGE/,
  );
  // A stale/looping cursor is still a stall.
  assert.throws(() => assertHistoryMergeProgress("c1", { items: [event("e1")], hasMore: true, next: "c1" }, 0),
    /PAGINATION_STALLED/);
  assert.throws(() => assertHistoryMergeProgress("c1", { items: [], hasMore: true, next: "c2" }, 0),
    /PAGINATION_STALLED/);
  assert.throws(() => assertHistoryMergeProgress("c1", { items: [event("e1")], hasMore: true, next: undefined }, 0),
    /PAGINATION_STALLED/);
});

test("a duplicate-only page is exactly what the old assertion let through", () => {
  const requested = "cur-1";
  const page = { items: [event("e1"), event("e2")], hasMore: true, next: "cur-2" };
  // The OLD check passes: the cursor advanced and rows came back.
  assert.doesNotThrow(() => assertHistoryProgress(requested, page));
  // But the client already holds both rows, so the merge adds nothing.
  const held = [event("e1"), event("e2")];
  const merged = mergeThreadEvents(held, page.items);
  assert.equal(merged.length - held.length, 0, "zero new messages");
  // The NEW check surfaces it instead of a silent no-op.
  assert.throws(() => assertHistoryMergeProgress(requested, page, merged.length - held.length),
    /PAGINATION_DUPLICATE_PAGE/);
});

// ------------------------------------------------ the click contract (§10)

/**
 * Drives the real handler logic. Every activation of a VISIBLE control must
 * yield exactly one of: MORE_MESSAGES, END_OF_HISTORY, RETRYABLE_ERROR.
 * `NOTHING` is the forbidden outcome.
 */
async function clickLoadOlder({ state, threadState, held, fetchPage }) {
  if (!showLoadOlder(state, threadState)) return "NOT_RENDERED";
  // The control is visible, so it must be actionable: a visible-but-silent
  // guard return is itself the bug.
  if (!canLoadOlder(state, threadState)) return "RETRYABLE_ERROR";   // LOAD_OLDER_INVARIANT_VIOLATION
  const cursor = state.next;
  if (!isValidCursor(cursor)) return "RETRYABLE_ERROR";              // cursor_invalid
  let page;
  try { page = await fetchPage(cursor); } catch { return "RETRYABLE_ERROR"; }
  try {
    if (page.items.some(e => e.decryption?.state === "invalid")) throw new Error("DECRYPTION_FAILED");
    assertHistoryProgress(cursor, page);
    const merged = mergeThreadEvents(held, page.items);
    assertHistoryMergeProgress(cursor, page, merged.length - held.length);
    if (!page.hasMore) return "END_OF_HISTORY";
    return "MORE_MESSAGES";
  } catch { return "RETRYABLE_ERROR"; }
}

const state = (over = {}) => ({ hasMore: true, next: "cur-1", loading: false, error: null, ...over });

test("a visible Load Older control always produces an outcome, never NOTHING", async () => {
  const held = [event("e1")];

  // Progress.
  assert.equal(await clickLoadOlder({ state: state(), threadState: "READY", held,
    fetchPage: async () => ({ items: [event("e0")], hasMore: true, next: "cur-2" }) }), "MORE_MESSAGES");
  // End of history.
  assert.equal(await clickLoadOlder({ state: state(), threadState: "READY", held,
    fetchPage: async () => ({ items: [event("e0")], hasMore: false, next: undefined }) }), "END_OF_HISTORY");
  // Duplicate-only page -> retryable error, NOT silence.
  assert.equal(await clickLoadOlder({ state: state(), threadState: "READY", held,
    fetchPage: async () => ({ items: [event("e1")], hasMore: true, next: "cur-2" }) }), "RETRYABLE_ERROR");
  // Stall.
  assert.equal(await clickLoadOlder({ state: state(), threadState: "READY", held,
    fetchPage: async () => ({ items: [event("e0")], hasMore: true, next: "cur-1" }) }), "RETRYABLE_ERROR");
  // Network failure.
  assert.equal(await clickLoadOlder({ state: state(), threadState: "READY", held,
    fetchPage: async () => { throw new Error("offline"); } }), "RETRYABLE_ERROR");
  // Decryption failure.
  assert.equal(await clickLoadOlder({ state: state(), threadState: "READY", held,
    fetchPage: async () => ({ items: [{ ...event("e0"), decryption: { state: "invalid" } }], hasMore: true, next: "cur-2" }) }),
    "RETRYABLE_ERROR");
  // Empty page while claiming more.
  assert.equal(await clickLoadOlder({ state: state(), threadState: "READY", held,
    fetchPage: async () => ({ items: [], hasMore: true, next: "cur-2" }) }), "RETRYABLE_ERROR");
  // Not rendered at all.
  assert.equal(await clickLoadOlder({ state: state({ hasMore: false }), threadState: "READY", held,
    fetchPage: async () => ({ items: [], hasMore: false, next: undefined }) }), "NOT_RENDERED");
});

test("an inconsistent paging state can never render an actionable control", () => {
  // The 6a2f86b invariant must survive: hasMore without a cursor is not a button.
  for (const bad of [undefined, null, "", NaN, {}]) {
    const bad_state = pagingFromPage({ hasMore: true, next: bad });
    assert.equal(bad_state.hasMore, false);
    assert.equal(showLoadOlder(bad_state, "READY"), false, `next=${String(bad)} must not render`);
  }
  // Rendered => actionable. There is no state where the button shows but the
  // click is refused because of `loading`.
  const loading = { ...state(), loading: true };
  assert.equal(showLoadOlder(loading, "READY"), true, "still visible while loading");
  assert.equal(canLoadOlder(loading, "READY"), false, "but disabled, which is why the guard maps to a visible error");
});
