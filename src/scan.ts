// The skeleton of a codebase, read from its files without an agent: folders and files
// as boxes, imports as arrows, and each box's seam — the names the rest of the code
// imports from it. Boxes and arrows are exact; an agent only says what they mean.
//
// Pure: the caller hands in the files and the import aliases. Nothing here reads disk.

import type { Smell } from "./types.ts";

interface SourceFile {
  path: string;
  text: string;
}

/** One name a box offers the rest of the code, and how many files outside it use it. */
export interface SeamName {
  name: string;
  /** The file in the box that offers it. */
  file: string;
  users: number;
}

interface ScanNode {
  id: string;
  name: string;
  parent: string | null;
  kind: "module" | "file" | "external";
  /** Lines of code under it, tests left out. */
  size: number;
  files: number;
  tests: number;
  /** What a box shows of its seam, in the order it shows it (`seamOf`). */
  seam: SeamName[];
  /** How many names the whole seam has. */
  seamSize: number;
  /** How many commits in the history handed in changed something in it. */
  churn: number;
  /** How many boxes beside it import it, and how many it imports. */
  usedBy: number;
  uses: number;
}

interface ScanEdge {
  from: string;
  to: string;
  /** The names the importing file takes, or `*` for a whole-module import. */
  symbols: string[];
}

export interface Skeleton {
  title: string;
  nodes: ScanNode[];
  /** File to file (or file to an outside package). The editor lifts them to its level. */
  edges: ScanEdge[];
  /** Where the code is tangled, as far as the files and their history show it. A pair
   *  smell is between two boxes side by side, so it shows on the level that has both. */
  smells: Smell[];
}


const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// Files come from `git ls-files`, so .gitignore already leaves most build output out; this
// catches build output a repository committed anyway. It is not a second ignore list.
const SKIP = /(^|\/)(node_modules|dist|coverage|\.git)\//;
const TEST = /(\.(test|spec)\.[a-z]+$)|(^|\/)(tests?|test-support|__tests__)\//;
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
export const OUTSIDE = "(outside)";

export const isCode = (path: string) => CODE.test(path) && !path.endsWith(".d.ts") && !SKIP.test(path);
const isTest = (path: string) => TEST.test(path);

/** Source without its comments, so a commented-out line doesn't count; strings are left
 *  alone, and so is `//` inside a URL. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const blank = (id: string, name: string, parent: string | null, kind: ScanNode["kind"]): ScanNode =>
  ({ id, name, parent, kind, size: 0, files: 0, tests: 0, seam: [], seamSize: 0, churn: 0, usedBy: 0, uses: 0 });

/** The imports of one file: where from, and which names. Comments are dropped first so a
 *  commented-out import doesn't count; string contents are left alone. */
export function importsOf(text: string): { spec: string; symbols: string[] }[] {
  const src = stripComments(text);
  const out: { spec: string; symbols: string[] }[] = [];
  const named = (list: string) =>
    list.split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim()).filter(Boolean);
  // An import clause is one of: `{ … }`, `* as x`, `x`, or `x, { … }` / `x, * as y`.
  const clause = String.raw`(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)`;
  const re = new RegExp(String.raw`\b(?:import|export)\s+(?:type\s+)?${clause}\s*from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)`, "g");
  for (const m of src.matchAll(re)) {
    if (m[3] || m[4]) {
      out.push({ spec: (m[3] ?? m[4])!, symbols: ["*"] });
      continue;
    }
    const clause = m[1];
    const symbols: string[] = [];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) symbols.push(...named(braces[1]));
    const rest = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
    if (/\*/.test(rest)) symbols.push("*");
    else if (rest && rest !== "type") symbols.push("default");
    if (!braces && /^\*/.test(clause)) symbols.splice(0, symbols.length, "*");
    out.push({ spec: m[2], symbols: symbols.length ? symbols : ["*"] });
  }
  return out;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** The package a bare import names: `react`, `@base-ui/react`, and every `node:` / `bun:` as one. */
