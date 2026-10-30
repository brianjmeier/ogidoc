import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { acceptProposal, anyBuilt, carryMeta, diffLines, joinLines, mapIndices, splitLines, type DiffOp } from "./shared/diff.ts";
import { buildPrompt, parseReply, readAgentFile } from "./prompt.ts";
import { AGENT_DIR } from "./paths.ts";
import { turnLog, type TurnLog } from "./turn-log.ts";
import type { Clock } from "./clock.ts";
import type { Agent, AnimationOp, Box, HumanDiff, LastTurn, Line, Reply, Settings, Snapshot, Symbol, Thread } from "./types.ts";

interface EditInput {
  text?: string;
  boxes?: Record<string, string>;
  accepted?: number[];
}

// What an agent turn can take back: the session as it was just before the turn.
const TURN_STATE = ["lines", "boxes", "threads", "base", "last", "symbols", "suggestions", "turn"] as const;
type TurnState = Pick<Session, (typeof TURN_STATE)[number]>;
interface HistoryEntry extends TurnState {
  commit: string | null;
}

// The text the agent last saw, to tell it what the person changed since.
interface Base {
  lines: string[];
  boxes: Record<string, string[]>;
}

// One plan file and its boxes, shared by a person and an agent who take turns.
//
// On disk everything stays plain text: the plan file itself, one file per box, and a
// small state file that remembers what the editor knows about each line (who wrote
// it, what kind of line it is, whether it is built). Conversation lives beside the
// plan, not in it: comment threads pinned to plan lines, in comments.json.

export class Session extends EventEmitter {
  cwd: string;
  planPath: string;
  name: string;
  dir: string;
  rulesPath: string;
  agent: Agent;
  clock: Clock;
  log!: TurnLog;
  working: boolean;
  activity: string[];
  turn!: number;
  lines!: Line[];
  boxes!: Box[];
  threads!: Thread[];
  symbols!: Symbol[];
  suggestions!: string[];
  last!: LastTurn | null;
  base!: Base;
  history!: HistoryEntry[];
  settings!: Settings;

  constructor({ cwd, planFile, agent, clock, commit = true }: { cwd: string; planFile: string; agent: Agent; clock: Clock; commit?: boolean }) {
    super();
    this.cwd = realpathSync(resolve(cwd));
    this.planPath = resolve(this.cwd, planFile);
    this.name = basename(this.planPath).replace(/\.[^.]+$/, "");
    this.dir = join(dirname(this.planPath), ".underpaint", this.name);
    this.rulesPath = join(dirname(this.planPath), ".underpaint", "rules.md");
    this.agent = agent;
    this.clock = clock;
    this.working = false;
    this.activity = [];
    this.load(commit);
  }

  // ---------- disk ----------

  load(commit: boolean) {
    mkdirSync(join(this.dir, "boxes"), { recursive: true });
    // The plan and boxes are shared in git; the editor's bookkeeping stays local.
    const ignore = join(this.dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "state.json\n");
    if (!existsSync(this.rulesPath)) copyFileSync(join(AGENT_DIR, "rules.md"), this.rulesPath);
    const statePath = join(this.dir, "state.json");
    const s = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    this.turn = s.turn || 1;
    this.lines = s.lines || [];
    this.boxes = s.boxes || [];
    this.symbols = s.symbols || [];
    this.suggestions = s.suggestions || [];
    this.last = s.last || null;
    this.base = s.base || { lines: [], boxes: {} };
    this.history = s.history || [];
    this.settings = { model: "", effort: "", ...s.settings };
    const commentsPath = join(this.dir, "comments.json");
    this.threads = existsSync(commentsPath) ? JSON.parse(readFileSync(commentsPath, "utf8")) : [];
    // The plan file and the folder beside it are the editor's own files.
    this.log = turnLog({ cwd: this.cwd, ownFiles: [this.planPath, dirname(this.dir)], commit, saved: { baseCommit: s.baseCommit, dirtyBase: s.dirtyBase } });

    // The files are the source of truth for text. Someone may have edited them in
    // another editor; carry what we know across that edit.
    const text = existsSync(this.planPath) ? readFileSync(this.planPath, "utf8") : "";
    this.applyText(text.replace(/\n$/, ""));
    const onDisk: Record<string, string> = {};
    for (const f of readdirSync(join(this.dir, "boxes"))) {
      if (f.endsWith(".plan")) onDisk[f.slice(0, -5)] = readFileSync(join(this.dir, "boxes", f), "utf8").replace(/\n$/, "");
    }
    this.boxes = this.boxes.filter((b) => b.name in onDisk);
    for (const [name, body] of Object.entries(onDisk)) {
      if (!this.boxes.find((b) => b.name === name)) this.boxes.push({ name, lines: [], status: "stale", uses: [] });
    }
    this.applyBoxes(onDisk);
  }

