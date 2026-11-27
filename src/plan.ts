import { acceptProposal, anyBuilt, carryMeta, diffLines, hasContent, joinLines, splitLines, type DiffOp } from "./shared/diff.ts";
import * as threads from "./threads.ts";
import * as choices from "./choices.ts";
import type { AnimationOp, Box, BoxChanges, BoxEdge, Choice, Edit, HumanDiff, LastTurn, Line, MapChange, MapOnDisk, MapView, Reply, Thread } from "./types.ts";
import { mapOf, withDescription } from "./map.ts";
import type { Described } from "./describe.ts";

// The plan as both sides edit it: its lines, the boxes settled pieces moved into, and
// the comment threads pinned to its lines, and the choices offered on them. Every change
// returns a new plan.
export interface Plan {
  lines: Line[];
  boxes: Box[];
  edges: BoxEdge[];
  threads: Thread[];
  choices: Choice[];
}

// The text the agent last saw, to tell it what the person changed since.
export interface Base {
  lines: string[];
  boxes: Record<string, string[]>;
  // Where each box sat and what it was called, and the arrows between boxes. Sessions saved
  // before the person could edit the map have none.
  map?: { boxes: Record<string, { name: string; parent: string | null }>; edges: string[] };
}

// The box of the code the scan found by this id, as the map shows it, whether or not anyone
// said something about it; undefined for a box the scan doesn't know.
export type Scanned = (id: string) => Box | undefined;
const noScan: Scanned = () => undefined;

const lookups = new WeakMap<MapView, Scanned>();
/** The boxes of the code in this map, by id. */
export function scannedIn(view: MapView): Scanned {
  let find = lookups.get(view);
  if (!find) {
    const byId = new Map(view.boxes.filter((b) => b.scan).map((b) => [b.id, b]));
    lookups.set(view, (find = (id) => byId.get(id)));
  }
  return find;
}

// The person's edits: new plan text, proposals they accepted, box bodies they changed,
// by box id. A box only the scan knows joins the plan once its text changes.
export function edit(plan: Plan, { text, accepted, boxes }: { text?: string; accepted?: number[]; boxes?: Record<string, string> }, scanned: Scanned = noScan): Plan {
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
  let have = plan.boxes;
  if (boxes) {
    for (const [id, body] of Object.entries(boxes)) {
      const joined = materialize(have, scanned, id);
      if (joinLines(joined.find((b) => b.id === id)?.lines ?? []) !== body) have = joined;
    }
    have = editBoxes(have, boxes);
  }
  return { ...plan, lines, threads: ts, choices: choices.follow(plan.choices, ops, lines), boxes: have };
}

// A box's body is plain text, edited on the map or in the map file.
function editBoxes(boxes: Box[], bodies: Record<string, string>): Box[] {
  let changed = false;
  const next = boxes.map((b): Box => {
    if (!(b.id in bodies) || joinLines(b.lines) === bodies[b.id]) return b;
    changed = true;
    const lines = carryMeta(b.lines, splitLines(bodies[b.id]), { anyBuilt: true }).map((l) => ({ ...l, kind: null }));
    return { ...b, lines, status: "stale" };
  });
  return changed ? next : boxes;
}

// The plan as the files on disk have it; the text there wins over what was saved. A box
// this session hasn't seen yet (another session's, or the person's) comes as the map has
// it; one it knows keeps what the editor knew about its lines.
export function fromFiles(saved: Plan, planText: string, map: MapOnDisk): Plan {
  const p = edit(saved, { text: planText });
  const had = new Map(p.boxes.map((b) => [b.id, b]));
  const boxes = map.boxes.map(({ text, ...disk }): Box => {
    const old = had.get(disk.id);
    return old ? { ...disk, lines: old.lines, status: old.status } : { ...disk, lines: text ? splitLines(text).map((t) => ({ text: t })) : [] };
  });
  return { ...p, boxes: editBoxes(boxes, Object.fromEntries(map.boxes.map((b) => [b.id, b.text]))), edges: map.edges };
}

