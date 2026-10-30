import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { AnimationOp, BoxChanges, Snapshot } from "../src/types.ts";

// The session as the server last sent it, plus the one message the editor shows when
// something went wrong outside a turn (a refused request, a lost connection).
// Each update is reconciled into one store, so a line, box, thread or list that didn't
// change keeps its identity and nothing on screen re-renders or closes because of it.
const [store, setStore] = createStore<{ s: Snapshot | null }>({ s: null });
export const state = () => store.s;
export const [notice, setNotice] = createSignal("");

export async function post<T = { ok: boolean }>(path: string, body?: unknown): Promise<T & { error?: string }> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  setNotice(r.ok ? "" : data.error || `Request failed (${r.status})`);
  return data;
}

// `next` is the plain snapshot as sent; `prev` is what the turn looked like before it.
type Prev = Pick<Snapshot, "turn" | "working">;

// An agent turn that changed the plan also says how, for the browser to animate.
export interface TurnChanges {
  animation: AnimationOp[];
  boxChanges: BoxChanges;
}

export function listen(onEvent: (next: Snapshot, prev: Prev | null, turn?: TurnChanges) => void) {
  const events = new EventSource("/api/events");
  events.onmessage = (e) => {
    const { state: next, animation, boxChanges } = JSON.parse(e.data);
    const prev = store.s && { turn: store.s.turn, working: store.s.working };
    setStore("s", reconcile(structuredClone(next), { key: "id" }));
    onEvent(next, prev, animation && { animation, boxChanges: boxChanges ?? {} });
  };
  events.onerror = () => setNotice("Lost the connection to the Ogidoc server. Is it still running?");
  events.onopen = () => setNotice("");
  return () => events.close();
}
