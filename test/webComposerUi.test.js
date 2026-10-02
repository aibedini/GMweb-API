"use strict";
// §52 composer / conversation-list presentation rules.
//
// These cover the pure rules that the redesigned HeroUI composer and thread
// depend on: the single send-enablement gate, the SIM selection sentinel,
// segmentation for every script the app must support, and the date-grouping
// presentation transform. The React rendering itself is exercised in the
// browser acceptance pass, not here.
const test = require("node:test");
const assert = require("node:assert/strict");

const GATE = { sending: false, canSend: true, simInstructions: null };

test("send is disabled for an empty or whitespace-only draft", async () => {
  const { sendDisabled } = await import("../web/src/lib/inboxActions.ts");
  assert.equal(sendDisabled({ ...GATE, draft: "" }), true);
  assert.equal(sendDisabled({ ...GATE, draft: " " }), true);
  assert.equal(sendDisabled({ ...GATE, draft: "   \n\t\r  " }), true);
  assert.equal(sendDisabled({ ...GATE, draft: "\u200b" }), false, "a zero-width space is still content");
});

test("send is enabled only when the capability and SIM state allow it", async () => {
  const { sendDisabled } = await import("../web/src/lib/inboxActions.ts");
  assert.equal(sendDisabled({ ...GATE, draft: "hello" }), false);
  assert.equal(sendDisabled({ ...GATE, draft: "سلام" }), false);
  assert.equal(sendDisabled({ ...GATE, draft: "hello", sending: true }), true, "no duplicate send while sending");
  assert.equal(sendDisabled({ ...GATE, draft: "hello", canSend: false }), true, "SEND_MESSAGES missing blocks send");
  assert.equal(
    sendDisabled({ ...GATE, draft: "hello", simInstructions: "Your phone's SIM information is out of date. Reconnect the Primary phone, then retry." }),
    true,
    "stale SIM blocks send",
  );
});

test("SIM help states follow the existing domain rules, including refresh", async () => {
  const { simHelp } = await import("../web/src/lib/inboxActions.ts");
  const now = 1_700_000_000_000;
  assert.match(simHelp(null, true, now), /Waiting for your phone/);
  assert.match(simHelp({ receivedAt: now - 180_001 }, true, now), /out of date/);
  assert.equal(
    simHelp({ receivedAt: now - 180_000, smsSubscriptions: { available: true } }, true, now),
    null,
    "telemetry exactly at the freshness boundary is still accepted",
  );
  assert.match(simHelp({ receivedAt: now }, true, now), /has not reported its SIMs/);
  assert.match(
    simHelp({ receivedAt: now - 180_001, smsSubscriptions: { available: true } }, true, now),
    /out of date/,
    "a stale subscription block is reported as out of date, not as missing",
  );
  assert.match(
    simHelp({ receivedAt: now, smsSubscriptions: { available: false } }, true, now),
    /Allow Phone permission/,
  );
  assert.match(
    simHelp({ receivedAt: now, smsSubscriptions: { available: true } }, false, now),
    /Choose an active SMS SIM/,
  );
  assert.equal(simHelp({ receivedAt: now, smsSubscriptions: { available: true } }, true, now), null);
});

