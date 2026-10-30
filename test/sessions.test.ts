import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fromFolder, sessionName, sessionToOpen } from "../src/sessions.ts";
import { registry, type Running } from "../src/registry.ts";
import { emptyDir } from "./support/index.ts";

// Answers every question with `answer`, and remembers what was asked.
const answering = (answer: string) => {
  const asked: string[] = [];
  return { asked, ask: async (q: string, suggestion: string) => (asked.push(`${q} [${suggestion}]`), answer) };
};

test("a session is a name; a plan file name still reads as its session", () => {
  assert.equal(sessionName("weekly"), "weekly");
  assert.equal(sessionName("weekly.plan"), "weekly");
  assert.throws(() => sessionName("My Plan"), /lowercase letters, digits and dashes/);
  assert.throws(() => sessionName("../etc"), /is a path/);
  assert.throws(() => sessionName("status"), /one of ogidoc's commands/);
  assert.equal(fromFolder("My App_v2"), "my-app-v2");
  assert.equal(fromFolder("___"), "plan");
});

test("opening without a name: the one session here, else ask which, else ask for one", async () => {
  assert.equal(await sessionToOpen({ here: ["nave"], folder: "x" }), "nave");
  assert.equal(await sessionToOpen({ given: "other", here: ["nave"], folder: "x" }), "other");

  const which = answering("");
  assert.equal(await sessionToOpen({ here: ["a", "b"], folder: "x", ask: which.ask }), "a", "enter takes the suggestion");
  assert.deepEqual(which.asked, ["Which session? (a, b) [a]"]);
  await assert.rejects(sessionToOpen({ here: ["a", "b"], folder: "x" }), /Several sessions were started here: a, b/);

  const named = answering("tic-tac-toe");
  assert.equal(await sessionToOpen({ here: [], folder: "Games", ask: named.ask }), "tic-tac-toe");
  assert.deepEqual(named.asked, ["Name this session [games]"]);
  assert.equal(await sessionToOpen({ here: [], folder: "Games" }), "games", "with no terminal to ask in, the folder's name");
  await assert.rejects(sessionToOpen({ here: [], folder: "x", ask: answering("Bad Name").ask }), /can't name a session/);
});

function machine() {
  const dir = join(emptyDir(), "sessions");
  const dead = new Set<number>();
  const reg = registry({ dir, alive: (pid) => !dead.has(pid) });
  const run = (name: string, cwd: string, pid: number): Running => ({ name, cwd, pid, url: `http://127.0.0.1:${pid}`, agent: "mock", log: "" });
  return { dead, reg, run };
}

test("the running sessions: found by name, by where you are, or as the only one", () => {
  const { reg, run } = machine();
  assert.throws(() => reg.pick({ cwd: "/a" }), /No Ogidoc session is running/);
  reg.register(run("nave", "/a", 1));
  assert.equal(reg.pick({ cwd: "/elsewhere" }).name, "nave", "the only one running");
  reg.register(run("site", "/b", 2));
  assert.equal(reg.pick({ cwd: "/b" }).name, "site", "the one started here");
  assert.equal(reg.pick({ given: "nave", cwd: "/b" }).name, "nave");
  assert.throws(() => reg.pick({ cwd: "/c" }), /Several sessions are running: nave, site/);
  assert.throws(() => reg.pick({ given: "gone", cwd: "/a" }), /No session named gone is running. Running: nave, site/);
});

test("a name runs once on the machine, and a session that died is forgotten", () => {
  const { dead, reg, run } = machine();
  reg.register(run("nave", "/a", 1));
  assert.throws(() => reg.check("nave", "/a"), /already open at http:\/\/127.0.0.1:1/);
  assert.throws(() => reg.register(run("nave", "/b", 2)), /already runs in \/a. Give this one another name/);
  dead.add(1);
  assert.deepEqual(reg.list(), []);
  reg.register(run("nave", "/b", 2));
  reg.release("nave", 3);
  assert.equal(reg.list().length, 1, "only the server that registered a name lets it go");
  reg.release("nave", 2);
  assert.deepEqual(reg.list(), []);
});

test("sessions made before names had rules keep their names; paths get told what changed", async () => {
  assert.equal(sessionName("tic_tac_toe", ["tic_tac_toe"]), "tic_tac_toe");
  assert.equal(await sessionToOpen({ given: "tic_tac_toe.plan", here: ["tic_tac_toe"], folder: "x" }), "tic_tac_toe");
  assert.equal(await sessionToOpen({ here: ["Old_One"], folder: "x" }), "Old_One");
  assert.throws(() => sessionName("sub/x.plan"), /is a path. A session is a name now/);
  assert.equal(fromFolder("list"), "list-plan", "a folder named like a command still gives a usable name");
});

test("a chat in a project's subfolder finds the session started above it", () => {
  const { reg, run } = machine();
  reg.register(run("nave", "/a", 1));
  reg.register(run("site", "/b", 2));
  assert.equal(reg.pick({ cwd: "/a/src/game" }).name, "nave");
  assert.throws(() => reg.pick({ cwd: "/ab" }), /Several sessions are running/, "a sibling folder isn't inside");
});
