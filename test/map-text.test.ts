import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoIO } from "../src/scan-repo.ts";
import { repoMap } from "../src/repo-map.ts";
import { levelText } from "../src/map-text.ts";
import { repo } from "./support/index.ts";

// The map as an agent reads it at a terminal, one level at a time.

// An app that posts through its routes to a store, and an old helper nothing imports.
function shop() {
  const r = repo();
  mkdirSync(join(r.dir, "src"));
  mkdirSync(join(r.dir, "lib"));
  writeFileSync(join(r.dir, "lib/store.js"), "export function save(x) { return x; }\nexport function load() { return []; }\n");
  writeFileSync(join(r.dir, "lib/old.js"), "export function legacy() { return 1; }\n");
  writeFileSync(join(r.dir, "src/routes.js"), "import { save, load } from '../lib/store.js';\nexport function post(x) { return save(x); }\nexport const list = () => load();\n");
  writeFileSync(join(r.dir, "src/app.js"), "import { post } from './routes.js';\npost(1);\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "shop");
  return repoMap(r.dir, { io: repoIO(r.dir), hashes: (files) => new Map(files.map((f) => [f, null])) })!;
}

test("the top of the map lists each box with what the scan read, and the arrows between them", () => {
  const text = levelText(shop().view, null);
  assert.match(text, /^lib {2}· {2}2 files · 3 lines · used by 1 · uses 0 · 2 inside · 1 tangle inside$/m);
  assert.match(text, /^ {2}exports: (save, load|load, save)$/m);
  assert.match(text, /^ {2}not described yet$/m);
  assert.match(text, /^ {2}src → lib: save, load$/m);
  assert.doesNotMatch(text, /^Tangles:/m, "a tangle inside a box is read by opening it");
  assert.match(text, /ogidoc map lib/, "it says how to go deeper");
});

test("inside a box: its files, the tangles among them, and arrows to the boxes outside", () => {
  const text = levelText(shop().view, "lib");
  assert.match(text, /^\S+ › lib$/m);
  assert.match(text, /^old\.js {2}lib\/old\.js {2}· {2}file · 1 line/m);
  assert.match(text, /^ {2}unused: old\.js, exports names nothing in the code imports$/m);
  assert.match(text, /^ {2}src \(outside\) → store\.js: save, load$/m);
});

test("what was said about a box shows as its pseudocode, and code changed since is flagged", () => {
  const { view } = shop();
  const said = { ...view, boxes: view.boxes.map((b) => (b.id === "lib" ? { ...b, lines: [{ text: "keeps what the app posts" }] } : b)) };
  const text = levelText(said, null, ["lib"]);
  assert.match(text, /^ {2}\| keeps what the app posts$/m);
  assert.match(text, /^ {2}its code changed since it was described$/m);
  assert.match(levelText(said, "lib"), /^\| keeps what the app posts$/m, "opening it shows it under the breadcrumb");
});

test("a box the map doesn't have is refused, with where to look", () => {
  assert.throws(() => levelText(shop().view, "nope"), /The map has no box "nope"\. Run `ogidoc map`/);
});
