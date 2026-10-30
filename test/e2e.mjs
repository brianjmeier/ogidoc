// Drives the real editor in Chromium against the scripted mock agent:
// write a plan, pass the pen, answer with autocomplete, accept a proposal, watch
// pieces move into boxes, disagree inside a box, reach done, undo.
//
//   node test/e2e.mjs            (screenshots go to $UNDERPAINT_SHOTS or the temp dir)

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const SHOTS = process.env.UNDERPAINT_SHOTS || mkdtempSync(join(tmpdir(), "underpaint-shots-"));
mkdirSync(SHOTS, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "underpaint-e2e-"));
const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
g("init", "-q");
g("config", "user.email", "t@example.com");
g("config", "user.name", "Test");
writeFileSync(join(dir, "README.md"), "journal\n");
g("add", ".");
g("commit", "-qm", "init");

const server = spawn("node", [join(ROOT, "bin/underpaint.js"), "weekly.plan", "--agent", "mock", "--script", join(ROOT, "test/fixtures/weekly.json"), "--port", "0"], { cwd: dir });
const url = await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/[\d.:]+/); if (m) resolve(m[0]); });
  server.stderr.on("data", (d) => process.stderr.write(d));
  server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const pen = () => page.textContent("#pen-label");
const waitPen = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("pen-label").textContent), re.source, { timeout: 15000 });
const hlText = () => page.$$eval("#hl .ln", (els) => els.map((e) => e.textContent));
const passPen = () => page.keyboard.press("Control+Enter");
const step = (s) => console.log(`· ${s}`);

try {
  await page.goto(url);
  await page.waitForSelector("#ta");
  await shot("01-empty");

  step("the person writes the idea");
  await page.fill("#ta", "weekly reflection\n  every sunday\n    look at my week\n    tell me what i felt most");
  await page.waitForTimeout(600);
  assert.equal(await page.$$eval("#gutter .m", (m) => m.length), 0, "nothing is built yet");
  await shot("02-idea");

  step("passing the pen gives it to the agent");
  await page.focus("#ta");
  await passPen();
  await waitPen(/agent's pen · working/);
  assert.equal(await page.$eval("#ta", (t) => t.readOnly), true, "the text is read-only on the agent's turn");
  await page.waitForSelector("#activity:not([hidden])");
  await page.waitForTimeout(500);
  await shot("03-agent-working");

  step("the agent's edits animate in");
  await page.waitForSelector("#hl .a-add", { timeout: 15000 });
  await page.waitForTimeout(250);
  await shot("04-agent-animating");
  await waitPen(/your pen/);
  await page.waitForFunction(() => !document.querySelector("#hl .a-add"), null, { timeout: 5000 });
  const t1 = await hlText();
  assert.ok(t1.some((t) => t.includes("sunday in whose timezone") && t.includes("agent asks")), "the question shows with its label");
  assert.ok(t1.some((t) => t.includes("7-day strip") && t.includes("proposal")));
  assert.ok(t1.some((t) => t.includes("becomes a test")));
  assert.ok(await page.$("#hl .sym"), "a real codebase name is highlighted");
  assert.ok((await page.$$("#gutter .m-built")).length >= 3, "built lines are marked");
  assert.ok((await page.$$("#gutter .m-blocked")).length >= 2, "blocked lines are marked");
  assert.match(await pen(), /1 open question/);
  await page.click("#under summary");
  assert.match(await page.textContent("#under-body"), /src\/summarize\.js/);
  await shot("05-agent-done-turn-1");
  await page.click("#under summary");

  step("the person answers by editing, with autocomplete");
  await page.$eval("#ta", (ta) => {
    ta.value = ta.value.split("\n").filter((l) => !l.includes("whose timezone")).join("\n");
    ta.dispatchEvent(new Event("input"));
    const end = ta.value.indexOf("\n", ta.value.indexOf("every sunday"));
    ta.focus();
    ta.setSelectionRange(end, end);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("  brow");
  await page.waitForSelector("#hl .ghost");
  assert.equal(await page.textContent("#hl .ghost"), "ser timezone is fine, it's only a card");
  await shot("06-ghost");
  await page.keyboard.press("Tab");
  assert.ok((await page.inputValue("#ta")).includes("    browser timezone is fine, it's only a card"));

  step("accepting the agent's proposal");
  await page.click('#gutter button[data-act="accept"]');
  assert.ok(!(await hlText()).some((t) => t.includes("proposal")));
  await page.waitForTimeout(600);

  step("the agent moves settled pieces into boxes");
  await page.focus("#ta");
  await passPen();
  await waitPen(/agent's pen/);
  await page.waitForSelector("#hl .a-move", { timeout: 15000 });
  await page.waitForTimeout(350);
  await shot("07-moving-into-boxes");
  await waitPen(/your pen/);
  await page.waitForFunction(() => !document.querySelector("#hl .a-move"), null, { timeout: 5000 });
  assert.equal(await page.$$eval("#canvas .box", (b) => b.length), 4);
  assert.equal((await hlText()).length, 3, "the plan got shorter");
  assert.equal(await page.$$eval("#canvas svg path[marker-end]", (p) => p.length), 3, "boxes are connected by what they use");
  await shot("08-boxes");

  step("the person disagrees inside a box and rejects a proposal");
  await page.click('#canvas .box[data-name="summarizeWeek"] .bb');
  const boxTa = await page.waitForSelector("#canvas textarea.box-edit");
  await boxTa.evaluate((ta) => { ta.value = ta.value.replace("keep 3", "keep 2"); });
  await page.click('#gutter button[data-act="reject"]');
  await page.waitForFunction(() => document.querySelector('#canvas .box[data-name="summarizeWeek"]')?.classList.contains("stale"), null, { timeout: 5000 });
  assert.equal((await hlText()).length, 2);
  await page.waitForTimeout(600);
  await shot("09-disagree-in-box");

  step("done means done");
  await page.click(".brand");
  await passPen();
  await waitPen(/done · every line built/);
  await page.waitForTimeout(1300);
  assert.equal(await page.$$eval("#canvas .box.built", (b) => b.length), 4);
  await shot("10-done");

  step("one commit per agent turn, code and plan together");
  const log = g("log", "--format=%s").trim().split("\n");
  assert.deepEqual(log.slice(0, 3), ["underpaint: turn 3 on weekly", "underpaint: turn 2 on weekly", "underpaint: turn 1 on weekly"]);
  const files = g("show", "--name-only", "--format=", "HEAD~1").trim().split("\n");
  assert.ok(files.includes("src/week.js") && files.includes("weekly.plan") && files.includes(".underpaint/weekly/boxes/weekWindow.plan"), files.join(", "));

  step("undo the last agent turn");
  await page.click("#undo");
  await page.click("#undo");
  await waitPen(/your pen/);
  assert.match(readFileSync(join(dir, "src/summarize.js"), "utf8"), /keep = 3/);
  assert.match(g("log", "-1", "--format=%s"), /undo turn 3/);

  step("narrow screens stack the panes");
  await page.setViewportSize({ width: 420, height: 860 });
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways page scroll");
  await shot("11-phone");

  assert.deepEqual(errors, [], "no page errors");
  console.log(`\nAll e2e checks passed. Screenshots in ${SHOTS}`);
} catch (e) {
  await shot("failure").catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
