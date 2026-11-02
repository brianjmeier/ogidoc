import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgent } from "../src/agents.ts";
import { parseReply } from "../src/prompt.ts";

// Fake CLIs that speak each tool's JSON event format, so the adapters are tested
// against the real wire shapes without calling a model.

const REPLY = '```json\n{"plan":[{"text":"hello","kind":null,"status":"built"}],"summary":"ok"}\n```';

function fake(name: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), `fake-${name}-`));
  const bin = join(dir, name);
  writeFileSync(bin, `#!/usr/bin/env node\n${body}`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

test("claude adapter: prompt on stdin, tool activity, final result", async () => {
  const { bin, dir } = fake("claude", `
const fs = require("fs");
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.argv[1] + ".args", JSON.stringify({ argv: process.argv.slice(2), prompt, claudecode: process.env.CLAUDECODE || null }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "conv-1" });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.js" } }] } });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test\\nmore" } }] } });
out({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
out({ type: "result", subtype: "success", result: ${JSON.stringify(REPLY)} });
`);
  const activity: string[] = [];
  const sessions: string[] = [];
  const agent = makeAgent("claude", { env: { CLAUDECODE: "1", PATH: process.env.PATH }, bin, args: ["--model", "sonnet"] });
  const out = await agent.run({ prompt: "PROMPT TEXT", cwd: dir, onActivity: (a) => activity.push(a), onSession: (id) => sessions.push(id) });
  assert.deepEqual(sessions, ["conv-1"]);
  assert.equal(parseReply(out).plan[0].text, "hello");
  assert.deepEqual(activity, ["editing src/a.js", "running npm test"]);
  const seen = JSON.parse(readFileSync(bin + ".args", "utf8"));
  assert.equal(seen.prompt, "PROMPT TEXT");
  assert.equal(seen.claudecode, null, "CLAUDECODE is removed so claude can run nested");
  assert.ok(seen.argv.includes("-p") && seen.argv.includes("stream-json"));
  assert.deepEqual(seen.argv.slice(-2), ["--model", "sonnet"]);
  assert.ok(!seen.argv.includes("--resume"));

  await agent.run({ prompt: "CARRY ON", cwd: dir, resume: "conv-1", onActivity() {} });
  const again = JSON.parse(readFileSync(bin + ".args", "utf8"));
  assert.equal(again.prompt, "CARRY ON");
  assert.deepEqual(again.argv.slice(0, 2), ["--resume", "conv-1"], "the same conversation carries on");
  await assert.rejects(async () => agent.run({ prompt: "p", cwd: dir, resume: "x --dangerously-skip-permissions", onActivity() {} }), /not a session id/);
});

test("pi adapter: prompt as argument, json mode events, last assistant text", async () => {
  const { bin, dir } = fake("pi", `
const fs = require("fs");
fs.writeFileSync(process.argv[1] + ".args", JSON.stringify(process.argv.slice(2)));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "session", version: 3, id: "x" });
out({ type: "agent_start" });
out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "weekly.plan" } });
out({ type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: "node --test" } });
const msg = { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(REPLY)} }] };
out({ type: "message_end", message: msg });
out({ type: "agent_end", messages: [{ role: "user", content: "p" }, msg] });
`);
  const activity: string[] = [];
  const sessions: string[] = [];
  const agent = makeAgent("pi", { env: { PATH: process.env.PATH }, bin });
  const out = await agent.run({ prompt: "PROMPT TEXT", cwd: dir, onActivity: (a) => activity.push(a), onSession: (id) => sessions.push(id) });
  assert.deepEqual(sessions, ["x"]);
  assert.equal(parseReply(out).summary, "ok");
  assert.deepEqual(activity, ["reading weekly.plan", "running node --test"]);
  const argv = JSON.parse(readFileSync(bin + ".args", "utf8"));
  assert.deepEqual(argv.slice(0, 3), ["-p", "--mode", "json"]);
  assert.ok(!argv.includes("--no-session"), "kept, so a retry can carry on");
  assert.equal(argv.at(-1), "PROMPT TEXT");

  await agent.run({ prompt: "CARRY ON", cwd: dir, resume: "x", onActivity() {} });
  const again = JSON.parse(readFileSync(bin + ".args", "utf8"));
  assert.deepEqual(again.slice(3, 5), ["--session", "x"]);
  assert.equal(again.at(-1), "CARRY ON");
});

test("an agent that exits without a reply is an error", async () => {
  const { bin, dir } = fake("pi", `process.stderr.write("No API key found"); process.exit(1);`);
  await assert.rejects(makeAgent("pi", { env: { PATH: process.env.PATH }, bin }).run({ prompt: "p", cwd: dir, onActivity() {} }), /No API key found/);
});

test("a model error inside pi's event stream is reported as such", async () => {
  const { bin, dir } = fake("pi", `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const msg = { role: "assistant", content: [], stopReason: "error", errorMessage: "UnrecognizedClientException: The security token included in the request is invalid." };
out({ type: "message_end", message: msg });
out({ type: "agent_end", messages: [msg] });
`);
  await assert.rejects(makeAgent("pi", { env: { PATH: process.env.PATH }, bin }).run({ prompt: "p", cwd: dir, onActivity() {} }), /security token included in the request is invalid/);
});

test("any agent CLI as a command: prompt on stdin and in $OGIDOC_PROMPT, stderr as activity, stdout as the reply", async () => {
  const { bin, dir } = fake("myagent", `
const fs = require("fs");
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.argv[1] + ".seen", JSON.stringify({ stdin, env: process.env.OGIDOC_PROMPT, cwd: process.cwd(), arg: process.argv[2] }));
process.stderr.write("reading weekly.plan\\n");
process.stderr.write("running the tests\\n");
process.stdout.write("Done.\\n\\n" + ${JSON.stringify(REPLY)});
`);
  const activity: string[] = [];
  const agent = makeAgent("command", { env: { PATH: process.env.PATH }, command: `${bin} "$OGIDOC_PROMPT"` });
  assert.equal(agent.name, "myagent", "named after the command, so the editor says what runs");
  const prompt = `PROMPT with "quotes", $dollars and \`ticks\``;
  const out = await agent.run({ prompt, cwd: dir, onActivity: (a) => activity.push(a) });
  assert.equal(parseReply(out).summary, "ok");
  assert.deepEqual(activity.slice(-1), ["running the tests"]);
  const seen = JSON.parse(readFileSync(bin + ".seen", "utf8"));
  assert.equal(seen.stdin, prompt);
  assert.equal(seen.env, prompt);
  assert.equal(seen.arg, prompt, "the prompt reaches an argument unchanged, quotes and all");
  assert.equal(realpathSync(seen.cwd), realpathSync(dir));
});

test("a command agent that prints nothing is an error, and stopping it stops what it started", async () => {
  const quiet = makeAgent("command", { env: { PATH: process.env.PATH }, command: "echo nope >&2; exit 3" });
  await assert.rejects(quiet.run({ prompt: "p", cwd: tmpdir(), onActivity() {} }), /exited with code 3 and no reply. nope/);

  // The command starts a child of its own and waits on it; once the child has said its pid,
  // stop the turn: the turn ends, and the child is gone too.
  const stop = new AbortController();
  const slow = makeAgent("command", { env: { PATH: process.env.PATH }, command: `sleep 30 & echo $! >&2; wait` });
  let child = 0;
  let said = () => {};
  const started = new Promise<void>((r) => (said = r));
  const turn = slow.run({ prompt: "p", cwd: tmpdir(), onActivity: (a) => { child = Number(a); said(); }, signal: stop.signal });
  await started;
  stop.abort();
  await assert.rejects(turn, /no reply/);
  for (let i = 0; i < 50 && running(child); i++) await setTimeout(10);
  assert.equal(running(child), false, "the command's own children are stopped too");
});

// Whether a process still runs; one that has exited but not been reaped doesn't count.
const running = (pid: number) => (spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().replace(/Z.*/, "") !== "");

test("--agent-cmd needs a command", () => {
  assert.throws(() => makeAgent("command", { env: {}, command: " " }), /needs --agent-cmd/);
});
