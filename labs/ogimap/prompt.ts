// The two prompts: draw the map of a codebase, and take one turn on it.

import type { FlowMap } from "./map.ts";

export interface Task {
  prompt: string;
  title?: string;
  // What scoping settled, in the agent's words: the brief the map is drawn from.
  brief?: string;
  phase: "scope" | "frame" | "map" | "done";
  messages: { who: "you" | "agent"; text: string; refs?: { file: string; line?: number }[] }[];
  session?: string;
}

export const MAP_FILE = ".ogimap/map.json";

const SCHEMA = `The map is JSON, in ${MAP_FILE}:

{
  "title": "what this codebase is, in a few words",
  "nodes": [{
    "id": "links.shorten",            // stable: keep it across turns while the thing exists
    "name": "shorten",                // the name a person would say
    "parent": "links",                // the node it sits inside, or null at the top level
    "kind": "entry | module | step | store | external",
    "pseudo": ["url must be http(s), else 400", "code = makeCode()", "store.save(code, url)", "→ 201 { code, short: /code }"],
    "code": [{ "file": "src/links.js", "line": 5, "symbol": "shorten" }],
    "status": "built | stale | proposal",
    "was": ["..."],                    // only on a stale node: its pseudo as the code is today
    "ways": [{ "pseudo": ["..."] }]    // optional: other ways you'd build it (see below)
  }],
  "edges": [{ "from": "links.shorten", "to": "codes.makeCode", "label": "new code", "kind": "call | data | event" }],
  "flows": [{ "id": "shorten", "name": "shorten a link", "steps": ["http.server", "routes.route", "links.shorten", "codes.makeCode", "store.save"] }]
}`;

const STYLE = `How a good map reads:

- Two levels. Top-level nodes are the abstractions a person would draw on a whiteboard
  (modules, services, stores, the outside world). Their children are the functions or
  parts that matter. Leave out trivial helpers.
- Pseudocode, not prose and not code. Short lines that read like code that wouldn't
  compile: names, arrows, conditions, results. 2–7 lines per node. A parent's pseudo
  says what the module is for and what it owns, in 1–3 lines.
- Real names stay real: when a line names something from the code, use its real name.
- Edges go between the most specific nodes (children). The editor lifts them to the
  parents when it shows the top level, so don't add parent-to-parent copies.
- Flows are the paths a person would want to watch: one per user-visible behaviour
  (a request, a command, a job). Steps are node ids in the order the work happens.
- "code" points at where the node lives, so the person can open it.`;

export function mapPrompt(): string {
  return `# Draw the flow map of this codebase

You are drawing a visual flow map of the code in this directory for Ogimap, an editor
where a person understands and changes a codebase through a map of its abstractions
and their pseudocode, instead of through prose.

Read the code. Don't change any code. Write the map to ${MAP_FILE}.

${SCHEMA}

${STYLE}

Every node you draw from existing code is "built". When you're done, reply with only:

\`\`\`json
{ "summary": "one short line" }
\`\`\`
`;
}

// Scoping: the person said what they want in a prompt. You may only read. Talk until
// the task is clear enough to draw, then say so.
export function scopePrompt({ task, map, said }: { task: Task; map: FlowMap | null; said: string }): string {
  const first = task.messages.length <= 1;
  return `${first ? `# Scope a task in Ogimap

Ogimap is an editor where a person changes a codebase by editing a flow map of it:
boxes of pseudocode for its abstractions, arrows between them. In a big codebase you
can't start from the map, so a task starts as a prompt. This is that first stage.

You are in **read-only** mode: read and search the code, don't change anything.

Your job: understand what the person wants and where it lands in the code, well enough
to draw the part of the map the task touches with the changes on it. Ask only what you
can't find out from the code, and only what changes what you'd build: at most two
questions a reply, each with the answer you'd pick. When nothing important is open,
you are ready. Decide that yourself; don't ask for permission.

Keep replies short: a few lines, real names in backticks, no essays.
${map ? `\nA map of this codebase already exists (ids you may point at):\n${map.nodes.map((n) => `- ${n.id}`).join("\n")}\n` : ""}
## The person's prompt

` : "## The person answered\n\n"}${said}

## End every reply with

\`\`\`json
{
  "ready": false,
  "title": "the task in a few words",
  "refs": [{ "file": "src/where.js", "line": 12 }],
  "brief": "only when ready: what will change, in a few pseudocode-ish lines"
}
\`\`\`
`;
}

export interface ScopeReply {
  text: string;
  ready: boolean;
  title: string;
  brief: string;
  refs: { file: string; line?: number }[];
}

