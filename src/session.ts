import { EventEmitter } from "node:events";
import * as plan from "./plan.ts";
import type { Plan } from "./plan.ts";
import * as threads from "./threads.ts";
import * as choices from "./choices.ts";
import { buildPrompt, notATurn, parseReply, readAgentFile } from "./prompt.ts";
import { planStore, type Loaded, type PlanStore, type SessionState } from "./plan-store.ts";
import { turnLog, type TurnLog } from "./turn-log.ts";
import type { Clock } from "./clock.ts";
import type { Agent } from "./agents.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AnimationOp, Box, BoxChanges, Edit, HumanDiff, MapView, Reply, Settings, Snapshot, Thread } from "./types.ts";
import { driftOf, mapView, stamped } from "./map.ts";
import { describeAsk, describeBox } from "./describe-box.ts";
import { MAP_FILE } from "./map-store.ts";
import { headOf, repoIO, scanRepo, type RepoIO } from "./scan-repo.ts";
import type { Skeleton } from "./scan.ts";
import { isCode } from "./languages/index.ts";
import { CLI } from "./paths.ts";

interface EditInput {
  text?: string;
  boxes?: Record<string, string>;
  accepted?: number[];
}

// How many replies the agent gets to end its turn properly before the turn fails.
const TURN_ATTEMPTS = 3;

// Put a session together from where its plan lives, the agent, and the clock.
export function openSession({ cwd, name, agent, reader, clock, commit = true }: { cwd: string; name: string; agent: Agent; reader?: Agent; clock: Clock; commit?: boolean }): Session {
  const store = planStore(cwd, name);
  const saved = store.load();
  const log = turnLog({ cwd: store.cwd, ownFiles: store.ownFiles, commit, saved: saved.log });
  const io = repoIO(store.cwd);
  if (log.commits) versionTheMap(store.cwd, io);
  // The scan reads the working tree, so it reads again when the commit or an uncommitted
  // code file changed.
  const stamp = () => [headOf(io), ...[...log.begin()].filter(([p]) => isCode(p)).map(([p, hash]) => `${p} ${hash}`)].join("\n");
  const scanner: Scanner = { scan: () => scanRepo(basename(store.cwd), io), stamp };
  return new Session({ store, saved, log, agent, reader: reader ?? agent, clock, scanner });
}

// Reads the code into the skeleton of the map, and says which code it would read: the
// scan runs again only when that changed.
export interface Scanner {
  scan(): Skeleton | null;
  stamp(): string;
}

// A checkout the editor commits to versions its map like code: git merges the map box by
// box, through \`ogidoc merge-map\`.
export function versionTheMap(root: string, io: RepoIO) {
  io.git(["config", "merge.ogidoc.name", "Ogidoc map, merged box by box"]);
  io.git(["config", "merge.ogidoc.driver", `'${process.execPath}' '${CLI}' merge-map %O %A %B`]);
  const rule = `${MAP_FILE} merge=ogidoc`;
  const path = join(root, ".gitattributes");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  if (!lines.includes(rule)) writeFileSync(path, [...lines.filter(Boolean), rule].join("\n") + "\n");
}

// One plan file and its boxes, shared by a person and an agent who take turns.
// Conversation lives beside the plan, not in it: comment threads pinned to plan lines.

export class Session extends EventEmitter {
  store: PlanStore;
  agent: Agent;
  clock: Clock;
  log: TurnLog;
  working = false;
  // Stops the agent's turn when aborted.
  private turnAbort = new AbortController();
  // The plan was done and the person removed it; the code stays.
  finished = false;
  activity: string[] = [];
  private s: SessionState;
  private scanner: Scanner;
  // Reads the code to say what a box does; it may not change anything.
  private reader: Agent;
  // The box being described while one is, and how the last describe went.
  private describing: { id: string | null } | null = null;
  private described: { id: string | null; summary?: string; error?: string } | null = null;
  // The code as the last scan read it, and the stamp of what it read.
  private skeleton: Skeleton | null = null;
  private scannedAt: string | null = null;
  private shown: { key: unknown[]; view: MapView } | null = null;
  // Goes up whenever the map changes, so the browser knows to fetch it again.
  private mapRev = 0;
  // Boxes whose code changed since they last said what it does, as of the last look.
  private drifted: string[] = [];

