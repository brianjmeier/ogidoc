// The map's geometry, with no DOM: which boxes a level shows, the arrows lifted to it,
// where each box goes, and the curves between them. Boxes.tsx measures the boxes and
// draws what this returns.

import type { Box, BoxEdge, Smell } from "../../src/types.ts";
import { smellIds } from "../../src/shared/smells.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

type ById = Map<string, Pick<Box, "id" | "parent">>;

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
type GhostSide = "in" | "out" | "both";

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
export function visible(boxes: Box[], edges: BoxEdge[], level: string | null) {
  const byId: ById = new Map(boxes.map((b) => [b.id, b]));
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
    const key = `${a}→${b}`;
    let w = wires.get(key);
    if (!w) wires.set(key, (w = { key, from: a, to: b, members: [], labels: new Set(), symbols: new Set(), imports: true, ghost: !from.inside || !to.inside }));
    w.members.push(e);
    if (e.label) w.labels.add(e.label);
    for (const s of e.symbols ?? []) w.symbols.add(s);
    w.imports &&= e.kind === "import";
  }
  return { byId, shown, ghosts, wires: [...wires.values()].map((w): Wire => ({ ...w, labels: [...w.labels], symbols: [...w.symbols] })) };
}

// Columns by what a box uses: what is used sits left of what uses it. The longest path
// from the boxes that use nothing; a loop stops where it meets itself.
function ranks(ids: string[], wires: Wire[]): Map<string, number> {
  const out = new Map(ids.map((id) => [id, [] as string[]]));
  for (const w of wires) if (out.has(w.from) && out.has(w.to)) out.get(w.to)!.push(w.from);
  const rank = new Map(ids.map((id) => [id, 0]));
  const visit = (id: string, r: number, path: Set<string>) => {
    if (path.has(id) || (r <= rank.get(id)! && path.size)) return;
    rank.set(id, Math.max(rank.get(id)!, r));
    path.add(id);
    for (const t of out.get(id)!) visit(t, r + 1, path);
    path.delete(id);
  };
  const hasIn = new Set([...out.values()].flat());
  for (const id of ids) if (!hasIn.has(id)) visit(id, 0, new Set());
  for (const id of ids) if (!rank.get(id) && hasIn.has(id)) visit(id, 0, new Set());
  return rank;
}

// Every box of a level with its rank, ghosts included: a ghost the level uses sits left
// of everything, one that uses the level right of it.
export function ranked(ids: string[], ghosts: Map<string, GhostSide>, wires: Wire[]): Map<string, number> {
  const rank = ranks(ids, wires);
  const last = Math.max(0, ...rank.values());
  for (const [id, side] of ghosts) rank.set(GHOST + id, side === "in" ? -1 : last + 1);
  return rank;
}

// Reading order: by rank, then the boxes that feed the next rank the most first.
export function order(rank: Map<string, number>, wires: Wire[]): string[] {
  const ahead = new Map<string, number>();
  for (const w of wires) if (!isGhost(w.from) && rank.get(w.from)! > rank.get(w.to)!) ahead.set(w.to, (ahead.get(w.to) ?? 0) + 1);
  return [...rank.keys()].sort((a, b) => rank.get(a)! - rank.get(b)! || (ahead.get(b) ?? 0) - (ahead.get(a) ?? 0));
}

const PAD = 8;
const GAP = 22;
const GAP_RANK = { across: 96, down: 52 };

interface Placed {
  pos: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  down: boolean;
}

// Ranks run left to right, or top to bottom when that shows the map larger in the room
// there is. A rank longer than the room wraps into another line, so a long list of boxes
// that don't use each other never shrinks the text to fit.
export function place(ids: string[], rank: Map<string, number>, size: Map<string, Size>, room: Size): Placed {
  const across = arrange(ids, rank, size, room, false);
  const down = arrange(ids, rank, size, room, true);
  return zoomToFit(down, room) > zoomToFit(across, room) ? down : across;
}

export const zoomToFit = (p: { width: number; height: number }, room: Size) => Math.min(1, room.w / p.width, room.h / p.height);

