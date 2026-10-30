import { spawnSync } from "node:child_process";

// Every path here is relative to the repository root.

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

export function repoRoot(cwd) {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out : null;
}

export function head(root) {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : null;
}

// Uncommitted paths mapped to a content hash, so a file that was already dirty but
// changed again still counts as changed.
export function dirtyFiles(root) {
  const r = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  const map = new Map();
  if (r.status !== 0) return map;
  const parts = r.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const path = parts[i].slice(3);
    if (code.startsWith("R")) i++;
    const h = git(root, ["hash-object", "--", path]);
    map.set(path, h.ok ? h.out : "deleted");
  }
  return map;
}

export function changedSince(root, before) {
  const after = dirtyFiles(root);
  return [...after.keys()].filter((p) => before.get(p) !== after.get(p));
}

export function commitPaths(root, paths, message) {
  if (!paths.length) return null;
  const add = git(root, ["add", "-A", "--", ...paths]);
  if (!add.ok) throw new Error(`git add failed: ${add.err}`);
  const staged = git(root, ["diff", "--cached", "--quiet", "--", ...paths]);
  if (staged.ok) return null;
  const c = git(root, ["commit", "-q", "-m", message, "--", ...paths]);
  if (!c.ok) throw new Error(`git commit failed: ${c.err || c.out}`);
  return head(root);
}

export function filesInCommits(root, from, to = "HEAD") {
  if (!from) return [];
  const r = git(root, ["diff", "--name-only", `${from}..${to}`]);
  return r.ok && r.out ? r.out.split("\n") : [];
}

export function revert(root, commit) {
  const r = git(root, ["revert", "--no-edit", commit]);
  if (!r.ok) {
    git(root, ["revert", "--abort"]);
    throw new Error(`Couldn't revert the agent's commit: ${r.err || r.out}`);
  }
  return head(root);
}