  constructor({ store, saved, log, agent, reader, clock, scanner }: { store: PlanStore; saved: Loaded; log: TurnLog; agent: Agent; reader: Agent; clock: Clock; scanner: Scanner }) {
    super();
    this.reader = reader;
    this.scanner = scanner;
    this.rescan();
    this.store = store;
    this.log = log;
    this.agent = agent;
    this.clock = clock;
    this.s = saved.state;
    // Someone may have edited the files in another editor; carry what we know across.
    this.setPlan(plan.fromFiles(this.plan, saved.planText, saved.map));
    this.drifted = this.driftNow();
  }

  get name() {
    return this.store.name;
  }

  save() {
    if (this.finished) return;
    this.store.save(this.s, this.log.saved());
  }

  // ---------- what the browser sees ----------

  snapshot(): Snapshot {
    const { history, base, ...s } = this.s;
    return {
      ...s,
      name: this.name,
      planPath: this.store.displayPath,
      agent: this.agent.name,
      settingOptions: this.agent.settingOptions,
      working: this.working,
      activity: this.activity.slice(-6),
      done: plan.isDone(this.plan, s.last),
      finished: this.finished,
      canUndo: history.length > 0 && !this.working,
      drifted: this.drifted,
      mapRev: this.mapRev,
      describing: this.describing,
      described: this.described,
    };
  }

  // The whole map: the scan of the code with the boxes on it. Too big to send with every
  // keystroke, so the browser fetches it when \`mapRev\` moves.
  map(): MapView {
    this.rescan();
    const key = [this.skeleton, this.s.boxes, this.s.edges];
    if (!this.shown || this.shown.key.some((k, i) => k !== key[i])) this.shown = { key, view: mapView(this.skeleton, this.s.boxes, this.s.edges) };
    return this.shown.view;
  }

  // The boxes of the code, as the map shows them now. Looked up only when an edit or a
  // reply names a box, so typing in the plan doesn't read the code.
  private scanned: plan.Scanned = (id) => plan.scannedIn(this.map())(id);

  // Scan again when the code changed since the last scan.
  private rescan() {
    const stamp = this.scanner.stamp();
    if (stamp === this.scannedAt) return;
    this.skeleton = this.scanner.scan();
    this.scannedAt = stamp;
    this.mapRev++;
  }

  // Each box remembers the hash of the files it points at; one that hashes differently now
  // says what the code did before someone changed it.
  private hashOf(boxes: Box[]): (file: string) => string | null {
    const hashes = this.log.hashes([...new Set(boxes.flatMap((b) => [...(b.code ?? []).map((c) => c.file), ...Object.keys(b.seen ?? {})]))]);
    return (file) => hashes.get(file) ?? null;
  }

  // The boxes a turn is about: the ones the person changed, the ones not built yet, and the
  // ones on code that changed, by drift or by the last turn.
  private seeds(diff: HumanDiff, changedFiles: string[]): string[] {
    const files = new Set([...changedFiles, ...(this.s.last?.files ?? []).map((f) => f.path)]);
    return this.s.boxes
      .filter((b) => diff.boxes.some((d) => d.id === b.id) || b.status !== "built" || this.drifted.includes(b.id) || b.code?.some((c) => files.has(c.file)))
      .map((b) => b.id);
  }

  private driftNow(): string[] {
    const seen = this.s.boxes.filter((b) => b.seen);
    return seen.length ? driftOf(seen, this.hashOf(seen)) : [];
  }

