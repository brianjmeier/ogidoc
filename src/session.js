import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { carryMeta, diffLines } from "./shared/diff.js";
import { buildPrompt, parseReply, readAgentFile, AGENT_DIR } from "./prompt.js";
import * as git from "./git.js";

// One plan file and its boxes, shared by a person and an agent who take turns.
//
// On disk everything stays plain text: the plan file itself, one file per box, and a
// small state file that remembers what the editor knows about each line (who wrote
// it, what kind of line it is, whether it is built).

export class Session extends EventEmitter {
  constructor({ cwd, planFile, agent, commit = true }) {
    super();
    this.cwd = realpathSync(resolve(cwd));
    this.planPath = resolve(this.cwd, planFile);
    this.name = basename(this.planPath).replace(/\.[^.]+$/, "");
    this.dir = join(dirname(this.planPath), ".underpaint", this.name);
    this.rulesPath = join(dirname(this.planPath), ".underpaint", "rules.md");
    this.agent = agent;
    this.root = git.repoRoot(this.cwd);
    this.commit = commit && !!this.root;
    this.working = false;
    this.activity = [];
    this.load();
  }

  // ---------- disk ----------

  load() {
    mkdirSync(join(this.dir, "boxes"), { recursive: true });
    // The plan and boxes are shared in git; the editor's bookkeeping stays local.
    const ignore = join(this.dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "state.json\n");
    if (!existsSync(this.rulesPath)) copyFileSync(join(AGENT_DIR, "rules.md"), this.rulesPath);
    const statePath = join(this.dir, "state.json");
    const s = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    this.turn = s.turn || 1;
    this.who = "h";
    this.lines = s.lines || [];
    this.boxes = s.boxes || [];
    this.symbols = s.symbols || [];
    this.suggestions = s.suggestions || [];
    this.last = s.last || null;
    this.base = s.base || { lines: [], boxes: {} };
    this.baseCommit = s.baseCommit || (this.root ? git.head(this.root) : null);
    this.history = s.history || [];
    // Work already in progress when we start isn't drift; only what changes after.
    this.dirtyBase = s.dirtyBase || (this.root ? Object.fromEntries(git.dirtyFiles(this.root)) : {});

    // The files are the source of truth for text. Someone may have edited them in
    // another editor; carry what we know across that edit.
    const text = existsSync(this.planPath) ? readFileSync(this.planPath, "utf8") : "";
    this.applyText(text.replace(/\n$/, ""));
    const onDisk = {};
    for (const f of readdirSync(join(this.dir, "boxes"))) {
      if (f.endsWith(".plan")) onDisk[f.slice(0, -5)] = readFileSync(join(this.dir, "boxes", f), "utf8").replace(/\n$/, "");
    }
    this.boxes = this.boxes.filter((b) => b.name in onDisk);
    for (const [name, body] of Object.entries(onDisk)) {
      if (!this.boxes.find((b) => b.name === name)) this.boxes.push({ name, lines: [], status: "stale", uses: [] });
    }
    this.applyBoxes(onDisk);
  }

  save() {
    writeFileSync(this.planPath, this.lines.map((l) => l.text).join("\n") + "\n");
    const boxDir = join(this.dir, "boxes");
    const keep = new Set(this.boxes.map((b) => `${b.name}.plan`));
    for (const f of readdirSync(boxDir)) if (!keep.has(f)) rmSync(join(boxDir, f));
    for (const b of this.boxes) writeFileSync(join(boxDir, `${b.name}.plan`), b.lines.map((l) => l.text).join("\n") + "\n");
    const { turn, lines, boxes, symbols, suggestions, last, base, baseCommit, history, dirtyBase } = this;
    writeFileSync(join(this.dir, "state.json"), JSON.stringify({ turn, lines, boxes, symbols, suggestions, last, base, baseCommit, history, dirtyBase }, null, 1));
  }

  // ---------- what the browser sees ----------

