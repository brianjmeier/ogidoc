import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnimationOp } from "../src/types.ts";
import { PLAN, emptyDir, open, repo, testClock, texts } from "./support/index.ts";

test("a full session: ask, build, move into boxes, disagree in a box, done, undo", async () => {
  const { dir, log } = repo();
  const { session: s, view, prompts } = open(dir);
  const events: { animation?: AnimationOp[] }[] = [];
  s.on("change", (e) => events.push(e));

  await s.pass({ text: PLAN });
  assert.equal(view().turn, 2);
  const [q] = view().threads;
  assert.equal(q.by, "a");
  assert.equal(view().lines[q.line].text, "  every sunday", "the question is pinned to the line it is about");
  assert.ok(!texts(view().lines).some((t) => t.includes("whose timezone")), "the question is not in the plan");
  assert.equal(view().lines[0].by, "h");
  assert.ok(existsSync(join(dir, "src/summarize.js")), "the agent's code is on disk");
  assert.match(readFileSync(join(dir, ".underpaint/weekly/comments.json"), "utf8"), /sunday in whose timezone/);
  assert.equal(log()[0], "underpaint: turn 1 on weekly");
  assert.equal(view().done, false);
  const anim = events.find((e) => e.animation)!.animation!;
  assert.ok(anim.some((o) => o.op === "add"));

  // The person replies in the thread, accepts the proposal, and passes.
  s.reply({ thread: q.id, text: "browser timezone is fine, it's only a card" });
  const text = texts(view().lines);
  const proposal = text.findIndex((t) => t.includes("7-day strip"));
  await s.pass({ text: text.join("\n"), accepted: [proposal] });
  assert.match(prompts[1], /person: browser timezone is fine/, "the agent reads the reply");
  assert.equal(view().threads[0].resolved, true, "the agent resolved the thread once it built the answer");
  assert.equal(view().threads[0].messages.at(-1)!.by, "a");
  assert.equal(view().boxes.length, 4);
  const moved = events.at(-1)!.animation!.filter((o) => o.op === "move");
  assert.ok(moved.length >= 6, `expected moved lines, got ${moved.length}`);
  assert.ok(moved.some((m) => m.to === "weekWindow"));
  assert.ok(existsSync(join(dir, ".underpaint/weekly/boxes/summarizeWeek.plan")));
  assert.equal(view().lines.length, 3);

  // Disagree inside a box, reject the dismiss proposal.
  s.edit({ boxes: { summarizeWeek: readFileSync(join(dir, ".underpaint/weekly/boxes/summarizeWeek.plan"), "utf8").replace("keep 3", "keep 2").trimEnd() } });
  assert.equal(view().boxes.find((b) => b.name === "summarizeWeek")!.status, "stale");
  await s.pass({ text: texts(view().lines.filter((l) => l.kind !== "proposal")).join("\n") });
  assert.match(prompts[2], /In box summarizeWeek:\n {2}- .*keep 3\n {2}\+ .*keep 2/, "the agent sees the person's change in the box");
  assert.equal(view().done, true);
  assert.equal(log().length, 4);

  s.undo();
  s.undo();
  assert.equal(view().threads[0].resolved, false, "undo brings back the open thread");
  assert.equal(view().threads[0].messages.length, 2, "and the person's reply, which came before that turn");
  assert.equal(view().turn, 2);
  assert.equal(view().done, false);
  assert.match(log()[0], /undo turn 2/);
});

test("drift: code changed outside a turn reaches the next prompt", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "wip.txt"), "already dirty before the session\n");
  const { session: s, view, prompts } = open(dir);
  await s.pass({ text: PLAN });
  assert.doesNotMatch(prompts[0], /# Code that changed outside a turn/, "work already in progress isn't drift");
  writeFileSync(join(dir, "src/summarize.js"), "// someone edited this by hand\n");
  await s.pass({ text: texts(view().lines).join("\n") });
  const drift = prompts[1].match(/# Code that changed outside a turn[\s\S]*?\n\n[^\n]*\n\n((?:- .*\n?)*)/)![1];
  assert.deepEqual(drift.trim().split("\n"), ["- src/summarize.js"], "only the hand edit, not earlier work or the editor's own files");
});