export const baseOf = (plan: Plan): Base => ({
  lines: plan.lines.map((l) => l.text),
  boxes: Object.fromEntries(plan.boxes.map((b) => [b.id, b.lines.map((l) => l.text)])),
  map: { boxes: Object.fromEntries(plan.boxes.map((b) => [b.id, { name: b.name, parent: b.parent }])), edges: plan.edges.filter((e) => e.kind === "call").map(edgeKey) },
});

const edgeKey = (e: { from: string; to: string }) => `${e.from} → ${e.to}`;

// The base with what the agent said outside a turn (a describe) taken as seen, so it
// doesn't read as the person's change; what the person changed meanwhile still does.
export function withSaid(base: Base, before: Plan, after: Plan, ids: string[]): Base {
  const now = baseOf(after);
  const fresh = after.boxes.filter((b) => ids.includes(b.id) || !before.boxes.some((x) => x.id === b.id)).map((b) => b.id);
  const had = new Set(before.edges.map(edgeKey));
  const added = after.edges.filter((e) => e.kind === "call" && !had.has(edgeKey(e))).map(edgeKey);
  return {
    ...base,
    boxes: { ...base.boxes, ...Object.fromEntries(fresh.map((id) => [id, now.boxes[id]])) },
    ...(base.map && { map: { boxes: { ...base.map.boxes, ...Object.fromEntries(fresh.map((id) => [id, now.map!.boxes[id]])) }, edges: [...base.map.edges, ...added] } }),
  };
}

// The person's edits to the map, as the browser reports them. A box added in the same
// batch is named by its \`key\` in later edits. An edit that names a box the map doesn't
// have is refused, naming it.
export function editMap(plan: Plan, edits: Edit[], scanned: Scanned = noScan): Plan {
  let boxes = plan.boxes;
  let edges = plan.edges;
  const keys = new Map<string, string>();
  const idOf = (ref: string) => {
    const id = keys.get(ref) ?? ref;
    boxes = materialize(boxes, scanned, id);
    if (!boxes.some((b) => b.id === id)) throw new Error(`There is no box ${ref} on the map.`);
    return id;
  };
  const change = (id: string, f: (b: Box) => Box) => (boxes = boxes.map((b) => (b.id === id ? f(b) : b)));
  for (const e of edits) {
    if (e.op === "pseudo") {
      const id = idOf(e.id);
      boxes = editBoxes(boxes, { [id]: e.lines.join("\n") });
    }
    else if (e.op === "rename") change(idOf(e.id), (b) => ({ ...b, name: e.name.trim() || b.name }));
    else if (e.op === "remove") {
      if (scanned(e.id) && !boxes.some((b) => b.id === e.id)) throw new Error(`${e.id} is code the scan found. Say in the plan what should happen to it.`);
      ({ boxes, edges } = takeOff({ boxes, edges }, idOf(e.id), scanned));
    } else if (e.op === "add") {
      const parent = e.parent === null ? null : idOf(e.parent);
      const slug = e.name.trim().replace(/[^\w.-]+/g, "_").replace(/^_|_$/g, "") || "box";
      let id = slug;
      for (let n = 2; boxes.some((b) => b.id === id); n++) id = `${slug}_${n}`;
      keys.set(e.key, id);
      boxes = [...boxes, { id, name: e.name.trim() || id, parent, lines: e.lines.map((text) => ({ text, by: "h" })), status: "stale" }];
    } else if (e.op === "connect") {
      const [from, to] = [idOf(e.from), idOf(e.to)];
      if (from !== to && !edges.some((x) => x.from === from && x.to === to && x.kind === "call")) edges = [...edges, { from, to, kind: "call", ...(e.label && { label: e.label }) }];
    } else if (e.op === "disconnect") {
      const [from, to] = [idOf(e.from), idOf(e.to)];
      edges = edges.filter((x) => !(x.from === from && x.to === to));
    }
  }
  return { ...plan, boxes, edges };
}

// A box only the scan knew joins the plan's boxes, with the boxes that hold it, once
// someone says something about it.
function materialize(boxes: Box[], scanned: Scanned, id: string): Box[] {
  const have = new Set(boxes.map((b) => b.id));
  const add: Box[] = [];
  for (let cur: string | null = id; cur && !have.has(cur); ) {
    const found = scanned(cur);
    if (!found) break;
    const { scan: _, ...b } = found;
    add.unshift(b);
    have.add(cur);
    cur = found.parent;
  }
  return add.length ? [...boxes, ...add] : boxes;
}

