// What a client of Ogimap's contract is told about the map.

import { diffLines } from "../../src/shared/diff.ts";
import type { FlowMap, MapNode, Status } from "../../src/map.ts";
import type { BoxLine, BoxState, MapView } from "./contract.ts";

const STATE: Record<Status, BoxState> = { built: "built", stale: "to build", proposal: "proposed", blocked: "to build" };

/** A box's pseudocode with the task's plan on it: the lines it adds, and the ones it takes
 *  away (from `was`, what the code does today). A proposed box is all new. */
function linesOf(n: MapNode): BoxLine[] {
  if (n.status === "proposal") return n.pseudo.map((text) => ({ text, mark: "added" }));
  if (!n.was) return n.pseudo.map((text) => ({ text, mark: null }));
  return diffLines(n.was, n.pseudo).flatMap((op): BoxLine[] => {
    if (op.op === "eq") return [{ text: n.pseudo[op.b], mark: null }];
    if (op.op === "del") return [{ text: n.was![op.a], mark: "removed" }];
    if (op.op === "ins") return [{ text: n.pseudo[op.b], mark: "added" }];
    return [{ text: n.was![op.a], mark: "removed" }, { text: n.pseudo[op.b], mark: "added" }];
  });
}

/** The map as a client draws it. Ogimap decides the meaning (each box's state, the plan's
 *  lines, which boxes the task works in); the client only lays it out. */
export function viewOf(map: FlowMap, { focus, drift, standing, failed }: { focus?: string[]; drift: string[]; standing: string; failed: boolean }): MapView {
  const inTask = focus ? new Set(focus) : null;
  const stale = new Set(drift);
  return {
    title: map.title,
    standing,
    failed,
    boxes: map.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      parent: n.parent ?? null,
      kind: n.kind,
      state: stale.has(n.id) ? "code changed" : STATE[n.status ?? "built"],
      lines: linesOf(n),
      ways: n.ways?.length ?? 0,
      inTask: inTask ? inTask.has(n.id) : true,
      described: n.pseudo.length > 0,
      size: n.size ?? null,
      seam: (n.seam ?? []).map(({ name, users }) => ({ name, users })),
      seamSize: n.seamSize ?? 0,
      usedBy: n.usedBy ?? null,
      uses: n.uses ?? null,
      pins: n.pins ?? [],
    })),
    edges: map.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), ...(e.symbols ? { symbols: e.symbols } : {}) })),
    smells: map.smells ?? [],
  };
}

