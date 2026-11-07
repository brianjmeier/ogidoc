// The flow map: what the person sees and edits, and what the agent keeps true to the code.
//
// A node is an abstraction (a module, a function, a store, something outside). Its
// pseudocode is the level the person thinks at. Nodes nest: a node's children are what
// you see when you open it. Edges are calls or data moving between nodes. A flow is a
// named path through the map, like "follow a link", that the editor can play.

import { diffLines } from "../../src/shared/diff.ts";
import type { BoxLine, BoxState, Edit, MapView } from "./contract.ts";

export type Kind = "entry" | "module" | "step" | "store" | "external";
export type Status = "built" | "stale" | "proposal";

export interface CodeRef {
  file: string;
  line?: number;
  symbol?: string;
}

export interface MapNode {
  id: string;
  name: string;
  parent?: string | null;
  kind: Kind;
  pseudo: string[];
  code?: CodeRef[];
  status?: Status;
  // Other ways the agent offers for this node. The node's own pseudo is the way it built.
  ways?: { pseudo: string[] }[];
  // On a stale node from a task plan: the pseudo as the code is today.
  was?: string[];
  // The git blob hash of each file in `code` when the node last said what it does.
  // A node whose files hash differently now is stale, whatever happened in between
  // (another task, a hand edit, a rebase onto main). Ogimap writes it, never the agent.
  seen?: Record<string, string>;
  // Set by the editor only: the person drew this node, or wants it gone.
  by?: "human";
  removed?: boolean;
}

export interface MapEdge {
  from: string;
  to: string;
  label?: string;
  kind?: "call" | "data" | "event";
  by?: "human";
  removed?: boolean;
}

export interface Flow {
  id: string;
  name: string;
  steps: string[];
}

export interface FlowMap {
  title: string;
  nodes: MapNode[];
  edges: MapEdge[];
  flows: Flow[];
}

const KINDS = new Set<Kind>(["entry", "module", "step", "store", "external"]);

// The agent writes the map, so check it before the editor trusts it.
export function checkMap(raw: unknown): FlowMap {
  const m = raw as FlowMap;
  const bad = (why: string) => {
    throw new Error(`The map is not valid: ${why}`);
  };
  if (!m || typeof m !== "object") bad("not an object");
  if (!Array.isArray(m.nodes) || !Array.isArray(m.edges)) bad("nodes and edges must be lists");
  const ids = new Set<string>();
  for (const n of m.nodes) {
    if (typeof n.id !== "string" || !n.id) bad("a node has no id");
    if (ids.has(n.id)) bad(`two nodes are called ${n.id}`);
    ids.add(n.id);
    if (typeof n.name !== "string") bad(`${n.id} has no name`);
    if (!Array.isArray(n.pseudo) || n.pseudo.some((l) => typeof l !== "string")) bad(`${n.id}'s pseudo must be a list of lines`);
    if (!KINDS.has(n.kind)) n.kind = "step";
    if (n.was && (!Array.isArray(n.was) || n.status === "built")) delete n.was;
    delete n.by;
    delete n.removed;
  }
  for (const n of m.nodes) if (n.parent && !ids.has(n.parent)) bad(`${n.id}'s parent ${n.parent} is not a node`);
  m.edges = m.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  for (const e of m.edges) {
    delete e.by;
    delete e.removed;
  }
  m.flows = (m.flows ?? []).map((f) => ({ ...f, steps: f.steps.filter((s) => ids.has(s)) })).filter((f) => f.steps.length > 1);
  m.title ||= "map";
  return m;
}

// ---------- regions: the map grows task by task ----------
//
// An agent never rewrites the whole map. It is handed the region a task works in and
// hands that region back; the merge below writes it into the map, so what lies outside
// stays exactly as it was. A node handed out and not handed back is deleted.

const EMPTY: FlowMap = { title: "map", nodes: [], edges: [], flows: [] };

/** The ids with every node that holds one of them, up to the top. */
function withAncestors(byId: Map<string, MapNode>, ids: Set<string>): Set<string> {
  for (const id of [...ids]) for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent) ids.add(p);
  return ids;
}

/** The ids around some seeds that a turn needs to see: the seeds, what contains them,
 *  what they contain, and what they call or are called by. */
