import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeAgent, type Agent } from "../src/agents.ts";
import { fakeAgent, jsonReply, open, recording, repo } from "./support/index.ts";

// An app in a git checkout: an app that posts through its routes to a store.
function shop() {
  const r = repo();
  mkdirSync(join(r.dir, "src"));
  mkdirSync(join(r.dir, "lib"));
  writeFileSync(join(r.dir, "lib/store.js"), "export function save(x) { return x; }\nexport function load() { return []; }\n");
  writeFileSync(join(r.dir, "src/routes.js"), "import { save, load } from '../lib/store.js';\nexport function post(x) { return save(x); }\nexport const list = () => load();\n");
  writeFileSync(join(r.dir, "src/app.js"), "import { post } from './routes.js';\npost(1);\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "shop");
  return r;
}

const TOP = {
  summary: "a shop: routes in front of a store",
  boxes: [
    { id: "src", name: "app", pseudo: ["takes requests, hands them to the store"] },
    { id: "lib", name: "store", pseudo: ["keeps what was posted"], pins: [{ kind: "special case", text: "load ignores what save kept", file: "lib/store.js", line: 2 }] },
  ],
  add: [],
  edges: [],
};

// Says what it was asked to describe, and takes turns as `turns` says.
function describer(said: Record<string, object>, turns: object[] = [{ plan: [{ text: "x", status: "built" }], steps: [] }], touch?: (cwd: string) => void): Agent & { prompts: string[] } {
  let n = 0;
  return recording(fakeAgent("fake", async ({ prompt, cwd }) => {
    const at = /^# Say what (?:`([^`]+)`|the top)/m.exec(prompt);
    if (at) {
      touch?.(cwd);
      return jsonReply(said[at[1] ?? ""]);
    }
    return jsonReply(turns[Math.min(n++, turns.length - 1)]);
  }));
}

const onDisk = (dir: string) => JSON.parse(readFileSync(join(dir, ".ogidoc/map.json"), "utf8"));

test("describing the top of the map names its boxes and says what they do, in a commit of its own", async () => {
  const { dir, log } = shop();
  const agent = describer({ "": TOP });
  const { session: s, view } = open(dir, { agent });
  await s.describe();
  assert.equal(view().described?.summary, "a shop: routes in front of a store");
  const lib = view().boxes.find((b) => b.id === "lib")!;
  assert.deepEqual([lib.name, lib.status, lib.lines.map((l) => [l.text, l.by])], ["store", "built", [["keeps what was posted", "a"]]]);
  assert.equal(lib.pins?.[0].kind, "special case");
  assert.match(agent.prompts[0], /- `lib`: \d+ lines, used by 1/, "the agent is told what the scan read");
  assert.equal(log()[0], "ogidoc: describe the map");
  assert.deepEqual(onDisk(dir).nodes.map((n: { name: string }) => n.name).sort(), ["app", "store"]);

  await s.pass({ text: "x" });
  assert.doesNotMatch(agent.prompts[1], /box lib|In box lib/, "what a describe said is not the person's change");
});

test("describing a file adds the functions that matter in it, calling each other", async () => {
  const { dir } = shop();
  const file = {
    summary: "routes",
    boxes: [{ id: "src/routes.js", pseudo: ["post(x) -> save(x)", "list() -> load()"] }],
    add: [
      { id: "src/routes.js#post", parent: "src/routes.js", name: "post", pseudo: ["save(x)"], code: [{ file: "src/routes.js", line: 2, symbol: "post" }] },
      { id: "src/routes.js#list", parent: "src/routes.js", name: "list", pseudo: ["load()"] },
    ],
    edges: [{ from: "src/routes.js#list", to: "src/routes.js#post", label: "after" }],
  };
  const { session: s } = open(dir, { agent: describer({ src: { summary: "", boxes: [], add: [], edges: [] }, "src/routes.js": file }) });
  await s.describe({ id: "src/routes.js" });
  const map = s.map();
  assert.deepEqual(map.boxes.filter((b) => b.parent === "src/routes.js").map((b) => b.id), ["src/routes.js#post", "src/routes.js#list"]);
  assert.deepEqual(map.boxes.find((b) => b.id === "src/routes.js#list")!.code, [{ file: "src/routes.js" }], "a function without a line points at its file");
  assert.ok(map.edges.some((e) => e.from === "src/routes.js#list" && e.to === "src/routes.js#post" && e.kind === "call"));
});

test("a describe only reads: whatever it changes in the code goes back, and the person's own changes stay", async () => {
  const { dir } = shop();
  writeFileSync(join(dir, "src/app.js"), "// the person's work in progress\n");
  const agent = describer({ "": TOP }, undefined, (cwd) => {
    writeFileSync(join(cwd, "lib/store.js"), "// rewritten by a reader\n");
    writeFileSync(join(cwd, "lib/new.js"), "// made by a reader\n");
  });
  const { session: s, view } = open(dir, { agent });
  await s.describe();
  assert.match(readFileSync(join(dir, "lib/store.js"), "utf8"), /export function save/);
  assert.equal(existsSync(join(dir, "lib/new.js")), false);
  assert.equal(readFileSync(join(dir, "src/app.js"), "utf8"), "// the person's work in progress\n");
  assert.equal(view().described?.error, undefined);
});

test("a describe and a turn take the pen in turn, and undo takes a describe back", async () => {
  const { dir, log } = shop();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const agent = fakeAgent("fake", async ({ prompt }) => {
    if (prompt.startsWith("# Say what")) {
      await held;
      return jsonReply(TOP);
    }
    return jsonReply({ plan: [{ text: "x", status: "built" }], steps: [] });
  });
  const { session: s, view } = open(dir, { agent });
  const describing = s.describe();
  assert.deepEqual(view().describing, { id: null });
  await assert.rejects(() => s.pass({ text: "x" }), /busy|turn/);
  assert.throws(() => s.describe({ id: "lib" }), /busy/);
  release();
  await describing;
  assert.equal(view().describing, null);
  assert.equal(view().boxes.find((b) => b.id === "lib")?.name, "store");

  s.undo();
  assert.equal(view().boxes.find((b) => b.id === "lib"), undefined);
  assert.match(log()[0], /undo/);
  assert.throws(() => s.describe({ id: "nope" }), /no box "nope"/);
});

test("the mock agent plays describes from its script without using up a turn", async () => {
  const { dir } = shop();
  const script = join(dir, "..", `script-${Date.now()}.json`);
  writeFileSync(script, JSON.stringify({ turns: [{ reply: { plan: [{ text: "x", status: "built" }], steps: [] } }], describe: { "": TOP } }));
  const agent = makeAgent("mock", { env: {}, script, sleep: async () => {} });
  const { session: s, view } = open(dir, { agent });
  await s.describe();
  assert.equal(view().boxes.find((b) => b.id === "src")?.name, "app");
  await s.pass({ text: "x" });
  assert.equal(view().turn, 2);
});
