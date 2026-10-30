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
import type { AnimationOp, BoxChanges, Reply, Settings, Snapshot, Thread } from "./types.ts";

interface EditInput {
  text?: string;
  boxes?: Record<string, string>;
  accepted?: number[];
}

// How many replies the agent gets to end its turn properly before the turn fails.
const TURN_ATTEMPTS = 3;

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
  // The plan was done and the person removed it; the code stays.
  finished = false;
  activity: string[] = [];
  private s: SessionState;

  constructor({ store, saved, log, agent, clock }: { store: PlanStore; saved: Loaded; log: TurnLog; agent: Agent; clock: Clock }) {
    super();
    this.store = store;
    this.log = log;
    this.agent = agent;
    this.clock = clock;
    this.s = saved.state;
    // Someone may have edited the files in another editor; carry what we know across.
    this.setPlan(plan.fromFiles(this.plan, saved.planText, saved.boxTexts));
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
    };
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
    return { lines: this.s.lines, boxes: this.s.boxes, threads: this.s.threads, choices: this.s.choices };
  }

  private setPlan(p: Plan) {
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
    this.setPlan(plan.edit(this.plan, input));
    this.changed();
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

  async pass({ text, boxes, accepted }: EditInput = {}) {
    this.guard("It's already the agent's turn.");
    if (text !== undefined || boxes || accepted) this.edit({ text, boxes, accepted });
    this.setPlan(plan.agree(this.plan));
    const s = this.s;
    const prompt = buildPrompt({
      skill: readAgentFile("SKILL.md"),
      rules: this.store.rules(),
      turn: s.turn,
      planPath: this.store.displayPath,
      cwd: this.store.cwd,
      lines: s.lines,
      boxes: s.boxes,
      threads: s.threads,
      choices: s.choices,
      humanDiff: plan.humanDiff(s.base, this.plan),
      drift: this.log.drift(),
      last: s.last,
    });
    const mark = this.log.begin();
    // What undo brings back. Every change makes new values, so this copy stays as it is.
    const { history: _history, settings: _settings, ...prev }: SessionState = s;
    this.working = true;
    this.activity = [];
    this.emit("change", {});
    const started = this.clock.now();
    let reply: Reply | null = null;
    let animation: AnimationOp[] = [];
    let boxChanges: BoxChanges = {};
    let error: string | null = null;
    try {
      // A reply that doesn't end the turn goes back to the agent with the reason, out of
      // the person's sight, a couple of times before the turn fails.
      let next: ReturnType<typeof plan.fromReply> | undefined;
      let problem: string | null = null;
      for (let attempt = 1; ; attempt++) {
        const out = await this.agent.run({
          prompt: problem ? `${prompt}\n\n${notATurn(problem)}` : prompt,
          cwd: this.store.cwd,
          ...s.settings,
          onActivity: (a: string) => {
            this.activity.push(a);
            this.emit("change", {});
          },
        });
        try {
          const r = parseReply(out);
          const n = plan.fromReply(this.plan, r, s.turn);
          problem = plan.whyNotATurn(this.plan, r, n);
          if (!problem) [reply, next] = [r, n];
        } catch (e) {
          problem = (e as Error).message;
        }
        if (next) break;
        if (attempt === TURN_ATTEMPTS) throw new Error(problem!);
      }
      this.setPlan(next.plan);
      ({ animation, boxChanges } = next);
      this.s = { ...this.s, symbols: reply!.symbols, suggestions: reply!.suggestions, base: plan.baseOf(next.plan) };
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
    if (reply) {
      this.s.last = { summary: reply.summary, steps: reply.steps, files: reply.files, checks: reply.checks, seconds: Math.round((this.clock.now() - started) / 1000) };
      this.s.turn += 1;
    }
    if (error) this.s.last = { ...(this.s.last || {}), error };
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
    this.emit("change", {});
  }
}
