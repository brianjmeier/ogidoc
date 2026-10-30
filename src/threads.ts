import { mapIndices, type DiffOp } from "./shared/diff.ts";
import type { Reply, Thread, Who } from "./types.ts";

// Comment threads pinned to plan lines. Every change returns new threads and leaves the
// old ones as they were, so a saved copy for undo stays exactly what it was.

export function find(threads: Thread[], id: string): Thread {
  const t = threads.find((x) => x.id === id);
  if (!t) throw new Error(`There is no comment thread ${id}.`);
  return t;
}

export function add(threads: Thread[], { line, by, text, turn }: { line: number; by: Who; text: string; turn: number }): Thread[] {
  const id = `t${1 + Math.max(0, ...threads.map((t) => Number(t.id.slice(1)) || 0))}`;
  return [...threads, { id, line, by, resolved: false, messages: [{ by, text, turn }] }];
}

const update = (threads: Thread[], id: string, change: (t: Thread) => Partial<Thread>) => {
  find(threads, id);
  return threads.map((t) => (t.id === id ? { ...t, ...change(t) } : t));
};

export const reply = (threads: Thread[], id: string, { by, text, turn }: { by: Who; text: string; turn: number }) =>
  update(threads, id, (t) => ({ messages: [...t.messages, { by, text, turn }] }));

// The agent hears about a thread the person resolved once, on its next turn.
export const resolve = (threads: Thread[], id: string, by: Who) => update(threads, id, () => ({ resolved: true, resolvedBy: by, seen: by === "a" }));

// Keep every thread on its line through an edit of the plan. A deleted line hands its
// threads to the nearest line above.
export function move(threads: Thread[], ops: DiffOp[], oldLength: number): Thread[] {
  const map = mapIndices(ops, oldLength);
  return threads.map((t) => (map[t.line] === t.line ? t : { ...t, line: map[t.line] ?? 0 }));
}

// What the agent said in its reply: answers in open threads and new comments, with
// `lineCount` lines in the plan it returned.
export function fromAgent(threads: Thread[], { comments, replies }: Pick<Reply, "comments" | "replies">, lineCount: number, turn: number): Thread[] {
  let out = threads.map((t) => (t.resolved && !t.seen ? { ...t, seen: true } : t));
  for (const r of replies) {
    if (!out.some((t) => t.id === r.thread)) continue;
    if (r.text) out = reply(out, r.thread, { by: "a", text: r.text, turn });
    if (r.resolve) out = resolve(out, r.thread, "a");
  }
  for (const c of comments) out = add(out, { line: Math.min(Math.max(0, c.line), Math.max(0, lineCount - 1)), by: "a", text: c.text, turn });
  return out;
}
