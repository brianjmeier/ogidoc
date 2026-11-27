import { test } from "node:test";
import assert from "node:assert/strict";
import { importsOf, OUTSIDE, scan } from "./scan.ts";

const f = (path: string, text = "") => ({ path, text });

test("imports keep the names they take, and skip commented-out ones", () => {
  const got = importsOf(`
import { a, type B, c as d } from "./x"
import def, { e } from "../y.js"
import * as ns from "pkg/sub"
export { f } from "./z"
// import { gone } from "./nope"
/* import { gone2 } from "./nope2" */
const lazy = await import("./later")
import "./side-effect"
`);
  assert.deepEqual(got, [
    { spec: "./x", symbols: ["a", "B", "c"] },
    { spec: "../y.js", symbols: ["e", "default"] },
    { spec: "pkg/sub", symbols: ["*"] },
    { spec: "./z", symbols: ["f"] },
    { spec: "./later", symbols: ["*"] },
    { spec: "./side-effect", symbols: ["*"] },
  ]);
});

// A small repo: an app that uses a package through an alias and through a relative path.
const repo = () => scan("demo", [
  f("apps/daemon/src/sessions/store.ts", `import { now } from "tend"\nexport const save = 1\nexport const load = 2`),
  f("apps/daemon/src/sessions/index.ts", `import { save, load } from "./store"\nimport { join } from "node:path"`),
  f("apps/daemon/src/boards/board.ts", `import { save } from "../sessions/store.js"\nimport React from "react"`),
  f("apps/daemon/src/boards/board.test.ts", `import { internal } from "../sessions/store"`),
  f("packages/tend/src/index.ts", `export const now = 0`),
  f("README.md", "# not code"),
  f("node_modules/x/index.js", "ignored"),
], { aliases: { tend: ["./packages/tend/src/index.ts"] } });

test("folders become boxes, a folder holding only one folder folds into it", () => {
  const s = repo();
  const top = s.nodes.filter((n) => n.parent === null).map((n) => n.id).sort();
  assert.deepEqual(top, [OUTSIDE, "apps/daemon/src", "packages/tend/src"]);
  assert.equal(s.nodes.find((n) => n.id === "apps/daemon/src")!.name, "apps/daemon/src");
  assert.equal(s.nodes.find((n) => n.id === "apps/daemon/src/sessions")!.parent, "apps/daemon/src");
});

test("arrows go file to file, through relative paths, aliases and .js for .ts", () => {
  const s = repo();
  const arrow = (from: string, to: string) => s.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(arrow("apps/daemon/src/boards/board.ts", "apps/daemon/src/sessions/store.ts")?.symbols, ["save"]);
  assert.deepEqual(arrow("apps/daemon/src/sessions/store.ts", "packages/tend/src/index.ts")?.symbols, ["now"]);
  assert.ok(arrow("apps/daemon/src/boards/board.ts", `${OUTSIDE}/react`));
  assert.ok(arrow("apps/daemon/src/sessions/index.ts", `${OUTSIDE}/node:*`));
});

test("a box's seam is what code outside it imports from it; tests don't count", () => {
  const s = repo();
  const seam = (id: string) => s.nodes.find((n) => n.id === id)!.seam.map((x) => x.name);
  // boards uses save; index.ts is inside sessions, so load is not part of the seam
  assert.deepEqual(seam("apps/daemon/src/sessions"), ["save"]);
  // the store file's own seam counts index.ts too
  assert.deepEqual(seam("apps/daemon/src/sessions/store.ts").sort(), ["load", "save"]);
  assert.deepEqual(seam("apps/daemon/src"), []);
  assert.deepEqual(seam("packages/tend/src/index.ts"), ["now"]);
  const boards = s.nodes.find((n) => n.id === "apps/daemon/src/boards")!;
  assert.equal(boards.files, 1);
  assert.equal(boards.tests, 1);
});

test("an import through a symlink lands on the file it points at", () => {
  const s = scan("links", [
    f("shared/lib/io.ts", "export const read = 1"),
    f("stations/fixers/entry.ts", `import { read } from "./lib/io"`),
  ], { links: { "stations/fixers/lib": "../../shared/lib" } });
  assert.deepEqual(s.edges.map((e) => [e.from, e.to]), [["stations/fixers/entry.ts", "shared/lib/io.ts"]]);
  assert.equal(s.unresolved, 0);
});

test("smells: a volatile import, two boxes that change together, unused and pass-through files", () => {
  const files = [
    f("core/rules.ts", `import { theme } from "../ui/theme"\nexport const rule = 1`),
    f("ui/theme.ts", `export const theme = 1`),
    f("billing/invoice.ts", `export const invoice = 1`),
    f("mail/send.ts", `export const send = 1`),
    f("mail/index.ts", `export {\n  send,\n} from "./send"\nexport * from "./other"`),
    f("app.ts", `import { rule } from "./core/rules"\nimport { send } from "./mail/index"\nimport { invoice } from "./billing/invoice"`),
  ];
  const history = [
    ...Array.from({ length: 6 }, () => ["ui/theme.ts"]),
    ["core/rules.ts"],
    ...Array.from({ length: 3 }, () => ["billing/invoice.ts", "mail/send.ts"]),
  ];
  const s = scan("smells", files, { history });
  const has = (kind: string, a: string, b?: string) => s.smells.some((x) => x.kind === kind && "a" in x && x.a === a && (b === undefined || ("b" in x && x.b === b)));
  assert.ok(has("volatile import", "core", "ui"), "core imports the ui, which changes six times as often");
  assert.ok(has("change together", "billing", "mail"), "billing and mail change in the same commits, with no import");
  assert.ok(has("pass-through", "mail/index.ts"));
  assert.ok(!has("unused", "mail/send.ts"), "send is imported by the pass-through");
  assert.ok(!s.smells.some((x) => x.kind === "change together" && "a" in x && x.a === "core"), "rules changed alone");
  assert.equal(s.nodes.find((n) => n.id === "ui")!.churn, 6);
});

test("boxes that import each other round in a loop are a cycle; each box knows who uses it", () => {
  const s = scan("loop", [
    f("a/x.ts", `import { y } from "../b/y"\nexport const x = 1`),
    f("b/y.ts", `import { z } from "../c/z"\nexport const y = 1`),
    f("c/z.ts", `import { x } from "../a/x"\nexport const z = 1`),
    f("d/w.ts", `import { x } from "../a/x"`),
  ]);
  assert.deepEqual(s.smells.filter((x) => x.kind === "cycle").map((x) => "ids" in x && x.ids), [["a", "b", "c"]]);
  const a = s.nodes.find((n) => n.id === "a")!;
  assert.deepEqual([a.usedBy, a.uses], [2, 1]);
});
