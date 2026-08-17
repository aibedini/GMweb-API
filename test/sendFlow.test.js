const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GoogleMessagesClient, normalizeComparableMessage } = require("../src/googleMessagesClient");
const { SendQueue } = require("../src/queue");
const { SendStore } = require("../src/sendStore");
const { sendSchedule, sendGate } = require("../src/sendSchedule");
const { normalizeSendPriority } = require("../src/sendPriority");

function client() {
  return new GoogleMessagesClient({
    sendMinIntervalMs: 1000,
    conversationHistoryMaxBatches: 2,
    conversationCacheFile: "./data/test-conversation-cache.json"
  });
}

test("priority aliases and numeric levels map to four canonical FIFO lanes", () => {
  assert.deepEqual(normalizeSendPriority("critical"), { name: "critical", level: 1, bypassQuietHours: true });
  assert.equal(normalizeSendPriority("high").name, "critical");
  assert.equal(normalizeSendPriority(2).name, "critical");
  assert.equal(normalizeSendPriority("expired").level, 3);
  assert.equal(normalizeSendPriority(4).name, "expired");
  assert.equal(normalizeSendPriority("normal").name, "expiring");
  assert.equal(normalizeSendPriority(undefined).name, "expiring");
  assert.equal(normalizeSendPriority(8).name, "expiring");
  assert.equal(normalizeSendPriority("announcement").level, 10);
  assert.equal(normalizeSendPriority(9).name, "announcement");
});

test("legacy conversation href is only a candidate and must be revalidated", async () => {
  const c = client();
  const stages = [];
  let existingCalls = 0;
  let startChatCalls = 0;
  c.ensurePage = async () => ({ url: () => "https://messages.google.com/web/conversations" });
  c.getCachedRecipientConversation = () => null;
  c.getLegacyRecipientCandidate = () => ({ href: "/web/conversations/legacy", title: "Saved name" });
  c.revalidateLegacyConversation = async (_to, candidate) => candidate.href.endsWith("legacy");
  c.openExistingConversation = async () => { existingCalls += 1; return false; };
  c.startChatFlow = async () => { startChatCalls += 1; return false; };

  const opened = await c.openForSend("+989121234567", (stage) => stages.push(stage));
  assert.equal(opened, true);
  assert.equal(existingCalls, 0);
  assert.equal(startChatCalls, 0);
  assert.deepEqual(stages, ["legacy_candidate_found"]);
});

test("rejected legacy candidate falls back to Start Chat and is not retried in later UI attempts", async () => {
  const c = client();
  let revalidations = 0;
  let startChatCalls = 0;
  c.ensurePage = async () => ({
    url: () => "https://messages.google.com/web/conversations/wrong",
    waitForTimeout: async () => {}
  });
  c.getCachedRecipientConversation = () => null;
  c.getLegacyRecipientCandidate = () => ({ href: "/web/conversations/wrong", title: "Saved name" });
  c.revalidateLegacyConversation = async () => { revalidations += 1; return false; };
  c.openExistingConversation = async () => false;
  c.startChatFlow = async () => { startChatCalls += 1; return false; };
  c.conversationCreationRateLimited = async () => false;
  c.openConversationByUrl = async () => false;

  assert.equal(await c.openForSend("+989121234567", () => {}, { restartNewConversation: false }), false);
  assert.equal(await c.openForSend("+989121234567", () => {}, { restartNewConversation: true }), false);
  assert.equal(revalidations, 1);
  assert.equal(startChatCalls, 2);
});

test("unpaired readiness failures are marked safe for pre-submit recovery", async () => {
  const c = client();
  c.pairedWaitMs = 0;
  c.closeRotationTabs = async () => {};
  c.page = { waitForTimeout: async () => {} };
  c.statusUnlocked = async () => ({
    paired: false,
    qrVisible: false,
    signInVisible: true,
    hint: "sign in to the controlled Chrome profile, then pair your phone",
    url: "https://messages.google.com/web/"
  });

  await assert.rejects(
    c.ensurePaired(),
    (error) => error.code === "GOOGLE_MESSAGES_NOT_READY" && error.details.signInVisible === true
  );
});

test("browser recovery can force a conversations reload before retry", async () => {
  const c = client();
  const navigations = [];
  c.withBrowserLock = async (action) => action();
  c.stopPolling = () => {};
  c.closeRotationTabs = async () => {};
  c.startUnlocked = async () => {
    c.page = {
      goto: async (url, options) => navigations.push({ url, options }),
      waitForLoadState: async () => {}
    };
  };

  const result = await c.recover({ reload: true });
  assert.equal(result.reloaded, true);
  assert.equal(navigations.length, 1);
  assert.match(navigations[0].url, /messages\.google\.com\/web\/conversations/);
});

