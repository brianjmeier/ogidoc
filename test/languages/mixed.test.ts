import { test } from "node:test";
import assert from "node:assert/strict";
import { arrows, scanOf } from "./scan-of.ts";

test("a repo in two languages maps both, each by its own rules, with no arrow between them", () => {
  const sk = scanOf({
    "web/src/app.ts": `import { get } from "./api"\nget()`,
    "web/src/api.ts": `export const get = () => fetch("/api")`,
    "server/main.go": `package main\n\nimport "example.com/shop/server/store"\n\nfunc main() { store.Open() }`,
    "server/store/store.go": `package store\n\nfunc Open() {}`,
  }, { "server/go.mod": "module example.com/shop/server\n" });
  assert.deepEqual(arrows(sk), ["server/main.go → server/store: Open", "web/src/app.ts → web/src/api.ts: get"]);
  assert.deepEqual(sk.nodes.filter((n) => n.parent === null).map((n) => n.id).sort(), ["server", "web/src"]);
});
