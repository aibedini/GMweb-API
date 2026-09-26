const { test } = require("node:test");
const assert = require("node:assert/strict");

test("key paging rejects invalid cursors and oversized keyrings without advancing progress", async () => {
  const { fetchValidatedGrantPage, fetchValidatedKeyring, grantCursorKey, keyringCursorKey } = await import("../web/src/lib/sync/key-sync.ts");
  assert.equal(keyringCursorKey("browser-a"), "account_keyring_v2_cursor:browser-a");
  assert.equal(grantCursorKey("browser-a"), "key_grant_bootstrap_v2_cursor:browser-a");
  const previousFetch = global.fetch;
  let response = { events: [], nextCursor: 0, hasMore: true };
  global.fetch = async () => Response.json(response);
  try {
    await assert.rejects(fetchValidatedKeyring(new AbortController().signal), /Invalid or oversized account keyring/);
    response = { events: [{ type: "KEY_GRANT", sequence: 5 }], nextCursor: 5, hasMore: false };
    await assert.rejects(fetchValidatedGrantPage(5, new AbortController().signal), /Invalid key-grant bootstrap page/);
    response = { events: [], nextCursor: 0, hasMore: false };
    assert.deepEqual((await fetchValidatedGrantPage(5, new AbortController().signal)).events, []);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(fetchValidatedKeyring(aborted.signal), { name: "AbortError" });
  } finally {
    global.fetch = previousFetch;
  }
});
