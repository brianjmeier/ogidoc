// Ogimap's editor: the flow map, the person's edits on it, and the agent's turns.
// No build step and no framework: the map is small, so each change redraws it.

const $ = (id) => document.getElementById(id);
const W = 260, GAP_X = 140, GAP_Y = 26, PAD = 40;

const S = {
  snap: null,          // the server's state: map, layout, busy, last…
  draft: null,         // the person's copy of the map, with their edits
  level: null,         // the node whose inside we're looking at (null = top)
  selected: new Set(),
  edge: null,          // the selected wire's key
  flow: null,          // the flow being played
  editing: null,       // the node being edited
  ways: {},            // node id → which way is showing (0 = the one built)
  view: { x: 0, y: 0, z: 1 },
  fresh: new Set(),    // nodes the agent just changed
  scope: "task",       // with a task: its part of the map, or the whole map
  fitted: undefined,
};

let newId = 0;
const clone = (x) => JSON.parse(JSON.stringify(x));
const byId = () => new Map(S.draft.nodes.map((n) => [n.id, n]));
const orig = (id) => S.snap.map?.nodes.find((n) => n.id === id);
const busy = () => !!S.snap?.busy;

// ---------- the server ----------

const events = new EventSource("/api/events");
let activity = [];
events.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (ev.type === "activity") { activity.push(ev.text); showActivity(); if (scoping()) renderTask(); }
  if (ev.type === "state") receive(ev);
};

function receive(snap) {
  const prev = S.snap;
  const turnEnded = prev?.busy && !snap.busy;
  S.snap = snap;
  activity = snap.activity ?? [];
  // A failed turn keeps the person's edits, so they can try again.
  const keepEdits = turnEnded && snap.last?.error && S.draft;
  if (!keepEdits && (!S.draft || turnEnded || !prev?.map || (!snap.busy && prev.map !== snap.map && !dirty()))) {
    if (turnEnded) { markFresh(prev.map, snap.map, snap.last?.changed ?? []); S.fitted = undefined; }
    S.draft = snap.map ? clone(snap.map) : null;
    S.ways = {};
    S.editing = null;
    if (S.level && !S.draft?.nodes.some((n) => n.id === S.level)) S.level = null;
  }
  render();
}

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
}

function markFresh(before, after, changed) {
  S.fresh = new Set(changed);
  const was = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  for (const n of after?.nodes ?? []) {
    const o = was.get(n.id);
    if (!o || o.pseudo.join("\n") !== n.pseudo.join("\n") || o.name !== n.name) S.fresh.add(n.id);
  }
  for (const id of S.fresh) {
    // A changed child makes its parent glow too, so the change is findable from above.
    let p = after?.nodes.find((n) => n.id === id)?.parent;
    while (p) { S.fresh.add(p); p = after.nodes.find((n) => n.id === p)?.parent; }
  }
  setTimeout(() => { S.fresh.clear(); render(); }, 2600);
}

// ---------- the person's edits ----------

function dirty() {
  return !!S.draft && !!S.snap?.map && JSON.stringify(S.draft) !== JSON.stringify(S.snap.map);
}

function editCount() {
  if (!S.draft || !S.snap?.map) return 0;
  let n = 0;
  for (const node of S.draft.nodes) {
    const o = orig(node.id);
    if (!o || node.removed || o.name !== node.name || o.pseudo.join("\n") !== node.pseudo.join("\n")) n++;
  }
  const key = (e) => `${e.from}→${e.to}`;
  const old = new Set(S.snap.map.edges.map(key));
  for (const e of S.draft.edges) if (e.removed || !old.has(key(e))) n++;
  return n;
}

function toggleRemove() {
  if (busy()) return;
  if (S.edge) {
    const wire = lastWires.get(S.edge);
    for (const e of wire?.members ?? []) {
      if (e.by === "human") S.draft.edges = S.draft.edges.filter((x) => x !== e);
      else e.removed = !wire.removed;
    }
    S.edge = null;
  } else {
    for (const id of S.selected) {
      const n = byId().get(id);
      if (!n) continue;
      if (n.by === "human") {
        S.draft.nodes = S.draft.nodes.filter((x) => x.id !== id);
        S.draft.edges = S.draft.edges.filter((e) => e.from !== id && e.to !== id);
      } else n.removed = !n.removed;
    }
  }
  render();
}

function addNode(x, y) {
  if (busy() || !S.draft) return;
  const id = `new${++newId}`;
  S.draft.nodes.push({ id, name: "", parent: S.level, kind: "step", pseudo: [], status: "stale", by: "human" });
  S.snap.layout[id] = { x, y };
  S.selected = new Set([id]);
  S.editing = id;
  render();
}

