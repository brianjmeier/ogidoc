// What the session tests share: a throwaway repository, the scripted agent, and one
// way to open a session, so how a session is put together is written here once.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgent } from "../../src/agents.ts";
import { openSession } from "../../src/session.ts";
import type { Agent } from "../../src/agents.ts";
import type { Clock } from "../../src/clock.ts";

export const SCRIPT = new URL("../fixtures/weekly.json", import.meta.url).pathname;
export const PLAN = "weekly reflection\n  every sunday\n    look at my week\n    tell me what i felt most";

// A clock the test moves by hand; sleeping costs no real time.
export function testClock(start = 0): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

export const scripted = (clock: Clock = testClock()) => makeAgent("mock", { env: {}, script: SCRIPT, sleep: clock.sleep });

export function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "underpaint-"));
}

export function repo() {
  const dir = emptyDir();
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, git, log: () => git("log", "--format=%s").trim().split("\n") };
}

// An agent for one test: it answers each turn with `run`.
export const fakeAgent = (name: string, run: Agent["run"]): Agent => ({ name, choices: { models: [], efforts: [] }, acceptsModel: () => true, run });

// An agent that remembers every prompt it was given.
export function recording(agent: Agent): Agent & { prompts: string[] } {
  const prompts: string[] = [];
  return { ...agent, prompts, run: (o) => { prompts.push(o.prompt); return agent.run(o); } };
}

export function open(dir: string, { planFile = "weekly.plan", clock = testClock(), agent = scripted(clock), commit = true }: { planFile?: string; clock?: Clock; agent?: Agent; commit?: boolean } = {}) {
  const a = recording(agent);
  const session = openSession({ cwd: dir, planFile, agent: a, clock, commit });
  return { session, view: () => session.snapshot(), prompts: a.prompts };
}

export const texts = (lines: { text: string }[]) => lines.map((l) => l.text);
