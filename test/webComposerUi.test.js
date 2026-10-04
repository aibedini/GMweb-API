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

test("structured send readiness replaces the legacy simHelp gating", async () => {
  const { deriveSendReadiness, sendBlocked, sendReadinessNotice, commandSubscriptionId, defaultModeFreshnessNotice } =
    await import("../web/src/lib/sendReadiness.ts");

  const SIM_A = { subscriptionId: 7, slotIndex: 0, displayName: "SIM 1", carrierName: "Irancell",
    isDefaultSms: true, isActive: true, sendCapable: true };
  const SIM_B = { subscriptionId: 9, slotIndex: 1, displayName: "SIM 2", carrierName: "IR-MCI",
    isDefaultSms: false, isActive: true, sendCapable: true };
  const sim = (over = {}) => ({ state: "OK", active: [SIM_A, SIM_B], ...over });
  const base = {
    draft: "hello", hasRecipient: true, canSend: true, sending: false,
    phonePresence: "ONLINE", telemetryFreshness: "FRESH",
    sim: sim(), selectedSubscriptionId: null,
  };

  // PHONE_DEFAULT with stale telemetry is ALLOWED — this was the production bug.
  const staleDefault = deriveSendReadiness({ ...base, telemetryFreshness: "OLD" });
  assert.equal(staleDefault.state, "READY_DEFAULT");
  assert.equal(sendBlocked(staleDefault), false, "stale SIM telemetry must not block Phone default");
  // ...and the freshness note is informational, never an "offline" alarm.
  const note = defaultModeFreshnessNotice("OLD", "SIM 2 · IR-MCI");
  assert.equal(note.blocking, false);
  assert.doesNotMatch(note.message, /offline|reconnect/i);
  assert.match(note.message, /outdated/i);

  // EXPLICIT SIM with stale telemetry is BLOCKED, with a truthful reason.
  const staleExplicit = deriveSendReadiness({ ...base, telemetryFreshness: "OLD", selectedSubscriptionId: 9 });
  assert.equal(staleExplicit.state, "EXPLICIT_SIM_TELEMETRY_STALE");
  assert.equal(sendBlocked(staleExplicit), true);
  assert.match(sendReadinessNotice(staleExplicit).message, /outdated/i);
  assert.doesNotMatch(sendReadinessNotice(staleExplicit).message, /offline/i);

  // Fresh + still-active explicit SIM is ready.
  assert.deepEqual(deriveSendReadiness({ ...base, selectedSubscriptionId: 9 }),
    { state: "READY_EXPLICIT", subscriptionId: 9 });
  // Fresh + vanished explicit SIM fails closed (no silent fallback).
  assert.equal(deriveSendReadiness({ ...base, selectedSubscriptionId: 999 }).state, "EXPLICIT_SIM_MISSING");

  // A live phone is never "offline" just because telemetry is old.
  for (const presence of ["ONLINE", "STALE", "OFFLINE"]) {
    const readiness = deriveSendReadiness({ ...base, phonePresence: presence, telemetryFreshness: "OLD" });
    assert.doesNotMatch(sendReadinessNotice(readiness)?.message ?? "", /offline|Reconnect the Primary phone/i,
      `${presence} + old telemetry must not claim the phone is offline`);
  }

  // No active SIM is only authoritative while telemetry is FRESH.
  assert.equal(deriveSendReadiness({ ...base, sim: sim({ state: "NO_ACTIVE_SUBSCRIPTIONS", active: [] }) }).state,
    "NO_ACTIVE_SIM");
  assert.equal(deriveSendReadiness({ ...base, telemetryFreshness: "OLD",
    sim: sim({ state: "NO_ACTIVE_SUBSCRIPTIONS", active: [] }) }).state,
    "READY_DEFAULT", "a stale empty list must not block Phone default");

  // PHONE_DEFAULT must OMIT subscriptionId; EXPLICIT must carry it exactly.
  assert.equal(commandSubscriptionId(null), undefined);
  assert.equal(commandSubscriptionId(9), 9);

  // Precondition ordering.
  assert.equal(deriveSendReadiness({ ...base, draft: "   " }).state, "EMPTY_BODY");
  assert.equal(deriveSendReadiness({ ...base, hasRecipient: false }).state, "NO_RECIPIENT");
  assert.equal(deriveSendReadiness({ ...base, canSend: false }).state, "SEND_CAPABILITY_MISSING");
  assert.equal(deriveSendReadiness({ ...base, phonePresence: "NEVER_SEEN" }).state, "PHONE_NEVER_SEEN");
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

test("no SIM telemetry keeps the selector showing Phone default and reports no SIMs", async () => {
  const { selectSmsSim, simSelectValue } = await import("../web/src/lib/simSelection.ts");
  const { deriveSendReadiness } = await import("../web/src/lib/sendReadiness.ts");
  const now = 1_700_000_000_000;
  const telemetry = { receivedAt: now };
  assert.equal(selectSmsSim([], null), undefined);
  assert.equal(simSelectValue([], undefined, true), null);
  // With no SIM data at all, Phone default is still the safe option.
  assert.equal(deriveSendReadiness({
    draft: "x", hasRecipient: true, canSend: true, sending: false,
    phonePresence: "ONLINE", telemetryFreshness: "NEVER_REPORTED",
    sim: { state: "NOT_REPORTED", active: [] }, selectedSubscriptionId: null,
  }).state, "READY_DEFAULT");
  assert.ok(telemetry.receivedAt);
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