function commitEdit(box) {
  const id = S.editing;
  if (!id) return;
  const n = byId().get(id);
  S.editing = null;
  if (!n) return render();
  const name = box?.querySelector("input")?.value.trim() ?? n.name;
  const lines = (box?.querySelector("textarea")?.value ?? n.pseudo.join("\n")).split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines.at(-1)) lines.pop();
  const kind = box?.querySelector("select")?.value ?? n.kind;
  if (n.by === "human" && !name && !lines.length) {
    S.draft.nodes = S.draft.nodes.filter((x) => x !== n);
    S.selected.delete(id);
    return render();
  }
  n.name = name || n.name || "untitled";
  n.pseudo = lines;
  n.kind = kind;
  if (n.by === "human" && /^new\d+$/.test(n.id)) {
    // A sketched node's id comes from its name, so the agent reads something meaningful.
    const base = (S.level ? `${S.level}.` : "") + n.name.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "");
    let nid = base, k = 1;
    while (byId().has(nid) && nid !== n.id) nid = `${base}${++k}`;
    for (const e of S.draft.edges) { if (e.from === n.id) e.from = nid; if (e.to === n.id) e.to = nid; }
    if (S.snap.layout[n.id]) { S.snap.layout[nid] = S.snap.layout[n.id]; delete S.snap.layout[n.id]; }
    S.selected.delete(n.id); S.selected.add(nid);
    n.id = nid;
  }
  render();
}

function cycleWay(id, step) {
  const o = orig(id);
  if (!o?.ways?.length || busy()) return;
  const count = o.ways.length + 1;
  const k = ((S.ways[id] ?? 0) + step + count) % count;
  S.ways[id] = k;
  byId().get(id).pseudo = clone(k === 0 ? o.pseudo : o.ways[k - 1].pseudo);
  render();
}

async function pass() {
  if (busy() || !S.draft) return;
  if (S.editing) commitEdit(document.querySelector(`.box[data-id="${CSS.escape(S.editing)}"]`));
  try {
    await post("/api/turn", { draft: S.draft, focus: [...S.selected] });
  } catch (e) {
    showActivity(e.message, "error");
  }
}

// ---------- levels: what is visible, and wires lifted to it ----------

function ancestorAt(id, level, nodes) {
  let n = nodes.get(id);
  while (n && (n.parent ?? null) !== level) n = n.parent ? nodes.get(n.parent) : undefined;
  return n?.id ?? null;
}
const isInside = (id, level, nodes) => level === null || ancestorAt(id, level, nodes) !== null;

// A wire end outside the level shows as a ghost: the nearest node that is a sibling of
// an ancestor of this level, so it reads like "comes from routes".
function outsideEnd(id, nodes) {
  const chain = [];
  for (let p = S.level; p; p = nodes.get(p)?.parent ?? null) chain.push(p);
  chain.push(null);
  for (const lvl of chain.slice(1)) {
    const a = ancestorAt(id, lvl, nodes);
    if (a && !chain.includes(a)) return a;
  }
  return null;
}

let lastWires = new Map();

// With a task, the map shows the task's part of it unless the person asks for the whole.
// What the person sketched is always theirs to see.
function inScope(id) {
  const focus = S.snap?.task?.focus;
  if (!focus || S.scope === "all") return true;
  return focus.includes(id) || !orig(id);
}

function visible() {
  const nodes = byId();
  const shown = S.draft.nodes.filter((n) => (n.parent ?? null) === S.level && inScope(n.id));
  const ghosts = new Map();
  const wires = new Map();
  for (const e of S.draft.edges) {
    const inA = isInside(e.from, S.level, nodes), inB = isInside(e.to, S.level, nodes);
    if (!inA && !inB) continue;
    let a = inA ? ancestorAt(e.from, S.level, nodes) : outsideEnd(e.from, nodes);
    let b = inB ? ancestorAt(e.to, S.level, nodes) : outsideEnd(e.to, nodes);
    if (!a || !b || a === b || !inScope(a) || !inScope(b)) continue;
    if (!inA) { ghosts.set(a, "in"); a = `ghost:${a}`; }
    if (!inB) { ghosts.set(b, ghosts.get(b) === "in" ? "both" : "out"); b = `ghost:${b}`; }
    const key = `${a}→${b}`;
    const w = wires.get(key) ?? { key, from: a, to: b, labels: new Set(), members: [], human: false, removed: true, ghost: !inA || !inB };
    if (e.label) w.labels.add(e.label);
    w.members.push(e);
    w.human ||= e.by === "human";
    w.removed &&= !!e.removed;
    wires.set(key, w);
  }
  return { nodes, shown, ghosts, wires };
}

// ---------- layout ----------

function autoRank(ids, wires) {
  const out = new Map(ids.map((id) => [id, []]));
  for (const w of wires.values()) if (out.has(w.from) && out.has(w.to)) out.get(w.from).push(w.to);
  const rank = new Map(ids.map((id) => [id, 0]));
  // Longest path from the sources; a cycle stops where it meets itself.
  const visit = (id, r, path) => {
    if (path.has(id) || r <= (rank.get(id) ?? 0) && path.size) return;
    rank.set(id, Math.max(rank.get(id), r));
    path.add(id);
    for (const t of out.get(id)) visit(t, r + 1, path);
    path.delete(id);
  };
  const hasIn = new Set([...out.values()].flat());
  for (const id of ids) if (!hasIn.has(id)) visit(id, 0, new Set());
  for (const id of ids) if (!rank.get(id) && hasIn.has(id)) visit(id, 0, new Set());
  return rank;
}

// ---------- drawing ----------

