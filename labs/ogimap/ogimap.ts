#!/usr/bin/env node
// Ogimap: change a codebase by editing its flow map. A proof of concept on top of
// Ogidoc's agent adapters.
//
//   node labs/ogimap/ogimap.ts [dir] [--agent claude|pi|mock] [--agent-cmd "<cmd>"]
//                              [--port 4848] [--remap] [--demo] [--open]
//                              [--task "<prompt>"] [--task-file brief.json] [--script turns.json] [--detach]
//
// A task goes: scope (a read-only chat, from your prompt) → frame (the agent draws the
// part of the map the task touches, with the change on it) → map (you and the agent
// take turns on the map; code is built underneath) → done.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { text } from "node:stream/consumers";
import type { AddressInfo } from "node:net";
import { makeAgent, type Agent } from "../../src/agents.ts";
import { checkMap, driftOf, focusOf, indexOf, intentOf, mergeRegion, regionIds, regionOf, stamped, type FlowMap } from "./map.ts";
import { MAP_FILE, REGION_FILE, framePrompt, mapPrompt, parseReply, parseScope, scopePrompt, turnPrompt, type Task } from "./prompt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "web");

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string" },
    "agent-cmd": { type: "string" },
    port: { type: "string", default: "4848" },
    remap: { type: "boolean", default: false },
    demo: { type: "boolean", default: false },
    open: { type: "boolean", default: false },
    task: { type: "string" },
    script: { type: "string" },
    detach: { type: "boolean", default: false },
    "task-file": { type: "string" },
  },
});

// ---------- the project and its agent ----------

let project = resolve(positionals[0] ?? ".");

// --detach: run the server in the background and print where it listens, as JSON, once
// it does. A Tend station starts Ogimap this way.
if (opts.detach && !opts.demo) {
  const serverFile = join(project, ".ogimap", "server.json");
  rmSync(serverFile, { force: true });
  const args = process.argv.slice(1).filter((a) => a !== "--detach");
  spawn(process.execPath, args, { cwd: process.cwd(), detached: true, stdio: "ignore" }).unref();
  for (const until = Date.now() + 15_000; Date.now() < until; await new Promise((r) => setTimeout(r, 150))) {
    if (existsSync(serverFile)) {
      process.stdout.write(readFileSync(serverFile, "utf8") + "\n");
      process.exit(0);
    }
  }
  console.error(`Ogimap didn't start in ${project}.`);
  process.exit(1);
}
let agentName = opts["agent-cmd"] ? "command" : (opts.agent ?? "claude");
let script: string | undefined = opts.script && resolve(opts.script);
if (script && !opts.agent) agentName = "mock";

if (opts.demo) {
  // A throwaway copy of the demo project, with its map already drawn, and a scripted agent.
  project = mkdtempSync(join(tmpdir(), "ogimap-demo-"));
  cpSync(join(HERE, "demo", "shortener"), project, { recursive: true });
  mkdirSync(join(project, ".ogimap"), { recursive: true });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=ogimap", "-c", "user.email=ogimap@localhost", "commit", "-qm", "the demo project");
  if (!opts.agent) {
    agentName = "mock";
    // A task scoped elsewhere (a Tend session) starts at its map: the script without the scoping.
    script ??= join(HERE, "demo", opts["task-file"] ? "turns-from-brief.json" : "turns.json");
  }
}

const agent: Agent = makeAgent(agentName, {
  env: process.env,
  command: opts["agent-cmd"],
  script,
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
});

// Scoping only reads. Claude Code can be held to that; other CLIs are told so.
const reader: Agent = agentName === "claude"
  ? makeAgent("claude", { env: process.env, args: ["--disallowedTools", "Edit,Write,NotebookEdit,Bash"] })
  : agent;

// The scripted demo says what to try next, since its agent plays the same turns whatever you edit.
const hints: string[] = script ? (JSON.parse(readFileSync(script, "utf8")).hints ?? []) : [];

const mapPath = join(project, MAP_FILE);
const layoutPath = join(project, ".ogimap", "layout.json");
const rulesPath = join(project, ".ogimap", "rules.md");
const taskPath = join(project, ".ogimap", "task.json");
const regionPath = join(project, REGION_FILE);