// A box taken off the map, with its arrows. A box of the code stays on the map, so what
// goes is what was said about it, and the boxes inside it stay inside; any other box goes,
// and the boxes it held move up into the box that held it.
function takeOff(p: Pick<Plan, "boxes" | "edges">, id: string, scanned: Scanned): Pick<Plan, "boxes" | "edges"> {
  const gone = p.boxes.find((b) => b.id === id);
  if (!gone) return p;
  const parent = scanned(id) ? id : gone.parent;
  return {
    boxes: p.boxes.filter((b) => b.id !== id).map((b) => (b.parent === id ? { ...b, parent } : b)),
    edges: p.edges.filter((x) => x.from !== id && x.to !== id),
  };
}

function mapChanges(base: Base["map"], plan: Plan, scanned: Scanned): MapChange[] {
  if (!base) return [];
  const out: MapChange[] = [];
  const now = new Map(plan.boxes.map((b) => [b.id, b]));
  for (const b of plan.boxes) {
    const was = base.boxes[b.id] ?? scanned(b.id);
    if (!was) out.push({ op: "add", id: b.id, name: b.name, parent: b.parent });
    else {
      if (was.name !== b.name) out.push({ op: "rename", id: b.id, old: was.name, name: b.name });
      if (was.parent !== b.parent) out.push({ op: "move", id: b.id, parent: b.parent });
    }
  }
  for (const [id, was] of Object.entries(base.boxes)) if (!now.has(id)) out.push(scanned(id) ? { op: "forget", id } : { op: "del", id, name: was.name });
  const calls = plan.edges.filter((e) => e.kind === "call");
  const had = new Set(base.edges);
  const has = new Set(calls.map(edgeKey));
  for (const e of calls) if (!had.has(edgeKey(e))) out.push({ op: "connect", from: e.from, to: e.to, ...(e.label && { label: e.label }) });
  for (const k of base.edges) if (!has.has(k)) {
    const [from, to] = k.split(" → ");
    out.push({ op: "disconnect", from, to });
  }
  return out;
}

// What the person changed since the agent last saw the plan.
export function humanDiff(base: Base, plan: Plan, scanned: Scanned = noScan): HumanDiff {
  const changes = (oldT: string[], newT: string[]): HumanDiff["lines"] =>
    diffLines(oldT, newT)
      .filter((o) => o.op !== "eq")
      .map((o) => (o.op === "del" ? { op: "del", text: oldT[o.a] } : o.op === "ins" ? { op: "add", text: newT[o.b] } : { op: "mod", old: oldT[o.a], text: newT[o.b] }));
  const boxes = plan.boxes
    .map((b) => ({ id: b.id, name: b.name, lines: changes(base.boxes[b.id] || [], b.lines.map((l) => l.text)) }))
    .filter((b) => b.lines.length);
  return { lines: changes(base.lines, plan.lines.map((l) => l.text)), boxes, map: mapChanges(base.map, plan, scanned) };
}

// Every line with something to build is built, and every box. Proposals aren't code yet.
const allBuilt = (plan: Plan) =>
  plan.lines.every((l) => !hasContent(l.text) || l.kind === "proposal" || l.status === "built") && plan.boxes.every((b) => b.status === "built");

// Done is read off the plan: no open comment, choice or proposal, every line built,
// checks green.
export function isDone(plan: Plan, last: LastTurn | null): boolean {
  if (!last || last.error) return false;
  if (!plan.lines.some((l) => hasContent(l.text))) return false;
  if (plan.threads.some((t) => !t.resolved) || plan.choices.length) return false;
  if (plan.lines.some((l) => l.kind === "proposal")) return false;
  if (!allBuilt(plan)) return false;
  return (last.checks || []).every((c) => c.ok);
}