  // The model and effort the next agent turn runs with; empty means the CLI's default.
  setSettings({ model, effort }: Partial<Settings> = {}) {
    const name = model === undefined ? undefined : String(model).trim();
    if (name && !this.agent.acceptsModel(name)) throw new Error(`${this.agent.name} has no model "${name}".`);
    if (effort && !this.agent.settingOptions.efforts.includes(effort)) throw new Error(`${this.agent.name} has no effort "${effort}".`);
    this.s.settings = { ...this.s.settings, ...(name !== undefined && { model: name }), ...(effort !== undefined && { effort }) };
    this.changed();
  }

  // The person's changes are refused during the agent's turn.
  private guard(working = "It's the agent's turn.") {
    if (this.finished) throw new Error("This plan is built and removed.");
    if (this.working) throw new Error(working);
  }

  private changed() {
    this.save();
    this.emit("change", {});
  }

  private get plan(): Plan {
    return { lines: this.s.lines, boxes: this.s.boxes, edges: this.s.edges, threads: this.s.threads, choices: this.s.choices };
  }

  private setPlan(p: Plan) {
    if (p.boxes !== this.s.boxes || p.edges !== this.s.edges) this.mapRev++;
    this.s = { ...this.s, ...p };
  }

  // ---------- the person's turn ----------

  comment({ line, text }: { line: number; text: string }): Thread {
    this.guard();
    if (!Number.isInteger(line) || line < 0 || line >= Math.max(1, this.s.lines.length)) throw new Error("That line isn't in the plan.");
    if (!String(text || "").trim()) throw new Error("A comment needs some text.");
    this.s.threads = threads.add(this.s.threads, { line, by: "h", text: text.trim(), turn: this.s.turn });
    this.changed();
    return this.s.threads.at(-1)!;
  }

  reply({ thread, text }: { thread: string; text: string }) {
    this.guard();
    if (!String(text || "").trim()) throw new Error("A reply needs some text.");
    this.s.threads = threads.reply(this.s.threads, thread, { by: "h", text: text.trim(), turn: this.s.turn });
    this.changed();
  }

  resolve({ thread }: { thread: string }) {
    this.guard();
    this.s.threads = threads.resolve(this.s.threads, thread, "h");
    this.changed();
  }

  // Switch a choice the agent offered to another of its options.
  choose({ choice, option }: { choice: string; option: number }) {
    this.guard();
    this.s = { ...this.s, ...choices.choose(this.s.lines, this.s.choices, choice, option) };
    this.changed();
  }

  // Keep the option the plan shows now; the other ways go.
  settle({ choice }: { choice: string }) {
    this.guard();
    this.s.choices = choices.settle(this.s.choices, choice);
    this.changed();
  }

  edit(input: EditInput) {
    this.guard();
    this.setPlan(plan.edit(this.plan, input, this.scanned));
    this.changed();
  }

  // The person's edits to the map: boxes added, renamed, removed, connected. They reach the
  // agent with the next turn, in the diff of what the person changed.
  editMap({ edits }: { edits: Edit[] }) {
    this.guard();
    if (!Array.isArray(edits)) throw new Error("Send the map edits as a list.");
    this.setPlan(plan.editMap(this.plan, edits, this.scanned));
    this.changed();
  }

  // Say what a box does, and what the boxes inside it do: the person opened it, or the top
  // of the map (\`id\` null). It reads the code and changes only the map, in a commit of its
  // own that undo takes back. Refused while the agent has the pen.
  describe({ id = null }: { id?: string | null } = {}): Promise<void> {
    this.guard("The agent is busy.");
    const view = this.map();
    describeAsk(view, id);
    return this.runDescribe(id, view);
  }

