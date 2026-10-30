#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { makeAgent, defaultAgent } from "../src/agents.ts";
import { AGENT_DIR } from "../src/paths.ts";
import { systemClock } from "../src/clock.ts";
import { openSession } from "../src/session.ts";
import { startServer } from "../src/server.ts";

const HELP = `underpaint: build software by taking turns on one pseudocode file

Usage
  underpaint [file.plan] [options]
  underpaint install-skill [claude|pi|both]

Options
  --agent <claude|pi|mock>   who holds the other pen (default: claude if installed, else pi)
  --agent-arg <arg>          extra argument for the agent CLI, repeatable (e.g. --agent-arg=--model --agent-arg=sonnet)
  --script <file.json>       turns for the mock agent
  --port <n>                 port to listen on (default 4747)
  --no-commit                don't commit each agent turn
  --open                     open the editor in your browser
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
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (positionals[0] === "install-skill") {
  const which = positionals[1] || "both";
  const targets = {
    claude: join(homedir(), ".claude", "skills", "underpaint"),
    pi: join(homedir(), ".pi", "agent", "skills", "underpaint"),
  };
  for (const [name, dir] of Object.entries(targets)) {
    if (which !== "both" && which !== name) continue;
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(AGENT_DIR, "SKILL.md"), join(dir, "SKILL.md"));
    console.log(`Installed the Underpaint skill for ${name} in ${dir}`);
  }
  process.exit(0);
}

const agentName = values.agent || defaultAgent();
const agent = makeAgent(agentName, { args: values["agent-arg"] || [], script: values.script && resolve(values.script), sleep: systemClock.sleep });
const session = openSession({ cwd: process.cwd(), planFile: positionals[0] || "underpaint.plan", agent, clock: systemClock, commit: !values["no-commit"] });
session.save();
const { url } = await startServer(session, { port: values.port ? Number(values.port) : 4747 });
console.log(`Underpaint is open at ${url}`);
console.log(`Plan: ${session.store.planPath}  Agent: ${agent.name}${session.log.commits ? "  Commits: one per agent turn" : ""}`);
if (values.open) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}