  addThread(line: number, by: Thread["by"], text: string): Thread {
    const id = `t${1 + Math.max(0, ...this.threads.map((t) => Number(t.id.slice(1)) || 0))}`;
    const t: Thread = { id, line, by, resolved: false, messages: [{ by, text, turn: this.turn }] };
    this.threads.push(t);
    return t;
  }

  save() {
    mkdirSync(join(this.dir, "boxes"), { recursive: true });
    writeFileSync(this.planPath, joinLines(this.lines) + "\n");
    const boxDir = join(this.dir, "boxes");
    const keep = new Set(this.boxes.map((b) => `${b.name}.plan`));
    for (const f of readdirSync(boxDir)) if (!keep.has(f)) rmSync(join(boxDir, f));
    for (const b of this.boxes) writeFileSync(join(boxDir, `${b.name}.plan`), joinLines(b.lines) + "\n");
    const { turn, lines, boxes, symbols, suggestions, last, base, history, settings } = this;
    const { baseCommit, dirtyBase } = this.log.saved();
    writeFileSync(join(this.dir, "state.json"), JSON.stringify({ turn, lines, boxes, symbols, suggestions, last, base, baseCommit, history, dirtyBase, settings }, null, 1));
    writeFileSync(join(this.dir, "comments.json"), JSON.stringify(this.threads, null, 1) + "\n");
  }

  // ---------- what the browser sees ----------

  snapshot(): Snapshot {
    return {
      name: this.name,
      planPath: relative(this.cwd, this.planPath),
      agent: this.agent.name,
      choices: this.agent.choices || { models: [], efforts: [] },
      settings: this.settings,
      turn: this.turn,
      working: this.working,
      activity: this.activity.slice(-6),
      lines: this.lines,
      boxes: this.boxes,
      threads: this.threads,
      symbols: this.symbols,
      suggestions: this.suggestions,
      last: this.last,
      done: this.isDone(),
      canUndo: this.history.length > 0 && !this.working,
    };
  }

  // The model and effort the next agent turn runs with; empty means the CLI's default.
  setSettings({ model, effort }: Partial<Settings> = {}) {
    const efforts = this.agent.choices?.efforts || [];
    if (effort && !efforts.includes(effort)) throw new Error(`${this.agent.name} has no effort "${effort}".`);
    if (model !== undefined) this.settings.model = String(model).trim();
    if (effort !== undefined) this.settings.effort = effort;
    this.changed();
  }

  // The person's changes are refused while the agent holds the pen.
  private guard() {
    if (this.working) throw new Error("The agent has the pen.");
  }

  private changed() {
    this.save();
    this.emit("change", {});
  }

  // Done is read off the plan: no open comment or proposal, every line built, checks green.
  isDone(): boolean {
    if (!this.last || this.last.error) return false;
    const content = this.lines.filter((l) => l.text.trim());
    if (!content.length) return false;
    if (this.threads.some((t) => !t.resolved)) return false;
    if (this.lines.some((l) => l.kind === "proposal")) return false;
    if (content.some((l) => l.status !== "built")) return false;
    if (this.boxes.some((b) => b.status !== "built")) return false;
    return (this.last.checks || []).every((c) => c.ok);
  }

  anyBuilt(): boolean {
    return anyBuilt(this.lines, this.boxes);
  }

  // ---------- the person's turn ----------

  applyText(text: string) {
    const texts = splitLines(text);
    const ops = diffLines(this.lines.map((l) => l.text), texts);
    this.moveThreads(ops);
    this.lines = carryMeta(this.lines, texts, { anyBuilt: this.anyBuilt(), ops });
  }

  // Keep every thread on its line through an edit of the plan.
  moveThreads(ops: DiffOp[]) {
    const map = mapIndices(ops, this.lines.length);
    for (const t of this.threads) t.line = map[t.line] ?? 0;
  }

  thread(id: string): Thread {
    const t = this.threads.find((x) => x.id === id);
    if (!t) throw new Error(`There is no comment thread ${id}.`);
    return t;
  }

