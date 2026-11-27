import type { Import, Language, Repo, Target } from "./index.ts";
import { C_LIKE, dirOf, withoutComments } from "./text.ts";

// Java and Kotlin: `import a.b.C`, `import a.b.*`, `import static a.b.C.m` and Kotlin's
// `import a.b.C as D`. Names are packages, not paths, so the resolver indexes every
// file's `package` line and top-level types: a type lands on its file, a package (or a
// Kotlin top-level function in it) on its folder, and any other package is from outside.
// shortcut: same-package use needs no import, so it draws no arrow and such files can read
// as unused; upgrade when the map should infer same-package references by name.

// Text blocks and raw strings are blanked whole, then string contents too: names hold no quotes.
const blank = (text: string) => withoutComments(text, { ...C_LIKE, template: ['"""'], strings: "blank" });

const IMPORT = /^[ \t]*import\s+(static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+(\w+))?\s*;?[ \t]*$/gm;
const PACKAGE = /^[ \t]*package\s+([\w.]+)/m;
// shortcut: a declaration counts as top-level when it starts its line unindented, so a nested type
// written flush left counts too; upgrade if a real repo writes them that way.
const MODIFIERS = String.raw`(?:@\w+(?:\([^)\n]*\))?\s+)*(?:(?:public|private|protected|internal|abstract|final|sealed|non-sealed|open|static|strictfp|data|enum|annotation|value|inline|fun|expect|actual)\s+)*`;
const TYPE = new RegExp(String.raw`^${MODIFIERS}(?:class|interface|enum|record|@interface|object|typealias)\s+(\w+)`, "gm");
const PUBLIC_TYPE = new RegExp(String.raw`^(?:@\w+(?:\([^)\n]*\))?\s+)*public\s+${MODIFIERS}(?:class|interface|enum|record|@interface)\s`, "m");
const KOTLIN_DECL = new RegExp(String.raw`^${MODIFIERS}(?:class|interface|object|typealias|fun|val|var|const)\b`, "gm");

/** The imports of one file, each with the name it takes (`D` as `C`), or `*`. */
export function importsOf(text: string): Import[] {
  return [...blank(text).matchAll(IMPORT)].map((m) => ({
    spec: m[2] + (m[3] ?? ""),
    symbols: [m[3] ? "*" : m[2].slice(m[2].lastIndexOf(".") + 1)],
  }));
}

/** An outside package as a person names it: `std` for the platform, else its first two segments. */
export const outsideOf = (spec: string) => (/^(java|javax|kotlin)\./.test(spec) ? "std" : spec.split(".").slice(0, 2).join("."));

const isJvm = (path: string) => path.endsWith(".java") || path.endsWith(".kt");
const inTests = (path: string) => /(^|\/)tests?\//.test(path) || jvm.isTest(path);

function resolver(repo: Repo) {
  // package → its folder (one of its main code's, when it spans several), and package.Type → file
  const folders = new Map<string, string>();
  const types = new Map<string, string>();
  for (const [path, text] of repo.files) {
    if (!isJvm(path)) continue;
    const src = blank(text);
    const pkg = src.match(PACKAGE)?.[1];
    if (!pkg) continue;
    const known = folders.get(pkg);
    if (!known || (inTests(known) && !inTests(path))) folders.set(pkg, dirOf(path));
    for (const m of src.matchAll(TYPE)) if (!types.has(`${pkg}.${m[1]}`)) types.set(`${pkg}.${m[1]}`, path);
  }
  return (_from: string, { spec }: Import): Target => {
    const parts = spec.split(".");
    // the longest leading run of segments that is one of this repo's packages
    let n = parts.length;
    while (n > 0 && !folders.has(parts.slice(0, n).join("."))) n--;
    if (n === 0) return { outside: outsideOf(spec) };
    const pkg = parts.slice(0, n).join(".");
    const next = parts[n];
    const folder = (): Target => (repo.dirs.has(folders.get(pkg)!) ? { at: folders.get(pkg)! } : null);
    if (next === undefined || next === "*") return folder();
    const file = types.get(`${pkg}.${next}`);
    if (file) return { at: file };
    // shortcut: a capitalised name is taken for a type and so is dead, a lower-case one for a
    // top-level function or property; upgrade by indexing Kotlin top-level names too.
    if (/^[A-Z]/.test(next)) return null;
    return n + 1 === parts.length ? folder() : { outside: outsideOf(spec) };
  };
}

export const jvm: Language = {
  name: "Java and Kotlin",
  extensions: [".java", ".kt"],
  isTest: (path) => /(Test|Tests|IT)\.(java|kt)$/.test(path),
  imports: importsOf,
  resolver,
  offersNames(text, path) {
    const src = blank(text);
    if (path.endsWith(".java")) return PUBLIC_TYPE.test(src);
    return [...src.matchAll(KOTLIN_DECL)].some((m) => !/\b(private|internal)\s/.test(m[0]));
  },
};
