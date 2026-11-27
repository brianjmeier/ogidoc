import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkMap, mapOf, mergeMaps, type FlowMap } from "./map.ts";
import type { Box, BoxEdge, MapOnDisk } from "./types.ts";

// The repo's map of abstractions, `.ogidoc/map.json`, shared in git by every session in
// the checkout and merged per branch. A session's boxes are its view of it: the same
// boxes with what the editor knows about each line, which the map file doesn't keep.
//
// Two sessions in one checkout each save what they changed since they last read the map,
// merged into what is on disk now, the way git merges a branch. An undo saves the same
// way, so it takes back only what this session did.

export const MAP_FILE = join(".ogidoc", "map.json");

const EMPTY: FlowMap = { title: "map", nodes: [], edges: [], flows: [] };

export type MapStore = ReturnType<typeof mapStore>;

export function mapStore(root: string) {
  const path = join(root, MAP_FILE);
  const read = (): FlowMap => (existsSync(path) ? checkMap(JSON.parse(readFileSync(path, "utf8"))) : structuredClone(EMPTY));
  let lastRead = read();
  let written = "";

  return {
    path,

    load(): MapOnDisk {
      lastRead = read();
      return fromFlowMap(lastRead);
    },

    /** Write this session's boxes, keeping what others saved since it last read. */
    save(boxes: Box[], edges: BoxEdge[]) {
      const mine = mapOf(lastRead.title, boxes, edges);
      const merged = mergeMaps(lastRead, mine, read());
      const text = JSON.stringify(merged, null, 1) + "\n";
      if (text !== written || !existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      written = text;
      lastRead = merged;
    },
  };
}

function fromFlowMap(m: FlowMap): MapOnDisk {
  return {
    boxes: m.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      parent: n.parent ?? null,
      text: n.pseudo.join("\n"),
      status: n.status === "built" || n.status === "blocked" ? n.status : "stale",
      ...(n.code && { code: n.code }),
      ...(n.seen && { seen: n.seen }),
      ...(n.pins && { pins: n.pins }),
    })),
    edges: m.edges.map(({ from, to, label, kind, symbols }) => ({ from, to, ...(label && { label }), kind: kind === "import" ? "import" : "call", ...(symbols && { symbols }) })),
  };
}
