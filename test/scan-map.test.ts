import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanRepo, type RepoIO } from "../src/scan-repo.ts";
import { open, recording, repo, replying } from "./support/index.ts";

// A small app in a git checkout: an app that posts through its routes to a store.
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

const onDisk = (dir: string) => JSON.parse(readFileSync(join(dir, ".ogidoc/map.json"), "utf8"));

test("the scan is the starting map: folders and files as boxes, imports as arrows", () => {
  const { dir } = shop();
  const { session: s, view } = open(dir, { commit: false });
  const map = s.map();
  const store = map.boxes.find((b) => b.id === "lib/store.js")!;
  assert.equal(store.parent, "lib");
  assert.equal(store.scan?.kind, "file");
  assert.deepEqual(store.scan?.seam.map((x) => x.name).sort(), ["load", "save"]);
  assert.deepEqual(map.edges.filter((e) => e.kind === "import").map((e) => [e.from, e.to, e.symbols]), [["src/app.js", "src/routes.js", ["post"]], ["src/routes.js", "lib/store.js", ["save", "load"]]]);
  assert.deepEqual(view().boxes, [], "nothing is the session's own until someone says something about it");
});

test("a box the agent describes joins the map file with the folders holding it, without the scan's numbers", async () => {
  const { dir } = shop();
  const agent = replying("fake", [{
    plan: [{ text: "keep things", status: "built" }],
    boxes: [{ id: "lib/store.js", name: "store", lines: ["save(x), load() -> everything saved"], status: "built" }],
    steps: [],
  }]);
  const { session: s, view } = open(dir, { agent });
  await s.pass({ text: "keep things" });
  assert.deepEqual(view().boxes.map((b) => [b.id, b.parent]).sort(), [["lib", null], ["lib/store.js", "lib"]]);
  const nodes = onDisk(dir).nodes.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  assert.deepEqual(nodes.map((n: { id: string }) => n.id), ["lib", "lib/store.js"]);
  assert.equal(nodes[1].size, undefined, "the next scan finds the numbers again");
  assert.deepEqual(nodes[1].code, [{ file: "lib/store.js" }], "a file box points at its file");
  assert.equal(s.map().boxes.find((b) => b.id === "lib/store.js")!.scan?.kind, "file", "on the map it still has them");
});

test("the person draws an arrow to code the scan found, and can't cross code out from the map", () => {
  const { dir } = shop();
  const { session: s } = open(dir, { commit: false });
  s.editMap({ edits: [{ op: "add", key: "k", name: "audit", parent: "lib", lines: ["log every save"] }, { op: "connect", from: "lib/store.js", to: "k" }] });
  assert.ok(s.map().edges.some((e) => e.from === "lib/store.js" && e.to === "audit" && e.kind === "call"));
  assert.throws(() => s.editMap({ edits: [{ op: "remove", id: "src/routes.js" }] }), /code the scan found/);
});

test("the turn prompt reads the scanned map and the person's arrow to it", async () => {
  const { dir } = shop();
  const agent = recording(replying("fake", [{ plan: [{ text: "audit saves", status: "built" }], steps: [] }]));
  const { session: s } = open(dir, { agent, commit: false });
  await s.pass({ text: "audit saves" });
  s.editMap({ edits: [{ op: "add", key: "k", name: "audit", parent: "lib", lines: ["log every save"] }, { op: "connect", from: "lib/store.js", to: "k" }] });
  await s.pass();
  assert.match(agent.prompts[1], /"id":"src\/routes.js"/);
  assert.match(agent.prompts[1], /\+ box audit "audit" inside lib/);
  assert.match(agent.prompts[1], /\+ arrow lib\/store.js → audit/);
  assert.doesNotMatch(agent.prompts[1], /\+ box lib /, "the scan's boxes the edit touched are not the person's new boxes");
});

test("git merges two branches' maps box by box, through ogidoc's merge driver", async () => {
  const { dir, git } = shop();
  const say = (lines: string[]) => replying("fake", [{ plan: [{ text: "x", status: "built" }], boxes: [{ id: "lib/store.js", lines, status: "built" }], steps: [] }]);
  await open(dir, { agent: say(["saves things"]) }).session.pass({ text: "x" });
  git("checkout", "-qb", "worker");
  await open(dir, { name: "w", agent: replying("fake", [{ plan: [{ text: "y", status: "built" }], boxes: [{ id: "src/routes.js", lines: ["post and list"], status: "built" }], steps: [] }]) }).session.pass({ text: "y" });
  git("checkout", "-q", "-");
  await open(dir, { agent: say(["saves things, and loads them"]) }).session.pass();
  git("merge", "-q", "--no-edit", "worker");
  const pseudo = Object.fromEntries(onDisk(dir).nodes.map((n: { id: string; pseudo: string[] }) => [n.id, n.pseudo.join()]));
  assert.equal(pseudo["lib/store.js"], "saves things, and loads them");
  assert.equal(pseudo["src/routes.js"], "post and list");
});

test("scanning reads what git tracks, follows its links, and gives up outside a checkout", () => {
  const files: Record<string, string> = { "a.js": "import { b } from './lib/b.js';\n", "lib/b.js": "export const b = 1;\n" };
  const io: RepoIO = {
    git: (args) => (args[0] === "ls-files" ? ["100644 x 0\ta.js", "100644 x 0\tlib/b.js", "120000 x 0\tlink"].join("\0") : args[0] === "log" ? "" : null),
    read: (p) => files[p] ?? null,
    readlink: () => "lib",
  };
  const sk = scanRepo("app", io)!;
  assert.deepEqual(sk.edges.map((e) => [e.from, e.to]), [["a.js", "lib/b.js"]]);
  assert.equal(scanRepo("app", { ...io, git: () => null }), null);
});
