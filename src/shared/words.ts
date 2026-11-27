// Counts and lists in the one wording the map text, the tangles and the editor share.

/** `1 file`, `3 files`. */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first `max` names, then how many more of `total` there are: `a, b, and 3 more`. */
export const clip = (names: string[], max: number, total = names.length) =>
  names.slice(0, max).join(", ") + (total > max ? `, and ${total - max} more` : "");
