"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DeviceKeyStore } = require("../src/deviceKey");

test("identity bootstrap mismatch returns an actionable masked reason", () => {
  const store = new DeviceKeyStore({ filePath: "unused", envValue: "" });
  store.key = "devk_abcdefghijklmnopqrstuvwxyz";
  const failure = store.authFailure();
  assert.equal(failure.reason, "device_key_mismatch");
  assert.equal(failure.expectedKeyPreview.endsWith("wxyz"), true);
  assert.equal(JSON.stringify(failure).includes(store.key), false);
});

test("missing server device key is distinguished from mismatch", () => {
  const store = new DeviceKeyStore({ filePath: "unused", envValue: "" });
  assert.deepEqual(store.authFailure(), {
    error: "unauthorized",
    reason: "device_key_not_configured",
    expectedKeyPreview: null,
  });
});
