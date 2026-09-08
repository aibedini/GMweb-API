const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fixture = require("../shared/trust-statement-jvm-fixture.json");

test("Android JVM trust-statement canonical bytes and DER signature verify in Node", () => {
  const bytes = Buffer.from(fixture.canonicalBase64, "base64");
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
  const key = crypto.createPublicKey({
    key: Buffer.from(fixture.rootPublicKey, "base64"),
    format: "der",
    type: "spki",
  });
  assert.equal(crypto.verify("sha256", bytes, key, Buffer.from(fixture.rootSignature, "base64")), true);
});
