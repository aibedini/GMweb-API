#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT_DIR/.manual-patches/v0.3.28-direct-reply-repair-$STAMP"

if [[ "$VERSION" != "0.3.28" ]]; then
  echo "ERROR: expected gmweb v0.3.28, detected v$VERSION" >&2
  exit 1
fi

cd "$ROOT_DIR"
mkdir -p "$BACKUP_DIR/src" "$BACKUP_DIR/dashboard-next/src/pages"
cp -p src/googleMessagesClient.js "$BACKUP_DIR/src/googleMessagesClient.js"
cp -p dashboard-next/src/pages/Conversations.tsx "$BACKUP_DIR/dashboard-next/src/pages/Conversations.tsx"

ROOT_DIR="$ROOT_DIR" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.ROOT_DIR;

const clientFile = path.join(root, "src/googleMessagesClient.js");
let client = fs.readFileSync(clientFile, "utf8");
if (!client.includes("async replyToConversation(query, text)")) {
  throw new Error("The direct-conversation reply patch is not installed.");
}
if (client.includes("direct_reply_clicking_send") && !client.includes("this.isExpectedConversationUrl")) {
  throw new Error("This repair is already installed.");
}

const start = client.indexOf("  async replyToConversation(query, text) {");
const end = client.indexOf("  async getConversationMessages(query, limit = 50) {", start);
if (start < 0 || end < 0) throw new Error("Could not locate replyToConversation method boundaries.");

const repairedMethod = `  async replyToConversation(query, text) {
    const message = String(text || "").trim();
    if (!query?.href || !message) {
      const error = new Error("Conversation href and message text are required.");
      error.statusCode = 400;
      throw error;
    }

    this.userActionInProgress = true;
    try {
      return await this.withBrowserLock(async () => {
        const opened = await this.openConversationUnlocked({
          href: query.href,
          title: query.title || ""
        });
        const page = await this.ensurePage();

        const matchesSelectedConversation = () => {
          const expectedId = String(query.href || "").split("/").filter(Boolean).pop();
          if (!expectedId) return false;
          try {
            const activeId = new URL(page.url()).pathname.split("/").filter(Boolean).pop();
            return activeId === expectedId;
          } catch {
            return false;
          }
        };

        if (!matchesSelectedConversation()) {
          const error = new Error("Refusing to reply: the selected conversation was not opened.");
          error.statusCode = 409;
          throw error;
        }
        if (!await this.composerReady(8000)) {
          const error = new Error("The selected conversation composer is not ready.");
          error.statusCode = 503;
          throw error;
        }

        const input = await this.locatorFirst([
          "[aria-label*='Text message' i]",
          "textarea[aria-label*='message' i]",
          "textarea[placeholder*='message' i]",
          "[contenteditable='true'][aria-label*='message' i]",
          "textarea"
        ]);
        const wanted = message.replace(/\\s+/g, " ").trim();
        const before = await page.locator("mws-text-message-part").count();

        await input.fill(message).catch(async () => {
          await input.click();
          await page.keyboard.type(message);
        });

        if (!matchesSelectedConversation()) {
          const error = new Error("Conversation changed before Send; reply was cancelled.");
          error.statusCode = 409;
          throw error;
        }

        // direct_reply_clicking_send: prefer Google's actual Send button. Enter
        // is retained only as a fallback for layouts without an exposed button.
        const sendSelectors = [
          "button[aria-label='Send SMS' i]",
          "button[aria-label='Send message' i]",
          "button[aria-label^='Send' i]",
          "mws-message-send-button button",
          "mws-send-button button"
        ];
        let clicked = false;
        for (const selector of sendSelectors) {
          const button = page.locator(selector).last();
          if (await button.isVisible().catch(() => false)) {
            await button.click();
            clicked = true;
            break;
          }
        }
        if (!clicked) await input.press("Enter");

        try {
          await page.waitForFunction(({ countBefore, expected }) => {
            const rows = [...document.querySelectorAll("mws-text-message-part")];
            if (rows.length <= countBefore) return false;
            return rows.slice(countBefore).some((node) => {
              const actual = (node.innerText || node.textContent || "")
                .replace(/\\s+/g, " ").trim();
              return actual === expected || actual.includes(expected);
            });
          }, { countBefore: before, expected: wanted }, { timeout: 12000 });
        } catch {
          const error = new Error("Send was clicked, but no outgoing message bubble was confirmed.");
          error.statusCode = 502;
          error.code = "SEND_UNVERIFIED";
          throw error;
        }

        const event = {
          type: "sent",
          conversation: opened.conversation,
          conversationUrl: page.url(),
          text: message,
          at: new Date().toISOString()
        };
        this.emit("message:sent", event);
        return event;
      });
    } finally {
      this.userActionInProgress = false;
    }
  }

`;

client = client.slice(0, start) + repairedMethod + client.slice(end);
fs.writeFileSync(clientFile, client, "utf8");
console.log("Repaired src/googleMessagesClient.js");

const uiFile = path.join(root, "dashboard-next/src/pages/Conversations.tsx");
let ui = fs.readFileSync(uiFile, "utf8");
if (!ui.includes('api("/conversations/reply"')) {
  throw new Error("The direct-conversation reply UI patch is not installed.");
}
if (ui.includes("Reply failed:")) {
  throw new Error("The UI error repair is already installed.");
}

const oldFinally = `      setTimeout(() => open && loadThread(open, true), 2500);
    } finally {
      setSending(false);
    }`;
const newFinally = `      setTimeout(() => open && loadThread(open, true), 1200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown reply error";
      window.alert(\`Reply failed: \${message}\`);
    } finally {
      setSending(false);
    }`;
if (!ui.includes(oldFinally)) throw new Error("Could not locate the UI send completion block.");
ui = ui.replace(oldFinally, newFinally);
fs.writeFileSync(uiFile, ui, "utf8");
console.log("Repaired dashboard-next/src/pages/Conversations.tsx");
NODE

node --check src/googleMessagesClient.js
npm --prefix dashboard-next run build
systemctl restart gmweb-api.service
sleep 2

if [[ "$(systemctl is-active gmweb-api.service)" != "active" ]]; then
  echo "ERROR: gmweb-api.service did not become active." >&2
  journalctl -u gmweb-api.service -n 100 --no-pager
  exit 1
fi

cat <<EOF

Conversation Reply repair completed successfully.
Backup directory: $BACKUP_DIR

Hard-refresh /app with Ctrl+Shift+R, open a conversation, type a message,
then press Enter or click Send. Any backend/browser error will now be shown.

Rollback:
  cp -p '$BACKUP_DIR/src/googleMessagesClient.js' '$ROOT_DIR/src/googleMessagesClient.js'
  cp -p '$BACKUP_DIR/dashboard-next/src/pages/Conversations.tsx' '$ROOT_DIR/dashboard-next/src/pages/Conversations.tsx'
  npm --prefix '$ROOT_DIR/dashboard-next' run build
  systemctl restart gmweb-api.service
EOF
