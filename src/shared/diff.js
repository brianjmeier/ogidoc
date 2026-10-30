// Line diff shared by the server and the browser.
// Plans are small, so a plain LCS table is fast enough and easy to trust.

export function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ op: "eq", a: i++, b: j++ });
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: "del", a: i++ });
    else ops.push({ op: "ins", b: j++ });
  }
  while (i < n) ops.push({ op: "del", a: i++ });
  while (j < m) ops.push({ op: "ins", b: j++ });
  return pairEdits(ops, a, b);
}

// A deletion followed by an insertion of a similar line reads better as one edit.
function pairEdits(ops, a, b) {
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const dels = [];
    while (k < ops.length && ops[k].op === "del") dels.push(ops[k++]);
    const ins = [];
    while (k < ops.length && ops[k].op === "ins") ins.push(ops[k++]);
    const pairs = Math.min(dels.length, ins.length);
    let p = 0;
    for (; p < pairs && similar(a[dels[p].a], b[ins[p].b]); p++) out.push({ op: "mod", a: dels[p].a, b: ins[p].b });
    for (let q = p; q < dels.length; q++) out.push(dels[q]);
    for (let q = p; q < ins.length; q++) out.push(ins[q]);
    if (k < ops.length) out.push(ops[k]);
  }
  return out;
}

export function similar(x, y) {
  const s = x.trim();
  const t = y.trim();
  if (!s || !t) return false;
  return dice(s, t) >= 0.5;
}

function dice(s, t) {
  if (s === t) return 1;
  if (s.length < 2 || t.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    const c = grams.get(g);
    if (c) { hits++; grams.set(g, c - 1); }
  }
  return (2 * hits) / (s.length + t.length - 2);
}

// Carry line metadata (who wrote it, what kind of line it is, whether it is built)
// across a human edit. Unchanged lines keep everything; new or edited lines become
// the human's, and need a build once anything has been built.
export function carryMeta(oldLines, newTexts, { anyBuilt }) {
  const ops = diffLines(oldLines.map((l) => l.text), newTexts);
  const out = new Array(newTexts.length);
  for (const o of ops) {
    if (o.op === "eq") out[o.b] = { ...oldLines[o.a], text: newTexts[o.b] };
    else if (o.op === "mod" || o.op === "ins") {
      const text = newTexts[o.b];
      const prev = o.op === "mod" ? oldLines[o.a] : null;
      out[o.b] = {
        text,
        by: "h",
        kind: guessKind(text, prev),
        status: text.trim() && anyBuilt && !isQuestion(text) ? "stale" : null,
        chg: true,
      };
    }
  }
  return out;
}

// Until the agent classifies a line, the only thing worth guessing is a question.
function guessKind(text, prev) {
  if (isQuestion(text)) return "question";
  if (prev && prev.kind && prev.kind !== "question") return prev.kind;
  return null;
}

export function isQuestion(text) {
  return /\?\s*$/.test(text.trim());
}
