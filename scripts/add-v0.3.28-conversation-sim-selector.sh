#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT_DIR/.manual-patches/v0.3.28-conversation-sim-$STAMP"

cd "$ROOT_DIR"
test "$(node -p "require('./package.json').version")" = "0.3.28"
mkdir -p "$BACKUP_DIR/src" "$BACKUP_DIR/dashboard-next/src/pages"
cp -p src/googleMessagesClient.js "$BACKUP_DIR/src/googleMessagesClient.js"
cp -p src/server.js "$BACKUP_DIR/src/server.js"
cp -p dashboard-next/src/pages/Conversations.tsx "$BACKUP_DIR/dashboard-next/src/pages/Conversations.tsx"

ROOT_DIR="$ROOT_DIR" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.ROOT_DIR;

function replaceOnce(source, oldText, newText, label) {
  const at = source.indexOf(oldText);
  if (at < 0) throw new Error(`Expected block not found: ${label}`);
  if (source.indexOf(oldText, at + oldText.length) >= 0) throw new Error(`Duplicate block: ${label}`);
  return source.slice(0, at) + newText + source.slice(at + oldText.length);
}

const clientFile = path.join(root, "src/googleMessagesClient.js");
let client = fs.readFileSync(clientFile, "utf8");
if (client.includes("requestedSim")) throw new Error("SIM selection backend is already installed.");
client = replaceOnce(
  client,
`        if (!await this.composerReady(8000)) {
          const error = new Error("The selected conversation composer is not ready.");
          error.statusCode = 503;
          throw error;
        }

        const input = await this.locatorFirst([`,
`        if (!await this.composerReady(8000)) {
          const error = new Error("The selected conversation composer is not ready.");
          error.statusCode = 503;
          throw error;
        }

        const requestedSim = String(query.sim || "").trim();
        if (!/^[12]$/.test(requestedSim)) {
          const error = new Error("Select SIM 1 or SIM 2 before sending.");
          error.statusCode = 400;
          throw error;
        }

        const simPicker = page.locator(
          "button[data-e2e-sim-info-picker-button], button[aria-label='Select a SIM']"
        ).first();
        if (!await simPicker.isVisible().catch(() => false)) {
          const error = new Error("Google Messages did not expose the SIM selector; message was not sent.");
          error.statusCode = 409;
          throw error;
        }

        const currentSim = (await simPicker.innerText()).replace(/\\s+/g, "").trim();
        if (currentSim !== requestedSim) {
          await simPicker.click();
          const simOption = page.locator("button[role='menuitem']").filter({
            has: page.locator(".sim-icon-label", { hasText: new RegExp(\`^\\s*\${requestedSim}\\s*$\`) })
          }).first();
          if (!await simOption.isVisible().catch(() => false)) {
            await page.keyboard.press("Escape").catch(() => {});
            const error = new Error(\`SIM \${requestedSim} is not available in Google Messages.\`);
            error.statusCode = 409;
            throw error;
          }
          await simOption.click();
          await page.waitForFunction((wantedSim) => {
            const picker = document.querySelector(
              "button[data-e2e-sim-info-picker-button], button[aria-label='Select a SIM']"
            );
            return (picker?.innerText || "").replace(/\\s+/g, "").trim() === wantedSim;
          }, requestedSim, { timeout: 3000 }).catch(() => {});
        }

        const confirmedSim = (await simPicker.innerText()).replace(/\\s+/g, "").trim();
        if (confirmedSim !== requestedSim) {
          const error = new Error(\`Could not activate SIM \${requestedSim}; message was not sent.\`);
          error.statusCode = 409;
          throw error;
        }

        const input = await this.locatorFirst([`,
  "client SIM selection"
);
client = replaceOnce(
  client,
`          conversationUrl: page.url(),
          text: message,
          at: new Date().toISOString()`,
`          conversationUrl: page.url(),
          text: message,
          sim: requestedSim,
          at: new Date().toISOString()`,
  "client event SIM"
);
fs.writeFileSync(clientFile, client, "utf8");

const serverFile = path.join(root, "src/server.js");
let server = fs.readFileSync(serverFile, "utf8");
server = replaceOnce(
  server,
`    { href: request.body.href, title: request.body.title || "" },
    request.body.text`,
`    {
      href: request.body.href,
      title: request.body.title || "",
      sim: String(request.headers["x-gmweb-sim"] || "")
    },
    request.body.text`,
  "server SIM header"
);
fs.writeFileSync(serverFile, server, "utf8");

const uiFile = path.join(root, "dashboard-next/src/pages/Conversations.tsx");
let ui = fs.readFileSync(uiFile, "utf8");
ui = replaceOnce(
  ui,
`  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);`,
`  const [draft, setDraft] = useState("");
  const [selectedSim, setSelectedSim] = useState(() => localStorage.getItem("gmweb:reply-sim") || "2");
  const [sending, setSending] = useState(false);`,
  "UI SIM state"
);
ui = replaceOnce(
  ui,
`      await api("/conversations/reply", {
        method: "POST",
        body: { href: open.href, title: open.title, text: draft.trim() },
      });`,
`      await api("/conversations/reply", {
        method: "POST",
        headers: { "X-GMweb-SIM": selectedSim },
        body: { href: open.href, title: open.title, text: draft.trim() },
      });`,
  "UI SIM request"
);
ui = replaceOnce(
  ui,
`            <form onSubmit={send} className="flex items-center gap-2 border-t border-border p-3">
              <input`,
`            <form onSubmit={send} className="flex items-center gap-2 border-t border-border p-3">
              <select
                value={selectedSim}
                onChange={(e) => {
                  setSelectedSim(e.target.value);
                  localStorage.setItem("gmweb:reply-sim", e.target.value);
                }}
                disabled={sending}
                aria-label="Sending SIM"
                title="Choose the SIM used for this reply"
                className="h-10 rounded-full border border-input bg-background/60 px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <option value="1">SIM 1 — Nima best</option>
                <option value="2">SIM 2 — IR-MCI</option>
              </select>
              <input`,
  "UI SIM selector"
);
fs.writeFileSync(uiFile, ui, "utf8");

console.log("Installed guarded per-reply SIM selection.");
NODE

node --check src/googleMessagesClient.js
node --check src/server.js
npm --prefix dashboard-next run build
systemctl restart gmweb-api.service
sleep 2
test "$(systemctl is-active gmweb-api.service)" = "active"

echo "SIM selector installed. Backup: $BACKUP_DIR"
