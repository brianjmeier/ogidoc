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

import { driftOf, focusOf, indexOf, mergeMaps, mergeRegion, regionIds, regionOf, stamped } from "./map.ts";

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
  const hashes: Record<string, string> = { "src/cart.js": "c1", "src/pay.js": "p1" };
  const seenNow = stamped(tiny(), tiny().nodes.map((n) => n.id), (f) => hashes[f] ?? null);
  assert.deepEqual(seenNow.nodes.find((n) => n.id === "cart.add")!.seen, { "src/cart.js": "c1" });
  assert.equal(seenNow.nodes.find((n) => n.id === "cart")!.seen, undefined);
  assert.deepEqual(driftOf(seenNow, (f) => hashes[f] ?? null), []);
  hashes["src/cart.js"] = "c2";
  const drift = driftOf(seenNow, (f) => hashes[f] ?? null);
  assert.deepEqual(drift, ["cart.add", "cart.total"]);
  const index = indexOf(tiny(), drift);
  assert.match(index, /- cart\.add \(in cart\): push item \[src\/cart\.js\] — code changed since mapped/);
  assert.match(index, /- pay\.charge \(in pay\): stripe\.charge\(total\) \[src\/pay\.js\]$/m);
});

test("a task's focus is what it touched and the modules holding it, not their neighbours", () => {
  assert.deepEqual([...focusOf(tiny(), ["pay.charge", "gone"])].sort(), ["pay", "pay.charge"]);
  assert.deepEqual([...regionIds(tiny(), focusOf(tiny(), ["pay.charge"]))].sort(), ["cart", "cart.total", "pay", "pay.charge"]);
});

// ---------- a branch's map rebases onto main's ----------

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync as write, readFileSync as read, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("three-way: each side's changes land, both-changed keeps ours unstamped, deletes and parents carry", () => {
  const base = stamped(tiny(), tiny().nodes.map((n) => n.id), () => "h0");
  const ours = structuredClone(base);
  ours.nodes.find((n) => n.id === "cart.add")!.pseudo = ["push item, merge duplicates"];
  ours.nodes.find((n) => n.id === "pay.charge")!.pseudo = ["ours: stripe.charge(total, idempotent)"];
  ours.nodes.push({ id: "cart.clear", name: "clear", parent: "cart", kind: "step", pseudo: ["empty the cart"] });
  ours.edges.push({ from: "pay.charge", to: "cart.clear" });
  const theirs = structuredClone(base);
  theirs.nodes.find((n) => n.id === "cart.total")!.pseudo = ["sum prices, then tax"];
  theirs.nodes.find((n) => n.id === "pay.charge")!.pseudo = ["theirs: adyen.charge(total)"];
  theirs.nodes = theirs.nodes.filter((n) => n.id !== "auth" && n.id !== "auth.login");
  theirs.nodes.push({ id: "auth.sso", name: "sso", parent: "auth", kind: "step", pseudo: ["google sign-in"] });
  const merged = mergeMaps(base, ours, theirs);
  const at = (id: string) => merged.nodes.find((n) => n.id === id);
  assert.deepEqual(at("cart.add")!.pseudo, ["push item, merge duplicates"]);
  assert.deepEqual(at("cart.total")!.pseudo, ["sum prices, then tax"]);
  assert.deepEqual(at("pay.charge")!.pseudo, ["ours: stripe.charge(total, idempotent)"]);
  assert.deepEqual(at("pay.charge")!.ways, [{ pseudo: ["theirs: adyen.charge(total)"] }]);
  assert.equal(at("pay.charge")!.status, "stale");
  assert.equal(at("pay.charge")!.seen, undefined);
  assert.deepEqual(at("cart.total")!.seen, { "src/cart.js": "h0" });
  assert.ok(at("cart.clear"));
  assert.equal(at("auth"), undefined);
  assert.equal(at("auth.login"), undefined);
  assert.equal(at("auth.sso")!.parent, null);
  assert.ok(merged.edges.some((e) => e.from === "pay.charge" && e.to === "cart.clear"));
  assert.equal(merged.edges.some((e) => e.from === "auth.login"), false);
});

