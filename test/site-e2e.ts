/// <reference lib="dom" />
// Plays the website's scenes in Chromium, in light and dark: a line gets built, settled
// lines fold into a box, a choice is offered, picked and built, and the agent writes in
// three pseudocode styles; at phone width nothing scrolls sideways.
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
    assert.ok(brandFonts.length > 1 && brandFonts.every((f) => f.startsWith("\"Ogidoc Wordmark\"")), `${colorScheme}: "ogidoc" is set in the same mono everywhere on the page, got ${brandFonts}`);
    assert.ok(await page.evaluate(() => document.fonts.load('700 17px "Ogidoc Wordmark"', "ogidoc").then((f) => f.length > 0)), `${colorScheme}: the wordmark's font ships with the site, not from the visitor's computer`);
    assert.equal(await page.title(), "Ogidoc", `${colorScheme}: the page is called Ogidoc`);
    assert.doesNotMatch((await page.textContent("body")) ?? "", /underpaint|paint/i, `${colorScheme}: nothing on the page still uses the old name or the painting idea`);

    const height = (n: number) => page.$eval(scene(n), (s) => s.getBoundingClientRect().height);
    await count(`${scene(1)} .ln`, 4);
    assert.deepEqual(await marks(1), ["built", "built", "built", "stale"], `${colorScheme}: the typed line needs a build`);
    assert.equal(await page.$(`${scene(1)} .under-slot > .under`), null, `${colorScheme}: no code before the turn`);
    const before = await height(1);
    await count(`${scene(1)} .m-built`, 4);
    await page.waitForSelector(`${scene(1)} .under-slot > .under`, { timeout: 20000 });
    assert.match((await page.textContent(`${scene(1)} .under-slot > .under`)) ?? "", /src\/game\.ts/, `${colorScheme}: code lands underneath`);
    assert.ok(Math.abs((await height(1)) - before) <= 1, `${colorScheme}: the scene keeps its size when Underneath appears, ${before} -> ${await height(1)}`);
    await page.waitForFunction((s) => !document.querySelector(s), `${scene(1)} .under-slot > .under`, { timeout: 20000 });
    assert.ok(Math.abs((await height(1)) - before) <= 1, `${colorScheme}: the scene keeps its size when the loop starts over`);
    console.log(`· ${colorScheme}: a line types itself, gets built, code lands underneath, and the scene never resizes`);

    await page.locator(scene(2)).scrollIntoViewIfNeeded();
    await count(`${scene(2)} .box[data-name="winner"]`, 1);
    await count(`${scene(2)} .row:not(.a-move) .ln`, 6);
    assert.match((await page.textContent(`${scene(2)} .box`)) ?? "", /three on a diagonal -> that mark/, `${colorScheme}: the settled lines are in the box`);
    console.log(`· ${colorScheme}: three settled lines fold into a box`);

    await page.locator(scene(3)).scrollIntoViewIfNeeded();
    await count(`${scene(3)} .ways`, 1);
    const beside = () => page.$eval(scene(3), (s) => {
      const w = s.querySelector(".ways")!.getBoundingClientRect();
      const r = s.querySelectorAll(".rows .row")[5].getBoundingClientRect();
      return { top: Math.round(w.top - r.top), right: Math.round(w.right) };
    });
    const at = await beside();
    assert.equal(at.top, 0, `${colorScheme}: the other way shows beside the line it would replace`);
    await page.waitForFunction((s) => document.querySelector(s)?.textContent === "2 of 2", `${scene(3)} .ways span`, { timeout: 20000 });
    assert.deepEqual(await beside(), at, `${colorScheme}: the switch stays put when the person picks the other way`);
    if (colorScheme === "light") await page.locator(scene(3)).screenshot({ path: "/tmp/site-scene3.png" });
    await page.waitForFunction((s) => document.querySelector(s)?.textContent?.includes("loser goes first"), `${scene(3)} .rows`, { timeout: 20000 });
    await count(`${scene(3)} .ways`, 0);
    console.log(`· ${colorScheme}: the agent offers another way, the person picks it, the agent builds it`);

    for (const [k, guard] of ["if board[row][col]: return", "if (taken(cell)) return;", "(ignore-when (taken? cell))"].entries()) {
      const style = `section:nth-of-type(4) .scene:nth-child(${k + 1})`;
      await page.locator(style).scrollIntoViewIfNeeded();
      await page.waitForFunction(([s, g]) => document.querySelector(s as string)?.textContent?.includes(g as string), [`${style} .rows`, guard] as const, { timeout: 20000 });
      assert.equal(await page.$$eval(`${style} .mk .m`, (els) => els.every((e) => e.classList.contains("m-built"))), true, `${colorScheme}: the agent's line in style ${k + 1} is built`);
    }
    console.log(`· ${colorScheme}: the agent writes in python-like, js-like and clojure-like pseudocode`);
    assert.deepEqual(errors, []);
    await page.close();

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme });
    await phone.goto(url);
    await phone.locator(scene(3)).scrollIntoViewIfNeeded();
    await phone.waitForSelector(`${scene(3)} .ways`, { timeout: 20000 });
    const fit = await phone.evaluate((s) => {
      const box = document.querySelector(s)!.getBoundingClientRect();
      const rail = [...document.querySelectorAll(`${s} .ways button`)].map((b) => b.getBoundingClientRect());
      return { sideways: document.documentElement.scrollWidth - innerWidth, gutter: box.left, railInside: rail.every((r) => r.right <= box.right && r.bottom <= box.bottom) };
    }, scene(3));
    assert.equal(fit.sideways, 0, `${colorScheme}: no sideways scroll at phone width`);
    assert.ok(fit.gutter >= 16, `${colorScheme}: at least a 16px side gutter at phone width, got ${fit.gutter}`);
    assert.ok(fit.railInside, `${colorScheme}: the choice switch fits inside the scene at phone width`);
    console.log(`· ${colorScheme}: at phone width the page fits and the choice switch stays inside the scene`);
    await phone.close();
  }
  console.log("\nAll site checks passed.");
} finally {
  await browser.close();
  server.kill();
}
