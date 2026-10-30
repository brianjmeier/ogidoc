import { acceptProposal, anyBuilt, carryMeta, diffLines, joinLines, splitLines, type DiffOp } from "./shared/diff.ts";
import * as threads from "./threads.ts";
import * as choices from "./choices.ts";
import type { AnimationOp, Box, BoxChanges, Choice, HumanDiff, LastTurn, Line, Reply, Thread } from "./types.ts";

// The plan as both sides edit it: its lines, the boxes settled pieces moved into, and
// the comment threads pinned to its lines, and the choices offered on them. Every change
// returns a new plan.
export interface Plan {
  lines: Line[];
  boxes: Box[];
  threads: Thread[];
  choices: Choice[];
}

// The text the agent last saw, to tell it what the person changed since.
export interface Base {
  lines: string[];
  boxes: Record<string, string[]>;
}

// The person's edits: new plan text, proposals they accepted, box bodies they changed.
export function edit(plan: Plan, { text, accepted, boxes }: { text?: string; accepted?: number[]; boxes?: Record<string, string> }): Plan {
  let { lines, threads: ts } = plan;
  let ops: DiffOp[] = lines.map((_, i) => ({ op: "eq", a: i, b: i }));
  if (typeof text === "string") {
    const texts = splitLines(text);
    ops = diffLines(lines.map((l) => l.text), texts);
    ts = threads.move(ts, ops, lines.length);
    lines = carryMeta(lines, texts, { anyBuilt: anyBuilt(lines, plan.boxes), ops });
  }
  const take = new Set((accepted ?? []).filter((i) => lines[i]?.kind === "proposal"));
  const built = anyBuilt(lines, plan.boxes);
  if (take.size) lines = lines.map((l, i) => (take.has(i) ? acceptProposal(l, built) : l));
  return { lines, threads: ts, choices: choices.follow(plan.choices, ops, lines), boxes: boxes ? editBoxes(plan.boxes, boxes) : plan.boxes };
}

// Box files are plain text, edited in the box pane or anywhere else.
function editBoxes(boxes: Box[], bodies: Record<string, string>): Box[] {
  return boxes.map((b) => {
    if (!(b.name in bodies) || joinLines(b.lines) === bodies[b.name]) return b;
    const lines = carryMeta(b.lines, splitLines(bodies[b.name]), { anyBuilt: true }).map((l) => ({ ...l, kind: null }));
    return { ...b, lines, status: "stale" };
  });
}

// The plan as the files on disk have it; the text there wins over what was saved.
export function fromFiles(saved: Plan, planText: string, boxTexts: Record<string, string>): Plan {
  const p = edit(saved, { text: planText });
  const boxes = p.boxes.filter((b) => b.name in boxTexts);
  for (const name of Object.keys(boxTexts)) if (!boxes.some((b) => b.name === name)) boxes.push({ name, lines: [], status: "stale", uses: [] });
  return { ...p, boxes: editBoxes(boxes, boxTexts) };
}

export const baseOf = (plan: Plan): Base => ({
  lines: plan.lines.map((l) => l.text),
  boxes: Object.fromEntries(plan.boxes.map((b) => [b.name, b.lines.map((l) => l.text)])),
});

// What the person changed since the agent last saw the plan.
export function humanDiff(base: Base, plan: Plan): HumanDiff {
  const changes = (oldT: string[], newT: string[]): HumanDiff["lines"] =>
    diffLines(oldT, newT)
      .filter((o) => o.op !== "eq")
      .map((o) => (o.op === "del" ? { op: "del", text: oldT[o.a] } : o.op === "ins" ? { op: "add", text: newT[o.b] } : { op: "mod", old: oldT[o.a], text: newT[o.b] }));
  const boxes = plan.boxes
    .map((b) => ({ name: b.name, lines: changes(base.boxes[b.name] || [], b.lines.map((l) => l.text)) }))
    .filter((b) => b.lines.length);
  return { lines: changes(base.lines, plan.lines.map((l) => l.text)), boxes };
}

// Done is read off the plan: no open comment, choice or proposal, every line built,
// checks green.
export function isDone(plan: Plan, last: LastTurn | null): boolean {
  if (!last || last.error) return false;
  const content = plan.lines.filter((l) => l.text.trim());
  if (!content.length) return false;
  if (plan.threads.some((t) => !t.resolved) || plan.choices.length) return false;
  if (plan.lines.some((l) => l.kind === "proposal")) return false;
  if (content.some((l) => l.status !== "built")) return false;
  if (plan.boxes.some((b) => b.status !== "built")) return false;
  return (last.checks || []).every((c) => c.ok);
}

