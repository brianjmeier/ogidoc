#!/usr/bin/env node
// Ogidoc's sessions on one pseudocode plan, and git's merge driver for the map.
if (process.argv[2] === "merge-map") {
  // Git runs this to merge .ogidoc/map.json; see src/merge-map.ts.
  const { mergeMapFiles } = await import("../src/merge-map.ts");
  const [base, ours, theirs] = process.argv.slice(3);
  process.exitCode = mergeMapFiles(base, ours, theirs, (s) => console.error(s)) ? 0 : 1;
} else await import("./plan.ts");