export function regionIds(map: FlowMap, seeds: Iterable<string>): Set<string> {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const region = new Set([...seeds].filter((id) => byId.has(id)));
  const core = [...region];
  for (const e of map.edges) {
    if (region.has(e.from) && byId.has(e.to)) region.add(e.to);
    if (region.has(e.to) && byId.has(e.from)) region.add(e.from);
  }
  for (const n of map.nodes) if (n.parent && core.includes(n.parent)) region.add(n.id);
  return withAncestors(byId, region);
}

/** What a task shows: the nodes it drew or changed, and the modules that hold them.
 *  Narrower than the region a turn is handed, which adds one hop of context. */
export function focusOf(map: FlowMap, ids: Iterable<string>): Set<string> {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  return withAncestors(byId, new Set([...ids].filter((id) => byId.has(id))));
}

/** The part of the map with these ids, with the edges and flows among them. */
export function regionOf(map: FlowMap, ids: Set<string>): FlowMap {
  return {
    title: map.title,
    nodes: map.nodes.filter((n) => ids.has(n.id)),
    edges: map.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    flows: map.flows.filter((f) => f.steps.some((s) => ids.has(s))),
  };
}

/** The map with a region written into it. `sent` is the ids the agent was handed: those
 *  it didn't hand back are gone. Edges among the region's nodes are the region's; flows
 *  it handed back replace the map's of the same id. */
export function mergeRegion(map: FlowMap | null, sent: Set<string>, back: FlowMap): FlowMap {
  const base = map ?? EMPTY;
  const backIds = new Set(back.nodes.map((n) => n.id));
  const touched = new Set([...sent, ...backIds]);
  const returned = new Map(back.nodes.map((n) => [n.id, n]));
  const nodes = [
    ...base.nodes.filter((n) => !sent.has(n.id) || backIds.has(n.id)).map((n) => returned.get(n.id) ?? n),
    ...back.nodes.filter((n) => !base.nodes.some((m) => m.id === n.id)),
  ];
  const edges = [...base.edges.filter((e) => !(touched.has(e.from) && touched.has(e.to))), ...back.edges];
  const backFlows = new Set((back.flows ?? []).map((f) => f.id));
  const flows = [...base.flows.filter((f) => !backFlows.has(f.id)), ...(back.flows ?? [])];
  return checkMap({ title: map ? base.title : back.title || base.title, nodes, edges, flows });
}

/** Nodes whose code changed since the map last said what it does: a file it saw hashes
 *  differently now, or is gone (`hashOf` answers null). A node never stamped is not drift. */
export function driftOf(map: FlowMap, hashOf: (file: string) => string | null): string[] {
  return map.nodes.filter((n) => n.seen && Object.entries(n.seen).some(([file, hash]) => hashOf(file) !== hash)).map((n) => n.id);
}

/** The map with these nodes stamped as true to the code as it is now. */
export function stamped(map: FlowMap, ids: Iterable<string>, hashOf: (file: string) => string | null): FlowMap {
  const fresh = new Set(ids);
  return {
    ...map,
    nodes: map.nodes.map((n) => {
      if (!fresh.has(n.id) || !n.code?.length) return n;
      const seen: Record<string, string> = {};
      for (const c of n.code) {
        const hash = hashOf(c.file);
        if (hash !== null) seen[c.file] = hash;
      }
      return Object.keys(seen).length ? { ...n, seen } : n;
    }),
  };
}

// ---------- three-way merge: a branch's map onto main's, as git merges code ----------

/** One branch's map merged with another's, from the map they share (`base`), the way
 *  git merges code. Nodes merge field by field: a field changed on one side takes that
 *  side. When both sides rewrote a node's pseudocode, the node keeps ours and offers
 *  theirs as another way, unstamped and to build, so the person sees the choice and the
 *  next turn re-reads it; any other field changed on both keeps ours. Nodes, edges and
 *  flows added or deleted on either side are added or deleted; a node whose parent the
 *  other side deleted moves to the top. */
