import type { Import, Language, Repo, Target } from "./index.ts";
import { baseOf, dirOf, normalize, withoutComments } from "./text.ts";

// Python: `import a.b`, `from a.b import c`, relative `from ..x import y`. Dotted names land
// on `a/b.py` or `a/b/__init__.py` under a root (the repo root, any `src/`, any folder with
// a pyproject.toml, setup.py or setup.cfg, and its `src/`); a name no root has is outside.

const CONFIG = ["pyproject.toml", "setup.py", "setup.cfg"];
// Triple quotes come first so they win over the single ones; code inside a string is text.
const strip = (text: string) =>
  withoutComments(text, { line: "#", quotes: ['"', "'"], template: ['"""', "'''"], strings: "blank" });

const IMPORT = /^[ \t]*import[ \t]+([^\n;]+)/gm;
const FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]*(\([^)]*\)|[^\n;]+)/gm;
const TYPE_CHECKING = /^[ \t]*if[ \t]+(?:typing\.)?TYPE_CHECKING[ \t]*:[ \t]*$/;

const names = (list: string) =>
  list.replace(/[()\\]/g, " ").split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);

/** The lines inside an `if TYPE_CHECKING:` block, by indentation. */
function typeLines(src: string): Set<number> {
  const out = new Set<number>();
  let block = -1; // the `if` line's indent while inside one
  src.split("\n").forEach((line, n) => {
    if (!line.trim()) return;
    const indent = line.length - line.trimStart().length;
    if (block >= 0 && indent <= block) block = -1;
    if (block >= 0) out.add(n);
    else if (TYPE_CHECKING.test(line)) block = indent;
  });
  return out;
}

/** The imports of one file: one per module for `import`, one per name for `from … import`. */
export function importsOf(text: string): Import[] {
  const src = strip(text);
  const types = typeLines(src);
  const found: [number, Import][] = [];
  const add = (index: number, imp: Import) => {
    const line = src.slice(0, index).split("\n").length - 1;
    found.push([index, types.has(line) ? { ...imp, typeOnly: true } : imp]);
  };
  for (const m of src.matchAll(IMPORT)) for (const spec of names(m[1])) add(m.index, { spec, symbols: ["*"] });
  for (const m of src.matchAll(FROM)) for (const name of names(m[2])) add(m.index, { spec: m[1], symbols: [name] });
  return found.sort((a, b) => a[0] - b[0]).map(([, imp]) => imp);
}

function resolver(repo: Repo) {
  const py = [...repo.files.keys()].filter((p) => p.endsWith(".py"));
  const pyDirs = new Set(py.flatMap((p) => {
    const out: string[] = [];
    for (let d = dirOf(p); d; d = dirOf(d)) out.push(d);
    return out;
  }));
  const join = (...parts: string[]) => parts.filter(Boolean).join("/");
  // A package before a module before a namespace folder, as Python looks.
  const module = (base: string): string | undefined => {
    if (!base) return undefined;
    for (const p of [`${base}/__init__.py`, `${base}.py`]) if (repo.files.has(repo.real(p))) return repo.real(p);
    return pyDirs.has(repo.real(base)) ? repo.real(base) : undefined;
  };
  const projects = [...repo.config.keys()].filter((k) => CONFIG.includes(baseOf(k))).map(dirOf);
  const roots = [...new Set(["", ...[...repo.dirs].filter((d) => baseOf(d) === "src"), ...projects, ...projects.map((d) => join(d, "src"))])];
  const anyRoot = (segs: string[]) => roots.map((r) => module(join(r, ...segs))).find(Boolean);
  const at = (p: string | undefined): Target => (p ? { at: p } : null);

  return (from: string, { spec, symbols }: Import): Target => {
    const name = symbols[0] === "*" ? undefined : symbols[0];
    if (spec.startsWith(".")) {
      const dots = spec.match(/^\.+/)![0].length;
      const base = normalize(join(dirOf(from), ..."../".repeat(dots - 1).split("/"), ...spec.slice(dots).split(".")));
      return at((name && module(join(base, name))) || module(base));
    }
    const segs = spec.split(".");
    if (name) {
      const sub = anyRoot([...segs, name]);
      if (sub) return { at: sub };
    }
    // The longest match, so `a.b.c` naming something inside `a/b.py` still lands there;
    // the first segment alone only when it is the whole name.
    for (let n = segs.length; n >= Math.min(2, segs.length); n--) {
      const hit = anyRoot(segs.slice(0, n));
      if (hit) return { at: hit };
    }
    return anyRoot(segs.slice(0, 1)) ? null : { outside: segs[0] };
  };
}

const ALL = /^__all__[ \t]*(?:\+?=|:[^=\n]*=)[ \t]*[[(][^\])]*[\])]/gm;
const STRING_ONLY = /^[ \t]*("""|'''|"|')\s*\1[ \t]*$/gm;

export const python: Language = {
  name: "Python",
  extensions: [".py"],
  isTest: (path) => /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/.test(path),
  config: CONFIG,
  imports: importsOf,
  resolver,
  offersNames: (text) => /^(?:(?:async[ \t]+)?def|class)[ \t]+[A-Za-z]|^[A-Z][A-Z0-9_]*[ \t]*(?::[^=\n]*)?=(?!=)/m.test(strip(text)),
  reexportsOnly(text) {
    const body = strip(text);
    const rest = body.replace(FROM, "").replace(IMPORT, "").replace(ALL, "").replace(STRING_ONLY, "");
    return (new RegExp(FROM.source, "m").test(body) || new RegExp(IMPORT.source, "m").test(body)) && !rest.trim();
  },
};