// The person hands over: whatever the agent wrote and they left as it is, they agreed
// to, so it is theirs now. Proposals and open choices are still the agent's offer.
export function agree(plan: Plan): Plan {
  const offered = new Set(plan.choices.flatMap((c) => c.options[c.current].map((_, i) => c.line + i)));
  const own = (l: Line): Line => (l.by === "a" ? { ...l, by: "h" } : l);
  return {
    ...plan,
    lines: plan.lines.map((l, i) => (l.kind === "proposal" || offered.has(i) ? l : own(l))),
    boxes: plan.boxes.map((b) => (b.lines.some((l) => l.by === "a") ? { ...b, lines: b.lines.map(own) } : b)),
  };
}

// Why a reply doesn't end the agent's turn, or null when it does. A turn moves the plan
// on: it changes code or the plan's text, offers or settles a choice, shapes a box,
// answers the person, stops on something only the person has, or finds everything
// built. Only relabelling lines, like calling a line an example, is not a turn.
export function whyNotATurn(before: Plan, reply: Reply, after: { plan: Plan; boxChanges: BoxChanges }, codeChanged: boolean): string | null {
  const text = (p: Plan) => p.lines.map((l) => l.text).join("\n");
  const ids = (p: Plan) => p.choices.map((c) => c.id).sort().join(" ");
  if (codeChanged || text(before) !== text(after.plan) || ids(before) !== ids(after.plan)) return null;
  if (Object.keys(after.boxChanges).length || before.boxes.length !== after.plan.boxes.length) return null;
  if (reply.replies.some((r) => r.text.trim() || r.resolve)) return null;
  if (reply.steps.some((s) => s.kind === "stop")) return null;
  const built = after.plan.lines.every((l) => !l.text.trim() || l.kind === "proposal" || l.status === "built");
  if (built && reply.steps.some((s) => s.kind === "done")) return null;
  return "It changed no code and nothing in the plan but how lines are labelled.";
}

// Take the agent's reply apart into lines, boxes, threads and choices, keeping authorship, and
// describe the change so the browser can animate it.
export function fromReply(plan: Plan, reply: Reply, turn: number): { plan: Plan; animation: AnimationOp[]; boxChanges: BoxChanges } {
  const oldLines = plan.lines;
  const newTexts = reply.plan.map((l) => l.text);
  const ops = diffLines(oldLines.map((l) => l.text), newTexts);
  const ts = threads.fromAgent(threads.move(plan.threads, ops, oldLines.length), reply, turn);

  const oldBoxes = new Map(plan.boxes.map((b) => [b.name, b]));
  const boxChanges: BoxChanges = {};
  const boxes = reply.boxes.map((rb): Box => {
    const old = oldBoxes.get(rb.name);
    const oldL = old ? old.lines : [];
    const bops = diffLines(oldL.map((l) => l.text), rb.lines);
    const lines: Line[] = new Array(rb.lines.length);
    for (const o of bops) {
      if (o.op === "eq") lines[o.b] = { ...oldL[o.a], chg: false };
      else if (o.op !== "del") lines[o.b] = { text: rb.lines[o.b], by: "a", chg: true };
    }
    if (!old) boxChanges[rb.name] = "new";
    else if (bops.some((o) => o.op !== "eq")) boxChanges[rb.name] = "changed";
    return { name: rb.name, lines, status: rb.status, uses: rb.uses };
  });

  // A line that left the plan and shows up in a box was moved there.
  const boxOf = new Map<string, string>();
  for (const b of boxes) if (b.name in boxChanges) for (const l of b.lines) boxOf.set(norm(l.text), b.name);

  const lines: Line[] = new Array(newTexts.length);
  const animation: AnimationOp[] = [];
  for (const o of ops) {
    if (o.op === "eq") {
      const r = reply.plan[o.b];
      lines[o.b] = { ...oldLines[o.a], kind: r.kind, status: r.status, chg: false };
      animation.push({ op: "keep", a: o.a, b: o.b });
    } else if (o.op === "del") {
      const t = oldLines[o.a].text;
      const to = boxOf.get(norm(t)) || boxOf.get(norm(t.replace(/^\s*(e\.g\.|for example,?)\s*/i, "")));
      animation.push(to ? { op: "move", text: t, to } : { op: "del", text: t });
    } else {
      const r = reply.plan[o.b];
      lines[o.b] = { text: r.text, by: "a", kind: r.kind, status: r.status, chg: true };
      animation.push(o.op === "mod" ? { op: "mod", b: o.b, old: oldLines[o.a].text } : { op: "add", b: o.b });
    }
  }
  return { plan: { lines, boxes, threads: ts, choices: choices.fromAgent(plan.choices, reply.choices, lines) }, animation, boxChanges };
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