const boxesEl = $("boxes"), wiresEl = $("wires"), world = $("world"), viewport = $("viewport");

function render() {
  renderTop();
  renderTask();
  renderFlows();
  const empty = $("empty");
  if (!S.draft) {
    boxesEl.innerHTML = "";
    wiresEl.querySelectorAll("path,text,circle").forEach((e) => e.remove());
    empty.hidden = false;
    empty.innerHTML = S.snap?.busy === "mapping" ? "<div>The agent is reading the code and drawing the map…</div>" : "<div>No map yet.</div>";
    return;
  }
  empty.hidden = true;
  const { nodes, shown, ghosts, wires } = visible();
  lastWires = wires;
  const flow = flowAt(nodes);

  boxesEl.innerHTML = "";
  const els = new Map();
  for (const n of shown) els.set(n.id, boxEl(n, nodes, flow));
  for (const [id, dir] of ghosts) {
    const n = nodes.get(id);
    const el = document.createElement("div");
    el.className = "box ghost-node";
    el.dataset.id = `ghost:${id}`;
    el.innerHTML = `<div class="bh"><span class="name"></span></div>`;
    el.querySelector(".name").textContent = (dir === "in" ? "from " : dir === "out" ? "to " : "") + (n.parent ? `${nodes.get(n.parent)?.name}.` : "") + n.name;
    el.title = "Go there";
    el.onclick = () => goTo(n.parent ?? null, id);
    els.set(`ghost:${id}`, el);
  }
  for (const el of els.values()) boxesEl.appendChild(el);

  // Place: the person's own positions first, the rest in columns by what they use.
  const layout = S.snap.layout ?? (S.snap.layout = {});
  const ids = [...els.keys()];
  const rank = autoRank(ids.filter((id) => !id.startsWith("ghost:")), wires);
  let maxRank = Math.max(0, ...rank.values());
  for (const [id, dir] of ghosts) rank.set(`ghost:${id}`, dir === "out" ? maxRank + 1 : -1);
  const minRank = Math.min(0, ...rank.values());
  const cols = new Map();
  for (const id of ids) {
    const r = rank.get(id) - minRank;
    if (!cols.has(r)) cols.set(r, []);
    cols.get(r).push(id);
  }
  const pos = new Map();
  for (const [r, col] of cols) {
    let y = PAD;
    for (const id of col) {
      const el = els.get(id);
      const saved = layout[id];
      const p = saved ? { x: saved.x, y: saved.y } : { x: PAD + r * (W + GAP_X) + (id.startsWith("ghost:") ? 60 : 0), y };
      if (!saved) y += el.offsetHeight + GAP_Y;
      pos.set(id, p);
    }
  }
  for (const [id, p] of pos) {
    const el = els.get(id);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
  }

  // Wires: from a box's right edge to the next one's left edge.
  wiresEl.querySelectorAll("path,text,circle,g").forEach((e) => e.remove());
  const rect = (id) => {
    const el = els.get(id), p = pos.get(id);
    return el && p ? { x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight } : null;
  };
  const flowPairs = new Set();
  if (flow) for (let i = 1; i < flow.steps.length; i++) flowPairs.add(`${flow.steps[i - 1]}→${flow.steps[i]}`);
  const paths = new Map();
  for (const w of wires.values()) {
    const a = rect(w.from), b = rect(w.to);
    if (!a || !b) continue;
    const d = wirePath(a, b);
    const onFlow = flowPairs.has(w.key);
    const cls = ["wire", w.human && "human", w.removed && "removed", S.edge === w.key && "sel", onFlow && "flow", flow && !onFlow && "dim", w.ghost && "ghostwire"].filter(Boolean).join(" ");
    const hit = svg("path", { d, class: "hit" });
    const path = svg("path", { d, class: cls });
    for (const p of [hit, path]) p.addEventListener("mousedown", (ev) => { ev.stopPropagation(); S.edge = w.key; S.selected.clear(); render(); });
    wiresEl.append(hit, path);
    paths.set(w.key, path);
    if (w.labels.size) {
      const mid = path.getPointAtLength(path.getTotalLength() / 2);
      const t = svg("text", { x: mid.x, y: mid.y - 5, "text-anchor": "middle", class: flow && !onFlow ? "dim" : "" });
      t.textContent = w.members.length > 1 ? `${w.members.length} ${w.members.every((e) => e.kind === "data") ? "flows" : "calls"}` : [...w.labels][0];
      wiresEl.append(t);
    }
  }
  // Flow steps that aren't wired still get a path, so the token can travel them.
  if (flow) {
    for (const k of flowPairs) {
      if (paths.has(k)) continue;
      const [f, t] = k.split("→"), a = rect(f), b = rect(t);
      if (!a || !b) continue;
      const p = svg("path", { d: wirePath(a, b), class: "wire flow ghostwire" });
      wiresEl.append(p);
      paths.set(k, p);
    }
  }
  const bounds = [...pos.keys()].map(rect).filter(Boolean);
  const maxX = Math.max(800, ...bounds.map((r) => r.x + r.w + PAD)), maxY = Math.max(500, ...bounds.map((r) => r.y + r.h + PAD));
  wiresEl.setAttribute("width", maxX);
  wiresEl.setAttribute("height", maxY);
  S.bounds = { w: maxX, h: maxY };
  if (S.fitted !== S.level) { S.fitted = S.level; fit(); }
  applyView();
  play(flow, paths, els);

  if (S.editing) {
    const ed = els.get(S.editing);
    (ed?.querySelector(ed.querySelector("input").value ? "textarea" : "input"))?.focus({ preventScroll: true });
  }
}

