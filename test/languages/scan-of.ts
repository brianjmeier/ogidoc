import { scan } from "../../src/scan.ts";

// A made-up repo, scanned: its code and config by path from its root, and the paths of
// its other files (stylesheets, images).
export const scanOf = (files: Record<string, string>, config: Record<string, string> = {}, others: string[] = []) =>
  scan("t", Object.entries(files).map(([path, text]) => ({ path, text })), { config, others });

/** The arrows as `from → to: names`, sorted, to compare whole. */
export const arrows = (sk: ReturnType<typeof scanOf>) => sk.edges.map((e) => `${e.from} → ${e.to}: ${e.symbols.join(", ")}`).sort();