// The person hands over: whatever the agent wrote and they left as it is, they agreed
// to, so it is theirs now. Proposals and open choices are still the agent's offer.
export function agree(plan: Plan): Plan {
  const offered = new Set(plan.choices.flatMap(choices.span));
  const own = (l: Line): Line => (l.by === "a" ? { ...l, by: "h" } : l);
  return {
    ...plan,
    lines: plan.lines.map((l, i) => (l.kind === "proposal" || offered.has(i) ? l : own(l))),
    boxes: plan.boxes.some((b) => b.lines.some((l) => l.by === "a")) ? plan.boxes.map((b) => (b.lines.some((l) => l.by === "a") ? { ...b, lines: b.lines.map(own) } : b)) : plan.boxes,
  };
}

// Why a reply doesn't end the agent's turn, or null when it does. A turn ends on
// something the person can see in the plan: everything built, a change to the plan, a
// choice offered or settled, a box, an answer to their comment, or a stop on what only
// they have. Code alone, or a relabelled line, gives them nothing to look at: the
// agent keeps building. Every red-green ends with a refactor.
export function whyNotATurn(before: Plan, reply: Reply, after: { plan: Plan; boxChanges: BoxChanges }): string | null {
  const kinds = reply.steps.map((s) => s.kind);
  if (kinds.lastIndexOf("red-green") > kinds.lastIndexOf("refactor")) return "The last red-green step has no refactor step after it.";
  const p = after.plan;
  const lost = reply.boxes.filter((b) => b.status === "built" && !p.boxes.find((x) => x.id === b.id)?.code?.length).map((b) => b.id);
  if (lost.length) return `${lost.join(", ")} ${lost.length > 1 ? "say they are" : "says it is"} built but not where the code is. Give every box its \`code\`.`;
  if (allBuilt(p)) return null;
  const ids = (x: Plan) => x.choices.map((c) => c.id).sort().join(" ");
  if (joinLines(before.lines) !== joinLines(p.lines) || ids(before) !== ids(p)) return null;
  // Naming a box only the scan knew brings it onto the plan without saying anything new;
  // saying what a box does, taking one off, or drawing an arrow is new.
  if (Object.keys(after.boxChanges).length || before.boxes.some((b) => !p.boxes.some((x) => x.id === b.id))) return null;
  const arrows = (x: Plan) => x.edges.filter((e) => e.kind === "call").map((e) => `${e.from}→${e.to}`).sort().join(" ");
  if (arrows(before) !== arrows(p)) return null;
  // An answer counts only where it lands: in one of the person's threads.
  if (JSON.stringify(before.threads) !== JSON.stringify(p.threads)) return null;
  if (reply.steps.some((s) => s.kind === "stop")) return null;
  return "Lines are still not built, and the plan shows nothing new.";
}

