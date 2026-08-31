"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const Database = require("better-sqlite3");
const { CommandEngine } = require("../src/commandEngine");

describe("CommandEngine durability + exactly-once", () => {
  test("create commits durably and returns QUEUED (Rule 4)", () => {
    const engine = new CommandEngine(new Database(":memory:"));
    const { created, command } = engine.createCommand({
      accountId: "acc1",
      idempotencyKey: "idem-1",
      type: "SEND_SMS",
      ciphertext: Buffer.from('{"phone":"+98912","body":"hi"}'),
      targetAgentId: "agent-1",
    });
    assert.equal(created, true);
    assert.equal(command.state, "QUEUED");
    assert.match(command.id, /^cmd_/);
    const fetched = engine.get(command.id);
    assert.equal(fetched.state, "QUEUED");
  });

  test("idempotency replay returns the ORIGINAL command (no double send)", () => {
    const engine = new CommandEngine(new Database(":memory:"));
    const first = engine.createCommand({
      accountId: "acc1", idempotencyKey: "k1", type: "SEND_SMS",
      ciphertext: Buffer.from("x"), targetAgentId: "agent-1",
    });
    const second = engine.createCommand({
      accountId: "acc1", idempotencyKey: "k1", type: "SEND_SMS",
      ciphertext: Buffer.from("y"), targetAgentId: "agent-1",
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.command.id, first.command.id);
  });

  test("same idempotency key on a DIFFERENT account is a separate command", () => {
    const engine = new CommandEngine(new Database(":memory:"));
    const a = engine.createCommand({ accountId: "a", idempotencyKey: "k", type: "SEND_SMS", ciphertext: Buffer.from("x") });
    const b = engine.createCommand({ accountId: "b", idempotencyKey: "k", type: "SEND_SMS", ciphertext: Buffer.from("x") });
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.notEqual(a.command.id, b.command.id);
  });

  test("claim flips QUEUED→DELIVERED_TO_AGENT and never hands a row twice", () => {
    const engine = new CommandEngine(new Database(":memory:"));
    engine.createCommand({ accountId: "acc", idempotencyKey: "k1", type: "SEND_SMS", ciphertext: Buffer.from("a"), targetAgentId: "ag" });
    engine.createCommand({ accountId: "acc", idempotencyKey: "k2", type: "SEND_SMS", ciphertext: Buffer.from("b"), targetAgentId: "ag" });
    const first = engine.claimForAgent("ag");
    assert.equal(first.length, 2);
    assert.ok(first.every((c) => c.state === "DELIVERED_TO_AGENT"));
    assert.deepEqual(engine.claimForAgent("ag"), []);
  });

  test("expired commands are never claimed (§93: 24h floor, honest expiry)", () => {
    let clock = { t: 1_000_000 };
    const engine = new CommandEngine(new Database(":memory:"), { now: () => clock.t, defaultExpiryMs: 1000 });
    engine.createCommand({ accountId: "acc", idempotencyKey: "k1", type: "SEND_SMS", ciphertext: Buffer.from("a"), targetAgentId: "ag" });
    clock.t += 2000; // past expiry
    assert.deepEqual(engine.claimForAgent("ag"), []);
    assert.equal(engine.counts("acc").EXPIRED, 1);
  });

  test("guarded transitions reject illegal jumps", () => {
    const engine = new CommandEngine(new Database(":memory:"));
    const { command } = engine.createCommand({ accountId: "a", idempotencyKey: "k", type: "SEND_SMS", ciphertext: Buffer.from("x"), targetAgentId: "ag" });
    engine.claimForAgent("ag");
    // DELIVERED → COMPLETED directly is illegal (must pass ACCEPTED/EXECUTING from set)
    const ok = engine.transition(command.id, "COMPLETED", { fromStates: ["ACCEPTED_BY_AGENT", "EXECUTING"], result: "sent" });
    assert.equal(ok, false);
    assert.equal(engine.get(command.id).state, "DELIVERED_TO_AGENT");
    // legal chain
    assert.equal(engine.transition(command.id, "ACCEPTED_BY_AGENT", { fromStates: ["DELIVERED_TO_AGENT"] }), true);
    assert.equal(engine.transition(command.id, "EXECUTING", { fromStates: ["ACCEPTED_BY_AGENT"] }), true);
    assert.equal(engine.transition(command.id, "COMPLETED", { fromStates: ["EXECUTING"], result: "modem accepted" }), true);
    assert.equal(engine.get(command.id).state, "COMPLETED");
  });

  test("counts aggregates per account state", () => {
    const engine = new CommandEngine(new Database(":memory:"));
    engine.createCommand({ accountId: "a", idempotencyKey: "1", type: "SEND_SMS", ciphertext: Buffer.from("x"), targetAgentId: "ag" });
    engine.createCommand({ accountId: "a", idempotencyKey: "2", type: "SEND_SMS", ciphertext: Buffer.from("x"), targetAgentId: "ag" });
    engine.createCommand({ accountId: "b", idempotencyKey: "3", type: "SEND_SMS", ciphertext: Buffer.from("x"), targetAgentId: "ag" });
    engine.claimForAgent("ag");
    assert.equal(engine.counts("a").DELIVERED_TO_AGENT, 2);
    assert.equal(engine.counts("b").DELIVERED_TO_AGENT, 1);
  });
});
