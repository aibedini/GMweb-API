"use strict";
// Phase 2 — Issue 1 observability trace test.
// Asserts that ONE synthetic incoming SMS produces the full server-side trace
// (batch_received → event_accepted) exactly once, that a redelivery logs
// event_duplicate without consuming a sequence, and that the browser
// projection can decode the stored incoming event as direction=in.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { EventStore } = require("../src/eventStore");

function envelope(payload) {
  const inner = Buffer.from(JSON.stringify(payload));
  const envelopeText = JSON.stringify({
    cryptoVersion: 0,
    encoding: "application/json",
    ciphertextB64: inner.toString("base64"),
  });
  return Buffer.from(envelopeText);
}

describe("incoming_sms_e2e_trace", () => {
  test("one synthetic incoming SMS fires batch_received/event_accepted once; replay is a logged duplicate", async () => {
    const lines = [];
    const store = new EventStore(new Database(":memory:"), {
      log: (line) => lines.push(line),
      debug: (line) => lines.push(line),
    });

    const incoming = {
      eventId: "in-1",
      type: "MESSAGE_CREATED",
      conversationId: "conversation-1",
      payload: envelope({ messageId: "m1", direction: "in", body: "Hello from Phone A", dateMs: 1000, status: 1, address: "+123" }),
      cryptoVersion: 0,
    };
    const outgoing = {
      eventId: "out-1",
      type: "MESSAGE_CREATED",
      conversationId: "conversation-1",
      payload: envelope({ messageId: "m2", direction: "out", body: "Hello back", dateMs: 2000, status: 2, address: "+123" }),
      cryptoVersion: 0,
    };

    const first = store.ingestBatch({ accountId: "acc1", sourceDeviceId: "agent-1", events: [incoming, outgoing] });
    assert.equal(first.accepted.length, 2);

    // Redelivery of the SAME incoming event must NOT consume a sequence.
    const replay = store.ingestBatch({ accountId: "acc1", sourceDeviceId: "agent-1", events: [incoming] });
    assert.equal(replay.duplicates, 1);
    assert.equal(replay.accepted.length, 1); // accepted carries the ORIGINAL sequence
    assert.equal(store.count("acc1"), 2);

    // Every trace marker fired exactly once.
    const batchReceived = lines.filter((l) => l.startsWith("batch_received sourceDeviceId=agent-1 count="));
    assert.equal(batchReceived.length, 2);
    assert.match(batchReceived[0], /count=2 types=\{MESSAGE_CREATED\}/);
    const accepted = lines.filter((l) => l.startsWith("event_accepted eventId="));
    assert.equal(accepted.length, 2);
    assert.ok(accepted.some((l) => l.includes("eventId=in-1") && l.includes("sequence=1") && l.includes("type=MESSAGE_CREATED")));
    assert.ok(accepted.some((l) => l.includes("eventId=out-1") && l.includes("sequence=2") && l.includes("type=MESSAGE_CREATED")));
    const duplicates = lines.filter((l) => l.startsWith("event_duplicate eventId=in-1"));
    assert.equal(duplicates.length, 1);

    // Browser projection decodes the stored (opaque) events: in + out present.
    const page = store.after("acc1", 0);
    assert.equal(page.events.length, 2);
    const { messagesForAggregate, buildConversations } = await import("../web/src/lib/inbox.ts");
    const timeline = messagesForAggregate(page.events, "conversation-1");
    assert.deepEqual(timeline.map((t) => t.payload.direction), ["in", "out"]);
    const conversations = buildConversations(page.events);
    assert.deepEqual(
      conversations.map((c) => ({ title: c.title, preview: c.preview })),
      [{ title: "+123", preview: "Hello back" }],
    );
  });
});
