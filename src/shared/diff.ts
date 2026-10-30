// Line diff and the plan-line rules shared by the server and the browser.
// Plans are small, so a plain LCS table is fast enough and easy to trust.

import type { Box, Line } from "../types.ts";

// An empty file is a plan with no lines, not one blank line.
export const splitLines = (text: string): string[] => (text === "" ? [] : text.split("\n"));
export const joinLines = (lines: Line[]): string => lines.map((l) => l.text).join("\n");

// Once anything is built, a line the person writes or changes needs a build.
export const anyBuilt = (lines: Line[], boxes: Box[]): boolean =>
  lines.some((l) => l.status === "built") || boxes.some((b) => b.status === "built");

// An accepted proposal stays as the person's own plain line.
export const acceptProposal = (l: Line, built: boolean): Line => ({ ...l, kind: null, by: "h", chg: true, status: built ? "stale" : null });

export type DiffOp = { op: "eq" | "mod"; a: number; b: number } | { op: "del"; a: number } | { op: "ins"; b: number };

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
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
function pairEdits(ops: DiffOp[], a: string[], b: string[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (let k = 0; k < ops.length; k++) {
    const dels: { op: "del"; a: number }[] = [];
    while (k < ops.length && ops[k].op === "del") dels.push(ops[k++] as { op: "del"; a: number });
    const ins: { op: "ins"; b: number }[] = [];
    while (k < ops.length && ops[k].op === "ins") ins.push(ops[k++] as { op: "ins"; b: number });
    const pairs = Math.min(dels.length, ins.length);
    let p = 0;
    for (; p < pairs && similar(a[dels[p].a], b[ins[p].b]); p++) out.push({ op: "mod", a: dels[p].a, b: ins[p].b });
    for (let q = p; q < dels.length; q++) out.push(dels[q]);
    for (let q = p; q < ins.length; q++) out.push(ins[q]);
    if (k < ops.length) out.push(ops[k]);
  }
  return out;
}

function similar(x: string, y: string): boolean {
  const s = x.trim();
  const t = y.trim();
  if (!s || !t) return false;
  return dice(s, t) >= 0.5;
}

function dice(s: string, t: string): number {
  if (s === t) return 1;
  if (s.length < 2 || t.length < 2) return 0;
  const grams = new Map<string, number>();
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

// Where each old line ended up after an edit. A deleted line maps to the nearest
// surviving line above it, so whatever was pinned to it stays close by.
export function mapIndices(ops: DiffOp[], oldLen: number): number[] {
  const map: number[] = new Array(oldLen).fill(-1);
  for (const o of ops) if (o.op === "eq" || o.op === "mod") map[o.a] = o.b;
  let last = 0;
  for (let i = 0; i < oldLen; i++) {
    if (map[i] >= 0) last = map[i];
    else map[i] = last;
  }
  return map;
}

// Carry line metadata (who wrote it, what kind of line it is, whether it is built)
// across a human edit. Unchanged lines keep everything; new or edited lines become
// the human's, and need a build once anything has been built.
// Pass `ops` when the caller already diffed the same texts.
export function carryMeta(oldLines: Line[], newTexts: string[], { anyBuilt, ops = diffLines(oldLines.map((l) => l.text), newTexts) }: { anyBuilt: boolean; ops?: DiffOp[] }): Line[] {
  const out: Line[] = new Array(newTexts.length);
  // The agent's marks last until the person starts changing things, so their own
  // edits, even on top of the agent's, are the only ones marked.
  const touched = ops.some((o) => o.op !== "eq");
  for (const o of ops) {
    // The same object, so the browser can tell nothing about the line changed.
    if (o.op === "eq") out[o.b] = touched && oldLines[o.a].chg && oldLines[o.a].by === "a" ? { ...oldLines[o.a], chg: false } : oldLines[o.a];
    else if (o.op === "mod" || o.op === "ins") {
      const text = newTexts[o.b];
      const prev = o.op === "mod" ? oldLines[o.a] : null;
      out[o.b] = {
        text,
        by: "h" as const,
        kind: prev?.kind ?? null,
        status: text.trim() && anyBuilt ? "stale" : null,
        chg: true,
      };
    }
  }
  return out;
}
