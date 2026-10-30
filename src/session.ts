import { EventEmitter } from "node:events";
import * as plan from "./plan.ts";
import type { Base, Plan } from "./plan.ts";
import * as threads from "./threads.ts";
import { buildPrompt, parseReply, readAgentFile } from "./prompt.ts";
import { planStore, type HistoryEntry, type Loaded, type PlanStore } from "./plan-store.ts";
import { turnLog, type TurnLog } from "./turn-log.ts";
import type { Clock } from "./clock.ts";
import type { Agent } from "./agents.ts";
import type { AnimationOp, Box, LastTurn, Line, Reply, Settings, Snapshot, Symbol, Thread } from "./types.ts";

interface EditInput {
  text?: string;
  boxes?: Record<string, string>;
  accepted?: number[];
}

// What an agent turn can take back: the session as it was just before the turn.
type TurnState = Omit<HistoryEntry, "commit">;
const TURN_STATE = ["lines", "boxes", "threads", "base", "last", "symbols", "suggestions", "turn"] as const satisfies readonly (keyof TurnState)[];
// Fails to compile when TurnState gains a field TURN_STATE doesn't list.
const _everyField: Exclude<keyof TurnState, (typeof TURN_STATE)[number]> extends never ? true : never = true;

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

    // Someone may have edited the files in another editor; carry what we know across.
    this.setPlan(plan.fromFiles(this.plan, saved.planText, saved.boxTexts));
  }

  get name() {
    return this.store.name;
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

  get plan(): Plan {
    return { lines: this.lines, boxes: this.boxes, threads: this.threads };
  }

  private setPlan(p: Plan) {
    ({ lines: this.lines, boxes: this.boxes, threads: this.threads } = p);
  }

  isDone(): boolean {
    return plan.isDone(this.plan, this.last);
  }

  // ---------- the person's turn ----------

  comment({ line, text }: { line: number; text: string }): Thread {
    this.guard();
    if (!Number.isInteger(line) || line < 0 || line >= Math.max(1, this.lines.length)) throw new Error("That line isn't in the plan.");
    if (!String(text || "").trim()) throw new Error("A comment needs some text.");
    this.threads = threads.add(this.threads, { line, by: "h", text: text.trim(), turn: this.turn });
    this.changed();
    return this.threads.at(-1)!;
  }

  reply({ thread, text }: { thread: string; text: string }) {
    this.guard();
    if (!String(text || "").trim()) throw new Error("A reply needs some text.");
    this.threads = threads.reply(this.threads, thread, { by: "h", text: text.trim(), turn: this.turn });
    this.changed();
  }

  resolve({ thread }: { thread: string }) {
    this.guard();
    this.threads = threads.resolve(this.threads, thread, "h");
    this.changed();
  }

  edit(input: EditInput) {
    this.guard();
    this.setPlan(plan.edit(this.plan, input));
    this.changed();
  }

  // ---------- the agent's turn ----------

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
      humanDiff: plan.humanDiff(this.base, this.plan),
      drift: this.log.drift(),
      last: this.last,
    });
    const mark = this.log.begin();
    const prev = this.turnState();
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
      const next = plan.fromReply(this.plan, reply, this.turn);
      this.setPlan(next.plan);
      animation = next.animation;
      this.symbols = reply.symbols;
      this.suggestions = reply.suggestions;
      this.base = plan.baseOf(this.plan);
      this.save();
    } catch (e) {
      error = (e as Error).message;
    }

    // Whatever the turn changed gets a commit, even when it failed, so it can be undone.
    // A turn that failed before replying commits only the code the agent touched.
    let commit: string | null = null;
    const title = `underpaint: ${error ? "failed turn" : "turn"} ${this.turn} on ${this.name}`;
    try {
      commit = this.log.record(mark, `${title}\n\n${reply?.summary || error || ""}`.trim(), { ownFiles: !!reply });
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
    try {
      this.save();
    } catch (e) {
      this.last = { ...(this.last || {}), error: `Couldn't save the plan: ${(e as Error).message}` };
    }
    this.emit("change", reply ? { animation } : {});
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
    const mark = this.log.begin();
    if (commit) this.log.revert(commit);
    Object.assign(this, state);
    this.save();
    if (commit) {
      this.log.record(mark, `underpaint: undo turn ${h.turn} on ${this.name}`, { ownFiles: true });
      this.save();
    }
    this.emit("change", {});
  }
}
