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
  // names (`parent`, `uses`, `code`) stays as the map has it.
  boxes: { id: string; name: string; parent?: string | null; lines: string[]; status: Status; uses?: string[]; code?: CodeRef[] }[];
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
