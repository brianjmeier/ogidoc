// How a chat agent, or anyone in a terminal, reads a running session. Read-only: turns
// stay between the person in the editor and the plan agent.

import { stops } from "./shared/stops.ts";
import type { Running } from "./registry.ts";
import type { Snapshot } from "./types.ts";

export async function readState(url: string): Promise<Snapshot> {
  const res = await fetch(`${url}/api/state`);
  if (!res.ok) throw new Error(`The session at ${url} answered ${res.status}.`);
  return (await res.json()) as Snapshot;
}

// The session's state once the plan agent's turn is over: at once when it isn't the
// agent's turn, else when the turn ends.
export async function turnOver(url: string): Promise<Snapshot> {
  const res = await fetch(`${url}/api/events`);
  if (!res.ok || !res.body) throw new Error(`The session at ${url} answered ${res.status}.`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The session stopped before the turn ended.");
    buf += value;
    let end;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const event = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const data = event.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      const state: Snapshot | undefined = data ? JSON.parse(data).state : undefined;
      if (state && !state.working) {
        await reader.cancel();
        return state;
      }
    }
  }
}

// What a session's state means, for a person or an agent to read.
export function describe(s: Running, state: Snapshot): string {
  const waiting = stops(state.lines, state.choices, state.threads).length;
  const last = state.last;
  const out = [`Session ${s.name}, in ${s.cwd}, open at ${s.url}`];
  if (state.finished) out.push("The plan was built and removed.");
  else if (state.working) out.push(`The agent is on turn ${state.turn}${state.activity.length ? `: ${state.activity.at(-1)}` : "."}`);
  else out.push(`It's the person's turn (turn ${state.turn}).${waiting ? ` ${waiting} ${waiting === 1 ? "thing waits" : "things wait"} on them.` : ""}`);
  if (last?.error) out.push(`The last turn failed: ${last.error}`);
  else if (last?.summary) out.push(`Last turn: ${last.summary}`);
  if (last?.commit) out.push(`Commit: ${last.commit}`);
  if (state.done) out.push("Everything in the plan is built.");
  return out.join("\n");
}

// The same for a program: the state without the plan's own lines.
export const summary = (s: Running, state: Snapshot) => ({
  name: s.name,
  cwd: s.cwd,
  url: s.url,
  turn: state.turn,
  working: state.working,
  activity: state.activity,
  waiting: stops(state.lines, state.choices, state.threads).length,
  last: state.last,
  done: state.done,
  finished: state.finished,
});