test("send retries stay inside the SPA and defer after three UI misses", async () => {
  const c = client();
  assert(c.sendOperationTimeoutMs >= 220000);
  const attempts = [];
  let navigations = 0;
  const page = {
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    goto: async () => { navigations += 1; }
  };
  c.ensurePage = async () => page;
  c.ensurePaired = async () => {};
  c.openForSend = async (_to, _stage, options) => {
    attempts.push(options.restartNewConversation);
    return false;
  };

  await assert.rejects(
    c.sendMessageUnlocked({ to: "+989121234567", text: "hello" }),
    (error) => error.code === "CONVERSATION_OPEN_DEFER"
  );
  assert.deepEqual(attempts, [false, true, true]);
  assert.equal(navigations, 0);
});

test("a selected recipient without a composer is retried from Start chat", async () => {
  const c = client();
  let startChatClicks = 0;
  const stages = [];
  const input = {
    fill: async () => {},
    inputValue: async () => "+989121234567",
    press: async () => {},
    click: async () => {},
    type: async () => {}
  };
  c.ensurePage = async () => ({
    url: () => "https://messages.google.com/web/conversations/new",
    waitForTimeout: async () => {}
  });
  c.clickFirst = async () => { startChatClicks += 1; };
  c.locatorFirst = async () => input;
  c.clickRecipientOption = async () => ({ status: "selected", evidence: { cacheKey: "989121234567" } });

  const opened = await c.startChatFlow(
    "+989121234567",
    (stage) => stages.push(stage),
    { forceRestart: true }
  );
  assert.equal(opened, false);
  assert.equal(startChatClicks, 1);
  assert(stages.includes("restarting_start_chat"));
  assert(stages.includes("recipient_filled"));
});

test("typeAndSend confirms a matching outgoing bubble after one Enter", async () => {
  const c = client();
  let submits = 0;
  const input = { fill: async () => {}, press: async () => { submits += 1; } };
  const page = {
    waitForTimeout: async () => {},
    keyboard: { type: async () => {} }
  };
  c.ensurePage = async () => page;
  c.locatorFirst = async () => input;
  c.outgoingMessageMatches = async () => true;
  const result = await c.typeAndSend("hello   world");
  assert.equal(result.verified, true);
  assert.equal(result.verificationStatus, "confirmed_initial");
  assert.equal(submits, 1);
});

test("recipient option selection rejects a different phone number", async () => {
  const c = client();
  let clicked = false;
  const option = {
    evaluate: async () => "Send to +989351112233",
    click: async () => { clicked = true; }
  };
  c.ensurePage = async () => ({ url: () => "https://messages.google.com/web/conversations/new" });
  c.locatorFirst = async () => option;

  const selection = await c.clickRecipientOption("+989127096919");
  assert.equal(selection.status, "missing");
  assert.equal(selection.evidence, null);
  assert.equal(clicked, false);
});

test("conversation lookup never matches a phone number from the message preview", () => {
  const c = client();
  const conversation = {
    title: "+989127096919",
    snippet: "Renew v20909129177288?",
    text: "+989127096919 Renew v20909129177288?"
  };
  assert.equal(c.conversationMatchesRecipient(conversation, "+989127096919"), true);
  assert.equal(c.conversationMatchesRecipient(conversation, "+989129177288"), false);
});

test("send fails closed when the opened conversation has no recipient evidence", async () => {
  const c = client();
  c.ensurePage = async () => ({
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    url: () => "https://messages.google.com/web/conversations/wrong"
  });
  c.ensurePaired = async () => {};
  c.openForSend = async () => true;

  await assert.rejects(
    c.sendMessageUnlocked({ to: "+989127096919", text: "must not send" }),
    (error) => error.code === "RECIPIENT_UNVERIFIED"
  );
});

test("typeAndSend never assumes sent when bubble verification fails", async () => {
  const c = client();
  let submits = 0;
  const input = { fill: async () => {}, press: async () => { submits += 1; } };
  const page = {
    waitForTimeout: async () => {},
    keyboard: { type: async () => {} }
  };
  c.ensurePage = async () => page;
  c.locatorFirst = async () => input;
  c.outgoingMessageMatches = async () => false;
  c.sendVerificationInitialTimeoutMs = 0;
  const result = await c.typeAndSend("not sent");
  assert.equal(result.verified, false);
  assert.equal(result.submittedOnce, true);
  assert.equal(submits, 1);
});

test("message comparison ignores Google-injected bidi marks", () => {
  assert.equal(
    normalizeComparableMessage("حجم\u200f\n y47iman9750\u200b  رو به تمامه"),
    normalizeComparableMessage("حجم y47iman9750 رو به تمامه")
  );
});

