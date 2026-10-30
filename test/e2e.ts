/// <reference lib="dom" />
// Drives the real editor in Chromium against the scripted mock agent:
// write a plan, pass the pen, cycle through the ways the agent offered and use one, autocomplete,
// accept a proposal, ask about a line and pass from the comment, watch pieces move into
// boxes, comment on a line, disagree inside a box, reach done, undo.
//
//   npm run build && node test/e2e.ts      (screenshots go to $UNDERPAINT_SHOTS or the temp dir)

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const SHOTS = process.env.UNDERPAINT_SHOTS || mkdtempSync(join(tmpdir(), "underpaint-shots-"));
mkdirSync(SHOTS, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "underpaint-e2e-"));
const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
g("init", "-q");
g("config", "user.email", "t@example.com");
g("config", "user.name", "Test");
writeFileSync(join(dir, "README.md"), "journal\n");
g("add", ".");
g("commit", "-qm", "init");

const server = spawn("node", [join(ROOT, "bin/underpaint.ts"), "weekly.plan", "--agent", "mock", "--script", join(ROOT, "test/fixtures/weekly.json"), "--port", "0"], { cwd: dir });
const url = await new Promise<string>((resolve, reject) => {
  server.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/[\d.:]+/); if (m) resolve(m[0]); });
  server.stderr.on("data", (d) => process.stderr.write(d));
  server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
});

const TA = 'textarea[aria-label="Plan text"]';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const pen = async () => (await page.textContent(".pen")) ?? "";
const waitPen = (re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".pen")?.textContent ?? ""), re.source, { timeout: 15000 });
// Each line as it reads, without the comment pins drawn at its end.
const planText = () =>
  page.$$eval(".rows .ln", (els) => els.map((e) => {
    const c = e.cloneNode(true) as HTMLElement;
    c.querySelectorAll(".pin-btn").forEach((p) => p.remove());
    return c.textContent ?? "";
  }));
const passPen = () => page.keyboard.press("Control+Enter");
const step = (s: string) => console.log(`· ${s}`);

