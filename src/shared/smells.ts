import type { Smell } from "../types.ts";

// A tangle the scan sees, in the one wording the person and the agent both read.

/** The boxes a tangle names. */
export const smellIds = (s: Smell): string[] => ("ids" in s ? s.ids : "b" in s ? [s.a, s.b] : [s.a]);

/** A tangle in words: what it is, and why it is one. */
export function tangleWords(s: Smell, nameOf: (id: string) => string = (id) => id): [string, string] {
  switch (s.kind) {
    case "volatile import":
      return [`${nameOf(s.a)} imports ${nameOf(s.b)}`, `${nameOf(s.b)} changed in ${s.count} recent commits, far more often, and code relies on ${nameOf(s.a)}`];
    case "change together":
      return [`${nameOf(s.a)} and ${nameOf(s.b)} change together`, `in ${s.count} commits, with no import between them: a link the code doesn't show`];
    case "cycle":
      return [`${s.ids.map(nameOf).join(" → ")} → …`, "import each other round in a loop"];
    case "unused":
      return [nameOf(s.a), "exports names nothing in the code imports"];
    case "pass-through":
      return [nameOf(s.a), "only re-exports what other files define"];
  }
}

/** A tangle as one line, for an agent. */
export const smellText = (s: Smell): string => `${s.kind}: ${tangleWords(s).join(", ")}`;
