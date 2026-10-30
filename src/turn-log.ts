import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, relative } from "node:path";

// Where each agent turn is recorded, so it can be undone and so changes made outside a
// turn can be told apart from the agent's. In a git repository every turn is a commit.
// With --no-commit nothing new is recorded, but a turn committed earlier can still be
// undone. Outside a repository undo restores the plan alone.
export interface TurnLog {
  readonly commits: boolean;
  // The code as it is now; `record` commits what changes after this mark.
  begin(): Mark;
  // Commit what changed since `mark`, plus the editor's own files when asked.
  record(mark: Mark, message: string, opts: { ownFiles: boolean }): string | null;
  // Take a recorded turn's code back out of the working tree. The editor's own files
  // are left alone: the caller rewrites them before the next `record`.
  revert(commit: string): void;
  // Code that changed since the last record without the editor or the agent.
  drift(): string[];
  // What to keep across restarts, handed back as `saved` next time.
  saved(): LogState;
}

export type Mark = Map<string, string>;

export interface LogState {
  baseCommit?: string | null;
  dirtyBase?: Record<string, string>;
}

// `ownFiles` are absolute paths the editor writes itself: the plan and its folder.
export function turnLog({ cwd, ownFiles, commit, saved = {} }: { cwd: string; ownFiles: string[]; commit: boolean; saved?: LogState }): TurnLog {
  const root = repoRoot(cwd);
  if (!root) return noLog;
  const log = gitLog(root, ownFiles.map((f) => relative(root, f)), saved);
  return commit ? log : { ...noLog, revert: log.revert };
}

const noLog: TurnLog = {
  commits: false,
  begin: () => new Map(),
  record: () => null,
  revert() {},
  drift: () => [],
  saved: () => ({}),
};

function gitLog(root: string, own: string[], saved: LogState): TurnLog {
  const isOwn = (p: string) => own.some((o) => p === o || p.startsWith(`${o}/`));
  let baseCommit = saved.baseCommit ?? head(root);
  // Work already in progress when we start isn't drift; only what changes after.
  let dirtyBase = saved.dirtyBase ?? Object.fromEntries(dirtyFiles(root));

  return {
    commits: true,
    begin: () => dirtyFiles(root),
    record(before, message, { ownFiles }) {
      const after = dirtyFiles(root);
      const changed = [...after.keys()].filter((p) => before.get(p) !== after.get(p));
      try {
        return commitPaths(root, [...new Set([...changed, ...(ownFiles ? own : [])])], message);
      } finally {
        baseCommit = head(root);
        dirtyBase = Object.fromEntries(dirtyFiles(root));
      }
    },
    revert(commit) {
      revertExcept(root, commit, own);
    },
    drift() {
      const committed = filesInCommits(root, baseCommit);
      const dirty = [...dirtyFiles(root)].filter(([p, h]) => dirtyBase[p] !== h).map(([p]) => p);
      return [...new Set([...committed, ...dirty])].filter((p) => !isOwn(p));
    },
    saved: () => ({ baseCommit, dirtyBase }),
  };
}

// ---------- git ----------
// Every path below is relative to the repository root.

function run(root: string, args: string[], input?: string) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", input });
  return { ok: r.status === 0, out: r.stdout || "", err: (r.stderr || "").trim() };
}

function git(root: string, args: string[]) {
  const r = run(root, args);
  return { ...r, out: r.out.trim() };
}

function repoRoot(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out : null;
}

function head(root: string): string | null {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : null;
}

// One `git status` entry: XY are the index and working-tree columns; a rename or copy
// also names the path it came from.
interface Entry {
  code: string;
  path: string;
  from?: string;
}

// Changed paths as git sees them, ignored files left out.
function status(root: string, paths?: string[]): Entry[] {
  const r = run(root, ["status", "--porcelain", "-z", "--untracked-files=all", ...(paths ? ["--", ...paths] : [])]);
  if (!r.ok) return [];
  const parts = r.out.split("\0").filter(Boolean);
  const out: Entry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e: Entry = { code: parts[i].slice(0, 2), path: parts[i].slice(3) };
    if (e.code[0] === "R" || e.code[0] === "C") e.from = parts[++i];
    out.push(e);
  }
  return out;
}

// Uncommitted paths mapped to a content hash, so a file that was already dirty but
// changed again still counts as changed.
function dirtyFiles(root: string): Map<string, string> {
  // A rename also changes the path it came from.
  const paths = status(root).flatMap((e) => (e.from ? [e.path, e.from] : [e.path]));
  // One git call hashes every file still on disk; a deleted one has no hash.
  const present = paths.filter((p) => statSync(join(root, p), { throwIfNoEntry: false })?.isFile());
  const hashes = present.length ? run(root, ["hash-object", "--stdin-paths"], present.join("\n")).out.trim().split("\n") : [];
  const hashOf = new Map(present.map((p, i) => [p, hashes[i]]));
  return new Map(paths.map((p) => [p, hashOf.get(p) ?? "deleted"]));
}

// Commit exactly what git reports changed under `paths`: an ignored path never shows
// up, and a change that is only in the index is already staged.
function commitPaths(root: string, paths: string[], message: string): string | null {
  const entries = paths.length ? status(root, paths) : [];
  if (!entries.length) return null;
  const unstaged = entries.filter((e) => e.code[1] !== " ").map((e) => e.path);
  if (unstaged.length) {
    const add = git(root, ["add", "-A", "--", ...unstaged]);
    if (!add.ok) throw new Error(`git add failed: ${add.err}`);
  }
  const c = git(root, ["commit", "-q", "-m", message, "--", ...entries.flatMap((e) => (e.from ? [e.path, e.from] : [e.path]))]);
  if (!c.ok) throw new Error(`git commit failed: ${c.err || c.out}`);
  return head(root);
}

function filesInCommits(root: string, from: string | null, to = "HEAD"): string[] {
  if (!from) return [];
  const r = git(root, ["diff", "--name-only", `${from}..${to}`]);
  return r.ok && r.out ? r.out.split("\n") : [];
}

// Undo a commit's changes in the working tree, except under `keep`: the caller is about
// to rewrite those paths itself, so conflicts there don't matter.
function revertExcept(root: string, commit: string, keep: string[]) {
  const r = git(root, ["revert", "--no-commit", commit]);
  if (!r.ok) {
    const conflicts = git(root, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
    const inKeep = (p: string) => keep.some((k) => p === k || p.startsWith(`${k}/`));
    if (!conflicts.length || !conflicts.every(inKeep)) {
      git(root, ["revert", "--abort"]);
      throw new Error(`Couldn't revert the agent's commit: ${r.err || r.out}`);
    }
  }
  git(root, ["reset", "-q", "--", ...keep]);
  git(root, ["checkout", "-q", "HEAD", "--", ...keep]);
  // The revert is applied by hand from here; drop git's in-progress marker.
  git(root, ["revert", "--quit"]);
}
