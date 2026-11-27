import { test } from "node:test";
import assert from "node:assert/strict";
import { impactOf, order, place, ranked, smellIds, tanglesAt, trail, visible, wirePath } from "../app/map/layout.ts";
import type { Box, BoxEdge } from "../src/types.ts";

const box = (id: string, parent: string | null = null): Box => ({ id, name: id, parent, lines: [], status: "built" });
const call = (from: string, to: string): BoxEdge => ({ from, to, kind: "call" });
const imp = (from: string, to: string, symbols: string[]): BoxEdge => ({ from, to, kind: "import", symbols });

// src holds api and db; api holds routes and handlers; cli sits beside src.
const boxes = [box("src"), box("cli"), box("api", "src"), box("db", "src"), box("routes", "api"), box("handlers", "api")];
const edges = [
  imp("routes", "handlers", ["handle"]),
  imp("handlers", "db", ["query"]),
  imp("routes", "db", ["connect"]),
  imp("cli", "routes", ["start"]),
];

test("the top shows only the top boxes, with the arrows inside them lifted to them", () => {
  const v = visible(boxes, edges, null);
  assert.deepEqual(v.shown.map((b) => b.id), ["src", "cli"]);
  assert.deepEqual(v.wires.map((w) => [w.from, w.to, w.members.length]), [["cli", "src", 1]], "arrows inside src don't show at the top");
  assert.equal(v.ghosts.size, 0);
});

test("a level lifts the arrows of what it holds and merges the ones between the same two boxes", () => {
  const v = visible(boxes, edges, "src");
  assert.deepEqual(v.shown.map((b) => b.id), ["api", "db"]);
  const toDb = v.wires.find((w) => w.from === "api" && w.to === "db")!;
  assert.equal(toDb.members.length, 2, "handlers→db and routes→db are one arrow from api");
  assert.deepEqual(toDb.symbols, ["query", "connect"]);
  assert.ok(toDb.imports);
});

test("an arrow end outside the level shows as a ghost of the nearest box beside the level", () => {
  const v = visible(boxes, edges, "api");
  assert.deepEqual(v.shown.map((b) => b.id), ["routes", "handlers"]);
  assert.deepEqual([...v.ghosts], [["db", "in"], ["cli", "out"]], "the level uses db, and cli uses the level");
  assert.deepEqual(v.wires.map((w) => w.key).sort(), ["ghost:cli→routes", "handlers→ghost:db", "routes→ghost:db", "routes→handlers"]);
  assert.deepEqual(trail("api", v.byId), ["src", "api"]);
});

test("what is used sits left of what uses it, ghosts at the ends", () => {
  const v = visible(boxes, edges, "api");
  const rank = ranked(v.shown.map((b) => b.id), v.ghosts, v.wires);
  assert.deepEqual(Object.fromEntries(rank), { handlers: 0, routes: 1, "ghost:db": -1, "ghost:cli": 2 });
  assert.deepEqual(order(rank, v.wires), ["ghost:db", "handlers", "routes", "ghost:cli"]);
});

test("a chain that is too wide to fit across is laid out top to bottom", () => {
  const ids = ["a", "b", "c", "d"];
  const wires = visible(ids.map((id) => box(id)), [call("b", "a"), call("c", "b"), call("d", "c")], null).wires;
  const rank = ranked(ids, new Map(), wires);
  const size = new Map(ids.map((id) => [id, { w: 250, h: 80 }]));
  const p = place(order(rank, wires), rank, size, { w: 640, h: 800 });
  assert.equal(p.down, true);
  const ys = ids.map((id) => p.pos.get(id)!.y);
  assert.deepEqual([...ys].sort((x, y) => x - y), ys, "each rank one row lower");
  const wide = place(order(rank, wires), rank, size, { w: 1600, h: 800 });
  assert.equal(wide.down, false, "with room across, it reads left to right");
});

test("a rank taller than the room wraps into another column", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const rank = new Map(ids.map((id) => [id, 0]));
  const size = new Map(ids.map((id) => [id, { w: 250, h: 200 }]));
  const p = place(ids, rank, size, { w: 2000, h: 600 });
  assert.equal(p.down, false);
  const columns = new Set(ids.map((id) => p.pos.get(id)!.x));
  assert.equal(columns.size, 3, "five 200px boxes in 600px make three columns");
  assert.ok(Math.max(...ids.map((id) => p.pos.get(id)!.y + 200)) <= 600, "none runs past the room");
  assert.ok(p.pos.get("a")!.x > p.pos.get("e")!.x, "the first boxes sit nearest the next rank");
});

test("a selected box lights up every box that uses it, directly or through others", () => {
  const ids = ["db", "handlers", "routes", "cli", "other"];
  const wires = visible(ids.map((id) => box(id)), [call("handlers", "db"), call("routes", "handlers"), call("cli", "routes"), call("db", "other")], null).wires;
  assert.deepEqual([...impactOf("handlers", wires)].sort(), ["cli", "routes"]);
  assert.deepEqual([...impactOf(null, wires)], []);
});

test("an arrow leaves the used box at its seam name and enters the user's side", () => {
  const { d } = wirePath({ x: 0, y: 0, w: 100, h: 80, port: 50 }, { x: 300, y: 0, w: 100, h: 80 }, false);
  assert.match(d, /^M100,50 C/);
  assert.match(d, /298,19$/);
});

test("a tangle shows on the level that holds every box it names", () => {
  const smells = [{ kind: "cycle" as const, ids: ["api", "db"] }, { kind: "change together" as const, a: "cli", b: "db", count: 3 }, { kind: "unused" as const, a: "cli" }];
  assert.deepEqual(smellIds(smells[1]), ["cli", "db"]);
  assert.deepEqual(tanglesAt(smells, new Set(["api", "db"])), [smells[0]]);
  assert.deepEqual(tanglesAt(smells, new Set(["src", "cli"])), [smells[2]]);
});
