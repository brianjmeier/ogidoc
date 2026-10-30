import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
out({ type: "system", subtype: "init" });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.js" } }] } });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test\\nmore" } }] } });
out({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
out({ type: "result", subtype: "success", result: ${JSON.stringify(REPLY)} });
`);
  process.env.CLAUDECODE = "1";
  const activity: string[] = [];
  const agent = makeAgent("claude", { bin, args: ["--model", "sonnet"] });
  const out = await agent.run({ prompt: "PROMPT TEXT", cwd: dir, onActivity: (a) => activity.push(a) });
  assert.equal(parseReply(out).plan[0].text, "hello");
  assert.deepEqual(activity, ["editing src/a.js", "running npm test"]);
  const seen = JSON.parse(readFileSync(bin + ".args", "utf8"));
  assert.equal(seen.prompt, "PROMPT TEXT");
  assert.equal(seen.claudecode, null, "CLAUDECODE is removed so claude can run nested");
  assert.ok(seen.argv.includes("-p") && seen.argv.includes("stream-json"));
  assert.deepEqual(seen.argv.slice(-2), ["--model", "sonnet"]);
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
  const out = await makeAgent("pi", { bin }).run({ prompt: "PROMPT TEXT", cwd: dir, onActivity: (a) => activity.push(a) });
  assert.equal(parseReply(out).summary, "ok");
  assert.deepEqual(activity, ["reading weekly.plan", "running node --test"]);
  const argv = JSON.parse(readFileSync(bin + ".args", "utf8"));
  assert.deepEqual(argv.slice(0, 4), ["-p", "--mode", "json", "--no-session"]);
  assert.equal(argv.at(-1), "PROMPT TEXT");
});

test("an agent that exits without a reply is an error", async () => {
  const { bin, dir } = fake("pi", `process.stderr.write("No API key found"); process.exit(1);`);
  await assert.rejects(makeAgent("pi", { bin }).run({ prompt: "p", cwd: dir, onActivity() {} }), /No API key found/);
});

test("a model error inside pi's event stream is reported as such", async () => {
  const { bin, dir } = fake("pi", `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const msg = { role: "assistant", content: [], stopReason: "error", errorMessage: "UnrecognizedClientException: The security token included in the request is invalid." };
out({ type: "message_end", message: msg });
out({ type: "agent_end", messages: [msg] });
`);
  await assert.rejects(makeAgent("pi", { bin }).run({ prompt: "p", cwd: dir, onActivity() {} }), /security token included in the request is invalid/);
});