test("an unverified submit presses Enter only once and never UI-retries", async () => {
  const c = client();
  let submits = 0;
  const stages = [];
  c.ensurePage = async () => ({
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    url: () => "https://messages.google.com/web/conversations/example"
  });
  c.ensurePaired = async () => {};
  c.openForSend = async () => true;
  c.activeSendRecipientEvidence = null;
  c.openForSend = async (to) => {
    c.activeSendRecipientEvidence = {
      cacheKey: c.recipientCacheKey(to), requestedTo: to, sentTo: to,
      source: "test", matchedVariant: c.recipientCacheKey(to), matchedText: to,
      conversationUrl: "https://messages.google.com/web/conversations/example"
    };
    return true;
  };
  c.lastOutgoingMatches = async () => false;
  c.typeAndSend = async () => {
    submits += 1;
    return {
      submittedOnce: true,
      submittedAt: "2026-08-16T16:00:00.000Z",
      verified: false,
      verificationStatus: "pending_recheck",
      verificationMethod: "outgoing_bubble_dom",
      verificationAttempts: 1
    };
  };
  c.verifySubmittedMessage = async () => ({ verified: false, attempts: 3, method: "outgoing_bubble_dom_recheck" });

  await assert.rejects(
    c.sendMessageUnlocked({
      to: "+989121234567", text: "one submission", onStage: (stage) => stages.push(stage)
    }),
    (error) => error.code === "SEND_UNVERIFIED"
  );
  assert.equal(submits, 1);
  assert.equal(stages.filter((stage) => stage === "typing").length, 1);
  assert(stages.includes("verification_pending"));
  assert(stages.includes("unverified_manual_review"));
  assert.equal(stages.some((stage) => stage.startsWith("ui_retry_")), false);
});

test("a delayed bubble is confirmed by verification-only retries without another Enter", async () => {
  const c = client();
  let submits = 0;
  const stages = [];
  c.ensurePage = async () => ({
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    url: () => "https://messages.google.com/web/conversations/example"
  });
  c.ensurePaired = async () => {};
  c.openForSend = async (to) => {
    c.activeSendRecipientEvidence = {
      cacheKey: c.recipientCacheKey(to), requestedTo: to, sentTo: to,
      source: "test", matchedVariant: c.recipientCacheKey(to), matchedText: to,
      conversationUrl: "https://messages.google.com/web/conversations/example"
    };
    return true;
  };
  c.lastOutgoingMatches = async () => false;
  c.typeAndSend = async () => {
    submits += 1;
    return {
      submittedOnce: true,
      submittedAt: "2026-08-16T16:00:00.000Z",
      verified: false,
      verificationStatus: "pending_recheck",
      verificationMethod: "outgoing_bubble_dom",
      verificationAttempts: 1
    };
  };
  c.verifySubmittedMessage = async (_text, { onAttempt }) => {
    onAttempt(1);
    return { verified: true, attempts: 1, method: "outgoing_bubble_dom_recheck" };
  };

  const result = await c.sendMessageUnlocked({
    to: "+989121234567", text: "one submission", onStage: (stage) => stages.push(stage)
  });
  assert.equal(submits, 1);
  assert.equal(result.submission.verificationStatus, "confirmed_after_recheck");
  assert.equal(result.submission.verificationAttempts, 2);
  assert(stages.includes("verification_pending"));
  assert(stages.includes("verification_retry_1"));
  assert(stages.includes("sent_after_recheck"));
});

test("a recent matching bubble prevents another Enter", async () => {
  const c = client();
  let submits = 0;
  const stages = [];
  c.ensurePage = async () => ({
    bringToFront: async () => {},
    url: () => "https://messages.google.com/web/conversations/example"
  });
  c.ensurePaired = async () => {};
  c.openForSend = async (to) => {
    c.activeSendRecipientEvidence = {
      cacheKey: c.recipientCacheKey(to), requestedTo: to, sentTo: to,
      source: "test", matchedVariant: c.recipientCacheKey(to), matchedText: to,
      conversationUrl: "https://messages.google.com/web/conversations/example"
    };
    return true;
  };
  c.lastOutgoingMatches = async () => true;
  c.typeAndSend = async () => { submits += 1; return true; };

  const result = await c.sendMessageUnlocked({
    to: "+989121234567", text: "already visible", onStage: (stage) => stages.push(stage)
  });
  assert.equal(result.type, "sent");
  assert.equal(result.requestedTo, "+989121234567");
  assert.equal(result.sentTo, "+989121234567");
  assert.equal(submits, 0);
  assert(stages.includes("already_sent"));
});

test("active cancellation stops before Enter", async () => {
  const c = client();
  let enterPresses = 0;
  const input = {
    fill: async () => {},
    press: async () => { enterPresses += 1; }
  };
  c.ensurePage = async () => ({
    evaluate: async () => 2,
    keyboard: { type: async () => {} }
  });
  c.locatorFirst = async () => input;

  await assert.rejects(
    c.typeAndSend("cancel me", { shouldCancel: () => true }),
    (error) => error.code === "SEND_CANCELLED"
  );
  assert.equal(enterPresses, 0);
});

