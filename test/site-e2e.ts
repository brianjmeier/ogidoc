/// <reference lib="dom" />
// Plays the website's scenes in Chromium, in light and dark: the typed line needs a
// build, the agent's turn marks it built, and the code lands underneath.
//
//   npm run build:site && node test/site-e2e.ts

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const server = spawn("npx", ["vite", "preview", "-c", "vite.site.config.ts", "--port", "4791"], { cwd: ROOT });
const url = await new Promise<string>((resolve, reject) => {
  server.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/localhost:\d+/); if (m) resolve(m[0]); });
  server.on("exit", (c) => reject(new Error(`vite preview exited ${c}`)));
});

const browser = await chromium.launch();
try {
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, colorScheme });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const marks = () => page.$$eval(".scene .mk .m", (els) => els.map((e) => e.className.replace("m m-", "")));
    await page.goto(url);

    await page.waitForFunction(() => document.querySelectorAll(".scene .ln").length === 3);
    assert.deepEqual(await marks(), ["built", "built", "stale"], `${colorScheme}: the typed line needs a build`);
    assert.equal(await page.$(".scene .under"), null, `${colorScheme}: no code before the turn`);

    await page.waitForFunction(() => document.querySelectorAll(".scene .m-built").length === 3, null, { timeout: 15000 });
    assert.match((await page.textContent(".scene .under")) ?? "", /src\/reflect\.ts/, `${colorScheme}: code lands underneath`);
    assert.deepEqual(errors, []);
    console.log(`· ${colorScheme}: a line types itself, gets built, code lands underneath`);
    await page.close();
  }
  console.log("\nAll site checks passed.");
} finally {
  await browser.close();
  server.kill();
}
