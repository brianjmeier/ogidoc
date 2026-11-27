// Small text helpers every language's reader shares.

export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Whether a path is under a folder that holds tests, in every language. */
export const inTestFolder = (path: string) => /(^|\/)(tests?|test-support|__tests__|testdata|spec)\//.test(path);

/** A path with `.` and `..` worked out. */
export function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Source with its comments blanked, so a commented-out import doesn't count. Strings are
 *  kept, so an import's path stays readable and `//` inside a URL is not a comment; with
 *  `strings: "blank"` their contents are blanked too, so text that only looks like code
 *  inside a string doesn't count. Everything keeps its place, so an index into one
 *  version is an index into the other.
 *  `quotes` are the string delimiters; `template` strings (JS backticks, Python triple
 *  quotes, Rust raw strings) are blanked too, since code written inside one is text, not
 *  an import. Line breaks stay, so line numbers still match. */
export function withoutComments(text: string, style: { line: string; block?: [string, string]; quotes: string[]; template?: string[]; strings?: "keep" | "blank" }): string {
  // One regex finds the next place anything starts; plain code between is copied whole.
  // Its order is the order of precedence when two start at the same place.
  const openers = [...(style.template ?? []), ...style.quotes, style.line, ...(style.block ? [style.block[0]] : [])];
  const next = new RegExp(openers.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const out: string[] = [];
  let i = 0;
  for (;;) {
    next.lastIndex = i;
    const m = next.exec(text);
    if (!m) break;
    out.push(text.slice(i, m.index));
    const o = m[0];
    i = m.index;
    if (style.template?.includes(o)) {
      const end = text.indexOf(o, i + o.length);
      const stop = end < 0 ? text.length : end;
      out.push(o, blank(text.slice(i + o.length, stop)), end < 0 ? "" : o);
      i = end < 0 ? text.length : end + o.length;
    } else if (style.quotes.includes(o)) {
      let j = i + o.length;
      while (j < text.length && !text.startsWith(o, j) && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(text.length, j + o.length);
      out.push(style.strings === "blank" ? o + blank(text.slice(i + o.length, j)) + text.slice(j, stop) : text.slice(i, stop));
      i = stop;
    } else if (o === style.line) {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out.push(blank(text.slice(i, stop)));
      i = stop;
    } else {
      const end = text.indexOf(style.block![1], i + o.length);
      const stop = end < 0 ? text.length : end + style.block![1].length;
      out.push(blank(text.slice(i, stop)));
      i = stop;
    }
  }
  out.push(text.slice(i));
  return out.join("");
}

/** Comments as C, Java, Go, Rust, Kotlin and JavaScript write them. */
export const C_LIKE = { line: "//", block: ["/*", "*/"] as [string, string], quotes: ['"', "'"] };