test("conversation misses preserve their canonical priority lane", async () => {
  const q = Object.create(SendQueue.prototype);
  const enqueued = [];
  const zadds = [];
  q.enqueue = async (data, opts = {}) => {
    const job = { id: String(enqueued.length + 1), data, opts };
    enqueued.push(job);
    return job;
  };
  q._redis = async () => ({
    get: async () => "7",
    zadd: async (...args) => { zadds.push(args); }
  });

  const normal = await q.deferNormal({ to: "1", text: "n" });
  const high = await q.deferHigh({ to: "2", text: "h" }, 10);
  assert.equal(normal.job.opts.lifo, undefined);
  assert.equal(normal.job.data.priority, "expiring");
  assert.equal(normal.job.opts.priority, 6);
  assert.equal(high.job.data.priority, "critical");
  assert.equal(high.job.opts.priority, 1);
  assert.equal(high.job.opts.lifo, undefined);
  assert(high.job.opts.delay > 300 * 24 * 60 * 60 * 1000);
  assert.deepEqual(zadds[1], ["gmweb-send:deferred-high", 17, high.job.id]);
});

test("capacity counts canonical and legacy jobs across all pending states", async () => {
  const q = Object.create(SendQueue.prototype);
  const jobs = [
    { data: { priority: "critical" }, opts: { priority: 1 } },
    { data: { priority: "high" }, opts: { lifo: true } },
    { data: { priority: "expired" }, opts: { priority: 3 } },
    { data: { priority: "normal" }, opts: {} },
    { data: { priority: "announcement" }, opts: { priority: 10 } }
  ];
  q.queue = { getJobs: async () => jobs };

  assert.deepEqual(await q.pendingCountsByPriority(), {
    critical: 2,
    expired: 1,
    expiring: 1,
    announcement: 1
  });
  assert.equal(await q.countPendingByPriority("announcement"), 1);
});

test("queue position excludes the newly enqueued job and counts same-or-higher lanes", async () => {
  const q = Object.create(SendQueue.prototype);
  const makeJob = (id, priority) => ({ id, data: { priority }, opts: {} });
  q.queue = {
    getJobs: async ([state]) => state === "active"
      ? [makeJob("active", "expiring")]
      : [makeJob("critical", "critical"), makeJob("self", "expired"), makeJob("announcement", "announcement")]
  };

  assert.equal(await q.queuePositionForPriority("expired", "self"), 2);
});

test("bulk priority changes pending jobs in place and skips active jobs", async () => {
  const q = Object.create(SendQueue.prototype);
  let updatedData = null;
  let changedPriority = null;
  const waiting = {
    id: "waiting-1",
    data: { to: "+989000000001", priority: "expiring", priorityLevel: 6 },
    opts: { priority: 6 },
    getState: async () => "waiting",
    updateData: async (data) => { updatedData = data; waiting.data = data; },
    changePriority: async (options) => { changedPriority = options; }
  };
  const active = {
    id: "active-1",
    data: { priority: "expired" },
    opts: { priority: 3 },
    getState: async () => "active"
  };
  q.queue = { getJob: async (id) => id === "waiting-1" ? waiting : active };

  const changed = await q.changeJobPriority("waiting-1", "critical");
  assert.equal(changed.changed, true);
  assert.equal(changed.previousPriority, "expiring");
  assert.equal(changed.priority, "critical");
  assert.equal(updatedData.priority, "critical");
  assert.equal(updatedData.priorityLevel, 1);
  assert.deepEqual(changedPriority, { priority: 1 });

  const skipped = await q.changeJobPriority("active-1", "announcement");
  assert.deepEqual(skipped, { changed: false, reason: "active", state: "active" });
});

test("Tehran quiet hours block normal sends from 02:00 until 08:00", () => {
  const before = sendSchedule(new Date("2026-07-01T22:29:59.000Z")); // 01:59:59 Tehran
  const start = sendSchedule(new Date("2026-07-01T22:30:00.000Z"));  // 02:00 Tehran
  const middle = sendSchedule(new Date("2026-07-02T00:00:00.000Z")); // 03:30 Tehran
  const end = sendSchedule(new Date("2026-07-02T04:30:00.000Z"));    // 08:00 Tehran
  assert.equal(before.blocked, false);
  assert.equal(start.blocked, true);
  assert.equal(start.releaseAt.toISOString(), "2026-07-02T04:30:00.000Z");
  assert.equal(middle.blocked, true);
  assert.equal(middle.releaseAt.toISOString(), "2026-07-02T04:30:00.000Z");
  assert.equal(end.blocked, false);
  const high = sendGate(new Date("2026-07-02T00:00:00.000Z"), { highPriority: true });
  assert.equal(high.blocked, false);
  assert.equal(high.bypassed, true);
  const delayedHigh = sendGate(new Date("2026-07-02T00:00:00.000Z"), {
    highPriority: true,
    delayedRetry: true
  });
  assert.equal(delayedHigh.blocked, true);
  assert.equal(delayedHigh.bypassed, false);
});

