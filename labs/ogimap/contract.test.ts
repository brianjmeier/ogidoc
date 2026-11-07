// The contract a client relies on, pinned against a real Ogimap: the demo, started from a
// brief the way a Tend station starts it. `contract-example.json` is what a client can
// expect from GET /api/state once the task's map is drawn; a client keeps its own copy
// and decodes it in its tests, so a change here shows up there as a version to bump.
//
//   node --test labs/ogimap/contract.test.ts
//   OGIMAP_WRITE_EXAMPLE=1 node --test labs/ogimap/contract.test.ts   rewrites the example

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OGIMAP_API, type State } from "./contract.ts";

const HERE = new URL(".", import.meta.url).pathname;
const EXAMPLE = join(HERE, "contract-example.json");

// Only the fields the contract names: the rest is Ogimap's own editor's business.
const contractOf = (s: Record<string, any>): State => ({
  api: s.api,
  busy: s.busy,
  view: s.view,
  task: s.task && { phase: s.task.phase, title: s.task.title, prompt: s.task.prompt },
  last: s.last && { summary: s.last.summary, ...(s.last.error ? { error: s.last.error } : {}) },
});

test("GET /api/state keeps its contract, and POST /api/turn takes edits", async () => {
  const brief = join(mkdtempSync(join(tmpdir(), "ogimap-contract-")), "brief.json");
  writeFileSync(brief, JSON.stringify({ prompt: "short links should expire after a while", title: "Expire short links after 7 days", brief: "createdAt; 410 after 7 days" }));
  const server = spawn(process.execPath, [join(HERE, "ogimap.ts"), "--demo", "--task-file", brief, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const base = await new Promise<string>((ok, fail) => {
      let out = "";
      server.stdout!.on("data", (d) => {
        out += d;
        const m = out.match(/Ogimap on (http:\/\/localhost:\d+)/);
        if (m) ok(m[1].replace("localhost", "127.0.0.1"));
      });
      server.on("exit", (code) => fail(new Error(`Ogimap exited ${code}`)));
    });
    const state = async () => (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>;
    const until = async (check: (s: Record<string, any>) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const s = await state();
        if (check(s)) return s;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("timed out");
    };
    const drawn = contractOf(await until((s) => s.task?.phase === "map" && s.busy === null));
    assert.equal(drawn.api, OGIMAP_API);
    if (process.env.OGIMAP_WRITE_EXAMPLE) writeFileSync(EXAMPLE, JSON.stringify(drawn, null, 1) + "\n");
    assert.deepEqual(drawn, JSON.parse(readFileSync(EXAMPLE, "utf8")));

    // A client's edits end the person's turn; one naming no box is refused before it starts.
    const turn = (edits: unknown) => fetch(`${base}/api/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ edits }) });
    const refused = await turn([{ op: "pseudo", id: "nowhere", lines: [] }]);
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /no box "nowhere"/);
    const follow = drawn.view!.boxes.find((b) => b.id === "links.follow")!;
    assert.equal((await turn([{ op: "pseudo", id: follow.id, lines: follow.lines.filter((l) => l.mark !== "removed").map((l) => l.text) }])).status, 202);
    const built = await until((s) => s.task?.phase === "done" && s.busy === null);
    assert.ok(built.view.boxes.every((b: { state: string; inTask: boolean }) => !b.inTask || b.state === "built"));
  } finally {
    server.kill();
  }
});
