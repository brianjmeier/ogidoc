// The flow map: what the person sees and edits, and what the agent keeps true to the code.
//
// A node is an abstraction (a module, a function, a store, something outside). Its
// pseudocode is the level the person thinks at. Nodes nest: a node's children are what
// you see when you open it. Edges are calls or data moving between nodes. A flow is a
// named path through the map, like "follow a link", that the editor can play.

import { diffLines } from "../../src/shared/diff.ts";

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
  for (const id of [...region]) for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent) region.add(p);
  return region;
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

/** Nodes whose code changed since the map last said what it does. */
export function driftOf(map: FlowMap, changed: Set<string>): string[] {
  return map.nodes.filter((n) => n.code?.some((c) => changed.has(c.file))).map((n) => n.id);
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
