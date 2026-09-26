"use strict";
// The Eve transport-health contract.
//
// These tests bind GMweb (the provider) to the SAME fixture Eve (the consumer)
// reads: shared/eve-gmweb-contract-v1.json. The samples in that file are the
// expectation on both sides, so a provider-side shape change fails here rather
// than silently rendering every card as "unknown" in the consumer's UI.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const contract = require("../shared/eve-gmweb-contract-v1.json");
const {
  projectTransportHealth,
  responseSchemaProperties,
  contractVersion
} = require("../src/eveTransportHealth");
const {
  requiredProjectKeyScope,
  PROJECT_KEY_SCOPES
} = require("../src/projectKeyScopes");
const { ApiKeyStore } = require("../src/apiKeys");

const RESPONSE = contract.transportHealthResponse;

// A frozen instant, so observed_at is deterministic without sleeping.
const OBSERVED_AT = "2026-09-26T19:03:48.000Z";
const frozenClock = () => Date.parse(OBSERVED_AT);

const STALE_PULL_AT = "2026-09-26T18:46:26.000Z"; // 17m 22s before OBSERVED_AT
const STALE_PULL_AGE_MS = 1042000;

/** Snapshot fixtures that must project onto the shared samples. */
const SNAPSHOTS = {
  android_pull_connected: {
    activeTransport: "android", mode: "pull", ready: true, state: "connected",
    reason: null, operationalReason: null,
    lastPullAt: "2026-09-26T19:03:45.000Z", lastPullAgeMs: 3000,
    pending: 4, inflight: 1,
    lastAckAt: "2026-09-26T19:03:41.000Z", lastAckOutcome: "completed",
    alternatives: {}
  },
  android_pull_stale: {
    activeTransport: "android", mode: "pull", ready: false, state: "stale",
    reason: "no_recent_device_pull", operationalReason: null,
    lastPullAt: STALE_PULL_AT, lastPullAgeMs: STALE_PULL_AGE_MS,
    pending: 0, inflight: 0,
    lastAckAt: null, lastAckOutcome: null,
    alternatives: {}
  },
  android_pull_stale_with_waiting_queue: {
    activeTransport: "android", mode: "pull", ready: false, state: "stale",
    reason: "no_recent_device_pull", operationalReason: "task_waiting_no_device",
    lastPullAt: STALE_PULL_AT, lastPullAgeMs: STALE_PULL_AGE_MS,
    pending: 14, inflight: 0,
    lastAckAt: null, lastAckOutcome: null,
    alternatives: {}
  },
  android_pull_inflight_device_stale: {
    activeTransport: "android", mode: "pull", ready: false, state: "stale",
    reason: "no_recent_device_pull", operationalReason: "inflight_device_stale",
    lastPullAt: STALE_PULL_AT, lastPullAgeMs: STALE_PULL_AGE_MS,
    pending: 3, inflight: 2,
    lastAckAt: null, lastAckOutcome: null,
    alternatives: {}
  },
  android_unconfigured: {
    activeTransport: "android", mode: "pull", ready: false, state: "unconfigured",
    reason: "device_key_not_configured", operationalReason: null,
    lastPullAt: null, lastPullAgeMs: null,
    pending: 0, inflight: 0,
    lastAckAt: null, lastAckOutcome: null,
    alternatives: {}
  },
  // Chrome is the ACTIVE transport, so the Android bridge must appear only as
  // non-authoritative diagnostics - never as the active device's presence.
  chrome_active_with_android_diagnostics: {
    activeTransport: "chrome", mode: null, ready: true, state: "connected",
    reason: null, operationalReason: null,
    lastPullAt: null, lastPullAgeMs: null,
    pending: 0, inflight: 0,
    lastAckAt: null, lastAckOutcome: null,
    alternatives: {
      android: {
        state: "stale", reason: "no_recent_device_pull",
        lastPullAt: STALE_PULL_AT, lastPullAgeMs: STALE_PULL_AGE_MS,
        pending: 14, inflight: 0
      }
    }
  }
};

