import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Button } from "@kobalte/core/button";
import type { Snapshot } from "../src/types.ts";
import { listen, notice, post, state, type TurnChanges } from "./api.ts";
import { Boxes, type BoxAnimation, type BoxesApi } from "./Boxes.tsx";
import { Editor, type EditorApi } from "./Editor.tsx";
import { TopBar } from "./TopBar.tsx";
import { Underneath } from "./Underneath.tsx";
import { sendAll, setOpenId, waitingOnYou } from "./threads.ts";
import { isPassKey } from "./text.ts";

export function App() {
  let editor!: EditorApi;
  let boxes: BoxesApi | undefined;
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  const [writing, setWriting] = createSignal(false);
  const [passing, setPassing] = createSignal(false);
  const [boxAnim, setBoxAnim] = createSignal<BoxAnimation | null>(null);
  const [hint, setHint] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const [workStart, setWorkStart] = createSignal(0);

  const editable = () => !!state() && !state()!.working && !writing();

  function sendEdit() {
    clearTimeout(editTimer);
    editTimer = undefined;
    return post("/api/edit", { text: editor.text(), accepted: editor.takeAccepted() });
  }

  async function pass() {
    const s = state();
    if (!s || s.working) return;
    await sendAll();
    clearTimeout(editTimer);
    setPassing(true);
    setTimeout(() => setPassing(false), 500);
    // Everything not sent yet goes with the pen in one request.
    await post("/api/pass", { text: editor.text(), accepted: editor.takeAccepted(), boxes: boxes?.take() });
  }

  async function onEvent(next: Snapshot, prev: Pick<Snapshot, "turn" | "working"> | null, turn?: TurnChanges) {
    document.title = `${next.name} · Underpaint`;
    const turnChanged = !prev || prev.turn !== next.turn;
    const agentFinished = !!prev && prev.working && !next.working;
    if (turn) {
      const { animation, boxChanges } = turn;
      const oldLines = editor.lines();
      const pulse: Record<string, number> = {};
      animation.filter((o) => o.op === "move").forEach((m, i) => { pulse[(m as { to: string }).to] ??= 500 + i * 40; });
      setBoxAnim({ delay: 250, pulse, changes: boxChanges });
      setWriting(true);
      await editor.animate(animation, oldLines, next);
      setWriting(false);
      setBoxAnim(null);
      editor.focus();
    } else if (!prev || (!next.working && (turnChanged || agentFinished))) {
      // During the person's turn the browser owns the text; only adopt the server's copy
      // when the turn moved (an undo) or an agent turn ended without changes (an error).
      editor.adopt(next);
    }
    // A question from the agent opens by itself when the pen comes back.
    if (agentFinished && !next.last?.error) {
      const first = next.threads.find(waitingOnYou);
      if (first) setOpenId(first.id);
    }
  }

  onCleanup(listen(onEvent));

  document.addEventListener("keydown", (e) => {
    if (isPassKey(e) && !(e.target as HTMLElement).closest("textarea")) {
      e.preventDefault();
      pass();
    }
  });

  // The clock for "working 12s".
  createEffect(() => {
    if (!state()?.working) { setWorkStart(0); return; }
    if (!workStart()) setWorkStart(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });

  const pen = () => {
    const s = state()!;
    if (writing()) return { cls: "a", label: "agent's pen · writing" };
    if (s.working) return { cls: "a", label: `agent's pen · working ${Math.max(0, Math.round((now() - workStart()) / 1000))}s` };
    if (s.done && !editor.lines().some((l) => l.chg && l.by === "h")) return { cls: "done", label: "done · every line built" };
    const waiting = s.threads.filter(waitingOnYou).length;
    return { cls: "h", label: `your pen${waiting ? ` · ${waiting} comment${waiting > 1 ? "s" : ""} waiting on you` : ""}` };
  };

  return (
    <Show when={state()}>
      {(s) => (
        <>
          <TopBar state={s()} pen={pen()} passing={passing()} onPass={pass} />
          <main class="panes" classList={{ solo: !s().boxes.length }}>
            <section class="pane text-pane" aria-label="Plan">
              <div class="editor">
                <Editor
                  ref={(api) => (editor = api)}
                  editable={editable()}
                  working={s().working}
                  threads={s().threads}
                  onEdit={() => { clearTimeout(editTimer); editTimer = setTimeout(sendEdit, 400); }}
                  onPass={pass}
                  onHint={setHint}
                />
                <StatusCard state={s()} />
              </div>
              <Show when={hint()}>
                <div class="statusbar">{hint()}</div>
              </Show>
              <Underneath last={s().last} />
            </section>
            <Show when={s().boxes.length}>
              <section class="pane box-pane" aria-label="Boxes">
                <div class="pane-label">Boxes</div>
                <Boxes
                  ref={(api) => (boxes = api)}
                  boxes={s().boxes}
                  symbols={s().symbols}
                  editable={editable()}
                  animate={boxAnim()}
                  onEdit={(name, text) => post("/api/edit", { boxes: { [name]: text } })}
                  onPass={pass}
                />
              </section>
            </Show>
          </main>
        </>
      )}
    </Show>
  );
}

// One card inside the editor carries what the agent is doing, or why something failed.
function StatusCard(props: { state: Snapshot }) {
  const failed = () =>
    notice() || (!props.state.working && props.state.last?.error ? `The agent's turn failed: ${props.state.last.error}\nThe pen is back with you.` : "");
  const items = () => (props.state.activity.length ? props.state.activity : ["reading the plan"]).slice(-4);
  return (
    <Show when={failed() || props.state.working}>
      <div class="activity" classList={{ failed: !!failed() }}>
        <Show when={failed()} fallback={<For each={items()}>{(a, i) => <div classList={{ now: i() === items().length - 1 }}>{a}</div>}</For>}>
          {failed()}
          <Show when={props.state.canUndo && !notice()}>
            <Button class="btn" onClick={() => post("/api/undo")}>Undo agent turn</Button>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
