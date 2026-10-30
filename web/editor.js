import { carryMeta } from "/shared/diff.js";

// The plan editor. A transparent textarea sits on top of a rendered copy of the same
// text, so typing stays native while the copy carries color, marks and animation.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const STATUS_TITLE = { built: "built and tested", stale: "needs a build", blocked: "waiting on a question" };

export class Editor {
  constructor({ onEdit, onPass, onHint }) {
    this.ta = document.getElementById("ta");
    this.hl = document.getElementById("hl");
    this.gutter = document.getElementById("gutter");
    this.root = document.getElementById("editor");
    this.onEdit = onEdit;
    this.onPass = onPass;
    this.onHint = onHint;
    this.lines = [];
    this.symbols = [];
    this.suggestions = [];
    this.anyBuilt = false;
    this.accepted = new Set();
    this.ghost = "";
    this.ghostOff = false;
    this.animating = false;

    this.ta.addEventListener("input", () => this.handleInput());
    this.ta.addEventListener("keydown", (e) => this.handleKey(e));
    for (const ev of ["keyup", "click", "select"]) this.ta.addEventListener(ev, () => this.refreshCaret());
    this.gutter.addEventListener("click", (e) => this.handleGutterClick(e));
  }

  // ---------- state in ----------

  setState({ lines, symbols, suggestions, anyBuilt }) {
    this.lines = lines.map((l) => ({ ...l }));
    this.symbols = symbols || [];
    this.suggestions = suggestions || [];
    this.anyBuilt = anyBuilt;
    this.accepted.clear();
    this.symRe = this.symbols.length
      ? new RegExp(`(?<![\\w.])(${this.symbols.map((s) => s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")})(?!\\w)`, "g")
      : null;
    const text = this.lines.map((l) => l.text).join("\n");
    if (this.ta.value !== text) this.ta.value = text;
    this.render();
  }

  setEditable(on) {
    const changed = this.ta.readOnly === on;
    this.ta.readOnly = !on;
    this.root.classList.toggle("working", !on);
    if (!on) this.ghost = "";
    if (changed && !this.animating) this.render();
  }

  text() {
    return this.ta.value;
  }

  // ---------- typing ----------

  handleInput() {
    const texts = this.ta.value === "" ? [] : this.ta.value.split("\n");
    this.lines = carryMeta(this.lines, texts, { anyBuilt: this.anyBuilt });
    this.ghostOff = false;
    this.render();
    this.onEdit();
  }

