import { test } from "node:test";
import assert from "node:assert/strict";
import { importsOf } from "../../src/languages/javascript.ts";
import { arrows, scanOf } from "./scan-of.ts";

test("javascript: import text inside a string or a template is not an import", () => {
  const got = importsOf(`const fixture = 'import { decode } from "./a"'\nconst t = \`import x from "./b"\`\nimport { real } from "./c"`);
  assert.deepEqual(got.map((i) => i.spec), ["./c"]);
});

test("javascript: type-only imports are marked, and a loop through them is no cycle", () => {
  const sk = scanOf({
    "a/x.ts": `import type { Y } from "../b/y"\nexport const x = 1`,
    "b/y.ts": `import { x } from "../a/x"\nexport type Y = number`,
  });
  assert.deepEqual(sk.edges.map((e) => [e.from, !!e.typeOnly]).sort(), [["a/x.ts", true], ["b/y.ts", false]]);
  assert.equal(sk.smells.filter((s) => s.kind === "cycle").length, 0);
});

test("javascript: a test file is an importer, a missing file is unread, a stylesheet is neither", () => {
  const sk = scanOf({
    "src/fake.ts": `export const fake = 1`,
    "src/app.ts": `import "./app.css"\nimport { gone } from "./moved"\nexport const app = 1`,
    "src/app.test.ts": `import { fake } from "./fake"\nimport { app } from "./app"`,
  }, {}, ["src/app.css"]);
  assert.deepEqual(arrows(sk), []);
  assert.deepEqual(sk.smells.filter((s) => s.kind === "unused"), [], "the test imports both");
  assert.deepEqual(sk.unread.imports, [{ from: "src/app.ts", spec: "./moved" }]);
});
