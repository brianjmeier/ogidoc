import type { MapView, Settings } from "./types.ts";
import type { Agent } from "./agents.ts";
import type { Mark, TurnLog } from "./turn-log.ts";
import { fromDescription, type Plan } from "./plan.ts";
import { parseDescribed } from "./prompt.ts";
import { describeBrief, stamped } from "./map.ts";
import { describePrompt } from "./describe.ts";

// Saying what a box does, outside a turn: the reader reads the code and changes only the
// map. The editor (a person opening a box) and `ogidoc map describe` both come here.

/** The prompt that asks what `id` (null: the top of the map) does. Throws when the map has
 *  nothing there to say anything about. */
export function describeAsk(view: MapView, id: string | null): string {
  const brief = describeBrief(view, id);
  if (!brief.children.length && !brief.box) throw new Error("There is nothing on the map to describe yet.");
  return describePrompt(brief);
}

/** Ask the reader what a box does, and put the answer on the plan's boxes, stamped as true
 *  to the code as it is now. Anything the reader changed in the code since `mark` is put
 *  back; `left` names files the person had already changed, which stay as they are. */
export async function describeBox({ reader, cwd, log, mark, plan, view, id, settings, onActivity, signal }: { reader: Agent; cwd: string; log: TurnLog; mark: Mark; plan: Plan; view: MapView; id: string | null; settings?: Partial<Settings>; onActivity: (a: string) => void; signal?: AbortSignal }): Promise<{ plan: Plan; ids: string[]; summary: string; left: string[] }> {
  const text = await reader.run({ prompt: describeAsk(view, id), cwd, ...settings, onActivity, signal });
  const left = log.discard(mark);
  const d = parseDescribed(text);
  const next = fromDescription(plan, view, id, d);
  const said = next.plan.boxes.filter((b) => next.ids.includes(b.id));
  const hashes = log.hashes([...new Set(said.flatMap((b) => (b.code ?? []).map((c) => c.file)))]);
  const boxes = stamped(next.plan.boxes, next.ids, (f) => hashes.get(f) ?? null);
  return { plan: { ...next.plan, boxes }, ids: next.ids, summary: d.summary || `described ${id ?? "the map"}`, left };
}