  handleKey(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.onPass();
      return;
    }
    if (this.ta.readOnly) return;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      this.insert(this.ghost || "  ");
      return;
    }
    if (e.key === "Escape" && this.ghost) {
      this.ghostOff = true;
      this.render();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      // Keep the indentation of the line above.
      const { line } = this.caret();
      const indent = (this.lines[line]?.text.match(/^\s*/) || [""])[0];
      e.preventDefault();
      this.insert("\n" + indent);
    }
  }

  insert(s) {
    const { selectionStart: a, selectionEnd: b } = this.ta;
    this.ta.setRangeText(s, a, b, "end");
    this.handleInput();
  }

  caret() {
    const pos = this.ta.selectionStart;
    const before = this.ta.value.slice(0, pos);
    const line = before.split("\n").length - 1;
    const col = pos - before.lastIndexOf("\n") - 1;
    return { line, col, collapsed: this.ta.selectionStart === this.ta.selectionEnd };
  }

  refreshCaret() {
    const before = this.ghost;
    this.ghost = this.findGhost();
    if (before !== this.ghost) this.render();
    this.hint();
  }

  // The agent's suggestions are whole lines it expects you to write. Offer the rest of
  // one when what you've typed on this line starts it.
  findGhost() {
    if (this.ta.readOnly || this.ghostOff || !this.suggestions.length) return "";
    const { line, col, collapsed } = this.caret();
    const cur = this.lines[line]?.text ?? "";
    if (!collapsed || col !== cur.length) return "";
    const typed = cur.trimStart();
    if (typed.length < 2) return "";
    const others = new Set(this.lines.map((l) => l.text.trim()));
    for (const s of this.suggestions) {
      const t = s.trimStart();
      if (t.length > typed.length && t.toLowerCase().startsWith(typed.toLowerCase()) && !others.has(t)) return t.slice(typed.length);
    }
    return "";
  }

  hint() {
    const { line, col } = this.caret();
    const text = this.lines[line]?.text || "";
    const sym = this.symbols.find((s) => {
      let i = text.indexOf(s.name);
      while (i >= 0) {
        if (col >= i && col <= i + s.name.length) return true;
        i = text.indexOf(s.name, i + 1);
      }
      return false;
    });
    this.onHint(sym ? `${sym.name} · ${sym.where}` : "");
  }

  // ---------- proposals ----------

  handleGutterClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn || this.ta.readOnly) return;
    const i = Number(btn.dataset.i);
    if (btn.dataset.act === "accept") {
      this.lines[i] = { ...this.lines[i], kind: null, by: "h", chg: true, status: this.anyBuilt ? "stale" : null };
      this.accepted.add(i);
      this.render();
      this.onEdit();
    } else {
      const texts = this.lines.map((l) => l.text);
      texts.splice(i, 1);
      this.ta.value = texts.join("\n");
      this.handleInput();
    }
  }

  // ---------- rendering ----------

  render() {
    const caretLine = this.ta.readOnly ? -1 : this.caret().line;
    this.ghost = this.findGhost();
    this.hl.innerHTML = this.lines.map((l, i) => this.lineHtml(l, i === caretLine ? this.ghost : "")).join("") || '<div class="ln"></div>';
    this.gutter.innerHTML = this.lines.map((l, i) => this.gutterHtml(l, i)).join("") || this.gutterHtml({ text: "" }, 0);
    this.size();
  }

  size() {
    const cols = Math.max(40, ...this.lines.map((l) => l.text.length + 30));
    this.ta.style.width = `max(100%, ${cols}ch)`;
    this.ta.style.height = "auto";
    this.ta.style.height = `${this.ta.scrollHeight}px`;
  }

  lineHtml(l, ghost = "", extra = "", style = "") {
    const cls = ["ln", l.by || "h", l.chg ? "chg" : "", l.kind ? `k-${l.kind}` : "", extra].join(" ");
    const indent = l.text.match(/^\s*/)[0];
    const body = l.text.slice(indent.length);
    let tx = this.decorate(body);
    let chip = "";
    if (l.kind === "question") chip = `<span class="chip">${l.by === "a" ? "agent asks" : "you ask"}</span>`;
    else if (l.kind === "answer") chip = '<span class="chip">answer</span>';
    else if (l.kind === "proposal") chip = '<span class="chip">proposal</span>';
    else if (l.kind === "example") chip = '<span class="chip">becomes a test</span>';
    const g = ghost ? `<span class="ghost">${esc(ghost)}</span><span class="tabkey">Tab</span>` : "";
    return `<div class="${cls}" style="${style}">${indent}<span class="tx">${tx}</span>${g}${body ? chip : ""}</div>`;
  }

  decorate(s) {
    const e = esc(s);
    if (!this.symRe) return e;
    return e.replace(this.symRe, (m) => `<span class="sym">${m}</span>`);
  }

  gutterHtml(l, i, extra = "", style = "", pop = false) {
    const st = l.text?.trim() ? l.status : null;
    const mark = st ? `<span class="mk${pop ? " pop" : ""}" title="${STATUS_TITLE[st]}"><i class="m m-${st}"></i></span>` : '<span class="mk"></span>';
    const acts = l.kind === "proposal" && !this.ta.readOnly
      ? `<span class="acts"><button type="button" data-act="accept" data-i="${i}" title="Accept: keep it as a plain line">✓</button><button type="button" data-act="reject" data-i="${i}" title="Reject: delete it">✕</button></span>`
      : "<span></span>";
    return `<div class="g ${l.by || "h"} ${l.chg ? "chg" : ""} ${extra}" style="${style}"><span class="bar"></span><span class="no">${i + 1}</span>${mark}${acts}</div>`;
  }

  // ---------- the agent's turn, animated ----------

  // ops come from the server: keep/add/mod/del/move, in display order.
  animate(ops, oldLines, next) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const changed = ops.filter((o) => o.op !== "keep").length;
    const step = reduce ? 0 : Math.min(70, 1100 / Math.max(1, changed));
    this.lines = next.lines;
    this.symbols = next.symbols;
    this.setState({ ...next, lines: next.lines });
    if (reduce || !ops.length) return Promise.resolve();
    this.animating = true;
    let k = 0;
    let n = 0;
    const rows = [];
    const gut = [];
    for (const o of ops) {
      const d = o.op === "keep" ? 0 : k++ * step;
      const style = `--d:${d}ms`;
      if (o.op === "keep") {
        const l = next.lines[o.b];
        const was = oldLines[o.a];
        const pop = !!l.status && l.status !== was?.status;
        rows.push(this.lineHtml(l, "", "", `--d:${k * step}ms`));
        gut.push(this.gutterHtml(l, n++, "", `--d:${k * step}ms`, pop));
      } else if (o.op === "add" || o.op === "mod") {
        const l = next.lines[o.b];
        const was = o.op === "mod" ? `<span class="was">${esc(o.old)}</span>` : "";
        rows.push(this.lineHtml(l, "", `a-${o.op}`, style).replace("</div>", `${was}</div>`));
        gut.push(this.gutterHtml(l, n++, `a-${o.op}`, style, !!l.status));
      } else {
        const l = { text: o.text, by: "h" };
        const chip = o.op === "move" ? `<span class="chip">→ ${esc(o.to)}</span>` : "";
        rows.push(this.lineHtml(l, "", `a-${o.op}`, style).replace("</div>", `${chip}</div>`));
        gut.push(`<div class="g a-${o.op}" style="${style}"></div>`);
      }
    }
    this.hl.innerHTML = rows.join("");
    this.gutter.innerHTML = gut.join("");
    this.ta.style.visibility = "hidden";
    const total = k * step + 1150;
    return new Promise((resolve) => setTimeout(() => {
      this.animating = false;
      this.ta.style.visibility = "";
      this.render();
      resolve();
    }, total));
  }
}
