#!/usr/bin/env bash
set -Eeuo pipefail

# Local hotfix for gmweb v0.3.28:
# Allow named conversations to use the composer after the operator supplies
# the recipient phone number once. The mapping is remembered in localStorage.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="$ROOT_DIR/dashboard-next/src/pages/Conversations.tsx"
PACKAGE_FILE="$ROOT_DIR/package.json"
BACKUP_DIR="$ROOT_DIR/.manual-patches/v0.3.28-conversation-compose-$(date +%Y%m%d-%H%M%S)"

cd "$ROOT_DIR"

if [[ ! -f "$PACKAGE_FILE" || ! -f "$SOURCE_FILE" ]]; then
  echo "ERROR: Run this script from a complete gmweb checkout." >&2
  exit 1
fi

VERSION="$(node -p "require(process.argv[1]).version" "$PACKAGE_FILE")"
if [[ "$VERSION" != "0.3.28" ]]; then
  echo "ERROR: This patch is only for gmweb v0.3.28; detected v$VERSION." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
cp -p "$SOURCE_FILE" "$BACKUP_DIR/Conversations.tsx"

SOURCE_FILE="$SOURCE_FILE" node <<'NODE'
const fs = require("node:fs");

const file = process.env.SOURCE_FILE;
let source = fs.readFileSync(file, "utf8");

if (source.includes('gmweb:conversation-number:')) {
  console.log("Patch is already present; source was not changed.");
  process.exit(0);
}

function replaceOnce(oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first === -1) throw new Error(`Cannot find expected v0.3.28 block: ${label}`);
  if (source.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error(`Expected exactly one v0.3.28 block: ${label}`);
  }
  source = source.slice(0, first) + newText + source.slice(first + oldText.length);
}

replaceOnce(
  '  const [draft, setDraft] = useState("");\n  const [sending, setSending] = useState(false);',
  '  const [draft, setDraft] = useState("");\n  const [recipient, setRecipient] = useState("");\n  const [sending, setSending] = useState(false);',
  "recipient state"
);

replaceOnce(
`  function openConv(c: Conversation) {
    setOpen(c);
    setMessages([]);
    setDraft("");
    loadThread(c);
  }`,
`  function openConv(c: Conversation) {
    setOpen(c);
    setMessages([]);
    setDraft("");

    const detected = dialNumber(c.title);
    const saved = localStorage.getItem(\`gmweb:conversation-number:\${c.href}\`);
    setRecipient(detected || saved || "");

    loadThread(c);
  }`,
  "openConv"
);

replaceOnce(
  '  const number = open ? dialNumber(open.title) : null;',
  '  const titleNumber = open ? dialNumber(open.title) : null;\n  const number = titleNumber || dialNumber(recipient);',
  "number calculation"
);

replaceOnce(
`            <form onSubmit={send} className="flex items-center gap-2 border-t border-border p-3">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={number ? "Text message" : "Can only reply to numeric conversations"}`,
`            <form onSubmit={send} className="flex flex-wrap items-center gap-2 border-t border-border p-3">
              {!titleNumber && (
                <input
                  type="tel"
                  inputMode="tel"
                  value={recipient}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRecipient(value);
                    const parsed = dialNumber(value);
                    if (parsed && open) {
                      localStorage.setItem(\`gmweb:conversation-number:\${open.href}\`, parsed);
                    }
                  }}
                  placeholder="Recipient number, e.g. +989121234567"
                  dir="ltr"
                  className="h-10 w-full rounded-full border border-input bg-background/60 px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-64"
                />
              )}
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={number ? "Text message" : "Enter recipient number first"}`,
  "composer"
);

fs.writeFileSync(file, source, "utf8");
console.log(`Patched ${file}`);
NODE

echo "Building the React console..."
npm --prefix dashboard-next run build

cat <<EOF

Patch completed successfully.
Backup: $BACKUP_DIR/Conversations.tsx

Now open /app and hard-refresh the browser (Ctrl+Shift+R).
For a named conversation, enter its number once using English digits, preferably +989xxxxxxxxx.

Rollback source command:
  cp -p '$BACKUP_DIR/Conversations.tsx' '$SOURCE_FILE'
  npm --prefix dashboard-next run build
EOF
