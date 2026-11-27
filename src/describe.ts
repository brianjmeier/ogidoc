// Describing a box when the person opens it: what the reader agent is handed, and what
// it answers (read by prompt.ts `parseDescribed`). The scan knows a box's size, seam and
// arrows; only an agent can say what the box is for.

import type { CodeRef, Pin } from "./types.ts";
import { count } from "./shared/words.ts";

const STYLE = `How a good box reads:

- Pseudocode, not prose and not code. Short lines that read like code that wouldn't
  compile: names, arrows, conditions, results.
- Real names stay real: when a line names something from the code, use its real name.
- "code" points at where the box lives, so the person can open it.`;

/** What a describe turn is handed: one box (or the top of the map) and what sits inside. */
export interface DescribeBrief {
  /** The box being opened, or null for the top of the map. */
  box: { id: string; name: string; files: number; size: number } | null;
  children: { id: string; name: string; file: boolean; size: number; seam: string[]; seamSize: number; usedBy: number; uses: number }[];
  /** Imports between the children, and from or to outside the box, with the names they carry. */
  arrows: { from: string; to: string; symbols: string[] }[];
  /** Tangles the scan already found here, in its words. */
  smells: string[];
}

export function describePrompt(b: DescribeBrief): string {
  const where = b.box ? `\`${b.box.id}\` (${b.box.files} files, ${b.box.size} lines)` : "the top of this codebase";
  const files = b.children.filter((c) => c.file);
  return `# Say what ${where} does, for Ogidoc

Ogidoc draws a codebase as a map: boxes for its folders and files, arrows for imports.
Ogidoc read the boxes, their sizes, their seams (the names code outside a box imports
from it) and the arrows from the code itself; they are exact. What it can't read is
what each box is *for*. The person just opened ${where}: say what its boxes do.

You are in **read-only** mode: read and search the code, don't change anything.

## The boxes

${b.children.map((c) => `- \`${c.id}\`${c.file ? " (file)" : ""}: ${c.size} lines of code, used by ${count(c.usedBy, "file")} outside it, uses ${count(c.uses, "file")} outside it${c.seam.length ? `; its seam: ${c.seam.join(", ")}${c.seamSize > c.seam.length ? ` and ${c.seamSize - c.seam.length} more` : ""}` : ""}`).join("\n")}

## Arrows

${b.arrows.length ? b.arrows.map((a) => `- ${a.from} → ${a.to}: ${a.symbols.join(", ")}`).join("\n") : "(none)"}
${b.smells.length ? `\n## Tangles Ogidoc already sees here\n\n${b.smells.map((s) => `- ${s}`).join("\n")}\n` : ""}
## What to write

${STYLE}

For ${b.box ? "the opened box and " : ""}each box above:
- "name": what a person would call it, in a word or two (the path is shown beside it).
- "pseudo": ${b.box ? "1–3 lines for the opened box, what it is for and what it owns; " : ""}1–3 lines
  for a folder, 2–7 for a file. Real names stay real.
- "pins": tangles you see reading it that the scan can't: an \`if\` for one value, a
  parameter only one caller understands, a swallowed error, a retry or a sleep, a
  disabled test, a copy of logic that lives elsewhere, a call order callers must know.
  Each with its \`file\` and \`line\`. None is fine; don't invent any.
${files.length ? `
For a file, you may also add the functions that matter inside it, as new boxes:
"id" like "${files[0].id}#name", "parent" the file's id, "code" pointing at it, and
"edges" between them where one calls another.` : ""}

Reply with only:

\`\`\`json
{
  "summary": "one short line",
  "boxes": [{ "id": "${b.children[0]?.id ?? "id"}", "name": "…", "pseudo": ["…"], "pins": [{ "kind": "special case", "text": "…", "file": "…", "line": 12 }] }],
  "add": [{ "id": "…#fn", "parent": "…", "name": "…", "pseudo": ["…"], "code": [{ "file": "…", "line": 3, "symbol": "fn" }] }],
  "edges": [{ "from": "…#fn", "to": "…#other", "label": "…" }]
}
\`\`\`
`;
}

export interface Described {
  summary: string;
  boxes: { id: string; name?: string; pseudo: string[]; pins?: Pin[] }[];
  add: { id: string; parent: string; name: string; pseudo: string[]; code?: CodeRef[] }[];
  edges: { from: string; to: string; label?: string }[];
}
