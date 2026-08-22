const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { chromium } = require("playwright");

const MESSAGES_URL = "https://messages.google.com/web";

function normalizeComparableMessage(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

class GoogleMessagesClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.pollTimer = null;
    this.lastConversationFingerprint = new Map();
    this.startedAt = null;
    this.actionLock = Promise.resolve();
    this.userActionInProgress = false;
    this.conversationCache = this.readConversationCache();
    // Cached pairing status so dashboard/readiness endpoints don't have to
    // acquire the (single) browser lock and queue behind in-flight sends.
    this.lastStatus = null;
    this.lastStatusAt = 0;
    // Hard cap on how long any single locked browser op may run. A wedged page
    // can otherwise hold the lock forever and stall the whole send queue.
    this.lockTimeoutMs = Number(config.lockTimeoutMs) || 70000;
    // Three in-SPA open attempts (including pacing and Google's rendering)
    // need a wider budget than ordinary browser actions.
    this.sendOperationTimeoutMs = Math.max(220000, Number(config.sendTimeoutMs || 0) - 10000);
    // How long to wait, after committing a recipient, for the conversation to
    // actually load (URL leaves /conversations/new and a real composer appears).
    this.conversationLoadTimeoutMs = Number(config.conversationLoadTimeoutMs) || 15000;
    // How long ensurePaired() will wait through transient Google cookie-rotation
    // before giving up. Kept well under lockTimeoutMs so the watchdog still fires.
    this.pairedWaitMs = Number(config.pairedWaitMs) || 20000;
    // Background guard that closes Google's accounts.google.com/RotateCookiesPage
    // tab. When that tab's cookie rotation loops/stalls it wedges the whole
    // Messages session (page spins, every send hangs ~80s). Closing it keeps the
    // main page alive. Runs off the browser lock — it only touches OTHER pages.
    this.rotationTimer = null;
    this.rotationGuardMs = Number(config.rotationGuardMs) || 3000;
    // Grace period: give a freshly-opened RotateCookiesPage this long to finish
    // rotating cookies on its own before we force-close it. Letting legit
    // rotations complete can end Google's retry loop; we only kill STALLED tabs.
    this.rotationGraceMs = Number(config.rotationGraceMs) || 8000;
    this.rotationSeen = new WeakMap(); // page -> first-seen timestamp
    // Applies to every Start-chat attempt, including retries within one job.
    // Worker pacing alone cannot protect against those internal retries.
    // Default from config; overridden by live pacing settings via setPacingSettings().
    this.conversationOpenIntervalMs = Math.max(1000, Number(config.sendMinIntervalMs) || 15000);
    this.lastConversationOpenAt = 0;
    // Live pacing controller (optional) — when set, conversation interval tracks
    // the dashboard's "Maximum messages per minute" setting instead of static config.
    this.pacingController = null;
    // A warm index of the sidebar lets sends open existing threads with one
    // SPA click instead of repeatedly invoking Google's new-conversation flow.
    this.sidebarConversationIndex = this.readSidebarIndexCache();
    this.sidebarIndexReady = this.sidebarConversationIndex.size > 0;
    this.sidebarIndexWarmPromise = null;
    this.sidebarIndexWriteTimer = null;
    this.statusRefreshPromise = null;
    // Google occasionally moves the paired Messages session to another tab or
    // browser and blocks this page with "Use Google Messages for web here?".
    // Keep the last automatic claim visible in status/diagnostics.
    this.lastSessionClaimAt = null;
    this.sidebarIndexStats = {
      rows: this.sidebarConversationIndex.size,
      batches: 0,
      reachedPreviousYear: false,
      loadedFromDisk: this.sidebarConversationIndex.size > 0
    };
    this.conversationHistoryMaxBatches = Math.max(1, Number(config.conversationHistoryMaxBatches) || 80);
    this.conversationIndexMaxBatches = Math.max(1, Number(config.conversationIndexMaxBatches) || 6);
    this.conversationIndexBudgetMs = Math.max(10000, Number(config.conversationIndexBudgetMs) || 45000);
    // Enter is pressed at most once. If Google's SPA does not render the
    // outgoing bubble immediately, these checks only re-read the DOM; they
    // never type or submit the message again.
    this.sendVerificationInitialTimeoutMs = Math.max(1000, Number(config.sendVerificationInitialTimeoutMs) || 15000);
    this.sendVerificationRetryDelaysMs = Array.isArray(config.sendVerificationRetryDelaysMs)
      ? config.sendVerificationRetryDelaysMs.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
      : [3000, 10000, 20000];
    // Rate limit fallback states for adaptive scrolling of sidebar
    this.googleRateLimitedMode = false;
    this.consecutiveSuccessfulConversationSends = 0;
  }

  // Bind the live pacing controller so conversation-open interval tracks the
  // dashboard's "Maximum messages per minute" instead of the static config.
  setPacingController(controller) {
    this.pacingController = controller;
    this.refreshConversationInterval();
  }

  refreshConversationInterval() {
    if (this.pacingController) {
      const snapshot = this.pacingController.snapshot();
      // Use the minimum interval from pacing (e.g. 30s for 2/min) as the base
      // conversation-open cooldown. This is stricter than the static 15s default.
      this.conversationOpenIntervalMs = snapshot.minimumIntervalSeconds * 1000;
    }
  }

  async start() {
    return this.withBrowserLock(() => this.startUnlocked());
  }

  async startUnlocked() {
    if (this.page && !this.page.isClosed()) return this.page;

    fs.mkdirSync(this.config.userDataDir, { recursive: true });
    if (this.config.browserMode === "connect") {
      this.browser = await chromium.connectOverCDP(this.config.browserCdpUrl);
      this.context = this.browser.contexts()[0] || await this.browser.newContext();
    } else {
      this.context = await chromium.launchPersistentContext(this.config.userDataDir, {
        headless: this.config.headless,
        executablePath: this.config.chromeExecutablePath || undefined,
        viewport: { width: 1280, height: 900 },
        args: [
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check"
        ]
      });
    }

    this.context.on("close", () => {
      this.page = null;
      this.context = null;
      this.stopPolling();
      this.stopRotationGuard();
    });
    this.browser?.on("disconnected", () => {
      this.browser = null;
      this.page = null;
      this.context = null;
      this.stopPolling();
      this.stopRotationGuard();
    });

    const existingPages = this.context.pages();
    this.page = existingPages.find((candidate) => candidate.url().startsWith(MESSAGES_URL)) ||
      existingPages[0] || await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    // Reconnecting to the externally-owned Chrome must not reload a healthy
    // Messages SPA. A full goto produces the long splash/loading screen and
    // discards the already-loaded sidebar history.
    if (!this.page.url().startsWith(MESSAGES_URL)) {
      await this.page.goto(MESSAGES_URL, { waitUntil: "domcontentloaded" });
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    this.startedAt = new Date().toISOString();
    this.startPolling();
    this.startRotationGuard();
    return this.page;
  }

  async stop() {
    return this.withBrowserLock(() => this.stopUnlocked());
  }

  detachForShutdown() {
    // The Chrome process is external in connect mode. During a long sidebar
    // warm-up, waiting for the browser lock makes systemd kill the API after
    // its stop timeout. Dropping our references is enough because this process
    // is about to exit and must not close the shared Chrome.
    this.stopPolling();
    this.stopRotationGuard();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async stopUnlocked() {
    this.stopPolling();
    this.stopRotationGuard();
    if (this.config.browserMode === "connect") {
      if (this.browser) await this.browser.close();
    } else if (this.context) {
      await this.context.close();
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async ensurePage() {
    if (!this.page || this.page.isClosed()) await this.startUnlocked();
    return this.page;
  }

  async status() {
    return this.withBrowserLock(() => this.statusUnlocked());
  }

  async statusUnlocked() {
    const page = await this.ensurePage();
    const sessionClaimed = await this.claimMessagesSessionIfNeeded(page);
    const title = await page.title().catch(() => "");
    const url = page.url();
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    const hasStartChatText = /Start chat|New conversation|Start conversation/i.test(bodyText);
    const qrVisible = await this.isVisible([
      "img[alt*='QR' i]",
      "text=/QR code/i",
      "text=/Scan this QR/i",
      "text=/Scan the QR/i"
    ]);
    const signInVisible = await this.isVisible([
      "a[href*='accounts.google.com']",
      "button:has-text('Sign in with Google')"
    ]);
    const composeVisible = await this.isVisible([
      "[aria-label*='Start chat' i]",
      "[aria-label*='Start conversation' i]",
      "text=/Start chat/i",
      "text=/New conversation/i"
    ]);
    const onConversationsPage = /\/web\/conversations/.test(url);
    const paired = (onConversationsPage || composeVisible || hasStartChatText) && !qrVisible;
    const needsSignIn = !paired && signInVisible;

    const result = {
      running: Boolean(this.page && !this.page.isClosed()),
      browserMode: this.config.browserMode,
      startedAt: this.startedAt,
      url,
      title,
      paired,
      qrVisible,
      signInVisible: needsSignIn,
      sessionClaimed,
      sessionClaimedAt: this.lastSessionClaimAt,
      hint: this.buildStatusHint(bodyText, qrVisible, paired, needsSignIn)
    };
    // Refresh the cache on every live status read (also done by the background
    // poller every cycle), so cache stays warm without extra lock contention.
    this.lastStatus = result;
    this.lastStatusAt = Date.now();
    return result;
  }

  // Last known status without touching the browser lock. null if never read.
  cachedStatus() {
    if (!this.lastStatus) return null;
    return { ...this.lastStatus, cached: true, ageMs: Date.now() - this.lastStatusAt };
  }

  // status() that can never block the caller longer than `ms`. The underlying
  // call keeps running (and will refresh the cache) even if we stop waiting.
  statusWithTimeout(ms = 5000) {
    return Promise.race([
      this.status(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("status_timeout")), ms))
    ]);
  }

  refreshStatusInBackground() {
    if (this.sidebarIndexWarmPromise || this.statusRefreshPromise) return this.statusRefreshPromise;
    this.statusRefreshPromise = this.status()
      .catch(() => null)
      .finally(() => { this.statusRefreshPromise = null; });
    return this.statusRefreshPromise;
  }

  // Non-blocking status for dashboard/readiness. Serves a fresh-enough cache
  // immediately; otherwise tries a time-boxed live read; otherwise stale cache.
  async statusForDashboard({ maxAgeMs = 15000, timeoutMs = 5000 } = {}) {
    const cached = this.cachedStatus();
    if (cached) {
      // Always answer instantly from cache so the dashboard never blocks behind
      // in-flight sends. If the cache is getting old (the poller may be starved
      // during a send burst), kick a background refresh for the next read.
      // Dashboard polling must not enqueue one status read per request behind
      // a long sidebar index. Keep refreshes single-flight and skip them while
      // the warm-up owns the browser lock.
      if (cached.ageMs >= maxAgeMs) this.refreshStatusInBackground();
      return cached.ageMs >= maxAgeMs ? { ...cached, stale: true } : cached;
    }
    // Cold start only (no cache yet): time-boxed live read, never hangs.
    try {
      return await this.statusWithTimeout(timeoutMs);
    } catch {
      return {
        running: Boolean(this.page && !this.page.isClosed()),
        browserMode: this.config.browserMode,
        startedAt: this.startedAt,
        url: "",
        title: "",
        paired: false,
        qrVisible: false,
        signInVisible: false,
        hint: "status warming up (browser busy)"
      };
    }
  }

  buildStatusHint(bodyText, qrVisible, paired, signInVisible) {
    if (paired) return "paired";
    if (signInVisible) return "sign in to the controlled Chrome profile, then pair your phone";
    if (qrVisible) return "scan the QR code with Google Messages on your phone";
    if (/Use Messages for web|Messages for web|Scan/i.test(bodyText)) return "pairing screen";
    return "unknown page state";
  }

  // Claim this browser when Google displays its single-active-web-session
  // prompt. The exact button text and surrounding prompt are both verified so
  // an unrelated button can never be clicked accidentally.
  async claimMessagesSessionIfNeeded(page = this.page) {
    if (!page || page.isClosed?.()) return false;
    if (!/messages\.google\.com\/web/i.test(page.url?.() || "")) return false;

    const dialogSelectors = [
      "[role='dialog']",
      "mat-dialog-container",
      ".mdc-dialog"
    ];
    const promptPattern = /Use Google Messages for web here\?|open in more than one tab or browser/i;
    let promptVisible = false;
    for (const selector of dialogSelectors) {
      try {
        const dialog = page.locator(selector).filter({ hasText: promptPattern }).first();
        if (await dialog.isVisible({ timeout: 350 })) {
          promptVisible = true;
          break;
        }
      } catch {
        // Try the next known dialog container.
      }
    }
    if (!promptVisible) return false;

    const buttonSelectors = [
      "[role='dialog'] button:has-text('Use here')",
      "[role='dialog'] [role='button']:has-text('Use here')",
      "mat-dialog-container button:has-text('Use here')",
      ".mdc-dialog button:has-text('Use here')"
    ];
    for (const selector of buttonSelectors) {
      try {
        const button = page.locator(selector).first();
        if (!await button.isVisible({ timeout: 350 })) continue;
        const label = String(await button.innerText({ timeout: 500 })).trim();
        if (!/^Use here$/i.test(label)) continue;
        await button.click({ timeout: 3000 });
        await button.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
        this.lastSessionClaimAt = new Date().toISOString();
        this.emit("session:claimed", { at: this.lastSessionClaimAt });
        return true;
      } catch {
        // Another observer may already have dismissed it; try the next shape.
      }
    }
    return false;
  }

  async screenshot() {
    return this.withBrowserLock(() => this.screenshotUnlocked());
  }

  async screenshotUnlocked() {
    const page = await this.ensurePage();
    return page.screenshot({ fullPage: true, type: "png" });
  }

  async sendMessage({ to, text, onStage, shouldCancel }) {
    return this.withBrowserLock(
      () => this.sendMessageUnlocked({ to, text, onStage, shouldCancel }),
      { timeoutMs: this.sendOperationTimeoutMs }
    );
  }

  // Try, in order, to open the recipient's conversation. Returns true on success.
  // onStage reports which step is being attempted so the ledger can show progress.
  async openForSend(to, onStage, { restartNewConversation = false } = {}) {
    const page = await this.ensurePage();

    // 1. Already viewing this recipient's verified conversation? Skip to send.
    const cached = this.getCachedRecipientConversation(to);
    if (cached?.href) {
      const convId = cached.href.split("/").pop();
      if (convId && this.isExpectedConversationUrl(page.url(), cached.href) && await this.conversationLoaded(1200)) {
        this.activeSendRecipientEvidence = { ...cached.recipientEvidence, conversationUrl: page.url() };
        return true;
      }
    }

    // Old cache rows know only number -> href. The href is a candidate, not
    // authorization to send. Upgrade it only after the active header/details
    // exposes the exact requested phone number.
    const legacyCandidate = restartNewConversation ? null : this.getLegacyRecipientCandidate(to);
    if (legacyCandidate) {
      onStage?.("legacy_candidate_found");
      if (await this.revalidateLegacyConversation(to, legacyCandidate, onStage)) return true;
    }

    // 2. Existing conversation — find it in the sidebar and click it (SPA, no reload).
    onStage?.("locating");
    if (await this.openExistingConversation(to)) return true;

    // --- Google Rate Limited (Scroll) Fallback Mode ---
    if (this.googleRateLimitedMode) {
      onStage?.("sidebar_scroll_searching");
      const match = await this.scrollAndSearchSidebar(to, 5);
      if (match && match.href) {
        const clicked = await this.clickConversationInSidebar(page, match.href);
        if (clicked && await this.composerReady(6000)) {
          const evidence = this.recipientEvidenceFromText(to, match.title, "sidebar_scroll", match.href);
          if (evidence) {
            this.activeSendRecipientEvidence = { ...evidence, conversationUrl: page.url() };
            this.cacheRecipientConversation(to, match.href, match.title || "", this.activeSendRecipientEvidence);
            return true;
          }
        }
      }

      // If we are in rate limited mode and can't find the conversation in the sidebar,
      // we must NOT try starting a chat (to avoid worsening Google's restriction).
      // Instead, we throw a CONVERSATION_OPEN_DEFER error to move this job down in the queue (by 10 positions).
      const error = new Error(`Conversation for ${to} not found in sidebar scrolling search while rate limited.`);
      error.code = "CONVERSATION_OPEN_DEFER";
      error.statusCode = 503;
      throw error;
    }

    // 3. New number — Start-chat UI flow.
    // Global inter-message randomness is controlled by the live Send settings.
    const conversationWaitMs = Math.max(0, this.lastConversationOpenAt + this.conversationOpenIntervalMs - Date.now());
    if (conversationWaitMs > 0) {
      onStage?.("conversation_pacing");
      await page.waitForTimeout(conversationWaitMs);
    }
    this.lastConversationOpenAt = Date.now();
    onStage?.("start_chat");
    if (await this.startChatFlow(to, onStage, { forceRestart: restartNewConversation })) return true;
    if (await this.conversationCreationRateLimited()) {
      const error = new Error("Google Messages asked us to wait before creating more conversations.");
      error.code = "GOOGLE_CONVERSATION_RATE_LIMIT";
      error.statusCode = 429;
      throw error;
    }

    // 4. Last resort — open the conversation by URL.
    onStage?.("open_by_url");
    if (await this.openConversationByUrl(to)) return true;
    if (await this.conversationCreationRateLimited()) {
      const error = new Error("Google Messages asked us to wait before creating more conversations.");
      error.code = "GOOGLE_CONVERSATION_RATE_LIMIT";
      error.statusCode = 429;
      throw error;
    }

    return false;
  }

  async sendMessageUnlocked({ to, text, onStage, shouldCancel }) {
    if (!to || !text) throw new Error("Both 'to' and 'text' are required.");
    // Evidence is scoped to this locked send operation. Never reuse recipient
    // evidence from the previous job: doing so could turn a navigation miss
    // into a send to the conversation that happened to remain open.
    this.activeSendRecipientEvidence = null;
    const stage = (s) => { try { onStage?.(s); } catch { /* ignore */ } };
    const throwIfCancelled = () => {
      if (!shouldCancel?.()) return;
      const error = new Error(`Send to ${to} was cancelled before submission.`);
      error.code = "SEND_CANCELLED";
      throw error;
    };

    const page = await this.ensurePage();
    await page.bringToFront().catch(() => {});
    stage("checking_paired");
    await this.ensurePaired();

    // The whole send is retryable, but retries stay inside the SPA. Reloading
    // Messages here causes a long resync and loses the warm sidebar index.
    let sent = false;
    let submissionEvidence = null;
    for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
      throwIfCancelled();
      stage(attempt === 1 ? "opening" : `ui_retry_${attempt}`);
      let opened = false;
      try {
        opened = await this.openForSend(to, stage, { restartNewConversation: attempt > 1 });
      } catch (error) {
        // This is an explicit Google anti-abuse response, not a wedged page.
        // Retrying immediately would create more conversations and extend the
        // restriction, so surface it to the queue on the first occurrence.
        if (error?.code === "GOOGLE_CONVERSATION_RATE_LIMIT") {
          this.googleRateLimitedMode = true;
          this.consecutiveSuccessfulConversationSends = 0;
          stage("entering_google_rate_limit_fallback_mode");

          // Gracefully defer this job 10 spots down in the queue (standard server behavior)
          const deferError = new Error("Google Messages rate-limited conversation creation. Switched to sidebar scrolling search mode.");
          deferError.code = "CONVERSATION_OPEN_DEFER";
          deferError.statusCode = 503;
          throw deferError;
        }
        throw error;
      }

      if (opened) {
        const recipientEvidence = this.activeSendRecipientEvidence;
        if (!recipientEvidence ||
            recipientEvidence.cacheKey !== this.recipientCacheKey(to) ||
            !this.isExpectedConversationUrl(page.url(), recipientEvidence.conversationUrl)) {
          stage("recipient_unverified");
          const error = new Error(`Refusing to send to ${to}: the active conversation recipient was not verified.`);
          error.code = "RECIPIENT_UNVERIFIED";
          error.statusCode = 409;
          throw error;
        }
        // A previous/replacement operation may already have submitted this text.
        // If it is visible, do not press Enter again.
        throwIfCancelled();
        if (await this.lastOutgoingMatches(text)) { stage("already_sent"); sent = true; break; }
        stage("typing");
        const submission = await this.typeAndSend(text, { shouldCancel });
        if (!submission.verified) {
          stage("verification_pending");
          const reconciliation = await this.verifySubmittedMessage(text, {
            onAttempt: (verificationAttempt) => stage(`verification_retry_${verificationAttempt}`)
          });
          submission.verificationAttempts += reconciliation.attempts;
          submission.verified = reconciliation.verified;
          if (reconciliation.verified) {
            submission.verificationStatus = "confirmed_after_recheck";
            submission.verificationMethod = reconciliation.method;
          }
        }
        if (submission.verified) {
          sent = true;
          stage(submission.verificationStatus === "confirmed_after_recheck" ? "sent_after_recheck" : "sent");
          // If we are in Google Rate Limited Mode, count consecutive successes
          if (this.googleRateLimitedMode) {
            this.consecutiveSuccessfulConversationSends += 1;
            if (this.consecutiveSuccessfulConversationSends >= 5) {
              this.googleRateLimitedMode = false;
              this.consecutiveSuccessfulConversationSends = 0;
              stage("exiting_google_rate_limit_fallback_mode");
            }
          }
          submissionEvidence = submission;
          break;
        }
        stage("unverified_manual_review");
        const error = new Error(`Send to ${to} was submitted once but the outgoing bubble could not be verified.`);
        error.code = "SEND_UNVERIFIED";
        error.details = {
          submittedOnce: true,
          submittedAt: submission.submittedAt,
          verificationStatus: "manual_review_required",
          verificationAttempts: submission.verificationAttempts,
          verificationMethod: submission.verificationMethod,
          requestedTo: String(to),
          sentTo: recipientEvidence.sentTo,
          recipientEvidence,
          conversationUrl: page.url()
        };
        throw error;
      }

      // A selected-recipient chip with no composer is a known Google UI miss.
      // The next attempt clicks Start chat again and re-enters the number.
      stage("retrying_without_reload");
      await page.waitForTimeout(500);
    }

    if (!sent) {
      stage("failed");
      const error = new Error(`Send to ${to} could not open a conversation after 3 UI attempts.`);
      error.code = "CONVERSATION_OPEN_DEFER";
      error.statusCode = 503;
      throw error;
    }

    const recipientEvidence = this.activeSendRecipientEvidence;
    this.cacheRecipientConversation(to, page.url(), "", recipientEvidence);

    const event = {
      type: "sent",
      to,
      requestedTo: String(to),
      sentTo: recipientEvidence.sentTo,
      recipientEvidence,
      conversationUrl: page.url(),
      submission: submissionEvidence,
      text,
      at: new Date().toISOString()
    };
    this.emit("message:sent", event);
    return event;
  }

  async conversationCreationRateLimited() {
    const page = await this.ensurePage();
    try {
      const bodyText = await page.locator("body").innerText({ timeout: 1500 });
      return /please\s+wait\s+before\s+creating\s+more\s+conversations/i.test(bodyText);
    } catch {
      return false;
    }
  }

  // Resolves true once the message composer is present (a conversation is open
  // and ready to type into). Broad on purpose so it matches GM's composer across
  // layouts; correctness is guaranteed downstream by typeAndSend's send-verify,
  // so a rare false "ready" just costs one retry rather than a silent failure.
  async composerReady(timeout = 2000) {
    const page = await this.ensurePage();
    try {
      await page.waitForFunction(() => {
        return !!document.querySelector(
          "[aria-label*='Text message' i], [aria-label*='Message' i], textarea, [contenteditable='true']"
        );
      }, null, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  // Stricter than composerReady: the conversation has actually loaded — a
  // *visible* composer is present and we are no longer on the recipient-entry
  // screen. A bare textarea/[contenteditable] that lingers on the loading or
  // Start-chat screen must not count as "ready".
  async conversationLoaded(timeout = 15000) {
    const page = await this.ensurePage();
    try {
      await page.waitForFunction(() => {
        const composer = [...document.querySelectorAll(
          "[aria-label*='Text message' i], [aria-label*='Message' i], textarea, [contenteditable='true']"
        )].find((node) => {
          const rect = node.getBoundingClientRect();
          return rect && rect.width > 0 && rect.height > 0 && node.offsetParent !== null;
        });
        if (!composer) return false;
        const onNewScreen = /\/web\/conversations\/new(?:[/?#]|$)/i.test(location.href);
        const recipientInput = document.querySelector(
          "input[placeholder*='Type a name' i], input[placeholder*='name' i], input[type='tel'], input[aria-label*='to' i], input[aria-label*='recipient' i]"
        );
        // Loaded = visible composer AND we left the recipient-entry screen.
        return onNewScreen ? !recipientInput : true;
      }, null, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  // Open an EXISTING conversation by finding it in the sidebar and clicking it
  // (pure SPA navigation — no page reload, no fragile Start-chat flow). Tries the
  // already-rendered rows first (cheap), then lazy-scrolls the whole list so even
  // older customers are found. Returns false only for genuinely new numbers.
  async openExistingConversation(to) {
    const page = await this.ensurePage();

    // Persistent recipient cache is the cheapest path; the warm in-memory
    // sidebar index covers every conversation loaded for the current year.
    const cached = this.getCachedRecipientConversation(to);
    let match = cached?.href ? { href: cached.href, title: cached.title || "", text: cached.title || "", evidence: cached.recipientEvidence } : null;
    if (!match) {
      match = [...this.sidebarConversationIndex.values()]
        .find((conversation) => this.conversationMatchesRecipient(conversation, to));
    }
    // While the background warm-up is still running, include whatever is
    // already rendered without triggering a per-message deep scan.
    if (!match) {
      const visible = await this.listConversationsUnlocked(120, { loadMore: false });
      this.mergeSidebarConversationIndex(visible);
      match = visible.find((conversation) => this.conversationMatchesRecipient(conversation, to));
    }
    if (!match?.href) return false;
    const evidence = match.evidence || this.recipientEvidenceFromText(to, match.title, "sidebar", match.href);
    if (!evidence) return false;

    // Already viewing it?
    const convId = match.href.split("/").pop();
    if (convId && this.isExpectedConversationUrl(page.url(), match.href) && await this.conversationLoaded(800)) {
      this.activeSendRecipientEvidence = { ...evidence, conversationUrl: page.url() };
      this.cacheRecipientConversation(to, match.href, match.title || "", this.activeSendRecipientEvidence);
      return true;
    }

    const clicked = await this.clickConversationInSidebar(page, match.href);
    if (clicked && this.isExpectedConversationUrl(page.url(), match.href) && await this.conversationLoaded(6000)) {
      this.activeSendRecipientEvidence = { ...evidence, conversationUrl: page.url() };
      this.cacheRecipientConversation(to, match.href, match.title || "", this.activeSendRecipientEvidence);
      return true;
    }

    // A persisted index can know about an old conversation that is not in the
    // currently rendered/virtualized sidebar. Navigate straight to its stable
    // Google Messages URL instead of inflating the sidebar DOM or falling into
    // the much slower Start-chat flow.
    try {
      await page.goto(new URL(match.href, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
      if (this.isExpectedConversationUrl(page.url(), match.href) && await this.conversationLoaded(10000)) {
        this.activeSendRecipientEvidence = { ...evidence, conversationUrl: page.url() };
        this.cacheRecipientConversation(to, match.href, match.title || "", this.activeSendRecipientEvidence);
        return true;
      }
    } catch { /* fall through to Start chat */ }
    return false;
  }

  async revalidateLegacyConversation(to, candidate, onStage) {
    const page = await this.ensurePage();
    try {
      onStage?.("candidate_opened_for_verification");
      await page.goto(new URL(candidate.href, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
      if (!await this.composerReady(10000)) {
        onStage?.("candidate_rejected");
        return false;
      }

      let evidence = await this.extractRecipientEvidenceFromActiveConversation(to, "conversation_header_revalidated");
      if (!evidence) {
        const details = await this.locatorFirst([
          "[aria-label*='Conversation details' i]",
          "[aria-label*='Contact info' i]",
          "[aria-label*='Details' i]",
          "button:has-text('Details')"
        ]).catch(() => null);
        if (details) {
          await details.click({ timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(750);
          evidence = await this.extractRecipientEvidenceFromActiveConversation(to, "conversation_details_revalidated");
          await page.keyboard.press("Escape").catch(() => {});
        }
      }

      if (!evidence) {
        onStage?.("candidate_rejected");
        return false;
      }
      this.activeSendRecipientEvidence = { ...evidence, conversationUrl: page.url() };
      this.cacheRecipientConversation(to, candidate.href, candidate.title || "", this.activeSendRecipientEvidence);
      onStage?.("recipient_revalidated");
      return true;
    } catch {
      onStage?.("candidate_rejected");
      return false;
    }
  }

  async extractRecipientEvidenceFromActiveConversation(to, source) {
    const page = await this.ensurePage();
    const variants = this.phoneVariants(to).filter((variant) => variant.length >= 7);
    try {
      const match = await page.evaluate((wantedVariants) => {
        const digits = (value) => String(value || "").replace(/\D/g, "");
        const scopes = [...document.querySelectorAll(
          "mws-conversation-header, header, [role='dialog'], mws-conversation-details, aside"
        )].filter((node) => {
          if (node.closest("nav.conversation-list, mws-conversation-list-item")) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left > 250;
        });
        for (const scope of scopes) {
          const nodes = [scope, ...scope.querySelectorAll("[aria-label], a[href^='tel:'], [data-phone-number], [data-number]")];
          for (const node of nodes) {
            if (node.closest("mws-text-message-part, mws-message-wrapper, [data-message-id]")) continue;
            const text = [
              node.innerText || node.textContent || "",
              node.getAttribute?.("aria-label") || "",
              node.getAttribute?.("href") || "",
              node.getAttribute?.("data-phone-number") || "",
              node.getAttribute?.("data-number") || ""
            ].join(" ");
            // Compare complete phone-like tokens, not arbitrary digit substrings.
            // This avoids accepting a header that merely contains the requested
            // number inside a longer, different identifier.
            const phoneTokens = String(text).match(/(?:\+?\d[\d\s().-]{5,}\d)/g) || [];
            const normalizedTokens = phoneTokens.map(digits).filter(Boolean);
            const matchedVariant = wantedVariants.find((variant) => normalizedTokens.includes(variant));
            if (matchedVariant) {
              return { matchedVariant, matchedText: String(text).replace(/\s+/g, " ").trim().slice(0, 240) };
            }
          }
        }
        return null;
      }, variants);
      if (!match) return null;
      return {
        cacheKey: this.recipientCacheKey(to),
        requestedTo: String(to),
        sentTo: String(to),
        source,
        matchedVariant: match.matchedVariant,
        matchedText: match.matchedText,
        conversationUrl: page.url()
      };
    } catch {
      return null;
    }
  }

  // Open a conversation purely through the "Start chat" UI — no page reload.
  // Works for ANY number regardless of whether it is visible in the sidebar.
  async startChatFlow(to, onStage, { forceRestart = false } = {}) {
    const page = await this.ensurePage();
    try {
      // Reuse an already-open New conversation screen. Clicking Start chat
      // again can reset the recipient field while Google is still rendering it.
      if (forceRestart || !/\/conversations\/new(?:[/?#]|$)/i.test(page.url())) {
        onStage?.(forceRestart ? "restarting_start_chat" : "opening_start_chat");
        await this.clickFirst([
          "[aria-label*='Start chat' i]",
          "[aria-label*='Start conversation' i]",
          "mws-fab",
          "text=/Start chat/i",
          "text=/New conversation/i"
        ], "start chat");
      }

      const recipientInput = await this.locatorFirst([
        "input[placeholder*='Type a name' i]",
        "input[placeholder*='name' i]",
        "input[placeholder*='phone' i]",
        "input[aria-label*='recipient' i]",
        "input[aria-label*='to' i]",
        "input[type='tel']",
        "input[type='text']"
      ]);
      onStage?.("recipient_input_ready");
      await recipientInput.fill(to);
      // Verify the controlled input accepted the value. If Google's component
      // dropped fill() during a re-render, retry once with real keystrokes.
      if ((await recipientInput.inputValue().catch(() => "")) !== String(to)) {
        await recipientInput.click();
        await recipientInput.press("Control+A").catch(() => {});
        await recipientInput.type(String(to), { delay: 35 });
      }
      const entered = await recipientInput.inputValue().catch(() => "");
      if (!entered) throw new Error("recipient input did not accept the phone number");
      onStage?.("recipient_filled");
      await page.waitForTimeout(750); // let the "Send to <number>" / contact rows render

      // Commit the recipient by CLICKING the suggestion row (the reliable, human
      // way) — it returns true only once the composer actually opened. Enter is a
      // last-resort fallback for layouts where no row is clickable.
      onStage?.("selecting_recipient");
      const selection = await this.clickRecipientOption(to);
      if (selection.status === "opened") {
        this.activeSendRecipientEvidence = selection.evidence;
        return true;
      }
      // The screenshot case: Google accepted the recipient and rendered a chip,
      // but never transitioned to the composer. Do not keep clicking the chip;
      // let the next attempt reset Start chat and enter the number again.
      if (selection.status === "selected") return false;
      // Do not press Enter against an unverified generic suggestion. Google may
      // focus the first contact instead of the literal number, which is exactly
      // how a message can land in the wrong existing conversation.
      return false;
    } catch {
      onStage?.("recipient_input_failed");
      return false;
    }
  }

  // Last resort: navigate to the conversation by URL (full page reload).
  // Uses the cached href, otherwise scans the conversation list once.
  async openConversationByUrl(to) {
    const page = await this.ensurePage();
    const cached = this.getCachedRecipientConversation(to);
    let href = cached?.href || null;
    let evidence = cached?.recipientEvidence || null;
    if (!href) {
      const conversations = await this.listConversationsUnlocked(80);
      const match = conversations.find((c) => this.conversationMatchesRecipient(c, to));
      href = match?.href || null;
      evidence = match ? this.recipientEvidenceFromText(to, match.title, "sidebar", href) : null;
    }
    if (!href || !evidence) return false;
    try {
      await page.goto(new URL(href, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
      const ready = await this.composerReady(10000);
      if (ready) {
        this.activeSendRecipientEvidence = { ...evidence, conversationUrl: page.url() };
        this.cacheRecipientConversation(to, href, "", this.activeSendRecipientEvidence);
      }
      return ready;
    } catch {
      this.deleteCachedRecipientConversation(to);
      return false;
    }
  }

  async waitForComposer(timeout = 10000) {
    const page = await this.ensurePage();
    await page.waitForFunction(() => {
      const text = document.body.innerText || "";
      return /Text message|SMS|MMS|RCS/i.test(text)
        || document.querySelector("[aria-label*='Text message' i], [aria-label*='Message' i], textarea, [contenteditable='true']");
    }, null, { timeout }).catch(() => {});
  }

  // Type into the real composer and press Enter exactly once. Verification does
  // not depend on the DOM node count increasing: Google may recycle a virtualized
  // message node or insert invisible bidi marks into Persian text.
  async typeAndSend(text, { shouldCancel } = {}) {
    const page = await this.ensurePage();
    const messageInput = await this.locatorFirst([
      "[aria-label*='Text message' i]",
      "[aria-label*='Message' i]",
      "textarea[aria-label*='message' i]",
      "textarea[placeholder*='message' i]",
      "[contenteditable='true'][aria-label*='message' i]",
      "[contenteditable='true']",
      "textarea"
    ]);
    await messageInput.fill(text).catch(async () => {
      await messageInput.click();
      await page.keyboard.type(text);
    });
    if (shouldCancel?.()) {
      const error = new Error("Send cancelled before Enter was pressed.");
      error.code = "SEND_CANCELLED";
      throw error;
    }
    const submittedAt = new Date().toISOString();
    await messageInput.press("Enter");

    const deadline = Date.now() + this.sendVerificationInitialTimeoutMs;
    let attempts = 0;
    do {
      attempts += 1;
      if (await this.outgoingMessageMatches(text)) {
        return {
          submittedOnce: true,
          submittedAt,
          verified: true,
          verificationStatus: "confirmed_initial",
          verificationMethod: "outgoing_bubble_dom",
          verificationAttempts: attempts
        };
      }
      if (Date.now() < deadline) await page.waitForTimeout(500);
    } while (Date.now() < deadline);

    return {
      submittedOnce: true,
      submittedAt,
      verified: false,
      verificationStatus: "pending_recheck",
      verificationMethod: "outgoing_bubble_dom",
      verificationAttempts: attempts
    };
  }

  async verifySubmittedMessage(text, { onAttempt } = {}) {
    const page = await this.ensurePage();
    let attempts = 0;
    for (const delayMs of this.sendVerificationRetryDelaysMs) {
      attempts += 1;
      onAttempt?.(attempts);
      if (delayMs > 0) await page.waitForTimeout(delayMs);
      if (await this.outgoingMessageMatches(text)) {
        return { verified: true, attempts, method: "outgoing_bubble_dom_recheck" };
      }
    }
    return { verified: false, attempts, method: "outgoing_bubble_dom_recheck" };
  }

  async outgoingMessageMatches(text) {
    const page = await this.ensurePage();
    const want = normalizeComparableMessage(text);
    try {
      return await page.evaluate((wanted) => {
        const normalize = (value) => String(value || "")
          .normalize("NFKC")
          .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const roots = [document];
        for (let index = 0; index < roots.length; index += 1) {
          for (const node of roots[index].querySelectorAll("*")) {
            if (node.shadowRoot) roots.push(node.shadowRoot);
          }
        }
        const selectors = [
          "mws-text-message-part",
          "mws-message-wrapper",
          "[data-message-id]",
          "[data-e2e-message-direction]",
          "[data-message-direction]",
          "[aria-label^='You said:' i]",
          "[aria-label^='You sent' i]"
        ];
        const candidates = [...new Set(roots.flatMap((root) => selectors.flatMap((selector) => [...root.querySelectorAll(selector)])))];
        return candidates.slice(-40).some((node) => {
          const aria = node.getAttribute?.("aria-label") || "";
          const direction = [
            aria,
            node.getAttribute?.("data-e2e-message-direction") || "",
            node.getAttribute?.("data-message-direction") || "",
            node.getAttribute?.("data-direction") || "",
            node.className || ""
          ].join(" ");
          const explicitlyOutgoing = /\b(you said|you sent|outgoing|outbound|sent)\b/i.test(direction);
          const explicitlyIncoming = /\b(incoming|inbound|received)\b/i.test(direction);
          const rect = node.getBoundingClientRect?.();
          const geometricallyOutgoing = rect && rect.width > 0 && rect.width < window.innerWidth * 0.65
            && (rect.left + rect.width / 2) > window.innerWidth * 0.56;
          if (explicitlyIncoming || (!explicitlyOutgoing && !geometricallyOutgoing)) return false;
          const actual = normalize(`${node.innerText || node.textContent || ""} ${aria}`);
          return actual === wanted || actual.includes(wanted);
        });
      }, want);
    } catch {
      return false;
    }
  }

  // Conservative duplicate guard. It shares the same outgoing-only detector
  // used after Enter, so a visible previous copy prevents another submission.
  async lastOutgoingMatches(text) {
    return this.outgoingMessageMatches(text);
  }

  // Wait for the app shell (sidebar / composer) to be present after a load —
  // i.e. NOT sitting on the blue "Messages" splash. Used after reloads.
  async waitForAppReady(timeout = 9000) {
    const page = await this.ensurePage();
    await page.waitForFunction(() => {
      return !!document.querySelector(
        "mws-conversation-list-item, a[href*='/web/conversations/'], [aria-label*='Text message' i], [aria-label*='Start chat' i]"
      );
    }, null, { timeout }).catch(() => {});
  }

  async listConversations(limit = 20) {
    return this.withBrowserLock(() => this.listConversationsUnlocked(limit));
  }

  mergeSidebarConversationIndex(rows) {
    let changed = false;
    for (const row of rows || []) {
      if (row?.href) {
        const previous = this.sidebarConversationIndex.get(row.href);
        this.sidebarConversationIndex.set(row.href, row);
        if (!previous || previous.text !== row.text || previous.timestamp !== row.timestamp) changed = true;
      }
    }
    if (changed) this.scheduleSidebarIndexWrite();
  }

  readSidebarIndexCache() {
    const file = this.config.conversationIndexFile;
    if (!file) return new Map();
    try {
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      return new Map((Array.isArray(rows) ? rows : []).filter((row) => row?.href).map((row) => [row.href, row]));
    } catch {
      return new Map();
    }
  }

  scheduleSidebarIndexWrite() {
    if (!this.config.conversationIndexFile || this.sidebarIndexWriteTimer) return;
    this.sidebarIndexWriteTimer = setTimeout(() => {
      this.sidebarIndexWriteTimer = null;
      this.writeSidebarIndexCache();
    }, 1000);
    this.sidebarIndexWriteTimer.unref?.();
  }

  writeSidebarIndexCache() {
    const file = this.config.conversationIndexFile;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify([...this.sidebarConversationIndex.values()]));
      fs.renameSync(temp, file);
    } catch { /* cache persistence is best effort */ }
  }

  timestampIsBeforeCurrentYear(timestamp) {
    const currentYear = new Date().getFullYear();
    const years = String(timestamp || "").match(/\b20\d{2}\b/g) || [];
    return years.some((year) => Number(year) < currentYear);
  }

  async clickLoadMoreConversations(page) {
    const loadMore = page.locator("button.load-more", { hasText: /Load more conversations/i }).first();
    const attached = await loadMore.waitFor({ state: "attached", timeout: 8000 })
      .then(() => true).catch(() => false);
    if (!attached) return false;
    // After several batches Google keeps the live button in the DOM but moves
    // it to x=-9999 while virtualizing the sidebar. A physical Playwright click
    // then fails even though the button's own handler remains usable.
    return loadMore.evaluate((button) => {
      button.click();
      return true;
    }).catch(() => false);
  }

  async warmConversationIndex(onStage) {
    if (this.sidebarIndexReady) return this.sidebarIndexStats;
    if (this.sidebarIndexWarmPromise) return this.sidebarIndexWarmPromise;
    this.sidebarIndexWarmPromise = this.withBrowserLock(
      () => this.preloadConversationIndexUnlocked(onStage),
      // A busy account can expose thousands of threads. Google releases only
      // ~25 per batch and occasionally takes several seconds between batches.
      { timeoutMs: 20 * 60 * 1000 }
    ).finally(() => { this.sidebarIndexWarmPromise = null; });
    return this.sidebarIndexWarmPromise;
  }

  async preloadConversationIndexUnlocked(onStage) {
    const page = await this.ensurePage();
    await this.ensurePaired();
    onStage?.("sidebar_indexing");

    let batches = 0;
    let stalls = 0;
    let reachedPreviousYear = false;
    const startedAt = Date.now();
    const maxBatches = Math.min(this.conversationHistoryMaxBatches, this.conversationIndexMaxBatches);
    for (; batches < maxBatches && Date.now() - startedAt < this.conversationIndexBudgetMs; batches++) {
      const rows = await this.listConversationsUnlocked(1000, { loadMore: false });
      this.mergeSidebarConversationIndex(rows);
      reachedPreviousYear = rows.some((row) => this.timestampIsBeforeCurrentYear(row.timestamp));
      if (reachedPreviousYear) break;

      const before = rows.length;
      await page.evaluate(() => {
        const scroller = document.querySelector("nav.conversation-list");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }).catch(() => {});
      // Rows arrive before Google re-renders this button. Treating that brief
      // gap as end-of-history stopped the warm-up after only a few batches.
      if (!await this.clickLoadMoreConversations(page)) break;
      const grew = await page.waitForFunction(
        (count) => document.querySelectorAll("mws-conversation-list-item").length > count,
        before,
        { timeout: 8000 }
      ).then(() => true).catch(() => false);
      if (!grew) {
        if (++stalls >= 2) break;
      } else {
        stalls = 0;
      }
    }

    await page.evaluate(() => {
      const scroller = document.querySelector("nav.conversation-list");
      if (scroller) scroller.scrollTop = 0;
    }).catch(() => {});
    this.sidebarIndexReady = true;
    this.sidebarIndexStats = {
      rows: this.sidebarConversationIndex.size,
      batches,
      reachedPreviousYear,
      loadedFromDisk: false,
      elapsedMs: Date.now() - startedAt
    };
    this.writeSidebarIndexCache();
    // Google often retains every lazy-loaded row in the DOM. A clean navigation
    // keeps the in-memory/disk index but drops hundreds of expensive list nodes.
    await page.goto(`${MESSAGES_URL}/conversations`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.waitForAppReady(12000).catch(() => {});
    onStage?.("sidebar_index_ready");
    return this.sidebarIndexStats;
  }

  // The GM web sidebar lazy-loads conversations on scroll. Scroll the list
  // container down until we have `target` items rendered or no more load in.
  // Cheap when enough items are already present (the loop exits immediately).
  async loadConversationListItems(page, target) {
    let stalls = 0;
    for (let i = 0; i < Math.min(this.conversationHistoryMaxBatches, this.conversationIndexMaxBatches); i++) {
      const before = await page.locator("mws-conversation-list-item").count();
      if (before >= target) break;
      await page.evaluate(() => {
        const scroller = document.querySelector("nav.conversation-list");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }).catch(() => {});
      if (!await this.clickLoadMoreConversations(page)) break;
      const grew = await page.waitForFunction(
        (count) => document.querySelectorAll("mws-conversation-list-item").length > count,
        before,
        { timeout: 8000 }
      ).then(() => true).catch(() => false);
      if (!grew && ++stalls >= 2) break;
      if (grew) stalls = 0;
    }
    await page.evaluate(() => {
      const scroller = document.querySelector("nav.conversation-list");
      if (scroller) scroller.scrollTop = 0;
    }).catch(() => {});
  }

  async listConversationsUnlocked(limit = 20, { loadMore = limit > 15 } = {}) {
    const page = await this.ensurePage();
    if (!/\/web\/conversations/.test(page.url())) {
      await page.goto(`${MESSAGES_URL}/conversations`, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await page.waitForFunction(() => {
      const rows = [
        ...document.querySelectorAll("mws-conversation-list-item"),
        ...document.querySelectorAll("a[href*='/web/conversations/']")
      ];
      return rows.some((node) => {
        const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        return text.length > 2 && !/^Start chat$/i.test(text);
      });
    }, null, { timeout: 5000 }).catch(() => {});

    // Lazy-load more rows only when the caller wants a large list (dashboard,
    // recipient lookup). Polling (small limit) skips this to stay fast.
    if (loadMore) {
      await this.loadConversationListItems(page, limit);
    }

    const rows = await page.evaluate((maxRows) => {
      const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
      const hrefOf = (node) => {
        const href = node?.getAttribute?.("href") || node?.querySelector?.("a[href]")?.getAttribute("href") || "";
        return href ? new URL(href, location.origin).pathname : "";
      };
      const directCandidates = [
        ...document.querySelectorAll("mws-conversation-list-item"),
        ...document.querySelectorAll("a[href*='/web/conversations/']"),
        ...document.querySelectorAll("[role='listitem']"),
        ...document.querySelectorAll("[data-e2e-conversation-list-item]")
      ];

      const mapRows = (candidates) => {
        const seen = new Set();
        return candidates
        .map((node, index) => {
          const text = textOf(node);
          const href = hrefOf(node);
          const title = textOf(node.querySelector?.("h2")) || text.split(" ").slice(0, 4).join(" ");
          const snippet = textOf(node.querySelector?.("mws-conversation-snippet"));
          const timestamp = textOf(node.querySelector?.("mws-relative-timestamp"));
          const id = href || text;
          const ariaLabel = node.getAttribute?.("aria-label") || "";
          let unreadCount = 0;
          let titleBold = false;
          const badgeEl = node.querySelector?.("mws-badge") ||
                          node.querySelector?.("[aria-label*='unread' i]");
          if (badgeEl) {
            const raw = (badgeEl.innerText || badgeEl.textContent || "").replace(/\D/g, "");
            unreadCount = raw.length <= 4 ? (parseInt(raw) || 0) : 0;
          }
          const titleEl = node.querySelector?.("h2");
          if (titleEl) {
            try {
              const fw = parseInt(window.getComputedStyle(titleEl).fontWeight);
              titleBold = fw >= 600;
            } catch {}
          }
          const snippetBold = (() => {
            const el = node.querySelector?.("mws-conversation-snippet");
            if (!el) return false;
            try { return parseInt(window.getComputedStyle(el).fontWeight) >= 600; } catch { return false; }
          })();
          const unread = unreadCount > 0 || /\bunread\b/i.test(ariaLabel) || titleBold || snippetBold;
          const pinned = node.innerHTML?.includes("push_pin") ||
                         /\bpinned\b/i.test(ariaLabel) ||
                         !!node.querySelector?.("[data-mat-icon-name='push_pin']");
          return {
            id,
            index,
            href,
            title,
            snippet,
            timestamp,
            text,
            unread,
            unreadCount,
            pinned
          };
        })
        .filter((row) => row.text && row.text.length > 2)
        .filter((row) => {
          if (seen.has(row.id)) return false;
          seen.add(row.id);
          return true;
        })
        .slice(0, maxRows);
      };

      const directRows = mapRows(directCandidates).filter((row) => !/^Start chat$/i.test(row.text));
      if (directRows.length > 0) return directRows;

      const sidebarRows = [...document.querySelectorAll("body *")]
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
          return {
            id: `${Math.round(rect.top)}:${text}`,
            index,
            text,
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height
          };
        })
        .filter((row) => row.text)
        .filter((row) => row.x >= 0 && row.x < 390 && row.y > 120)
        .filter((row) => row.width > 150 && row.width < 390)
        .filter((row) => row.height >= 38 && row.height <= 95)
        .filter((row) => !/^Start chat$/i.test(row.text))
        .filter((row) => !/^Google Messages$/i.test(row.text))
        .sort((a, b) => a.y - b.y || b.width - a.width);

      const seenBands = new Set();
      return sidebarRows
        .filter((row) => {
          const band = Math.round(row.y / 12);
          if (seenBands.has(band)) return false;
          seenBands.add(band);
          return true;
        })
        .slice(0, maxRows)
        .map(({ id, index, text }) => ({ id, index, href: "", title: text, snippet: "", timestamp: "", text }));
    }, limit);

    this.mergeSidebarConversationIndex(rows);
    return rows;
  }

  // Scroll and search the sidebar for existing conversation.
  // maxScrolls limits how active we'll be, stopping immediately if any row
  // has a timestamp before the current calendar year.
  async scrollAndSearchSidebar(to, maxScrolls = 5) {
    const page = await this.ensurePage();
    let stalls = 0;

    for (let scroll = 1; scroll <= maxScrolls; scroll++) {
      const before = await page.locator("mws-conversation-list-item").count().catch(() => 0);

      await page.evaluate(() => {
        const scroller = document.querySelector("nav.conversation-list");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }).catch(() => {});

      await this.clickLoadMoreConversations(page).catch(() => {});

      const grew = await page.waitForFunction(
        (count) => document.querySelectorAll("mws-conversation-list-item").length > count,
        before,
        { timeout: 2500 }
      ).then(() => true).catch(() => false);

      const rows = await this.listConversationsUnlocked(100, { loadMore: false });
      this.mergeSidebarConversationIndex(rows);

      const match = rows.find((conversation) => this.conversationMatchesRecipient(conversation, to));
      if (match) {
        return match;
      }

      const reachedPreviousYear = rows.some((row) => this.timestampIsBeforeCurrentYear(row.timestamp));
      if (reachedPreviousYear) {
        break;
      }

      if (!grew && ++stalls >= 2) break;
      if (grew) stalls = 0;
    }

    // Default to searching overall cache index
    return [...this.sidebarConversationIndex.values()]
      .find((conversation) => this.conversationMatchesRecipient(conversation, to)) || null;
  }

  async ensurePaired() {
    await this.closeRotationTabs().catch(() => {});
    const deadline = Date.now() + this.pairedWaitMs;
    let status = await this.statusUnlocked();
    while (!status.paired) {
      // Real blockers waiting can't fix → fail fast so the caller re-pairs.
      if (status.qrVisible || status.signInVisible) break;
      if (Date.now() >= deadline) break;
      // Transient: Google cookie rotation (accounts.google.com / RotateCookiesPage)
      // or a mid-load page where the composer hasn't rendered yet. Don't fail the
      // send — nudge back to conversations if parked on auth, then re-check. This
      // is what stops a brief rotation from draining the whole queue into failures.
      if (/accounts\.google\.com|RotateCookies/i.test(status.url)) {
        await this.page.goto(`${MESSAGES_URL}/conversations`, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      await this.page.waitForTimeout(1000).catch(() => {});
      status = await this.statusUnlocked();
    }
    if (!status.paired) {
      const error = new Error(`Google Messages is not ready: ${status.hint}`);
      // This happens before the composer is touched, so the queue worker can
      // safely reload/reconnect Chrome and retry without risking a duplicate.
      error.code = "GOOGLE_MESSAGES_NOT_READY";
      error.statusCode = 409;
      error.details = status;
      throw error;
    }
  }

  async openConversation(query) {
    return this.withBrowserLock(() => this.openConversationUnlocked(query));
  }

  async openConversationUnlocked(query = {}) {
    const page = await this.ensurePage();
    await this.ensurePaired();

    const hrefToOpen = query.href || null;

    if (hrefToOpen) {
      // Already on this conversation? Nothing to do.
      const convId = hrefToOpen.split("/").pop();
      if (page.url().includes(convId)) {
        return { opened: true, conversation: { href: hrefToOpen, id: hrefToOpen, title: query.title || "" } };
      }

      // Prefer SPA click (fast) over full page navigation (slow)
      const clicked = await this.clickConversationInSidebar(page, hrefToOpen);
      if (!clicked) {
        // Sidebar link not visible — fall back to full navigation
        await page.goto(new URL(hrefToOpen, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
      return { opened: true, conversation: { href: hrefToOpen, id: hrefToOpen, title: query.title || "" } };
    }

    const conversations = await this.listConversationsUnlocked(100);
    const match = this.findConversation(conversations, query);
    if (!match) {
      const error = new Error("Conversation not found.");
      error.statusCode = 404;
      error.details = { query };
      throw error;
    }

    if (match.href) {
      const clicked = await this.clickConversationInSidebar(page, match.href);
      if (!clicked) {
        await page.goto(new URL(match.href, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    } else {
      await page.getByText(match.title || match.text, { exact: false }).first().click();
    }

    return { opened: true, conversation: match };
  }

  async clickConversationInSidebar(page, href) {
    const convId = href.split("/").pop();
    try {
      const link = page.locator(`a[href*="${convId}"]`).first();
      await link.waitFor({ state: "attached", timeout: 1500 });
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await link.click();
      await page.waitForFunction(
        (expectedId) => {
          const activeId = location.pathname.match(/\/web\/conversations\/([^/?#]+)/i)?.[1] || "";
          return activeId === expectedId;
        },
        convId,
        { timeout: this.conversationLoadTimeoutMs }
      );
      return this.isExpectedConversationUrl(page.url(), href);
    } catch {
      return false;
    }
  }

  async waitForMessages(timeout = 8000) {
    const page = await this.ensurePage();
    await page.waitForFunction(
      () => document.querySelector("mws-text-message-part, mws-tombstone-message-wrapper"),
      null, { timeout }
    ).catch(() => {});
  }

  findConversation(conversations, query) {
    if (Number.isInteger(query.index)) return conversations[query.index] || null;
    if (query.href) return conversations.find((row) => row.href === query.href || row.id === query.href) || null;
    if (query.id) return conversations.find((row) => row.id === query.id || row.href === query.id) || null;
    if (query.title) {
      const title = query.title.toLowerCase();
      return conversations.find((row) => row.title.toLowerCase() === title)
        || conversations.find((row) => row.title.toLowerCase().includes(title));
    }
    return null;
  }

  conversationMatchesRecipient(conversation, to) {
    // Never match against `text` or `snippet`: they include the previous SMS
    // body, which commonly contains another customer's renewal identifier or
    // phone number. Matching that preview can open the wrong conversation.
    const titleDigits = this.normalizePhone(conversation.title);
    return this.phoneVariants(to).some((variant) => variant.length >= 7 && titleDigits === variant);
  }

  isExpectedConversationUrl(currentUrl, expectedHref) {
    try {
      const current = new URL(currentUrl, MESSAGES_URL);
      const expected = new URL(expectedHref, MESSAGES_URL);
      const currentId = current.pathname.match(/\/web\/conversations\/([^/?#]+)/i)?.[1] || "";
      const expectedId = expected.pathname.match(/\/web\/conversations\/([^/?#]+)/i)?.[1] || "";
      return Boolean(currentId && expectedId && currentId === expectedId && currentId.toLowerCase() !== "new");
    } catch {
      return false;
    }
  }

  normalizePhone(value) {
    return String(value || "").replace(/\D/g, "");
  }

  phoneVariants(value) {
    const digits = this.normalizePhone(value);
    const variants = new Set([digits]);
    if (digits.startsWith("98")) variants.add(`0${digits.slice(2)}`);
    if (digits.startsWith("0")) variants.add(`98${digits.slice(1)}`);
    if (digits.length > 10) variants.add(digits.slice(-10));
    return [...variants].filter(Boolean);
  }

  recipientCacheKey(to) {
    return this.phoneVariants(to).sort((a, b) => b.length - a.length)[0] || String(to);
  }

  recipientEvidenceFromText(to, text, source, hrefOrUrl = "") {
    const phoneTokens = String(text || "").match(/(?:\+?\d[\d\s().-]{5,}\d)/g) || [];
    const normalizedTokens = phoneTokens.map((token) => this.normalizePhone(token)).filter(Boolean);
    const matchedVariant = this.phoneVariants(to)
      .filter((variant) => variant.length >= 7)
      .find((variant) => normalizedTokens.includes(variant));
    if (!matchedVariant) return null;
    let conversationUrl = "";
    try { conversationUrl = new URL(hrefOrUrl || "/", MESSAGES_URL).toString(); } catch { /* leave blank */ }
    return {
      cacheKey: this.recipientCacheKey(to),
      requestedTo: String(to),
      sentTo: String(to),
      source,
      matchedVariant,
      matchedText: String(text || "").replace(/\s+/g, " ").trim().slice(0, 240),
      conversationUrl
    };
  }

  readConversationCache() {
    try {
      if (!fs.existsSync(this.config.conversationCacheFile)) return { recipients: {} };
      return JSON.parse(fs.readFileSync(this.config.conversationCacheFile, "utf8"));
    } catch {
      return { recipients: {} };
    }
  }

  writeConversationCache() {
    fs.mkdirSync(path.dirname(this.config.conversationCacheFile), { recursive: true });
    fs.writeFileSync(this.config.conversationCacheFile, JSON.stringify(this.conversationCache, null, 2));
  }

  getCachedRecipientConversation(to) {
    const cacheKey = this.recipientCacheKey(to);
    const cached = this.conversationCache.recipients?.[cacheKey] || null;
    // Old cache entries did not carry recipient proof. Ignore them so an old,
    // possibly incorrect number -> conversation mapping can never authorize a send.
    return cached?.verifiedTo === cacheKey && cached?.recipientEvidence?.cacheKey === cacheKey ? cached : null;
  }

  getLegacyRecipientCandidate(to) {
    const cacheKey = this.recipientCacheKey(to);
    const cached = this.conversationCache.recipients?.[cacheKey] || null;
    if (!cached?.href || this.getCachedRecipientConversation(to)) return null;
    try {
      const parsed = new URL(cached.href, MESSAGES_URL);
      if (!parsed.pathname.includes("/web/conversations/")) return null;
      return { href: parsed.pathname, title: cached.title || "" };
    } catch {
      return null;
    }
  }

  cacheRecipientConversation(to, hrefOrUrl, title = "", recipientEvidence = null) {
    const parsedUrl = new URL(hrefOrUrl, MESSAGES_URL);
    if (!parsedUrl.pathname.includes("/web/conversations/")) return;
    const cacheKey = this.recipientCacheKey(to);
    if (!recipientEvidence || recipientEvidence.cacheKey !== cacheKey) return;
    this.conversationCache.recipients ||= {};
    this.conversationCache.recipients[cacheKey] = {
      href: parsedUrl.pathname,
      title,
      verifiedTo: cacheKey,
      recipientEvidence: { ...recipientEvidence, conversationUrl: parsedUrl.toString() },
      updatedAt: new Date().toISOString()
    };
    this.writeConversationCache();
  }

  deleteCachedRecipientConversation(to) {
    if (!this.conversationCache.recipients) return;
    delete this.conversationCache.recipients[this.recipientCacheKey(to)];
    this.writeConversationCache();
  }

  // Click a recipient suggestion to actually OPEN the conversation. GM shows a
  // "Send to <number>" row and (if known) a contact row — clicking either opens
  // the thread. We try each, and only return true once the message composer is
  // really present, so a click that didn't commit is treated as a miss.
  async clickRecipientOption(to) {
    const page = await this.ensurePage();
    const local = to.replace(/^\+98/, "0");
    // Most specific first: the exact "Send to <number>" row, then any suggestion
    // row that contains the number (contact match), then scoped/option selectors.
    // We avoid generic text=number selectors as they can pre-emptively match the
    // currently-typed search input box or header chips instead of the dropdown options.
    const selectors = [
      `text=Send to ${to}`,
      `text=Send to ${local}`,
      `[role='option']:has-text("${to}")`,
      `[role='listitem']:has-text("${to}")`,
      `[role='option']:has-text("${local}")`,
      `mws-contact-selection-list :has-text("${to}")`,
      `mws-contact-selection-list :has-text("${local}")`,
      `mws-contact-selection-list-item :has-text("${to}")`,
      `mws-contact-selection-list-item :has-text("${local}")`,
      `mws-contact-selection-list-item:has-text("${to}")`,
      `mws-contact-selection-list-item:has-text("${local}")`
    ];

    let option;
    try {
      // Race all selectors and click exactly one result. The old sequential
      // loop could spend 40+ seconds clicking the same selected chip through
      // different selectors.
      option = await this.locatorFirst(selectors);
      const optionText = await option.evaluate((node) => {
        const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        const aria = node.getAttribute?.("aria-label") || "";
        return `${text} ${aria}`.trim();
      });
      const evidence = this.recipientEvidenceFromText(to, optionText, "recipient_option", page.url());
      if (!evidence) return { status: "missing", evidence: null };
      await option.click({ timeout: 1500 });
      if (await this.conversationLoaded(this.conversationLoadTimeoutMs)) {
        return { status: "opened", evidence: { ...evidence, conversationUrl: page.url() } };
      }
      return { status: "selected", evidence };
    } catch {
      return { status: "missing", evidence: null };
    }
  }

  async extractMessagesFromPage(page, limit) {
    await page.waitForFunction(() => {
      const body = document.body.innerText || "";
      const loaded = !/Loading messages/i.test(body);
      return loaded && document.querySelector("mws-text-message-part, mws-tombstone-message-wrapper");
    }, null, { timeout: 8000 }).catch(() => {});

    return page.evaluate((maxRows) => {
      const directCandidates = [
        ...document.querySelectorAll("mws-text-message-part"),
        ...document.querySelectorAll("mws-tombstone-message-wrapper")
      ];
      const fallbackCandidates = [...document.querySelectorAll("body *")]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left > 340 && rect.top > 130 && rect.top < window.innerHeight - 80
            && rect.width > 8 && rect.width < 850 && rect.height > 8 && rect.height < 180;
        });
      const candidates = directCandidates.length ? directCandidates : fallbackCandidates;
      return candidates
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const tag = node.tagName.toLowerCase();
          const aria = node.getAttribute("aria-label") || "";
          const type = tag === "mws-tombstone-message-wrapper" ? "timestamp" : "message";
          const dirFromAria = aria.startsWith("You said:") ? "out" : aria.includes(" said:") ? "in" : "";
          const direction = dirFromAria || (type !== "timestamp" ? (Math.round(rect.left) > 720 ? "out" : "in") : "");
          return {
            index,
            type,
            direction,
            aria,
            text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim(),
            x: Math.round(rect.left),
            y: Math.round(rect.top)
          };
        })
        .filter((row) => row.text)
        .filter((row) => !/^Text message/i.test(row.text))
        .filter((row) => !/^(SMS|MMS|RCS)$/i.test(row.text))
        .filter((row) => !/^\d+$/.test(row.text))
        .filter((row) => !/^0 new messages$/i.test(row.text))
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .filter((row, idx, rows) => rows.findIndex((other) => other.text === row.text && Math.abs(other.y - row.y) < 4) === idx)
        .map(({ index, type, direction, text, aria }) => ({ index, type, direction, text, aria }))
        .slice(-maxRows);
    }, limit);
  }

  async getActiveConversationMessages(limit = 50) {
    return this.withBrowserLock(() => this.getActiveConversationMessagesUnlocked(limit));
  }

  async getActiveConversationMessagesUnlocked(limit = 50) {
    const page = await this.ensurePage();
    return this.extractMessagesFromPage(page, limit);
  }

  async getConversationMessages(query, limit = 50) {
    this.userActionInProgress = true;
    try {
      return await this.withBrowserLock(async () => {
        const opened = await this.openConversationUnlocked(query);
        const messages = await this.getActiveConversationMessagesUnlocked(limit);
        return { conversation: opened.conversation, messages };
      });
    } finally {
      this.userActionInProgress = false;
    }
  }

  async debugSidebarElements(limit = 80) {
    return this.withBrowserLock(() => this.debugSidebarElementsUnlocked(limit));
  }

  async debugSidebarElementsUnlocked(limit = 80) {
    const page = await this.ensurePage();
    return page.evaluate((maxRows) => {
      return [...document.querySelectorAll("body *")]
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
          return {
            index,
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute("role") || "",
            aria: node.getAttribute("aria-label") || "",
            text,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        })
        .filter((row) => row.text || row.aria)
        .filter((row) => row.x >= 0 && row.x < 430 && row.y >= 0)
        .slice(0, maxRows);
    }, limit);
  }

  async debugMainElements(limit = 120) {
    return this.withBrowserLock(async () => {
      const page = await this.ensurePage();
      return page.evaluate((maxRows) => {
        return [...document.querySelectorAll("body *")]
          .map((node, index) => {
            const rect = node.getBoundingClientRect();
            const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
            return {
              index,
              tag: node.tagName.toLowerCase(),
              role: node.getAttribute("role") || "",
              aria: node.getAttribute("aria-label") || "",
              text,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
          })
          .filter((row) => row.text || row.aria)
          .filter((row) => row.x > 330 && row.y > 70)
          .slice(0, maxRows);
      }, limit);
    });
  }

  startPolling() {
    if (this.config.pollIntervalMs <= 0) return;
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pollConversations().catch((error) => {
        this.emit("error", error);
      });
    }, this.config.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // Close Google's accounts.google.com/RotateCookiesPage tab(s). That tab is
  // opened by Google to rotate session cookies; when its rotation stalls it
  // wedges the Messages session (page spins, sends hang). We don't need it —
  // closing it lets the main page keep working. Touches only OTHER pages, so it
  // is safe to run without the browser lock.
  // force=true closes any rotation tab immediately (used during recovery when the
  // session is already wedged). Otherwise a fresh rotation tab gets rotationGraceMs
  // to complete on its own; only a stalled tab (open past the grace) is closed.
  async closeRotationTabs(force = false) {
    const browser = this.browser;
    const context = this.context;
    if (!browser && !context) return 0;
    const contexts = browser ? browser.contexts() : [context];
    let closed = 0;
    const now = Date.now();
    for (const ctx of contexts) {
      let pages = [];
      try { pages = ctx.pages(); } catch { continue; }
      for (const pg of pages) {
        if (pg === this.page) continue;
        let url = "";
        try { url = pg.url() || ""; } catch { continue; }
        if (!/accounts\.google\.com\/RotateCookies/i.test(url)) continue;
        if (force) {
          await pg.close().catch(() => {});
          closed += 1;
          continue;
        }
        const seen = this.rotationSeen.get(pg);
        if (seen === undefined) {
          // First sighting — start the grace clock, let rotation try to finish.
          this.rotationSeen.set(pg, now);
          continue;
        }
        if (now - seen >= this.rotationGraceMs) {
          await pg.close().catch(() => {});
          closed += 1;
        }
      }
    }
    return closed;
  }

  startRotationGuard() {
    if (this.rotationTimer || this.rotationGuardMs <= 0) return;
    this.rotationTimer = setInterval(() => {
      this.closeRotationTabs().catch(() => {});
    }, this.rotationGuardMs);
    this.rotationTimer.unref?.();
  }

  stopRotationGuard() {
    if (!this.rotationTimer) return;
    clearInterval(this.rotationTimer);
    this.rotationTimer = null;
  }

  async pollConversations() {
    if (!this.page || this.page.isClosed()) return;
    if (this.userActionInProgress) return; // user action has priority — skip this cycle
    await this.withBrowserLock(async () => {
      if (this.userActionInProgress) return; // re-check after acquiring lock
      const status = await this.statusUnlocked();
      if (!status.paired || this.userActionInProgress) return;

      const conversations = await this.listConversationsUnlocked(10);
      for (const conversation of conversations) {
        const previous = this.lastConversationFingerprint.get(conversation.id);
        if (previous && previous !== conversation.text) {
          const event = {
            type: "conversation_changed",
            conversation,
            previousText: previous,
            at: new Date().toISOString()
          };
          this.emit("conversation:changed", event);
        }
        this.lastConversationFingerprint.set(conversation.id, conversation.text);
      }
    });
  }

  async locatorFirst(selectors) {
    const page = await this.ensurePage();
    return new Promise((resolve, reject) => {
      let done = false;
      let pending = selectors.length;
      const missed = [];
      for (const selector of selectors) {
        const loc = page.locator(selector).first();
        loc.waitFor({ state: "visible", timeout: 5000 })
          .then(() => { if (!done) { done = true; resolve(loc); } })
          .catch((err) => {
            missed.push(selector);
            if (--pending === 0 && !done) {
              reject(new Error(`Element not found. Tried: ${missed.join(", ")}`));
            }
          });
      }
    });
  }

  async clickFirst(selectors, label) {
    const locator = await this.locatorFirst(selectors);
    await locator.click();
    return { clicked: label };
  }

  async clickOptional(selectors) {
    for (const selector of selectors) {
      try {
        const locator = await this.locatorFirst([selector]);
        await locator.click();
        return true;
      } catch {
        // Try the next selector.
      }
    }
    return false;
  }

  async isVisible(selectors) {
    const page = await this.ensurePage();
    for (const selector of selectors) {
      try {
        if (await page.locator(selector).first().isVisible({ timeout: 1000 })) return true;
      } catch {
        // Try the next selector.
      }
    }
    return false;
  }

  async withBrowserLock(action, { timeoutMs = this.lockTimeoutMs } = {}) {
    const previous = this.actionLock;
    const requestedAt = Date.now();
    let release;
    this.actionLock = new Promise((resolve) => {
      release = resolve;
    });

    try {
      if (!timeoutMs) {
        await previous.catch(() => {});
        return await action();
      }
      // The budget covers BOTH waiting for the previous owner and executing
      // this action. Previously the wait was unbounded, so a job could remain
      // "active" without emitting a single stage while an orphaned browser
      // operation held the lock ahead of it.
      let waitTimer;
      try {
        await Promise.race([
          previous.catch(() => {}),
          new Promise((_, reject) => {
            waitTimer = setTimeout(() => reject(new Error("browser_lock_wait_timeout")), timeoutMs);
          })
        ]);
      } finally {
        clearTimeout(waitTimer);
      }

      const remainingMs = Math.max(1, timeoutMs - (Date.now() - requestedAt));
      // Watchdog: never hold the lock longer than timeoutMs. If the action
      // wedges, reject so the lock frees and the queue keeps moving. The
      // orphaned action is abandoned; the worker triggers recover() on repeated
      // failures to rebuild a clean page.
      let timer;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("browser_lock_timeout")), remainingMs);
      });
      try {
        return await Promise.race([action(), guard]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      release();
    }
  }

  // Drop the current (possibly wedged) page and reconnect to the external
  // Chrome with a fresh Messages page. Does NOT kill the Chrome process.
  async recover({ reload = false } = {}) {
    return this.withBrowserLock(async () => {
      this.stopPolling();
      // Session is wedged — force-close any rotation tab immediately (skip grace).
      await this.closeRotationTabs(true).catch(() => {});
      // In connect mode the browser process is owned by gmweb-chrome.service;
      // just drop our refs and reconnect rather than closing it.
      this.browser = null;
      this.context = null;
      this.page = null;
      await this.startUnlocked();
      if (reload) {
        await this.page.goto(`${MESSAGES_URL}/conversations`, { waitUntil: "domcontentloaded" });
        await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      }
      return { recovered: true, reloaded: reload, at: new Date().toISOString() };
    }, { timeoutMs: 60000 });
  }
}

module.exports = {
  GoogleMessagesClient,
  normalizeComparableMessage
};