const state = {
  map: existsSync(mapPath) ? checkMap(JSON.parse(readFileSync(mapPath, "utf8"))) : null as FlowMap | null,
  busy: null as null | "mapping" | "turn" | "scoping" | "framing",
  task: (existsSync(taskPath) ? JSON.parse(readFileSync(taskPath, "utf8")) : null) as Task | null,
  activity: [] as string[],
  last: null as null | { summary: string; changed: string[]; error?: string },
  turn: 0,
};

// ---------- git: one commit per turn, so a turn can be undone ----------

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const isRepo = () => existsSync(join(project, ".git"));
const ID = ["-c", "user.name=ogimap", "-c", "user.email=ogimap@localhost"];

function commitTurn(summary: string) {
  if (!isRepo()) return;
  try {
    git("add", "-A");
    git(...ID, "commit", "-qm", `ogimap: ${summary || "turn"}`);
  } catch {}
}

// What each file the map anchors to hashes to now, as git hashes a blob; null for a
// file that is gone. A box is stale when this differs from what it saw.
function hashesOf(files: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const present = files.filter((f) => existsSync(join(project, f)));
  for (const f of files) out.set(f, null);
  if (!present.length) return out;
  try {
    const hashes = execFileSync("git", ["hash-object", "--", ...present], { cwd: project, encoding: "utf8" }).trim().split("\n");
    present.forEach((f, i) => out.set(f, hashes[i] ?? null));
  } catch {}
  return out;
}
const hasherFor = (map: FlowMap) => {
  const hashes = hashesOf([...new Set(map.nodes.flatMap((n) => [...(n.code ?? []).map((c) => c.file), ...Object.keys(n.seen ?? {})]))]);
  return (file: string) => hashes.get(file) ?? null;
};
const drift = (): string[] => (state.map ? driftOf(state.map, hasherFor(state.map)) : []);

// After an agent writes its region: the boxes it drew, changed or re-read get fresh
// stamps; the context it handed back as it was keeps the stamp it had.
function restamp(before: FlowMap | null, after: FlowMap, alsoFresh: Iterable<string>): FlowMap {
  const was = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  const plain = (n: FlowMap["nodes"][number]) => JSON.stringify({ ...n, seen: undefined });
  const fresh = new Set(alsoFresh);
  const kept = after.nodes.map((n) => {
    const old = was.get(n.id);
    if (!old || plain(old) !== plain(n)) fresh.add(n.id);
    return old?.seen && !fresh.has(n.id) ? { ...n, seen: old.seen } : n;
  });
  const map = { ...after, nodes: kept };
  return stamped(map, fresh, hasherFor(map));
}

// A checkout Ogimap runs in versions its map like code: the map rebases and merges by
// node (the merge driver), and what belongs to this checkout alone stays out of git.
function versionTheMap() {
  if (!isRepo()) return;
  try {
    git("config", "merge.ogimap.name", "Ogimap map, merged by node");
    git("config", "merge.ogimap.driver", `node '${join(HERE, "merge.ts")}' %O %A %B`);
    const attributes = join(project, ".gitattributes");
    const rule = `${MAP_FILE} merge=ogimap`;
    const lines = existsSync(attributes) ? readFileSync(attributes, "utf8").split("\n") : [];
    if (!lines.includes(rule)) writeFileSync(attributes, [...lines.filter(Boolean), rule].join("\n") + "\n");
  } catch {}
}

function canUndo(): boolean {
  if (!isRepo()) return false;
  try {
    return git("log", "-1", "--format=%s").startsWith("ogimap: ");
  } catch {
    return false;
  }
}

// ---------- events to the browser ----------

const clients = new Set<ServerResponse>();
function send(ev: object) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(data);
}
// The map is versioned with the code, so git can change it under a running server
// (a rebase onto main, a pull, a checkout). Between turns, read it again when it did.
let mapStamp = existsSync(mapPath) ? statSync(mapPath).mtimeMs : 0;
function followDisk() {
  if (state.busy || !existsSync(mapPath)) return;
  const now = statSync(mapPath).mtimeMs;
  if (now === mapStamp) return;
  mapStamp = now;
  try {
    state.map = checkMap(JSON.parse(readFileSync(mapPath, "utf8")));
  } catch {}
}

