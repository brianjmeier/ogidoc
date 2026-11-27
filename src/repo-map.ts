import { basename, join } from "node:path";
import { scanRepo, type RepoIO } from "./scan-repo.ts";
import { MAP_FILE, readMap } from "./map-store.ts";
import { driftOf, mapView } from "./map.ts";
import * as plan from "./plan.ts";
import type { MapView } from "./types.ts";

// The repo's map as the editor would open it, read without a session: the scan of the
// code, the boxes said about it in map.json, and the ones whose code changed since.

export interface RepoMap {
  view: MapView;
  // The boxes and arrows map.json holds, as a plan with no lines: what a describe adds to.
  plan: plan.Plan;
  drifted: string[];
}

const NO_PLAN: plan.Plan = { lines: [], boxes: [], edges: [], threads: [], choices: [] };

/** The map of the checkout at `cwd`, or null when there is nothing to map: not a git
 *  checkout with code the scan reads, and nothing said in map.json either. */
export function repoMap(cwd: string, { io, hashes }: { io: RepoIO; hashes: (files: string[]) => Map<string, string | null> }): RepoMap | null {
  const skeleton = scanRepo(basename(cwd), io);
  const saved = plan.fromFiles(NO_PLAN, "", readMap(join(cwd, MAP_FILE)));
  if (!skeleton && !saved.boxes.length) return null;
  const seen = hashes([...new Set(saved.boxes.flatMap((b) => Object.keys(b.seen ?? {})))]);
  return { view: mapView(skeleton, saved.boxes, saved.edges), plan: saved, drifted: driftOf(saved.boxes, (f) => seen.get(f) ?? null) };
}
