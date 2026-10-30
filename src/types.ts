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

export interface Box {
  name: string;
  lines: Line[];
  status: Status;
  uses: string[];
}

export interface Message {
  by: Who;
  text: string;
  turn: number;
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
}

export interface Reply {
  plan: { text: string; kind: Kind | null; status: Status | null }[];
  boxes: { name: string; lines: string[]; status: Status; uses: string[] }[];
  comments: { line: number; text: string }[];
  replies: { thread: string; text: string; resolve: boolean }[];
  symbols: Symbol[];
  suggestions: string[];
  steps: Step[];
  files: FileChange[];
  checks: Check[];
  summary: string;
}

export type LineChange = { op: "add" | "del"; text: string } | { op: "mod"; old: string; text: string };

export interface HumanDiff {
  lines: LineChange[];
  boxes: { name: string; lines: LineChange[] }[];
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

export interface Choices {
  models: string[];
  efforts: string[];
}

export interface Snapshot {
  name: string;
  planPath: string;
  agent: string;
  choices: Choices;
  settings: Settings;
  turn: number;
  working: boolean;
  activity: string[];
  lines: Line[];
  boxes: Box[];
  threads: Thread[];
  symbols: Symbol[];
  suggestions: string[];
  last: LastTurn | null;
  done: boolean;
  canUndo: boolean;
}