const snapshot = () => (followDisk(), {
  map: state.map,
  layout: existsSync(layoutPath) ? JSON.parse(readFileSync(layoutPath, "utf8")) : {},
  busy: state.busy,
  activity: state.activity.slice(-6),
  last: state.last,
  canUndo: canUndo(),
  project: relative(process.cwd(), project).startsWith("..") ? basename(project) : relative(process.cwd(), project) || ".",
  agent: agent.name,
  hint: hints[Math.min(state.turn, hints.length - 1)] ?? null,
  task: state.task,
  drift: drift(),
}) as const;
const publish = () => send({ type: "state", ...snapshot() });

function activity(a: string) {
  a = a.replaceAll(project + sep, "");
  state.activity.push(a);
  send({ type: "activity", text: a });
}

// ---------- turns ----------

// Reads what the agent wrote into the new map: the whole map when mapping, a region
// merged into the map otherwise.
type Collect = { file: string; read: () => FlowMap };

const wholeMap: Collect = {
  file: MAP_FILE,
  read: () => {
    const map = checkMap(JSON.parse(readFileSync(mapPath, "utf8")));
    const all = stamped(map, map.nodes.map((n) => n.id), hasherFor(map));
    writeFileSync(mapPath, JSON.stringify(all, null, 1));
    return all;
  },
};

// `returned` collects the ids the agent handed back, for the task's focus.
const regionMerged = (sent: Set<string>, returned: Set<string>, reread: Iterable<string> = []): Collect => ({
  file: REGION_FILE,
  read: () => {
    if (!existsSync(regionPath)) throw new Error(`${REGION_FILE} is missing`);
    const back = JSON.parse(readFileSync(regionPath, "utf8")) as FlowMap;
    const merged = restamp(state.map, mergeRegion(state.map, sent, back), reread);
    for (const n of back.nodes) returned.add(n.id);
    writeFileSync(mapPath, JSON.stringify(merged, null, 1));
    mapStamp = statSync(mapPath).mtimeMs;
    rmSync(regionPath, { force: true });
    return merged;
  },
});

async function runAgent(prompt: string, collect: Collect = wholeMap): Promise<{ summary: string; changed: string[] }> {
  let resume: string | undefined;
  let reply = parseReply(await agent.run({ prompt, cwd: project, onActivity: activity, onSession: (id) => (resume = id) }));
  for (let tries = 0; ; tries++) {
    try {
      state.map = collect.read();
      return reply;
    } catch (e) {
      // One chance to fix it, in the same conversation when the CLI can carry one on.
      if (tries > 0 || agent.name === "mock") throw e;
      activity(`${collect.file} didn't check out; asking for a fix`);
      const fix = `${collect.file} is not right: ${(e as Error).message}. Fix the file, then reply with the same JSON block.`;
      reply = parseReply(await agent.run({ prompt: resume ? fix : `${prompt}\n\n# Before you start\n\n${fix}`, cwd: project, onActivity: activity, resume }));
    }
  }
}

async function guarded(kind: "mapping" | "turn" | "framing", work: () => Promise<{ summary: string; changed: string[] }>) {
  state.busy = kind;
  state.activity = [];
  publish();
  try {
    const r = await work();
    state.turn++;
    commitTurn(r.summary);
    state.last = r;
  } catch (e) {
    state.last = { summary: "", changed: [], error: (e as Error).message };
  } finally {
    state.busy = null;
    publish();
  }
}

const remap = () => guarded("mapping", () => runAgent(mapPrompt()));

// What a turn works in: the task's region, what the person touched, and nodes whose code
// changed under the map. With no task, the whole map.
function turnRegion(before: FlowMap, draft: FlowMap, focus: string[], drifted: string[]): Set<string> {
  if (!state.task?.focus) return new Set(before.nodes.map((n) => n.id));
  const was = new Map(before.nodes.map((n) => [n.id, n]));
  const touched = draft.nodes.filter((n) => {
    const o = was.get(n.id);
    return o && (n.removed || o.name !== n.name || o.pseudo.join("\n") !== n.pseudo.join("\n") || (o.parent ?? null) !== (n.parent ?? null));
  }).map((n) => n.id);
  const parents = draft.nodes.filter((n) => !was.has(n.id) && n.parent).map((n) => n.parent!);
  const wired = draft.edges.filter((e) => e.by === "human" || e.removed).flatMap((e) => [e.from, e.to]);
  return regionIds(before, [...state.task.focus, ...touched, ...parents, ...wired, ...focus, ...drifted]);
}

