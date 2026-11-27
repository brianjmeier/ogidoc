import { readFileSync, writeFileSync } from "node:fs";
import { checkMap, mergeMaps, type FlowMap } from "./map.ts";

// Git's merge driver for .ogidoc/map.json: a branch's map merges with another's box by
// box, the way their code merges, without line conflicts. `ogidoc` installs it in a
// checkout it commits to:
//
//   git config merge.ogidoc.driver "ogidoc merge-map %O %A %B"
//   .gitattributes: .ogidoc/map.json merge=ogidoc
//
// `base` is the map both sides started from, `ours` the one the result goes to.

const EMPTY: FlowMap = { title: "", nodes: [], edges: [], flows: [] };

function read(path: string): FlowMap {
  const text = readFileSync(path, "utf8").trim();
  return text ? checkMap(JSON.parse(text)) : EMPTY;
}

/** Merge the three maps git hands over; false when one doesn't parse, so git says so. */
export function mergeMapFiles(base: string, ours: string, theirs: string, warn: (s: string) => void): boolean {
  try {
    writeFileSync(ours, JSON.stringify(mergeMaps(read(base), read(ours), read(theirs)), null, 1) + "\n");
    return true;
  } catch (e) {
    warn(`ogidoc: could not merge the map: ${(e as Error).message}`);
    return false;
  }
}