  snapshot() {
    return {
      name: this.name,
      planPath: relative(this.cwd, this.planPath),
      agent: this.agent.name,
      turn: this.turn,
      who: this.working ? "a" : "h",
      working: this.working,
      activity: this.activity.slice(-6),
      lines: this.lines,
      boxes: this.boxes,
      symbols: this.symbols,
      suggestions: this.suggestions,
      last: this.last,
      done: this.isDone(),
      canUndo: this.history.length > 0 && !this.working,
    };
  }

  // Done is read off the plan: nothing open, every line built, checks green.
  isDone() {
    if (!this.last || this.last.error) return false;
    const content = this.lines.filter((l) => l.text.trim() && !["question", "answer", "proposal"].includes(l.kind));
    if (!content.length) return false;
    if (this.lines.some((l) => l.kind === "question" || l.kind === "proposal")) return false;
    if (content.some((l) => l.status !== "built")) return false;
    if (this.boxes.some((b) => b.status !== "built")) return false;
    return (this.last.checks || []).every((c) => c.ok);
  }

  anyBuilt() {
    return this.lines.some((l) => l.status === "built") || this.boxes.some((b) => b.status === "built");
  }

  // ---------- the person's turn ----------

  applyText(text) {
    const texts = text === "" ? [] : text.split("\n");
    this.lines = carryMeta(this.lines, texts, { anyBuilt: this.anyBuilt() });
  }

  applyBoxes(bodies) {
    for (const b of this.boxes) {
      if (!(b.name in bodies)) continue;
      const texts = bodies[b.name] === "" ? [] : bodies[b.name].split("\n");
      const before = b.lines.map((l) => l.text).join("\n");
      b.lines = carryMeta(b.lines, texts, { anyBuilt: true }).map((l) => ({ ...l, kind: null }));
      if (before !== texts.join("\n")) b.status = "stale";
    }
  }

  edit({ text, boxes, accepted }) {
    if (this.working) throw new Error("The agent has the pen.");
    if (typeof text === "string") this.applyText(text);
    // An accepted proposal stays as the person's own plain line.
    for (const i of accepted || []) {
      const l = this.lines[i];
      if (l && l.kind === "proposal") Object.assign(l, { kind: null, by: "h", chg: true, status: this.anyBuilt() ? "stale" : null });
    }
    if (boxes) this.applyBoxes(boxes);
    this.save();
    this.emit("change", {});
  }

  // ---------- the agent's turn ----------

  humanDiff() {
    const lineChanges = (oldT, newT) =>
      diffLines(oldT, newT)
        .filter((o) => o.op !== "eq")
        .map((o) => (o.op === "del" ? { op: "del", text: oldT[o.a] } : o.op === "ins" ? { op: "add", text: newT[o.b] } : { op: "mod", old: oldT[o.a], text: newT[o.b] }));
    const boxes = [];
    for (const b of this.boxes) {
      const changes = lineChanges(this.base.boxes[b.name] || [], b.lines.map((l) => l.text));
      if (changes.length) boxes.push({ name: b.name, lines: changes });
    }
    return { lines: lineChanges(this.base.lines, this.lines.map((l) => l.text)), boxes };
  }

  drift() {
    if (!this.commit) return [];
    const ours = (p) => {
      const abs = join(this.root, p);
      return abs === this.planPath || abs.startsWith(join(dirname(this.planPath), ".underpaint"));
    };
    const committed = git.filesInCommits(this.root, this.baseCommit);
    const dirty = [...git.dirtyFiles(this.root)].filter(([p, h]) => this.dirtyBase[p] !== h).map(([p]) => p);
    return [...new Set([...committed, ...dirty])].filter((p) => !ours(p));
  }

