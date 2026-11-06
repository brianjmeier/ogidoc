import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkMap, intentOf, type FlowMap } from "./map.ts";
import { parseReply, parseScope } from "./prompt.ts";

// The task map the agent drew in the recorded demo session: the plan is on it.
const plan = (): FlowMap => checkMap(JSON.parse(readFileSync(new URL("./demo/turns/frame/map.json", import.meta.url), "utf8")));

test("the demo's task map checks out, with the plan on it", () => {
  const m = plan();
  assert.ok(m.nodes.length > 10);
  assert.ok(m.flows.every((f) => f.steps.length > 1));
  const follow = m.nodes.find((n) => n.id === "links.follow")!;
  assert.equal(follow.status, "stale");
  assert.ok(follow.was && follow.was.length < follow.pseudo.length);
  assert.ok(m.nodes.some((n) => n.status === "proposal"));
});

test("a built node keeps no was", () => {
  const m = checkMap({ title: "x", nodes: [{ id: "a", name: "a", kind: "step", pseudo: ["new"], status: "built", was: ["old"] }], edges: [], flows: [] });
  assert.equal(m.nodes[0].was, undefined);
});

test("a map with a dangling parent is refused", () => {
  assert.throws(() => checkMap({ title: "x", nodes: [{ id: "a", name: "a", kind: "step", pseudo: [], parent: "nope" }], edges: [], flows: [] }), /parent/);
});

test("the person's edits read as a diff, not prose", () => {
  const before = plan();
  const draft = structuredClone(before);
  const follow = draft.nodes.find((n) => n.id === "links.follow")!;
  follow.pseudo = follow.pseudo.map((l) => l.replace("410", "404"));
  draft.nodes.push({ id: "rateLimit", name: "rateLimit", kind: "step", parent: null, pseudo: ["10 a minute per ip"], by: "human" });
  draft.edges.push({ from: "routes", to: "rateLimit", by: "human" });
  draft.edges[0].removed = true;
  draft.nodes.find((n) => n.id === "links.stats")!.removed = true;
  const intent = intentOf(before, draft, ["links.follow"]);
  assert.match(intent, /CHANGE node links.follow\n/);
  assert.match(intent, /\n {2}- .*410.*\n {2}\+ .*404/);
  assert.match(intent, /NEW node rateLimit "rateLimit" \(step\)\n {2}\+ 10 a minute per ip/);
  assert.match(intent, /NEW edge routes → rateLimit/);
  assert.match(intent, new RegExp(`REMOVE edge ${before.edges[0].from} → ${before.edges[0].to}`));
  assert.match(intent, /REMOVE node links.stats/);
  assert.match(intent, /selected: links.follow/);
});

test("picking another way says so", () => {
  const before = plan();
  const withWays = before.nodes.find((n) => n.ways?.length)!;
  const draft = structuredClone(before);
  draft.nodes.find((n) => n.id === withWays.id)!.pseudo = withWays.ways![0].pseudo;
  assert.match(intentOf(before, draft, []), new RegExp(`CHANGE node ${withWays.id.replace(".", "\\.")}: picked way 2 of`));
});

test("no edits means go on: build the plan", () => {
  assert.match(intentOf(plan(), plan(), []), /no edits/);
});

test("a scoping reply: words, then the verdict", () => {
  const r = parseScope('Links live in `store`.\n\n```json\n{"ready": true, "title": "Expire links", "refs": [{"file": "src/store.js", "line": 5}, {"nope": 1}], "brief": "store createdAt"}\n```');
  assert.deepEqual(r, { text: "Links live in `store`.", ready: true, title: "Expire links", brief: "store createdAt", refs: [{ file: "src/store.js", line: 5 }] });
  assert.equal(parseScope("no block at all").ready, false);
});

test("the reply is the last json block", () => {
  assert.deepEqual(parseReply('done\n```json\n{"summary":"s","changed":["a"]}\n```'), { summary: "s", changed: ["a"] });
});
