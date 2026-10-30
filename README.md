# Underpaint

Build software with an agent by taking turns on one pseudocode file. There is no
chat. You write the idea the way it sits in your head; the agent edits the same file
in place, asks its questions next to the line they're about, and builds the real
code underneath, test first, in small steps. Each line shows whether it is built, so
when the plan looks done, the software is done.

Painters block in a rough layer called the underpainting and keep painting until it
becomes the picture. Here the rough layer is the only part you touch. The finished
work goes on underneath it.

![The plan on the left, settled pieces in boxes on the right](docs/boxes.png)

## Install

Node 20 or newer. No dependencies, no build step.

```bash
npm install -g github:brianjmeier/underpaint
underpaint install-skill        # optional: teach Claude Code and pi the tool
```

Run the same install again to update. Working on Underpaint itself? Clone it and run
`npm link` inside the checkout instead, so `underpaint` runs your copy.

## Run it

```bash
cd your-project
underpaint feature.plan --open
```

| Option | |
| --- | --- |
| `--agent claude\|pi\|mock` | Who holds the other pen. Defaults to Claude Code if installed, else pi. |
| `--agent-arg <arg>` | Extra argument for the agent CLI, repeatable: `--agent-arg=--model --agent-arg=sonnet` |
| `--no-commit` | Don't commit each agent turn. |
| `--port <n>` | Defaults to 4747, or any free port. |
| `--open` | Open the editor in the browser. |

To see it without an agent, run `npm run demo` in a clone (a scripted agent plays four
turns).

`underpaint install-skill [claude|pi|both]` (default both) copies the skill into
`~/.claude/skills` and `~/.pi/agent/skills`, so an agent in a normal session knows the
tool and how to start it.

## How a session goes

- **Strict turns.** One side holds the pen. `⌘↵` (or `Ctrl ↵`) passes it. Your edits
  are the whole message; passing without edits means "go on". Code never changes on
  your turn.
- **No syntax.** Write any pseudocode. The agent follows your style and tells the
  editor what each line is: a question, an answer, a proposal (accept ✓ or reject ✕ in
  the margin), an example (it becomes a test), or a real name from the codebase
  (underlined).
- **Building underneath.** The agent builds what it understands in TDD baby steps and
  stops to ask where it would have to guess. Margin marks say what's built, what needs
  a build, and what waits on a question. The Underneath drawer lists the steps, files
  and checks of the last turn.
- **Boxes.** When a piece is settled, the agent moves it into a named box on the
  canvas and leaves a reference in the plan, so the plan stays short. Click a box to
  edit it; that's how you disagree with an abstraction.
- **Autocomplete.** On your turn the agent's guesses about your next lines show as
  ghost text. Tab accepts.
- **Done means done.** No open questions, every line and box built, checks green.
- **One commit per agent turn**, code and plan together. "Undo agent turn" reverts it.
  If code changes outside a turn, the agent asks about it instead of overwriting.

## Files

Everything stays plain text next to your code:

```
feature.plan                         the plan
.underpaint/rules.md                 house rules for turns; edit freely
.underpaint/feature/boxes/*.plan     one file per box
.underpaint/feature/state.json       what the editor knows per line (git-ignored)
```

## What the agent reads

- `agent/SKILL.md` teaches the agent what Underpaint is: the shared plan, the pen,
  building underneath, boxes, honest build status.
- `agent/rules.md` is the default for `.underpaint/rules.md`: how big turns are, what
  to do at a gap, what earns a built mark.
- `agent/turn.md` is the prompt for one turn: the skill, the rules, the plan, what the
  person changed, drift, and the JSON reply the editor expects.

Claude Code runs as `claude -p --output-format stream-json` with edit and shell tools
allowed; pi runs as `pi -p --mode json --no-session`. Both edit code with their own
tools and end their reply with the JSON block. Tool use streams to the editor as
activity.

## Layout

```
bin/underpaint.js     the CLI
src/session.js        turns, line metadata, boxes, commits, drift, undo
src/agents.js         Claude Code, pi and mock adapters
src/prompt.js         builds the turn prompt, parses the reply
src/git.js            the few git operations a turn needs
src/shared/diff.js    line diff used by server and browser
web/                  the editor (plain ES modules)
agent/                skill, rules and turn prompt
design/               the design walkthrough this was built from
```

## Tests

From a clone of this repository:

```bash
npm ci                # only installs Playwright, for the browser test
npm test              # unit tests: diff, prompt, session with git, both adapters
npm run test:e2e      # the editor in Chromium against the scripted agent
npm run test:real     # one real Claude Code turn in a temp repo (needs `claude`)
node test/real-agent.mjs pi   # same with pi (needs pi with a provider configured)
```

The pi adapter is tested against pi's JSON event format with a stand-in binary, and
the real pi CLI was checked to accept its flags. A live pi turn needs credentials.
