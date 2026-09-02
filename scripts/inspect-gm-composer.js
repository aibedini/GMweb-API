"use strict";

const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.connectOverCDP(process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222");
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /messages\.google\.com\/web/i.test(candidate.url()));
  if (!page) throw new Error("Google Messages page not found");

  const state = await page.evaluate(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const composers = [...document.querySelectorAll("textarea, input, [contenteditable='true']")]
      .filter(visible)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        aria: node.getAttribute("aria-label") || "",
        placeholder: node.getAttribute("placeholder") || "",
        value: "value" in node ? node.value : node.textContent,
        outer: node.outerHTML.slice(0, 500)
      }));
    const buttons = [...document.querySelectorAll("button, [role='button']")]
      .filter(visible)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        aria: node.getAttribute("aria-label") || "",
        title: node.getAttribute("title") || "",
        text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
        outer: node.outerHTML.slice(0, 500)
      }))
      .filter((row) => /send|message|sms/i.test(`${row.aria} ${row.title} ${row.text} ${row.outer}`));
    const messages = [...document.querySelectorAll("mws-text-message-part")].slice(-8).map((node) => ({
      aria: node.getAttribute("aria-label") || "",
      text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      outer: node.outerHTML.slice(0, 300)
    }));
    const composer = document.querySelector("textarea[data-e2e-message-input-box], textarea[aria-label*='Type a text message' i]");
    const composerTree = [];
    let parent = composer;
    for (let depth = 0; parent && depth < 7; depth += 1, parent = parent.parentElement) {
      composerTree.push({
        depth,
        tag: parent.tagName.toLowerCase(),
        className: String(parent.className || ""),
        text: (parent.innerText || parent.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
        outer: parent.outerHTML.slice(0, 3000)
      });
    }
    const simCandidates = [...document.querySelectorAll("button, [role='button'], select, [role='combobox'], [aria-haspopup]")]
      .filter(visible)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        aria: node.getAttribute("aria-label") || "",
        title: node.getAttribute("title") || "",
        role: node.getAttribute("role") || "",
        popup: node.getAttribute("aria-haspopup") || "",
        text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
        outer: node.outerHTML.slice(0, 1000)
      }))
      .filter((row) => /sim|sms|phone|send with|subscription|carrier|nima best/i.test(JSON.stringify(row)));
    return { url: location.href, composers, buttons, composerTree, simCandidates, messages };
  });
  process.stdout.write(JSON.stringify(state, null, 2) + "\n");
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
