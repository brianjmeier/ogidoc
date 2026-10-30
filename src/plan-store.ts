import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { joinLines } from "./shared/diff.ts";
import { AGENT_DIR } from "./paths.ts";
import type { LogState } from "./turn-log.ts";
import type { Base } from "./plan.ts";
import type { Box, LastTurn, Line, Settings, Symbol, Thread } from "./types.ts";

// Where a plan lives on disk and how it is saved. Everything stays plain text beside the
// code: the plan file itself, one file per box, comment threads in comments.json, and
// the editor's local bookkeeping (what it knows about each line, undo history), which
// git ignores.
//
//   weekly.plan
//   .underpaint/rules.md               the house rules the agent reads every turn
//   .underpaint/weekly/boxes/*.plan
//   .underpaint/weekly/comments.json
//   .underpaint/weekly/state.json      local
//   .underpaint/weekly/history.json    local

// The session as it was just before an agent turn, so the turn can be taken back.
export interface HistoryEntry {
  lines: Line[];
  boxes: Box[];
  threads: Thread[];
  base: Base;
  last: LastTurn | null;
  symbols: Symbol[];
  suggestions: string[];
  turn: number;
  commit: string | null;
}

interface Stored {
  turn: number;
  lines: Line[];
  boxes: Box[];
  threads: Thread[];
  symbols: Symbol[];
  suggestions: string[];
  last: LastTurn | null;
  base: Base;
  history: HistoryEntry[];
  settings: Settings;
  log: LogState;
}

// What `load` hands back: what was saved, and the text now on disk, which wins.
export interface Loaded extends Stored {
  planText: string;
  boxTexts: Record<string, string>;
}

// The editor's own bookkeeping, which stays on this machine.
const LOCAL = ["state.json", "history.json"];

export type PlanStore = ReturnType<typeof planStore>;

export function planStore(cwd: string, planFile: string) {
  const root = realpathSync(resolve(cwd));
  const planPath = resolve(root, planFile);
  const name = basename(planPath).replace(/\.[^.]+$/, "");
  const shared = join(dirname(planPath), ".underpaint");
  const dir = join(shared, name);
  const boxDir = join(dir, "boxes");
  const rulesPath = join(shared, "rules.md");
  const at = (f: string) => join(dir, f);
  const readJson = (f: string) => (existsSync(at(f)) ? JSON.parse(readFileSync(at(f), "utf8")) : undefined);
  const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").replace(/\n$/, "") : "");
  let historyWritten = "";

  return {
    cwd: root,
    planPath,
    name,
    // Written only by the editor, never the agent's drift.
    ownFiles: [planPath, shared],
    displayPath: relative(root, planPath),

    load(): Loaded {
      mkdirSync(boxDir, { recursive: true });
      // The plan and boxes are shared in git; the editor's bookkeeping stays local.
      const ignore = at(".gitignore");
      const ignored = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
      const have = new Set(ignored.split("\n").map((l) => l.trim()));
      const missing = LOCAL.filter((f) => !have.has(f));
      if (missing.length) writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
      if (!existsSync(rulesPath)) copyFileSync(join(AGENT_DIR, "rules.md"), rulesPath);
      const s = readJson("state.json") ?? {};
      const boxTexts: Record<string, string> = {};
      for (const f of readdirSync(boxDir)) if (f.endsWith(".plan")) boxTexts[f.slice(0, -5)] = readText(join(boxDir, f));
      return {
        turn: s.turn || 1,
        lines: s.lines || [],
        boxes: s.boxes || [],
        threads: readJson("comments.json") ?? [],
        symbols: s.symbols || [],
        suggestions: s.suggestions || [],
        last: s.last || null,
        base: s.base || { lines: [], boxes: {} },
        // Sessions saved before history had its own file kept it in state.json.
        history: readJson("history.json") ?? s.history ?? [],
        settings: { model: "", effort: "", ...s.settings },
        // Older sessions kept the turn log's state at the top level.
        log: s.log ?? { baseCommit: s.baseCommit, dirtyBase: s.dirtyBase },
        planText: readText(planPath),
        boxTexts,
      };
    },

    save({ history, threads, log, ...s }: Stored) {
      mkdirSync(boxDir, { recursive: true });
      writeFileSync(planPath, joinLines(s.lines) + "\n");
      const keep = new Set(s.boxes.map((b) => `${b.name}.plan`));
      for (const f of readdirSync(boxDir)) if (!keep.has(f)) rmSync(join(boxDir, f));
      for (const b of s.boxes) writeFileSync(join(boxDir, `${b.name}.plan`), joinLines(b.lines) + "\n");
      writeFileSync(at("state.json"), JSON.stringify({ ...s, log }, null, 1));
      writeFileSync(at("comments.json"), JSON.stringify(threads, null, 1) + "\n");
      // History only changes with an agent turn or an undo, and it is the biggest file.
      const h = JSON.stringify(history);
      if (h !== historyWritten || !existsSync(at("history.json"))) writeFileSync(at("history.json"), h);
      historyWritten = h;
    },

    rules: () => readFileSync(rulesPath, "utf8"),
  };
}
