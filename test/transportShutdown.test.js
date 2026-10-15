"use strict";
// Transport shutdown must never throw, in ANY transport mode.
//
// Production bug: server shutdown called `client.detachForShutdown()`. `client`
// is the TransportSelector Proxy, whose `get` trap falls through to the ACTIVE
// transport — and in pull mode that is the outbox, which has no such method.
// The TypeError aborted shutdown before `app.close()`, producing the repeated
// restart/502 windows seen in production.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTransportSelector, TransportSelector } = require("../src/transportSelector");

const noopLog = () => {};

function makeSelector({ overrides = {} } = {}) {
  const chrome = { name: "chrome", detachForShutdown() { this.detached = true; }, async stop() { this.stopped = true; },
    on() {}, refreshConversationInterval() {}, setPacingController() {}, ...overrides.chrome };
  const android = { name: "android", detachForShutdown() { this.detached = true; }, async stop() { this.stopped = true; },
    ...overrides.android };
  const outbox = { name: "outbox", async stop() { this.stopped = true; }, ...overrides.outbox };
  const selector = createTransportSelector({ chromeClient: chrome, androidClient: android,
    androidOutbox: outbox, filePath: "/tmp/nonexistent-transport.json", logger: noopLog });
  return { selector, chrome, android, outbox };
}

test("shutdown in pull mode no longer throws on the missing method", async () => {
  const { selector, outbox } = makeSelector();
  await selector.load();
  await selector.setTransport("android");
  // This is the exact call that used to raise
  // "client.detachForShutdown is not a function".
  assert.equal(typeof selector.detachForShutdown, "function");
  await assert.doesNotReject(() => selector.detachForShutdown());
  await assert.doesNotReject(() => selector.stop());
  assert.equal(outbox.stopped, true, "the outbox was actually stopped");
});

test("shutdown works for chrome/connect mode and android direct-push", async () => {
  const connect = makeSelector();
  await connect.selector.load();
  await assert.doesNotReject(() => connect.selector.detachForShutdown());

  const push = makeSelector();
  await push.selector.load();
  await push.selector.setTransport("android");
  await assert.doesNotReject(() => push.selector.stop());
});

test("lifecycle is idempotent and tolerates a transport without the method", async () => {
  const { selector } = makeSelector({ overrides: { outbox: {}, chrome: {}, android: {} } });
  await selector.load();
  // None of the parts implement anything: must still be a clean no-op.
  await assert.doesNotReject(() => selector.detachForShutdown());
  await assert.doesNotReject(() => selector.stop());
  // Repeated calls are safe (systemd can deliver the signal more than once).
  await assert.doesNotReject(() => selector.detachForShutdown());
  await assert.doesNotReject(() => selector.stop());
});

test("a transport that throws during shutdown cannot abort the rest", async () => {
  const { selector, chrome } = makeSelector({
    overrides: { chrome: { detachForShutdown() { throw new Error("browser already gone"); } } },
  });
  await selector.load();
  // A partially initialized / already-dead transport must not break shutdown.
  await assert.doesNotReject(() => selector.detachForShutdown());
  assert.equal(typeof chrome.detachForShutdown, "function");
});

test("20 repeated shutdown cycles stay clean", async () => {
  for (let i = 0; i < 20; i += 1) {
    const { selector } = makeSelector();
    await selector.load();
    if (i % 2 === 0) await selector.setTransport("android");
    await assert.doesNotReject(() => selector.detachForShutdown(), `cycle ${i} detach`);
  }
});

test("the selector exposes lifecycle explicitly instead of via Proxy fall-through", () => {
  const { selector } = makeSelector({ overrides: { outbox: {} } });
  // Both must resolve on the SELECTOR, not the active transport.
  assert.equal(typeof TransportSelector.prototype.detachForShutdown, "function");
  assert.equal(typeof TransportSelector.prototype.stop, "function");
  assert.equal(typeof selector.detachForShutdown, "function");
  assert.equal(typeof selector.stop, "function");
});
