---
name: ogidoc
description: How to work in a chat next to an Ogidoc session, where a person and a separate plan agent take turns on one pseudocode plan in the browser. Use when the person mentions Ogidoc or a session of it, asks you to start, check or stop one, or asks for chat-side work (tests, running the app, a PR) on a project with a session running. Not for the plan agent taking a turn inside a session; that one gets its own instructions.
---

# Ogidoc, from the chat

Ogidoc is where the person builds software by taking turns with an agent on one
pseudocode plan. The person edits the plan in the editor in their browser and hands
over; a separate agent, the plan agent, takes the turn: it edits the plan and builds the
real code underneath, test first, and commits. Then it is the person's turn again.

You are not that agent. You are the chat beside it, for everything that isn't the plan:
running the tests, running the app, reading the code, opening a pull request, answering
questions. Turns stay between the person and the plan agent.

## What you never do

- **Edit the plan or anything Ogidoc keeps.** That is the session's plan file and its
  `.ogidoc/` folder. If the person wants the plan changed, they change it in the editor.
- **Take a turn or drive the session.** Never post to the session's server, and never
  hand over, undo, comment or choose for the person. Those are theirs, in the editor.
- **Change code while the plan agent is working.** It commits whatever changed during
  its turn as its own. Check first, and wait if it is the agent's turn.

## Seeing a session

Every session has a name, and both you and the plan agent know it.

```bash
ogidoc list               # the sessions running on this machine
ogidoc status [name]      # whose turn it is, what the agent is doing, how the last turn went
ogidoc wait [name]        # returns when the agent's current or next turn ends, with its summary and commit
```

Without a name, a command takes the session started in the current folder (or a folder
above it), or the only one running. When several could be meant, it says so: name one.
Add `--json` when you want to read the result in a script.

`ogidoc wait` blocks until the plan agent's turn ends: the one running now, or the next
one, after the person hands over. Run it in the background when you have something to
do after a turn, like running the tests on what it built, so you are told when it ends.
It exits with an error when the turn failed.

To see what a turn did, read its commit: `git show <commit>`. Turns are commits titled
`ogidoc: turn N on <name>`, or `ogidoc: failed turn N on <name>`.

## Changing code from the chat

Code you change is code the plan agent finds next turn, and it treats it as the
person's. So:

1. Run `ogidoc status` first. If it is the agent's turn, wait with `ogidoc wait`.
2. Prefer a separate git worktree for anything bigger than a quick fix, like a branch
   for a pull request, so the session's checkout only changes when the person means it.
3. Tell the person what you changed. The plan agent will build on it.

## Starting and stopping

From the project directory:

```bash
ogidoc --detach --open    # start the session in the background and open the editor
ogidoc stop [name]        # stop it, once no turn is running
```

Without a name, Ogidoc opens the session in this folder, or starts one named after
the folder; `ogidoc checkout --detach` starts or opens the one called `checkout`.
Always start it with `--detach`, so the terminal stays free.

If `ogidoc` is not on the path, it isn't installed; tell the person how to install it
from https://github.com/brianjmeier/ogidoc.