function wirePath(a, b) {
  const x1 = a.x + a.w, y1 = a.y + Math.min(19, a.h / 2), x2 = b.x, y2 = b.y + Math.min(19, b.h / 2);
  if (x2 > x1 + 20) {
    const c = Math.max(30, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2 - 2},${y2}`;
  }
  // Backwards or stacked: leave from the bottom and come in from the top.
  const sx = a.x + a.w / 2, sy = a.y + a.h, tx = b.x + b.w / 2, ty = b.y;
  if (ty > sy) return `M${sx},${sy} C${sx},${sy + 40} ${tx},${ty - 40} ${tx},${ty - 2}`;
  return `M${x1},${y1} C${x1 + 70},${y1} ${b.x + b.w + 70},${b.y + 19} ${b.x + b.w + 2},${b.y + 19}`;
}

function svg(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function boxEl(n, nodes, flow) {
  const el = document.createElement("div");
  const o = orig(n.id);
  const kids = S.draft.nodes.filter((c) => c.parent === n.id && !c.removed).length;
  const wayK = S.ways[n.id] ?? 0;
  const inFlow = flow?.order.get(n.id);
  el.className = ["box", `kind-${n.kind}`, `status-${n.status ?? "built"}`, n.by === "human" && "human", n.removed && "removed",
    S.selected.has(n.id) && "selected", flow && !inFlow && "dim", busy() && S.selected.has(n.id) && "working", S.fresh.has(n.id) && "fresh"].filter(Boolean).join(" ");
  el.dataset.id = n.id;
  el.tabIndex = 0;

  const head = document.createElement("div");
  head.className = "bh";
  head.innerHTML = `<i class="dot ${n.by === "human" ? "stale" : n.status ?? "built"}"></i><span class="name"></span><span class="kind"></span>`;
  head.querySelector(".name").textContent = n.name || "untitled";
  head.querySelector(".name").title = n.id;
  head.querySelector(".kind").textContent = n.kind;
  if (S.snap.drift?.includes(n.id)) {
    const d = document.createElement("span");
    d.className = "drift";
    d.textContent = "code changed";
    d.title = "The code changed since the map said this; the next turn re-reads it.";
    head.insertBefore(d, head.querySelector(".kind"));
  }
  if (kids) {
    const open = document.createElement("button");
    open.className = "open" + (editedInside(n.id) ? " edited" : "");
    open.textContent = `▸ ${kids}`;
    open.title = "Open";
    open.onclick = (ev) => { ev.stopPropagation(); goTo(n.id); };
    head.appendChild(open);
  }
  el.appendChild(head);
  if (inFlow) {
    const b = document.createElement("span");
    b.className = "order";
    b.textContent = inFlow.join("·");
    el.appendChild(b);
  }

  if (S.editing === n.id) {
    const ed = document.createElement("div");
    ed.className = "edit";
    ed.innerHTML = `<div class="row"><input placeholder="name"><select>${["step", "module", "entry", "store", "external"].map((k) => `<option>${k}</option>`).join("")}</select></div><textarea spellcheck="false" placeholder="pseudocode, one line each"></textarea><small>Esc or click away to keep · ⌘↵ to pass the pen</small>`;
    ed.querySelector("input").value = n.name;
    ed.querySelector("select").value = n.kind;
    ed.querySelector("textarea").value = n.pseudo.join("\n");
    ed.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") commitEdit(el);
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { commitEdit(el); pass(); }
    });
    ed.addEventListener("mousedown", (ev) => ev.stopPropagation());
    el.appendChild(ed);
  } else {
    const ol = document.createElement("ol");
    ol.className = "pseudo";
    for (const [cls, line] of pseudoView(n, o, wayK)) {
      const li = document.createElement("li");
      if (cls) li.className = cls;
      li.textContent = line;
      ol.appendChild(li);
    }
    el.appendChild(ol);
  }

  if (o?.ways?.length && !n.removed) {
    const ways = document.createElement("div");
    ways.className = "ways";
    ways.innerHTML = `<span class="tag">${wayK ? "another way" : "agent's pick"}</span><button aria-label="Previous way">‹</button><span>${wayK + 1} of ${o.ways.length + 1}</span><button aria-label="Next way">›</button>`;
    const [prev, next] = ways.querySelectorAll("button");
    prev.onclick = (ev) => { ev.stopPropagation(); cycleWay(n.id, -1); };
    next.onclick = (ev) => { ev.stopPropagation(); cycleWay(n.id, 1); };
    el.appendChild(ways);
  }

  if (n.code?.length) {
    const refs = document.createElement("div");
    refs.className = "refs";
    for (const c of n.code.slice(0, 3)) {
      const b = document.createElement("button");
      b.textContent = `${c.file.split("/").at(-1)}${c.line ? `:${c.line}` : ""}`;
      b.title = `${c.file}${c.symbol ? ` · ${c.symbol}` : ""}`;
      b.onclick = (ev) => { ev.stopPropagation(); openCode(c); };
      refs.appendChild(b);
    }
    el.appendChild(refs);
  }

  const port = document.createElement("span");
  port.className = "port";
  port.title = "Drag to draw an arrow";
  port.addEventListener("mousedown", (ev) => startWire(ev, n.id));
  el.appendChild(port);

  head.addEventListener("mousedown", (ev) => startMove(ev, el, n.id));
  el.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("button,.edit")) return;
    ev.stopPropagation();
    select(n.id, ev.shiftKey || ev.metaKey);
  });
  el.addEventListener("dblclick", (ev) => {
    if (busy() || ev.target.closest("button")) return;
    ev.stopPropagation();
    S.editing = n.id;
    render();
  });
  return el;
}

// Whether the person changed something inside this node, so it shows from above.
function editedInside(id) {
  const nodes = byId();
  const under = (n) => { for (let p = n.parent; p; p = nodes.get(p)?.parent) if (p === id) return true; return false; };
  for (const n of S.draft.nodes) {
    if (!under(n)) continue;
    const o = orig(n.id);
    if (!o || n.removed || o.name !== n.name || o.pseudo.join("\n") !== n.pseudo.join("\n")) return true;
  }
  return false;
}

// The pseudocode as the person should read it: their edits in blue, crossed-out lines
// in red, another way in grey, and the task's plan (what will change) in green.
function pseudoView(n, o, wayK) {
  if (wayK) return n.pseudo.map((l) => ["way", l]);
  if (!o || n.by === "human") return n.pseudo.map((l) => ["add", l]);
  if (n.removed) return n.pseudo.map((l) => ["", l]);
  if (o.status === "proposal" && n.pseudo.join("\n") === o.pseudo.join("\n")) return n.pseudo.map((l) => ["plan-add", l]);
  if (o.was && n.pseudo.join("\n") === o.pseudo.join("\n")) return diff(o.was, o.pseudo).map(([op, l]) => [op === "=" ? "" : op === "+" ? "plan-add" : "plan-del", l]);
  const ops = diff(o.pseudo, n.pseudo);
  const fresh = S.fresh.has(n.id);
  return ops.map(([op, l]) => [op === "=" ? (fresh && n.status !== "built" ? "agentnew" : "") : op === "+" ? "add" : "del", l]);
}

function diff(a, b) {
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(["=", b[j]]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push(["-", a[i++]]);
    else out.push(["+", b[j++]]);
  }
  while (i < n) out.push(["-", a[i++]]);
  while (j < m) out.push(["+", b[j++]]);
  return out;
}

// ---------- the task: prompt, scoping chat, then the map ----------

const phase = () => S.snap?.task?.phase ?? null;
// Scoping shows while there's no task and no map, or while the task is being scoped.
const scoping = () => (!S.snap?.task && !S.snap?.map) || phase() === "scope" || phase() === "frame";

function renderTask() {
  const task = S.snap?.task;
  const on = scoping();
  const scope = $("scope");
  scope.hidden = !on;
  scope.classList.toggle("alone", on && !S.draft);
  viewport.hidden = on && !S.draft;
  document.querySelector(".flows").hidden = on;
  $("scope-title").textContent = task?.title || "What do you want to change?";
  if (on) fillThread($("thread"), task, true);
  $("composer").hidden = !!task && phase() !== "scope";
  $("say").placeholder = task ? "answer, or say what's missing" : "e.g. short links should expire after a while";
  $("send").disabled = busy();

  const chip = $("taskchip");
  chip.hidden = on || !task;
  if (task && !on) {
    const b = $("taskchip-btn");
    b.innerHTML = "";
    b.append(task.title || "task");
    const small = document.createElement("small");
    small.textContent = phase() === "done" ? "✓ done: everything on its map is built" : "the plan is the green on the map";
    b.appendChild(small);
    fillThread($("minithread"), task, false);
  }
}

function fillThread(ol, task, live) {
  ol.innerHTML = "";
  for (const m of task?.messages ?? []) {
    const li = document.createElement("li");
    li.className = m.who;
    // `names` in the agent's words read as code.
    for (const [i, part] of m.text.split("`").entries()) {
      if (i % 2) { const c = document.createElement("code"); c.textContent = part; li.appendChild(c); continue; }
      for (const [j, bit] of part.split("**").entries()) {
        if (j % 2) { const b = document.createElement("b"); b.textContent = bit; li.appendChild(b); }
        else li.append(bit);
      }
    }
    if (m.refs?.length) {
      const refs = document.createElement("div");
      refs.className = "refs";
      for (const r of m.refs.slice(0, 6)) {
        const b = document.createElement("button");
        b.textContent = `${r.file.split("/").at(-1)}${r.line ? `:${r.line}` : ""}`;
        b.title = r.file;
        b.onclick = () => openCode(r);
        refs.appendChild(b);
      }
      li.appendChild(refs);
    }
    ol.appendChild(li);
  }
  if (!live) return;
  if (task?.brief && phase() !== "scope") {
    const li = document.createElement("li");
    li.className = "ready";
    li.innerHTML = "<b>Ready to build.</b> ";
    li.append(task.brief);
    ol.appendChild(li);
  }
  if (busy()) {
    const li = document.createElement("li");
    li.className = "live";
    li.textContent = S.snap.busy === "framing" ? `drawing the map for this task · ${activity.at(-1) ?? ""}` : `reading the code · ${activity.at(-1) ?? ""}`;
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

async function say() {
  const text = $("say").value.trim();
  if (busy() || (!text && !S.snap?.task)) return;
  try {
    if (S.snap?.task) await post("/api/ask", { text });
    else await post("/api/task", { prompt: text });
    $("say").value = "";
  } catch (e) {
    showActivity(e.message, "error");
  }
}
$("composer").addEventListener("submit", (ev) => { ev.preventDefault(); say(); });
$("say").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); say(); }
});
$("taskchip-btn").onclick = () => {
  const open = $("minithread").hidden;
  $("minithread").hidden = !open;
  $("taskchip-btn").setAttribute("aria-expanded", String(open));
};
$("newtask").onclick = () => post("/api/task/close").catch((e) => showActivity(e.message, "error"));

