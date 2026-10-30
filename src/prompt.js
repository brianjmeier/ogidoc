import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agent");

export function readAgentFile(name) {
  return readFileSync(join(AGENT_DIR, name), "utf8");
}

export function buildPrompt({ skill, rules, turn, planPath, cwd, lines, boxes, humanDiff, drift, last }) {
  const vars = {
    skill: skill.replace(/^---[\s\S]*?---\n/, "").trim(),
    rules: rules.trim(),
    turn: String(turn),
    planPath,
    cwd,
    plan: jsonLines(lines.map(({ text, kind, status, by }) => ({ text, kind: kind ?? null, status: status ?? null, by }))),
    boxes: boxes.length
      ? jsonLines(boxes.map(({ name, lines: body, status, uses }) => ({ name, lines: body.map((l) => l.text), status, uses })))
      : "None yet.",
    humanDiff: describeHumanDiff(humanDiff, turn),
    drift: drift.length
      ? `# Code that changed outside a turn\n\nThese files changed since your last turn, and you didn't change them:\n\n${drift.map((f) => `- ${f}`).join("\n")}`
      : "",
    last: last?.summary ? `# Your previous turn\n\n${last.summary}` : "",
  };
  return readAgentFile("turn.md").replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "").replace(/\n{3,}/g, "\n\n");
}

function jsonLines(items) {
  return "```json\n[\n" + items.map((x) => "  " + JSON.stringify(x)).join(",\n") + "\n]\n```";
}

function describeHumanDiff(d, turn) {
  if (turn === 1) return "This is the first turn. Everything in the plan is theirs.";
  const out = [];
  for (const c of d.lines) {
    if (c.op === "add") out.push(`+ ${c.text}`);
    else if (c.op === "del") out.push(`- ${c.text}`);
    else if (c.op === "mod") out.push(`- ${c.old}\n+ ${c.text}`);
  }
  for (const b of d.boxes) {
    out.push(`In box ${b.name}:`);
    for (const c of b.lines) {
      if (c.op === "add") out.push(`  + ${c.text}`);
      else if (c.op === "del") out.push(`  - ${c.text}`);
      else if (c.op === "mod") out.push(`  - ${c.old}\n  + ${c.text}`);
    }
  }
  if (!out.length) return "Nothing. They passed the pen without editing, which means: go on.";
  return "```diff\n" + out.join("\n") + "\n```";
}

const KINDS = new Set(["question", "answer", "proposal", "example"]);
const STATUSES = new Set(["built", "stale", "blocked"]);

// The agent ends its reply with a fenced JSON object. Take the last one that parses.
export function parseReply(text) {
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

function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const end = raw.lastIndexOf("}");
    if (end < 0) return null;
    try { return JSON.parse(raw.slice(0, end + 1)); } catch { return null; }
  }
}

function normalize(o) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const str = (x) => (typeof x === "string" ? x : "");
  return {
    plan: o.plan.map((l) => {
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
    symbols: arr(o.symbols).filter((s) => s && str(s.name)).map((s) => ({ name: str(s.name), where: str(s.where) })),
    suggestions: arr(o.suggestions).filter((s) => typeof s === "string" && s.trim()),
    steps: arr(o.steps).map((s) => ({ kind: str(s?.kind) || "red-green", what: str(s?.what) })),
    files: arr(o.files).map((f) => ({ op: str(f?.op) || "~", path: str(f?.path), why: str(f?.why) })),
    checks: arr(o.checks).map((c) => ({ name: str(c?.name), ok: c?.ok !== false })),
    summary: str(o.summary),
  };
}
