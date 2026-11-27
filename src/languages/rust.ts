import type { Import, Language, Repo, Target } from "./index.ts";
import { baseOf, dirOf, normalize } from "./text.ts";

// Rust: `use a::b::{C, d::E}` and `extern crate x`. Crates come from each Cargo.toml's
// `[package]` name. `crate::`, `self::` and `super::` paths are worked out against the
// file's module path, then land on the longest prefix that is a module file; a workspace
// crate's name lands in that crate the same way; anything else is a crate from outside.

const STD = new Set(["std", "core", "alloc", "proc_macro"]);
const RAW = /b?r(#*)"/y;
// A char literal; a lone `'` (a lifetime, a label) is left as code.
const CHAR = /'(?:\\(?:u\{[0-9a-fA-F]*\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/uy;

/** Source with comments, strings, raw strings and char literals blanked, places kept.
 *  Rust strings may span lines and block comments nest, so this is its own small scanner. */
export function strip(text: string): string {
  let out = "";
  let i = 0;
  const take = (end: number) => {
    out += text.slice(i, end).replace(/[^\n]/g, " ");
    i = end;
  };
  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      take(end < 0 ? text.length : end);
      continue;
    }
    if (text.startsWith("/*", i)) {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text.startsWith("/*", j)) (depth++, (j += 2));
        else if (text.startsWith("*/", j)) {
          j += 2;
          if (!--depth) break;
        } else j++;
      }
      take(Math.min(j, text.length));
      continue;
    }
    RAW.lastIndex = i;
    const raw = !/\w/.test(text[i - 1] ?? "") && RAW.exec(text);
    if (raw) {
      const close = `"${raw[1]}`;
      const end = text.indexOf(close, i + raw[0].length);
      take(end < 0 ? text.length : end + close.length);
      continue;
    }
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      take(Math.min(text.length, j + 1));
      continue;
    }
    if (text[i] === "'") {
      CHAR.lastIndex = i;
      const ch = CHAR.exec(text);
      if (ch) {
        take(i + ch[0].length);
        continue;
      }
    }
    out += text[i++];
  }
  return out;
}

/** Commas at the top level of a use tree, not inside its braces. */
function splitTop(tree: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tree.length; i++) {
    if (tree[i] === "{") depth++;
    else if (tree[i] === "}") depth--;
    else if (tree[i] === "," && !depth) (parts.push(tree.slice(start, i)), (start = i + 1));
  }
  return [...parts, tree.slice(start)];
}

/** Every path a use tree names: `a::{b, c::{d as e}}` is `a::b` and `a::c::d`. */
function leaves(tree: string, prefix = ""): string[] {
  const join = (head: string) => [prefix, head].filter(Boolean).join("::");
  return splitTop(tree).flatMap((part) => {
    const p = part.trim();
    if (!p) return [];
    const brace = p.indexOf("{");
    if (brace < 0) return [join(p.split(/\s+as\s+/)[0].trim())];
    return leaves(p.slice(brace + 1, p.lastIndexOf("}")), join(p.slice(0, brace).replace(/::$/, "")));
  });
}

// The name a path takes: the type it names (`Shape` in `shapes::Shape::Circle`), or its last part.
const symbolOf = (path: string) => {
  const segs = path.split("::");
  if (/^(self|\*)$/.test(segs.at(-1)!)) return "*";
  return segs.slice(1).find((s) => /^[A-Z]/.test(s)) ?? segs.at(-1)!;
};

/** Inside inline `mod a { mod b { … } }`, a `self::`/`super::` path is rewritten to start
 *  from the file's own module, so the resolver only needs the file. */
function fromFile(path: string, inline: string[]): string {
  const segs = path.split("::");
  if (!inline.length || !/^(self|super)$/.test(segs[0])) return path;
  const m = [...inline];
  let i = segs[0] === "self" ? 1 : 0;
  while (segs[i] === "super" && m.length) (m.pop(), i++);
  return segs[i] === "super" ? segs.slice(i).join("::") : ["self", ...m, ...segs.slice(i)].join("::");
}

/** The imports of one file: every leaf of every `use`, and each `extern crate`. */
export function importsOf(text: string): Import[] {
  const src = strip(text);
  const blocks: { start: number; end: number; name: string }[] = [];
  for (const m of src.matchAll(/\bmod\s+(\w+)\s*\{/g)) {
    let depth = 0;
    let j = m.index + m[0].length - 1;
    for (; j < src.length; j++) if (src[j] === "{") depth++;
    else if (src[j] === "}" && !--depth) break;
    blocks.push({ start: m.index, end: j, name: m[1] });
  }
  const out: Import[] = [];
  for (const m of src.matchAll(/\buse\s+([^;]*);|\bextern\s+crate\s+(\w+)/g)) {
    if (m[2] !== undefined) {
      if (m[2] !== "self") out.push({ spec: m[2], symbols: ["*"] });
      continue;
    }
    const tree = m[1].replace(/\s*::\s*/g, "::");
    if (!/^[\w\s:{},*]+$/.test(tree)) continue; // `$crate` in a macro, or not a use at all
    const inline = blocks.filter((b) => b.start < m.index && m.index < b.end).map((b) => b.name);
    for (const leaf of leaves(tree)) {
      const spec = fromFile(leaf, inline);
      out.push({ spec, symbols: [symbolOf(spec)] });
    }
  }
  return out;
}

/** `[package] name = "x-y"` as Rust names the crate (`x_y`), and the root files the
 *  Cargo.toml names itself: `[lib] path = …`, else the first `[[bin]] path = …`. */
function crateOf(toml: string): { name?: string; paths: string[] } {
  let section = "";
  let name: string | undefined;
  const lib: string[] = [], bins: string[] = [];
  for (const line of toml.split("\n")) {
    const head = line.match(/^\s*\[\[?([^\]]+)\]\]?/);
    if (head) section = head[1].trim();
    const value = line.match(/^\s*(name|path)\s*=\s*"([^"]+)"/);
    if (!value) continue;
    if (section === "package" && value[1] === "name") name ??= value[2].replace(/-/g, "_");
    if (section === "lib" && value[1] === "path") lib.push(value[2]);
    if (section === "bin" && value[1] === "path") bins.push(value[2]);
  }
  return { name, paths: [...lib, ...bins.slice(0, 1)] };
}