// ---------- flows: a path you can watch ----------

function flowAt(nodes) {
  const f = S.draft.flows?.find((x) => x.id === S.flow);
  if (!f) return null;
  const steps = [];
  for (const s of f.steps) {
    if (!nodes.has(s)) continue;
    let id = isInside(s, S.level, nodes) ? ancestorAt(s, S.level, nodes) : outsideEnd(s, nodes);
    if (!id) continue;
    if (!isInside(s, S.level, nodes)) id = `ghost:${id}`;
    if (steps.at(-1) !== id) steps.push(id);
  }
  const order = new Map();
  steps.forEach((id, i) => order.set(id, [...(order.get(id) ?? []), i + 1]));
  return { steps, order };
}

let anim = 0;
function play(flow, paths, els) {
  cancelAnimationFrame(anim);
  wiresEl.querySelector("circle.token")?.remove();
  if (!flow || flow.steps.length < 2 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const token = svg("circle", { r: 6, class: "token" });
  wiresEl.appendChild(token);
  const legs = [];
  for (let i = 1; i < flow.steps.length; i++) legs.push({ path: paths.get(`${flow.steps[i - 1]}→${flow.steps[i]}`), to: flow.steps[i], from: flow.steps[i - 1] });
  const LEG = 750, REST = 350;
  const total = legs.length * (LEG + REST) + 600;
  let start = performance.now();
  const lit = (id) => { for (const el of els.values()) el.classList.toggle("lit", el.dataset.id === id); };
  const tick = (now) => {
    let t = (now - start) % total;
    const leg = Math.floor(t / (LEG + REST));
    const l = legs[leg];
    if (!l) { lit(flow.steps.at(-1)); token.setAttribute("opacity", 0); }
    else {
      const k = Math.min(1, (t - leg * (LEG + REST)) / LEG);
      token.setAttribute("opacity", 1);
      if (l.path) {
        const len = l.path.getTotalLength();
        const p = l.path.getPointAtLength(ease(k) * len);
        token.setAttribute("cx", p.x); token.setAttribute("cy", p.y);
      }
      lit(k < 1 ? l.from : l.to);
    }
    anim = requestAnimationFrame(tick);
  };
  anim = requestAnimationFrame(tick);
}
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

function renderFlows() {
  const ol = $("flows");
  ol.innerHTML = "";
  for (const f of (S.draft?.flows ?? []).filter((f) => f.steps.some(inScope))) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = f.name;
    b.setAttribute("aria-pressed", String(S.flow === f.id));
    b.onclick = () => { S.flow = S.flow === f.id ? null : f.id; render(); };
    li.appendChild(b);
    ol.appendChild(li);
  }
  if (!ol.children.length) ol.innerHTML = `<li style="color:var(--muted);font-size:12px">none yet</li>`;
}