describe("the shared contract declares the consumer transport-health surface", () => {
  test("the endpoint is declared with the read-only scope", () => {
    const entry = contract.endpoints.find((item) => item.key === "transport_health");
    assert.ok(entry, "the contract must declare the transport_health endpoint");
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/eve/v1/transport-health");
    assert.equal(entry.scope, "transport:read");
    // Every declared endpoint scope must also be a default project-key scope;
    // otherwise a key could never be granted the authority the route requires.
    assert.ok(contract.projectKeyDefaults.scopes.includes(entry.scope),
      "transport:read must be a declared project-key scope");
  });

  test("the projection resolves the endpoint path through the contract", () => {
    // The route path is not restated in src/; it lives in the contract file, and
    // the scope mapper must agree with it.
    const entry = contract.endpoints.find((item) => item.key === "transport_health");
    assert.equal(requiredProjectKeyScope("GET", entry.path), entry.scope);
    assert.equal(requiredProjectKeyScope("GET", "/eve/v1/transport-health"), "transport:read");
  });

  test("the declared contract version is what the response reports", () => {
    assert.equal(contractVersion(), RESPONSE.contractVersion);
    assert.equal(RESPONSE.contractVersion, 1);
  });

  test("transport:read is a grantable scope", () => {
    assert.ok(PROJECT_KEY_SCOPES.includes("transport:read"),
      "normalizeProjectKeyScopes silently drops scopes absent from the enum");
    const store = new ApiKeyStore("unused", "unused");
    store.save = () => Promise.resolve();
    const key = store.create({ name: "with-transport-read", scopes: ["transport:read"] });
    assert.equal(store.hasScope(key, "transport:read"), true);
  });
});

describe("the projection reproduces every shared sample", () => {
  for (const [name, sample] of Object.entries(RESPONSE.samples)) {
    test(`${name} matches the shared fixture exactly`, () => {
      const snapshot = SNAPSHOTS[name];
      assert.ok(snapshot, `test fixture missing for sample ${name}`);
      const projected = projectTransportHealth(snapshot, { now: frozenClock });
      // Byte-for-byte equality with the consumer's expectation.
      assert.deepEqual(projected, sample);
    });

    test(`${name} emits exactly the declared sections and fields`, () => {
      const projected = projectTransportHealth(SNAPSHOTS[name], { now: frozenClock });
      // Top level: neither missing nor extra.
      assert.deepEqual(Object.keys(projected).sort(), [...RESPONSE.topLevel].sort());
      // Every section: neither missing nor extra. This is what catches a field
      // added to the contract but not produced (or produced but not declared).
      for (const [section, fields] of Object.entries(RESPONSE.sections)) {
        assert.deepEqual(
          Object.keys(projected[section] ?? {}).sort(),
          [...fields].sort(),
          `section ${section} drifted from the contract`
        );
      }
    });
  }

  test("the deprecated age alias always equals the canonical field", () => {
    const projected = projectTransportHealth(SNAPSHOTS.android_pull_connected, { now: frozenClock });
    assert.equal(projected.device.age_ms, projected.device.last_seen_age_ms);
    assert.equal(projected.device.last_seen_age_ms, 3000);
  });

  test("a never-observed device reports null, not zero", () => {
    // "not measured" and "measured as zero" must not be confused.
    const projected = projectTransportHealth(SNAPSHOTS.android_unconfigured, { now: frozenClock });
    assert.equal(projected.device.last_seen_at, null);
    assert.equal(projected.device.last_seen_age_ms, null);
    assert.equal(projected.device.age_ms, null);
  });

  test("chrome never borrows Android's presence timestamps", () => {
    const projected = projectTransportHealth(
      SNAPSHOTS.chrome_active_with_android_diagnostics, { now: frozenClock });
    assert.equal(projected.transport.active, "chrome");
    assert.equal(projected.device.last_seen_at, null);
    assert.equal(projected.device.last_seen_age_ms, null);
    // Android is still visible, but only as declared non-authoritative data.
    assert.equal(projected.diagnostics.androidPull.authoritative, false);
    assert.equal(projected.diagnostics.androidPull.last_seen_age_ms, STALE_PULL_AGE_MS);
  });

  test("the projection is pure and never mutates the snapshot", () => {
    const snapshot = JSON.parse(JSON.stringify(SNAPSHOTS.android_pull_connected));
    const before = JSON.stringify(snapshot);
    projectTransportHealth(snapshot, { now: frozenClock });
    assert.equal(JSON.stringify(snapshot), before);
  });
});

