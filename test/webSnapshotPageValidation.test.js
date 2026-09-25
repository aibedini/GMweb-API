const { test } = require("node:test");
const assert = require("node:assert/strict");

test("snapshot pages keep token, baseline and positions stable before persistence", async () => {
  const { assertValidSnapshotPage } = await import("../web/src/lib/sync/snapshot-sync.ts");
  const page = { token: "snapshot-a", replicaGeneration: "generation-a", snapshotVersion: 1,
    baselineSequence: 10, expiresAt: Date.now() + 60_000,
    rows: [{ position: 1, kind: "message", messageId: "message-a" }],
    hasMore: true, nextCursor: btoa("1") };
  const expected = { token: null, cursor: null, baseline: null,
    expectedGeneration: null, expectedVersion: null, pageLimit: 100 };
  assert.doesNotThrow(() => assertValidSnapshotPage(page, expected));
  assert.throws(() => assertValidSnapshotPage({ ...page, token: "snapshot-b" },
    { ...expected, token: "snapshot-a" }), /Invalid encrypted snapshot page/);
  assert.throws(() => assertValidSnapshotPage({ ...page, rows: [{ ...page.rows[0], position: 2 }] },
    expected), /Invalid encrypted snapshot position/);
  assert.throws(() => assertValidSnapshotPage({ ...page, nextCursor: btoa("2") },
    expected), /Invalid encrypted snapshot cursor/);
});
