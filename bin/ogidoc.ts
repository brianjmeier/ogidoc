#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGENTS, makeAgent } from "../src/agents.ts";
import { AGENT_DIR } from "../src/paths.ts";
import { systemClock } from "../src/clock.ts";
import { openSession } from "../src/session.ts";
import { startServer } from "../src/server.ts";
import { sessionsIn } from "../src/plan-store.ts";
import { sessionToOpen, type Ask } from "../src/sessions.ts";
import { registry } from "../src/registry.ts";
import { describe, readState, summary, turnOver } from "../src/client.ts";

const HELP = `ogidoc: build software by taking turns with an agent on one pseudocode plan

Usage
  ogidoc [name] [options]      open a session (the one here, or a new one you name)
  ogidoc list                  the sessions running on this machine
  ogidoc status [name]         whose turn it is, and how the last turn went
  ogidoc wait [name]           wait until the agent's turn ends, then say how it went
  ogidoc stop [name]           stop a session
  ogidoc install-skill [claude|pi|both]

Options
  --detach                   run in the background and give the terminal back
  --open                     open the editor in your browser
  --agent <claude|pi|mock>   the agent that takes turns with you (default: claude if installed, else pi)
  --agent-arg <arg>          extra argument for the agent CLI, repeatable (e.g. --agent-arg=--model --agent-arg=sonnet)
  --script <file.json>       turns for the mock agent
  --port <n>                 port to listen on (default 4747)
  --no-commit                don't commit each agent turn
  --json                     status, wait and list print JSON
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string" },
    "agent-arg": { type: "string", multiple: true },
    script: { type: "string" },
    port: { type: "string" },
    "no-commit": { type: "boolean" },
    open: { type: "boolean" },
    detach: { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const cwd = realpathSync(process.cwd());
const home = process.env.OGIDOC_HOME || join(homedir(), ".ogidoc");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const sessions = registry({ dir: join(home, "sessions"), alive });
const print = (x: unknown) => console.log(values.json ? JSON.stringify(x, null, 2) : x);

const commands: Record<string, () => Promise<void> | void> = {
  "install-skill"() {
    const which = positionals[1] || "both";
    const targets = {
      claude: join(homedir(), ".claude", "skills", "ogidoc"),
      pi: join(homedir(), ".pi", "agent", "skills", "ogidoc"),
    };
    for (const [name, dir] of Object.entries(targets)) {
      if (which !== "both" && which !== name) continue;
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(AGENT_DIR, "chat", "SKILL.md"), join(dir, "SKILL.md"));
      console.log(`Installed the Ogidoc chat skill for ${name} in ${dir}`);
    }
  },
  list() {
    const all = sessions.list();
    if (values.json) return print(all);
    print(all.length ? all.map((s) => `${s.name}  ${s.url}  ${s.cwd}`).join("\n") : "No Ogidoc session is running.");
  },
  async status() {
    const s = sessions.pick({ given: positionals[1], cwd });
    const state = await readState(s.url);
    print(values.json ? summary(s, state) : describe(s, state));
  },
  async wait() {
    const s = sessions.pick({ given: positionals[1], cwd });
    const state = await turnOver(s.url, (now) =>
      console.error(now.working ? `Waiting for the agent's turn in ${s.name} to end…` : `Waiting for the next agent turn in ${s.name} to end…`),
    );
    print(values.json ? summary(s, state) : describe(s, state));
    if (state.last?.error) process.exitCode = 1;
  },
  // Only a session that answers is stopped, so a reused pid is never killed; one whose
  // agent is mid-turn is left to finish, since its turn would be lost.
  async stop() {
    const s = sessions.pick({ given: positionals[1], cwd });
    const state = await readState(s.url).catch(() => null);
    if (state?.name !== s.name) {
      if (alive(s.pid)) throw new Error(`${s.name} doesn't answer at ${s.url}. Its process is ${s.pid}.`);
      sessions.release(s.name, s.pid);
      return print(`${s.name} wasn't running anymore.`);
    }
    if (state.working) throw new Error(`The agent is taking a turn in ${s.name}. Stop it once the turn is over: ogidoc wait ${s.name} && ogidoc stop ${s.name}`);
    process.kill(s.pid, "SIGTERM");
    sessions.release(s.name, s.pid);
    print(`Stopped ${s.name}.`);
  },
};

// Asks in the terminal, when there is one to ask in.
const ask: Ask | undefined =
  process.stdin.isTTY && process.stdout.isTTY
    ? async (question, suggestion) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(`${question} (${suggestion}): `);
        } finally {
          rl.close();
        }
      }
    : undefined;

async function open() {
  const name = await sessionToOpen({ given: positionals[0], here: sessionsIn(cwd), folder: basename(cwd), ask });
  sessions.check(name, cwd);
  const log = join(home, "sessions", `${name}.log`);
  if (values.detach) return detach(name, log);

  // The first agent CLI on the path, else claude so the error names it.
  const installed = (cli: string) => spawnSync(process.platform === "win32" ? "where" : "which", [cli]).status === 0;
  const agentName = values.agent || AGENTS.find(installed) || "claude";
  const agent = makeAgent(agentName, { env: process.env, args: values["agent-arg"] || [], script: values.script && resolve(values.script), sleep: systemClock.sleep });
  const session = openSession({ cwd, name, agent, clock: systemClock, commit: !values["no-commit"] });
  session.save();
  const { url } = await startServer(session, { port: values.port ? Number(values.port) : 4747 });
  try {
    sessions.register({ name, cwd, url, pid: process.pid, agent: agent.name, log });
  } catch (e) {
    // The server is already listening, so leave rather than run unlisted.
    console.error((e as Error).message);
    process.exit(1);
  }
  process.on("exit", () => sessions.release(name, process.pid));
  // A turn running when the session is stopped is stopped too, and kept as a failed turn.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => session.stopTurn().finally(() => process.exit(0)));
  console.log(`Ogidoc session ${name} is open at ${url}`);
  console.log(`Agent: ${agent.name}${session.log.commits ? "  Commits: one per agent turn" : ""}`);
  // A detached parent waits for this to know the session is up.
  process.send?.({ url });
  if (values.open) openBrowser(url);
}

// Start the same session in a process that outlives this one, writing its output to the
// log, and hand the terminal back once it is listening.
function detach(name: string, log: string) {
  mkdirSync(join(home, "sessions"), { recursive: true });
  const out = openSync(log, "a");
  const args = [
    name,
    ...(values.agent ? ["--agent", values.agent] : []),
    ...(values["agent-arg"] || []).map((a) => `--agent-arg=${a}`),
    ...(values.script ? ["--script", resolve(values.script)] : []),
    ...(values.port ? ["--port", values.port] : []),
    ...(values["no-commit"] ? ["--no-commit"] : []),
  ];
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args], {
    cwd,
    detached: true,
    stdio: ["ignore", out, out, "ipc"],
  });
  const failed = (code: number | null) => {
    console.error(`The session didn't start (exit ${code}).\n${readFileSync(log, "utf8").trim().split("\n").slice(-10).join("\n")}`);
    process.exitCode = 1;
  };
  child.once("exit", failed);
  child.once("message", (m: { url: string }) => {
    child.off("exit", failed);
    console.log(`Ogidoc session ${name} is open at ${m.url}`);
    console.log(`It runs in the background. Stop it with: ogidoc stop ${name}`);
    if (values.open) openBrowser(m.url);
    child.disconnect();
    child.unref();
  });
}

function openBrowser(url: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

try {
  await (Object.hasOwn(commands, positionals[0] ?? "") ? commands[positionals[0]] : open)();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