function turn(draft: FlowMap, focus: string[]) {
  const before = state.map!;
  const intent = intentOf(before, draft, focus);
  const drifted = drift();
  const ids = turnRegion(before, draft, focus, drifted);
  const region = regionOf(before, ids);
  mkdirSync(dirname(regionPath), { recursive: true });
  writeFileSync(regionPath, JSON.stringify(region, null, 1));
  activity("the pen is with the agent");
  const rules = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";
  return guarded("turn", async () => {
    const returned = new Set<string>();
    const r = await runAgent(turnPrompt({ region, intent, rules, task: state.task, drift: drifted.filter((id) => ids.has(id)) }), regionMerged(ids, returned, drifted.filter((id) => ids.has(id))));
    const task = state.task;
    if (task && state.map) {
      const map = state.map;
      // The task keeps what it worked in, minus what the turn deleted, plus what it added
      // or changed. The context a turn was handed and handed back unchanged stays out.
      const added = [...returned].filter((id) => !before.nodes.some((n) => n.id === id));
      task.focus = [...focusOf(map, [...(task.focus ?? []), ...added, ...r.changed])];
      // The task is done when nothing in its part of the map waits for a build.
      const mine = new Set(task.focus);
      if (!map.nodes.some((n) => mine.has(n.id) && (n.status === "stale" || n.status === "proposal"))) task.phase = "done";
      saveTask();
    }
    return r;
  });
}

// ---------- tasks: prompt → scope → frame → map ----------

function saveTask() {
  mkdirSync(dirname(taskPath), { recursive: true });
  if (state.task) writeFileSync(taskPath, JSON.stringify(state.task, null, 1));
}

async function scope(said: string) {
  const task = state.task!;
  task.messages.push({ who: "you", text: said });
  saveTask();
  state.busy = "scoping";
  state.activity = [];
  publish();
  try {
    const text = await reader.run({
      prompt: scopePrompt({ task, map: state.map, said }),
      cwd: project,
      onActivity: activity,
      resume: task.session,
      onSession: (id) => (task.session = id),
    });
    const r = parseScope(text);
    task.messages.push({ who: "agent", text: r.text, refs: r.refs });
    if (r.title) task.title = r.title;
    if (r.ready) {
      task.brief = r.brief;
      task.phase = "frame";
    }
    state.last = null;
    state.turn++;
  } catch (e) {
    state.last = { summary: "", changed: [], error: (e as Error).message };
  } finally {
    saveTask();
    state.busy = null;
    publish();
  }
  if (task.phase === "frame") await frame();
}

// Framing may only write the map. Anything else it touched goes back as it was.
function changedFiles(): Set<string> {
  if (!isRepo()) return new Set();
  return new Set(git("status", "--porcelain", "-uall").split("\n").filter(Boolean).map((l) => l.slice(3)));
}

async function frame() {
  const before = changedFiles();
  await guarded("framing", async () => {
    rmSync(regionPath, { force: true });
    const index = state.map ? indexOf(state.map, drift()) : "";
    const returned = new Set<string>();
    const r = await runAgent(framePrompt({ task: state.task!, index }), regionMerged(new Set(), returned));
    state.task!.focus = [...focusOf(state.map!, returned)];
    for (const f of changedFiles()) {
      if (before.has(f) || f.startsWith(".ogimap/")) continue;
      activity(`framing may not change ${f}; put back`);
      try { git("checkout", "--", f); } catch { try { git("rm", "-qf", "--cached", f); } catch {} rmSync(join(project, f), { force: true }); }
    }
    state.task!.phase = "map";
    saveTask();
    return { summary: r.summary || `the map for: ${state.task!.title}`, changed: [...returned] };
  });
}

function startTask(body: { prompt?: string; title?: string; brief?: string; messages?: Task["messages"] }) {
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) throw new Error("a task starts with a prompt");
  state.task = { prompt, title: body.title, phase: "scope", messages: body.messages ?? [] };
  state.turn = 0;
  // A task scoped somewhere else (a Tend session, say) goes straight to its map.
  if (body.brief) {
    state.task.brief = body.brief;
    state.task.phase = "frame";
    saveTask();
    void frame();
  } else void scope(prompt);
}

// A task file is read before the server listens, so a bad one fails the start instead
// of leaving a server that answers nothing.
const taskFile: Parameters<typeof startTask>[0] | null = opts["task-file"] ? JSON.parse(readFileSync(opts["task-file"], "utf8")) : null;

