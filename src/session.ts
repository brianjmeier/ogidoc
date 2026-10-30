import { EventEmitter } from "node:events";
import { acceptProposal, anyBuilt, carryMeta, diffLines, joinLines, mapIndices, splitLines, type DiffOp } from "./shared/diff.ts";
import { buildPrompt, parseReply, readAgentFile } from "./prompt.ts";
import { planStore, type Base, type HistoryEntry, type Loaded, type PlanStore } from "./plan-store.ts";
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
type TurnState = Omit<HistoryEntry, "commit">;

// Put a session together from where its plan lives, the agent, and the clock.
export function openSession({ cwd, planFile, agent, clock, commit = true }: { cwd: string; planFile: string; agent: Agent; clock: Clock; commit?: boolean }): Session {
  const store = planStore(cwd, planFile);
  const saved = store.load();
  const log = turnLog({ cwd: store.cwd, ownFiles: store.ownFiles, commit, saved: saved.log });
  return new Session({ store, saved, log, agent, clock });
}

// One plan file and its boxes, shared by a person and an agent who take turns.
// Conversation lives beside the plan, not in it: comment threads pinned to plan lines.

export class Session extends EventEmitter {
  store: PlanStore;
  agent: Agent;
  clock: Clock;
  log: TurnLog;
  working = false;
  activity: string[] = [];
  turn: number;
  lines: Line[];
  boxes: Box[];
  threads: Thread[];
  symbols: Symbol[];
  suggestions: string[];
  last: LastTurn | null;
  base: Base;
  history: HistoryEntry[];
  settings: Settings;

  constructor({ store, saved, log, agent, clock }: { store: PlanStore; saved: Loaded; log: TurnLog; agent: Agent; clock: Clock }) {
    super();
    this.store = store;
    this.log = log;
    this.agent = agent;
    this.clock = clock;
    this.turn = saved.turn;
    this.lines = saved.lines;
    this.boxes = saved.boxes;
    this.threads = saved.threads;
    this.symbols = saved.symbols;
    this.suggestions = saved.suggestions;
    this.last = saved.last;
    this.base = saved.base;
    this.history = saved.history;
    this.settings = saved.settings;

    // The files are the source of truth for text. Someone may have edited them in
    // another editor; carry what we know across that edit.
    this.applyText(saved.planText);
    this.boxes = this.boxes.filter((b) => b.name in saved.boxTexts);
    for (const name of Object.keys(saved.boxTexts)) {
      if (!this.boxes.find((b) => b.name === name)) this.boxes.push({ name, lines: [], status: "stale", uses: [] });
    }
    this.applyBoxes(saved.boxTexts);
  }

  get name() {
    return this.store.name;
  }

  addThread(line: number, by: Thread["by"], text: string): Thread {
    const id = `t${1 + Math.max(0, ...this.threads.map((t) => Number(t.id.slice(1)) || 0))}`;
    const t: Thread = { id, line, by, resolved: false, messages: [{ by, text, turn: this.turn }] };
    this.threads.push(t);
    return t;
  }

  save() {
    const { turn, lines, boxes, threads, symbols, suggestions, last, base, history, settings } = this;
    this.store.save({ turn, lines, boxes, threads, symbols, suggestions, last, base, history, settings, log: this.log.saved() });
  }

  // ---------- what the browser sees ----------

  snapshot(): Snapshot {
    return {
      name: this.name,
      planPath: this.store.displayPath,
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
      rules: this.store.rules(),
      turn: this.turn,
      planPath: this.store.displayPath,
      cwd: this.store.cwd,
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
        cwd: this.store.cwd,
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