const packageOf = (spec: string) =>
  /^(node|bun):/.test(spec) ? spec.split(":")[0] + ":*" : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

interface ScanOptions {
  /** The project's import aliases, as tsconfig's `paths`, relative to the root. */
  aliases?: Record<string, string[]>;
  /** The project's symlinks: path → what it points at, relative to the link. Their
   *  files are not handed in; an import through one lands on the file it points at. */
  links?: Record<string, string>;
  /** Recent commits, newest first, each as the paths it changed. */
  history?: string[][];
}

export function scan(title: string, all: SourceFile[], { aliases = {}, links = {}, history = [] }: ScanOptions = {}): Skeleton {
  const files = all.filter((f) => isCode(f.path));
  const known = new Set(files.map((f) => f.path));
  // A path with a symlink anywhere along it, as the path it really is.
  const real = (path: string) => {
    for (let hops = 0; hops < 8; hops++) {
      const parts = path.split("/");
      const at = parts.findIndex((_, i) => parts.slice(0, i + 1).join("/") in links);
      if (at < 0) return path;
      const link = parts.slice(0, at + 1).join("/");
      path = normalize([dirOf(link), links[link], ...parts.slice(at + 1)].filter(Boolean).join("/"));
    }
    return path;
  };
  const find = (raw: string) => {
    const base = real(raw);
    return EXTS.map((e) => base + e).find((p) => known.has(p)) ?? (EXTS.map((e) => real(raw + e)).find((p) => known.has(p))) ??
    // `./x.js` written in a TS project names `./x.ts`
    (/\.(js|jsx|mjs)$/.test(base) ? [".ts", ".tsx"].map((e) => base.replace(/\.(js|jsx|mjs)$/, e)).find((p) => known.has(p)) : undefined);
  };
  const resolveSpec = (from: string, spec: string): string | null | undefined => {
    if (spec.startsWith(".")) return find(normalize(`${dirOf(from)}/${spec}`)) ?? null;
    for (const [key, targets] of Object.entries(aliases)) {
      const star = key.endsWith("/*");
      const head = star ? key.slice(0, -1) : key;
      if (star ? spec.startsWith(head) : spec === key) {
        for (const t of targets) {
          const hit = find(normalize(star ? t.replace(/\*$/, spec.slice(head.length)) : t));
          if (hit) return hit;
        }
        return null;
      }
    }
    return undefined; // a package from outside
  };

  // ---- the tree: folders and files, a folder holding only one folder folded into it ----
  // Built from the code alone: a tests folder beside `src` doesn't keep `src` from folding.
  const code = files.filter((f) => !isTest(f.path));
  const children = new Map<string, Set<string>>();
  const add = (parent: string, child: string) => (children.get(parent) ?? children.set(parent, new Set()).get(parent)!).add(child);
  for (const f of code) {
    let p = f.path;
    while (p) {
      add(dirOf(p), p);
      p = dirOf(p);
    }
  }
  // Each path's box: itself, or the folder it was folded into.
  const boxOf = new Map<string, string>();
  const parentOf = new Map<string, string | null>();
  const nameOf = new Map<string, string>();
  const walk = (path: string, parent: string | null, name: string) => {
    let id = path;
    let label = name;
    // fold `a/b` into `a` while `a` holds nothing but `b`
    for (let kids = children.get(id); kids?.size === 1 && children.has([...kids][0]); kids = children.get(id)) {
      const only = [...kids][0];
      boxOf.set(id, only);
      label = label ? `${label}/${only.slice(id.length + 1)}` : only;
      id = only;
    }
    if (path) {
      boxOf.set(id, id);
      parentOf.set(id, parent);
      nameOf.set(id, label);
    }
    for (const k of [...(children.get(id) ?? [])].sort()) walk(k, path ? id : null, k.slice(k.lastIndexOf("/") + 1));
  };
  walk("", null, "");
  const box = (path: string) => boxOf.get(path) ?? path;
  const ancestors = (id: string) => {
    const out: string[] = [];
    for (let p: string | null = id; p; p = parentOf.get(p) ?? null) out.push(p);
    return out;
  };

  // ---- arrows ----
  const edges = new Map<string, ScanEdge>();
  for (const f of code) {
    for (const { spec, symbols } of importsOf(f.text)) {
      const hit = resolveSpec(f.path, spec);
      if (hit === null) continue;
      if (hit && isTest(hit)) continue;
      const to = hit ? box(hit) : `${OUTSIDE}/${packageOf(spec)}`;
      if (to === f.path) continue;
      const key = `${f.path}→${to}`;
      const e = edges.get(key) ?? edges.set(key, { from: f.path, to, symbols: [] }).get(key)!;
      for (const s of symbols) if (!e.symbols.includes(s)) e.symbols.push(s);
    }
  }

  // ---- boxes, with size and seam ----
  const lines = new Map(files.map((f) => [f.path, f.text.split("\n").filter((l) => l.trim()).length]));
  const nodes = new Map<string, ScanNode>();
  for (const [id, parent] of parentOf) {
    nodes.set(id, blank(id, nameOf.get(id)!, parent, known.has(id) ? "file" : "module"));
  }
  for (const f of code) for (const a of ancestors(f.path)) {
    nodes.get(a)!.files++;
    nodes.get(a)!.size += lines.get(f.path)!;
  }
  // A test counts for the deepest box whose folder holds it.
  for (const f of files) {
    if (!isTest(f.path)) continue;
    let d = dirOf(f.path);
    while (d && !nodes.has(box(d))) d = dirOf(d);
    if (d) for (const a of ancestors(box(d))) nodes.get(a)!.tests++;
  }
  // A seam name is used by an importing file outside the box.
  const users = new Map<string, Map<string, Set<string>>>(); // box → "file#name" → importers
  for (const e of edges.values()) {
    if (e.to.startsWith(OUTSIDE)) continue;
    const inFrom = new Set(ancestors(e.from));
    for (const a of ancestors(e.to)) {
      if (inFrom.has(a)) break; // from here up, the importer is inside
      const m = users.get(a) ?? users.set(a, new Map()).get(a)!;
      for (const s of e.symbols) {
        const k = `${e.to}#${s}`;
        (m.get(k) ?? m.set(k, new Set()).get(k)!).add(e.from);
      }
    }
  }
  for (const [id, m] of users) {
    const all = [...m].map(([k, who]) => ({ file: k.slice(0, k.lastIndexOf("#")), name: k.slice(k.lastIndexOf("#") + 1), users: who.size }));
    nodes.get(id)!.seam = seamOf(all);
    nodes.get(id)!.seamSize = all.length;
  }

  // ---- the outside world: one box per package ----
  const outside = [...new Set([...edges.values()].map((e) => e.to).filter((t) => t.startsWith(OUTSIDE)))].sort();
  if (outside.length) {
    nodes.set(OUTSIDE, blank(OUTSIDE, "outside", null, "external"));
    for (const id of outside) nodes.set(id, blank(id, id.slice(OUTSIDE.length + 1), OUTSIDE, "external"));
  }

  const smells = smellsOf({ code, nodes, edges: [...edges.values()], history, ancestors });
  return { title, nodes: [...nodes.values()], edges: [...edges.values()], smells };
}