test("single SIM, dual SIM and default SIM keep the null-subscription sentinel", async () => {
  const { selectSmsSim, simSelectValue, simSelectChoice, DEFAULT_SIM_KEY } =
    await import("../web/src/lib/simSelection.ts");
  const single = [{ subscriptionId: 7, isActive: true, isDefaultSms: true, sendCapable: true }];
  const dual = [
    { subscriptionId: 7, isActive: true, isDefaultSms: true, sendCapable: true },
    { subscriptionId: 9, isActive: true, isDefaultSms: false, sendCapable: true },
  ];
  const nodefault = [
    { subscriptionId: 7, isActive: true, isDefaultSms: false, sendCapable: true },
    { subscriptionId: 9, isActive: true, isDefaultSms: false, sendCapable: true },
  ];

  // Single SIM, nothing saved: the default is resolved and sent explicitly.
  assert.equal(selectSmsSim(single, null)?.subscriptionId, 7);
  assert.equal(simSelectValue(single, selectSmsSim(single, null), true), DEFAULT_SIM_KEY);
  assert.equal(simSelectChoice(DEFAULT_SIM_KEY), null, "Default maps back to a null subscriptionId");

  // Dual SIM with an explicit choice.
  assert.equal(selectSmsSim(dual, 9)?.subscriptionId, 9);
  assert.equal(simSelectValue(dual, selectSmsSim(dual, 9), false), "9");
  assert.equal(simSelectChoice("9"), 9);

  // Dual SIM with no default reported: show the resolved SIM, never "Default".
  assert.equal(selectSmsSim(nodefault, null)?.subscriptionId, 7);
  assert.equal(simSelectValue(nodefault, selectSmsSim(nodefault, null), true), "7");

  // A saved SIM that no longer exists resolves to nothing -> placeholder.
  assert.equal(selectSmsSim(dual, 999), undefined);
  assert.equal(simSelectValue(dual, undefined, false), null);
  assert.equal(simSelectChoice(null), null);

  // Inactive / send-incapable SIMs are rejected by selectSmsSim, so no draft
  // can be sent through a SIM the phone cannot use.
  const stale = [{ subscriptionId: 5, isActive: false, isDefaultSms: false }];
  assert.equal(selectSmsSim(stale, null), undefined);
  assert.equal(simSelectChoice(undefined), null);
});

test("no SIM telemetry keeps sending blocked and reports no SIMs", async () => {
  const { simHelp } = await import("../web/src/lib/inboxActions.ts");
  const { selectSmsSim, simSelectValue } = await import("../web/src/lib/simSelection.ts");
  const now = 1_700_000_000_000;
  const telemetry = { receivedAt: now };
  assert.match(simHelp(telemetry, false, now), /has not reported its SIMs/);
  assert.equal(selectSmsSim([], null), undefined);
  assert.equal(simSelectValue([], undefined, true), null);
});

test("SMSCounter segments GSM-7, UCS-2 and multiline drafts honestly", async () => {
  const { calculateSmsSegments } = await import("../web/src/lib/smsSegments.ts");

  // GSM-7 single and multipart.
  assert.deepEqual(
    { encoding: calculateSmsSegments("hello").encoding, units: calculateSmsSegments("hello").units, segments: calculateSmsSegments("hello").segments },
    { encoding: "GSM-7", units: 5, segments: 1 },
  );
  assert.equal(calculateSmsSegments("a".repeat(161)).segments, 2);

  // GSM-7 extension characters cost two units.
  assert.equal(calculateSmsSegments("^".repeat(80)).units, 160);

  // Multiline stays GSM-7 because \n is in the basic set.
  assert.equal(calculateSmsSegments("line one\nline two\nline three").encoding, "GSM-7");

  // Persian forces UCS-2 (70 / 67 boundaries).
  const persian = "سلام دنیا";
  assert.equal(calculateSmsSegments(persian).encoding, "Unicode");
  assert.equal(calculateSmsSegments("س".repeat(70)).segments, 1);
  assert.equal(calculateSmsSegments("س".repeat(71)).segments, 2);

  // Emoji are surrogate pairs: count as two units, never split into garbage.
  const emoji = "🙂";
  assert.equal(calculateSmsSegments(emoji).encoding, "Unicode");
  assert.equal(calculateSmsSegments(emoji).units, 2);
  assert.equal(calculateSmsSegments(emoji.repeat(35)).units, 70);
  assert.equal(calculateSmsSegments(emoji.repeat(35)).segments, 1, "70 UCS-2 units is exactly one segment");
  assert.equal(calculateSmsSegments(emoji.repeat(36)).segments, 2);

  // Mixed Persian/English is UCS-2 end to end.
  assert.equal(calculateSmsSegments("hello سلام world").encoding, "Unicode");

  // Empty draft reports no segments (the counter stays hidden).
  assert.equal(calculateSmsSegments("").segments, 0);
});

