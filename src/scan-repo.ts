import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { isCode, scan, type Skeleton } from "./scan.ts";

// The scan of a checkout: what git tracks, read from disk, and how often things changed
// together in its history. The scan itself is pure; this hands it the files.

/** What the scan reads from a checkout, by paths from its root. */
export interface RepoIO {
  /** git's output, or null when git fails (no checkout, no commits). */
  git(args: string[]): string | null;
  read(path: string): string | null;
  readlink(path: string): string | null;
}

// How much history the scan reads to see what changes often and what changes together.
const HISTORY = 1000;

/** The checkout as the scan sees it, or null when it isn't a git checkout. */
export function scanRepo(title: string, io: RepoIO): Skeleton | null {
  const listed = io.git(["ls-files", "-s", "-z"]);
  if (listed === null) return null;
  const entries = listed.split("\0").filter(Boolean).map((l) => {
    const [meta, path] = l.split("\t");
    return { link: meta.startsWith("120000"), path };
  });
  const links: Record<string, string> = {};
  for (const x of entries) {
    const to = x.link ? io.readlink(x.path) : null;
    if (to !== null) links[x.path] = to;
  }
  const files = entries.filter((x) => !x.link && isCode(x.path)).flatMap((x) => {
    const text = io.read(x.path);
    return text === null ? [] : [{ path: x.path, text }];
  });
  if (!files.length) return null;
  const log = io.git(["log", "-n", String(HISTORY), "--name-only", "--relative", "--format=%x00"]) ?? "";
  const history = log.split("\0").map((c) => c.split("\n").filter(Boolean)).filter((c) => c.length);
  return scan(title, files, { aliases: aliasesOf(io), links, history });
}

/** The commit the checkout is on, to scan again only when it moved. */
export const headOf = (io: RepoIO): string => io.git(["rev-parse", "HEAD"])?.trim() ?? "";

// tsconfig's `paths`, relative to the project root. tsconfig may carry comments.
function aliasesOf(io: RepoIO): Record<string, string[]> {
  try {
    const raw = withoutComments(io.read("tsconfig.json") ?? "{}").replace(/,(\s*[}\]])/g, "$1");
    const { baseUrl = ".", paths = {} } = JSON.parse(raw).compilerOptions ?? {};
    return Object.fromEntries(Object.entries(paths as Record<string, string[]>).map(([k, v]) => [k, v.map((t) => join(baseUrl, t))]));
  } catch {
    return {};
  }
}

// JSON with its comments taken out. A string is skipped whole, so `"@/*"` stays as it is.
const withoutComments = (text: string) => text.replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, str) => str ?? "");

/** The real checkout at `root`. */
export function repoIO(root: string): RepoIO {
  const attempt = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  return {
    git: (args) => attempt(() => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] })),
    read: (path) => attempt(() => readFileSync(join(root, path), "utf8")),
    readlink: (path) => attempt(() => readlinkSync(join(root, path))),
  };
}
