import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mapStore } from "../src/map-store.ts";
import type { Box } from "../src/types.ts";
import { emptyDir, open, texts } from "./support/index.ts";

const box = (id: string, lines: string[], status: Box["status"] = "built"): Box => ({ id, name: id, parent: null, lines: lines.map((text) => ({ text })), status });
const onDisk = (dir: string) => JSON.parse(readFileSync(join(dir, ".ogidoc/map.json"), "utf8"));

test("a session's old box files join the repo's map, with what they used as arrows", () => {
  const dir = emptyDir();
  const old = join(dir, ".ogidoc/weekly");
  mkdirSync(join(old, "boxes"), { recursive: true });
  writeFileSync(join(old, "boxes/summarize.plan"), "count the week\nkeep 3\n");
  writeFileSync(join(old, "boxes/window.plan"), "monday to sunday\n");
  writeFileSync(join(old, "state.json"), JSON.stringify({ boxes: [
    { name: "summarize", lines: [{ text: "count the week", by: "a" }, { text: "keep 3", by: "h" }], status: "built", uses: ["window"] },
    { name: "window", lines: [{ text: "monday to sunday", by: "a" }], status: "stale", uses: [] },
  ] }));

  const { session, view } = open(dir, { commit: false });
  const boxes = view().boxes;
  assert.deepEqual(boxes.map((b) => [b.id, b.parent, b.status]), [["summarize", null, "built"], ["window", null, "stale"]]);
  assert.deepEqual(boxes[0].lines.map((l) => l.by), ["a", "h"], "what the editor knew about each line comes along");
  assert.deepEqual(view().edges, [{ from: "summarize", to: "window", kind: "call" }]);

  session.save();
  assert.equal(existsSync(join(old, "boxes")), false, "the old box files are gone once the map has them");
  assert.deepEqual(onDisk(dir).nodes.map((n: { id: string; pseudo: string[] }) => [n.id, n.pseudo]), [["summarize", ["count the week", "keep 3"]], ["window", ["monday to sunday"]]]);
});

test("two sessions in one checkout each keep what the other saved", () => {
  const dir = emptyDir();
  const a = mapStore(dir);
  a.save([box("shared", ["one"]), box("left", ["mine"])], []);
  const b = mapStore(dir);
  const seen = b.load();
  assert.deepEqual(seen.boxes.map((x) => x.id), ["shared", "left"]);

  // b changes `shared` and adds a box; a, which read before that, adds its own box.
  b.save([box("shared", ["one, changed by b"]), box("left", ["mine"]), box("right", ["b's"])], seen.edges);
  a.save([box("shared", ["one"]), box("left", ["mine"]), box("third", ["a's too"])], []);

  const nodes = onDisk(dir).nodes.map((n: { id: string; pseudo: string[] }) => [n.id, n.pseudo.join()]);
  assert.deepEqual(new Map(nodes), new Map([["shared", "one, changed by b"], ["left", "mine"], ["right", "b's"], ["third", "a's too"]]));
});

test("a box another session made shows up as the map has it", () => {
  const dir = emptyDir();
  mapStore(dir).save([box("theirs", ["built elsewhere"])], []);
  const { view } = open(dir, { commit: false });
  const [b] = view().boxes;
  assert.equal(b.status, "built", "a box this session never saw is not made stale by opening it");
  assert.deepEqual(texts(b.lines), ["built elsewhere"]);
});
