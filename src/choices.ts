import type { DiffOp } from "./shared/diff.ts";
import type { Choice, Line, Reply } from "./types.ts";

// Places where the agent built one way and offers others, cycled in place. The plan
// holds the current option's lines; every option keeps its own lines, so switching back
// to the built one brings its built marks back. Every change returns new choices.

const size = (c: Choice) => c.options[c.current].length;

// Keep every choice on its lines through an edit of the plan. Whatever the person
// writes between its first and last surviving line becomes the current option, lines
// added or removed included. A choice whose lines were all deleted is gone.
export function follow(choices: Choice[], ops: DiffOp[], lines: Line[]): Choice[] {
  const to = new Map<number, number>();
  for (const o of ops) if (o.op === "eq" || o.op === "mod") to.set(o.a, o.b);
  return choices.flatMap((c) => {
    const kept = Array.from({ length: size(c) }, (_, i) => to.get(c.line + i)).filter((b) => b !== undefined);
    if (!kept.length) return [];
    const start = kept[0];
    const options = c.options.map((o, k) => (k === c.current ? lines.slice(start, kept.at(-1)! + 1) : o));
    return [{ ...c, line: start, options }];
  });
}

// The person takes the option the plan shows now, and the other ways go.
export function settle(choices: Choice[], id: string): Choice[] {
  if (!choices.some((c) => c.id === id)) throw new Error(`There is no choice ${id}.`);
  return choices.filter((c) => c.id !== id);
}

// Swap a choice's lines in the plan for another of its options.
export function choose(lines: Line[], choices: Choice[], id: string, option: number): { lines: Line[]; choices: Choice[] } {
  const c = choices.find((x) => x.id === id);
  if (!c) throw new Error(`There is no choice ${id}.`);
  if (!Number.isInteger(option) || !c.options[option]) throw new Error(`Choice ${id} has no option ${option}.`);
  const options = c.options.map((o, k) => (k === c.current ? lines.slice(c.line, c.line + size(c)) : o));
  return {
    lines: [...lines.slice(0, c.line), ...options[option], ...lines.slice(c.line + size(c))],
    choices: choices.map((x) => (x === c ? { ...c, current: option, options } : x)),
  };
}

// The choices the agent left open after its turn, on the plan it returned. Each one's
// first option must be what the plan says at its line, and choices can't overlap; any
// that don't fit are dropped. An id the agent kept keeps the choice's name.
export function fromAgent(old: Choice[], offered: Reply["choices"], lines: Line[]): Choice[] {
  let next = 1 + Math.max(0, ...old.map((c) => Number(c.id.slice(1)) || 0));
  const taken = new Set<number>();
  const out: Choice[] = [];
  for (const r of offered) {
    const [pick, ...others] = r.options;
    if (!pick?.length || !others.length || others.some((o) => !o.length)) continue;
    const span = lines.slice(r.line, r.line + pick.length);
    if (span.length < pick.length || span.some((l, i) => l.text !== pick[i])) continue;
    if (span.some((_, i) => taken.has(r.line + i))) continue;
    span.forEach((_, i) => taken.add(r.line + i));
    const keep = r.id && old.some((c) => c.id === r.id) && !out.some((c) => c.id === r.id);
    const id = keep ? r.id! : `c${next++}`;
    out.push({ id, line: r.line, current: 0, options: [span, ...others.map((o) => o.map((text): Line => ({ text, by: "a", kind: null, status: text.trim() ? "stale" : null })))] });
  }
  return out;
}
