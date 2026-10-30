import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Every path here is relative to the repository root.

function git(root: string, args: string[]) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

export function repoRoot(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out : null;
}

export function head(root: string): string | null {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : null;
}

// Uncommitted paths mapped to a content hash, so a file that was already dirty but
// changed again still counts as changed.
export function dirtyFiles(root: string): Map<string, string> {
  const r = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  const map = new Map<string, string>();
  if (r.status !== 0) return map;
  const parts = r.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    paths.push(parts[i].slice(3));
    if (parts[i].startsWith("R")) i++; // a rename's next entry is its old path
  }
  // One git call hashes every file still on disk; a deleted one has no hash.
  const present = paths.filter((p) => statSync(join(root, p), { throwIfNoEntry: false })?.isFile());
  const hashes = present.length ? spawnSync("git", ["hash-object", "--stdin-paths"], { cwd: root, encoding: "utf8", input: present.join("\n") }).stdout.trim().split("\n") : [];
  const hashOf = new Map(present.map((p, i) => [p, hashes[i]]));
  for (const p of paths) map.set(p, hashOf.get(p) ?? "deleted");
  return map;
}

export function changedSince(root: string, before: Map<string, string>): string[] {
  const after = dirtyFiles(root);
  return [...after.keys()].filter((p) => before.get(p) !== after.get(p));
}

// Paths the repository's .gitignore excludes; tracked files never count as ignored.
function ignored(root: string, paths: string[]): Set<string> {
  const r = git(root, ["check-ignore", "--", ...paths]);
  return new Set(r.out ? r.out.split("\n") : []);
}

export function commitPaths(root: string, paths: string[], message: string): string | null {
  if (paths.length) {
    const skip = ignored(root, paths);
    paths = paths.filter((p) => !skip.has(p));
  }
  if (!paths.length) return null;
  // A path gone from disk and from the index is a deletion already staged.
  const tracked = new Set(git(root, ["ls-files", "--", ...paths]).out.split("\n"));
  const toAdd = paths.filter((p) => existsSync(join(root, p)) || tracked.has(p));
  const add = toAdd.length ? git(root, ["add", "-A", "--", ...toAdd]) : { ok: true, out: "", err: "" };
  if (!add.ok) throw new Error(`git add failed: ${add.err}`);
  const staged = git(root, ["diff", "--cached", "--quiet", "--", ...paths]);
  if (staged.ok) return null;
  const c = git(root, ["commit", "-q", "-m", message, "--", ...paths]);
  if (!c.ok) throw new Error(`git commit failed: ${c.err || c.out}`);
  return head(root);
}

export function filesInCommits(root: string, from: string | null, to = "HEAD"): string[] {
  if (!from) return [];
  const r = git(root, ["diff", "--name-only", `${from}..${to}`]);
  return r.ok && r.out ? r.out.split("\n") : [];
}

// Undo a commit's changes in the working tree, except under `keep`: the caller is about
// to rewrite those paths itself, so conflicts there don't matter. Returns the paths the
// commit touched, for the caller to commit along with its own.
export function revertExcept(root: string, commit: string, keep: string[]): string[] {
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
  return filesInCommits(root, `${commit}^`, commit);
}
