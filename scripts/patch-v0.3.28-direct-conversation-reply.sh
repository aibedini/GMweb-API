#!/usr/bin/env bash
set -Eeuo pipefail

# gmweb v0.3.28 hotfix: reply directly inside the selected conversation.
# No phone-number prompt and no package-version change.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT_DIR/.manual-patches/v0.3.28-direct-reply-$STAMP"

if [[ "$VERSION" != "0.3.28" ]]; then
  echo "ERROR: expected gmweb v0.3.28, detected v$VERSION" >&2
  exit 1
fi

cd "$ROOT_DIR"
mkdir -p "$BACKUP_DIR/src" "$BACKUP_DIR/dashboard-next/src/pages"
cp -p src/server.js "$BACKUP_DIR/src/server.js"
cp -p src/googleMessagesClient.js "$BACKUP_DIR/src/googleMessagesClient.js"
cp -p dashboard-next/src/pages/Conversations.tsx "$BACKUP_DIR/dashboard-next/src/pages/Conversations.tsx"

ROOT_DIR="$ROOT_DIR" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.ROOT_DIR;

function edit(relative, mutate) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, "utf8");
  const after = mutate(before);
  if (after === before) throw new Error(`No change made to ${relative}`);
  fs.writeFileSync(file, after, "utf8");
  console.log(`Patched ${relative}`);
}

function once(source, oldText, newText, label) {
  const at = source.indexOf(oldText);
  if (at < 0) throw new Error(`Expected v0.3.28 block not found: ${label}`);
  if (source.indexOf(oldText, at + oldText.length) >= 0) {
    throw new Error(`Expected only one block: ${label}`);
  }
  return source.slice(0, at) + newText + source.slice(at + oldText.length);
}

edit("src/googleMessagesClient.js", (source) => {
  if (source.includes("async replyToConversation(")) {
    throw new Error("Direct-reply client patch is already installed.");
  }
  const marker = "  async getConversationMessages(query, limit = 50) {";
  const method = `  async replyToConversation(query, text) {
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

        if (!this.isExpectedConversationUrl(page.url(), query.href)) {
          const error = new Error("Refusing to reply: the selected conversation was not opened.");
          error.statusCode = 409;
          throw error;
        }
        if (!await this.composerReady(8000)) {
          const error = new Error("The selected conversation composer is not ready.");
          error.statusCode = 503;
          throw error;
        }

        const sent = await this.typeAndSend(message);
        if (!sent) {
          const error = new Error("Reply was submitted but the outgoing message could not be verified.");
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
  return once(source, marker, method + marker, "client reply insertion point");
});

edit("src/server.js", (source) => {
  if (source.includes('app.post("/conversations/reply"')) {
    throw new Error("Direct-reply route patch is already installed.");
  }
  const marker = 'app.post("/conversations/messages", {';
  const route = `app.post("/conversations/reply", {
  schema: {
    summary: "Reply in the selected conversation",
    description: "Opens the exact conversation by href and sends through its existing composer.",
    tags: ["Conversations"],
    body: {
      type: "object",
      required: ["href", "text"],
      properties: {
        href: { type: "string", minLength: 1, maxLength: 500 },
        title: { type: "string", maxLength: 500 },
        text: { type: "string", minLength: 1, maxLength: 4000 }
      },
      additionalProperties: false
    },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          sent: { type: "boolean" },
          conversationUrl: { type: "string" },
          at: { type: "string" }
        }
      }
    }
  }
}, async (request) => {
  const result = await client.replyToConversation(
    { href: request.body.href, title: request.body.title || "" },
    request.body.text
  );
  return { ok: true, sent: true, conversationUrl: result.conversationUrl, at: result.at };
});

`;
  return once(source, marker, route + marker, "server reply route insertion point");
});

edit("dashboard-next/src/pages/Conversations.tsx", (source) => {
  if (source.includes('api("/conversations/reply"')) {
    throw new Error("Direct-reply UI patch is already installed.");
  }
  source = once(
    source,
    "  const number = open ? dialNumber(open.title) : null;",
    "  const canReply = Boolean(open?.href);",
    "UI reply availability"
  );
  source = once(
    source,
    "    if (!number || !draft.trim()) return;",
    "    if (!open?.href || !draft.trim()) return;",
    "UI send guard"
  );
  source = once(
    source,
    '      await api("/send", { method: "POST", body: { to: number, text: draft.trim() } });',
    '      await api("/conversations/reply", {\n        method: "POST",\n        body: { href: open.href, title: open.title, text: draft.trim() },\n      });',
    "UI reply request"
  );
  source = once(
    source,
    '{number ? "SMS" : "contact"}',
    'conversation',
    "UI header"
  );
  source = once(
    source,
    'placeholder={number ? "Text message" : "Can only reply to numeric conversations"}',
    'placeholder="Text message"',
    "UI placeholder"
  );
  source = once(source, "disabled={!number || sending}", "disabled={!canReply || sending}", "UI input state");
  source = once(
    source,
    'disabled={!number || !draft.trim() || sending}',
    'disabled={!canReply || !draft.trim() || sending}',
    "UI button state"
  );
  return source;
});
NODE

node --check src/googleMessagesClient.js
node --check src/server.js

if [[ ! -x dashboard-next/node_modules/.bin/tsc || ! -x dashboard-next/node_modules/.bin/vite ]]; then
  if [[ -f dashboard-next/package-lock.json ]]; then
    echo "Installing the locked frontend build dependencies..."
    npm --prefix dashboard-next ci --include=dev
  else
    echo "ERROR: dashboard-next build dependencies and package-lock.json are missing." >&2
    echo "Restore with the rollback commands shown below." >&2
    exit 1
  fi
fi

npm --prefix dashboard-next run build

cat <<EOF

Direct conversation Reply patch completed.
Backup directory: $BACKUP_DIR

Restart the existing gmweb service, then hard-refresh /app with Ctrl+Shift+R.
No phone-number field is shown; Send replies through the selected conversation href.

Rollback:
  cp -p '$BACKUP_DIR/src/server.js' '$ROOT_DIR/src/server.js'
  cp -p '$BACKUP_DIR/src/googleMessagesClient.js' '$ROOT_DIR/src/googleMessagesClient.js'
  cp -p '$BACKUP_DIR/dashboard-next/src/pages/Conversations.tsx' '$ROOT_DIR/dashboard-next/src/pages/Conversations.tsx'
  npm --prefix '$ROOT_DIR/dashboard-next' run build
EOF
