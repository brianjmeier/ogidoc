import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./paths.ts";
import type { Box, Choice, HumanDiff, LastTurn, Line, LineChange, Reply, Thread, Who } from "./types.ts";

export function readAgentFile(name: string): string {
  return readFileSync(join(AGENT_DIR, name), "utf8");
}

interface PromptInput {
  skill: string;
  rules: string;
  turn: number;
  planPath: string;
  cwd: string;
  lines: Line[];
  boxes: Box[];
  threads: Thread[];
  choices: Choice[];
  humanDiff: HumanDiff;
  drift: string[];
  last: LastTurn | null;
}

export function buildPrompt({ skill, rules, turn, planPath, cwd, lines, boxes, threads, choices, humanDiff, drift, last }: PromptInput): string {
  const vars: Record<string, string> = {
    skill: skill.replace(/^---[\s\S]*?---\n/, "").trim(),
    rules: rules.trim(),
    turn: String(turn),
    planPath,
    cwd,
    plan: jsonLines(lines.map(({ text, kind, status, by }) => ({ text, kind: kind ?? null, status: status ?? null, by }))),
    boxes: boxes.length
      ? jsonLines(boxes.map(({ name, lines: body, status, uses }) => ({ name, lines: body.map((l) => l.text), status, uses })))
      : "None yet.",
    comments: describeThreads(threads, lines),
    choices: describeChoices(choices),
    humanDiff: describeHumanDiff(humanDiff, turn),
    drift: drift.length
      ? `# Code that changed outside a turn\n\nThese files changed since your last turn, and you didn't change them:\n\n${drift.map((f) => `- ${f}`).join("\n")}`
      : "",
    last: last?.summary ? `# Your previous turn\n\n${last.summary}` : "",
  };
  return readAgentFile("turn.md").replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "").replace(/\n{3,}/g, "\n\n");
}

function jsonLines(items: unknown[]): string {
  return "```json\n[\n" + items.map((x) => "  " + JSON.stringify(x)).join(",\n") + "\n]\n```";
}

// Open threads, and the ones the person closed since the agent last looked.
function describeThreads(threads: Thread[], lines: Line[]): string {
  const open = threads.filter((t) => !t.resolved);
  const closed = threads.filter((t) => t.resolved && t.resolvedBy === "h" && !t.seen);
  if (!open.length && !closed.length) return "None open.";
  const who = (by: Who) => (by === "a" ? "you" : "person");
  const show = (t: Thread) => [
    `${t.id} on line ${t.line} (${JSON.stringify(lines[t.line]?.text ?? "")}):`,
    ...t.messages.map((m) => `  ${who(m.by)}: ${m.text}`),
  ].join("\n");
  const out: string[] = [];
  if (open.length) out.push("```\n" + open.map(show).join("\n\n") + "\n```");
  if (closed.length) out.push(`The person resolved ${closed.map((t) => t.id).join(", ")}:\n\n` + "```\n" + closed.map(show).join("\n\n") + "\n```");
  return out.join("\n\n");
}

// The choices still open, each option's lines, and which one the plan shows now.
function describeChoices(choices: Choice[]): string {
  if (!choices.length) return "None open.";
  const show = (c: Choice) => [
    `${c.id} on line ${c.line}: ${c.current ? `the person switched to option ${c.current + 1}` : "the person kept your pick"}`,
    ...c.options.map((o, k) => `  option ${k + 1}${k === c.current ? ", in the plan now" : ""}: ${JSON.stringify(o.map((l) => l.text))}`),
  ].join("\n");
  return "```\n" + choices.map(show).join("\n\n") + "\n```";
}

