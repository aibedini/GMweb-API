// Device key for the android pull bridge. Precedence: data file (dashboard-
// managed) > ANDROID_DEVICE_KEY env > generated on first need. Kept separate
// from gmw_ project keys: those authorize message consumers; this authorizes
// a delivery DEVICE picking up queued sends.
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

class DeviceKeyStore {
  constructor({ filePath, envValue }) {
    this.filePath = filePath;
    this.envValue = (envValue || "").trim();
    this.key = "";
    this.source = "none"; // none | env | file
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed && typeof parsed.key === "string" && parsed.key.trim()) {
        this.key = parsed.key.trim();
        this.source = "file";
        return this;
      }
    } catch { /* no file yet */ }
    if (this.envValue) {
      this.key = this.envValue;
      this.source = "env";
    }
    return this;
  }

  get configured() { return Boolean(this.key); }

  /** Masked form safe to show at a glance: devk_…abcd */
  preview() {
    return this.configured ? `${this.key.slice(0, 5)}…${this.key.slice(-4)}` : null;
  }

  async generate() {
    this.key = `devk_${crypto.randomBytes(24).toString("base64url")}`;
    this.source = "file";
    await this.#persist();
    return this.key;
  }

  async set(key) {
    const k = String(key || "").trim();
    if (k.length < 16) throw new Error("key_too_short");
    this.key = k;
    this.source = "file";
    await this.#persist();
    return this.key;
  }

  async #persist() {
    await fs.mkdir(require("node:path").dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify({ key: this.key, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  }
}

module.exports = { DeviceKeyStore };
