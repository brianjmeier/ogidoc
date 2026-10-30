import { hasContent } from "./diff.ts";
import type { Choice, Line, Thread } from "../types.ts";

// A thread is waiting on the person when the agent spoke last.
export const waitingOnYou = (t: Thread) => !t.resolved && t.messages.at(-1)?.by === "a";

// A proposal the person can accept or reject; a blank one offers nothing.
export const isOpenProposal = (l: Line) => l.kind === "proposal" && !!l.text.trim();

const waits = (l: Line) => isOpenProposal(l) || (hasContent(l.text) && l.status === "blocked");

// The lines that wait on the person, top to bottom: a choice to make, a proposal to
// accept or reject, a line blocked on a comment, a comment the agent answered.
export function stops(lines: Line[], choices: Choice[], threads: Thread[]): number[] {
  const at = new Set<number>();
  for (const c of choices) at.add(c.line);
  lines.forEach((l, i) => { if (waits(l)) at.add(i); });
  for (const t of threads) if (waitingOnYou(t)) at.add(t.line);
  return [...at].filter((n) => n < lines.length).sort((a, b) => a - b);
}

// Whether anything waits on the person, without listing it.
export const anyStop = (lines: Line[], choices: Choice[], threads: Thread[]) =>
  choices.some((c) => c.line < lines.length) || lines.some(waits) || threads.some((t) => waitingOnYou(t) && t.line < lines.length);

// The stop after line `from` (or before it, going up), wrapping around; null when
// nothing waits.
export function nextStop(at: number[], from: number, by: 1 | -1): number | null {
  if (!at.length) return null;
  if (by === 1) return at.find((n) => n > from) ?? at[0];
  return [...at].reverse().find((n) => n < from) ?? at[at.length - 1];
}
