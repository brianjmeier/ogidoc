// The two prompts: draw the map of a codebase, and take one turn on it.

import type { FlowMap } from "./map.ts";

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

export function turnPrompt({ map, intent, rules }: { map: FlowMap; intent: string; rules: string }): string {
  return `# Your turn in Ogimap

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
"built" only if a test covers it.

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