// ---------- top bar ----------

function renderTop() {
  const snap = S.snap;
  $("where").textContent = snap ? `${snap.map?.title ?? snap.project} · ${snap.agent}` : "";
  const crumbs = $("crumbs");
  crumbs.innerHTML = "";
  if (S.draft) {
    const nodes = byId();
    const chain = [];
    for (let p = S.level; p; p = nodes.get(p)?.parent ?? null) chain.unshift(p);
    const add = (label, level, here) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (here) b.className = "here";
      b.onclick = () => goTo(level);
      crumbs.appendChild(b);
    };
    add("map", null, !chain.length);
    chain.forEach((id, i) => { crumbs.append("›"); add(nodes.get(id)?.name ?? id, id, i === chain.length - 1); });
  }
  const n = editCount();
  $("edits").hidden = !n;
  $("edits").textContent = `${n} edit${n === 1 ? "" : "s"}`;
  $("reset").hidden = !n || busy();
  $("undo").hidden = !snap?.canUndo || busy();
  const pen = $("pen");
  pen.textContent = busy()
    ? ({ mapping: "agent is mapping", scoping: "agent is reading", framing: "agent is drawing" }[snap.busy] ?? "agent's pen")
    : scoping() ? "your turn to say" : "your pen";
  pen.className = busy() ? "pen agent" : "pen";
  $("pass").disabled = busy() || !S.draft;
  $("pass").hidden = scoping();
  const focus = snap?.task?.focus;
  const whole = $("scopeview");
  whole.hidden = scoping() || !focus || !snap?.map || snap.map.nodes.length <= focus.length;
  whole.textContent = S.scope === "task" ? `Show the whole map (${snap?.map?.nodes.length ?? 0} boxes)` : "Show this task only";
  $("newtask").hidden = busy() || scoping() || !(phase() === "done" || !snap?.task);
  if (phase() === "done") $("newtask").className = "primary";
  else $("newtask").className = "ghost";
  showActivity();
}

