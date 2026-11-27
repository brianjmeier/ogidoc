import type { Import, Language, Repo, Target } from "./index.ts";
import { C_LIKE, baseOf, dirOf, normalize, withoutComments } from "./text.ts";

// Go: `import "x"`, `import alias "x"` and the grouped `import ( … )`. A package is a
// folder, so an import under a go.mod's module path lands on that folder; a first
// segment with no dot is the standard library; anything else is a module from outside.

// Raw strings (backticks) are blanked: code written inside one is text.
const blankStrings = (text: string) => withoutComments(text, { ...C_LIKE, template: ["`"], strings: "blank" });
const keepStrings = (text: string) => withoutComments(text, { ...C_LIKE, template: ["`"] });

/** The name a file calls a package by when it gives no alias: the path's last segment,
 *  skipping a major version (`…/v2`, `yaml.v3`). */
const nameOf = (spec: string) => {
  const parts = spec.split("/");
  const last = /^v\d+$/.test(parts.at(-1)!) && parts.length > 1 ? parts.at(-2)! : parts.at(-1)!;
  return last.replace(/\.v\d+$/, "");
};

/** The imports of one file, each with the names the file uses from it (`store.Open` → `Open`). */
export function importsOf(text: string): Import[] {
  // Keywords are found where strings are blank, paths read where they are kept.
  const src = blankStrings(text);
  const kept = keepStrings(text);
  const specs: { alias?: string; spec: string }[] = [];
  const one = /([\w.]+\s+)?"[^"\n]*"/dg;
  const read = (body: string, offset: number) => {
    for (const m of body.matchAll(one)) {
      const [start, end] = m.indices![0]!;
      const quoted = kept.slice(offset + start, offset + end).trim();
      const alias = m[1]?.trim();
      specs.push({ alias, spec: quoted.slice(quoted.indexOf('"') + 1, -1) });
    }
  };
  for (const m of src.matchAll(/\bimport\s*(\([^)]*\)|[\w.]+\s+"[^"\n]*"|"[^"\n]*")/dg)) {
    const [start] = m.indices![1]!;
    read(m[1], start);
  }
  return specs.map(({ alias, spec }) => {
    if (alias === "." || alias === "_") return { spec, symbols: ["*"] };
    const name = alias ?? nameOf(spec);
    const used = new Set<string>();
    for (const u of src.matchAll(new RegExp(String.raw`(?<![\w.])${name.replace(/\W/g, "\\$&")}\.([A-Za-z_]\w*)`, "g"))) used.add(u[1]);
    return { spec, symbols: used.size ? [...used] : ["*"] };
  });
}

// Hosts whose module is the first three segments: github.com/owner/repo.
const HOSTED = /^(github\.com|gitlab\.com|bitbucket\.org|golang\.org\/x)\//;

/** An outside package as a person names it: `std`, or its module. */
export const outsideOf = (spec: string) => {
  if (!spec.split("/")[0].includes(".")) return "std";
  if (HOSTED.test(spec)) return spec.split("/").slice(0, 3).join("/");
  return spec.replace(/\/v\d+$/, "");
};

/** Each go.mod's module path, with the folder it roots. */
const modulesOf = (config: Map<string, string>) =>
  [...config]
    .filter(([path]) => baseOf(path) === "go.mod")
    .flatMap(([path, text]) => {
      const m = withoutComments(text, { ...C_LIKE, quotes: ['"'] }).match(/^\s*module\s+"?([^"\s]+)"?/m);
      return m ? [{ path: m[1], root: dirOf(path) }] : [];
    })
    .sort((a, b) => b.path.length - a.path.length);

function resolver(repo: Repo) {
  const modules = modulesOf(repo.config);
  const rootHasGo = [...repo.files.keys()].some((f) => !f.includes("/") && f.endsWith(".go"));
  return (_from: string, { spec }: Import): Target => {
    const mod = modules.find((m) => spec === m.path || spec.startsWith(m.path + "/"));
    if (!mod) return { outside: outsideOf(spec) };
    const folder = repo.real(normalize(`${mod.root}/${spec.slice(mod.path.length)}`));
    return repo.dirs.has(folder) || (folder === "" && rootHasGo) ? { at: folder } : null;
  };
}

const EXPORTED = /^(?:func\s+(?:\([^)]*\)\s*)?|(?:type|var|const)\s+)[A-Z]/m;
// gofmt closes a top-level block with `)` at the start of a line; values inside may hold parens.
const BLOCK = /^(?:type|var|const)\s*\(([\s\S]*?)^\)/gm;

export const go: Language = {
  name: "Go",
  extensions: [".go"],
  isTest: (path) => path.endsWith("_test.go"),
  config: ["go.mod"],
  imports: importsOf,
  resolver,
  offersNames(text) {
    const src = blankStrings(text);
    return EXPORTED.test(src) || [...src.matchAll(BLOCK)].some((m) => /^\s*[A-Z]/m.test(m[1]));
  },
};
