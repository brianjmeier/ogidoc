// The languages the scan reads. Each one says which files are its, what a file imports,
// and where those imports land; the scan does the rest (the folder tree, seams, sizes,
// history, tangles) the same way for every language.
//
// Adding a language: write `src/languages/<name>.ts` exporting a `Language`, add it to
// LANGUAGES below, and give it a test in `test/languages/` on a small made-up repo.

import { javascript } from "./javascript.ts";
import { go } from "./go.ts";
import { rust } from "./rust.ts";
import { python } from "./python.ts";
import { jvm } from "./jvm.ts";

export interface Import {
  /** The import as written: a path, a package, a module path. */
  spec: string;
  /** The names the file takes from it; "*" for the whole thing. */
  symbols: string[];
  /** Only types: it shapes the code but doesn't run it, so it closes no real loop. */
  typeOnly?: boolean;
}

/** Where an import lands: a file or folder of code in the repo, a package from outside by
 *  name, a file in the repo that isn't code (a stylesheet, JSON, an image), or null for
 *  code in the repo that isn't there (a moved or deleted file). */
export type Target = { at: string } | { outside: string } | { asset: string } | null;

/** The repo as a language's resolver sees it. Paths are from the repo root. */
export interface Repo {
  /** Every code file the scan reads, of any language, with its text. */
  files: Map<string, string>;
  /** Every folder that holds a code file, at any depth. */
  dirs: Set<string>;
  /** Every other file the checkout has, that isn't code. */
  others: Set<string>;
  /** The config files languages asked for (`Language.config`), with their text. */
  config: Map<string, string>;
  /** A path with the repo's symlinks followed. */
  real(path: string): string;
}

export interface Language {
  name: string;
  /** File endings that are this language's: [".go"]. */
  extensions: string[];
  /** Whether a file of this language is a test, beyond the test folders every language shares. */
  isTest(path: string): boolean;
  /** Config files the resolver reads, by name, wherever they are in the repo: "go.mod". */
  config?: string[];
  /** What one file imports. */
  imports(text: string, path: string): Import[];
  /** Set up once per scan: where this language's imports land. */
  resolver(repo: Repo): (from: string, imp: Import) => Target;
  /** Whether the file offers names other files could import, for the "unused" tangle. */
  offersNames?(text: string, path: string): boolean;
  /** Whether the file only passes on names other files define, for the "pass-through" tangle. */
  reexportsOnly?(text: string): boolean;
}

export const LANGUAGES: Language[] = [javascript, go, rust, python, jvm];

// Files under these are never the repo's own code, even when committed.
const SKIP = /(^|\/)(node_modules|dist|coverage|target|vendor|\.git|__pycache__|\.venv|venv)\//;
// Folders that hold tests, in every language.
const TEST_DIR = /(^|\/)(tests?|test-support|__tests__|testdata|spec)\//;

const byExt = new Map(LANGUAGES.flatMap((l) => l.extensions.map((e) => [e, l] as const)));
const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
};

/** The language a file is written in, or undefined for anything the scan doesn't read. */
export const languageOf = (path: string): Language | undefined => (SKIP.test(path) || path.endsWith(".d.ts") ? undefined : byExt.get(extOf(path)));
export const isCode = (path: string) => languageOf(path) !== undefined;
export const isTest = (path: string) => TEST_DIR.test(path) || !!languageOf(path)?.isTest(path);
/** The file ending of something the scan can't read, to say what it left out. */
export const unreadKind = (path: string): string | null => {
  const ext = extOf(path);
  return !isCode(path) && !SKIP.test(path) && SOURCE_LIKE.has(ext) ? ext : null;
};
// Endings of source code in languages the scan doesn't read yet, so the map can say so.
const SOURCE_LIKE = new Set([".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".m", ".rb", ".php", ".scala", ".ex", ".exs", ".erl", ".hs", ".ml", ".lua", ".dart", ".zig", ".clj", ".cljs", ".fs", ".r", ".jl", ".vue", ".svelte"]);
/** Every config file name some language reads. */
export const CONFIG_NAMES = new Set(LANGUAGES.flatMap((l) => l.config ?? []));
