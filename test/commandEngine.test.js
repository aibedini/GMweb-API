"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const Database = require("better-sqlite3");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
      ciphertext: Buffer.from("x"), targetAgentId: "agent-1",
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.command.id, first.command.id);
    assert.throws(() => engine.createCommand({ accountId: "acc1", idempotencyKey: "k1",
      type: "SEND_SMS", ciphertext: Buffer.from("y"), targetAgentId: "agent-1" }),
    /idempotency_key_reused/);
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

  test("V2 lease reclaims the same command identity after a lost claim response and restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-command-lease-"));
    const file = path.join(dir, "commands.sqlite");
    let now = 10_000;
    let db = new Database(file);
    try {
      let engine = new CommandEngine(db, { now: () => now, claimLeaseMs: 1_000 });
      const original = engine.createCommand({ accountId: "a", idempotencyKey: "sms-1",
        type: "SEND_SMS", ciphertext: Buffer.from("opaque"), targetAgentId: "phone-a" }).command;
      const first = engine.claimForAgentV2("phone-a", { limit: 1 })[0];
      assert.equal(first.id, original.id);
      assert.equal(first.claimGeneration, 1);
      assert.equal(first.leaseExpiresAt, 11_000);
      assert.deepEqual(engine.claimForAgentV2("phone-b"), []);
      db.close();
      db = new Database(file);
      engine = new CommandEngine(db, { now: () => now, claimLeaseMs: 1_000 });
      assert.deepEqual(engine.claimForAgentV2("phone-a"), []);
      now = 11_001;
      const replay = engine.claimForAgentV2("phone-a", { limit: 1 })[0];
      assert.equal(replay.id, original.id);
      assert.equal(replay.idempotencyKey, original.idempotencyKey);
      assert.equal(replay.claimGeneration, 2);
      assert.equal(replay.leaseExpiresAt, 12_001);
      assert.equal(engine.transitionClaim(replay.id, "ACCEPTED_BY_AGENT", {
        agentId: "phone-a", claimGeneration: 1, fromStates: ["DELIVERED_TO_AGENT"],
      }), false);
      assert.equal(engine.transitionClaim(replay.id, "ACCEPTED_BY_AGENT", {
        agentId: "phone-b", claimGeneration: 2, fromStates: ["DELIVERED_TO_AGENT"],
      }), false);
      assert.equal(engine.transitionClaim(replay.id, "ACCEPTED_BY_AGENT", {
        agentId: "phone-a", claimGeneration: 2, fromStates: ["DELIVERED_TO_AGENT"],
      }), true);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two SQLite connections cannot claim one live V2 lease twice", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-command-race-"));
    const file = path.join(dir, "commands.sqlite");
    const leftDb = new Database(file);
    const rightDb = new Database(file);
    try {
      const left = new CommandEngine(leftDb, { now: () => 5_000, claimLeaseMs: 1_000 });
      const right = new CommandEngine(rightDb, { now: () => 5_000, claimLeaseMs: 1_000 });
      left.createCommand({ accountId: "a", idempotencyKey: "one", type: "SEND_SMS",
        ciphertext: Buffer.from("opaque"), targetAgentId: "phone" });
      assert.equal(left.claimForAgentV2("phone").length, 1);
      assert.deepEqual(right.claimForAgentV2("phone"), []);
    } finally {
      leftDb.close();
      rightDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("existing command rows migrate to nullable V2 lease columns without losing identity", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE commands (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        target_agent_id TEXT, source_client_id TEXT, type TEXT NOT NULL, ciphertext BLOB NOT NULL,
        encoding TEXT NOT NULL, schema_version INTEGER NOT NULL, crypto_version INTEGER NOT NULL,
        client_signature BLOB, state TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, accepted_at INTEGER, completed_at INTEGER, result TEXT,
        UNIQUE(account_id, idempotency_key))`);
      db.prepare(`INSERT INTO commands (id, account_id, idempotency_key, target_agent_id,
        type, ciphertext, encoding, schema_version, crypto_version, state, created_at, expires_at)
        VALUES ('old', 'a', 'same', 'phone', 'SEND_SMS', ?, 'envelope.v1', 1, 1, 'QUEUED', 1, 999999)`).run(Buffer.from("opaque"));
      const engine = new CommandEngine(db, { now: () => 2 });
      assert.equal(engine.get("old").claimGeneration, 0);
      assert.equal(engine.claimForAgentV2("phone")[0].id, "old");
      assert.equal(engine.get("old").claimGeneration, 1);
    } finally { db.close(); }
  });
});