const under = (dir: string, p: string) => (dir ? `${dir}/${p}` : p);

function resolver(repo: Repo) {
  const crates: { name: string; src: string; root: string }[] = [];
  for (const [path, toml] of repo.config) {
    if (baseOf(path) !== "Cargo.toml") continue;
    const { name, paths } = crateOf(toml);
    const root = [...paths.map((p) => normalize(under(dirOf(path), p))), ...["lib.rs", "main.rs"].map((f) => under(dirOf(path), `src/${f}`))].find((p) => repo.files.has(p));
    if (name && root) crates.push({ name, src: dirOf(root), root });
  }
  const byName = new Map(crates.map((c) => [c.name, c.root]));

  // The crate root a file hangs from, and its module path below that root.
  const moduleOf = (file: string): { root: string; segs: string[] } => {
    const own = { root: file, segs: [] };
    const c = crates.filter((c) => file.startsWith(`${c.src}/`)).sort((a, b) => b.src.length - a.src.length)[0];
    if (!c) return own;
    const rel = file.slice(c.src.length + 1).split("/");
    if (rel.length === 1 && /^(lib|main)\.rs$/.test(rel[0])) return own;
    // each file in src/bin/ is a binary of its own; so is src/bin/x/main.rs, with its modules beside it
    const root = rel[0] !== "bin" ? c.root : rel.length === 2 ? file : `${c.src}/bin/${rel[1]}/main.rs`;
    if (root === file) return own;
    const segs = file.slice(dirOf(root).length + (dirOf(root) ? 1 : 0)).replace(/\.rs$/, "").split("/");
    return { root, segs: segs.at(-1) === "mod" ? segs.slice(0, -1) : segs };
  };
  const fileOf = (root: string, segs: string[]) =>
    !segs.length ? root : [".rs", "/mod.rs"].map((e) => under(dirOf(root), segs.join("/") + e)).find((p) => repo.files.has(p));

  // The longest prefix that is a module file; what follows is an item in it. `anchored`
  // paths (crate/self/super) surely name this repo's code, so a module with no file is dead.
  // The prefix with nothing taken is the base module itself, which always has its file.
  const land = (root: string, base: string[], rest: string[], anchored: boolean): Target => {
    const wholeModule = /^(self|\*)$/.test(rest.at(-1) ?? "");
    if (wholeModule) rest = rest.slice(0, -1);
    for (let k = rest.length; k >= 0; k--) {
      const file = fileOf(root, [...base, ...rest.slice(0, k)]);
      if (!file) continue;
      const next = rest[k];
      // a lowercase name with more after it is a module; it may still be an inline `mod x { }`
      const module = next !== undefined && /^[a-z_]/.test(next) && (k < rest.length - 1 || wholeModule);
      if (anchored && module && !new RegExp(String.raw`\bmod\s+${next}\s*\{`).test(strip(repo.files.get(file)!))) return null;
      return { at: file };
    }
    return null;
  };

  return (from: string, { spec }: Import): Target => {
    const segs = spec.replace(/^::/, "").split("::");
    const first = segs[0];
    if (STD.has(first)) return { outside: "std" };
    const here = moduleOf(from);
    if (first === "crate") return land(here.root, [], segs.slice(1), true);
    if (first === "self" || first === "super") {
      const base = [...here.segs];
      let i = first === "self" ? 1 : 0;
      for (; segs[i] === "super"; i++) if (!base.pop()) return null;
      return land(here.root, base, segs.slice(i), true);
    }
    if (fileOf(here.root, [...here.segs, first])) return land(here.root, here.segs, segs, false);
    const other = byName.get(first);
    return other ? land(other, [], segs.slice(1), false) : { outside: first };
  };
}

const REEXPORT = /\bpub(?:\s*\([^)]*\))?\s+use\s[^;]*;/g;

export const rust: Language = {
  name: "Rust",
  extensions: [".rs"],
  isTest: (path) => /(^|\/)benches\//.test(path) || /_test\.rs$/.test(path),
  config: ["Cargo.toml"],
  imports: importsOf,
  resolver,
  // A crate root is where the crate starts, not a module others must import.
  offersNames: (text, path) => !/(^|\/)src\/(lib|main)\.rs$|(^|\/)src\/bin\//.test(path) && /^\s*pub(?:\s*\([^)]*\))?\s+(?:(?:async|unsafe|const|extern)\s+)*(?:fn|struct|enum|trait|mod|const|static|type|use|union)\b/m.test(strip(text)),
  // `mod x;` lines lay out the crate's modules, which is no pass-through on its own; it
  // takes a `pub use` handing on what another module defines.
  reexportsOnly(text) {
    const body = strip(text);
    const rest = body.replace(REEXPORT, "").replace(/\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+\w+\s*;/g, "");
    return new RegExp(REEXPORT.source).test(body) && !rest.trim();
  },
};
