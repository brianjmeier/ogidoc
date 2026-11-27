import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EMPTY_MAP, checkMap, mapOf, mergeMaps, type FlowMap } from "./map.ts";
import type { Box, BoxEdge } from "./types.ts";

// The repo's map of abstractions, `.ogidoc/map.json`, shared in git by every session in
// the checkout and merged per branch. A session's boxes are its view of it: the same
// boxes with what the editor knows about each line, which the map file doesn't keep.
//
// Two sessions in one checkout each save what they changed since they last read the map,
// merged into what is on disk now, the way git merges a branch. An undo saves the same
// way, so it takes back only what this session did.

export const MAP_FILE = join(".ogidoc", "map.json");

/** A map file, checked; an empty map when there is none yet. Throws on one that isn't valid. */
export function readMap(path: string): FlowMap {
  const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  return text ? checkMap(JSON.parse(text)) : structuredClone(EMPTY_MAP);
}

export function mapStore(root: string) {
  const path = join(root, MAP_FILE);
  let lastRead = readMap(path);
  let written = "";

  return {
    path,

    load(): FlowMap {
      lastRead = readMap(path);
      return structuredClone(lastRead);
    },

    /** Write this session's boxes, keeping what others saved since it last read. */
    save(boxes: Box[], edges: BoxEdge[]) {
      const mine = mapOf(lastRead.title, boxes.map(({ scan, ...b }) => b), edges.filter((e) => e.kind === "call"));
      const merged = mergeMaps(lastRead, mine, readMap(path));
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
