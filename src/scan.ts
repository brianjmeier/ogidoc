// The skeleton of a codebase, read from its files without an agent: folders and files
// as boxes, imports as arrows, and each box's seam — the names the rest of the code
// imports from it. Boxes and arrows are exact; an agent only says what they mean.
//
// Pure: the caller hands in the files and the config. Nothing here reads disk. What is
// particular to one language lives in `src/languages/`; everything here is the same for all.

import type { Smell, Unread } from "./types.ts";
import { arrowKey } from "./shared/level.ts";
import { isTest, languageOf, unreadKind, type Import, type Language, type Repo, type Target } from "./languages/index.ts";
import { dirOf, normalize } from "./languages/text.ts";

export { isCode } from "./languages/index.ts";

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
  /** Lines of code under it (blank lines left out), tests left out. */
  size: number;
  files: number;
  tests: number;
  /** What a box shows of its seam, in the order it shows it (`seamOf`). */
  seam: SeamName[];
  /** How many names the whole seam has. */
  seamSize: number;
  /** How many commits in the history handed in changed something in it. */
  churn: number;
  /** How many files outside it import it, and how many files outside it it imports. */
  usedBy: number;
  uses: number;
}

interface ScanEdge {
  from: string;
  to: string;
  /** The names the importing file takes, or `*` for a whole-module import. */
  symbols: string[];
  /** Every import along it takes only types: it closes no loop that runs. */
  typeOnly?: boolean;
}

export interface Skeleton {
  title: string;
  nodes: ScanNode[];
  /** File to file (or file to an outside package). The editor lifts them to its level. */
  edges: ScanEdge[];
  /** Where the code is tangled, as far as the files and their history show it. A pair
   *  smell is between two boxes side by side, so it shows on the level that has both. */
  smells: Smell[];
  unread: Unread;
}

export const OUTSIDE = "(outside)";

const blank = (id: string, name: string, parent: string | null, kind: ScanNode["kind"]): ScanNode =>
  ({ id, name, parent, kind, size: 0, files: 0, tests: 0, seam: [], seamSize: 0, churn: 0, usedBy: 0, uses: 0 });

interface ScanOptions {
  /** The project's symlinks: path → what it points at, relative to the link. Their
   *  files are not handed in; an import through one lands on the file it points at. */
  links?: Record<string, string>;
  /** Recent commits, newest first, each as the paths it changed. */
  history?: string[][];
  /** The config files the languages read (`Language.config`): path → text. */
  config?: Record<string, string>;
  /** Paths of the other files in the checkout, to say which languages went unread. */
  others?: string[];
}