test("a repository that ignores .underpaint still gets one commit per turn", async () => {
  const { dir, git, log } = repo();
  writeFileSync(join(dir, ".gitignore"), ".underpaint/\n");
  git("add", ".gitignore");
  git("commit", "-qm", "ignore underpaint");
  const { session: s, view } = open(dir);
  await s.pass({ text: PLAN });
  assert.equal(view().last!.error, undefined);
  assert.equal(log()[0], "underpaint: turn 1 on weekly");
  s.undo();
  assert.match(log()[0], /undo turn 1/);
});

test("a thread stays on its line while the person edits around it, and keeps the plan from being done", async () => {
  const { dir } = repo();
  const { session: s, view } = open(dir);
  await s.pass({ text: PLAN });
  const [q] = view().threads;
  const lineOf = (id: string) => view().lines[view().threads.find((t) => t.id === id)!.line].text;
  s.edit({ text: ["a new first line", ...texts(view().lines)].join("\n") });
  assert.equal(lineOf(q.id), "  every sunday");
  s.edit({ text: texts(view().lines).filter((t) => t !== "  every sunday").join("\n") });
  assert.equal(lineOf(q.id), "weekly reflection", "a deleted line hands its thread to the line above");
  assert.equal(view().done, false);
  const mine = s.comment({ line: 0, text: "can this be weekly by email too?" });
  assert.equal(mine.by, "h");
  s.resolve({ thread: mine.id });
  assert.equal(view().threads.find((t) => t.id === mine.id)!.resolved, true);
  assert.ok(JSON.parse(readFileSync(join(dir, ".underpaint/weekly/comments.json"), "utf8")).length === 2, "threads are saved beside the plan");
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
  const { session: s, view } = open(dir, { planFile: "p.plan", agent });
  await s.pass({ text: "hello" });
  assert.match(view().last!.error!, /no JSON block/);
  assert.equal(log()[0], "underpaint: failed turn 1 on p");
  assert.equal(view().canUndo, true);
  s.undo();
  assert.equal(existsSync(join(dir, "half.js")), false, "the agent's half-done code is gone");
  assert.deepEqual(texts(view().lines), ["hello"], "the plan is as the person left it");
});

test("a failed agent turn gives the pen back with an error", async () => {
  const { dir } = repo();
  const { session: s, view } = open(dir, { planFile: "p.plan", agent: { name: "broken", choices: { models: [], efforts: [] }, run: async () => "I forgot the JSON" } });
  await s.pass({ text: "hello" });
  assert.equal(view().working, false);
  assert.match(view().last!.error!, /no JSON block/);
  assert.equal(view().turn, 1);
  assert.equal(view().canUndo, false, "nothing changed, so there is nothing to undo");
});

test("without a repository the session works and keeps undo", async () => {
  const dir = emptyDir();
  const { session: s, view } = open(dir);
  await s.pass({ text: PLAN });
  assert.equal(view().turn, 2);
  assert.equal(view().canUndo, true);
  s.undo();
  assert.deepEqual(texts(view().lines), PLAN.split("\n"));
});

test("the plan file stays plain text and edits made elsewhere are picked up", async () => {
  const { dir } = repo();
  const { session: s } = open(dir);
  await s.pass({ text: PLAN });
  writeFileSync(join(dir, "weekly.plan"), readFileSync(join(dir, "weekly.plan"), "utf8") + "  added in vim\n");
  const { view } = open(dir);
  const last = view().lines.at(-1)!;
  assert.equal(last.text, "  added in vim");
  assert.equal(last.by, "h");
  assert.equal(last.status, "stale");
  assert.equal(view().lines[5].status, "built");
});

test("undo history survives a restart", async () => {
  const { dir, log } = repo();
  await open(dir).session.pass({ text: PLAN });
  const { session: s, view } = open(dir);
  assert.equal(view().canUndo, true);
  s.undo();
  assert.equal(view().turn, 1);
  assert.match(log()[0], /undo turn 1/);
});

