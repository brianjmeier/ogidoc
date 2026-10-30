// The real command, as a chat agent would use it next to a running session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { emptyDir, repo } from "./support/index.ts";

const BIN = new URL("../bin/ogidoc.ts", import.meta.url).pathname;
const SCRIPT = new URL("./fixtures/weekly.json", import.meta.url).pathname;

test("a detached session gives the terminal back, and list, status, wait and stop read it", async () => {
  const { dir } = repo();
  const env = { ...process.env, OGIDOC_HOME: emptyDir() };
  const ogidoc = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: "utf8" });

  const started = ogidoc("weekly", "--detach", "--agent", "mock", "--script", SCRIPT, "--port", "0");
  assert.equal(started.status, 0, started.stderr);
  const url = started.stdout.match(/Ogidoc session weekly is open at (http:\/\/\S+)/)?.[1];
  assert.ok(url, started.stdout);
  try {
    assert.match(ogidoc("list").stdout, /^weekly {2}http:\/\/\S+ {2}\//);
    assert.match(ogidoc("status").stdout, /Session weekly[\s\S]*It's the person's turn \(turn 1\)/);
    assert.match(ogidoc("weekly", "--detach").stderr, /The session weekly is already open at/);

    // The person hands over in the editor; the chat waits for the turn to end.
    const text = "weekly reflection\n  every sunday\n    look at my week\n    tell me what i felt most";
    const pass = await fetch(`${url}/api/pass`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    assert.equal(pass.status, 202);
    const waited = ogidoc("wait", "--json");
    assert.equal(waited.status, 0, waited.stderr);
    const state = JSON.parse(waited.stdout);
    assert.equal(state.name, "weekly");
    assert.equal(state.working, false);
    assert.equal(state.turn, 2);
    assert.ok(state.last.summary);
    assert.match(state.last.commit, /^[0-9a-f]{7,}$/);
    assert.match(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }), /ogidoc: turn 1 on weekly/);
  } finally {
    assert.match(ogidoc("stop").stdout, /Stopped weekly/);
  }
  assert.equal(ogidoc("list").stdout.trim(), "No Ogidoc session is running.");
  assert.match(ogidoc("status").stderr, /No Ogidoc session is running/);
});

test("without a name or a terminal, the session takes the folder's name", () => {
  const { dir } = repo();
  const env = { ...process.env, OGIDOC_HOME: emptyDir() };
  const r = spawnSync(process.execPath, [BIN, "--detach", "--agent", "mock", "--script", SCRIPT, "--port", "0"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const name = r.stdout.match(/Ogidoc session (\S+) is open/)?.[1];
  assert.match(name!, /^ogidoc-/, "the test repo's folder is named ogidoc-…");
  spawnSync(process.execPath, [BIN, "stop", name!], { cwd: dir, env });
});
