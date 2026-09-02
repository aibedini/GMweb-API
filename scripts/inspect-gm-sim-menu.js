"use strict";

const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.connectOverCDP(process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222");
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /messages\.google\.com\/web/i.test(candidate.url()));
  if (!page) throw new Error("Google Messages page not found");
  const picker = page.locator("button[data-e2e-sim-info-picker-button], button[aria-label='Select a SIM']").first();
  await picker.click();
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll("[role='menuitem'], button, mat-option, [role='option']")]
      .filter(visible)
      .map((node, index) => ({
        index,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role") || "",
        aria: node.getAttribute("aria-label") || "",
        text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim(),
        outer: node.outerHTML.slice(0, 1500)
      }))
      .filter((row) => /sim|ir-|mci|mtn|rightel|phone|sms|\b1\b|\b2\b/i.test(JSON.stringify(row)));
  });
  await page.keyboard.press("Escape").catch(() => {});
  process.stdout.write(JSON.stringify(state, null, 2) + "\n");
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