  async pass({ text, boxes, accepted } = {}) {
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
      humanDiff: this.humanDiff(),
      drift: this.drift(),
      last: this.last,
    });
    const before = this.root ? git.dirtyFiles(this.root) : new Map();
    const prev = { lines: this.lines, boxes: this.boxes, base: this.base, last: this.last, symbols: this.symbols, suggestions: this.suggestions };
    this.working = true;
    this.activity = [];
    this.emit("change", {});
    const started = Date.now();
    try {
      const out = await this.agent.run({
        prompt,
        cwd: this.cwd,
        onActivity: (a) => {
          this.activity.push(a);
          this.emit("change", {});
        },
      });
      const reply = parseReply(out);
      const animation = this.applyReply(reply);
      this.last = { summary: reply.summary, steps: reply.steps, files: reply.files, checks: reply.checks, seconds: Math.round((Date.now() - started) / 1000) };
      this.base = { lines: this.lines.map((l) => l.text), boxes: Object.fromEntries(this.boxes.map((b) => [b.name, b.lines.map((l) => l.text)])) };
      this.save();
      let commit = null;
      if (this.commit) {
        const paths = [...new Set([...git.changedSince(this.root, before), relative(this.root, this.planPath), relative(this.root, dirname(this.dir))])];
        commit = git.commitPaths(this.root, paths, `underpaint: turn ${this.turn} on ${this.name}\n\n${reply.summary}`.trim());
        this.baseCommit = git.head(this.root);
        this.dirtyBase = Object.fromEntries(git.dirtyFiles(this.root));
      }
      this.history.push({ ...prev, turn: this.turn, commit });
      this.history = this.history.slice(-20);
      this.turn += 1;
      this.working = false;
      this.save();
      this.emit("change", { animation });
    } catch (e) {
      this.working = false;
      this.last = { ...(this.last || {}), error: e.message };
      this.save();
      this.emit("change", {});
    }
  }

  // Take the agent's reply apart into lines and boxes, keeping authorship, and
  // describe the change so the browser can animate it.
  applyReply(reply) {
    const oldLines = this.lines;
    const newTexts = reply.plan.map((l) => l.text);
    const ops = diffLines(oldLines.map((l) => l.text), newTexts);

    const oldBoxes = new Map(this.boxes.map((b) => [b.name, b]));
    const boxes = reply.boxes.map((rb) => {
      const old = oldBoxes.get(rb.name);
      const oldL = old ? old.lines : [];
      const bops = diffLines(oldL.map((l) => l.text), rb.lines);
      const lines = new Array(rb.lines.length);
      for (const o of bops) {
        if (o.op === "eq") lines[o.b] = { ...oldL[o.a], text: rb.lines[o.b], chg: false };
        else if (o.op !== "del") lines[o.b] = { text: rb.lines[o.b], by: "a", chg: true };
      }
      const changed = !old || bops.some((o) => o.op !== "eq");
      return { name: rb.name, lines, status: rb.status, uses: rb.uses, isNew: !old, changed };
    });

    // A line that left the plan and shows up in a box was moved there.
    const boxOf = new Map();
    for (const b of boxes) if (b.changed) for (const l of b.lines) boxOf.set(norm(l.text), b.name);

    const lines = new Array(newTexts.length);
    const animation = [];
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

  undo() {
    if (this.working) throw new Error("The agent has the pen.");
    const h = this.history.pop();
    if (!h) throw new Error("There is no agent turn to undo.");
    if (h.commit && this.root) this.baseCommit = git.revert(this.root, h.commit);
    Object.assign(this, { lines: h.lines, boxes: h.boxes, base: h.base, last: h.last, symbols: h.symbols, suggestions: h.suggestions, turn: h.turn });
    this.save();
    if (this.commit && h.commit) {
      git.commitPaths(this.root, [relative(this.root, this.planPath), relative(this.root, dirname(this.dir))], `underpaint: undo turn ${h.turn} on ${this.name}`);
      this.baseCommit = git.head(this.root);
      this.save();
    }
    this.emit("change", {});
  }
}

const norm = (t) => t.trim().toLowerCase().replace(/\s+/g, " ");