  private async runDescribe(id: string | null, view: MapView) {
    const mark = this.log.begin();
    const { history: _history, settings: _settings, ...prev }: SessionState = this.s;
    this.working = true;
    this.describing = { id };
    this.turnAbort = new AbortController();
    this.activity = [];
    this.emit("change", {});
    const onActivity = (a: string) => {
      this.activity.push(a);
      this.emit("change", {});
    };
    const what = id ?? "the map";
    try {
      const said = await describeBox({ reader: this.reader, cwd: this.store.cwd, log: this.log, mark, plan: this.plan, view, id, settings: this.s.settings, onActivity, signal: this.turnAbort.signal });
      if (said.left.length) onActivity(`it changed ${said.left.join(", ")}, which only a turn may change`);
      this.setPlan(said.plan);
      this.s = { ...this.s, base: plan.withSaid(this.s.base, prev, this.plan, said.ids) };
      this.save();
      const commit = this.log.record(mark, `ogidoc: describe ${what}`, { ownFiles: true });
      this.s.history = [...this.s.history, { ...prev, commit }].slice(-20);
      this.described = { id, summary: said.summary };
    } catch (e) {
      this.described = { id, error: this.turnAbort.signal.aborted ? "Describing was stopped." : (e as Error).message };
    }
    this.working = false;
    this.describing = null;
    this.save();
    this.emit("change", {});
  }

  // A done plan has served its purpose: remove it and its files in one commit. The code
  // it built stays.
  finish() {
    this.guard();
    if (!plan.isDone(this.plan, this.s.last)) throw new Error("The plan isn't done yet: something is open or not built.");
    const mark = this.log.begin();
    this.store.remove();
    this.finished = true;
    this.log.record(mark, `ogidoc: remove the built plan ${this.name}`, { ownFiles: true });
    this.emit("change", {});
  }

  // ---------- the agent's turn ----------

  // Run the agent until a reply ends its turn. One that doesn't goes back to it with
  // the reason, out of the person's sight, a couple of times before the turn fails.
  // The retry carries on the agent's own conversation when its CLI can, so it keeps
  // what it read and did; otherwise it starts over with the whole prompt.
  private async runTurn(prompt: string, turn: number): Promise<{ reply: Reply; next: ReturnType<typeof plan.fromReply> }> {
    const onActivity = (a: string) => {
      this.activity.push(a);
      this.emit("change", {});
    };
    let conversation: string | undefined;
    const onSession = (id: string) => { conversation = id; };
    const { signal } = this.turnAbort;
    let problem = "";
    for (let attempt = 1; attempt <= TURN_ATTEMPTS; attempt++) {
      const resume = problem ? conversation : undefined;
      const ask = !problem ? prompt : resume ? notATurn(problem) : `${prompt}\n\n${notATurn(problem)}`;
      const out = await this.agent.run({ prompt: ask, resume, cwd: this.store.cwd, ...this.s.settings, onActivity, onSession, signal }).catch((e) => {
        throw signal.aborted ? new Error("The turn was stopped.") : e;
      });
      if (signal.aborted) throw new Error("The turn was stopped.");
      try {
        const reply = parseReply(out);
        const next = plan.fromReply(this.plan, reply, turn, this.scanned);
        const why = plan.whyNotATurn(this.plan, reply, next);
        if (!why) return { reply, next };
        problem = why;
      } catch (e) {
        problem = (e as Error).message;
      }
    }
    throw new Error(problem);
  }

  // Stop the agent's turn, when one is running: its CLI is stopped and the turn ends as a
  // failed one, with whatever it changed committed so it can be undone.
  stopTurn(): Promise<void> {
    if (!this.working) return Promise.resolve();
    const over = new Promise<void>((resolve) => {
      const check = () => {
        if (this.working) return;
        this.off("change", check);
        resolve();
      };
      this.on("change", check);
    });
    this.turnAbort.abort();
    return over;
  }

