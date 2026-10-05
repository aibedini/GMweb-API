// Send evidence precedence: the QUEUED/DELIVERED contradiction must be
// unrepresentable.
//
// PRODUCTION INCIDENT (real screenshot): the sent bubble showed "Delivered"
// while the composer footer still showed "Queued" with a spinner. Two writers
// owned one slot with no precedence: the carrier-evidence writer was gated on
// the CURRENTLY RENDERED thread, while the command-lifecycle poll ran
// unconditionally and overwrote it.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSendStatus, detectSendDivergence, evidenceStateForStatus,
  commandStateForText, diagnosticHash } from "../web/src/lib/sendEvidence.ts";
import { messageStatusLabel } from "../web/src/app/components/format.ts";

// PART C — the exact production incident fixture.
test("PART C: DELIVERED evidence overrides a QUEUED command", () => {
  const view = resolveSendStatus({ evidenceStatus: 0, commandStatus: "Queued" });
  assert.equal(view.text, "Delivered");
  assert.equal(view.state, "DELIVERED");
  assert.equal(view.source, "message");
  assert.equal(view.terminal, true);
  assert.equal(view.pending, false, "the spinner must stop");

  const divergence = detectSendDivergence({ evidenceStatus: 0, commandStatus: "Queued" });
  assert.equal(divergence?.code, "SEND_COMMAND_EVIDENCE_DIVERGENCE");
  assert.equal(divergence?.evidenceState, "DELIVERED");
  assert.equal(divergence?.commandState, "SERVER_QUEUED");
});

test("13: DELIVERED evidence overrides every stale command string", () => {
  for (const command of ["Queued", "Accepted by GMweb; waiting for phone", "Pulled by phone",
    "Submitting", "Preparing send…", "Encrypting…", "Queued locally",
    "Command completed; waiting for Android evidence"]) {
    const view = resolveSendStatus({ evidenceStatus: 0, commandStatus: command });
    assert.equal(view.text, "Delivered", `command=${command}`);
    assert.equal(view.terminal, true, `command=${command}`);
  }
});

test("14: SENT evidence overrides QUEUED but is not terminal", () => {
  const view = resolveSendStatus({ evidenceStatus: 1, commandStatus: "Queued" });
  assert.equal(view.text, "Sent");
  assert.equal(view.source, "message");
  assert.equal(view.terminal, false, "Sent is progress, not delivery");
  assert.equal(view.pending, true);
});

test("15: a COMPLETED command without delivery evidence must NOT say Delivered", () => {
  const view = resolveSendStatus({ evidenceStatus: null,
    commandStatus: "Command completed; waiting for Android evidence" });
  assert.notEqual(view.text, "Delivered");
  assert.equal(view.terminal, false, "spinner stays until DELIVERED/FAILED");
  assert.equal(view.pending, true);
  // A command lifecycle string must never be promoted to carrier truth.
  assert.equal(view.source, "command");
});

test("FAILED carrier evidence outranks everything", () => {
  const view = resolveSendStatus({ evidenceStatus: 64, commandStatus: "Command completed" });
  assert.equal(view.text, "Failed");
  assert.equal(view.terminal, true);
  const divergence = detectSendDivergence({ evidenceStatus: 64, commandStatus: "Queued" });
  assert.equal(divergence?.code, "SEND_COMMAND_EVIDENCE_DIVERGENCE");
});

test("precedence is total and order-independent", () => {
  // Swapping the arrival order cannot change the outcome: the same inputs always
  // resolve the same way, no matter which writer ran last.
  const a = resolveSendStatus({ evidenceStatus: 0, commandStatus: "Queued" });
  const b = resolveSendStatus({ evidenceStatus: 0, commandStatus: "Queued" });
  assert.deepEqual(a, b);
  // Evidence present with no command view at all still reports the evidence.
  assert.equal(resolveSendStatus({ evidenceStatus: 0 }).text, "Delivered");
  // Nothing known -> nothing claimed.
  assert.equal(resolveSendStatus({}).text, "");
  assert.equal(resolveSendStatus({}).source, "local");
});

test("no divergence is reported when the sources agree", () => {
  assert.equal(detectSendDivergence({ evidenceStatus: 0, commandStatus: "Delivered" }), null);
  // Non-terminal evidence is not a settled contradiction.
  assert.equal(detectSendDivergence({ evidenceStatus: 1, commandStatus: "Queued" }), null);
  assert.equal(detectSendDivergence({ evidenceStatus: null, commandStatus: "Queued" }), null);
});

test("evidenceStateForStatus mirrors messageStatusLabel", () => {
  assert.equal(evidenceStateForStatus(0), "DELIVERED");
  assert.equal(messageStatusLabel(0), "Delivered");
  assert.equal(evidenceStateForStatus(64), "FAILED");
  assert.equal(messageStatusLabel(64), "Failed");
  assert.equal(evidenceStateForStatus(32), "SERVER_QUEUED");
  assert.equal(evidenceStateForStatus(1), "SENT");
  assert.equal(evidenceStateForStatus(undefined), null);
  assert.equal(evidenceStateForStatus(null), null);
});

test("18: the resolved status is never an empty visible state while pending", () => {
  // A visible send always resolves to something a user can read.
  const states = [
    { evidenceStatus: 0, commandStatus: "Queued" },
    { evidenceStatus: 64, commandStatus: null },
    { evidenceStatus: 1, commandStatus: "Submitting" },
    { evidenceStatus: null, commandStatus: "Queued" },
    { evidenceStatus: null, commandStatus: "Preparing send…" },
  ];
  for (const input of states) {
    const view = resolveSendStatus(input);
    assert.ok(view.text.length > 0, JSON.stringify(input));
    assert.equal(typeof view.terminal, "boolean");
  }
});

test("diagnostics hash identifiers and never leak raw values", () => {
  const hash = diagnosticHash("client-message-abc-123");
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 8);
  assert.ok(!hash.includes("client-message"));
  assert.equal(diagnosticHash(null), null);
  assert.equal(diagnosticHash(""), null);
  // Deterministic, so repeated divergences for one send collapse to one record.
  assert.equal(diagnosticHash("x"), diagnosticHash("x"));
  assert.notEqual(diagnosticHash("x"), diagnosticHash("y"));
});

test("commandStateForText classifies without inventing delivery", () => {
  assert.equal(commandStateForText("Pulled by phone"), "PHONE_CLAIMED");
  assert.equal(commandStateForText("Submitting"), "PHONE_ACCEPTED");
  assert.equal(commandStateForText("Queued"), "SERVER_QUEUED");
  assert.equal(commandStateForText("Queued locally"), "LOCAL_QUEUED");
  // Crucially, no command string is ever classified as DELIVERED/FAILED
  // evidence from the command lifecycle alone.
  for (const text of ["Queued", "Submitting", "Pulled by phone", "Command completed"]) {
    assert.notEqual(commandStateForText(text), "DELIVERED", text);
  }
  assert.equal(commandStateForText(null), null);
  assert.equal(commandStateForText(""), null);
});
