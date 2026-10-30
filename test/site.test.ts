import { test } from "node:test";
import assert from "node:assert/strict";
import { abstractions, choices, frames, keystrokes, promptWithCode, styles } from "../site/scenes.ts";
import { hasContent } from "../src/shared/diff.ts";

test("keystrokes type a new line one character at a time, after its indentation", () => {
  assert.deepEqual(keystrokes(["a"], ["a", "  bc"]), ["a\n  b", "a\n  bc"]);
});

test("keystrokes continue an edited line from where it starts to differ", () => {
  assert.deepEqual(keystrokes(["every sunday"], ["every sunday!!"]), ["every sunday!", "every sunday!!"]);
});

test("keystrokes take the end off a line that only got shorter", () => {
  assert.deepEqual(keystrokes(["(turn :x))"], ["(turn :x)", "  (b)"]), ["(turn :x)", "(turn :x)\n  (", "(turn :x)\n  (b", "(turn :x)\n  (b)"]);
});

test("keystrokes take a removed line away before typing", () => {
  assert.deepEqual(keystrokes(["a", "gone", "b"], ["a", "b", "c"]), ["a\nb", "a\nb\nc"]);
});

test("prompt with code: a pseudocode line types itself and needs a build", () => {
  const typed = frames(promptWithCode.start, promptWithCode.beats).filter((f) => f.kind === "type");
  const last = typed.at(-1)!.plan.lines;
  assert.equal(last[3].text, "  click(cell) -> put turn's mark there, swap turn");
  assert.deepEqual(last.map((l) => l.status), ["built", "built", "built", "stale"]);
  assert.equal(typed[0].plan.lines[3].text, "  c");
});

test("prompt with code: the agent's turn marks the line built and real code lands underneath", () => {
  const turn = frames(promptWithCode.start, promptWithCode.beats).at(-1)!;
  assert.equal(turn.kind, "turn");
  if (turn.kind !== "turn") return;
  assert.deepEqual(turn.plan.lines.map((l) => l.status), ["built", "built", "built", "built"]);
  assert.deepEqual(turn.animation.map((o) => o.op), ["keep", "keep", "keep", "keep"]);
  assert.ok(turn.last.files?.some((f) => f.path === "src/game.ts"));
});

test("abstractions: three settled lines fold into a named box and leave a one-line reference behind", () => {
  const turn = frames(abstractions.start, abstractions.beats).at(-1)!;
  assert.equal(turn.kind, "turn");
  if (turn.kind !== "turn") return;
  assert.deepEqual(turn.animation.filter((o) => o.op === "move").map((o) => o.op === "move" && o.to), ["winner", "winner", "winner"]);
  assert.deepEqual(turn.boxChanges, { winner: "new" });
  assert.equal(turn.plan.lines[4].text, "  winner(board) -> see winner");
  assert.deepEqual(turn.plan.lines.map((l) => l.status), ["built", "built", "built", "built", "built", "built"]);
});

test("choices: the agent builds its pick and offers the other way in place", () => {
  const turn = frames(choices.start, choices.beats).find((f) => f.kind === "turn")!;
  assert.deepEqual(turn.plan.choices.map((c) => c.options.map((o) => o.map((l) => l.text))), [[["    clear board, X goes first"], ["    clear board, loser goes first"]]]);
  assert.equal(turn.plan.lines[5].status, "built");
});

test("choices: the person switches to the other way, and the agent builds it and settles the choice", () => {
  const all = frames(choices.start, choices.beats);
  const picked = all.at(-2)!;
  assert.equal(picked.kind, "type");
  assert.equal(picked.kind === "type" && picked.picked, true, "the switch is marked, so the scene can hold on it before handing over");
  assert.equal(picked.plan.lines[5].text, "    clear board, loser goes first");
  const done = all.at(-1)!;
  assert.deepEqual(done.plan.choices, []);
  assert.deepEqual(done.plan.lines.map((l) => l.status), ["built", "built", "built", "built", "built", "built"]);
});

for (const [style, guard] of [["python", "        if board[row][col]: return"], ["js", "    if (taken(cell)) return;"], ["clojure", "    (ignore-when (taken? cell))"]] as const) {
  test(`styles: in ${style}-like pseudocode the agent adds its line in the same style, and only that line is its own`, () => {
    const all = frames(styles[style].start, styles[style].beats);
    const typed = all.at(-2)!.plan.lines;
    const before = styles[style].start.lines.map((l) => l.text);
    const want = (t: string) => (before.includes(t) ? "built" : hasContent(t) ? "stale" : null);
    assert.deepEqual(typed.map((l) => l.status), typed.map((l) => want(l.text)), "every line the person wrote or changed needs a build, unless it's bare structure like a brace");
    const done = all.at(-1)!.plan.lines;
    assert.deepEqual(done.filter((l) => l.by === "a").map((l) => l.text), [guard]);
    assert.ok(done.every((l) => l.status === "built"));
  });
}
