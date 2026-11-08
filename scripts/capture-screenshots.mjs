#!/usr/bin/env bun
/**
 * Capture docs/screenshots from the mock desktop UI.
 *
 *   cd apps/desktop && bun run dev:mock
 *   # Playwright is not a repo dependency — point at a local install:
 *   mkdir -p /tmp/rivet-screenshots && cd /tmp/rivet-screenshots && bun add playwright@1.65.0
 *   bunx playwright install chromium
 *   PLAYWRIGHT_PKG=/tmp/rivet-screenshots/node_modules/playwright/index.mjs \
 *     bun scripts/capture-screenshots.mjs
 *
 * Override base URL with RIVET_SCREENSHOT_URL (default http://localhost:1420).
 */
import { access } from "node:fs/promises";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const playwrightEntry =
  process.env.PLAYWRIGHT_PKG ??
  path.resolve("/tmp/rivet-screenshots/node_modules/playwright/index.mjs");

try {
  await access(playwrightEntry);
} catch {
  console.error(
    `Playwright not found at ${playwrightEntry}. Set PLAYWRIGHT_PKG to playwright/index.mjs.`,
  );
  process.exit(1);
}

const { chromium } = await import(pathToFileURL(playwrightEntry).href);

const BASE = process.env.RIVET_SCREENSHOT_URL ?? "http://localhost:1420";
const OUT = path.resolve(import.meta.dirname, "../docs/screenshots");
const SIZE = { width: 1280, height: 840 };

const shots = [
  { file: "01-quota.png", url: "/#/?filter=all&metric=limits", title: "Quota Management" },
  { file: "02-data.png", url: "/#/data", title: "Data" },
  {
    file: "03-data-detail.png",
    url: "/#/data",
    title: "Data",
    after: async (page) => {
      const row = page.locator("button:has(strong)").first();
      await row.waitFor({ state: "visible", timeout: 15000 });
      await row.click();
      await page.waitForTimeout(800);
    },
  },
  { file: "04-runtime.png", url: "/#/runtime", title: "Runtime" },
  { file: "05-accounts.png", url: "/#/settings/accounts", title: "Accounts" },
  { file: "06-harness.png", url: "/#/settings/harness", title: "Harness" },
  { file: "07-wiki.png", url: "/#/wiki", title: "Wiki" },
  { file: "08-topics.png", url: "/#/topics", title: "Topics" },
  { file: "09-quota-tokens.png", url: "/#/?filter=all&metric=tokens", title: "Quota Management" },
];

const obsolete = [
  "02-traffic.png",
  "03-traffic-detail.png",
  "08-export.png",
  "09-quota-burn.png",
];

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: SIZE,
  deviceScaleFactor: 1,
  colorScheme: "dark",
});

await page.addInitScript(() => {
  try {
    localStorage.setItem("rivet.mockScenario", "default");
  } catch {
    /* ignore */
  }
});

await page.goto(`${BASE}/#/`, { waitUntil: "networkidle", timeout: 60000 });
await page.addStyleTag({
  content: `
    [aria-label="Mock IPC controls"] { display: none !important; }
    [data-sonner-toaster] { display: none !important; }
  `,
});

for (const shot of shots) {
  const dest = path.join(OUT, shot.file);
  await page.goto(`${BASE}${shot.url}`, { waitUntil: "networkidle", timeout: 60000 });
  await page.locator("h1", { hasText: shot.title }).waitFor({ state: "visible", timeout: 20000 });
  // Charts / virtual lists settle
  await page.waitForTimeout(1200);
  if (shot.after) await shot.after(page);
  await page.screenshot({ path: dest, type: "png" });
  console.log(`wrote ${shot.file}`);
}

for (const name of obsolete) {
  try {
    await rm(path.join(OUT, name));
    console.log(`removed ${name}`);
  } catch {
    /* missing */
  }
}

await browser.close();
console.log("done");
