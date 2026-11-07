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

// ---------- the map grows task by task ----------

import { driftOf, indexOf, mergeRegion, regionIds, regionOf } from "./map.ts";

const tiny = (): FlowMap =>
  checkMap({
    title: "shop",
    nodes: [
      { id: "cart", name: "cart", kind: "module", pseudo: ["holds items"] },
      { id: "cart.add", name: "add", parent: "cart", kind: "step", pseudo: ["push item"], code: [{ file: "src/cart.js", line: 3 }] },
      { id: "cart.total", name: "total", parent: "cart", kind: "step", pseudo: ["sum prices"], code: [{ file: "src/cart.js", line: 9 }] },
      { id: "pay", name: "pay", kind: "module", pseudo: ["charges cards"] },
      { id: "pay.charge", name: "charge", parent: "pay", kind: "step", pseudo: ["stripe.charge(total)"], code: [{ file: "src/pay.js" }] },
      { id: "auth", name: "auth", kind: "module", pseudo: ["who you are"] },
      { id: "auth.login", name: "login", parent: "auth", kind: "step", pseudo: ["check password"] },
    ],
    edges: [
      { from: "pay.charge", to: "cart.total", label: "amount" },
      { from: "auth.login", to: "cart.add" },
    ],
    flows: [{ id: "checkout", name: "check out", steps: ["cart.total", "pay.charge"] }, { id: "signin", name: "sign in", steps: ["auth.login", "cart.add"] }],
  });

test("a region is the seeds, what holds them, what they hold, and what they call or are called by", () => {
  assert.deepEqual([...regionIds(tiny(), ["pay.charge"])].sort(), ["cart", "cart.total", "pay", "pay.charge"]);
  assert.deepEqual([...regionIds(tiny(), ["pay"])].sort(), ["pay", "pay.charge"]);
  const r = regionOf(tiny(), regionIds(tiny(), ["pay.charge"]));
  assert.deepEqual(r.edges, [{ from: "pay.charge", to: "cart.total", label: "amount" }]);
  assert.deepEqual(r.flows.map((f) => f.id), ["checkout"]);
});

test("merging a region changes only the region: replaced, added, deleted, and the rest exactly as it was", () => {
  const before = tiny();
  const sent = regionIds(before, ["pay.charge"]);
  const back = structuredClone(regionOf(before, sent));
  back.nodes = back.nodes.filter((n) => n.id !== "cart.total"); // deleted
  back.nodes.find((n) => n.id === "pay.charge")!.pseudo = ["stripe.charge(cart.sum)"]; // replaced
  back.nodes.push({ id: "cart.sum", name: "sum", parent: "cart", kind: "step", pseudo: ["sum prices, minus discounts"], status: "proposal" }); // added
  back.edges = [{ from: "pay.charge", to: "cart.sum" }];
  back.flows = [{ id: "checkout", name: "check out", steps: ["cart.sum", "pay.charge"] }];
  const after = mergeRegion(before, sent, back);
  assert.equal(after.nodes.some((n) => n.id === "cart.total"), false);
  assert.deepEqual(after.nodes.find((n) => n.id === "pay.charge")!.pseudo, ["stripe.charge(cart.sum)"]);
  assert.equal(after.nodes.find((n) => n.id === "cart.sum")!.parent, "cart");
  for (const id of ["auth", "auth.login", "cart.add"]) assert.deepEqual(after.nodes.find((n) => n.id === id), before.nodes.find((n) => n.id === id));
  assert.deepEqual(after.edges, [{ from: "auth.login", to: "cart.add" }, { from: "pay.charge", to: "cart.sum" }]);
  assert.deepEqual(after.flows.map((f) => [f.id, f.steps]), [["signin", ["auth.login", "cart.add"]], ["checkout", ["cart.sum", "pay.charge"]]]);
});

test("a first region is the whole map, and a framing region (nothing sent) deletes nothing", () => {
  const first = mergeRegion(null, new Set(), { title: "shop", nodes: [{ id: "a", name: "a", kind: "step", pseudo: ["x"] }], edges: [], flows: [] });
  assert.deepEqual(first.nodes.map((n) => n.id), ["a"]);
  const framed = mergeRegion(tiny(), new Set(), { title: "", nodes: [{ id: "auth.logout", name: "logout", parent: "auth", kind: "step", pseudo: ["forget session"], status: "proposal" }], edges: [], flows: [] });
  assert.equal(framed.nodes.length, tiny().nodes.length + 1);
  assert.equal(framed.title, "shop");
});

test("a region that points at a parent nowhere in the map is refused", () => {
  assert.throws(() => mergeRegion(tiny(), new Set(), { title: "", nodes: [{ id: "x", name: "x", parent: "nowhere", kind: "step", pseudo: [] }], edges: [], flows: [] }), /parent nowhere/);
});

test("nodes whose code changed are drift, and the index says so", () => {
  const drift = driftOf(tiny(), new Set(["src/cart.js"]));
  assert.deepEqual(drift, ["cart.add", "cart.total"]);
  const index = indexOf(tiny(), drift);
  assert.match(index, /- cart\.add \(in cart\): push item \[src\/cart\.js\] — code changed since mapped/);
  assert.match(index, /- pay\.charge \(in pay\): stripe\.charge\(total\) \[src\/pay\.js\]$/m);
});