export function mergeMaps(base: FlowMap, ours: FlowMap, theirs: FlowMap): FlowMap {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const three = <T>(key: (x: T) => string, b: T[], o: T[], t: T[], both: (o: T, t: T, b: T | undefined) => T): T[] => {
    const B = new Map(b.map((x) => [key(x), x]));
    const O = new Map(o.map((x) => [key(x), x]));
    const T = new Map(t.map((x) => [key(x), x]));
    const out: T[] = [];
    for (const k of new Set([...O.keys(), ...T.keys(), ...B.keys()])) {
      const [bx, ox, tx] = [B.get(k), O.get(k), T.get(k)];
      if (ox && tx) out.push(same(ox, tx) ? ox : same(ox, bx) ? tx : same(tx, bx) ? ox : both(ox, tx, bx));
      else if (ox && !tx) { if (!bx || !same(ox, bx)) out.push(ox); }
      else if (tx && !ox) { if (!bx || !same(tx, bx)) out.push(tx); }
    }
    return out;
  };
  const nodes = three<MapNode>((n) => n.id, base.nodes, ours.nodes, theirs.nodes, (o, t, b) => {
    const merged: Record<string, unknown> = {};
    const fields = new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(b ?? {})]);
    for (const f of fields) {
      const [ov, tv, bv] = [(o as any)[f], (t as any)[f], (b as any)?.[f]];
      const v = same(ov, tv) || same(tv, bv) ? ov : same(ov, bv) ? tv : ov;
      if (v !== undefined) merged[f] = v;
    }
    const node = merged as unknown as MapNode;
    if (b && !same(o.pseudo, b.pseudo) && !same(t.pseudo, b.pseudo) && !same(o.pseudo, t.pseudo)) {
      node.ways = [{ pseudo: t.pseudo }, ...(o.ways ?? [])];
      node.status = "stale";
    }
    // Both sides touched this node: whatever it saw, the next turn re-reads it.
    delete node.seen;
    return node;
  });
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (n.parent && !ids.has(n.parent)) n.parent = null;
  const edges = three<MapEdge>((e) => `${e.from}→${e.to}`, base.edges, ours.edges, theirs.edges, (o) => o);
  const flows = three<Flow>((f) => f.id, base.flows ?? [], ours.flows ?? [], theirs.flows ?? [], (o) => o);
  return checkMap({ title: ours.title || theirs.title, nodes, edges, flows });
}

// ---------- what a client is told, and what it can do ----------

const STATE: Record<Status, BoxState> = { built: "built", stale: "to build", proposal: "proposed" };

/** A box's pseudocode with the task's plan on it: the lines it adds, and the ones it takes
 *  away (from `was`, what the code does today). A proposed box is all new. */
function linesOf(n: MapNode): BoxLine[] {
  if (n.status === "proposal") return n.pseudo.map((text) => ({ text, mark: "added" }));
  if (!n.was) return n.pseudo.map((text) => ({ text, mark: null }));
  return diffLines(n.was, n.pseudo).flatMap((op): BoxLine[] => {
    if (op.op === "eq") return [{ text: n.pseudo[op.b], mark: null }];
    if (op.op === "del") return [{ text: n.was![op.a], mark: "removed" }];
    if (op.op === "ins") return [{ text: n.pseudo[op.b], mark: "added" }];
    return [{ text: n.was![op.a], mark: "removed" }, { text: n.pseudo[op.b], mark: "added" }];
  });
}

/** The map as a client draws it. Ogimap decides the meaning (each box's state, the plan's
 *  lines, which boxes the task works in); the client only lays it out. */
export function viewOf(map: FlowMap, { focus, drift, standing, failed }: { focus?: string[]; drift: string[]; standing: string; failed: boolean }): MapView {
  const inTask = focus ? new Set(focus) : null;
  const stale = new Set(drift);
  return {
    title: map.title,
    standing,
    failed,
    boxes: map.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      parent: n.parent ?? null,
      kind: n.kind,
      state: stale.has(n.id) ? "code changed" : STATE[n.status ?? "built"],
      lines: linesOf(n),
      ways: n.ways?.length ?? 0,
      inTask: inTask ? inTask.has(n.id) : true,
    })),
    edges: map.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
  };
}

const slug = (name: string) => name.trim().toLowerCase().replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "box";

/** A client's edits as the person's draft of the map, the form a turn reads. An edit that
 *  names a box the map doesn't have is refused, naming it. */