function arrange(ids: string[], rank: Map<string, number>, size: Map<string, Size>, room: Size, down: boolean): Placed {
  const along = (s: Size) => (down ? s.w : s.h);
  const thick = (s: Size) => (down ? s.h : s.w);
  const limit = down ? Math.max(room.w, 250 + 2 * PAD) : Math.max(room.h, 600);
  const byRank = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    const at = byRank.get(r);
    if (at) at.push(id);
    else byRank.set(r, [id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let at = PAD;
  let width = 0;
  let height = 0;
  for (const r of [...byRank.keys()].sort((a, b) => a - b)) {
    const placed: { id: string; line: number; c: number }[] = [];
    const lines = [0];
    let c = PAD;
    for (const id of byRank.get(r)!) {
      const s = size.get(id) ?? { w: 0, h: 0 };
      if (c > PAD && c + along(s) > limit - PAD) {
        c = PAD;
        lines.push(0);
      }
      placed.push({ id, line: lines.length - 1, c });
      lines[lines.length - 1] = Math.max(lines.at(-1)!, thick(s));
      c += along(s) + GAP;
    }
    // The first line filled sits nearest the next rank: it has the boxes that feed it most.
    const offset: number[] = [];
    for (let k = lines.length - 1; k >= 0; k--) {
      offset[k] = at;
      at += lines[k] + GAP;
    }
    at += GAP_RANK[down ? "down" : "across"] - GAP;
    for (const p of placed) {
      const s = size.get(p.id) ?? { w: 0, h: 0 };
      const xy = down ? { x: p.c, y: offset[p.line] } : { x: offset[p.line], y: p.c };
      pos.set(p.id, xy);
      width = Math.max(width, xy.x + s.w + PAD);
      height = Math.max(height, xy.y + s.h + PAD);
    }
  }
  return { pos, width, height, down };
}

// A curve from what is used (`a`) to what uses it (`b`), with where to put its label.
// `a.port` is how far down `a` the arrow leaves: the seam name it carries.
export function wirePath(a: Rect & { port?: number }, b: Rect, down: boolean): { d: string; mid: { x: number; y: number } } {
  const curve = (x1: number, y1: number, c1x: number, c1y: number, c2x: number, c2y: number, x2: number, y2: number) => ({
    d: `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`,
    mid: { x: (x1 + 3 * c1x + 3 * c2x + x2) / 8, y: (y1 + 3 * c1y + 3 * c2y + y2) / 8 },
  });
  const x1 = a.x + a.w, y1 = a.y + (a.port ?? Math.min(19, a.h / 2));
  const x2 = b.x, y2 = b.y + Math.min(19, b.h / 2);
  const sx = a.x + a.w / 2, sy = a.y + a.h, tx = b.x + b.w / 2, ty = b.y;
  if (down && ty > sy + 10) {
    const c = Math.max(24, (ty - sy) / 2);
    return curve(sx, sy, sx, sy + c, tx, ty - c, tx, ty - 2);
  }
  if (x2 > x1 + 20) {
    const c = Math.max(30, (x2 - x1) / 2);
    return curve(x1, y1, x1 + c, y1, x2 - c, y2, x2 - 2, y2);
  }
  // Backwards or stacked: leave from the bottom and come in from the top, or loop round.
  if (ty > sy) return curve(sx, sy, sx, sy + 40, tx, ty - 40, tx, ty - 2);
  return curve(x1, y1, x1 + 70, y1, b.x + b.w + 70, b.y + 19, b.x + b.w + 2, b.y + 19);
}

// With one box selected: every box on the level that uses it, directly or through others.
// That is what a change to it can break.
export function impactOf(selected: string | null, wires: Wire[]): Set<string> {
  const seen = new Set<string>();
  if (!selected) return seen;
  const users = new Map<string, string[]>();
  for (const w of wires) {
    const u = users.get(w.to);
    if (u) u.push(w.from);
    else users.set(w.to, [w.from]);
  }
  const todo = [selected];
  while (todo.length) {
    for (const u of users.get(todo.pop()!) ?? []) {
      if (u !== selected && !seen.has(u)) {
        seen.add(u);
        todo.push(u);
      }
    }
  }
  return seen;
}

// The names an import arrow carries, as many as read at a glance.
export function namesOf(symbols: string[]): string {
  const names = symbols.filter((x) => x !== "*" && x !== "default");
  if (!names.length) return symbols.length ? "the whole module" : "";
  return names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
}

// The tangles that lie on a level: every box they name is shown there.
export const tanglesAt = (smells: Smell[], shown: Set<string>) => smells.filter((s) => smellIds(s).every((id) => shown.has(id)));

export const count = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(k >= 10000 ? 0 : 1)}k` : String(k));
