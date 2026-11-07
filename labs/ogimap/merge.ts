#!/usr/bin/env node
// Git's merge driver for .ogimap/map.json: merges a branch's map with another's by node,
// so a Worker's map rebases onto main's the way its code does, without line conflicts.
//
//   git config merge.ogimap.driver "node <this file> %O %A %B"
//   .gitattributes: .ogimap/map.json merge=ogimap
//
// %O is the map both sides started from, %A ours (the result goes here), %B theirs.

import { readFileSync, writeFileSync } from "node:fs";
import { checkMap, mergeMaps, type FlowMap } from "./map.ts";

const EMPTY: FlowMap = { title: "", nodes: [], edges: [], flows: [] };

const read = (path: string): FlowMap => {
  const text = readFileSync(path, "utf8").trim();
  return text ? checkMap(JSON.parse(text)) : EMPTY;
};

const [base, ours, theirs] = process.argv.slice(2);
try {
  writeFileSync(ours, JSON.stringify(mergeMaps(read(base), read(ours), read(theirs)), null, 1) + "\n");
} catch (e) {
  // A map that doesn't parse can't be merged by node: leave git to say so.
  console.error(`ogimap: could not merge the map: ${(e as Error).message}`);
  process.exit(1);
}