function showActivity(override, kind) {
  const el = $("activity");
  if (override) { el.textContent = override; el.className = `activity ${kind ?? ""}`; return; }
  const snap = S.snap;
  if (busy()) { el.textContent = activity.at(-1) ?? "…"; el.className = "activity agent"; }
  else if (snap?.last?.error) { el.textContent = snap.last.error; el.className = "activity error"; }
  else if (snap?.hint && !dirty()) { el.textContent = (snap.last?.summary ? `✓ ${snap.last.summary}   ·   ` : "") + snap.hint; el.className = "activity hint"; }
  else { el.textContent = snap?.last?.summary ?? ""; el.className = "activity"; }
}

function goTo(level, focus) {
  S.level = level;
  S.selected = new Set(focus ? [focus] : []);
  S.edge = null;
  render();
}

function select(id, add) {
  const hadEdge = S.edge;
  S.edge = null;
  if (add) S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
  else S.selected = new Set([id]);
  // Restyle in place: redrawing here would swallow the second click of a double-click.
  if (hadEdge) return render();
  for (const el of boxesEl.querySelectorAll(".box")) el.classList.toggle("selected", S.selected.has(el.dataset.id));
}

// ---------- pointer: pan, zoom, move boxes, draw wires ----------

function applyView() {
  world.style.transform = `translate(${S.view.x}px, ${S.view.y}px) scale(${S.view.z})`;
}

function fit() {
  if (!S.bounds) return;
  const r = viewport.getBoundingClientRect();
  const z = Math.min(1.1, Math.max(0.35, Math.min(r.width / S.bounds.w, r.height / S.bounds.h)));
  S.view = { z, x: Math.max(0, (r.width - S.bounds.w * z) / 2), y: Math.max(0, (r.height - S.bounds.h * z) / 2) };
  applyView();
}

const toWorld = (ev) => {
  const r = viewport.getBoundingClientRect();
  return { x: (ev.clientX - r.left - S.view.x) / S.view.z, y: (ev.clientY - r.top - S.view.y) / S.view.z };
};

viewport.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  if (S.editing) commitEdit(document.querySelector(`.box[data-id="${CSS.escape(S.editing)}"]`));
  const start = { x: ev.clientX, y: ev.clientY, vx: S.view.x, vy: S.view.y };
  let moved = false;
  viewport.classList.add("panning");
  const move = (e) => {
    moved ||= Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3;
    S.view.x = start.vx + e.clientX - start.x;
    S.view.y = start.vy + e.clientY - start.y;
    applyView();
  };
  const up = () => {
    viewport.classList.remove("panning");
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    if (!moved && (S.selected.size || S.edge)) { S.selected.clear(); S.edge = null; render(); }
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
});

viewport.addEventListener("dblclick", (ev) => {
  if (ev.target.closest(".box")) return;
  const p = toWorld(ev);
  addNode(p.x - 20, p.y - 15);
});

viewport.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  if (!ev.ctrlKey && !ev.metaKey && Math.abs(ev.deltaX) + Math.abs(ev.deltaY) < 60 && !Number.isInteger(ev.deltaY)) {
    S.view.x -= ev.deltaX; S.view.y -= ev.deltaY; return applyView();
  }
  const r = viewport.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  const z = Math.min(2, Math.max(0.25, S.view.z * Math.exp(-ev.deltaY * 0.0015)));
  S.view.x = mx - ((mx - S.view.x) * z) / S.view.z;
  S.view.y = my - ((my - S.view.y) * z) / S.view.z;
  S.view.z = z;
  applyView();
}, { passive: false });

