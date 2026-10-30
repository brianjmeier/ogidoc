import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// An agent takes a prompt, works in the project directory with its own tools,
// and returns its final message as text. Progress arrives through onActivity.

export function makeAgent(name, opts = {}) {
  if (name === "claude") return claudeAgent(opts);
  if (name === "pi") return piAgent(opts);
  if (name === "mock") return mockAgent(opts);
  throw new Error(`Unknown agent "${name}". Use claude, pi or mock.`);
}

export function defaultAgent() {
  for (const name of ["claude", "pi"]) {
    if (spawnSync(process.platform === "win32" ? "where" : "which", [name]).status === 0) return name;
  }
  return "claude";
}

function claudeAgent({ bin = process.env.UNDERPAINT_CLAUDE || "claude", args = [] }) {
  return {
    name: "claude",
    run({ prompt, cwd, onActivity, signal }) {
      const argv = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep",
        ...args,
      ];
      return runJsonLines(bin, argv, { cwd, stdin: prompt, signal }, (ev, acc) => {
        if (ev.type === "assistant") {
          for (const c of ev.message?.content || []) {
            if (c.type === "tool_use") onActivity(describeTool(c.name, c.input));
            if (c.type === "text" && c.text) acc.text = c.text;
          }
        }
        if (ev.type === "result" && typeof ev.result === "string") {
          if (ev.is_error) acc.error = ev.result;
          else acc.final = ev.result;
        }
      });
    },
  };
}

function piAgent({ bin = process.env.UNDERPAINT_PI || "pi", args = [] }) {
  return {
    name: "pi",
    run({ prompt, cwd, onActivity, signal }) {
      const argv = ["-p", "--mode", "json", "--no-session", ...args, prompt];
      return runJsonLines(bin, argv, { cwd, signal }, (ev, acc) => {
        if (ev.type === "tool_execution_start") onActivity(describeTool(ev.toolName, ev.args));
        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          if (ev.message.stopReason === "error") acc.error = ev.message.errorMessage || "the model call failed";
          const text = textOf(ev.message);
          if (text) acc.text = text;
        }
        if (ev.type === "agent_end") {
          const last = [...(ev.messages || [])].reverse().find((m) => m.role === "assistant" && textOf(m));
          if (last) acc.final = textOf(last);
        }
      });
    },
  };
}

function textOf(message) {
  const c = message.content;
  if (typeof c === "string") return c;
  return (c || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

function runJsonLines(bin, argv, { cwd, stdin, signal }, onEvent) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Claude Code refuses to start inside another Claude Code session unless told otherwise.
    delete env.CLAUDECODE;
    const child = spawn(bin, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const acc = { text: "", final: "", error: "" };
    let buf = "";
    let err = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line), acc); } catch { /* not an event line */ }
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(new Error(`Could not start ${bin}: ${e.message}`)));
    child.on("close", (code) => {
      const out = acc.final || acc.text;
      if (out) resolve(out);
      else if (acc.error) reject(new Error(`${bin}: ${acc.error}`));
      else reject(new Error(`${bin} exited with code ${code} and no reply. ${err.trim().slice(-500)}`));
    });
    signal?.addEventListener("abort", () => child.kill("SIGTERM"));
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export function describeTool(name, input = {}) {
  const n = String(name).toLowerCase();
  const path = input.file_path || input.path || "";
  if (n === "edit" || n === "write" || n === "multiedit") return `editing ${path}`;
  if (n === "read") return `reading ${path}`;
  if (n === "bash") return `running ${String(input.command || "").split("\n")[0].slice(0, 80)}`;
  if (n === "grep" || n === "glob" || n === "find" || n === "ls") return "searching the code";
  return `using ${name}`;
}

// A scripted agent for tests and demos. The script is a JSON array of turns; each turn
// has the reply object, optional files to write, activity lines and a delay.
function mockAgent({ script }) {
  const turns = JSON.parse(readFileSync(script, "utf8"));
  let i = 0;
  return {
    name: "mock",
    async run({ cwd, onActivity }) {
      const t = turns[Math.min(i++, turns.length - 1)];
      for (const a of t.activity || []) {
        onActivity(a);
        await sleep((t.delay ?? 300) / Math.max(1, (t.activity || []).length));
      }
      for (const [rel, content] of Object.entries(t.writes || {})) {
        const p = join(cwd, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
      return `Done.\n\n\`\`\`json\n${JSON.stringify(t.reply, null, 2)}\n\`\`\``;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
