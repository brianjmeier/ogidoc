import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgent } from "../src/agents.ts";
import { Session } from "../src/session.ts";
import type { AnimationOp } from "../src/types.ts";

const SCRIPT = new URL("./fixtures/weekly.json", import.meta.url).pathname;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "underpaint-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hi\n");
  g("add", ".");
  g("commit", "-qm", "init");
  return { dir, log: () => execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim().split("\n") };
}

function session(dir: string) {
  return new Session({ cwd: dir, planFile: "weekly.plan", agent: makeAgent("mock", { script: SCRIPT }) });
}

const PLAN = "weekly reflection\n  every sunday\n    look at my week\n    tell me what i felt most";

test("a full session: ask, build, move into boxes, disagree in a box, done, undo", async () => {
  const { dir, log } = repo();
  const s = session(dir);
  const events: { animation?: AnimationOp[] }[] = [];
  s.on("change", (e) => events.push(e));

  await s.pass({ text: PLAN });
  assert.equal(s.turn, 2);
  const [q] = s.threads;
  assert.equal(q.by, "a");
  assert.equal(s.lines[q.line].text, "  every sunday", "the question is pinned to the line it is about");
  assert.ok(!s.lines.some((l) => l.text.includes("whose timezone")), "the question is not in the plan");
  assert.equal(s.lines[0].by, "h");
  assert.ok(existsSync(join(dir, "src/summarize.js")), "the agent's code is on disk");
  assert.match(readFileSync(join(dir, ".underpaint/weekly/comments.json"), "utf8"), /sunday in whose timezone/);
  assert.equal(log()[0], "underpaint: turn 1 on weekly");
  assert.equal(s.isDone(), false);
  const anim = events.find((e) => e.animation)!.animation!;
  assert.ok(anim.some((o) => o.op === "add"));

  // The person replies in the thread, accepts the proposal, and passes.
  s.reply({ thread: q.id, text: "browser timezone is fine, it's only a card" });
  const text = s.lines.map((l) => l.text);
  const proposal = text.findIndex((t) => t.includes("7-day strip"));
  await s.pass({ text: text.join("\n"), accepted: [proposal] });
  assert.equal(s.threads[0].resolved, true, "the agent resolved the thread once it built the answer");
  assert.equal(s.threads[0].messages.at(-1)!.by, "a");
  assert.equal(s.boxes.length, 4);
  const moved = events.at(-1)!.animation!.filter((o) => o.op === "move");
  assert.ok(moved.length >= 6, `expected moved lines, got ${moved.length}`);
  assert.ok(moved.some((m) => m.to === "weekWindow"));
  assert.ok(existsSync(join(dir, ".underpaint/weekly/boxes/summarizeWeek.plan")));
  assert.equal(s.lines.length, 3);

  // Disagree inside a box, reject the dismiss proposal.
  s.edit({ boxes: { summarizeWeek: readFileSync(join(dir, ".underpaint/weekly/boxes/summarizeWeek.plan"), "utf8").replace("keep 3", "keep 2").trimEnd() } });
  assert.equal(s.boxes.find((b) => b.name === "summarizeWeek")!.status, "stale");
  const diff = s.humanDiff();
  assert.equal(diff.boxes[0].name, "summarizeWeek");
  await s.pass({ text: s.lines.filter((l) => l.kind !== "proposal").map((l) => l.text).join("\n") });
  assert.equal(s.isDone(), true);
  assert.equal(log().length, 4);

  s.undo();
  s.undo();
  assert.equal(s.threads[0].resolved, false, "undo brings back the open thread");
  assert.equal(s.threads[0].messages.length, 2, "and the person's reply, which came before that turn");
  assert.equal(s.turn, 2);
  assert.equal(s.isDone(), false);
  assert.match(log()[0], /undo turn 2/);
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

test("a repository that ignores .underpaint still gets one commit per turn", async () => {
  const { dir, log } = repo();
  writeFileSync(join(dir, ".gitignore"), ".underpaint/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "ignore underpaint"], { cwd: dir });
  const s = session(dir);
  await s.pass({ text: PLAN });
  assert.equal(s.last!.error, undefined);
  assert.equal(log()[0], "underpaint: turn 1 on weekly");
  s.undo();
  assert.match(log()[0], /undo turn 1/);
});

test("a thread stays on its line while the person edits around it, and keeps the plan from being done", async () => {
  const { dir } = repo();
  const s = session(dir);
  await s.pass({ text: PLAN });
  const [q] = s.threads;
  s.edit({ text: ["a new first line", ...s.lines.map((l) => l.text)].join("\n") });
  assert.equal(s.lines[q.line].text, "  every sunday");
  s.edit({ text: s.lines.filter((l) => l.text !== "  every sunday").map((l) => l.text).join("\n") });
  assert.equal(s.lines[q.line].text, "weekly reflection", "a deleted line hands its thread to the line above");
  assert.equal(s.isDone(), false);
  const mine = s.comment({ line: 0, text: "can this be weekly by email too?" });
  assert.equal(mine.by, "h");
  s.resolve({ thread: mine.id });
  assert.equal(s.threads.find((t) => t.id === mine.id)!.resolved, true);
  assert.ok(JSON.parse(readFileSync(join(dir, ".underpaint/weekly/comments.json"), "utf8")).length === 2, "threads are saved beside the plan");
});

test("questions kept as plan lines by older sessions become threads", () => {
  const { dir } = repo();
  mkdirSync(join(dir, ".underpaint/old"), { recursive: true });
  writeFileSync(join(dir, "old.plan"), "weekly reflection\n  every sunday\n    sunday in whose timezone?\n");
  writeFileSync(join(dir, ".underpaint/old/state.json"), JSON.stringify({
    turn: 2,
    lines: [
      { text: "weekly reflection", by: "h", kind: null },
      { text: "  every sunday", by: "h", kind: null },
      { text: "    sunday in whose timezone?", by: "a", kind: "question" },
    ],
  }));
  const s = new Session({ cwd: dir, planFile: "old.plan", agent: makeAgent("mock", { script: SCRIPT }) });
  assert.deepEqual(s.lines.map((l) => l.text), ["weekly reflection", "  every sunday"]);
  assert.equal(s.threads[0].line, 1);
  assert.equal(s.threads[0].messages[0].text, "sunday in whose timezone?");
});

test("a failed turn that changed code can be undone", async () => {
  const { dir, log } = repo();
  const agent = {
    name: "sloppy",
    choices: { models: [], efforts: [] },
    run: async ({ cwd }: { cwd: string }) => {
      writeFileSync(join(cwd, "half.js"), "// half done\n");
      return "I forgot the JSON";
    },
  };
  const s = new Session({ cwd: dir, planFile: "p.plan", agent });
  await s.pass({ text: "hello" });
  assert.match(s.last!.error!, /no JSON block/);
  assert.equal(log()[0], "underpaint: failed turn 1 on p");
  assert.equal(s.snapshot().canUndo, true);
  s.undo();
  assert.equal(existsSync(join(dir, "half.js")), false, "the agent's half-done code is gone");
  assert.deepEqual(s.lines.map((l) => l.text), ["hello"], "the plan is as the person left it");
});

test("a failed agent turn gives the pen back with an error", async () => {
  const { dir } = repo();
  const s = new Session({ cwd: dir, planFile: "p.plan", agent: { name: "broken", choices: { models: [], efforts: [] }, run: async () => "I forgot the JSON" } });
  await s.pass({ text: "hello" });
  assert.equal(s.working, false);
  assert.match(s.last!.error!, /no JSON block/);
  assert.equal(s.turn, 1);
  assert.equal(s.snapshot().canUndo, false, "nothing changed, so there is nothing to undo");
});

test("the plan file stays plain text and edits made elsewhere are picked up", async () => {
  const { dir } = repo();
  const s = session(dir);
  await s.pass({ text: PLAN });
  writeFileSync(join(dir, "weekly.plan"), readFileSync(join(dir, "weekly.plan"), "utf8") + "  added in vim\n");
  const again = session(dir);
  const last = again.lines.at(-1)!;
  assert.equal(last.text, "  added in vim");
  assert.equal(last.by, "h");
  assert.equal(last.status, "stale");
  assert.equal(again.lines[5].status, "built");
});