  comment({ line, text }: { line: number; text: string }): Thread {
    this.guard();
    if (!Number.isInteger(line) || line < 0 || line >= Math.max(1, this.lines.length)) throw new Error("That line isn't in the plan.");
    if (!String(text || "").trim()) throw new Error("A comment needs some text.");
    const t = this.addThread(line, "h", text.trim());
    this.changed();
    return t;
  }

  reply({ thread, text }: { thread: string; text: string }) {
    this.guard();
    if (!String(text || "").trim()) throw new Error("A reply needs some text.");
    this.thread(thread).messages.push({ by: "h", text: text.trim(), turn: this.turn });
    this.changed();
  }

  resolve({ thread }: { thread: string }) {
    this.guard();
    Object.assign(this.thread(thread), { resolved: true, resolvedBy: "h", seen: false });
    this.changed();
  }

  applyBoxes(bodies: Record<string, string>) {
    for (const b of this.boxes) {
      if (!(b.name in bodies)) continue;
      const texts = splitLines(bodies[b.name]);
      const before = joinLines(b.lines);
      b.lines = carryMeta(b.lines, texts, { anyBuilt: true }).map((l) => ({ ...l, kind: null }));
      if (before !== texts.join("\n")) b.status = "stale";
    }
  }

  edit({ text, boxes, accepted }: EditInput) {
    this.guard();
    if (typeof text === "string") this.applyText(text);
    for (const i of accepted || []) {
      if (this.lines[i]?.kind === "proposal") this.lines[i] = acceptProposal(this.lines[i], this.anyBuilt());
    }
    if (boxes) this.applyBoxes(boxes);
    this.changed();
  }

  // ---------- the agent's turn ----------

  humanDiff(): HumanDiff {
    const lineChanges = (oldT: string[], newT: string[]): HumanDiff["lines"] =>
      diffLines(oldT, newT)
        .filter((o) => o.op !== "eq")
        .map((o) => (o.op === "del" ? { op: "del", text: oldT[o.a] } : o.op === "ins" ? { op: "add", text: newT[o.b] } : { op: "mod", old: oldT[o.a], text: newT[o.b] }));
    const boxes: HumanDiff["boxes"] = [];
    for (const b of this.boxes) {
      const changes = lineChanges(this.base.boxes[b.name] || [], b.lines.map((l) => l.text));
      if (changes.length) boxes.push({ name: b.name, lines: changes });
    }
    return { lines: lineChanges(this.base.lines, this.lines.map((l) => l.text)), boxes };
  }

  async pass({ text, boxes, accepted }: EditInput = {}) {
    if (this.working) throw new Error("The agent already has the pen.");
    if (text !== undefined || boxes || accepted) this.edit({ text, boxes, accepted });
    const prompt = buildPrompt({
      skill: readAgentFile("SKILL.md"),
      rules: readFileSync(this.rulesPath, "utf8"),
      turn: this.turn,
      planPath: relative(this.cwd, this.planPath),
      cwd: this.cwd,
      lines: this.lines,
      boxes: this.boxes,
      threads: this.threads,
      humanDiff: this.humanDiff(),
      drift: this.log.drift(),
      last: this.last,
    });
    this.log.begin();
    const prev = { ...this.turnState(), threads: structuredClone(this.threads) };
    this.working = true;
    this.activity = [];
    this.emit("change", {});
    const started = this.clock.now();
    let reply: Reply | null = null;
    let animation: AnimationOp[] = [];
    let error: string | null = null;
    try {
      const out = await this.agent.run({
        prompt,
        cwd: this.cwd,
        ...this.settings,
        onActivity: (a: string) => {
          this.activity.push(a);
          this.emit("change", {});
        },
      });
      reply = parseReply(out);
      animation = this.applyReply(reply);
      this.base = { lines: this.lines.map((l) => l.text), boxes: Object.fromEntries(this.boxes.map((b) => [b.name, b.lines.map((l) => l.text)])) };
      this.save();
    } catch (e) {
      error = (e as Error).message;
    }

    // Whatever the turn changed gets a commit, even when it failed, so it can be undone.
    // A turn that failed before replying commits only the code the agent touched.
    let commit: string | null = null;
    const title = `underpaint: ${error ? "failed turn" : "turn"} ${this.turn} on ${this.name}`;
    try {
      commit = this.log.record(`${title}\n\n${reply?.summary || error || ""}`.trim(), { ownFiles: !!reply });
    } catch (e) {
      error ??= (e as Error).message;
    }
    if (reply || commit) {
      this.history.push({ ...prev, commit });
      this.history = this.history.slice(-20);
    }
    if (reply) {
      this.last = { summary: reply.summary, steps: reply.steps, files: reply.files, checks: reply.checks, seconds: Math.round((this.clock.now() - started) / 1000) };
      this.turn += 1;
    }
    if (error) this.last = { ...(this.last || {}), error };
    this.working = false;
    this.save();
    this.emit("change", reply ? { animation } : {});
  }