// Take the agent's reply apart into lines, boxes, threads and choices, keeping authorship, and
// describe the change so the browser can animate it.
export function fromReply(plan: Plan, reply: Reply, turn: number, scanned: Scanned = noScan): { plan: Plan; animation: AnimationOp[]; boxChanges: BoxChanges } {
  const oldLines = plan.lines;
  const newTexts = reply.plan.map((l) => l.text);
  const ops = diffLines(oldLines.map((l) => l.text), newTexts);
  const ts = threads.fromAgent(threads.move(plan.threads, ops, oldLines.length), reply, turn);

  // The reply names only the boxes the agent made, changed or removed; every other box
  // stays exactly as it was. What the reply leaves out of a box stays as the map has it.
  let have = plan.boxes;
  for (const rb of reply.boxes) have = materialize(materialize(have, scanned, rb.id), scanned, rb.parent ?? "");
  for (const rb of reply.boxes) for (const u of rb.uses ?? []) have = materialize(have, scanned, u);
  const oldBoxes = new Map(have.map((b) => [b.id, b]));
  const removed = new Set(reply.removed);
  let left: Pick<Plan, "boxes" | "edges"> = { boxes: have, edges: plan.edges };
  for (const id of removed) left = takeOff(left, id, scanned);
  const boxChanges: BoxChanges = {};
  const touched = new Map<string, Box>();
  for (const rb of reply.boxes) {
    if (removed.has(rb.id)) continue;
    const old = oldBoxes.get(rb.id);
    const { lines, changed } = agentLines(old?.lines ?? [], rb.lines);
    if (!old) boxChanges[rb.id] = "new";
    else if (changed) boxChanges[rb.id] = "changed";
    const code = rb.code ?? old?.code;
    touched.set(rb.id, { ...old, id: rb.id, name: rb.name ?? old?.name ?? rb.id, parent: rb.parent === undefined ? (old?.parent ?? null) : rb.parent, lines, status: rb.status, ...(code && { code }) });
  }
  const kept = left.boxes.map((b) => touched.get(b.id) ?? b);
  const boxes = [...kept, ...[...touched.values()].filter((b) => !oldBoxes.has(b.id))];
  // A box whose parent is on neither the plan nor the scan sits at the top.
  const ids = new Set(boxes.map((b) => b.id));
  for (const [k, b] of boxes.entries()) if (b.parent !== null && ((!ids.has(b.parent) && !scanned(b.parent)) || b.parent === b.id)) boxes[k] = { ...b, parent: null };
  const said = new Set(reply.boxes.filter((rb) => rb.uses).map((rb) => rb.id));
  const edges: BoxEdge[] = [
    ...left.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && !(e.kind === "call" && said.has(e.from))),
    ...reply.boxes.flatMap((rb) => (rb.uses ?? []).filter((u) => ids.has(u) && u !== rb.id && ids.has(rb.id)).map((to): BoxEdge => ({ from: rb.id, to, kind: "call" }))),
  ];

  // A line that left the plan and shows up in a box was moved there.
  const boxOf = new Map<string, string>();
  for (const b of boxes) if (b.id in boxChanges) for (const l of b.lines) boxOf.set(norm(l.text), b.id);

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
  return { plan: { lines, boxes, edges, threads: ts, choices: choices.fromAgent(plan.choices, reply.choices, lines) }, animation, boxChanges };
}

// A box's lines as the agent wrote them: the ones it kept keep what the editor knew.
function agentLines(old: Line[], texts: string[]): { lines: Line[]; changed: boolean } {
  const ops = diffLines(old.map((l) => l.text), texts);
  const lines: Line[] = new Array(texts.length);
  for (const o of ops) {
    if (o.op === "eq") lines[o.b] = { ...old[o.a], chg: false };
    else if (o.op !== "del") lines[o.b] = { text: texts[o.b], by: "a", chg: true };
  }
  return { lines, changed: ops.some((o) => o.op !== "eq") };
}

// What a describe said about a box and the boxes inside it, as boxes of the plan. It only
// says what code does, so what it describes is built.
export function fromDescription(plan: Plan, view: MapView, id: string | null, d: Described): { plan: Plan; ids: string[] } {
  const { map, ids } = withDescription({ ...mapOf(view.title, view.boxes, view.edges), smells: view.smells }, id, d);
  const scanned = scannedIn(view);
  const said = new Map(map.nodes.filter((n) => ids.includes(n.id)).map((n) => [n.id, n]));
  let boxes = plan.boxes;
  for (const n of said.values()) boxes = materialize(boxes, scanned, n.parent ?? "");
  for (const n of said.values()) {
    const old = boxes.find((b) => b.id === n.id) ?? scanned(n.id);
    const { scan: _, pins: _pins, ...was } = old ?? { id: n.id, name: n.name, parent: n.parent ?? null, lines: [], status: "built" as const };
    const box: Box = { ...was, name: n.name, lines: agentLines(was.lines, n.pseudo).lines, status: "built", ...(n.code?.length && { code: n.code }), ...(n.pins?.length && { pins: n.pins }) };
    boxes = boxes.some((b) => b.id === n.id) ? boxes.map((b) => (b.id === n.id ? box : b)) : [...boxes, box];
  }
  const have = new Set(plan.edges.map((e) => `${e.from}→${e.to}`));
  const edges = [...plan.edges, ...map.edges.filter((e) => e.kind === "call" && !have.has(`${e.from}→${e.to}`) && (said.has(e.from) || said.has(e.to))).map((e): BoxEdge => ({ from: e.from, to: e.to, kind: "call", ...(e.label && { label: e.label }) }))];
  return { plan: { ...plan, boxes, edges }, ids };
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
