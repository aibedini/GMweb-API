#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="$ROOT_DIR/src/googleMessagesClient.js"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT_DIR/.manual-patches/googleMessagesClient.reply-verification-$STAMP.js"

mkdir -p "$ROOT_DIR/.manual-patches"
cp -p "$FILE" "$BACKUP"

FILE="$FILE" node <<'NODE'
const fs = require("node:fs");
const file = process.env.FILE;
let source = fs.readFileSync(file, "utf8");

const oldBlock = `        const before = await page.locator("mws-text-message-part").count();

        await input.fill(message).catch(async () => {`;
const newBlock = `        await input.fill(message).catch(async () => {`;
if (!source.includes(oldBlock)) throw new Error("Expected pre-send verification block not found.");
source = source.replace(oldBlock, newBlock);

const oldWait = `          await page.waitForFunction(({ countBefore, expected }) => {
            const rows = [...document.querySelectorAll("mws-text-message-part")];
            if (rows.length <= countBefore) return false;
            return rows.slice(countBefore).some((node) => {
              const actual = (node.innerText || node.textContent || "")
                .replace(/\\s+/g, " ").trim();
              return actual === expected || actual.includes(expected);
            });
          }, { countBefore: before, expected: wanted }, { timeout: 12000 });`;
const newWait = `          await page.waitForFunction((expected) => {
            const composer = document.querySelector(
              "textarea[data-e2e-message-input-box], textarea[aria-label*='Type a text message' i], textarea[aria-label*='message' i]"
            );
            const composerValue = composer && "value" in composer ? composer.value.trim() : "";
            const outgoing = [...document.querySelectorAll("mws-text-message-part")]
              .filter((node) => /^You said:/i.test(node.getAttribute("aria-label") || ""));
            const last = outgoing[outgoing.length - 1];
            const actual = (last?.innerText || last?.textContent || "")
              .replace(/\\s+/g, " ").trim();
            return composerValue === "" && (actual === expected || actual.includes(expected));
          }, wanted, { timeout: 12000 });`;
if (!source.includes(oldWait)) throw new Error("Expected bubble-count verification block not found.");
source = source.replace(oldWait, newWait);

fs.writeFileSync(file, source, "utf8");
console.log(`Fixed reply verification in ${file}`);
NODE

node --check "$FILE"
systemctl restart gmweb-api.service
sleep 2
test "$(systemctl is-active gmweb-api.service)" = "active"

echo "Reply verification fixed. Backup: $BACKUP"
