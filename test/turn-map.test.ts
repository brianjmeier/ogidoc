import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromReply, whyNotATurn, type Plan } from "../src/plan.ts";
import { buildPrompt, parseReply, readAgentFile } from "../src/prompt.ts";
import type { Box, Reply } from "../src/types.ts";
import { jsonReply, open, recording, repo, replying } from "./support/index.ts";

const box = (id: string, lines: string[], more: Partial<Box> = {}): Box => ({ id, name: id, parent: null, lines: lines.map((text) => ({ text, by: "a" as const })), status: "built", code: [{ file: `src/${id}.js` }], ...more });
const plan = (boxes: Box[], edges: Plan["edges"] = []): Plan => ({ lines: [{ text: "app", by: "h" }], boxes, edges, threads: [], choices: [] });
const reply = (o: object): Reply => parseReply(jsonReply({ plan: [{ text: "app" }], ...o }));

test("a reply names only the boxes it changed; every other box stays as it was", () => {
  const before = plan([box("cart", ["holds items"]), box("pay", ["charges"], { parent: "cart" })], [{ from: "pay", to: "cart", kind: "call" }]);
  const { plan: after, boxChanges } = fromReply(before, reply({ boxes: [{ id: "cart", lines: ["holds items", "and their prices"], status: "built" }] }), 2);
  assert.deepEqual(after.boxes.map((b) => [b.id, b.lines.length]), [["cart", 2], ["pay", 1]]);
  assert.deepEqual(boxChanges, { cart: "changed" });
  assert.deepEqual(after.boxes[0].code, [{ file: "src/cart.js" }], "what the reply leaves out of a box stays");
  assert.equal(after.boxes[1].parent, "cart");
  assert.deepEqual(after.edges, before.edges, "a box that doesn't say what it uses keeps its arrows");
});

test("a reply that leaves out a box's name keeps the name the map has", () => {
  const before = plan([box("src/links.js", ["shorten, follow"], { name: "links" })]);
  const { plan: after } = fromReply(before, reply({ boxes: [{ id: "src/links.js", lines: ["shorten, follow, expire"], status: "built" }] }), 2, [box("src/store.js", [], { name: "store.js" })]);
  assert.equal(after.boxes[0].name, "links");
  const { plan: scanned } = fromReply(before, reply({ boxes: [{ id: "src/store.js", lines: ["keeps links"], status: "built" }] }), 2, [box("src/store.js", [], { name: "store.js" })]);
  assert.equal(scanned.boxes.find((b) => b.id === "src/store.js")!.name, "store.js", "a scanned box keeps the scan's name");
});

test("a reply can add a box inside another, rewire it, and take one off the map", () => {
  const before = plan([box("cart", ["holds items"]), box("pay", ["charges"]), box("old", ["gone soon"], { parent: "cart" })], [{ from: "pay", to: "old", kind: "call" }]);
  const { plan: after, boxChanges } = fromReply(before, reply({
    boxes: [
      { id: "src/cart.js#total", name: "total", parent: "cart", lines: ["sum prices"], status: "built", code: [{ file: "src/cart.js", line: 9, symbol: "total" }] },
      { id: "pay", lines: ["charges the total"], status: "built", uses: ["src/cart.js#total"] },
      { id: "lost", parent: "nowhere", lines: ["x"], status: "stale" },
    ],
    removed: ["old"],
  }), 2);
  assert.deepEqual(after.boxes.map((b) => [b.id, b.parent]), [["cart", null], ["pay", null], ["src/cart.js#total", "cart"], ["lost", null]]);
  assert.equal(after.boxes[2].name, "total");
  assert.deepEqual(after.edges, [{ from: "pay", to: "src/cart.js#total", kind: "call" }], "the removed box's arrows go, and pay's say what it uses now");
  assert.equal(boxChanges["src/cart.js#total"], "new");
});

test("a box that says it's built but not where its code is sends the turn back", () => {
  const before = plan([]);
  const r = reply({ boxes: [{ id: "cart", lines: ["holds items"], status: "built" }], steps: [{ kind: "red-green" }, { kind: "refactor" }] });
  assert.match(whyNotATurn(before, r, fromReply(before, r, 1)) ?? "", /cart says it is built but not where the code is/);
});