test("quiet-hour deferral creates a durable delayed normal job", async () => {
  const q = Object.create(SendQueue.prototype);
  let added;
  q.enqueue = async (data, opts) => {
    added = { data, opts };
    return { id: "next", data, opts };
  };
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-02T00:00:00.000Z");
  try {
    await q.deferUntil({ to: "1", text: "normal" }, new Date("2026-07-02T04:30:00.000Z"), "quiet_hours");
  } finally {
    Date.now = realNow;
  }
  assert.equal(added.data.priority, "expiring");
  assert.equal(added.data.priorityLevel, 6);
  assert.equal(added.data.deferReason, "quiet_hours");
  assert.equal(added.opts.delay, 4.5 * 60 * 60 * 1000);
});

test("quiet-hour deferral preserves HIGH while delaying its retry", async () => {
  const q = Object.create(SendQueue.prototype);
  let added;
  q.enqueue = async (data, opts) => {
    added = { data, opts };
    return { id: "next-high", data, opts };
  };
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-02T00:00:00.000Z");
  try {
    await q.deferUntil(
      { to: "1", text: "retry", priority: "high" },
      new Date("2026-07-02T04:30:00.000Z"),
      "quiet_hours",
      { highPriority: true }
    );
  } finally {
    Date.now = realNow;
  }
  assert.equal(added.data.priority, "critical");
  assert.equal(added.data.priorityLevel, 1);
  assert.equal(added.data.deferReason, "quiet_hours");
  assert.equal(added.opts.priority, 1);
  assert.equal(added.opts.lifo, undefined);
  assert.equal(added.opts.delay, 4.5 * 60 * 60 * 1000);
});

test("bulk release moves only deferred HIGH jobs to the front, oldest first", async () => {
  const q = Object.create(SendQueue.prototype);
  const added = [];
  const removed = [];
  const forgotten = [];
  let paused = false;
  const makeJob = ({ id, timestamp, priority, state, deferCount = 0 }) => ({
    id, timestamp,
    data: { to: id, priority, deferCount },
    opts: {},
    getState: async () => state,
    remove: async () => { removed.push(id); }
  });
  const jobs = [
    makeJob({ id: "old-high", timestamp: 100, priority: "high", state: "delayed", deferCount: 1 }),
    makeJob({ id: "new-high", timestamp: 200, priority: "high", state: "waiting", deferCount: 1 }),
    makeJob({ id: "fresh-high", timestamp: 300, priority: "high", state: "waiting" }),
    makeJob({ id: "normal", timestamp: 400, priority: "normal", state: "delayed", deferCount: 1 })
  ];
  q.queue = {
    getJobs: async () => jobs,
    add: async (_name, data, opts) => {
      added.push({ data, opts });
      return { id: `released-${added.length}` };
    }
  };
  q.isPaused = async () => paused;
  q.pause = async () => { paused = true; };
  q.resume = async () => { paused = false; };
  q.forgetDeferredHigh = async (id) => { forgotten.push(String(id)); };

  const released = await q.releaseDeferredHighJobs();
  assert.deepEqual(removed, ["old-high", "new-high"]);
  assert.deepEqual(forgotten, ["old-high", "new-high"]);
  assert.deepEqual(added.map((entry) => entry.data.to), ["old-high", "new-high"]);
  assert.equal(added.every((entry) => entry.opts.priority === 1 && entry.opts.lifo === undefined), true);
  assert.equal("deferCount" in added[0].data, false);
  assert.deepEqual(released.map((entry) => entry.previousId), ["old-high", "new-high"]);
  assert.equal(paused, false);
});

test("queue dashboard lists jobs in worker processing order", async () => {
  const q = Object.create(SendQueue.prototype);
  const calls = [];
  const makeJob = (id, state) => ({
    id,
    data: { to: id, text: id, priority: "normal" },
    opts: { attempts: 3 },
    getState: async () => state
  });
  const byState = {
    active: [makeJob("active", "active")],
    waiting: [makeJob("promoted-high", "waiting"), makeJob("normal-next", "waiting")],
    paused: [],
    delayed: [makeJob("delayed", "delayed")]
  };
  q.queue = {
    getJobs: async ([state], start, end, asc) => {
      calls.push({ state, start, end, asc });
      return byState[state].slice(start, end + 1);
    }
  };

  const jobs = await q.listJobs({ limit: 3 });
  assert.deepEqual(jobs.map((job) => job.id), ["active", "promoted-high", "normal-next"]);
  assert.equal(calls.every((call) => call.asc === true), true);
  assert.deepEqual(calls.map((call) => call.state), ["active", "waiting"]);
});

