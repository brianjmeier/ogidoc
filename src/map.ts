// The flow map: what the person sees and edits, and what the agent keeps true to the code.
//
// A node is an abstraction (a module, a function, a store, something outside). Its
// pseudocode is the level the person thinks at. Nodes nest: a node's children are what
// you see when you open it. Edges are calls or data moving between nodes.

import type { Box, BoxEdge, BoxScan, CodeRef, MapView, Pin, Smell, Status } from "./types.ts";
import type { Skeleton } from "./scan.ts";
import type { DescribeBrief } from "./describe.ts";
import { renameSmell, smellIds, smellText } from "./shared/smells.ts";
import { GHOST, arrowKey, isGhost, trail, visible } from "./shared/level.ts";

export interface MapNode {
  id: string;
  name: string;
  parent?: string | null;
  pseudo: string[];
  code?: CodeRef[];
  status?: Status;
  // The git blob hash of each file in `code` when the node last said what it does.
  // A node whose files hash differently now is stale, whatever happened in between
  // (another task, a hand edit, a rebase onto main). the editor writes it, never the agent.
  seen?: Record<string, string>;
  // Set by the scan only (never kept in map.json).
  scan?: BoxScan;
  // Said by an agent when it described the box: tangles only reading the code shows
  // (an `if` for one value, a parameter for one caller, a copy, a call order to know).
  pins?: Pin[];
}

export interface FlowMap {
  title: string;
  nodes: MapNode[];
  edges: BoxEdge[];
  /** From the scan only, never kept in map.json. */
  smells?: Smell[];
}

export const EMPTY_MAP: FlowMap = { title: "map", nodes: [], edges: [] };

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
  }
  for (const n of m.nodes) if (n.parent && !ids.has(n.parent)) bad(`${n.id}'s parent ${n.parent} is not a node`);
  // An arrow is a call unless the scan found it as an import.
  m.edges = m.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to).map((e) => (e.kind === "call" || e.kind === "import" ? e : { ...e, kind: "call" }));
  m.title ||= "map";
  return m;
}

/** Boxes and their arrows as a map, for the functions here. */
export function mapOf(title: string, boxes: Box[], edges: BoxEdge[]): FlowMap {
  const nodes = boxes.map(({ id, name, parent, lines, status, code, seen, pins, scan }): MapNode => ({
    id,
    name,
    parent,
    pseudo: lines.map((l) => l.text),
    status,
    ...(code?.length && { code }),
    ...(seen && { seen }),
    ...(pins?.length && { pins }),
    ...(scan && { scan }),
  }));
  return { title, nodes, edges };
}

/** The whole map as the person sees it: the scan of the code, with the boxes someone said
 *  something about on it. A box the scan doesn't know sits where its code is. */
export function mapView(sk: Skeleton | null, boxes: Box[], edges: BoxEdge[]): MapView {
  const m = overlay(sk, mapOf("map", boxes, edges));
  const own = new Map(boxes.map((b) => [b.id, b]));
  return {
    title: m.title,
    boxes: m.nodes.map((n): Box => {
      const { scan: _, ...b } = own.get(n.id) ?? { id: n.id, name: n.name, parent: null, lines: [], status: "built" as const, ...(n.code && { code: n.code }) };
      return { ...b, parent: n.parent ?? null, ...(n.scan && { scan: n.scan }) };
    }),
    edges: m.edges,
    smells: m.smells ?? [],
    ...(sk && { unread: sk.unread }),
  };
}