test("a map too big for one prompt shows the boxes the turn is about, and names the rest", () => {
  const boxes = Array.from({ length: 200 }, (_, i) => box(`b${i}`, [`line ${i}`]));
  const p = buildPrompt({
    skill: readAgentFile("SKILL.md"), rules: "", session: "s", turn: 2, planPath: "s.plan", cwd: "/x",
    lines: [], boxes, edges: [{ from: "b7", to: "b8", kind: "call" }], seeds: ["b7"], drifted: ["b9"],
    threads: [], choices: [], humanDiff: { lines: [], boxes: [], map: [] }, drift: [], last: null,
  });
  assert.match(p, /"id":"b7".*"uses":\["b8"\]/, "a seed shows in full");
  assert.match(p, /"id":"b8"/, "and what it calls");
  assert.match(p, /"id":"b9".*"codeChanged":true/, "a drifted box shows in full, marked");
  assert.match(p, /^- b150$/m, "the rest are named");
  assert.doesNotMatch(p, /"id":"b150"/);
  assert.match(p, /The code under these boxes changed[^]*- b9/);
});

test("code changed under a box outside a turn marks the box, until a turn says what it does again", async () => {
  const { dir } = repo();
  const cart = { id: "cart", lines: ["holds items"], status: "built", code: [{ file: "src/cart.js" }] };
  const agent = recording(replying("fake", [
    { plan: [{ text: "a cart", status: "built" }], boxes: [cart], steps: [{ kind: "red-green" }, { kind: "refactor" }] },
    { plan: [{ text: "a cart", status: "built" }], boxes: [], steps: [] },
    { plan: [{ text: "a cart", status: "built" }], boxes: [{ ...cart, lines: ["holds items, at most 10"] }], steps: [] },
  ], (cwd, n) => n === 0 && writeFileSync(join(cwd, "src/cart.js"), "export const cart = [];\n")));
  mkdirSync(join(dir, "src"));
  const { session: s, view } = open(dir, { agent });
  await s.pass({ text: "a cart" });
  assert.deepEqual(view().drifted, []);
  assert.ok(view().boxes[0].seen?.["src/cart.js"], "the box remembers the code it says what it does");

  writeFileSync(join(dir, "src/cart.js"), "export const cart = []; // at most 10\n");
  await s.pass();
  assert.match(agent.prompts[1], /"id":"cart".*"codeChanged":true/);
  assert.deepEqual(view().drifted, ["cart"], "a turn that leaves the box alone doesn't vouch for code it didn't see");

  await s.pass();
  assert.deepEqual(view().drifted, [], "the turn that brings the box back clears it");
});

// ---------- the person edits the map ----------

import { baseOf, editMap, humanDiff } from "../src/plan.ts";

test("the person's map edits read as a diff the next turn builds", () => {
  const before = plan([box("routes", ["get /:code"]), box("links", ["shorten, follow"]), box("stats", ["count clicks"], { parent: "links" })], [{ from: "routes", to: "stats", kind: "call" }]);
  const after = editMap(before, [
    { op: "add", key: "k1", name: "rate limit", parent: "routes", lines: ["10 a minute per ip"] },
    { op: "connect", from: "routes", to: "k1", label: "before every request" },
    { op: "rename", id: "links", name: "short links" },
    { op: "remove", id: "stats" },
    { op: "pseudo", id: "routes", lines: ["get /:code", "post /"] },
  ]);
  const added = after.boxes.find((b) => b.name === "rate limit")!;
  assert.deepEqual([added.id, added.parent, added.status, added.lines[0].by], ["rate_limit", "routes", "stale", "h"]);
  assert.equal(after.boxes.find((b) => b.id === "routes")!.status, "stale", "a changed body needs a build");
  assert.ok(!after.edges.some((e) => e.to === "stats"), "a removed box takes its arrows with it");

  const d = humanDiff(baseOf(before), after);
  const p = buildPrompt({
    skill: "", rules: "", session: "s", turn: 2, planPath: "s.plan", cwd: "/x", lines: after.lines, boxes: after.boxes, edges: after.edges,
    seeds: [], drifted: [], threads: [], choices: [], humanDiff: d, drift: [], last: null,
  });
  assert.match(p, /\+ box rate_limit "rate limit" inside routes/);
  assert.match(p, /\+ arrow routes → rate_limit: before every request/);
  assert.match(p, /~ box links renamed "links" to "short links"/);
  assert.match(p, /- box stats "stats"/);
  assert.match(p, /- arrow routes → stats/);
  assert.match(p, /In box routes:\n {2}\+ post \//);
});

test("an edit naming a box the map doesn't have is refused, naming it", () => {
  assert.throws(() => editMap(plan([box("a", [])]), [{ op: "connect", from: "a", to: "nope" }]), /no box nope/);
});

test("a session takes map edits between turns and refuses them during one", async () => {
  const { dir } = repo();
  const { session: s, view } = open(dir, { commit: false });
  s.editMap({ edits: [{ op: "add", key: "k", name: "cart", parent: null, lines: ["holds items"] }] });
  assert.deepEqual(view().boxes.map((b) => b.id), ["cart"]);
  assert.throws(() => s.editMap({ edits: [{ op: "remove", id: "nope" }] }), /no box nope/);
});