  // Take the agent's reply apart into lines and boxes, keeping authorship, and
  // describe the change so the browser can animate it.
  applyReply(reply: Reply): AnimationOp[] {
    const oldLines = this.lines;
    const newTexts = reply.plan.map((l) => l.text);
    const ops = diffLines(oldLines.map((l) => l.text), newTexts);
    this.moveThreads(ops);
    this.applyComments(reply, newTexts.length);

    const oldBoxes = new Map(this.boxes.map((b) => [b.name, b]));
    const boxes = reply.boxes.map((rb) => {
      const old = oldBoxes.get(rb.name);
      const oldL = old ? old.lines : [];
      const bops = diffLines(oldL.map((l) => l.text), rb.lines);
      const lines: Line[] = new Array(rb.lines.length);
      for (const o of bops) {
        if (o.op === "eq") lines[o.b] = { ...oldL[o.a], text: rb.lines[o.b], chg: false };
        else if (o.op !== "del") lines[o.b] = { text: rb.lines[o.b], by: "a", chg: true };
      }
      const changed = !old || bops.some((o) => o.op !== "eq");
      return { name: rb.name, lines, status: rb.status, uses: rb.uses, isNew: !old, changed };
    });

    // A line that left the plan and shows up in a box was moved there.
    const boxOf = new Map<string, string>();
    for (const b of boxes) if (b.changed) for (const l of b.lines) boxOf.set(norm(l.text), b.name);

    const lines: Line[] = new Array(newTexts.length);
    const animation: AnimationOp[] = [];
    for (const o of ops) {
      if (o.op === "eq") {
        const r = reply.plan[o.b];
        lines[o.b] = { ...oldLines[o.a], kind: r.kind, status: r.status, chg: false };
        animation.push({ op: "keep", a: o.a, b: o.b });
      } else if (o.op === "del") {
        const t = oldLines[o.a].text;
        const to = boxOf.get(norm(t)) || boxOf.get(norm(t.replace(/^\s*(e\.g\.|for example,?)\s*/i, "")));
        animation.push(to ? { op: "move", text: t, to } : { op: "del", text: t });
      } else {
        const r = reply.plan[o.b];
        lines[o.b] = { text: r.text, by: "a", kind: r.kind, status: r.status, chg: true };
        animation.push(o.op === "mod" ? { op: "mod", b: o.b, old: oldLines[o.a].text } : { op: "add", b: o.b });
      }
    }
    this.lines = lines;
    this.boxes = boxes;
    this.symbols = reply.symbols;
    this.suggestions = reply.suggestions;
    return animation;
  }

  applyComments({ comments, replies }: Pick<Reply, "comments" | "replies">, lineCount: number) {
    for (const t of this.threads) if (t.resolved) t.seen = true;
    for (const r of replies) {
      const t = this.threads.find((x) => x.id === r.thread);
      if (!t) continue;
      if (r.text) t.messages.push({ by: "a", text: r.text, turn: this.turn });
      if (r.resolve) Object.assign(t, { resolved: true, resolvedBy: "a", seen: true });
    }
    for (const c of comments) {
      const line = Math.min(Math.max(0, c.line), Math.max(0, lineCount - 1));
      this.addThread(line, "a", c.text);
    }
  }

  private turnState(): TurnState {
    return Object.fromEntries(TURN_STATE.map((k) => [k, this[k]])) as TurnState;
  }

  undo() {
    this.guard();
    const h = this.history.pop();
    if (!h) throw new Error("There is no agent turn to undo.");
    // The code goes back through git; the plan, boxes and threads come back from memory,
    // as they were just before the turn, with the person's edits from before it.
    const { commit, ...state } = h;
    this.log.begin();
    if (commit) this.log.revert(commit);
    Object.assign(this, state, { threads: h.threads || [] });
    this.save();
    if (commit) {
      this.log.record(`underpaint: undo turn ${h.turn} on ${this.name}`, { ownFiles: true });
      this.save();
    }
    this.emit("change", {});
  }
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