test("queue dashboard can list the complete pending queue", async () => {
  const q = Object.create(SendQueue.prototype);
  const makeJob = (id, state) => ({
    id,
    data: { to: id, text: id, priority: "normal" },
    opts: { attempts: 3 },
    getState: async () => state
  });
  const byState = {
    active: [makeJob("active", "active")],
    waiting: [makeJob("waiting-1", "waiting"), makeJob("waiting-2", "waiting")],
    paused: [makeJob("paused", "paused")],
    delayed: [makeJob("delayed", "delayed")]
  };
  const calls = [];
  q.queue = {
    getJobs: async ([state], start, end, asc) => {
      calls.push({ state, start, end, asc });
      return end === -1 ? byState[state].slice(start) : byState[state].slice(start, end + 1);
    }
  };

  const jobs = await q.listJobs({ limit: null });
  assert.deepEqual(jobs.map((job) => job.id), ["active", "waiting-1", "waiting-2", "paused", "delayed"]);
  assert.equal(calls.every((call) => call.end === -1 && call.asc === true), true);
});

test("deferred HIGH count scans the complete pending queue", async () => {
  const q = Object.create(SendQueue.prototype);
  const makeJob = ({ priority, state, deferCount = 0, lifo = false }) => ({
    data: { priority, deferCount },
    opts: { lifo },
    getState: async () => state
  });
  q.queue = {
    getJobs: async () => [
      ...Array.from({ length: 100 }, () => makeJob({ priority: "normal", state: "waiting" })),
      makeJob({ priority: "high", state: "delayed", deferCount: 1 }),
      makeJob({ priority: "high", state: "waiting", deferCount: 2 }),
      makeJob({ priority: "high", state: "waiting" })
    ]
  };

  assert.equal(await q.countDeferredHighJobs(), 2);
});

test("single-job promotion clears delay markers and works for normal jobs", async () => {
  const q = Object.create(SendQueue.prototype);
  const forgotten = [];
  let removed = false;
  let added;
  q.queue = {
    getJob: async () => ({
      id: "normal-delayed",
      data: { to: "1", priority: "normal", deferCount: 2, deferReason: "quiet_hours" },
      getState: async () => "delayed",
      remove: async () => { removed = true; }
    }),
    add: async (_name, data, opts) => {
      added = { data, opts };
      return { id: "promoted" };
    }
  };
  q.forgetDeferredHigh = async (id) => { forgotten.push(String(id)); };

  const result = await q.promoteJob("normal-delayed");
  assert.equal(result.promoted, true);
  assert.equal(result.id, "promoted");
  assert.equal(removed, true);
  assert.deepEqual(forgotten, ["normal-delayed"]);
  assert.equal(added.data.priority, "critical");
  assert.equal(added.data.priorityLevel, 1);
  assert.equal("deferCount" in added.data, false);
  assert.equal("deferReason" in added.data, false);
  assert.equal(added.opts.lifo, true);
  assert.equal(added.opts.priority, undefined);
});

test("consumer cancel removes only pending jobs", async () => {
  const q = Object.create(SendQueue.prototype);
  const forgotten = [];
  let removedWaiting = false;
  const jobs = {
    waiting: {
      id: "waiting",
      getState: async () => "waiting",
      remove: async () => { removedWaiting = true; }
    },
    active: {
      id: "active",
      getState: async () => "active",
      remove: async () => { throw new Error("active job should not be removed"); }
    }
  };
  q.queue = { getJob: async (id) => jobs[id] || null };
  q.forgetDeferredHigh = async (id) => { forgotten.push(String(id)); };

  const waiting = await q.cancelPendingJob("waiting");
  const active = await q.cancelPendingJob("active");
  const missing = await q.cancelPendingJob("missing");

  assert.equal(waiting.cancelled, true);
  assert.equal(waiting.state, "waiting");
  assert.equal(removedWaiting, true);
  assert.deepEqual(forgotten, ["waiting"]);
  assert.equal(active.cancelled, false);
  assert.equal(active.reason, "active");
  assert.equal(missing.cancelled, false);
  assert.equal(missing.reason, "not_found");
});

test("previous-year timestamps stop sidebar warm-up", () => {
  const c = client();
  assert.equal(c.timestampIsBeforeCurrentYear("Jun 30"), false);
  assert.equal(c.timestampIsBeforeCurrentYear(String(new Date().getFullYear() - 1)), true);
});

