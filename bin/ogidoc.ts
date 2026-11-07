#!/usr/bin/env node
// `ogidoc map …` is Ogimap: change an existing codebase by editing a flow map of it.
// Everything else is Ogidoc's sessions on one pseudocode plan.
if (process.argv[2] === "map") await import("../labs/ogimap/ogimap.ts");
else await import("./plan.ts");
