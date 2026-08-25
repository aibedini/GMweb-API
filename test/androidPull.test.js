const test = require("node:test");
const assert = require("node:assert/strict");
const { AndroidOutbox } = require("../src/androidOutbox");

test("outbox hands the task to the phone and resolves on ack", async () => {
  const outbox = new AndroidOutbox();

  // Worker side: offer a send (does not resolve until ack).
  const worker = outbox.sendMessage({ to: "+989121234567", text: "سلام", priority: "critical" });
  let resolved = false;
  worker.then(() => { resolved = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false, "worker promise must wait for the device ack");
  assert.equal(outbox.stats().pending, 1);

  // Phone side: long-poll picks it up immediately.
  const task = await outbox.take(1000);
  assert.equal(task.to, "+989121234567");
  assert.equal(task.text, "سلام");
  assert.equal(task.priority, "critical");

  // Ack success -> worker's sendMessage resolves in GMweb's "sent" shape.
  const handled = outbox.ack(task.requestId, true, { sentAt: 123 });
  assert.equal(handled, true);
  const result = await worker;
  assert.equal(result.type, "sent");
  assert.equal(result.submission.verified, true);
  assert.equal(result.submittedOnce ?? result.submission.submittedOnce, true);
});

test("outbox: empty queue long-poll waits, then a later offer wakes the phone", async () => {
  const outbox = new AndroidOutbox();
  const startedAt = Date.now();
  const phoneWait = outbox.take(1500);          // phone long-poll, nothing queued
  await new Promise((r) => setTimeout(r, 100));
  const worker = outbox.sendMessage({ to: "+989120000000", text: "later" });
  const task = await phoneWait;                  // woken by the late offer
  assert.ok(Date.now() - startedAt < 1400, "phone should wake as soon as work arrives");
  assert.equal(task.text, "later");
  outbox.ack(task.requestId, false, { reason: "radio_down" });
  await assert.rejects(() => worker, /android_gateway_failed|radio_down/i);
});

test("ack for an unknown requestId is a no-op", () => {
  const outbox = new AndroidOutbox();
  assert.equal(outbox.ack("pull_nope", true), false);
});

test("readyState: paired only while a device long-polls or pulled recently", async () => {
  const outbox = new AndroidOutbox();
  assert.equal(outbox.readyState().paired, false, "no device yet");

  const wait = outbox.take(300);              // a device starts long-polling
  await new Promise((r) => setTimeout(r, 20));
  const live = outbox.readyState();
  assert.equal(live.paired, true, "open waiter counts as connected");
  assert.equal(live.transport, "android-pull");
  assert.equal(live.waitingPhones, 1);
  await wait;                                  // waiter times out cleanly
});

test("readyState: fresh lastPull keeps paired true inside the 90s window", () => {
  const outbox = new AndroidOutbox();
  outbox.lastPullAt = Date.now() - 10_000;
  assert.equal(outbox.readyState().paired, true, "recent pull = alive");
  outbox.lastPullAt = Date.now() - 120_000;
  assert.equal(outbox.readyState().paired, false, "stale pull = gone");
});