test("git rebases a branch's map onto main's through the driver, with no conflict", () => {
  const repo = mkdtempSync(join(tmpdir(), "ogimap-rebase-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const save = (map: FlowMap) => write(join(repo, ".ogimap/map.json"), JSON.stringify(map, null, 1) + "\n");
  git("init", "-q", "-b", "main");
  git("config", "merge.ogimap.driver", `node '${new URL("./merge.ts", import.meta.url).pathname}' %O %A %B`);
  write(join(repo, ".gitattributes"), ".ogimap/map.json merge=ogimap\n");
  mkdirSync(join(repo, ".ogimap"));
  save(tiny());
  git("add", "-A");
  git("commit", "-qm", "the map");
  git("checkout", "-qb", "worker");
  const mine = tiny();
  mine.nodes.find((n) => n.id === "cart.add")!.pseudo = ["worker: push item"];
  mine.nodes.push({ id: "cart.clear", name: "clear", parent: "cart", kind: "step", pseudo: ["empty the cart"] });
  save(mine);
  git("commit", "-qam", "worker's task");
  git("checkout", "-q", "main");
  const mains = tiny();
  mains.nodes.find((n) => n.id === "cart.total")!.pseudo = ["main: sum prices, then tax"];
  mains.nodes.find((n) => n.id === "cart.add")!.code = [{ file: "src/cart.js", line: 4 }];
  save(mains);
  git("commit", "-qam", "main's task");
  git("checkout", "-q", "worker");
  git("rebase", "-q", "main");
  const after = checkMap(JSON.parse(read(join(repo, ".ogimap/map.json"), "utf8")));
  const at = (id: string) => after.nodes.find((n) => n.id === id);
  assert.deepEqual(at("cart.add")!.pseudo, ["worker: push item"]);
  assert.deepEqual(at("cart.add")!.code, [{ file: "src/cart.js", line: 4 }]);
  assert.deepEqual(at("cart.total")!.pseudo, ["main: sum prices, then tax"]);
  assert.ok(at("cart.clear"));
  assert.match(git("log", "--format=%s"), /worker's task\nmain's task\nthe map/);
});

// ---------- what a client is told, and what it can do ----------

import { draftFromEdits, viewOf } from "./map.ts";

test("the view says each box's state and the plan's lines; a task marks its boxes", () => {
  const map = tiny();
  map.nodes.find((n) => n.id === "pay.charge")!.status = "stale";
  map.nodes.find((n) => n.id === "pay.charge")!.pseudo = ["stripe.charge(total, idempotent)"];
  map.nodes.find((n) => n.id === "pay.charge")!.was = ["stripe.charge(total)"];
  map.nodes.push({ id: "cart.clear", name: "clear", parent: "cart", kind: "step", pseudo: ["empty the cart"], status: "proposal", ways: [{ pseudo: ["keep it, mark it done"] }] });
  const view = viewOf(map, { focus: ["pay", "pay.charge"], drift: ["auth.login"], standing: "Your pen", failed: false });
  const at = (id: string) => view.boxes.find((b) => b.id === id)!;
  assert.equal(at("pay.charge").state, "to build");
  assert.deepEqual(at("pay.charge").lines, [{ text: "stripe.charge(total)", mark: "removed" }, { text: "stripe.charge(total, idempotent)", mark: "added" }]);
  assert.equal(at("cart.clear").state, "proposed");
  assert.deepEqual(at("cart.clear").lines, [{ text: "empty the cart", mark: "added" }]);
  assert.equal(at("cart.clear").ways, 1);
  assert.equal(at("auth.login").state, "code changed");
  assert.deepEqual(at("cart.add").lines, [{ text: "push item", mark: null }]);
  assert.deepEqual(view.boxes.filter((b) => b.inTask).map((b) => b.id), ["pay", "pay.charge"]);
  assert.equal(viewOf(map, { drift: [], standing: "", failed: false }).boxes.every((b) => b.inTask), true);
  assert.deepEqual(view.edges[0], { from: "pay.charge", to: "cart.total", label: "amount" });
});

test("a client's edits become the person's draft, and read as a turn's diff", () => {
  const draft = draftFromEdits(tiny(), [
    { op: "pseudo", id: "cart.add", lines: ["push item, merge duplicates"] },
    { op: "rename", id: "pay", name: "payments" },
    { op: "remove", id: "auth.login" },
    { op: "add", key: "k1", name: "Clear cart", parent: "cart", lines: ["empty the cart"] },
    { op: "connect", from: "pay.charge", to: "k1", label: "after paying" },
    { op: "disconnect", from: "pay.charge", to: "cart.total" },
  ]);
  const at = (id: string) => draft.nodes.find((n) => n.id === id)!;
  assert.deepEqual(at("cart.add").pseudo, ["push item, merge duplicates"]);
  assert.equal(at("pay").name, "payments");
  assert.equal(at("auth.login").removed, true);
  assert.deepEqual(at("cart.clear_cart"), { id: "cart.clear_cart", name: "Clear cart", parent: "cart", kind: "step", pseudo: ["empty the cart"], status: "proposal", by: "human" });
  assert.deepEqual(draft.edges.find((e) => e.to === "cart.clear_cart"), { from: "pay.charge", to: "cart.clear_cart", label: "after paying", kind: "call", by: "human" });
  assert.equal(draft.edges.find((e) => e.to === "cart.total")!.removed, true);
  const intent = intentOf(tiny(), draft, []);
  assert.match(intent, /CHANGE node cart\.add\n {2}- push item\n {2}\+ push item, merge duplicates/);
  assert.match(intent, /NEW node cart\.clear_cart "Clear cart" \(step\) inside cart/);
  assert.match(intent, /NEW edge pay\.charge → cart\.clear_cart "after paying"/);
  assert.match(intent, /REMOVE edge pay\.charge → cart\.total/);
  assert.match(intent, /REMOVE node auth\.login/);
  assert.throws(() => draftFromEdits(tiny(), [{ op: "pseudo", id: "nowhere", lines: [] }]), /no box "nowhere"/);
  assert.throws(() => draftFromEdits(tiny(), [{ op: "disconnect", from: "cart", to: "pay" }]), /no arrow/);
});
