import { createSignal } from "solid-js";
import { post, state } from "./api.ts";
import type { Thread } from "../src/types.ts";

// Which thread card is open, a new thread being written, and replies not sent yet.
// A draft is keyed by thread id, or "new" for a new thread.
export const [openId, setOpenId] = createSignal<string | null>(null);
export const [draftLine, setDraftLine] = createSignal<number | null>(null);
const [drafts, setDrafts] = createSignal<Record<string, string>>({});

export const draft = (key: string) => drafts()[key] ?? "";
export const setDraft = (key: string, text: string) => setDrafts((d) => ({ ...d, [key]: text }));

// A thread is waiting on the person when the agent spoke last.
export const waitingOnYou = (t: Thread) => !t.resolved && t.messages.at(-1)?.by === "a";

export function startThread(line: number) {
  setDraftLine(line);
  setOpenId("new");
}

export function close() {
  setOpenId(null);
  setDraftLine(null);
}

// Messages sent but not back from the server yet, shown right away as sending. `after`
// is how many messages the thread has once this one lands, so the card stops showing
// the pending copy as soon as the server's copy is there.
export interface Pending { text: string; after: number }
const [pendings, setPendings] = createSignal<Record<string, Pending[]>>({});

export const pending = (key: string, thread?: Thread) => (pendings()[key] ?? []).filter((m) => (thread?.messages.length ?? 0) < m.after);

export async function send(key: string, thread?: Thread) {
  const text = draft(key).trim();
  if (!text) return;
  const line = draftLine();
  const mine: Pending = { text, after: (thread?.messages.length ?? 0) + pending(key, thread).length + 1 };
  setPendings((p) => ({ ...p, [key]: [...pending(key, thread), mine] }));
  setDraft(key, "");
  const r = key === "new" ? await post("/api/comment", { line, text }) : await post("/api/reply", { thread: key, text });
  if (r.error || key === "new") setPendings((p) => ({ ...p, [key]: (p[key] ?? []).filter((m) => m !== mine) }));
  if (r.error) setDraft(key, draft(key) ? `${text}\n${draft(key)}` : text);
  else if (key === "new") close();
}

export async function resolve(id: string) {
  const r = await post("/api/resolve", { thread: id });
  if (!r.error) close();
}

// Whatever the person typed in a card goes with the hand-over.
export async function sendAll() {
  for (const key of Object.keys(drafts())) if (draft(key).trim()) await send(key, state()?.threads.find((t) => t.id === key));
}
