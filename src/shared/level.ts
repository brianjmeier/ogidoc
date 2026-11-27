import type { Box, BoxEdge } from "../types.ts";

// One level of the map, as the person and the agent both see it: the boxes inside it, and
// every arrow lifted to the boxes that hold its ends.

type ById = Map<string, { id: string; parent?: string | null }>;

/** The one key of an arrow from `from` to `to`. */
export const arrowKey = (e: { from: string; to: string }) => `${e.from}→${e.to}`;

// An arrow on one level: every edge whose ends lie inside the same two shown boxes.
// `from` uses `to`, as on a BoxEdge.
export interface Wire {
  key: string;
  from: string;
  to: string;
  members: BoxEdge[];
  labels: string[];
  symbols: string[];
  imports: boolean;
  ghost: boolean;
}

// A box outside the level that an arrow comes from or goes to. "in": the level uses it;
// "out": it uses the level.
export type GhostSide = "in" | "out" | "both";

export const GHOST = "ghost:";
export const isGhost = (key: string) => key.startsWith(GHOST);

// The box holding `id` whose parent is `level`, or null when `id` isn't inside the level.
export function ancestorAt(id: string, level: string | null, byId: ById): string | null {
  let b = byId.get(id);
  while (b && (b.parent ?? null) !== level) b = b.parent ? byId.get(b.parent) : undefined;
  return b?.id ?? null;
}

// The boxes from the top down to `level`, for the breadcrumb.
export function trail(level: string | null, byId: ById): string[] {
  const out: string[] = [];
  for (let p = level; p; p = byId.get(p)?.parent ?? null) out.unshift(p);
  return out;
}

// An arrow end outside the level shows as the nearest box beside one of the level's
// ancestors, so it reads like "from routes". `chain` is the level and its ancestors, up
// to the top (null).
function outsideEnd(id: string, chain: (string | null)[], byId: ById): string | null {
  for (const lvl of chain.slice(1)) {
    const a = ancestorAt(id, lvl, byId);
    if (a && !chain.includes(a)) return a;
  }
  return null;
}

// What a level shows: its boxes, the arrows lifted to them, and ghosts for the ends outside.
export function visible<B extends Pick<Box, "id" | "parent">>(boxes: B[], edges: BoxEdge[], level: string | null) {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const shown = boxes.filter((b) => (b.parent ?? null) === level);
  const ghosts = new Map<string, GhostSide>();
  const wires = new Map<string, Omit<Wire, "labels" | "symbols"> & { labels: Set<string>; symbols: Set<string> }>();
  const ghost = (id: string, side: GhostSide) => {
    const was = ghosts.get(id);
    ghosts.set(id, was && was !== side ? "both" : side);
    return GHOST + id;
  };
  // Where each end shows on this level: the box inside holding it, or the box outside.
  const chain: (string | null)[] = [...trail(level, byId).reverse(), null];
  const ends = new Map<string, { inside: boolean; at: string | null }>();
  const endOf = (id: string) => {
    let end = ends.get(id);
    if (!end) {
      const at = ancestorAt(id, level, byId);
      end = at ? { inside: true, at } : { inside: false, at: outsideEnd(id, chain, byId) };
      ends.set(id, end);
    }
    return end;
  };
  for (const e of edges) {
    const from = endOf(e.from);
    const to = endOf(e.to);
    if (!from.inside && !to.inside) continue;
    if (!from.at || !to.at || from.at === to.at) continue;
    const a = from.inside ? from.at : ghost(from.at, "out");
    const b = to.inside ? to.at : ghost(to.at, "in");
    const key = arrowKey({ from: a, to: b });
    let w = wires.get(key);
    if (!w) wires.set(key, (w = { key, from: a, to: b, members: [], labels: new Set(), symbols: new Set(), imports: true, ghost: !from.inside || !to.inside }));
    w.members.push(e);
    if (e.label) w.labels.add(e.label);
    for (const s of e.symbols ?? []) w.symbols.add(s);
    w.imports &&= e.kind === "import";
  }
  return { byId, shown, ghosts, wires: [...wires.values()].map((w): Wire => ({ ...w, labels: [...w.labels], symbols: [...w.symbols] })) };
}