export function scan(title: string, all: SourceFile[], { links = {}, history = [], config = {}, others = [] }: ScanOptions = {}): Skeleton {
  const files = all.filter((f) => languageOf(f.path));
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
  const dirs = new Set<string>();
  for (const f of files) for (let d = dirOf(f.path); d && !dirs.has(d); d = dirOf(d)) dirs.add(d);
  const repo: Repo = { files: new Map(files.map((f) => [f.path, f.text])), dirs, config: new Map(Object.entries(config)), others: new Set(others), real };
  const resolvers = new Map<Language, (from: string, imp: Import) => Target>();
  const resolverOf = (l: Language) => resolvers.get(l) ?? resolvers.set(l, l.resolver(repo)).get(l)!;

  // ---- the tree: folders and files, a folder holding only one folder folded into it ----
  // Built from the code. Tests beside code (`src/x.test.ts`, `native/shell/tests/`) don't
  // keep `src` from folding; a top folder that holds only tests (`tests/`) is code of its own.
  const topOf = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : ""); // "" is the root
  const codeTops = new Set(files.filter((f) => !isTest(f.path)).map((f) => topOf(f.path)));
  const code = files.filter((f) => !isTest(f.path) || !codeTops.has(topOf(f.path)));
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
  // Tests beside the code draw no arrows, but what they import is not unused.
  const edges = new Map<string, ScanEdge>();
  const testedImports = new Set<string>();
  const unread: Unread = { imports: [], files: {} };
  const inTree = new Set(code.map((f) => f.path));
  for (const f of files) {
    const lang = languageOf(f.path)!;
    const resolve = resolverOf(lang);
    for (const imp of lang.imports(f.text, f.path)) {
      const hit = resolve(f.path, imp);
      if (hit === null) {
        if (inTree.has(f.path)) unread.imports.push({ from: f.path, spec: imp.spec });
        continue;
      }
      if ("asset" in hit || ("at" in hit && !boxOf.has(hit.at))) continue; // not code, a test, or a folder of tests
      const to = "at" in hit ? box(hit.at) : `${OUTSIDE}/${hit.outside}`;
      if (!inTree.has(f.path)) {
        testedImports.add(to);
        continue;
      }
      if (ancestors(f.path).includes(to)) continue; // itself, or the folder it is in
      const key = arrowKey({ from: f.path, to });
      const known = edges.get(key);
      const e = known ?? edges.set(key, { from: f.path, to, symbols: [], ...(imp.typeOnly && { typeOnly: true }) }).get(key)!;
      if (known && !imp.typeOnly) delete e.typeOnly;
      for (const s of imp.symbols) if (!e.symbols.includes(s)) e.symbols.push(s);
    }
  }
  for (const p of others) {
    const ext = unreadKind(p);
    if (ext) unread.files[ext] = (unread.files[ext] ?? 0) + 1;
  }

  // ---- boxes, with size and seam ----
  const lines = new Map(files.map((f) => [f.path, f.text.split("\n").filter((l) => l.trim()).length]));
  const nodes = new Map<string, ScanNode>();
  for (const [id, parent] of parentOf) {
    nodes.set(id, blank(id, nameOf.get(id)!, parent, inTree.has(id) ? "file" : "module"));
  }
  for (const f of code) for (const a of ancestors(f.path)) {
    nodes.get(a)!.files++;
    nodes.get(a)!.size += lines.get(f.path)!;
  }
  // A test beside the code counts for the deepest box whose folder holds it.
  for (const f of files) {
    if (inTree.has(f.path)) continue;
    let d = dirOf(f.path);
    while (d && !nodes.has(box(d))) d = dirOf(d);
    if (d) for (const a of ancestors(box(d))) nodes.get(a)!.tests++;
  }
  // A seam name is used by an importing file outside the box.
  const users = new Map<string, Map<string, Set<string>>>(); // box → "file#name" → importers
  const usedBy = new Map<string, Set<string>>(), uses = new Map<string, Set<string>>();
  const note = (m: Map<string, Set<string>>, id: string, file: string) => (m.get(id) ?? m.set(id, new Set()).get(id)!).add(file);
  for (const e of edges.values()) {
    if (e.to.startsWith(OUTSIDE)) continue;
    const inFrom = new Set(ancestors(e.from)), inTo = new Set(ancestors(e.to));
    for (const a of ancestors(e.from)) {
      if (inTo.has(a)) break;
      note(uses, a, e.to);
    }
    for (const a of ancestors(e.to)) {
      if (inFrom.has(a)) break; // from here up, the importer is inside
      note(usedBy, a, e.from);
      const m = users.get(a) ?? users.set(a, new Map()).get(a)!;
      for (const s of e.symbols) {
        const k = `${e.to}#${s}`;
        (m.get(k) ?? m.set(k, new Set()).get(k)!).add(e.from);
      }
    }
  }
  for (const [id, who] of usedBy) nodes.get(id)!.usedBy = who.size;
  for (const [id, what] of uses) nodes.get(id)!.uses = what.size;
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

  const imported = new Set([...[...edges.values()].map((e) => e.to), ...testedImports]);
  const smells = smellsOf({ code, nodes, edges: [...edges.values()], history, ancestors, imported: (p) => imported.has(p) || imported.has(box(dirOf(p))) });
  return { title, nodes: [...nodes.values()], edges: [...edges.values()], smells, unread };
}

// A commit that touches more files than this is a sweep (a rename, a format), not a sign
// that the files belong together.
const SWEEP = 30;
// A file this many lines of code long is hard to hold in one's head, whatever it does.
const LARGE = 800;