/** The ids with every node that holds one of them, up to the top. */
function withAncestors(byId: Map<string, MapNode>, ids: Set<string>): Set<string> {
  for (const id of [...ids]) for (const p of trail(id, byId)) ids.add(p);
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

// ---------- the scan under the map ----------
//
// The scan's folders and files are the frame; map.json holds only what an agent or the
// person said about them, and what they drew that the scan can't see (functions, plans).
// The running map is `overlay(scan, map.json)`.

/** A top-level box an agent anchored to exactly one file stands in for that file's box,
 *  keeping the agent's id: the weekly plan's `weekWindow`, pointing at `src/week.js`, is
 *  that file's box, so what else lives in the file sits inside it. */
function standIns(sk: Skeleton, map: FlowMap): Map<string, string> {
  const scanIds = new Set(sk.nodes.map((n) => n.id));
  const out = new Map<string, string>();
  for (const n of map.nodes) {
    if (scanIds.has(n.id) || n.parent) continue;
    const files = [...new Set((n.code ?? []).map((c) => c.file))];
    if (files.length === 1 && scanIds.has(files[0]) && !out.has(files[0])) out.set(files[0], n.id);
  }
  return out;
}

export function overlay(sk: Skeleton | null, map: FlowMap | null): FlowMap {
  const base = map ?? EMPTY_MAP;
  if (!sk) return base;
  const stand = standIns(sk, base);
  const idOf = (id: string) => stand.get(id) ?? id;
  const own = new Map(base.nodes.map((n) => [n.id, n]));
  const scanned = new Map(sk.nodes.map((n) => [n.id, n]));
  const nodes: MapNode[] = sk.nodes.map((s) => {
    const id = idOf(s.id);
    const mine = own.get(id);
    // A file box points at its file; a folder at the files that make its seam.
    const code = s.kind === "file" ? [{ file: s.id }] : [...new Set(s.seam.map((x) => x.file))].slice(0, 8).map((file) => ({ file }));
    return {
      ...mine,
      id,
      name: mine?.name ?? s.name,
      parent: s.parent ? idOf(s.parent) : null,
      pseudo: mine?.pseudo ?? [],
      ...(mine?.code?.length ? { code: mine.code } : code.length ? { code } : {}),
      scan: { kind: s.kind, size: s.size, files: s.files, tests: s.tests, seam: s.seam, seamSize: s.seamSize, usedBy: s.usedBy, uses: s.uses },
    };
  });
  const placed = new Set(nodes.map((n) => n.id));
  // A box the scan doesn't know sits in the smallest scan box holding all its files.
  const home = (n: MapNode): string | null => {
    const chains = [...new Set((n.code ?? []).map((c) => c.file))].filter((f) => scanned.has(f)).map((f) => trail(f, scanned).reverse());
    const common = chains[0]?.find((id) => chains.every((c) => c.includes(id)));
    return common ? idOf(common) : null;
  };
  for (const n of base.nodes) {
    if (placed.has(n.id)) continue;
    const parent = n.parent && (own.has(n.parent) || placed.has(idOf(n.parent))) ? idOf(n.parent) : home(n);
    nodes.push({ ...n, parent: parent === n.id ? null : parent });
  }
  const have = new Set(base.edges.map(arrowKey));
  const edges = [...base.edges];
  for (const e of sk.edges) {
    const from = idOf(e.from), to = idOf(e.to);
    if (from === to || have.has(arrowKey({ from, to }))) continue;
    edges.push({ from, to, kind: "import", symbols: e.symbols, ...(e.typeOnly && { typeOnly: true }) });
  }
  const smells = sk.smells.map((x) => renameSmell(x, idOf));
  return { ...checkMap({ title: map?.title && map.title !== "map" ? map.title : sk.title, nodes, edges }), smells };
}

/** The boxes worth listing to an agent that picks where a task lands: what anyone said
 *  something about, and the top two levels of folders. The rest it finds by path. */
export function landmarks(map: FlowMap): MapNode[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  return map.nodes.filter((n) => !n.scan || n.pseudo.length || (trail(n.id, byId).length < 3 && !isFile(n) && n.scan.kind !== "external"));
}

// ---------- describing a box, when the person opens it ----------

/** A box that stands for one file, so the functions inside it can be boxes too. */
export const isFile = (n: { id: string; code?: CodeRef[] }) => n.code?.length === 1 && n.code[0].file === n.id;

/** What a describe turn on `id` (null: the top of the map) is handed: the boxes inside,
 *  the imports among them and across the box's edge, and the tangles already seen. */
export function describeBrief(view: MapView, id: string | null): DescribeBrief {
  const box = id ? view.boxes.find((b) => b.id === id) : null;
  if (id && !box) throw new Error(`The map has no box "${id}".`);
  const kids = view.boxes.filter((b) => (b.parent ?? null) === id && b.scan);
  const kidIds = new Set(kids.map((b) => b.id));
  const bare = (end: string) => (isGhost(end) ? end.slice(GHOST.length) : end);
  const { wires } = visible(view.boxes, view.edges.filter((e) => e.kind === "import"), id);
  return {
    box: box ? { id: box.id, name: box.name, files: box.scan?.files ?? 0, size: box.scan?.size ?? 0 } : null,
    children: kids.map((b) => {
      const { size, seam, seamSize, usedBy, uses } = b.scan!;
      return { id: b.id, name: b.name, file: isFile(b), size, seam: seam.slice(0, 12).map((x) => x.name), seamSize, usedBy, uses };
    }),
    arrows: wires.map((w) => ({ from: bare(w.from), to: bare(w.to), symbols: w.symbols.slice(0, 12) })),
    smells: view.smells.filter((s) => smellIds(s).some((x) => kidIds.has(x))).slice(0, 20).map(smellText),
  };
}

/** Anything on the map that points at code and remembers what the code was. */
interface Anchored {
  id: string;
  code?: CodeRef[];
  seen?: Record<string, string>;
}

/** Boxes whose code changed since they last said what they do: a file they saw hashes
 *  differently now, or is gone (`hashOf` answers null). A box never stamped is not drift. */
export function driftOf(nodes: Anchored[], hashOf: (file: string) => string | null): string[] {
  return nodes.filter((n) => n.seen && Object.entries(n.seen).some(([file, hash]) => hashOf(file) !== hash)).map((n) => n.id);
}

/** These boxes stamped as true to the code as it is now. */
export function stamped<N extends Anchored>(nodes: N[], ids: Iterable<string>, hashOf: (file: string) => string | null): N[] {
  const fresh = new Set(ids);
  return nodes.map((n) => {
    if (!fresh.has(n.id) || !n.code?.length) return n;
    const seen: Record<string, string> = {};
    for (const c of n.code) {
      const hash = hashOf(c.file);
      if (hash !== null) seen[c.file] = hash;
    }
    return Object.keys(seen).length ? { ...n, seen } : n;
  });
}

// ---------- three-way merge: a branch's map onto main's, as git merges code ----------

/** One branch's map merged with another's, from the map they share (`base`), the way
 *  git merges code. Nodes merge field by field: a field changed on one side takes that
 *  side; a field changed on both keeps ours. When both sides rewrote a node's
 *  pseudocode, it keeps ours, unstamped and stale, so the next turn re-reads it. Nodes
 *  and edges added or deleted on either side are added or deleted; a node whose parent
 *  the other side deleted moves to the top. */
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
    if (b && !same(o.pseudo, b.pseudo) && !same(t.pseudo, b.pseudo) && !same(o.pseudo, t.pseudo)) node.status = "stale";
    // Both sides touched this node: whatever it saw, the next turn re-reads it.
    delete node.seen;
    return node;
  });
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (n.parent && !ids.has(n.parent)) n.parent = null;
  const edges = three<BoxEdge>(arrowKey, base.edges, ours.edges, theirs.edges, (o) => o);
  return checkMap({ title: ours.title || theirs.title, nodes, edges });
}
