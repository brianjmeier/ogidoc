import type { Smell } from "../types.ts";

// A tangle the scan sees, in the one wording the person and the agent both read.

/** The boxes a tangle names. */
export const smellIds = (s: Smell): string[] =>
  s.kind === "cycle" ? s.ids : s.kind === "volatile import" ? [s.b, ...s.importers] : s.kind === "change together" ? [s.a, s.b] : [s.a];

/** The same tangle with every box it names renamed, as the map renames scan ids. */
export const renameSmell = (s: Smell, idOf: (id: string) => string): Smell =>
  s.kind === "cycle" ? { ...s, ids: s.ids.map(idOf), closing: s.closing.map((e) => ({ from: idOf(e.from), to: idOf(e.to) })) }
  : s.kind === "volatile import" ? { ...s, b: idOf(s.b), importers: s.importers.map(idOf) }
  : s.kind === "change together" ? { ...s, a: idOf(s.a), b: idOf(s.b) }
  : { ...s, a: idOf(s.a) };

// A path as read from the folder that holds the boxes: `kit/timers.ts`, not the whole path.
const within = (ids: string[], path: string) => {
  const base = ids[0].slice(0, ids[0].lastIndexOf("/") + 1);
  return base && ids.every((id) => id.startsWith(base)) && path.startsWith(base) ? path.slice(base.length) : path;
};

const few = (ids: string[], nameOf: (id: string) => string, n = 4) =>
  ids.slice(0, n).map(nameOf).join(", ") + (ids.length > n ? ` and ${ids.length - n} more` : "");

/** A tangle in words: what it is, and why it is one. */
export function tangleWords(s: Smell, nameOf: (id: string) => string = (id) => id): [string, string] {
  switch (s.kind) {
    case "volatile import":
      return [`${nameOf(s.b)}, imported by ${s.importers.length} steadier ${s.importers.length === 1 ? "box" : "boxes"} other code relies on`,
        `it changed in ${s.count} recent commits, at least twice as often as ${few(s.importers, nameOf)}`];
    case "change together":
      return [`${nameOf(s.a)} and ${nameOf(s.b)} change together`, `in ${s.count} commits, with no import between them: a link the code doesn't show`];
    case "cycle":
      return [`${s.ids.length} boxes import each other round in a loop: ${few(s.ids, nameOf, 6)}`,
        `closed by ${few(s.closing.map((e) => `${within(s.ids, e.from)} → ${within(s.ids, e.to)}`), (x) => x, 3)}`];
    case "unused":
      return [nameOf(s.a), "exports names nothing in the code imports"];
    case "pass-through":
      return [nameOf(s.a), "only re-exports what other files define"];
    case "large":
      return [nameOf(s.a), `${s.size} lines of code in one file`];
  }
}

/** A tangle as one line, for an agent. */
export const smellText = (s: Smell): string => `${s.kind}: ${tangleWords(s).join(", ")}`;
