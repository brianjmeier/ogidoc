import type { Import, Language, Repo, Target } from "./index.ts";
import { C_LIKE, dirOf, normalize, withoutComments } from "./text.ts";

// JavaScript and TypeScript: `import … from "x"`, `export … from "x"`, `import("x")`.
// Relative paths land on files, with or without their ending; tsconfig `paths` are
// aliases; anything else is a package from outside.

const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
// Template strings are blanked: code written inside one (a fixture, a generated file) is text.
const strip = (text: string) => withoutComments(text, { ...C_LIKE, quotes: ['"', "'"], template: ["`"] });

/** The imports of one file: where from, and which names. */
export function importsOf(text: string): Import[] {
  // Keywords are found where strings are blank, paths read where they are kept.
  const src = withoutComments(text, { ...C_LIKE, template: ["`"], strings: "blank" });
  const kept = strip(text);
  const out: Import[] = [];
  const named = (list: string) =>
    list.split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim()).filter(Boolean);
  // An import clause is one of: `{ … }`, `* as x`, `x`, or `x, { … }` / `x, * as y`.
  const clause = String.raw`(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)`;
  const re = new RegExp(String.raw`\b(?:import|export)\s+(type\s+)?${clause}\s*from\s*["']([^"']*)["']|\bimport\s*["']([^"']*)["']|\bimport\(\s*["']([^"']*)["']\s*\)`, "dg");
  const path = (m: RegExpExecArray, g: number) => kept.slice(...m.indices![g]!);
  for (const m of src.matchAll(re)) {
    if (m[4] !== undefined || m[5] !== undefined) {
      out.push({ spec: path(m, m[4] !== undefined ? 4 : 5), symbols: ["*"] });
      continue;
    }
    const clause = m[2];
    const symbols: string[] = [];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) symbols.push(...named(braces[1]));
    const rest = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
    if (/\*/.test(rest)) symbols.push("*");
    else if (rest && rest !== "type") symbols.push("default");
    if (!braces && /^\*/.test(clause)) symbols.splice(0, symbols.length, "*");
    // `import type …`, or braces where every name is `type x`
    const typeOnly = !!m[1] || (!!braces && !rest && braces[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => /^type\s/.test(s)));
    out.push({ spec: path(m, 3), symbols: symbols.length ? symbols : ["*"], ...(typeOnly && { typeOnly }) });
  }
  return out;
}

/** The package a bare import names: `react`, `@base-ui/react`, and every `node:` / `bun:` as one. */
const packageOf = (spec: string) =>
  /^(node|bun):/.test(spec) ? spec.split(":")[0] + ":*" : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

/** tsconfig's `paths`, relative to the project root. tsconfig may carry comments and trailing commas. */
export function aliasesOf(tsconfig: string | undefined): Record<string, string[]> {
  try {
    const raw = withoutComments(tsconfig ?? "{}", { ...C_LIKE, quotes: ['"'] }).replace(/,(\s*[}\]])/g, "$1");
    const { baseUrl = ".", paths = {} } = JSON.parse(raw).compilerOptions ?? {};
    return Object.fromEntries(Object.entries(paths as Record<string, string[]>).map(([k, v]) => [k, v.map((t) => normalize(`${baseUrl}/${t}`))]));
  } catch {
    return {};
  }
}

function resolver(repo: Repo) {
  const aliases = aliasesOf(repo.config.get("tsconfig.json"));
  const known = (p: string) => repo.files.has(p);
  const find = (raw: string) => {
    const base = repo.real(raw);
    return EXTS.map((e) => base + e).find(known) ?? EXTS.map((e) => repo.real(raw + e)).find(known) ??
      // `./x.js` written in a TS project names `./x.ts`
      (/\.(js|jsx|mjs)$/.test(base) ? [".ts", ".tsx"].map((e) => base.replace(/\.(js|jsx|mjs)$/, e)).find(known) : undefined);
  };
  const at = (p: string | undefined): Target => (p ? { at: p } : null);
  return (from: string, { spec }: Import): Target => {
    if (spec.startsWith(".")) {
      const path = normalize(`${dirOf(from)}/${spec.replace(/\?.*$/, "")}`);
      return at(find(path)) ?? (repo.others.has(repo.real(path)) ? { asset: path } : null);
    }
    for (const [key, targets] of Object.entries(aliases)) {
      const star = key.endsWith("/*");
      const head = star ? key.slice(0, -1) : key;
      if (star ? spec.startsWith(head) : spec === key) {
        for (const t of targets) {
          const hit = find(normalize(star ? t.replace(/\*$/, spec.slice(head.length)) : t));
          if (hit) return { at: hit };
        }
        return null;
      }
    }
    return { outside: packageOf(spec) };
  };
}

const REEXPORT = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"']+["'];?/g;

export const javascript: Language = {
  name: "JavaScript and TypeScript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  isTest: (path) => /\.(test|spec)\.[a-z]+$/.test(path),
  config: ["tsconfig.json"],
  imports: importsOf,
  resolver,
  offersNames: (text) => /^export\s+(const|function|class|interface|type|enum|async)/m.test(text),
  reexportsOnly(text) {
    const body = strip(text);
    const rest = body.replace(REEXPORT, "").replace(/\bimport\s[^;]*?from\s*["'][^"']+["'];?/g, "");
    return new RegExp(REEXPORT.source).test(body) && !rest.trim();
  },
};
