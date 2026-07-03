const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_SETTINGS = Object.freeze({
  maxPerMinute: 4,
  randomDelayEnabled: false,
  randomExtraSeconds: 0
});

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeSendPacingSettings(value = {}, fallback = DEFAULT_SETTINGS) {
  return {
    maxPerMinute: clampInteger(value.maxPerMinute, fallback.maxPerMinute, 1, 60),
    randomDelayEnabled: typeof value.randomDelayEnabled === "boolean"
      ? value.randomDelayEnabled
      : fallback.randomDelayEnabled,
    randomExtraSeconds: clampInteger(value.randomExtraSeconds, fallback.randomExtraSeconds, 0, 120)
  };
}

class SendPacingController {
  constructor({ filePath, defaults = DEFAULT_SETTINGS, minuteMs = 60000, now = Date.now, random = Math.random } = {}) {
    this.filePath = filePath;
    this.minuteMs = minuteMs;
    this.now = now;
    this.random = random;
    this.settings = normalizeSendPacingSettings(defaults, DEFAULT_SETTINGS);
    this.updatedAt = null;
    this.lastSendStartedAt = 0;
    this.revision = 0;
    this.waiters = new Set();
  }

  snapshot() {
    const minimumIntervalMs = Math.ceil(this.minuteMs / this.settings.maxPerMinute);
    return {
      ...this.settings,
      minimumIntervalSeconds: Math.round((minimumIntervalMs / 1000) * 10) / 10,
      maximumIntervalSeconds: Math.round((minimumIntervalMs / 1000 + (this.settings.randomDelayEnabled ? this.settings.randomExtraSeconds : 0)) * 10) / 10,
      updatedAt: this.updatedAt
    };
  }

  async load() {
    if (!this.filePath) return this.snapshot();
    try {
      const saved = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.settings = normalizeSendPacingSettings(saved, this.settings);
      this.updatedAt = typeof saved.updatedAt === "string" ? saved.updatedAt : null;
    } catch {
      // Missing or invalid settings keep the environment-backed defaults.
    }
    return this.snapshot();
  }

  async update(value) {
    const next = normalizeSendPacingSettings(value, this.settings);
    const updatedAt = new Date(this.now()).toISOString();
    if (this.filePath) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify({ ...next, updatedAt }, null, 2), "utf8");
      await fs.rename(temporaryPath, this.filePath);
    }
    this.settings = next;
    this.updatedAt = updatedAt;
    this.revision += 1;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    return this.snapshot();
  }

  randomExtraMs(settings = this.settings) {
    if (!settings.randomDelayEnabled || settings.randomExtraSeconds <= 0) return 0;
    return Math.floor(this.random() * (settings.randomExtraSeconds * 1000 + 1));
  }

  waitOrSettingsChange(waitMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(reason);
      };
      const wake = () => finish("settings_changed");
      const timer = setTimeout(() => finish("timer"), waitMs);
      this.waiters.add(wake);
    });
  }

  async wait({ onWait } = {}) {
    let revision = this.revision;
    let randomExtraMs = this.randomExtraMs();
    for (;;) {
      if (revision !== this.revision) {
        revision = this.revision;
        randomExtraMs = this.randomExtraMs();
      }
      const settings = this.snapshot();
      const minimumIntervalMs = Math.ceil(this.minuteMs / settings.maxPerMinute);
      const waitMs = Math.max(0, this.lastSendStartedAt + minimumIntervalMs + randomExtraMs - this.now());
      if (waitMs <= 0) {
        this.lastSendStartedAt = this.now();
        return { waitMs: 0, randomExtraMs, settings };
      }
      onWait?.({ waitMs, randomExtraMs, settings });
      await this.waitOrSettingsChange(waitMs);
    }
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  SendPacingController,
  normalizeSendPacingSettings
};