describe("the projection exposes nothing private", () => {
  const forbidden = RESPONSE.forbiddenFields;

  test("no forbidden field name appears anywhere in the response", () => {
    for (const snapshot of Object.values(SNAPSHOTS)) {
      const serialized = JSON.stringify(projectTransportHealth(snapshot, { now: frozenClock }));
      for (const field of forbidden) {
        assert.equal(serialized.includes(`"${field}"`), false,
          `forbidden field ${field} leaked into the response`);
      }
    }
  });

  test("an over-rich snapshot cannot leak extra fields by default", () => {
    // Explicit field selection, never a spread: a field added to the snapshot
    // later must not appear in the consumer response automatically.
    const leaky = {
      ...SNAPSHOTS.android_pull_connected,
      deviceKey: "gmw_secret_device_key",
      masterToken: "master-secret",
      to: "+989121234567",
      text: "private message body",
      conversationId: "conv-1"
    };
    const projected = projectTransportHealth(leaky, { now: frozenClock });
    assert.deepEqual(projected, RESPONSE.samples.android_pull_connected);
    const serialized = JSON.stringify(projected);
    assert.equal(serialized.includes("gmw_secret_device_key"), false);
    assert.equal(serialized.includes("master-secret"), false);
    assert.equal(serialized.includes("+989121234567"), false);
    assert.equal(serialized.includes("private message body"), false);
  });
});

describe("the response schema cannot strip a declared field", () => {
  test("every declared top-level key is described by the schema", () => {
    const properties = responseSchemaProperties();
    assert.deepEqual(Object.keys(properties).sort(), [...RESPONSE.topLevel].sort());
  });

  test("every declared section field is named in the schema", () => {
    const properties = responseSchemaProperties();
    for (const [section, fields] of Object.entries(RESPONSE.sections)) {
      const declared = properties[section]?.properties ?? {};
      for (const field of fields) {
        assert.ok(field in declared,
          `schema for ${section} omits declared field ${field}; Fastify would strip it`);
      }
    }
  });
});

describe("the response survives Fastify's response serializer", () => {
  // Fastify strips every property the response schema does not declare, so a
  // declared field that the schema omits would silently never reach the
  // consumer. This drives a minimal Fastify instance with the SAME derived
  // schema and the projection as its handler.
  //
  // It deliberately does not boot src/server: the production app opens
  // background handles (queue, browser client, pacing timers) that outlive
  // app.close() and keep the test runner alive. The HTTP status behaviour
  // (401 unauthenticated, 403 project_scope_denied, 200 with the scope) is
  // covered by the scope mapping tests above and by test/eveContract.test.js,
  // which boots the real server and asserts that exact 403 shape.
  test("every declared field reaches the wire", async (t) => {
    const Fastify = require("fastify");
    const app = Fastify();
    app.get("/eve/v1/transport-health", {
      schema: { response: { 200: { type: "object", properties: responseSchemaProperties() } } }
    }, async () => projectTransportHealth(SNAPSHOTS.android_pull_connected, { now: frozenClock }));
    t.after(async () => { await app.close(); });

    const response = await app.inject({ method: "GET", url: "/eve/v1/transport-health" });
    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json();
    assert.deepEqual(Object.keys(body).sort(), [...RESPONSE.topLevel].sort());
    for (const [section, fields] of Object.entries(RESPONSE.sections)) {
      assert.deepEqual(Object.keys(body[section] ?? {}).sort(), [...fields].sort(), section);
    }
    // The whole sample, after a real serialize/deserialize round trip.
    assert.deepEqual(body, RESPONSE.samples.android_pull_connected);
  });
});

describe("the production server wires the route to this contract", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");

  test("server.js registers the route with the contract-derived schema", () => {
    assert.ok(source.includes('app.get("/eve/v1/transport-health"'),
      "the production server must register the consumer transport-health route");
    assert.ok(source.includes("eveTransportHealthSchema()"),
      "the route response schema must be derived from the shared contract, not hand-written");
    assert.ok(source.includes("projectTransportHealth(await transportHealth.snapshot())"),
      "the route must project the ONE authoritative snapshot rather than re-deriving health");
  });

  test("the route is not under an admin-only prefix", () => {
    // /admin/... is master-token-only, so a project key could never read it.
    const prefixes = source.match(/const ADMIN_ONLY_PREFIXES = \[[^\]]*\]/);
    assert.ok(prefixes, "ADMIN_ONLY_PREFIXES must stay greppable");
    assert.equal(prefixes[0].includes("/eve"), false,
      "an admin-only /eve prefix would make the scoped key unusable");
  });
});