try {
  await page.goto(url);
  await page.waitForSelector(TA);
  await shot("01-empty");

  step("the person writes the idea");
  await page.fill(TA, "weekly reflection\n  every sunday\n    look at my week\n    tell me what i felt most");
  await page.waitForTimeout(600);
  assert.equal(await page.$$eval(".rows .g .m", (m) => m.length), 0, "nothing is built yet");
  await shot("02-idea");

  step("passing the pen gives it to the agent");
  await page.focus(TA);
  await passPen();
  await waitPen(/agent's pen · working/);
  assert.equal(await page.$eval(TA, (t) => (t as HTMLTextAreaElement).readOnly), true, "the text is read-only on the agent's turn");
  await page.waitForSelector(".activity");
  await page.waitForTimeout(500);
  await shot("03-agent-working");

  step("the agent's edits animate in");
  await page.waitForSelector(".rows .a-add", { timeout: 15000 });
  await page.waitForTimeout(250);
  await shot("04-agent-animating");
  await waitPen(/your pen/);
  await page.waitForFunction(() => !document.querySelector(".rows .a-add"), null, { timeout: 5000 });
  const t1 = await planText();
  assert.ok(t1.some((t) => t.includes("7-day strip") && t.includes("AcceptReject")), "a proposal offers Accept and Reject on its line");
  assert.ok(t1.some((t) => t.includes("becomes a test")));
  assert.ok(await page.$(".rows .sym"), "a real codebase name is highlighted");
  assert.ok((await page.$$(".rows .m-built")).length >= 3, "built lines are marked");
  assert.equal(await page.$$(".pin-btn").then((p) => p.length), 0, "the agent doesn't ask in comments");
  assert.equal((await page.$$(".rows .m-blocked")).length, 0, "nothing waits on the person");
  assert.match(await pen(), /your pen$/);
  await page.click(".under summary");
  assert.match((await page.textContent(".under-body")) ?? "", /src\/summarize\.js/);
  await page.click(".under summary");

  step("the agent built one way and shows the other in place");
  const row: number = await page.evaluate(() => fetch("/api/state").then((r) => r.json()).then((s) => s.choices[0].line));
  assert.equal((await planText())[row].trim(), "in the browser's timezone", "the agent's pick is in the plan");
  assert.equal(await page.textContent(".ways span"), "1 of 2");
  assert.ok(await page.$(`.rows .row:nth-child(${row + 1}) .m-built`));
  assert.deepEqual(new Set(await page.$$eval(".rows .row", (r) => r.map((x) => (x as HTMLElement).offsetHeight))), new Set([24]), "the control doesn't make its line taller");
  const beside = () => page.evaluate((n) => {
    const w = document.querySelector(".ways")!.getBoundingClientRect();
    const r = document.querySelectorAll(".rows .row")[n].getBoundingClientRect();
    return { top: w.top - r.top, left: Math.round(w.left) };
  }, row);
  const at = await beside();
  assert.equal(at.top, 0, "the switch sits beside the choice's first line");
  await shot("05-choice");

  step("Alt+] switches to the other way, which needs a build");
  await page.$eval(TA, (el) => {
    const ta = el as HTMLTextAreaElement;
    const at = ta.value.indexOf("in the browser's timezone");
    ta.focus();
    ta.setSelectionRange(at, at);
  });
  await page.keyboard.press("Alt+BracketRight");
  assert.equal((await planText())[row].trim(), "in a timezone you set once");
  assert.equal(await page.textContent(".ways span"), "2 of 2");
  assert.deepEqual(await beside(), at, "the switch doesn't move when the text changes");
  assert.ok(await page.$(`.rows .row:nth-child(${row + 1}) .m-stale`), "the switched-in way needs a build");
  await page.waitForTimeout(300);
  await shot("06-switched");
  await page.waitForFunction(() => fetch("/api/state").then((r) => r.json()).then((s) => s.choices[0]?.current === 1), null, { timeout: 5000 });

  step("switching back brings the built mark back");
  await page.click('.ways button[aria-label="Previous way"]');
  assert.equal((await planText())[row].trim(), "in the browser's timezone");
  assert.ok(await page.$(`.rows .row:nth-child(${row + 1}) .m-built`));
  await page.waitForFunction(() => fetch("/api/state").then((r) => r.json()).then((s) => s.choices[0]?.current === 0), null, { timeout: 5000 });

  step("typing in a way keeps it a choice, and Use this locks it in");
  await page.$eval(TA, (el) => {
    const ta = el as HTMLTextAreaElement;
    const end = ta.value.indexOf("in the browser's timezone") + "in the browser's timezone".length;
    ta.focus();
    ta.setSelectionRange(end, end);
  });
  await page.keyboard.type(", for now");
  assert.equal(await page.textContent(".ways span"), "1 of 2", "editing an option doesn't drop the choice");
  await page.click('.ways button:has-text("Use this")');
  assert.equal(await page.$$(".ways").then((w) => w.length), 0);
  assert.equal((await planText())[row].trim(), "in the browser's timezone, for now");
  await page.waitForFunction(() => fetch("/api/state").then((r) => r.json()).then((s) => !s.choices.length && s.lines.some((l: { text: string }) => l.text.endsWith(", for now"))), null, { timeout: 5000 });

  step("autocomplete offers the line the agent expects next");
  await page.click(".brand");
  await page.$eval(TA, (el) => {
    const ta = el as HTMLTextAreaElement;
    const end = ta.value.indexOf("\n", ta.value.indexOf("entries = journal_entries"));
    ta.focus();
    ta.setSelectionRange(end, end);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("pre");
  await page.waitForSelector(".rows .ghost");
  assert.equal(await page.textContent(".rows .ghost"), "v = the 7 days before");
  await shot("07-ghost");
  await page.keyboard.press("Tab");
  assert.ok((await page.inputValue(TA)).includes("      prev = the 7 days before"), await page.inputValue(TA));

  step("accepting the agent's proposal");
  await page.click('.decide button:has-text("Accept")');
  assert.ok(!(await planText()).some((t) => t.includes("Accept")));
  await page.waitForTimeout(600);

  step("the person asks about a line and passes the pen from the comment");
  await page.click(".rows .row:first-child .no");
  await page.fill(".card textarea", "does this fit on a phone?");
  await page.keyboard.press("Control+Enter");
  await waitPen(/agent's pen/);
  await page.waitForSelector(".rows .a-move", { timeout: 15000 });
  assert.ok(await page.$(".canvas .box.pop-in"), "boxes the agent added pop in");
  await page.waitForTimeout(350);
  await shot("08-moving-into-boxes");
  await waitPen(/your pen/);
  await page.waitForFunction(() => !document.querySelector(".rows .a-move"), null, { timeout: 5000 });
  assert.equal(await page.$$(".pin-btn").then((p) => p.length), 0, "the agent answered and resolved the thread");
  const thread = JSON.parse(readFileSync(join(dir, ".underpaint/weekly/comments.json"), "utf8"))[0];
  assert.deepEqual(thread.messages.map((m: { by: string }) => m.by), ["h", "a"], "the comment reached the agent and it answered");
  assert.equal(await page.$$eval(".canvas .box", (b) => b.length), 4);
  assert.equal((await planText()).length, 3, "the plan got shorter");
  assert.equal(await page.$$eval(".canvas svg path[marker-end]", (p) => p.length), 3, "boxes are connected by what they use");
  await shot("09-boxes");

  step("the person comments on a line, then resolves it");
  await page.click(".rows .row:first-child .no");
  await page.fill(".card textarea", "could this also go out by email?");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.pin-btn[aria-label="Comment from You"]');
  assert.match(await pen(), /your pen$/, "the person's own comment isn't waiting on them");
  await shot("10-own-comment");
  await page.click('.pin-btn[aria-label="Comment from You"]');
  await page.click('.card button:has-text("Resolve")');
  await page.waitForFunction(() => !document.querySelector(".pin-btn"), null, { timeout: 5000 });

  step("the person disagrees inside a box and rejects a proposal");
  await page.click('.canvas .box[data-name="summarizeWeek"] .bb');
  const boxTa = await page.waitForSelector(".canvas textarea.box-edit");
  await boxTa.evaluate((el) => { const ta = el as HTMLTextAreaElement; ta.value = ta.value.replace("keep 3", "keep 2"); });
  await page.click('.decide button:has-text("Reject")');
  await page.waitForFunction(() => document.querySelector('.canvas .box[data-name="summarizeWeek"]')?.classList.contains("stale"), null, { timeout: 5000 });
  assert.equal((await planText()).length, 2);
  await page.waitForTimeout(600);
  await shot("11-disagree-in-box");

  step("done means done");
  await page.click(".brand");
  await passPen();
  await waitPen(/done · every line built/);
  await page.waitForTimeout(1300);
  assert.equal(await page.$$eval(".canvas .box.built", (b) => b.length), 4);
  await shot("12-done");

  step("one commit per agent turn, code and plan together");
  const log = g("log", "--format=%s").trim().split("\n");
  assert.deepEqual(log.slice(0, 3), ["underpaint: turn 3 on weekly", "underpaint: turn 2 on weekly", "underpaint: turn 1 on weekly"]);
  const files = g("show", "--name-only", "--format=", "HEAD~1").trim().split("\n");
  assert.ok(files.includes("src/card.js") && files.includes("weekly.plan") && files.includes(".underpaint/weekly/boxes/weekWindow.plan"), files.join(", "));
  assert.ok(files.includes(".underpaint/weekly/comments.json"), "the thread is committed with the turn");

  step("undo the last agent turn");
  await page.click('button:has-text("Undo agent turn")');
  await page.click('button:has-text("Undo it? Click again")');
  await waitPen(/your pen/);
  assert.match(readFileSync(join(dir, "src/summarize.js"), "utf8"), /keep = 3/);
  assert.match(g("log", "-1", "--format=%s"), /undo turn 3/);

  step("narrow screens stack the panes");
  await page.setViewportSize({ width: 420, height: 860 });
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways page scroll");
  await shot("13-phone");

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
