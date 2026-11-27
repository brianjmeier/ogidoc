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
    threads: [], choices: [], humanDiff: { lines: [], boxes: [] }, drift: [], last: null,
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
