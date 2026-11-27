import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { joinLines } from "./shared/diff.ts";
import { AGENT_DIR } from "./paths.ts";
import type { LogState } from "./turn-log.ts";
import type { Base } from "./plan.ts";
import type { Box, BoxEdge, Choice, LastTurn, Line, MapOnDisk, Settings, Symbol, Thread } from "./types.ts";
import { mapStore } from "./map-store.ts";

// Where a plan lives on disk and how it is saved. Everything stays plain text beside the
// code: the plan file itself, the repo's map of boxes every session shares, comment
// threads in comments.json, and the editor's local bookkeeping (what it knows about each
// line, undo history), which git ignores.
//
//   weekly.plan
//   .ogidoc/rules.md               the house rules the agent reads every turn
//   .ogidoc/map.json               the boxes, shared by every session
//   .ogidoc/weekly/comments.json
//   .ogidoc/weekly/state.json      local
//   .ogidoc/weekly/history.json    local

// Everything a session remembers.
export interface SessionState {
  turn: number;
  lines: Line[];
  boxes: Box[];
  edges: BoxEdge[];
  threads: Thread[];
  choices: Choice[];
  symbols: Symbol[];
  suggestions: string[];
  last: LastTurn | null;
  base: Base;
  history: HistoryEntry[];
  settings: Settings;
}

// What an agent turn can take back: everything but the undo history and the settings.
export type TurnState = Omit<SessionState, "history" | "settings">;

export interface HistoryEntry extends TurnState {
  commit: string | null;
}

// What `load` hands back: what was saved, and the text now on disk, which wins.
export interface Loaded {
  state: SessionState;
  log: LogState;
  planText: string;
  map: MapOnDisk;
}

// The editor's own bookkeeping, which stays on this machine.
const LOCAL = ["state.json", "history.json"];

export type PlanStore = ReturnType<typeof planStore>;

// The sessions started in a directory: one folder each under .ogidoc/.
export function sessionsIn(cwd: string): string[] {
  const shared = join(cwd, ".ogidoc");
  if (!existsSync(shared)) return [];
  return readdirSync(shared, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

// A session is a name; its plan is `<name>.plan` in the directory it was started in.
export function planStore(cwd: string, name: string) {
  const root = realpathSync(resolve(cwd));
  const planPath = join(root, `${name}.plan`);
  const shared = join(root, ".ogidoc");
  const dir = join(shared, name);
  // Sessions saved before the repo had one map kept their boxes here.
  const boxDir = join(dir, "boxes");
  const map = mapStore(root);
  const rulesPath = join(shared, "rules.md");
  const at = (f: string) => join(dir, f);
  const readJson = (f: string) => (existsSync(at(f)) ? JSON.parse(readFileSync(at(f), "utf8")) : undefined);
  const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").replace(/\n$/, "") : "");
  // What was written last, to skip writing it again: the map's boxes and arrows, and the
  // history, by identity (every change makes new ones), then the history as text.
  let mapSaved: { boxes: Box[]; edges: BoxEdge[] } | null = null;
  let historySaved: HistoryEntry[] | null = null;
  let historyWritten = "";

  return {
    cwd: root,
    planPath,
    name,
    // Written only by the editor, never the agent's drift.
    ownFiles: [planPath, shared, join(root, ".gitattributes")],
    displayPath: relative(root, planPath),

    load(): Loaded {
      mkdirSync(dir, { recursive: true });
      // The plan and boxes are shared in git; the editor's bookkeeping stays local.
      const ignore = at(".gitignore");
      const ignored = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
      const have = new Set(ignored.split("\n").map((l) => l.trim()));
      const missing = LOCAL.filter((f) => !have.has(f));
      if (missing.length) writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
      if (!existsSync(rulesPath)) copyFileSync(join(AGENT_DIR, "rules.md"), rulesPath);
      const s = readJson("state.json") ?? {};
      const onDisk = map.load();
      const saved: Box[] = (s.boxes || []).map(({ uses, ...b }: Box & { uses?: string[] }) => ({ ...b, id: b.id ?? b.name, parent: b.parent ?? null }));
      if (existsSync(boxDir)) migrate(onDisk, boxDir, saved, s.boxes || [], readText);
      const state: SessionState = {
        turn: s.turn || 1,
        lines: s.lines || [],
        boxes: saved,
        edges: onDisk.edges,
        threads: readJson("comments.json") ?? [],
        choices: s.choices || [],
        symbols: s.symbols || [],
        suggestions: s.suggestions || [],
        last: s.last || null,
        base: s.base || { lines: [], boxes: {} },
        // Sessions saved before history had its own file kept it in state.json, and turns
        // saved before choices existed had none.
        history: (readJson("history.json") ?? s.history ?? []).map((h: Omit<HistoryEntry, "choices"> & Partial<HistoryEntry>) => ({ ...h, choices: h.choices ?? [] })),
        settings: { model: "", effort: "", ...s.settings },
      };
      return {
        state,
        // Older sessions kept the turn log's state at the top level.
        log: s.log ?? { baseCommit: s.baseCommit, dirtyBase: s.dirtyBase },
        planText: readText(planPath),
        map: onDisk,
      };
    },

    save({ history, threads, edges, ...s }: SessionState, log: LogState) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(planPath, joinLines(s.lines) + "\n");
      if (mapSaved?.boxes !== s.boxes || mapSaved.edges !== edges || !existsSync(map.path)) {
        map.save(s.boxes, edges);
        mapSaved = { boxes: s.boxes, edges };
      }
      rmSync(boxDir, { recursive: true, force: true });
      writeFileSync(at("state.json"), JSON.stringify({ ...s, log }, null, 1));
      writeFileSync(at("comments.json"), JSON.stringify(threads, null, 1) + "\n");
      // History only changes with an agent turn or an undo, and it is the biggest file.
      if (history !== historySaved || !existsSync(at("history.json"))) {
        const h = JSON.stringify(history);
        if (h !== historyWritten || !existsSync(at("history.json"))) writeFileSync(at("history.json"), h);
        historyWritten = h;
        historySaved = history;
      }
    },

    rules: () => readFileSync(rulesPath, "utf8"),

    // The plan file and everything the editor kept for it. The house rules stay, for the
    // next plan.
    remove() {
      rmSync(planPath, { force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Boxes from a session's own box files join the repo's map, as the agent made them: at
// the top, named by their name, calling the boxes they used.
function migrate(map: MapOnDisk, boxDir: string, saved: Box[], old: { name: string; uses?: string[] }[], readText: (p: string) => string) {
  const have = new Set(map.boxes.map((b) => b.id));
  for (const f of readdirSync(boxDir)) {
    const id = f.slice(0, -".plan".length);
    if (!f.endsWith(".plan") || have.has(id)) continue;
    map.boxes.push({ id, name: id, parent: null, text: readText(join(boxDir, f)), status: saved.find((b) => b.id === id)?.status ?? "stale" });
    have.add(id);
  }
  for (const b of old) for (const to of b.uses ?? []) if (have.has(b.name) && have.has(to)) map.edges.push({ from: b.name, to, kind: "call" });
}