function smellsOf({ code, nodes, edges, history, ancestors, imported }: {
  code: SourceFile[];
  nodes: Map<string, ScanNode>;
  edges: ScanEdge[];
  history: string[][];
  ancestors: (id: string) => string[];
  /** Whether anything (a test included) imports the file or the folder it is in. */
  imported: (path: string) => boolean;
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

  // imports between boxes side by side; a loop only counts imports that run
  const imports = new Set<string>();
  const uses = new Map<string, Set<string>>();
  const runs = new Map<string, Set<string>>();
  const along = new Map<string, ScanEdge[]>(); // "a|b" between boxes → the file imports that make it
  const link = (m: Map<string, Set<string>>, a: string, b: string) => (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
  for (const e of edges) {
    if (!nodes.has(e.to) || nodes.get(e.to)!.kind === "external") continue;
    const p = sideBySide(e.from, e.to);
    if (!p) continue;
    imports.add(pair(...p));
    link(uses, ...p);
    if (e.typeOnly) continue;
    link(runs, ...p);
    const k = `${p[0]}|${p[1]}`;
    (along.get(k) ?? along.set(k, []).get(k)!).push(e);
  }
  const volatile = new Map<string, string[]>();
  for (const [a, bs] of uses) {
    const from = nodes.get(a)!;
    for (const b of bs) {
      const to = nodes.get(b)!;
      // Only code others rely on: a box nothing imports may lean on anything.
      if (from.seamSize > 0 && to.churn >= 5 && to.churn >= 2 * from.churn) (volatile.get(b) ?? volatile.set(b, []).get(b)!).push(a);
    }
  }
  for (const [b, importers] of volatile) smells.push({ kind: "volatile import", b, importers: importers.sort(), count: nodes.get(b)!.churn });
  for (const ids of cyclesOf(runs)) {
    const closing = closingOf(ids, runs).flatMap(([a, b]) => along.get(`${a}|${b}`)!.map(({ from, to }) => ({ from, to })));
    smells.push({ kind: "cycle", ids, closing });
  }
  for (const [p, count] of together) {
    const [a, b] = p.split("|");
    const least = Math.min(nodes.get(a)!.churn, nodes.get(b)!.churn);
    if (count >= 3 && count >= least / 2 && !imports.has(p)) smells.push({ kind: "change together", a, b, count });
  }

  // files: too big, re-exports only, or exports nobody takes
  for (const f of code) {
    const size = nodes.get(f.path)!.size;
    if (size >= LARGE) smells.push({ kind: "large", a: f.path, size });
    if (isTest(f.path)) continue;
    const lang = languageOf(f.path)!;
    if (lang.reexportsOnly?.(f.text)) smells.push({ kind: "pass-through", a: f.path });
    else if (!imported(f.path) && lang.offersNames?.(f.text, f.path)) smells.push({ kind: "unused", a: f.path });
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

/** The imports between boxes that close a loop. The loop's boxes are put in order, the
 *  ones that mostly import first and the ones the others mostly import (shared code) last;
 *  an import pointing back up that order closes it. Shared code that imports upward (a
 *  `kit` importing a page) is what this finds. */
function closingOf(ids: string[], uses: Map<string, Set<string>>): [string, string][] {
  const group = new Set(ids);
  const within = (v: string) => [...(uses.get(v) ?? [])].filter((w) => group.has(w));
  const usedBy = (id: string) => ids.filter((x) => within(x).includes(id)).length;
  const score = new Map(ids.map((id) => [id, within(id).length - usedBy(id)]));
  const order = [...ids].sort((a, b) => score.get(b)! - score.get(a)! || a.localeCompare(b));
  const rank = new Map(order.map((id, i) => [id, i]));
  return ids.flatMap((a) => within(a).filter((b) => rank.get(b)! < rank.get(a)!).map((b): [string, string] => [a, b]));
}

/** The order a box lists its seam in, which is also what a box shows first when its seam
 *  is too long to show whole. */
function seamOf(names: SeamName[]): SeamName[] {
  // TODO(Brian): rank and cut the seam — see the note in the conversation.
  return [...names].sort((a, b) => b.users - a.users || a.name.localeCompare(b.name)).slice(0, 24);
}
