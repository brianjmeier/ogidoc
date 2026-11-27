import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { scan, type Skeleton } from "./scan.ts";
import { CONFIG_NAMES, isCode } from "./languages/index.ts";
import { baseOf } from "./languages/text.ts";

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
  const read = (paths: string[]) => paths.flatMap((path) => {
    const text = io.read(path);
    return text === null ? [] : [{ path, text }];
  });
  const plain = entries.filter((x) => !x.link).map((x) => x.path);
  const files = read(plain.filter(isCode));
  if (!files.length) return null;
  const config = Object.fromEntries(read(plain.filter((p) => CONFIG_NAMES.has(baseOf(p)))).map((f) => [f.path, f.text]));
  const log = io.git(["log", "-n", String(HISTORY), "--name-only", "--relative", "--format=%x00"]) ?? "";
  const history = log.split("\0").map((c) => c.split("\n").filter(Boolean)).filter((c) => c.length);
  return scan(title, files, { links, history, config, others: plain.filter((p) => !isCode(p)) });
}

/** The commit the checkout is on, to scan again only when it moved. */
export const headOf = (io: RepoIO): string => io.git(["rev-parse", "HEAD"])?.trim() ?? "";

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
