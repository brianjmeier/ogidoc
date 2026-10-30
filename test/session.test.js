import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgent } from "../src/agents.js";
import { Session } from "../src/session.js";

const SCRIPT = new URL("./fixtures/weekly.json", import.meta.url).pathname;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "underpaint-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hi\n");
  g("add", ".");
  g("commit", "-qm", "init");
  return { dir, log: () => execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim().split("\n") };
}

function session(dir) {
  return new Session({ cwd: dir, planFile: "weekly.plan", agent: makeAgent("mock", { script: SCRIPT }) });
}

const PLAN = "weekly reflection\n  every sunday\n    look at my week\n    tell me what i felt most";

test("a full session: ask, build, move into boxes, disagree in a box, done, undo", async () => {
  const { dir, log } = repo();
  const s = session(dir);
  const events = [];
  s.on("change", (e) => events.push(e));

  await s.pass({ text: PLAN });
  assert.equal(s.turn, 2);
  assert.equal(s.lines.find((l) => l.kind === "question").by, "a");
  assert.equal(s.lines[0].by, "h");
  assert.ok(existsSync(join(dir, "src/summarize.js")), "the agent's code is on disk");
  assert.match(readFileSync(join(dir, "weekly.plan"), "utf8"), /sunday in whose timezone/);
  assert.equal(log()[0], "underpaint: turn 1 on weekly");
  assert.equal(s.isDone(), false);
  const anim = events.find((e) => e.animation).animation;
  assert.ok(anim.some((o) => o.op === "add"));

  // The person answers the question, accepts the proposal, and passes.
  const text = s.lines.map((l) => l.text).filter((t) => !t.includes("whose timezone"));
  text.splice(2, 0, "    browser timezone is fine, it's only a card");
  const proposal = text.findIndex((t) => t.includes("7-day strip"));
  await s.pass({ text: text.join("\n"), accepted: [proposal] });
  assert.equal(s.boxes.length, 4);
  const moved = events.at(-1).animation.filter((o) => o.op === "move");
  assert.ok(moved.length >= 6, `expected moved lines, got ${moved.length}`);
  assert.ok(moved.some((m) => m.to === "weekWindow"));
  assert.ok(existsSync(join(dir, ".underpaint/weekly/boxes/summarizeWeek.plan")));
  assert.equal(s.lines.length, 3);

  // Disagree inside a box, reject the dismiss proposal.
  s.edit({ boxes: { summarizeWeek: readFileSync(join(dir, ".underpaint/weekly/boxes/summarizeWeek.plan"), "utf8").replace("keep 3", "keep 2").trimEnd() } });
  assert.equal(s.boxes.find((b) => b.name === "summarizeWeek").status, "stale");
  const diff = s.humanDiff();
  assert.equal(diff.boxes[0].name, "summarizeWeek");
  await s.pass({ text: s.lines.filter((l) => l.kind !== "proposal").map((l) => l.text).join("\n") });
  assert.equal(s.isDone(), true);
  assert.equal(log().length, 4);

  s.undo();
  assert.equal(s.turn, 3);
  assert.equal(s.isDone(), false);
  assert.match(readFileSync(join(dir, "src/summarize.js"), "utf8"), /keep = 3/);
  assert.match(log()[0], /undo turn 3/);
});

test("drift: code changed outside a turn reaches the next prompt", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "wip.txt"), "already dirty before the session\n");
  const s = session(dir);
  await s.pass({ text: PLAN });
  assert.deepEqual(s.drift(), []);
  writeFileSync(join(dir, "src/summarize.js"), "// someone edited this by hand\n");
  assert.deepEqual(s.drift(), ["src/summarize.js"]);
});

test("a failed agent turn gives the pen back with an error", async () => {
  const { dir } = repo();
  const s = new Session({ cwd: dir, planFile: "p.plan", agent: { name: "broken", run: async () => "I forgot the JSON" } });
  await s.pass({ text: "hello" });
  assert.equal(s.working, false);
  assert.match(s.last.error, /no JSON block/);
  assert.equal(s.turn, 1);
});

test("the plan file stays plain text and edits made elsewhere are picked up", async () => {
  const { dir } = repo();
  const s = session(dir);
  await s.pass({ text: PLAN });
  writeFileSync(join(dir, "weekly.plan"), readFileSync(join(dir, "weekly.plan"), "utf8") + "  added in vim\n");
  const again = session(dir);
  const last = again.lines.at(-1);
  assert.equal(last.text, "  added in vim");
  assert.equal(last.by, "h");
  assert.equal(last.status, "stale");
  assert.equal(again.lines[5].status, "built");
});