  async pass({ text, boxes, accepted }: EditInput = {}) {
    this.guard("It's already the agent's turn.");
    if (text !== undefined || boxes || accepted) this.edit({ text, boxes, accepted });
    this.setPlan(plan.agree(this.plan));
    const s = this.s;
    const view = this.map();
    // Boxes the scan found were on the map before anyone said anything about them.
    const diff = plan.humanDiff(s.base, this.plan, this.scanned);
    const changedFiles = this.log.drift();
    this.drifted = this.driftNow();
    const prompt = buildPrompt({
      skill: readAgentFile("SKILL.md"),
      rules: this.store.rules(),
      session: this.name,
      turn: s.turn,
      planPath: this.store.displayPath,
      cwd: this.store.cwd,
      lines: s.lines,
      boxes: view.boxes,
      edges: view.edges,
      seeds: this.seeds(diff, changedFiles),
      drifted: this.drifted,
      threads: s.threads,
      choices: s.choices,
      humanDiff: diff,
      drift: changedFiles.filter((f) => !s.boxes.some((b) => b.code?.some((c) => c.file === f))),
      last: s.last,
    });
    const mark = this.log.begin();
    // What undo brings back. Every change makes new values, so this copy stays as it is.
    const { history: _history, settings: _settings, ...prev }: SessionState = s;
    this.working = true;
    this.turnAbort = new AbortController();
    this.activity = [];
    this.emit("change", {});
    const started = this.clock.now();
    let reply: Reply | null = null;
    let animation: AnimationOp[] = [];
    let boxChanges: BoxChanges = {};
    let error: string | null = null;
    try {
      let next: ReturnType<typeof plan.fromReply>;
      ({ reply, next } = await this.runTurn(prompt, s.turn));
      // A turn vouches for the code as it leaves it: what it said about a box, and every box
      // it left alone. Only a box whose code had already changed before the turn, and that
      // the turn didn't bring back, still says what the code used to do.
      const said = new Set(reply.boxes.map((b) => b.id));
      const vouched = next.plan.boxes.filter((b) => said.has(b.id) || !this.drifted.includes(b.id));
      this.setPlan({ ...next.plan, boxes: stamped(next.plan.boxes, vouched.map((b) => b.id), this.hashOf(vouched)) });
      this.drifted = this.driftNow();
      ({ animation, boxChanges } = next);
      this.s = { ...this.s, symbols: reply.symbols, suggestions: reply.suggestions, base: plan.baseOf(next.plan) };
      this.save();
    } catch (e) {
      error = (e as Error).message;
    }

    // Whatever the turn changed gets a commit, even when it failed, so it can be undone.
    // A turn that failed before replying commits only the code the agent touched.
    let commit: string | null = null;
    const title = `ogidoc: ${error ? "failed turn" : "turn"} ${s.turn} on ${this.name}`;
    try {
      commit = this.log.record(mark, `${title}\n\n${reply?.summary || error || ""}`.trim(), { ownFiles: !!reply });
    } catch (e) {
      error ??= (e as Error).message;
    }
    if (reply || commit) this.s.history = [...this.s.history, { ...prev, commit }].slice(-20);
    // What the turn did to the code shows on the map.
    this.rescan();
    if (reply) {
      this.s.last = { summary: reply.summary, steps: reply.steps, files: reply.files, checks: reply.checks, seconds: Math.round((this.clock.now() - started) / 1000) };
      this.s.turn += 1;
    }
    if (error) this.s.last = { ...(this.s.last || {}), error };
    if (this.s.last) this.s.last = { ...this.s.last, commit };
    this.working = false;
    try {
      this.save();
    } catch (e) {
      this.s.last = { ...(this.s.last || {}), error: `Couldn't save the plan: ${(e as Error).message}` };
    }
    this.emit("change", reply ? { animation, boxChanges } : {});
  }

  undo() {
    this.guard();
    const h = this.s.history.at(-1);
    if (!h) throw new Error("There is no agent turn to undo.");
    // The code goes back through git; the plan, boxes and threads come back from memory,
    // as they were just before the turn, with the person's edits from before it.
    const { commit, ...state } = h;
    const mark = this.log.begin();
    if (commit) this.log.revert(commit);
    this.s = { ...this.s, ...state, history: this.s.history.slice(0, -1) };
    this.save();
    if (commit) {
      this.log.record(mark, `ogidoc: undo turn ${h.turn} on ${this.name}`, { ownFiles: true });
      this.save();
    }
    // The code went back too, so what the scan reads of it may have.
    this.rescan();
    this.emit("change", {});
  }
}
