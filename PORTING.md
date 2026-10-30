# Moving Underpaint to its own repository

Underpaint lives in `underpaint/` of the michiadas monorepo but depends on nothing
outside that folder. Everything it needs to stand alone is already inside it:
`package.json` with a lockfile, `LICENSE`, `.gitignore`, and a CI workflow in
`.github/workflows/ci.yml` that GitHub picks up once the folder is the repository root.

## 1. Split it out with its history

From the monorepo, with `underpaint/` committed:

```bash
underpaint/scripts/export.sh            # creates branch underpaint-export
git push git@github.com:<you>/underpaint.git underpaint-export:main
```

The branch has `underpaint/` as its root and keeps every commit that touched the
folder. Commits from before the rename (when it was `plancoding/`, design only) are not
carried over; the design page they produced is in `design/`.

## 2. Check the new repository

```bash
git clone git@github.com:<you>/underpaint.git && cd underpaint
npm ci
npm test
npx playwright install chromium && npm run test:e2e
```

Optionally `npm link` to get the `underpaint` command, and `npm run test:real` for one
real Claude Code turn.

## 3. Clean up the monorepo

These pieces exist only because Underpaint lived here. Remove them after the move:

- `underpaint/` itself
- `.github/workflows/underpaint.yml`
- the `underpaint*` scripts in the root `package.json`
- the skill links `.claude/skills/underpaint` and `pi/agent/skills/underpaint`. Replace
  them with `underpaint install-skill both`, which copies the skill into
  `~/.claude/skills` and `~/.pi/agent/skills`.

## Publishing (optional)

The package is ready for npm as `underpaint` (check the name is free first). `files`
in `package.json` limits the package to the CLI, server, editor and agent text.
