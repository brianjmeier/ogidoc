#!/usr/bin/env bash
# Split underpaint/ out of the monorepo into a branch whose root is this folder,
# keeping its history. Then push that branch to a new, empty repository.
#
#   underpaint/scripts/export.sh [branch]            # default branch: underpaint-export
#   git push git@github.com:you/underpaint.git underpaint-export:main
set -euo pipefail
branch="${1:-underpaint-export}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"
if [ -n "$(git status --porcelain -- underpaint)" ]; then
  echo "Commit or stash changes under underpaint/ first." >&2
  exit 1
fi
git branch -D "$branch" >/dev/null 2>&1 || true
git subtree split --quiet --prefix=underpaint -b "$branch"
echo "Branch $branch now holds underpaint/ as its root, with history."
echo "Push it to a new repository with:"
echo "  git push <new-repo-url> $branch:main"
