import { acceptProposal, anyBuilt, carryMeta, diffLines, joinLines, splitLines } from "./shared/diff.ts";
import * as threads from "./threads.ts";
import type { Base } from "./plan-store.ts";
import type { AnimationOp, Box, HumanDiff, LastTurn, Line, Reply, Thread } from "./types.ts";

// The plan as both sides edit it: its lines, the boxes settled pieces moved into, and
// the comment threads pinned to its lines. Every change returns a new plan.
export interface Plan {
  lines: Line[];
  boxes: Box[];
  threads: Thread[];
}

// The person's edits: new plan text, proposals they accepted, box bodies they changed.
export function edit(plan: Plan, { text, accepted, boxes }: { text?: string; accepted?: number[]; boxes?: Record<string, string> }): Plan {
  let { lines, threads: ts } = plan;
  const built = anyBuilt(plan.lines, plan.boxes);
  if (typeof text === "string") {
    const texts = splitLines(text);
    const ops = diffLines(lines.map((l) => l.text), texts);
    ts = threads.move(ts, ops, lines.length);
    lines = carryMeta(lines, texts, { anyBuilt: built, ops });
  }
  const take = new Set((accepted ?? []).filter((i) => lines[i]?.kind === "proposal"));
  if (take.size) lines = lines.map((l, i) => (take.has(i) ? acceptProposal(l, built) : l));
  return { lines, threads: ts, boxes: boxes ? editBoxes(plan.boxes, boxes) : plan.boxes };
}

// Box files are plain text, edited in the box pane or anywhere else.
export function editBoxes(boxes: Box[], bodies: Record<string, string>): Box[] {
  return boxes.map((b) => {
    if (!(b.name in bodies) || joinLines(b.lines) === bodies[b.name]) return b;
    const lines = carryMeta(b.lines, splitLines(bodies[b.name]), { anyBuilt: true }).map((l) => ({ ...l, kind: null }));
    return { ...b, lines, status: "stale" };
  });
}

// The plan as the files on disk have it; the text there wins over what was saved.
export function fromFiles(saved: Plan, planText: string, boxTexts: Record<string, string>): Plan {
  const boxes = saved.boxes.filter((b) => b.name in boxTexts);
  for (const name of Object.keys(boxTexts)) if (!boxes.some((b) => b.name === name)) boxes.push({ name, lines: [], status: "stale", uses: [] });
  return edit({ ...saved, boxes }, { text: planText, boxes: boxTexts });
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

// Done is read off the plan: no open comment or proposal, every line built, checks green.
export function isDone(plan: Plan, last: LastTurn | null): boolean {
  if (!last || last.error) return false;
  const content = plan.lines.filter((l) => l.text.trim());
  if (!content.length) return false;
  if (plan.threads.some((t) => !t.resolved)) return false;
  if (plan.lines.some((l) => l.kind === "proposal")) return false;
  if (content.some((l) => l.status !== "built")) return false;
  if (plan.boxes.some((b) => b.status !== "built")) return false;
  return (last.checks || []).every((c) => c.ok);
}

// Take the agent's reply apart into lines, boxes and threads, keeping authorship, and
// describe the change so the browser can animate it.
export function fromReply(plan: Plan, reply: Reply, turn: number): { plan: Plan; animation: AnimationOp[] } {
  const oldLines = plan.lines;
  const newTexts = reply.plan.map((l) => l.text);
  const ops = diffLines(oldLines.map((l) => l.text), newTexts);
  const ts = threads.fromAgent(threads.move(plan.threads, ops, oldLines.length), reply, newTexts.length, turn);

  const oldBoxes = new Map(plan.boxes.map((b) => [b.name, b]));
  const boxes = reply.boxes.map((rb) => {
    const old = oldBoxes.get(rb.name);
    const oldL = old ? old.lines : [];
    const bops = diffLines(oldL.map((l) => l.text), rb.lines);
    const lines: Line[] = new Array(rb.lines.length);
    for (const o of bops) {
      if (o.op === "eq") lines[o.b] = { ...oldL[o.a], chg: false };
      else if (o.op !== "del") lines[o.b] = { text: rb.lines[o.b], by: "a", chg: true };
    }
    const changed = !old || bops.some((o) => o.op !== "eq");
    return { name: rb.name, lines, status: rb.status, uses: rb.uses, isNew: !old, changed };
  });

  // A line that left the plan and shows up in a box was moved there.
  const boxOf = new Map<string, string>();
  for (const b of boxes) if (b.changed) for (const l of b.lines) boxOf.set(norm(l.text), b.name);

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
  return { plan: { lines, boxes, threads: ts }, animation };
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
