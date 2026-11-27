import { writeFileSync } from "node:fs";
import { mergeMaps } from "./map.ts";
import { readMap } from "./map-store.ts";

// Git's merge driver for .ogidoc/map.json: a branch's map merges with another's box by
// box, the way their code merges, without line conflicts. `ogidoc` installs it in a
// checkout it commits to:
//
//   git config merge.ogidoc.driver "ogidoc merge-map %O %A %B"
//   .gitattributes: .ogidoc/map.json merge=ogidoc
//
// `base` is the map both sides started from, `ours` the one the result goes to.

/** Merge the three maps git hands over; false when one doesn't parse, so git says so. */
export function mergeMapFiles(base: string, ours: string, theirs: string, warn: (s: string) => void): boolean {
  try {
    writeFileSync(ours, JSON.stringify(mergeMaps(readMap(base), readMap(ours), readMap(theirs)), null, 1) + "\n");
    return true;
  } catch (e) {
    warn(`ogidoc: could not merge the map: ${(e as Error).message}`);
    return false;
  }
}