export function parseScope(text: string): ScopeReply {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1);
  const prose = (last ? text.slice(0, last.index) : text).trim();
  try {
    const r = JSON.parse(last?.[1] ?? "");
    // `say` carries the words when an agent puts them in the block (the scripted demo does).
    return { text: typeof r.say === "string" ? r.say : prose, ready: !!r.ready, title: String(r.title ?? ""), brief: String(r.brief ?? ""), refs: Array.isArray(r.refs) ? r.refs.filter((x: any) => typeof x?.file === "string") : [] };
  } catch {
    return { text: prose, ready: false, title: "", brief: "", refs: [] };
  }
}

// Framing: the task is clear; draw the part of the map it touches, with the change on it.
export function framePrompt({ task, map }: { task: Task; map: FlowMap | null }): string {
  return `# Draw the task map in Ogimap

A person and you scoped a task. Now draw the part of the codebase it touches as a flow
map, with the change already on it as a plan. Don't change any code. Write only
${MAP_FILE}${map ? " (replace it: this map is for this task)" : ""}.

## The task: ${task.title ?? ""}

${task.prompt}

### What scoping settled

${task.brief ?? ""}

### The conversation

${task.messages.map((m) => `${m.who}: ${m.text}`).join("\n\n")}

## What to draw

- Only what the task touches, plus one step of context either side (what calls in,
  what it calls). A big codebase stays out of the picture.
- Existing abstractions as they are: "built", pseudo true to the code.
- The change as a plan on the map, never in prose:
  - a node whose behaviour changes: pseudo says what it will do, "status": "stale",
    and "was" keeps what it does today;
  - a node that doesn't exist yet: "status": "proposal";
  - new edges for the new calls; flows that pass through the change.
- Where a decision is expensive or visible, put your pick in pseudo and the other ways
  in "ways".

${SCHEMA}

${STYLE}

Reply with only:

\`\`\`json
{ "summary": "one short line" }
\`\`\`
`;
}

export function turnPrompt({ map, intent, rules, task }: { map: FlowMap; intent: string; rules: string; task?: Task | null }): string {
  return `# Your turn in Ogimap
${task ? `\nThe task: **${task.title}**. ${task.prompt}\n\nNodes marked "stale" (with "was") or "proposal" are the plan: build them, along with the person's edits.\n` : ""}
Ogimap is an editor where a person changes a codebase without writing prose. They see
a flow map of its abstractions: boxes with pseudocode, arrows between them, flows they
can play. They select boxes, rewrite pseudocode, draw new boxes and arrows, cross out
the ones they don't want, and hand the pen to you. Their edits are the whole message.

Your turn: make the code do what their edited map says, then redraw the map so it is
true to the code again.

## What the person changed

\`\`\`diff
${intent}
\`\`\`

Read it like a code review of the design. A rewritten pseudo line means the old one was
wrong. A NEW node is something they want to exist: build it, and put it where it
belongs in the code. A NEW edge means "this should use / send to that". A REMOVE means
take it out of the code, and whatever only it needed.

## How to work

- Build in small test-first steps: a failing test for the behaviour, the code, green,
  then tidy. Run the project's tests before you finish. Keep the tests green.
- Decide the small things yourself. Where a decision is expensive to undo or the person
  would notice it (a dependency, a data model, a public interface, behaviour), build
  your pick and offer one or two other ways on that node, in "ways": each is the
  whole pseudo the node would have if built that way. Never ask in prose.
- Keep the person's wording. Their lines stay theirs unless the code proves them wrong;
  then rewrite the line to say what the code really does.
- A line you could not build (it needs something only they have) stays, and its node
  is "stale".

## Then redraw the map

Rewrite ${MAP_FILE} whole, true to the code as it now is. Keep ids stable for things
that still exist. Nodes the person added get proper ids (rename them if theirs were
placeholders). Update "code" anchors, edges and flows. A node you built or changed is
"built" only if a test covers it; drop its "was" once built.

${SCHEMA}

${STYLE}
${rules ? `\n## House rules\n\n${rules}\n` : ""}
## The map you were handed (before their edits)

\`\`\`json
${JSON.stringify(map, null, 1)}
\`\`\`

## Your reply

End with only this, with the ids of the nodes whose code you changed or created:

\`\`\`json
{ "summary": "one short line, what you built", "changed": ["links.shorten"] }
\`\`\`
`;
}

export interface Reply {
  summary: string;
  changed: string[];
}

export function parseReply(text: string): Reply {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [text.slice(text.lastIndexOf("{"))];
  for (const c of candidates) {
    try {
      const r = JSON.parse(c);
      return { summary: String(r.summary ?? ""), changed: Array.isArray(r.changed) ? r.changed.map(String) : [] };
    } catch {}
  }
  return { summary: text.trim().split("\n").at(-1)?.slice(0, 160) ?? "", changed: [] };
}
