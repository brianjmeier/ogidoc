// The real command, as a chat agent would use it next to a running session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, readFileSync } from "node:fs";
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
    assert.match(ogidoc("status").stdout, /Session weekly[\s\S]*It's the person's turn; the agent has taken 0 turns/);
    assert.match(ogidoc("weekly", "--detach").stderr, /The session weekly is already open at/);

    // The chat waits first; it returns only once the person has handed over in the editor
    // and the agent's turn has ended.
    const waiting = spawn(process.execPath, [BIN, "wait", "--json"], { cwd: dir, env });
    let out = "";
    waiting.stdout.on("data", (d) => (out += d));
    const waited = new Promise<number | null>((r) => waiting.on("exit", r));
    await new Promise((r) => waiting.stderr.on("data", (d) => String(d).includes("Waiting for the next agent turn in weekly") && r(null)));
    const text = "weekly reflection\n  every sunday\n    look at my week\n    tell me what i felt most";
    const pass = await fetch(`${url}/api/pass`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    assert.equal(pass.status, 202);
    assert.equal(await waited, 0);
    const state = JSON.parse(out);
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

test("install-skill gives the chat its own skill, not the plan agent's", () => {
  const home = emptyDir();
  const r = spawnSync(process.execPath, [BIN, "install-skill", "both"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const dir of [".claude/skills/ogidoc", ".pi/agent/skills/ogidoc"]) {
    const skill = readFileSync(`${home}/${dir}/SKILL.md`, "utf8");
    assert.match(skill, /# Ogidoc, from the chat/);
    assert.match(skill, /never post to the session's server/i);
  }
});

test("the demo needs no project and no API key: a scripted agent plays on a written plan", async () => {
  const env = { ...process.env, OGIDOC_HOME: emptyDir() };
  const ogidoc = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: emptyDir(), env, encoding: "utf8" });
  const started = ogidoc("--demo", "--detach", "--port", "0");
  assert.equal(started.status, 0, started.stderr);
  const url = started.stdout.match(/Ogidoc session tic-tac-toe is open at (http:\/\/\S+)/)?.[1];
  assert.ok(url, started.stdout);
  try {
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.agent, "mock");
    assert.equal(state.lines[0].text, "game tic_tac_toe:");
    const waiting = spawn(process.execPath, [BIN, "wait", "tic-tac-toe", "--json"], { env });
    let out = "";
    waiting.stdout.on("data", (d) => (out += d));
    const waited = new Promise<number | null>((r) => waiting.on("exit", r));
    await new Promise((r) => waiting.stderr.on("data", (d) => String(d).includes("Waiting") && r(null)));
    await fetch(`${url}/api/pass`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(await waited, 0);
    assert.equal(JSON.parse(out).turn, 2);
  } finally {
    ogidoc("stop", "tic-tac-toe");
  }
});

// A copy of the shortener demo in a git checkout of its own.
function shortener() {
  const { dir, git } = repo();
  cpSync(new URL("../demo/shortener", import.meta.url).pathname, dir, { recursive: true });
  git("add", "-A");
  git("commit", "-qm", "the shortener");
  return { dir, git };
}

test("ogidoc map gives an agent the map with no editor: one level as text, or all of it as JSON", () => {
  const { dir } = shortener();
  const env = { ...process.env, OGIDOC_HOME: emptyDir() };
  const ogidoc = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: "utf8" });
  const top = ogidoc("map");
  assert.equal(top.status, 0, top.stderr);
  assert.match(top.stdout, /^test {2}· {2}1 file · /m, "the tests folder is code of its own");
  const src = ogidoc("map", "src").stdout;
  assert.match(src, /^links\.js {2}src\/links\.js {2}· {2}file · 20 lines/m);
  assert.match(src, /^ {2}unused: server\.js, exports names nothing in the code imports$/m);
  const all = JSON.parse(ogidoc("map", "--json").stdout);
  assert.ok(all.boxes.some((b: { id: string }) => b.id === "src/links.js"));
  assert.ok(all.smells.length);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout, "", "reading the map writes nothing");
  const nowhere = spawnSync(process.execPath, [BIN, "map"], { cwd: emptyDir(), env, encoding: "utf8" });
  assert.equal(nowhere.status, 1);
  assert.match(nowhere.stderr, /There is no map here/);
});

test("ogidoc map describe says what a box does, in a commit that touches only the map", () => {
  const { dir, git } = shortener();
  const env = { ...process.env, OGIDOC_HOME: emptyDir() };
  const r = spawnSync(process.execPath, [BIN, "map", "describe", "src/links.js", "--agent", "mock", "--script", new URL("../demo/shortener.json", import.meta.url).pathname], { cwd: dir, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\| follow\(code\) -> redirect, counting the visit$/m, "it prints the box as now described");
  assert.match(r.stdout, /^follow {2}src\/links\.js#follow {2}· {2}in src\/links\.js$/m);
  assert.equal(git("log", "-1", "--format=%s").trim(), "ogidoc: describe src/links.js");
  assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), [".gitattributes", ".ogidoc/map.json"]);
  assert.match(spawnSync(process.execPath, [BIN, "map", "src/links.js"], { cwd: dir, env, encoding: "utf8" }).stdout, /^\| shorten\(url\)/m, "the next read has it");
});

test("ogidoc map describe leaves the map to a session open on the same checkout", () => {
  const { dir } = shortener();
  const env = { ...process.env, OGIDOC_HOME: emptyDir() };
  const ogidoc = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: "utf8" });
  assert.equal(ogidoc("p", "--detach", "--agent", "mock", "--script", SCRIPT, "--port", "0").status, 0);
  try {
    const r = ogidoc("map", "describe", "src/links.js", "--agent", "mock");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The session p is open on this checkout .* ogidoc stop p/);
  } finally {
    ogidoc("stop", "p");
  }
});
