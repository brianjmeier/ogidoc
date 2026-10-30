// The boxes canvas. Boxes are laid out in columns by what they use: a box sits to the
// right of the boxes it uses, so the plan reads left to right like the code runs.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const STATUS = { built: "built", stale: "needs build", blocked: "waiting" };
const W = 250;
const GAP_X = 56;
const GAP_Y = 22;

export class Boxes {
  constructor({ onEdit, onPass }) {
    this.canvas = document.getElementById("canvas");
    this.empty = document.getElementById("boxes-empty");
    this.onEdit = onEdit;
    this.onPass = onPass;
    this.boxes = [];
    this.symRe = null;
    this.editable = true;
    this.editing = null;
    this.canvas.addEventListener("click", (e) => {
      const bb = e.target.closest(".bb");
      if (bb && this.editable && !this.editing) this.startEdit(bb.closest(".box").dataset.name);
    });
  }

  set(boxes, { symbols = [], editable, animate } = {}) {
    if (this.editing) return;
    this.boxes = boxes;
    this.editable = editable;
    this.symRe = symbols.length
      ? new RegExp(`(?<![\\w.])(${symbols.map((s) => s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")})(?!\\w)`, "g")
      : null;
    this.render(animate);
  }

  render(animate) {
    this.empty.hidden = this.boxes.length > 0;
    this.canvas.innerHTML = this.boxes.map((b, i) => {
      let cls = `box ${b.status}`;
      let style = "";
      if (animate && b.isNew) { cls += " pop-in"; style = `--d:${animate.delay + i * 90}ms`; }
      else if (animate && b.changed) { cls += " pulse"; style = `--d:${animate.delay}ms`; }
      const body = b.lines.map((l) => `<span class="${l.chg ? `chg ${l.by}` : ""}">${this.decorate(l.text) || " "}</span>`).join("");
      return `<div class="${cls}" style="${style}" data-name="${esc(b.name)}"><div class="bt"><span>${esc(b.name)}</span><span class="st">${STATUS[b.status] || b.status}</span></div><div class="bb" title="${this.editable ? "Click to edit" : ""}">${body}</div></div>`;
    }).join("");
    this.layout();
  }

  decorate(s) {
    const e = esc(s);
    return this.symRe ? e.replace(this.symRe, (m) => `<span class="sym">${m}</span>`) : e;
  }

  layout() {
    this.canvas.querySelector("svg")?.remove();
    const byName = new Map(this.boxes.map((b) => [b.name, b]));
    const depth = new Map();
    const visit = (name, seen = new Set()) => {
      if (depth.has(name)) return depth.get(name);
      if (seen.has(name)) return 0;
      seen.add(name);
      const uses = (byName.get(name)?.uses || []).filter((u) => byName.has(u) && u !== name);
      const d = uses.length ? 1 + Math.max(...uses.map((u) => visit(u, seen))) : 0;
      depth.set(name, d);
      return d;
    };
    for (const b of this.boxes) visit(b.name);
    const cols = new Map();
    for (const b of this.boxes) {
      const d = depth.get(b.name);
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d).push(b.name);
    }
    const els = new Map([...this.canvas.querySelectorAll(".box")].map((el) => [el.dataset.name, el]));
    const levels = [...cols.keys()].sort((a, b) => a - b);
    // Read left to right when the chain fits across the pane, otherwise top to bottom.
    const across = levels.length * (W + GAP_X) - GAP_X <= this.canvas.parentElement.clientWidth - 32;
    const rect = new Map();
    let width = 0;
    let height = 0;
    let offset = 0;
    for (const d of levels) {
      let along = 0;
      let thickest = 0;
      for (const name of cols.get(d)) {
        const el = els.get(name);
        const h = el.offsetHeight;
        const [x, y] = across ? [offset, along] : [along, offset];
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        rect.set(name, { x, y, w: W, h });
        width = Math.max(width, x + W);
        height = Math.max(height, y + h);
        along += across ? h + GAP_Y : W + GAP_Y;
        thickest = Math.max(thickest, across ? W : h);
      }
      offset += thickest + (across ? GAP_X : GAP_X * 0.6);
    }
    this.canvas.style.height = `${height}px`;
    this.canvas.style.width = `${width}px`;
    const paths = [];
    for (const b of this.boxes) {
      for (const u of b.uses || []) {
        const A = rect.get(u);
        const B = rect.get(b.name);
        if (!A || !B || u === b.name) continue;
        let d;
        if (across) {
          const x1 = A.x + A.w, y1 = A.y + Math.min(A.h / 2, 30);
          const x2 = B.x, y2 = B.y + Math.min(B.h / 2, 30);
          const c = (x1 + x2) / 2;
          d = `M${x1},${y1} C${c},${y1} ${c},${y2} ${x2},${y2}`;
        } else {
          const x1 = A.x + A.w / 2, y1 = A.y + A.h;
          const x2 = B.x + B.w / 2, y2 = B.y;
          const c = (y1 + y2) / 2;
          d = `M${x1},${y1} C${x1},${c} ${x2},${c} ${x2},${y2}`;
        }
        paths.push(`<path d="${d}" marker-end="url(#arr)"></path>`);
      }
    }
    this.canvas.insertAdjacentHTML("afterbegin", `<svg width="${width}" height="${height}" aria-hidden="true"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--muted);stroke:none"></path></marker></defs>${paths.join("")}</svg>`);
  }

  startEdit(name) {
    const b = this.boxes.find((x) => x.name === name);
    const el = this.canvas.querySelector(`.box[data-name="${CSS.escape(name)}"] .bb`);
    if (!b || !el) return;
    const ta = document.createElement("textarea");
    ta.className = "box-edit";
    ta.spellcheck = false;
    ta.value = b.lines.map((l) => l.text).join("\n");
    ta.rows = Math.max(3, b.lines.length + 1);
    el.replaceWith(ta);
    this.editing = name;
    ta.focus();
    const finish = (pass) => {
      if (this.editing !== name) return;
      this.editing = null;
      this.onEdit(name, ta.value);
      if (pass) this.onPass();
    };
    ta.addEventListener("blur", () => finish(false));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { this.editing = null; this.render(); }
    });
    this.layout();
  }

  // Make sure an open box editor is saved before the pen moves.
  flush() {
    const ta = this.canvas.querySelector("textarea.box-edit");
    if (ta && this.editing) {
      const name = this.editing;
      this.editing = null;
      this.onEdit(name, ta.value);
    }
  }

  pulse(name, delay) {
    const el = this.canvas.querySelector(`.box[data-name="${CSS.escape(name)}"]`);
    if (!el) return;
    el.classList.remove("pulse");
    el.style.setProperty("--d", `${delay}ms`);
    void el.offsetWidth;
    el.classList.add("pulse");
  }
}
