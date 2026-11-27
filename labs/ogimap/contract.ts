// What Ogimap promises a client that drives it over HTTP, such as a Tend station that
// draws the map on its own surface. Ogimap decides what the map means: each box's
// state, which lines a task's plan adds or takes away, what an edit does. A client only
// lays it out and reports what the person did. Change this shape and OGIMAP_API goes up.
//
// 2: the map starts from a scan of the code: boxes carry their size, seam and who uses
//    them; import arrows carry their names; the view lists the tangles the scan sees.

export const OGIMAP_API = 2;

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
  /** Whether an agent has said what it does yet; a scanned box starts without pseudocode. */
  described: boolean;
  /** Lines of code under it; null for a box the scan doesn't know (a function, a plan). */
  size: number | null;
  /** Its seam: the names code outside it imports from it, the most used first, cut short. */
  seam: { name: string; users: number }[];
  /** How many names the whole seam has. */
  seamSize: number;
  /** How many boxes beside it import it, and how many it imports. */
  usedBy: number | null;
  uses: number | null;
  /** Tangles an agent found reading it, each with where. */
  pins: { kind: string; text: string; file?: string; line?: number }[];
}

import type { Smell as SmellView } from "../../src/scan.ts";
export type { SmellView };

export interface MapView {
  title: string;
  /** Where things stand, in one line: whose pen it is, or what went wrong. */
  standing: string;
  failed: boolean;
  boxes: BoxView[];
  /** An import arrow carries the names it imports. */
  edges: { from: string; to: string; label?: string; symbols?: string[] }[];
  smells: SmellView[];
}

import type { Edit } from "../../src/types.ts";
export type { Edit };

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
