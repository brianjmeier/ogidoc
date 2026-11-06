import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkMap, intentOf, type FlowMap } from "./map.ts";
import { parseReply } from "./prompt.ts";

const demo = (): FlowMap => checkMap(JSON.parse(readFileSync(new URL("./demo/map.json", import.meta.url), "utf8")));

test("the demo map checks out", () => {
  const m = demo();
  assert.ok(m.nodes.length > 10);
  assert.ok(m.flows.every((f) => f.steps.length > 1));
});

test("a map with a dangling parent is refused", () => {
  assert.throws(() => checkMap({ title: "x", nodes: [{ id: "a", name: "a", kind: "step", pseudo: [], parent: "nope" }], edges: [], flows: [] }), /parent/);
});

test("the person's edits read as a diff, not prose", () => {
  const before = demo();
  const draft = structuredClone(before);
  const make = draft.nodes.find((n) => n.id === "codes.makeCode")!;
  make.pseudo = ["6 × random char from ALPHABET", "retry while store.find(code) exists"];
  draft.nodes.push({ id: "rateLimit", name: "rateLimit", kind: "step", parent: null, pseudo: ["10 a minute per ip"], by: "human" });
  draft.edges.push({ from: "routes", to: "rateLimit", by: "human" });
  draft.edges.find((e) => e.to === "store.countVisit")!.removed = true;
  draft.nodes.find((n) => n.id === "links.stats")!.removed = true;
  const intent = intentOf(before, draft, ["codes.makeCode"]);
  assert.match(intent, /CHANGE node codes.makeCode\n {4}6 × random char from ALPHABET\n {2}- → code \(no uniqueness check\)\n {2}\+ retry while store.find\(code\) exists/);
  assert.match(intent, /NEW node rateLimit "rateLimit" \(step\)\n {2}\+ 10 a minute per ip/);
  assert.match(intent, /NEW edge routes → rateLimit/);
  assert.match(intent, /REMOVE edge links.follow → store.countVisit/);
  assert.match(intent, /REMOVE node links.stats/);
  assert.match(intent, /selected: codes.makeCode/);
});

test("picking another way says so", () => {
  const before = demo();
  before.nodes[0].ways = [{ pseudo: ["the other way"] }];
  const draft = structuredClone(before);
  draft.nodes[0].pseudo = ["the other way"];
  assert.match(intentOf(before, draft, []), /picked way 2 of 2/);
});

test("no edits means go on", () => {
  assert.match(intentOf(demo(), demo(), []), /no edits/);
});

test("the reply is the last json block", () => {
  assert.deepEqual(parseReply('done\n```json\n{"summary":"s","changed":["a"]}\n```'), { summary: "s", changed: ["a"] });
});
