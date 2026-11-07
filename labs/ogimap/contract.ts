// What Ogimap promises a client that drives it over HTTP, such as a Tend station that
// draws the map on its own surface. Ogimap decides what the map means: each box's
// state, which lines a task's plan adds or takes away, what an edit does. A client only
// lays it out and reports what the person did. Change this shape and OGIMAP_API goes up.

export const OGIMAP_API = 1;

/** A box's state, in the words a person reads. */
export type BoxState = "built" | "to build" | "proposed" | "code changed";

/** One line of a box's pseudocode: one the task's plan adds, one it takes away, or neither. */
export interface BoxLine {
  text: string;
  mark: "added" | "removed" | null;
}

export interface BoxView {
  id: string;
  name: string;
  /** The box that holds this one, or null at the top. */
  parent: string | null;
  kind: string;
  state: BoxState;
  lines: BoxLine[];
  /** How many other ways the agent offers for this box. */
  ways: number;
  /** Whether the task works in this box (every box when there is no task). */
  inTask: boolean;
}

export interface MapView {
  title: string;
  /** Where things stand, in one line: whose pen it is, or what went wrong. */
  standing: string;
  failed: boolean;
  boxes: BoxView[];
  edges: { from: string; to: string; label?: string }[];
}

/** What a person did to the map, as a client reports it. A box added in the same hand
 *  over is named by its `key` in later edits; Ogimap gives it its id. */
export type Edit =
  | { op: "pseudo"; id: string; lines: string[] }
  | { op: "rename"; id: string; name: string }
  | { op: "remove"; id: string }
  | { op: "add"; key: string; name: string; parent: string | null; lines: string[] }
  | { op: "connect"; from: string; to: string; label?: string }
  | { op: "disconnect"; from: string; to: string };

/** `GET /api/state`, the part a client relies on. */
export interface State {
  api: typeof OGIMAP_API;
  busy: string | null;
  view: MapView | null;
  task: { phase: string; title?: string; prompt: string } | null;
  last: { summary: string; error?: string } | null;
}

/** `POST /api/turn`: the person's edits, which end their turn. */
export interface TurnRequest {
  edits: Edit[];
}
