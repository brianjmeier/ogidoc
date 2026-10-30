/// <reference lib="dom" />
// Plays the website's three scenes in Chromium, in light and dark: a line gets built,
// settled lines fold into a box, and a choice is offered, picked and built.
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
    const scene = (n: number) => `section:nth-of-type(${n}) .scene`;
    const marks = (n: number) => page.$$eval(`${scene(n)} .mk .m`, (els) => els.map((e) => e.className.replace("m m-", "")));
    const count = (sel: string, n: number) => page.waitForFunction(([s, k]) => document.querySelectorAll(s as string).length === k, [sel, n] as const, { timeout: 20000 });
    await page.goto(url);

    const brandFonts = await page.$$eval(".brand", (els) => els.map((e) => getComputedStyle(e).fontFamily));
    assert.ok(brandFonts.length > 1 && brandFonts.every((f) => f.startsWith("Caveat")), `${colorScheme}: "Underpaint" is handwritten everywhere on the page, got ${brandFonts}`);
    assert.ok(await page.evaluate(() => document.fonts.load('700 17px Caveat', "Underpaint").then((f) => f.length > 0)), `${colorScheme}: the handwriting ships with the site, not from the visitor's computer`);

    await count(`${scene(1)} .ln`, 3);
    assert.deepEqual(await marks(1), ["built", "built", "stale"], `${colorScheme}: the typed line needs a build`);
    assert.equal(await page.$(`${scene(1)} .under`), null, `${colorScheme}: no code before the turn`);
    await count(`${scene(1)} .m-built`, 3);
    assert.match((await page.textContent(`${scene(1)} .under`)) ?? "", /src\/reflect\.ts/, `${colorScheme}: code lands underneath`);
    console.log(`· ${colorScheme}: a line types itself, gets built, code lands underneath`);

    await page.locator(scene(2)).scrollIntoViewIfNeeded();
    await count(`${scene(2)} .box[data-name="topFeeling"]`, 1);
    await count(`${scene(2)} .row:not(.a-move) .ln`, 4);
    assert.match((await page.textContent(`${scene(2)} .box`)) ?? "", /ties go to the most recent day/, `${colorScheme}: the settled lines are in the box`);
    console.log(`· ${colorScheme}: three settled lines fold into a box`);

    await page.locator(scene(3)).scrollIntoViewIfNeeded();
    await count(`${scene(3)} .ways`, 1);
    const beside = () => page.$eval(scene(3), (s) => {
      const w = s.querySelector(".ways")!.getBoundingClientRect();
      const r = s.querySelectorAll(".rows .row")[4].getBoundingClientRect();
      return { top: Math.round(w.top - r.top), right: Math.round(w.right) };
    });
    const at = await beside();
    assert.equal(at.top, 0, `${colorScheme}: the other way shows beside the line it would replace`);
    await page.waitForFunction((s) => document.querySelector(s)?.textContent === "2 of 2", `${scene(3)} .ways span`, { timeout: 20000 });
    assert.deepEqual(await beside(), at, `${colorScheme}: the switch stays put when the person picks the other way`);
    if (colorScheme === "light") await page.locator(scene(3)).screenshot({ path: "/tmp/site-scene3.png" });
    await page.waitForFunction((s) => document.querySelector(s)?.textContent?.includes("one table in a local database"), `${scene(3)} .rows`, { timeout: 20000 });
    await count(`${scene(3)} .ways`, 0);
    console.log(`· ${colorScheme}: the agent offers another way, the person picks it, the agent builds it`);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("\nAll site checks passed.");
} finally {
  await browser.close();
  server.kill();
}