test("dashboard status refresh is single-flight and skipped during sidebar warm-up", async () => {
  const c = client();
  c.lastStatus = { paired: true };
  c.lastStatusAt = 0;
  let calls = 0;
  let release;
  c.status = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return { paired: true };
  };

  c.sidebarIndexWarmPromise = Promise.resolve();
  await c.statusForDashboard({ maxAgeMs: 0 });
  assert.equal(calls, 0);

  c.sidebarIndexWarmPromise = null;
  await c.statusForDashboard({ maxAgeMs: 0 });
  await c.statusForDashboard({ maxAgeMs: 0 });
  assert.equal(calls, 1);
  release();
  await c.statusRefreshPromise;
});

test("browser lock timeout includes time spent waiting for the previous owner", async () => {
  const c = client();
  c.actionLock = new Promise(() => {});
  const started = Date.now();
  await assert.rejects(
    c.withBrowserLock(async () => true, { timeoutMs: 30 }),
    /browser_lock_wait_timeout/
  );
  assert(Date.now() - started < 500);
});

test("idempotent sends receive a complete durable SQLite timeline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-send-store-"));
  const store = new SendStore(path.join(dir, "sends.db"));
  try {
    const id = store.create({
      to: "+989000000000", text: "test", keyName: "eve",
      priority: "high", idempotencyKey: "test-idem"
    });
    const requestId = store.requestId(id);
    assert.equal(requestId, `send_${id}`);
    store.attachJob(id, "42");
    store.markStatus("42", "active", { attempts: 1 });
    store.markStage("42", "typing");
    const row = store.byJob("42");
    assert.equal(row.priority, "high");
    assert.equal(row.idempotency_key, "test-idem");
    assert.equal(row.status, "active");
    assert.equal(row.stage, "typing");
    assert(row.queued_at > 0);
    assert(row.active_at > 0);
    assert(row.stage_at > 0);
    // Replacing a BullMQ job must not replace the public request identity.
    store.attachJob(id, "43");
    assert.equal(store.updatePriorityByJob("42", "expired"), 1);
    assert.equal(store.byReference(requestId).priority, "expired");
    store.markStatus("43", "sent", { attempts: 2, result: { sent: true, transport: "rcs" } });
    const completed = store.byReference(requestId);
    assert.equal(completed.job_id, "43");
    assert.equal(completed.status, "sent");
    assert.deepEqual(JSON.parse(completed.result_json), { sent: true, transport: "rcs" });
    assert.equal(store.byReference("43").id, id);
    assert.equal(store.byReference("42").id, id);
    assert.equal(store.backfillPending({
      jobId: "legacy-1", state: "waiting", to: "+989000000001", text: "legacy",
      keyName: "eve", priority: "normal", attempts: 1, createdAt: Date.now() - 5000
    }), true);
    const legacy = store.byJob("legacy-1");
    assert.equal(legacy.stage, "legacy_queued");
    assert.equal(legacy.status, "queued");
    assert.equal(store.backfillPending({ jobId: "legacy-1" }), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unverified is terminal and suppresses an identical resend", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-unverified-store-"));
  const store = new SendStore(path.join(dir, "sends.db"));
  try {
    const first = store.claim({
      to: "+989000000002", text: "single submit", keyName: "eve",
      priority: "high", windowMs: 24 * 60 * 60 * 1000
    });
    assert.equal(first.action, "new");
    store.attachJob(first.id, "unverified-job");
    store.markStatus("unverified-job", "unverified", { error: "bubble_not_verified" });
    const row = store.byJob("unverified-job");
    assert.equal(row.status, "unverified");
    assert(row.finished_at > 0);

    const duplicate = store.claim({
      to: "+989000000002", text: "single submit", keyName: "eve",
      priority: "high", windowMs: 24 * 60 * 60 * 1000
    });
    assert.equal(duplicate.action, "duplicate_suppressed");
    assert.equal(duplicate.row.id, first.id);
    assert.equal(store.stats().unverified, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted conversation index skips expensive startup sidebar expansion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-index-"));
  const file = path.join(dir, "conversation-index.json");
  fs.writeFileSync(file, JSON.stringify([
    { href: "/web/conversations/abc", title: "Saved", text: "Saved", timestamp: "Jun 1" }
  ]));
  try {
    const c = new GoogleMessagesClient({
      sendMinIntervalMs: 1000,
      conversationHistoryMaxBatches: 80,
      conversationIndexMaxBatches: 6,
      conversationIndexBudgetMs: 45000,
      conversationCacheFile: path.join(dir, "recipient-cache.json"),
      conversationIndexFile: file
    });
    assert.equal(c.sidebarConversationIndex.size, 1);
    assert.equal(c.sidebarIndexReady, true);
    c.ensurePage = async () => { throw new Error("startup should not touch the page"); };
    const stats = await c.warmConversationIndex();
    assert.equal(stats.loadedFromDisk, true);
    assert.equal(stats.rows, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Google Messages single-session prompt selects only the exact Use here action", async () => {
  const c = client();
  let clicks = 0;
  const hiddenWaits = [];
  const dialog = {
    filter: ({ hasText }) => {
      assert(hasText.test("Use Google Messages for web here?"));
      return dialog;
    },
    first: () => dialog,
    isVisible: async () => true
  };
  const button = {
    first: () => button,
    isVisible: async () => true,
    innerText: async () => "Use here",
    click: async () => { clicks += 1; },
    waitFor: async (options) => { hiddenWaits.push(options.state); }
  };
  const page = {
    isClosed: () => false,
    url: () => "https://messages.google.com/web/conversations",
    locator: (selector) => selector === "[role='dialog']" ? dialog : button
  };

  const claimed = await c.claimMessagesSessionIfNeeded(page);
  assert.equal(claimed, true);
  assert.equal(clicks, 1);
  assert.deepEqual(hiddenWaits, ["hidden"]);
  assert.match(c.lastSessionClaimAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("session claim ignores a similarly named action without the Google prompt", async () => {
  const c = client();
  let clicks = 0;
  const missingDialog = {
    filter: () => missingDialog,
    first: () => missingDialog,
    isVisible: async () => false
  };
  const page = {
    isClosed: () => false,
    url: () => "https://messages.google.com/web/conversations",
    locator: () => missingDialog
  };
  const claimed = await c.claimMessagesSessionIfNeeded(page);
  assert.equal(claimed, false);
  assert.equal(clicks, 0);
});

test("google messages rate limit fallback scrolling mode triggers, scrolls, defers, and auto-exits after successes", async () => {
  try { fs.unlinkSync("./data/test-conversation-cache.json"); } catch (e) {}
  const c = client();
  let scrolls = 0;
  let clickedConversations = [];
  let isWarmed = false;

  const page = {
    bringToFront: async () => {},
    isClosed: () => false,
    url: () => "https://messages.google.com/web/conversations",
    waitForTimeout: async () => {},
    locator: (sel) => ({
      count: async () => 2,
      first: () => ({
        waitFor: async () => {},
        scrollIntoViewIfNeeded: async () => {},
        click: async () => { clickedConversations.push(sel); }
      })
    }),
    evaluate: async (fn) => {
      const str = String(fn || "");
      if (str.includes("scrollTop")) {
        scrolls += 1;
      }
    },
    waitForFunction: async () => true,
    goto: async () => {}
  };

  c.ensurePage = async () => page;
  c.ensurePaired = async () => {};
  c.clickLoadMoreConversations = async () => true;
  c.composerReady = async () => true;
  c.typeAndSend = async () => ({
    submittedOnce: true,
    submittedAt: "2026-08-16T16:00:00.000Z",
    verified: true,
    verificationStatus: "confirmed_initial",
    verificationMethod: "outgoing_bubble_dom",
    verificationAttempts: 1
  });

  // We have no cached conversation initialy
  c.sidebarConversationIndex = new Map();
  let listCalls = 0;
  c.listConversationsUnlocked = async () => {
    listCalls += 1;
    if (listCalls === 1) return [];
    return [
      { id: "1", href: "/web/conversations/abc", title: "+989128904528", text: "+989128904528", timestamp: "Jun 1" }
    ];
  };

  // Enable rate limit fallback mode manually
  c.googleRateLimitedMode = true;
  c.consecutiveSuccessfulConversationSends = 0;

  // 1. Send with rate limit scroll mode on -> should use scrollAndSearchSidebar and find/send
  const res = await c.sendMessageUnlocked({ to: "+989128904528", text: "Test fallback mode" });
  assert.equal(res.type, "sent");
  assert.equal(c.googleRateLimitedMode, true);
  assert.equal(c.consecutiveSuccessfulConversationSends, 1);
  assert(scrolls > 0);

  // 2. Perform more sends to hit 5 successes and automatically turn off googleRateLimitedMode
  for (let i = 0; i < 4; i++) {
    await c.sendMessageUnlocked({ to: "+989128904528", text: `Success ${i + 2}` });
  }
  assert.equal(c.googleRateLimitedMode, false);
  assert.equal(c.consecutiveSuccessfulConversationSends, 0);

  // 3. Fallback to startChatFlow rate limit check
  c.startChatFlow = async () => {
    // Mimic google rate limit display
    return false;
  };
  c.conversationCreationRateLimited = async () => true;

  await assert.rejects(
    c.sendMessageUnlocked({ to: "+989000000000", text: "This will trigger rate limit" }),
    (error) => error.code === "CONVERSATION_OPEN_DEFER"
  );
  assert.equal(c.googleRateLimitedMode, true);
  assert.equal(c.consecutiveSuccessfulConversationSends, 0);
});
