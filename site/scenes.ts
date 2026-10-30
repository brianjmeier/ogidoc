import { diffLines, splitLines } from "../src/shared/diff.ts";
import { edit, fromReply, type Plan } from "../src/plan.ts";
import type { AnimationOp, BoxChanges, LastTurn, Line, Reply } from "../src/types.ts";

// The site's scenes are written as turns, and played through the same plan code the
// editor runs: the person's typing goes through `edit`, the agent's reply through
// `fromReply`, so marks, authorship and the turn animation are the real ones.

// The person rewrites the plan to `person`, or the agent replies with `agent`.
export type Beat =
  | { person: string }
  | { agent: Partial<Reply> & Pick<Reply, "plan">; last: LastTurn };

export type Frame =
  | { kind: "type"; plan: Plan }
  | { kind: "turn"; plan: Plan; animation: AnimationOp[]; boxChanges: BoxChanges; last: LastTurn };

const NO_REPLY: Omit<Reply, "plan"> = { boxes: [], comments: [], replies: [], symbols: [], suggestions: [], steps: [], files: [], checks: [], summary: "" };

export function frames(start: Plan, beats: Beat[]): Frame[] {
  const out: Frame[] = [];
  let plan = start;
  let turn = 1;
  for (const beat of beats) {
    if ("person" in beat) {
      for (const text of keystrokes(plan.lines.map((l) => l.text), splitLines(beat.person))) {
        plan = edit(plan, { text });
        out.push({ kind: "type", plan });
      }
    } else {
      const r = fromReply(plan, { ...NO_REPLY, ...beat.agent }, turn++);
      plan = r.plan;
      out.push({ kind: "turn", plan, animation: r.animation, boxChanges: r.boxChanges, last: beat.last });
    }
  }
  return out;
}

// The plan text after each keystroke on the way from `old` to `next`: removed lines go
// first, then each new or edited line is typed out one character at a time.
export function keystrokes(old: string[], next: string[]): string[] {
  const ops = diffLines(old, next);
  const shown: (string | null)[] = next.map(() => null);
  for (const o of ops) if (o.op === "eq") shown[o.b] = next[o.b];
  for (const o of ops) if (o.op === "mod") shown[o.b] = old[o.a];
  const text = () => shown.filter((s) => s !== null).join("\n");
  const out = ops.some((o) => o.op === "del") ? [text()] : [];
  for (const o of ops) {
    if (o.op !== "ins" && o.op !== "mod") continue;
    const target = next[o.b];
    const from = o.op === "mod" ? commonPrefix(old[o.a], target) : target.match(/^\s*/)![0].length;
    for (let k = from + 1; k <= target.length; k++) {
      shown[o.b] = target.slice(0, k);
      out.push(text());
    }
  }
  return out;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

const built = (text: string): Line => ({ text, by: "h", kind: null, status: "built" });

// if (coding is slow but fun): you can prompt with code.
export const promptWithCode = {
  start: { lines: [built("weekly reflection"), built("  every sunday")], boxes: [], threads: [] } satisfies Plan,
  beats: [
    { person: "weekly reflection\n  every sunday\n    look at my week, tell me what i felt most" },
    {
      agent: {
        plan: [
          { text: "weekly reflection", kind: null, status: "built" },
          { text: "  every sunday", kind: null, status: "built" },
          { text: "    look at my week, tell me what i felt most", kind: null, status: "built" },
        ],
      },
      last: {
        summary: "Reads the week's entries and names the feeling that came up most",
        steps: [{ kind: "red-green", what: "the feeling that came up most" }],
        files: [
          { op: "+", path: "src/reflect.ts", why: "topFeeling(week)" },
          { op: "+", path: "test/reflect.test.ts", why: "three calm days beat two tense ones" },
        ],
        checks: [{ name: "npm test", ok: true }],
      },
    },
  ] satisfies Beat[],
};