function describeHumanDiff(d: HumanDiff, turn: number): string {
  if (turn === 1) return "This is the first turn. Everything in the plan is theirs.";
  const fmt = (c: LineChange, pad: string) =>
    c.op === "mod" ? `${pad}- ${c.old}\n${pad}+ ${c.text}` : `${pad}${c.op === "add" ? "+" : "-"} ${c.text}`;
  const out = d.lines.map((c) => fmt(c, ""));
  for (const b of d.boxes) out.push(`In box ${b.name}:`, ...b.lines.map((c) => fmt(c, "  ")));
  if (!out.length) return "Nothing. They handed over without editing, which means: go on.";
  return "```diff\n" + out.join("\n") + "\n```";
}

const KINDS = new Set<unknown>(["proposal", "example"]);
const STATUSES = new Set<unknown>(["built", "stale", "blocked"]);

// The agent ends its reply with a fenced JSON object. Take the last one that parses.
// Sent back with the turn's prompt when a reply didn't end the turn.
export const notATurn = (problem: string) => `# Your turn isn't over

Your last reply didn't end the turn. ${problem}

Whatever you changed in the code is still there. Carry on from where you are: build
the next line that isn't built, test first, or offer a choice, fold settled lines into
a box, or stop on what only the person can give you. Then end with the reply described
above.`;

export function parseReply(text: string): Reply {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const start = text.lastIndexOf('{"plan"') >= 0 ? text.lastIndexOf('{"plan"') : text.lastIndexOf("{\n  \"plan\"");
  if (start >= 0) blocks.push(text.slice(start));
  for (const raw of blocks.reverse()) {
    const obj = tryParse(raw);
    if (obj && Array.isArray(obj.plan)) return normalize(obj);
  }
  const said = text.trim().slice(-300);
  throw new Error(`The agent's reply had no JSON block with a plan in it.${said ? ` It said: ${said}` : ""}`);
}

function tryParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const end = raw.lastIndexOf("}");
    if (end < 0) return null;
    try { return JSON.parse(raw.slice(0, end + 1)); } catch { return null; }
  }
}

// The reply is the agent's free-form JSON: anything it got wrong becomes a safe default.
function normalize(o: any): Reply {
  const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  return {
    plan: o.plan.map((l: any) => {
      const line = typeof l === "string" ? { text: l } : l || {};
      const text = str(line.text).replace(/\s+$/, "");
      return {
        text,
        kind: KINDS.has(line.kind) ? line.kind : null,
        status: text.trim() && STATUSES.has(line.status) ? line.status : null,
      };
    }),
    boxes: arr(o.boxes)
      .filter((b) => b && str(b.name).trim())
      .map((b) => ({
        name: str(b.name).trim().replace(/[^\w.-]/g, ""),
        lines: arr(b.lines).map((l) => (typeof l === "string" ? l : str(l?.text))),
        status: STATUSES.has(b.status) ? b.status : "stale",
        uses: arr(b.uses).filter((u) => typeof u === "string"),
      })),
    choices: arr(o.choices)
      .filter((c) => c && Number.isInteger(c.line) && Array.isArray(c.options))
      .map((c) => ({
        ...(str(c.id) && { id: str(c.id) }),
        line: c.line,
        options: arr(c.options).map((opt) => arr(opt).map((l) => str(l).replace(/\s+$/, ""))),
      })),
    replies: arr(o.replies)
      .filter((r) => r && str(r.thread))
      .map((r) => ({ thread: str(r.thread), text: str(r.text).trim(), resolve: r.resolve === true })),
    symbols: arr(o.symbols).filter((s) => s && str(s.name)).map((s) => ({ name: str(s.name), where: str(s.where) })),
    suggestions: arr(o.suggestions).filter((s) => typeof s === "string" && s.trim()),
    steps: arr(o.steps).map((s) => ({ kind: str(s?.kind) || "red-green", what: str(s?.what) })),
    files: arr(o.files).map((f) => ({ op: str(f?.op) || "~", path: str(f?.path), why: str(f?.why) })),
    checks: arr(o.checks).map((c) => ({ name: str(c?.name), ok: c?.ok !== false })),
    summary: str(o.summary),
  };
}
