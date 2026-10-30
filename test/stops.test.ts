import { test } from "node:test";
import assert from "node:assert/strict";
import { anyStop, nextStop, stops } from "../src/shared/stops.ts";
import type { Line, Thread } from "../src/types.ts";

const line = (text: string, more: Partial<Line> = {}): Line => ({ text, by: "a", ...more });
const thread = (at: number, last: "a" | "h", resolved = false): Thread => ({ id: `t${at}`, line: at, by: "h", resolved, messages: [{ by: "h", text: "q" }, { by: last, text: "r" }] } as Thread);

test("stops are the lines that wait on the person, in order", () => {
  const lines = [line("a"), line("b", { kind: "proposal" }), line("c", { status: "blocked" }), line("d"), line("e"), line("  ", { kind: "proposal" })];
  const choices = [{ id: "c1", line: 4, current: 0, options: [[line("e")], [line("f")]] }];
  const threads = [thread(3, "a"), thread(0, "h"), thread(0, "a", true)];
  assert.deepEqual(stops(lines, choices, threads), [1, 2, 3, 4], "not a blank proposal, a thread waiting on the agent, or a resolved one");
  assert.equal(anyStop(lines, choices, threads), true);
  assert.equal(anyStop([line("a"), line("  ", { kind: "proposal" })], [], [thread(0, "h"), thread(5, "a")]), false, "nothing waits on a line the plan doesn't have");
});

test("nextStop goes either way and wraps around", () => {
  assert.equal(nextStop([2, 8], 0, 1), 2);
  assert.equal(nextStop([2, 8], 2, 1), 8);
  assert.equal(nextStop([2, 8], 8, 1), 2);
  assert.equal(nextStop([2, 8], 5, -1), 2);
  assert.equal(nextStop([2, 8], 2, -1), 8);
  assert.equal(nextStop([], 3, 1), null);
});
