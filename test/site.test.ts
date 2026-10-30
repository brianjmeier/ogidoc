import { test } from "node:test";
import assert from "node:assert/strict";
import { frames, keystrokes, promptWithCode } from "../site/scenes.ts";

test("keystrokes type a new line one character at a time, after its indentation", () => {
  assert.deepEqual(keystrokes(["a"], ["a", "  bc"]), ["a\n  b", "a\n  bc"]);
});

test("keystrokes continue an edited line from where it starts to differ", () => {
  assert.deepEqual(keystrokes(["every sunday"], ["every sunday!!"]), ["every sunday!", "every sunday!!"]);
});

test("keystrokes take a removed line away before typing", () => {
  assert.deepEqual(keystrokes(["a", "gone", "b"], ["a", "b", "c"]), ["a\nb", "a\nb\nc"]);
});

test("prompt with code: a pseudocode line types itself and needs a build", () => {
  const typed = frames(promptWithCode.start, promptWithCode.beats).filter((f) => f.kind === "type");
  const last = typed.at(-1)!.plan.lines;
  assert.equal(last[2].text, "    look at my week, tell me what i felt most");
  assert.deepEqual(last.map((l) => l.status), ["built", "built", "stale"]);
  assert.equal(typed[0].plan.lines[2].text, "    l");
});

test("prompt with code: the agent's turn marks the line built and real code lands underneath", () => {
  const turn = frames(promptWithCode.start, promptWithCode.beats).at(-1)!;
  assert.equal(turn.kind, "turn");
  if (turn.kind !== "turn") return;
  assert.deepEqual(turn.plan.lines.map((l) => l.status), ["built", "built", "built"]);
  assert.deepEqual(turn.animation.map((o) => o.op), ["keep", "keep", "keep"]);
  assert.ok(turn.last.files?.some((f) => f.path === "src/reflect.ts"));
});
