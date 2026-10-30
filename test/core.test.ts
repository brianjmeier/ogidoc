import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, carryMeta, mapIndices } from "../src/shared/diff.ts";
import { buildPrompt, parseReply, readAgentFile } from "../src/prompt.ts";
import type { Line } from "../src/types.ts";

test("diffLines keeps equal lines and pairs similar edits", () => {
  const ops = diffLines(["a", "every sunday", "c"], ["a", "every sunday, my timezone", "c", "d"]);
  assert.deepEqual(ops.map((o) => o.op), ["eq", "mod", "eq", "ins"]);
});

test("diffLines treats unrelated replacements as delete and insert", () => {
  const ops = diffLines(["look at my week"], ["zzzz"]);
  assert.deepEqual(ops.map((o) => o.op).sort(), ["del", "ins"]);
});

test("carryMeta keeps what it knows and marks the person's edits", () => {
  const old: Line[] = [
    { text: "weekly reflection", by: "h", kind: null, status: "built" },
    { text: "  top = keep 3", by: "a", kind: null, status: "built" },
  ];
  const out = carryMeta(old, ["weekly reflection", "  top = keep 2", "  what about weekends?"], { anyBuilt: true });
  assert.equal(out[0].status, "built");
  assert.equal(out[0].chg, undefined);
  assert.equal(out[1].by, "h");
  assert.equal(out[1].status, "stale");
  assert.equal(out[2].kind, null);
  assert.equal(out[2].status, "stale");
});

test("mapIndices follows kept and edited lines, and sends deleted ones to the line above", () => {
  const old = ["a", "every sunday", "gone entirely", "c"];
  const next = ["new first line", "a", "every sunday, my timezone", "c"];
  assert.deepEqual(mapIndices(diffLines(old, next), old.length), [1, 2, 2, 3]);
  assert.deepEqual(mapIndices(diffLines(["only"], []), 1), [0]);
});

test("carryMeta doesn't mark anything stale before anything is built", () => {
  const out = carryMeta([], ["weekly reflection"], { anyBuilt: false });
  assert.equal(out[0].status, null);
});

test("buildPrompt includes the skill, the rules and the plan as JSON", () => {
  const p = buildPrompt({
    skill: readAgentFile("SKILL.md"),
    rules: "Keep turns small.",
    turn: 2,
    planPath: "weekly.plan",
    cwd: "/tmp/x",
    lines: [{ text: "weekly reflection", by: "h", kind: null, status: null }],
    boxes: [],
    threads: [{ id: "t1", line: 0, by: "a", resolved: false, messages: [{ by: "a", text: "whose timezone?", turn: 1 }, { by: "h", text: "mine", turn: 1 }] }],
    choices: [{ id: "c1", line: 0, current: 1, options: [[{ text: "weekly reflection" }], [{ text: "daily reflection" }]] }],
    humanDiff: { lines: [{ op: "add", text: "weekly reflection" }], boxes: [] },
    drift: ["src/other.js"],
    last: { summary: "Asked about the timezone." },
  });
  assert.match(p, /# Underpaint/);
  assert.doesNotMatch(p, /^---/);
  assert.match(p, /Keep turns small\./);
  assert.match(p, /\{"text":"weekly reflection","kind":null,"status":null,"by":"h"\}/);
  assert.match(p, /\+ weekly reflection/);
  assert.match(p, /src\/other\.js/);
  assert.match(p, /Asked about the timezone\./);
  assert.match(p, /t1 on line 0 \("weekly reflection"\):\n  you: whose timezone\?\n  person: mine/);
  assert.match(p, /c1 on line 0: the person switched to option 2\n  option 1: \["weekly reflection"\]\n  option 2, in the plan now: \["daily reflection"\]/);
  assert.doesNotMatch(p, /\{\{/);
});

test("parseReply takes the last JSON block and normalizes it", () => {
  const text = 'I did things.\n```json\n{"plan": []}\n```\nThen more.\n```json\n' + JSON.stringify({
    plan: [{ text: "a  ", kind: "question", status: "built" }, "  plain", { text: "", status: "built" }],
    comments: [{ line: 0, text: "the agent can't start a thread" }],
    choices: [{ id: "c1", line: 0, options: [["a  "], ["b", 3]] }, { line: "x", options: [] }],
    replies: [{ thread: "t1", text: "ok", resolve: true }, { text: "no thread" }],
    boxes: [{ name: "summarize week!", lines: ["x"], status: "nope", uses: ["a", 3] }],
    checks: [{ name: "vitest", ok: false }],
  }) + "\n```";
  const r = parseReply(text);
  assert.equal(r.plan.length, 3);
  assert.equal(r.plan[0].text, "a");
  assert.equal(r.plan[0].kind, null, "questions are comments now, not a kind of line");
  assert.deepEqual(r.choices, [{ id: "c1", line: 0, options: [["a"], ["b", ""]] }]);
  assert.ok(!("comments" in r));
  assert.deepEqual(r.replies, [{ thread: "t1", text: "ok", resolve: true }]);
  assert.equal(r.plan[1].text, "  plain");
  assert.equal(r.plan[2].status, null);
  assert.equal(r.boxes[0].name, "summarizeweek");
  assert.equal(r.boxes[0].status, "stale");
  assert.deepEqual(r.boxes[0].uses, ["a"]);
  assert.equal(r.checks[0].ok, false);
  assert.deepEqual(r.suggestions, []);
});

test("parseReply fails clearly without a plan", () => {
  assert.throws(() => parseReply("no json here"), /no JSON block/);
  assert.throws(() => parseReply("Not logged in · Please run /login"), /It said: Not logged in/);
});