// ---------- http ----------

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Same rule as Ogidoc: a turn runs an agent that edits files, so only a page this
// server served, on this machine, may start one.
function trusted(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!LOCAL.has(host.replace(/:\d+$/, ""))) return false;
  if (req.method !== "POST") return true;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return (req.headers["content-type"] ?? "").startsWith("application/json");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// A slice of a file in the project, for the code drawer. Never outside the project.
function codeSlice(file: string, line: number) {
  const p = normalize(join(project, file));
  if (!p.startsWith(project + sep) || p.includes(`${sep}.git${sep}`)) throw new Error("outside the project");
  const lines = readFileSync(p, "utf8").split("\n");
  const at = Math.max(1, Math.min(line || 1, lines.length));
  const start = Math.max(1, at - 4);
  return { file, line: at, start, lines: lines.slice(start - 1, start + 39) };
}

const server = createServer(async (req, res) => {
  if (!trusted(req)) return json(res, 403, { error: "forbidden" });
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      res.write(`data: ${JSON.stringify({ type: "state", ...snapshot() })}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/state") return json(res, 200, snapshot());
    if (url.pathname === "/api/code") return json(res, 200, codeSlice(url.searchParams.get("file") ?? "", Number(url.searchParams.get("line"))));
    if (req.method === "POST") {
      const body = JSON.parse((await text(req)) || "{}");
      if (url.pathname === "/api/intent") return json(res, 200, { intent: state.map ? intentOf(state.map, body.draft, body.focus ?? []) : "" });
      if (state.busy) return json(res, 409, { error: "the agent has the pen" });
      if (url.pathname === "/api/turn") {
        if (!state.map) return json(res, 409, { error: "no map yet" });
        void turn(body.draft, body.focus ?? []);
        return json(res, 202, {});
      }
      if (url.pathname === "/api/task") {
        startTask(body);
        return json(res, 202, {});
      }
      if (url.pathname === "/api/ask") {
        if (state.task?.phase !== "scope") return json(res, 409, { error: "not scoping" });
        void scope(String(body.text ?? "").trim() || "go on");
        return json(res, 202, {});
      }
      if (url.pathname === "/api/task/close") {
        state.task = null;
        rmSync(taskPath, { force: true });
        publish();
        return json(res, 200, {});
      }
      if (url.pathname === "/api/remap") {
        void remap();
        return json(res, 202, {});
      }
      if (url.pathname === "/api/layout") {
        mkdirSync(dirname(layoutPath), { recursive: true });
        writeFileSync(layoutPath, JSON.stringify(body.layout ?? {}, null, 1));
        return json(res, 200, {});
      }
      if (url.pathname === "/api/undo") {
        if (!canUndo()) return json(res, 409, { error: "nothing to undo" });
        git(...ID, "revert", "--no-edit", "HEAD");
        state.map = existsSync(mapPath) ? checkMap(JSON.parse(readFileSync(mapPath, "utf8"))) : null;
        state.last = { summary: "undid the last turn", changed: [] };
        publish();
        return json(res, 200, {});
      }
      return json(res, 404, { error: "no such action" });
    }
    const file = normalize(join(WEB, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(WEB + sep)) return json(res, 404, {});
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

server.listen(Number(opts.port), "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const url = `http://localhost:${port}`;
  // Where to find this server, for whoever started it in the background (a Tend station).
  mkdirSync(join(project, ".ogimap"), { recursive: true });
  writeFileSync(join(project, ".ogimap", "server.json"), JSON.stringify({ port, pid: process.pid, url }));
  versionTheMap();
  // Where the server listens, a turn's region in flight, this checkout's task and its
  // layout are never part of the map, which travels with the branch.
  const ignore = join(project, ".ogimap", ".gitignore");
  const ignored = existsSync(ignore) ? readFileSync(ignore, "utf8").split("\n") : [];
  const missing = ["server.json", "region.json", "task.json", "layout.json"].filter((f) => !ignored.includes(f));
  if (missing.length) writeFileSync(ignore, [...ignored.filter(Boolean), ...missing].join("\n") + "\n");
  console.log(`Ogimap on ${url}\n  project: ${project}\n  agent:   ${agent.name}`);
  if (opts.open) spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  if (taskFile) startTask(taskFile);
  else if (opts.task) startTask({ prompt: opts.task });
  else if (opts.remap) void remap();
});
