"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fixture = require("../shared/pairing-protocol-v1.json");
const protocol = require("../shared/pairingProtocol.mjs");
for (const v of fixture.vectors) {
  test(`fixed ${v.kind} bytes, hash and signature`, () => {
    const encode = protocol[`canonical${v.kind[0].toUpperCase()}${v.kind.slice(1)}`];
    const bytes = Buffer.from(encode(v.input));
    assert.equal(bytes.toString("base64"), v.canonicalBase64);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), v.sha256);
    assert.equal(crypto.verify("sha256", bytes, crypto.createPublicKey({key:Buffer.from(fixture.trustRootPublicKey,"base64"),format:"der",type:"spki"}), Buffer.from(v.signature,"base64")), true);
  });
}
test("TypeScript browser verifier reads the same static certificate fixture", async () => {
  const web = await import("../web/src/lib/trustRoot.ts");
  const v = fixture.vectors.find(v => v.kind === "certificate");
  assert.equal(Buffer.from(web.canonicalCertificate(v.input)).toString("base64"), v.canonicalBase64);
  const cert = {...v.input,rootSignature:v.signature};
  assert.equal(await web.verifyRootSignature(cert,fixture.trustRootPublicKey),true);
  for (const field of ["deviceId","apiOrigin","webOrigin","pairingSessionId","pairingTranscriptHash","signingPublicKey"]) {
    assert.equal(await web.verifyRootSignature({...cert,[field]:"tampered"},fixture.trustRootPublicKey),false);
  }
});
test("ambiguous strings and non-integer protocol numbers are rejected", () => {
  const c=fixture.vectors[0].input;
  assert.throws(()=>protocol.canonicalCertificate({...c,deviceId:"\ud800"}));
  assert.throws(()=>protocol.canonicalCertificate({...c,trustSequence:1.1}));
  assert.throws(()=>protocol.canonicalCertificate({...c,capabilities:["READ_MESSAGES","READ_MESSAGES"]}));
});
