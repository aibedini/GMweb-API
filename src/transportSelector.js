// Dual-transport selector. Both delivery transports are always constructed;
// exactly one is ACTIVE at a time and every `client.*` call site in server.js
// goes through this Proxy, so switching transports needs no code changes:
//
//   chrome   (default): Playwright drives Google Messages for Web
//   android          : relays to the Messages Android app (EVE Custom HTTP)
//
// The active transport persists to data/transport.json (survives restarts) and
// is toggled at runtime via GET/POST /admin/transport (see Controls page).
//
// Proxy pitfalls handled here (both bit us once):
// - Methods must be bound to the SELECTOR instance, never to the proxy
//   receiver — otherwise `this.active = x` inside a method re-enters the set
//   trap and silently drops the assignment.
// - Wiring-style calls (setPacingController / on / refreshConversationInterval)
//   must land on BOTH transports, or a switch loses the configuration. They are
//   therefore explicit selector methods below, not fall-throughs.
const fs = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const TRANSPORTS = ["chrome", "android"];

class TransportSelector extends EventEmitter {
  constructor({ chromeClient, androidClient, androidOutbox, filePath, logger }) {
    super();
    this.chrome = chromeClient;
    this.android = androidClient;
    this.outbox = androidOutbox || null;
    // PULL mode (default when an outbox is provided): the phone dials out and
    // picks up tasks, so the server never connects to the phone. Set
    // GMWEB_ANDROID_PUSH=1 to fall back to direct-push (needs a tunnel).
    this.pullMode = process.env.GMWEB_ANDROID_PUSH !== "1";
    this.filePath = filePath;
    this.log = logger || (() => {});
    this.active = "chrome";
    this.changeListeners = new Set();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (TRANSPORTS.includes(parsed.transport)) this.active = parsed.transport;
    } catch { /* first boot or unreadable file -> default */ }
    this.log(`delivery transport: ${this.active}`);
  }

  get name() { return this.active; }
  get current() {
    if (this.active !== "android") return this.chrome;
    // In pull mode the worker hands the task to the outbox and waits for the
    // phone's ack; direct-push (tunnel) keeps using the HTTP client.
    if (this.pullMode && this.outbox) return this.outbox;
    return this.android;
  }

  async setTransport(name) {
    if (!TRANSPORTS.includes(name)) throw new Error(`unknown_transport: ${name}`);
    if (name === this.active) return this.describe();
    const previous = this.active;
    this.active = name;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify({ transport: name, changedAt: new Date().toISOString() }, null, 2), "utf8");
    } catch (error) {
      // Revert on persistence failure so memory and disk never disagree.
      this.active = previous;
      throw error;
    }
    this.log(`delivery transport switched ${previous} -> ${name}`);
    for (const listener of this.changeListeners) {
      Promise.resolve().then(() => listener(this.describe())).catch(() => {});
    }
    return this.describe();
  }

  // Transport metadata (NOT the active client's session status — that stays
  // reachable as client.status() via the fall-through).
  describe() {
    return { transport: this.active, available: TRANSPORTS };
  }

  onChange(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  // --- dual-wiring pass-throughs (apply to every transport) -----------------
  setPacingController(controller) {
    this.chrome?.setPacingController?.(controller);
  }

  refreshConversationInterval() {
    try { this.chrome?.refreshConversationInterval?.(); } catch { /* chrome-only knob */ }
  }

  // Chrome is the only event emitter today (conversation/session/error);
  // registering on it unconditionally keeps listeners alive across switches.
  on(event, listener) {
    this.chrome?.on?.(event, listener);
    return this;
  }
}

function createTransportSelector(parts) {
  const selector = new TransportSelector(parts);
  return new Proxy(selector, {
    get(target, prop) {
      // Selector API first (bound to the real instance, never the receiver).
      if (prop in target) {
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }
      // Everything else duck-types to the ACTIVE transport.
      const value = target.current?.[prop];
      return typeof value === "function" ? value.bind(target.current) : value;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
}

module.exports = { TransportSelector, createTransportSelector, TRANSPORTS };
