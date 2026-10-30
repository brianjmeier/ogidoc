import { Editor } from "/editor.js";
import { Boxes } from "/boxes.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$("pass-kbd").textContent = isMac ? "⌘↵" : "Ctrl ↵";

let state = null;
let editTimer = null;
let workTimer = null;
let undoArmed = false;
let writing = false;
let workStart = 0;

const editor = new Editor({
  onEdit: () => {
    clearTimeout(editTimer);
    editTimer = setTimeout(sendEdit, 400);
    updatePen();
  },
  onPass: pass,
  onHint: (h) => { $("hint").textContent = h; },
});

const boxes = new Boxes({
  onEdit: (name, text) => post("/api/edit", { boxes: { [name]: text } }),
  onPass: pass,
});

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) showBanner(data.error || `Request failed (${r.status})`);
  return data;
}

function sendEdit() {
  clearTimeout(editTimer);
  editTimer = null;
  const accepted = [...editor.accepted];
  editor.accepted.clear();
  return post("/api/edit", { text: editor.text(), accepted });
}

async function pass() {
  if (!state || state.working) return;
  boxes.flush();
  clearTimeout(editTimer);
  const accepted = [...editor.accepted];
  editor.accepted.clear();
  editor.setEditable(false);
  $("pen").classList.add("passing");
  setTimeout(() => $("pen").classList.remove("passing"), 500);
  await post("/api/pass", { text: editor.text(), accepted });
}

$("pass").addEventListener("click", pass);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.target.closest("textarea")) {
    e.preventDefault();
    pass();
  }
});

$("undo").addEventListener("click", async () => {
  if (!undoArmed) {
    undoArmed = true;
    $("undo").textContent = "Undo it? Click again";
    setTimeout(() => { undoArmed = false; $("undo").textContent = "Undo agent turn"; }, 3000);
    return;
  }
  undoArmed = false;
  $("undo").textContent = "Undo agent turn";
  await post("/api/undo");
});

// ---------- state from the server ----------

const events = new EventSource("/api/events");
events.onmessage = async (e) => {
  const { state: next, animation } = JSON.parse(e.data);
  const prev = state;
  state = next;
  $("file").textContent = `${next.planPath} · ${next.agent}`;
  document.title = `${next.name} · Underpaint`;

  const anyBuilt = next.lines.some((l) => l.status === "built") || next.boxes.some((b) => b.status === "built");
  const turnChanged = !prev || prev.turn !== next.turn;
  const agentFinished = prev && prev.working && !next.working;

  if (animation) {
    const oldLines = editor.lines;
    renderChrome();
    const moves = animation.filter((o) => o.op === "move");
    boxes.set(next.boxes, { symbols: next.symbols, editable: false, animate: { delay: 250 } });
    moves.forEach((m, i) => boxes.pulse(m.to, 500 + i * 40));
    writing = true;
    updatePen();
    await editor.animate(animation, oldLines, { ...next, anyBuilt });
    writing = false;
    editor.setEditable(true);
    boxes.set(next.boxes, { symbols: next.symbols, editable: true });
    editor.ta.focus({ preventScroll: true });
  } else if (next.working) {
    editor.setEditable(false);
    boxes.set(next.boxes, { symbols: next.symbols, editable: false });
  } else {
    // During the person's turn the browser owns the text; only adopt the server's copy
    // when the turn moved (an undo) or an agent turn ended without changes (an error).
    if (!prev || turnChanged || agentFinished) editor.setState({ ...next, anyBuilt });
    else editor.anyBuilt = anyBuilt;
    editor.setEditable(true);
    boxes.set(next.boxes, { symbols: next.symbols, editable: true });
  }
  renderChrome();
};
window.addEventListener("resize", () => boxes.layout());
events.onerror = () => showBanner("Lost the connection to the Underpaint server. Is it still running?");
events.onopen = () => hideBanner();

function renderChrome() {
  updatePen();
  renderActivity();
  renderUnder();
  $("undo").hidden = !state.canUndo;
  $("pass").disabled = state.working;
  if (state.last?.error && !state.working) showBanner(`The agent's turn failed: ${state.last.error} The pen is back with you.`);
  else if (!state.working) hideBanner();
}

function updatePen() {
  if (!state) return;
  const pen = $("pen");
  const label = $("pen-label");
  clearInterval(workTimer);
  if (writing) {
    pen.className = "pen a";
    label.textContent = "agent's pen · writing";
    return;
  }
  if (state.working) {
    pen.className = "pen a";
    if (!workStart) workStart = Date.now();
    const tick = () => { label.textContent = `agent's pen · working ${Math.round((Date.now() - workStart) / 1000)}s`; };
    tick();
    workTimer = setInterval(tick, 1000);
    return;
  }
  workStart = 0;
  const open = editor.lines.filter((l) => l.kind === "question").length;
  if (state.done && !editor.lines.some((l) => l.chg && l.by === "h")) {
    pen.className = "pen done";
    label.textContent = "done · every line built";
  } else {
    pen.className = "pen h";
    label.textContent = `your pen${open ? ` · ${open} open question${open > 1 ? "s" : ""}` : ""}`;
  }
}

function renderActivity() {
  const el = $("activity");
  if (!state.working) { el.hidden = true; return; }
  const items = state.activity.length ? state.activity : ["reading the plan"];
  el.hidden = false;
  el.innerHTML = items.slice(-4).map((a, i, arr) => `<div class="${i === arr.length - 1 ? "now" : ""}">${esc(a)}</div>`).join("");
}

function renderUnder() {
  const last = state.last;
  if (!last || (!last.summary && !last.files?.length)) {
    $("under-sum").textContent = "No code yet";
    $("under-body").innerHTML = '<p class="why">Nothing has been built yet.</p>';
    return;
  }
  const files = last.files?.length ? `<ul>${last.files.map((f) => `<li><span class="op">${esc(f.op)}</span><span><span class="path">${esc(f.path)}</span> <span class="why">${esc(f.why)}</span></span></li>`).join("")}</ul>` : "";
  const steps = last.steps?.length
    ? `<div class="row">${last.steps.map((s) => `${stepTag(s.kind)}<span class="why">${esc(s.what)}</span>`).join(" ")}</div>`
    : "";
  const checks = last.checks?.length ? `<div class="row">${last.checks.map((c) => `<span class="tag ${c.ok ? "" : "bad"}">${c.ok ? "✓" : "✕"} ${esc(c.name)}</span>`).join("")}</div>` : "";
  $("under-sum").textContent = `${last.summary || ""}${last.seconds ? ` · ${last.seconds}s` : ""}`;
  $("under-body").innerHTML = steps + files + checks;
}

function stepTag(kind) {
  if (kind === "red-green") return '<span class="tag r">red</span><span class="tag">green</span>';
  if (kind === "refactor") return '<span class="tag">refactor</span>';
  if (kind === "stop") return '<span class="tag q">? stop</span>';
  if (kind === "done") return '<span class="tag">done</span>';
  return `<span class="tag">${esc(kind)}</span>`;
}

function showBanner(msg) { $("banner").textContent = msg; $("banner").hidden = false; }
function hideBanner() { $("banner").hidden = true; }
