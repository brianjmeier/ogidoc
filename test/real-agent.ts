// One real turn against an installed agent CLI, to check the whole contract end to end:
// the prompt, the agent's own edits and test run, the JSON reply, and the commit.
//
//   node test/real-agent.ts [claude|pi]

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { makeAgent } from "../src/agents.ts";
import { Session } from "../src/session.ts";
import { systemClock } from "../src/clock.ts";

const name = process.argv[2] || "claude";
const dir = mkdtempSync(join(tmpdir(), `underpaint-real-${name}-`));
const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
g("init", "-q");
g("config", "user.email", "t@example.com");
g("config", "user.name", "Test");
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
g("add", ".");
g("commit", "-qm", "init");

const s = new Session({ cwd: dir, planFile: "slug.plan", agent: makeAgent(name), clock: systemClock });
s.on("change", () => { if (s.working && s.activity.length) console.log(`  … ${s.activity.at(-1)}`); });
const plan = [
  "slugify(title) for blog urls",
  "  lowercase, spaces become dashes",
  "  drop anything that isn't a letter, digit or dash",
  '  e.g. "Hello, World!" → "hello-world"',
].join("\n");
console.log(`Running one ${name} turn in ${dir}`);
const t0 = Date.now();
await s.pass({ text: plan });
console.log(`Turn took ${Math.round((Date.now() - t0) / 1000)}s`);
if (!s.last || s.last.error) throw new Error(s.last?.error ?? "no reply");
const last = s.last;

console.log("\nPlan after the agent's turn:");
for (const l of s.lines) console.log(`  ${(l.status || "").padEnd(8)} ${(l.kind || "").padEnd(9)} ${l.by} | ${l.text}`);
console.log(`\nSummary: ${last.summary}`);
console.log(`Files: ${(last.files ?? []).map((f) => `${f.op} ${f.path}`).join(", ")}`);
console.log(`Checks: ${(last.checks ?? []).map((c) => `${c.ok ? "✓" : "✕"} ${c.name}`).join(", ")}`);
console.log(`Commit: ${g("log", "-1", "--format=%s")}`);
console.log(`Files in repo: ${readdirSync(dir).join(", ")}`);

assert.ok(s.lines.length >= 3, "the agent returned a plan");
assert.ok(s.lines.some((l) => l.status === "built"), "something is built");
assert.match(g("log", "-1", "--format=%s"), /underpaint: turn 1 on slug/);
execFileSync("npm", ["test", "--silent"], { cwd: dir, stdio: "inherit" });
console.log("\nReal agent turn checks passed.");