test("Enter, Ctrl/Cmd+Enter and IME composition keep their exact semantics", async () => {
  const { shouldSendMessage } = await import("../shared/smsComposer.ts");
  const base = { key: "Enter", ctrlKey: false, metaKey: false, isComposing: false };
  assert.equal(shouldSendMessage(base), false, "plain Enter inserts a newline");
  assert.equal(shouldSendMessage({ ...base, shiftKey: true }), false, "Shift+Enter inserts a newline");
  assert.equal(shouldSendMessage({ ...base, ctrlKey: true }), true);
  assert.equal(shouldSendMessage({ ...base, metaKey: true }), true);
  assert.equal(shouldSendMessage({ ...base, ctrlKey: true, isComposing: true }), false, "IME must not send");
  assert.equal(shouldSendMessage({ ...base, metaKey: true, isComposing: true }), false, "IME must not send");
  assert.equal(shouldSendMessage({ ...base, key: "a", ctrlKey: true }), false);
});

test("command lifecycle text maps to a pending/ok/failed tone without changing semantics", async () => {
  const { commandTone, commandFeedback } = await import("../web/src/lib/inboxActions.ts");
  for (const pending of [
    "Preparing send…",
    "Encrypting…",
    "Queued locally",
    "Accepted by GMweb; waiting for phone",
    "Pulled by phone",
    "Submitting",
    "Queued",
    "Command completed; waiting for Android evidence",
    "Previous send pending; waiting for phone",
    "Recovering pending send",
  ]) {
    assert.equal(commandTone(pending), "pending", pending);
  }
  for (const ok of ["delivered", "sent", "COMMAND_COMPLETED"]) {
    assert.equal(commandTone(ok), "ok", ok);
  }
  for (const failed of [
    "COMMAND_FAILED",
    "COMMAND_EXPIRED",
    "COMMAND_POLL_FAILED",
    "ENCRYPTION_FAILED",
    "LOCAL_OUTBOX_FAILED",
    "BROWSER_IDENTITY_UNAVAILABLE",
    "DEVICE_COMMAND_KEY_UNAVAILABLE",
    "SEND_CAPABILITY_MISSING",
    "SIM_STATE_UNAVAILABLE",
    "SELECTED_SIM_UNAVAILABLE",
    "EMPTY_BODY",
    "NO_RECIPIENT",
    "Pending send needs retry",
    "Failed · Carrier rejected message",
  ]) {
    assert.equal(commandTone(failed), "failed", failed);
  }
  assert.equal(commandFeedback(null), null);
  assert.match(commandFeedback("COMMAND_FAILED"), /phone could not complete/);
});

test("message status labels come from the real Android status values only", async () => {
  const { messageStatusLabel } = await import("../web/src/app/components/format.ts");
  assert.equal(messageStatusLabel(0), "Delivered");
  assert.equal(messageStatusLabel(32), "Queued");
  assert.equal(messageStatusLabel(64), "Failed");
  assert.equal(messageStatusLabel(1), "Sent");
  assert.equal(messageStatusLabel(undefined), null, "unknown status is not invented");
});

test("day separators group by real payload timestamps without mutating them", async () => {
  const { withDaySeparators, dayKey, formatDayLabel } = await import("../web/src/app/components/format.ts");
  const today = Date.now();
  const yesterday = today - 86_400_000;
  const older = new Date("2026-09-28T12:00:00").getTime();

  const items = [
    { key: "a", direction: "in", body: "old", dateMs: older },
    { key: "b", direction: "out", body: "old 2", dateMs: older + 60_000 },
    { key: "c", direction: "in", body: "yesterday", dateMs: yesterday },
    { key: "d", direction: "in", body: "today", dateMs: today },
  ];
  const snapshot = JSON.stringify(items);

  const rows = withDaySeparators(items);
  assert.equal(rows.filter((row) => row.kind === "day").length, 3, "one separator per calendar day");
  assert.equal(rows.filter((row) => row.kind === "message").length, 4);
  assert.equal(rows[0].kind, "day");
  assert.equal(rows[1].kind, "message");
  assert.equal(rows[rows.length - 1].item.key, "d");
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, "virtualizer keys are unique");

  assert.equal(formatDayLabel(today), "Today");
  assert.equal(formatDayLabel(yesterday), "Yesterday");
  assert.equal(dayKey(older), dayKey(older + 60_000), "same calendar day shares a bucket");
  assert.equal(JSON.stringify(items), snapshot, "the transform never mutates stored events");

  assert.deepEqual(withDaySeparators([]), []);
});
