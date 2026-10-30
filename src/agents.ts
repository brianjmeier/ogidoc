import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Choices } from "./types.ts";
import type { Clock } from "./clock.ts";

export interface Agent {
  name: string;
  choices: Choices;
  // Whether the CLI takes this model name: one of `choices.models` or a full name in the
  // CLI's own form. It goes into the CLI's arguments, so nothing else gets through.
  acceptsModel(name: string): boolean;
  run(opts: {
    prompt: string;
    cwd: string;
    model?: string;
    effort?: string;
    onActivity: (a: string) => void;
    signal?: AbortSignal;
  }): Promise<string>;
}

type Env = Record<string, string | undefined>;

interface AgentOpts {
  // The environment the agent CLI runs in; UNDERPAINT_CLAUDE and UNDERPAINT_PI there
  // point at a different executable.
  env: Env;
  bin?: string;
  args?: string[];
  script?: string;
  // Paces the mock agent's activity.
  sleep?: Clock["sleep"];
}

// What a CLI's event stream has told us so far.
interface Acc {
  text: string;
  final: string;
  error: string;
}

// An agent takes a prompt, works in the project directory with its own tools,
// and returns its final message as text. Progress arrives through onActivity.
// `choices` lists the models and efforts the browser offers; an empty model or
// effort leaves the CLI's own default in place.

export function makeAgent(name: string, opts: AgentOpts): Agent {
  if (name === "claude") return claudeAgent(opts);
  if (name === "pi") return piAgent(opts);
  if (name === "mock") {
    if (!opts.script) throw new Error("The mock agent needs --script.");
    if (!opts.sleep) throw new Error("The mock agent needs a clock to pace its turns.");
    return mockAgent({ script: opts.script, sleep: opts.sleep });
  }
  throw new Error(`Unknown agent "${name}". Use claude, pi or mock.`);
}

export const AGENTS = ["claude", "pi"];

const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"];

function claudeAgent({ env, bin = env.UNDERPAINT_CLAUDE || "claude", args = [] }: AgentOpts): Agent {
  // Claude Code refuses to start inside another Claude Code session unless told otherwise.
  const { CLAUDECODE: _, ...childEnv } = env;
  return {
    name: "claude",
    choices: { models: CLAUDE_MODELS, efforts: ["low", "medium", "high", "xhigh", "max"] },
    acceptsModel: (m) => CLAUDE_MODELS.includes(m) || /^claude-[a-z0-9.-]+(\[1m\])?$/.test(m),
    run({ prompt, cwd, onActivity, signal, model, effort }) {
      const argv = [
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep",
        ...args,
      ];
      return runJsonLines(bin, argv, { cwd, env: childEnv, stdin: prompt, signal }, (ev, acc) => {
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

function piAgent({ env, bin = env.UNDERPAINT_PI || "pi", args = [] }: AgentOpts): Agent {
  return {
    name: "pi",
    choices: { models: [], efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    // pi names models as provider/model, e.g. anthropic/claude-opus-5-5.
    acceptsModel: (m) => /^\w[\w.:/-]*$/.test(m),
    run({ prompt, cwd, onActivity, signal, model, effort }) {
      const argv = [
        "-p", "--mode", "json", "--no-session",
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--thinking", effort] : []),
        ...args, prompt,
      ];
      return runJsonLines(bin, argv, { cwd, env, signal }, (ev, acc) => {
        if (ev.type === "tool_execution_start") onActivity(describeTool(ev.toolName, ev.args));
        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          if (ev.message.stopReason === "error") acc.error = ev.message.errorMessage || "the model call failed";
          const text = textOf(ev.message);
          if (text) acc.text = text;
        }
        if (ev.type === "agent_end") {
          const last = [...(ev.messages || [])].reverse().find((m: any) => m.role === "assistant" && textOf(m));
          if (last) acc.final = textOf(last);
        }
      });
    },
  };
}

function textOf(message: any): string {
  const c = message.content;
  if (typeof c === "string") return c;
  return (c || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
}

// Each CLI prints one JSON event per line; `onEvent` reads them into `acc`.
function runJsonLines(
  bin: string,
  argv: string[],
  { cwd, env, stdin, signal }: { cwd: string; env: Env; stdin?: string; signal?: AbortSignal },
  onEvent: (ev: any, acc: Acc) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const acc: Acc = { text: "", final: "", error: "" };
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

function describeTool(name: string, input: Record<string, unknown> = {}): string {
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
interface MockTurn {
  reply: unknown;
  writes?: Record<string, string>;
  activity?: string[];
  delay?: number;
}

function mockAgent({ script, sleep }: { script: string; sleep: Clock["sleep"] }): Agent {
  const turns: MockTurn[] = JSON.parse(readFileSync(script, "utf8"));
  let i = 0;
  return {
    name: "mock",
    choices: { models: [], efforts: [] },
    acceptsModel: () => false,
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