test("a turn reports how long the agent took", async () => {
  const clock = testClock(1_000_000);
  const agent = {
    name: "slow",
    choices: { models: [], efforts: [] },
    run: async () => {
      clock.advance(7_400);
      return '```json\n{"plan":[{"text":"hello"}],"summary":"ok"}\n```';
    },
  };
  const { session: s, view } = open(emptyDir(), { planFile: "p.plan", clock, agent });
  await s.pass({ text: "hello" });
  assert.equal(view().last!.seconds, 7);
});

test("an agent's renames, deletions and staged edits all land in its turn's commit", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "old.js"), "a\n");
  writeFileSync(join(dir, "gone.js"), "b\n");
  writeFileSync(join(dir, "staged.js"), "c\n");
  git("add", ".");
  git("commit", "-qm", "files");
  const agent = {
    name: "git-savvy",
    choices: { models: [], efforts: [] },
    run: async () => {
      git("mv", "old.js", "new.js");
      git("rm", "-q", "gone.js");
      writeFileSync(join(dir, "staged.js"), "c2\n");
      git("add", "staged.js");
      return '```json\n{"plan":[{"text":"hello"}],"summary":"moved things"}\n```';
    },
  };
  const { session: s } = open(dir, { planFile: "p.plan", agent });
  await s.pass({ text: "hello" });
  const files = git("show", "--name-status", "--format=", "HEAD").trim().split("\n").filter((l) => !l.includes(".underpaint"));
  assert.deepEqual(files.sort(), ["A\tp.plan", "D\tgone.js", "M\tstaged.js", "R100\told.js\tnew.js"]);
  assert.equal(git("status", "--porcelain", "--", "new.js", "old.js", "gone.js", "staged.js"), "");
});

test("undo commits only what the undo changed, not the person's other work", async () => {
  const { dir, git, log } = repo();
  const { session: s } = open(dir);
  await s.pass({ text: PLAN });
  writeFileSync(join(dir, "notes.txt"), "the person's own work in progress\n");
  s.undo();
  assert.match(log()[0], /undo turn 1/);
  assert.doesNotMatch(git("show", "--name-only", "--format=", "HEAD"), /notes\.txt/);
  assert.match(git("status", "--porcelain"), /\?\? notes\.txt/);
});

test("with --no-commit, a turn committed earlier can still be undone", async () => {
  const { dir } = repo();
  await open(dir).session.pass({ text: PLAN });
  const { session: s } = open(dir, { commit: false });
  s.undo();
  assert.equal(existsSync(join(dir, "src/summarize.js")), false, "the agent's code is gone too");
});

test("drift is measured from the last turn even across a restart", async () => {
  const { dir } = repo();
  await open(dir).session.pass({ text: PLAN });
  writeFileSync(join(dir, "src/summarize.js"), "// edited while the editor was closed\n");
  const { session: s, view, prompts } = open(dir);
  await s.pass({ text: texts(view().lines).join("\n") });
  assert.match(prompts[0], /# Code that changed outside a turn[\s\S]*- src\/summarize\.js/);
});

test("a session saved by an older version still opens with its undo history", async () => {
  const { dir } = repo();
  await open(dir).session.pass({ text: PLAN });
  // Older versions kept history and the turn log's state inside state.json, and
  // ignored only state.json.
  const at = (f: string) => join(dir, ".underpaint/weekly", f);
  const state = JSON.parse(readFileSync(at("state.json"), "utf8"));
  const { log, ...rest } = state;
  writeFileSync(at("state.json"), JSON.stringify({ ...rest, ...log, history: JSON.parse(readFileSync(at("history.json"), "utf8")) }));
  rmSync(at("history.json"));
  writeFileSync(at(".gitignore"), "# local\nstate.json");
  const { view } = open(dir);
  assert.equal(view().canUndo, true);
  assert.equal(readFileSync(at(".gitignore"), "utf8"), "# local\nstate.json\nhistory.json\n");
});