function startMove(ev, el, id) {
  if (ev.button !== 0 || ev.target.closest("button")) return;
  ev.stopPropagation();
  if (!S.selected.has(id)) select(id, ev.shiftKey);
  const start = { x: ev.clientX, y: ev.clientY, left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
  let moved = false;
  const box = () => document.querySelector(`.box[data-id="${CSS.escape(id)}"]`);
  const move = (e) => {
    moved = true;
    const b = box();
    b.style.left = `${start.left + (e.clientX - start.x) / S.view.z}px`;
    b.style.top = `${start.top + (e.clientY - start.y) / S.view.z}px`;
  };
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    if (!moved) return;
    const b = box();
    // Pin every box on this level where it is now, so the auto layout doesn't shuffle them.
    for (const other of document.querySelectorAll(".box:not(.ghost-node)")) S.snap.layout[other.dataset.id] = { x: parseFloat(other.style.left), y: parseFloat(other.style.top) };
    S.snap.layout[id] = { x: parseFloat(b.style.left), y: parseFloat(b.style.top) };
    post("/api/layout", { layout: S.snap.layout }).catch(() => {});
    render();
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
}

function startWire(ev, from) {
  if (busy()) return;
  ev.stopPropagation();
  ev.preventDefault();
  const a = toWorld(ev);
  const temp = svg("path", { class: "temp" });
  wiresEl.appendChild(temp);
  let target = null;
  const move = (e) => {
    const b = toWorld(e);
    temp.setAttribute("d", `M${a.x},${a.y} C${a.x + 60},${a.y} ${b.x - 60},${b.y} ${b.x},${b.y}`);
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".box:not(.ghost-node)");
    document.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
    target = over && over.dataset.id !== from ? over.dataset.id : null;
    if (target) over.classList.add("drop-target");
  };
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    temp.remove();
    if (!target) return render();
    const existing = S.draft.edges.find((e) => e.from === from && e.to === target);
    if (existing) existing.removed = false;
    else S.draft.edges.push({ from, to: target, kind: "call", by: "human" });
    render();
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
}

// ---------- keys ----------

addEventListener("keydown", (ev) => {
  if (ev.target.closest?.("input,textarea,select")) return;
  const mod = ev.metaKey || ev.ctrlKey;
  if (ev.key === "Enter" && mod) { ev.preventDefault(); return scoping() ? say() : pass(); }
  if (ev.key === "Escape") { S.selected.clear(); S.edge = null; S.flow = null; return render(); }
  if ((ev.key === "Backspace" || ev.key === "Delete") && (S.selected.size || S.edge)) { ev.preventDefault(); return toggleRemove(); }
  if (ev.key === "Enter" && S.selected.size === 1 && !busy()) { ev.preventDefault(); S.editing = [...S.selected][0]; return render(); }
  if (ev.altKey && (ev.code === "BracketLeft" || ev.code === "BracketRight") && S.selected.size === 1) {
    ev.preventDefault();
    return cycleWay([...S.selected][0], ev.code === "BracketLeft" ? -1 : 1);
  }
});

// ---------- buttons, code drawer, the intent preview ----------

$("pass").onclick = pass;
$("scopeview").onclick = () => { S.scope = S.scope === "task" ? "all" : "task"; S.fitted = undefined; render(); };
$("fit").onclick = fit;
$("reset").onclick = () => { S.draft = clone(S.snap.map); S.ways = {}; S.editing = null; render(); };
$("undo").onclick = () => post("/api/undo").catch((e) => showActivity(e.message, "error"));
$("code-close").onclick = () => { $("code").hidden = true; fit(); };

async function openCode(ref) {
  const r = await fetch(`/api/code?file=${encodeURIComponent(ref.file)}&line=${ref.line ?? 1}`).then((r) => r.json());
  if (r.error) return showActivity(r.error, "error");
  const opening = $("code").hidden;
  $("code").hidden = false;
  if (opening) fit();
  $("code-file").textContent = `${r.file}${ref.symbol ? ` · ${ref.symbol}` : ""}`;
  const pre = $("code-body");
  pre.innerHTML = "";
  r.lines.forEach((l, i) => {
    const s = document.createElement("span");
    s.dataset.n = r.start + i;
    s.textContent = l || " ";
    if (r.start + i === r.line) s.className = "at";
    pre.appendChild(s);
  });
}

// Hovering the edit count shows exactly what the agent will read.
const intentEl = $("intent");
$("edits").addEventListener("mouseenter", async () => {
  const r = await post("/api/intent", { draft: S.draft, focus: [...S.selected] }).catch(() => null);
  if (!r) return;
  intentEl.innerHTML = "";
  for (const line of r.intent.split("\n")) {
    const s = document.createElement("div");
    s.textContent = line || " ";
    if (/^\s+\+ /.test(line)) s.className = "add";
    else if (/^\s+- /.test(line)) s.className = "del";
    else if (/^[A-Z]/.test(line)) s.className = "h";
    intentEl.appendChild(s);
  }
  const b = $("edits").getBoundingClientRect();
  intentEl.style.top = `${b.bottom + 8}px`;
  intentEl.style.right = `${innerWidth - b.right}px`;
  intentEl.hidden = false;
});
$("edits").addEventListener("mouseleave", () => { intentEl.hidden = true; });

// The canvas moves only by its transform; never let focus scroll it.
// If focus scrolls the canvas (or the page) to show a field, turn that into a pan.
for (const el of [viewport, viewport.parentElement]) {
  el.addEventListener("scroll", () => {
    if (!el.scrollTop && !el.scrollLeft) return;
    S.view.x -= el.scrollLeft; S.view.y -= el.scrollTop;
    el.scrollTop = 0; el.scrollLeft = 0;
    applyView();
  });
}

addEventListener("resize", () => { if (S.draft) fit(); });