export function draftFromEdits(map: FlowMap, edits: Edit[]): FlowMap {
  const draft: FlowMap = JSON.parse(JSON.stringify(map));
  const byId = new Map(draft.nodes.map((n) => [n.id, n]));
  const keys = new Map<string, string>();
  const box = (id: string) => {
    const n = byId.get(keys.get(id) ?? id);
    if (!n) throw new Error(`The map has no box "${id}".`);
    return n;
  };
  for (const e of edits) {
    if (e.op === "pseudo") box(e.id).pseudo = e.lines;
    else if (e.op === "rename") box(e.id).name = e.name;
    else if (e.op === "remove") box(e.id).removed = true;
    else if (e.op === "add") {
      if (e.parent !== null) box(e.parent);
      const base = (e.parent ? `${e.parent}.` : "") + slug(e.name);
      let id = base;
      for (let k = 2; byId.has(id); k++) id = `${base}${k}`;
      const n: MapNode = { id, name: e.name, parent: e.parent, kind: "step", pseudo: e.lines, status: "proposal", by: "human" };
      draft.nodes.push(n);
      byId.set(id, n);
      keys.set(e.key, id);
    } else if (e.op === "connect" || e.op === "disconnect") {
      const from = box(e.from).id;
      const to = box(e.to).id;
      const edge = draft.edges.find((x) => x.from === from && x.to === to);
      if (e.op === "disconnect") {
        if (!edge) throw new Error(`The map has no arrow from "${from}" to "${to}".`);
        edge.removed = true;
      } else if (edge) edge.removed = false;
      else draft.edges.push({ from, to, ...(e.label ? { label: e.label } : {}), kind: "call", by: "human" });
    }
  }
  return draft;
}

/** A short index of the map, so a new task reuses what is already drawn. */
export function indexOf(map: FlowMap, drift: string[]): string {
  return map.nodes
    .map((n) => `- ${n.id}${n.parent ? ` (in ${n.parent})` : ""}: ${n.pseudo[0] ?? ""}${n.code?.length ? ` [${[...new Set(n.code.map((c) => c.file))].join(", ")}]` : ""}${drift.includes(n.id) ? " — code changed since mapped" : ""}`)
    .join("\n");
}

const edgeKey = (e: MapEdge) => `${e.from} → ${e.to}`;

// What the person changed between the map they were handed and their draft. This is
// their whole message to the agent, so it reads as a diff, never as prose.
export function intentOf(before: FlowMap, draft: FlowMap, focus: string[]): string {
  const was = new Map(before.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const n of draft.nodes) {
    const old = was.get(n.id);
    const where = n.parent ? ` inside ${n.parent}` : "";
    if (n.removed) {
      if (old) out.push(`REMOVE node ${n.id}`);
      continue;
    }
    if (!old) {
      out.push(`NEW node ${n.id} "${n.name}" (${n.kind})${where}`, ...n.pseudo.map((l) => `  + ${l}`));
      continue;
    }
    const head: string[] = [];
    if (old.name !== n.name) head.push(`renamed ${JSON.stringify(old.name)} → ${JSON.stringify(n.name)}`);
    if ((old.parent ?? null) !== (n.parent ?? null)) head.push(`moved into ${n.parent ?? "the top level"}`);
    const lines = pseudoDiff(old.pseudo, n.pseudo);
    const picked = old.ways?.findIndex((w) => same(w.pseudo, n.pseudo)) ?? -1;
    if (picked >= 0) head.push(`picked way ${picked + 2} of ${(old.ways?.length ?? 0) + 1} (build this one instead)`);
    if (head.length || lines.length) out.push(`CHANGE node ${n.id}${head.length ? ": " + head.join(", ") : ""}`, ...lines);
  }
  const oldEdges = new Set(before.edges.map(edgeKey));
  for (const e of draft.edges) {
    if (e.removed && oldEdges.has(edgeKey(e))) out.push(`REMOVE edge ${edgeKey(e)}`);
    else if (!e.removed && !oldEdges.has(edgeKey(e))) out.push(`NEW edge ${edgeKey(e)}${e.label ? ` "${e.label}"` : ""}`);
  }
  if (!out.length) out.push("(no edits: go on with what is not built yet, or settle open ways by keeping your pick)");
  if (focus.length) out.push("", `The person had these nodes selected: ${focus.join(", ")}`);
  return out.join("\n");
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

function pseudoDiff(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const op of diffLines(a, b)) {
    if (op.op === "eq") out.push(`    ${b[op.b]}`);
    else if (op.op === "del") out.push(`  - ${a[op.a]}`);
    else if (op.op === "ins") out.push(`  + ${b[op.b]}`);
    else out.push(`  - ${a[op.a]}`, `  + ${b[op.b]}`);
  }
  return out.some((l) => !l.startsWith("    ")) ? out : [];
}
