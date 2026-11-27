// The shapes the server and the browser share.

export type Who = "h" | "a";
export type Kind = "proposal" | "example";
export type Status = "built" | "stale" | "blocked";

export interface Line {
  text: string;
  by?: Who;
  kind?: Kind | null;
  status?: Status | null;
  chg?: boolean;
}

// Where a box lives in the code, so the person can open it and the editor can tell when
// the code under it changed.
export interface CodeRef {
  file: string;
  line?: number;
  symbol?: string;
}

/** A box as the map file keeps it: its lines as text. */
export interface BoxOnDisk {
  id: string;
  name: string;
  parent: string | null;
  text: string;
  status: Status;
  code?: CodeRef[];
  seen?: Record<string, string>;
  pins?: Pin[];
}

// The repo's map as the map file keeps it.
export interface MapOnDisk {
  boxes: BoxOnDisk[];
  edges: BoxEdge[];
}

// A tangle an agent found reading a box's code, with where.
export interface Pin {
  kind: string;
  text: string;
  file?: string;
  line?: number;
}

// An abstraction on the repo's map. Boxes nest: a box's children are what you see when
// you open it.
export interface Box {
  id: string;
  name: string;
  parent: string | null;
  lines: Line[];
  status: Status;
  code?: CodeRef[];
  // The git blob hash of each file in `code` when the box last said what it does.
  seen?: Record<string, string>;
  pins?: Pin[];
  // What the scan of the code reads under the box. Never kept in the map file: the next
  // scan finds it again.
  scan?: BoxScan;
}

export interface BoxScan {
  kind: "module" | "file" | "external";
  // Lines of code under it, tests left out.
  size: number;
  files: number;
  tests: number;
  // The names code outside it imports from it, the most used first, cut short; and how
  // many the whole seam has.
  seam: { name: string; file: string; users: number }[];
  seamSize: number;
  // How many boxes beside it import it, and how many it imports.
  usedBy: number;
  uses: number;
}

// A tangle the scan sees without an agent (after caldoai's untangle-codebase). A pair is
// two boxes side by side, so it shows on the level that holds both.
//  - `volatile import`: `a`, which other code imports, imports `b`, which changes much more often;
//  - `change together`: git changes `a` and `b` in the same commits, with no import between them;
//  - `unused`: `a` exports names and nothing in the code imports it (an entry point
//    loaded by convention reads the same; the box says what is true, not that it's dead);
//  - `pass-through`: `a` only re-exports what other files define;
//  - `cycle`: boxes side by side that import each other round in a loop.
export type Smell =
  | { kind: "volatile import" | "change together"; a: string; b: string; count: number }
  | { kind: "cycle"; ids: string[] }
  | { kind: "unused" | "pass-through"; a: string };

// The whole map as the person sees it: the scan of the code with every box on it.
export interface MapView {
  title: string;
  boxes: Box[];
  edges: BoxEdge[];
  smells: Smell[];
}

// One box calling another, or importing from it.
export interface BoxEdge {
  from: string;
  to: string;
  label?: string;
  kind: "call" | "import";
  symbols?: string[];
}

export interface Message {
  by: Who;
  text: string;
  turn: number;
}

// Other ways to do one thing the agent built: the plan holds the current option's lines
// from `line` on, and every option keeps its own lines. Option 0 is the agent's pick.
export interface Choice {
  id: string;
  line: number;
  current: number;
  options: Line[][];
}

// A conversation pinned to one plan line. `line` is an index into the plan.
export interface Thread {
  id: string;
  line: number;
  by: Who;
  resolved: boolean;
  resolvedBy?: Who;
  // Whether the agent has seen that the person resolved it.
  seen?: boolean;
  messages: Message[];
}

export interface Symbol {
  name: string;
  where: string;
}

export interface Step {
  kind: string;
  what: string;
}

export interface FileChange {
  op: string;
  path: string;
  why: string;
}

export interface Check {
  name: string;
  ok: boolean;
}

export interface LastTurn {
  summary?: string;
  steps?: Step[];
  files?: FileChange[];
  checks?: Check[];
  seconds?: number;
  error?: string;
  // The commit the turn made, if it made one.
  commit?: string | null;
}

export interface Reply {
  plan: { text: string; kind: Kind | null; status: Status | null }[];
  // Only the boxes the agent made or changed this turn. What it leaves out of a box it
  // names (`name`, `parent`, `uses`, `code`) stays as the map has it.
  boxes: { id: string; name?: string; parent?: string | null; lines: string[]; status: Status; uses?: string[]; code?: CodeRef[] }[];
  // Boxes the agent took off the map.
  removed: string[];
  choices: { id?: string; line: number; options: string[][] }[];
  replies: { thread: string; text: string; resolve: boolean }[];
  symbols: Symbol[];
  suggestions: string[];
  steps: Step[];
  files: FileChange[];
  checks: Check[];
  summary: string;
}

export type LineChange = { op: "add" | "del"; text: string } | { op: "mod"; old: string; text: string };

// What the person did to the map itself: boxes and arrows, apart from what boxes say.
export type MapChange =
  | { op: "add"; id: string; name: string; parent: string | null }
  | { op: "del"; id: string; name: string }
  | { op: "forget"; id: string }
  | { op: "rename"; id: string; old: string; name: string }
  | { op: "move"; id: string; parent: string | null }
  | { op: "connect" | "disconnect"; from: string; to: string; label?: string };

export interface HumanDiff {
  lines: LineChange[];
  boxes: { id: string; name: string; lines: LineChange[] }[];
  map: MapChange[];
}

// How the browser replays an agent turn, in display order.
export type AnimationOp =
  | { op: "keep"; a: number; b: number }
  | { op: "add"; b: number }
  | { op: "mod"; b: number; old: string }
  | { op: "del"; text: string }
  | { op: "move"; text: string; to: string };

// Which boxes an agent turn added or changed, for the browser to animate.
export type BoxChanges = Record<string, "new" | "changed">;

export interface Settings {
  model: string;
  effort: string;
}

export interface SettingOptions {
  models: string[];
  efforts: string[];
}

export interface Snapshot {
  name: string;
  planPath: string;
  agent: string;
  settingOptions: SettingOptions;
  settings: Settings;
  turn: number;
  working: boolean;
  activity: string[];
  lines: Line[];
  boxes: Box[];
  edges: BoxEdge[];
  threads: Thread[];
  choices: Choice[];
  symbols: Symbol[];
  suggestions: string[];
  last: LastTurn | null;
  done: boolean;
  // The plan was done and the person removed it.
  finished: boolean;
  canUndo: boolean;
  // Boxes whose code changed since they last said what it does.
  drifted: string[];
  // Goes up when the map changes: fetch \`GET /api/map\` again.
  mapRev: number;
  // The box being described while one is (\`id\` null for the top of the map), and how the
  // last describe went.
  describing: { id: string | null } | null;
  described: { id: string | null; summary?: string; error?: string } | null;
}

/** What a person did to the map. A box added in the same hand-over is named by its
 *  `key` in later edits; the editor gives it its id. */
export type Edit =
  | { op: "pseudo"; id: string; lines: string[] }
  | { op: "rename"; id: string; name: string }
  | { op: "remove"; id: string }
  | { op: "add"; key: string; name: string; parent: string | null; lines: string[] }
  | { op: "connect"; from: string; to: string; label?: string }
  | { op: "disconnect"; from: string; to: string };