// A commit that touches more files than this is a sweep (a rename, a format), not a sign
// that the files belong together.
const SWEEP = 30;

function smellsOf({ code, nodes, edges, history, ancestors }: {
  code: SourceFile[];
  nodes: Map<string, ScanNode>;
  edges: ScanEdge[];
  history: string[][];
  ancestors: (id: string) => string[];
}): Smell[] {
  const smells: Smell[] = [];
  // The two boxes side by side that hold x and y: the children of their nearest common box.
  const sideBySide = (x: string, y: string): [string, string] | null => {
    const cx = ancestors(x), cy = ancestors(y);
    const iny = new Set(cy);
    const at = cx.findIndex((p) => iny.has(p));
    if (at === 0) return null; // x is inside y, or is y
    const a = at < 0 ? cx[cx.length - 1] : cx[at - 1];
    const b = at < 0 ? cy[cy.length - 1] : cy[cy.indexOf(cx[at]) - 1];
    return b && a !== b ? [a, b] : null;
  };
  const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  // how often each box changed, and which pairs changed in the same commits
  const together = new Map<string, number>();
  for (const commit of history) {
    const touched = [...new Set(commit)].filter((f) => nodes.has(f));
    if (!touched.length || touched.length > SWEEP) continue;
    for (const id of new Set(touched.flatMap(ancestors))) nodes.get(id)!.churn++;
    const pairs = new Set<string>();
    for (let i = 0; i < touched.length; i++) for (let j = i + 1; j < touched.length; j++) {
      const p = sideBySide(touched[i], touched[j]);
      if (p) pairs.add(pair(...p));
    }
    for (const p of pairs) together.set(p, (together.get(p) ?? 0) + 1);
  }

  // imports between boxes side by side
  const imports = new Set<string>();
  const uses = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!nodes.has(e.to) || nodes.get(e.to)!.kind === "external") continue;
    const p = sideBySide(e.from, e.to);
    if (!p) continue;
    imports.add(pair(...p));
    (uses.get(p[0]) ?? uses.set(p[0], new Set()).get(p[0])!).add(p[1]);
  }
  for (const [a, bs] of uses) {
    const from = nodes.get(a)!;
    from.uses = bs.size;
    for (const b of bs) {
      const to = nodes.get(b)!;
      to.usedBy++;
      // Only code others rely on: a box nothing imports may lean on anything.
      if (from.seamSize > 0 && to.churn >= 5 && to.churn >= 2 * from.churn) smells.push({ kind: "volatile import", a, b, count: to.churn });
    }
  }
  smells.push(...cyclesOf(uses).map((ids): Smell => ({ kind: "cycle", ids })));
  for (const [p, count] of together) {
    const [a, b] = p.split("|");
    const least = Math.min(nodes.get(a)!.churn, nodes.get(b)!.churn);
    if (count >= 3 && count >= least / 2 && !imports.has(p)) smells.push({ kind: "change together", a, b, count });
  }

  // files: re-exports only, or exports nobody takes
  const imported = new Set(edges.map((e) => e.to));
  for (const f of code) {
    const body = stripComments(f.text);
    const reexport = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"']+["'];?/g;
    const rest = body.replace(reexport, "").replace(/\bimport\s[^;]*?from\s*["'][^"']+["'];?/g, "");
    if (reexport.test(body) && !rest.trim()) smells.push({ kind: "pass-through", a: f.path });
    else if (!imported.has(f.path) && /^export\s+(const|function|class|interface|type|enum|async)/m.test(f.text)) smells.push({ kind: "unused", a: f.path });
  }
  return smells;
}

/** Groups of two or more boxes that import each other round in a loop (Tarjan). */
function cyclesOf(uses: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], on = new Set<string>(), out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    on.add(v);
    for (const w of uses.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    for (let w = ""; w !== v; ) { w = stack.pop()!; on.delete(w); group.push(w); }
    if (group.length > 1) out.push(group.sort());
  };
  for (const v of uses.keys()) if (!index.has(v)) visit(v);
  return out;
}

/** The order a box lists its seam in, which is also what a box shows first when its seam
 *  is too long to show whole. */
function seamOf(names: SeamName[]): SeamName[] {
  // TODO(Brian): rank and cut the seam — see the note in the conversation.
  return [...names].sort((a, b) => b.users - a.users || a.name.localeCompare(b.name)).slice(0, 24);
}
