import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Button } from "@kobalte/core/button";
import type { Edit, MapView, Snapshot } from "../src/types.ts";
import { listen, notice, post, state, type TurnChanges } from "./api.ts";
import { Boxes, type BoxAnimation, type BoxesApi } from "./Boxes.tsx";
import { Editor, type EditorApi } from "./Editor.tsx";
import { confirmed } from "./confirm.ts";
import { TopBar } from "./TopBar.tsx";
import { Underneath } from "./Underneath.tsx";
import { sendAll, setOpenId } from "./threads.ts";
import { keys } from "./text.ts";
import { waitingOnYou } from "../src/shared/stops.ts";
import { splitLines } from "../src/shared/diff.ts";

export function App() {
  // The top bar renders before the editor exists.
  const [editor, setEditor] = createSignal<EditorApi>();
  let boxes: BoxesApi | undefined;
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  const [writing, setWriting] = createSignal(false);
  const [passing, setPassing] = createSignal(false);
  const [boxAnim, setBoxAnim] = createSignal<BoxAnimation | null>(null);
  const [hint, setHint] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const [workStart, setWorkStart] = createSignal(0);

  // The whole map, fetched when the server says it changed; reconciled so a box that
  // didn't change keeps its identity and an open box editor stays open.
  const [map, setMap] = createStore<{ m: MapView | null }>({ m: null });
  let mapAsked = 0;
  createEffect(on(() => state()?.mapRev, (rev) => {
    if (rev === undefined) return;
    const ask = ++mapAsked;
    fetch("/api/map").then((r) => r.json()).then((m: MapView) => {
      if (ask === mapAsked) setMap("m", reconcile(m, { key: "id" }));
    }, () => {});
  }));
  const owned = (id: string) => !!state()?.boxes.some((b) => b.id === id);
  // A box only the scan knows joins the plan through a map edit.
  const editMap = (edits: Edit[]) => post("/api/map", { edits });
  const editBox = (id: string, text: string) => (owned(id) ? post("/api/edit", { boxes: { [id]: text } }) : editMap([{ op: "pseudo", id, lines: splitLines(text) }]));

  const editable = () => !!state() && !state()!.working && !writing();
  const live = () => editable() && !!editor();
  const undo = confirmed(() => post("/api/undo"));

  function sendEdit() {
    clearTimeout(editTimer);
    editTimer = undefined;
    return post("/api/edit", { text: editor()!.text(), accepted: editor()!.takeAccepted() });
  }

  // An edit still waiting to be sent goes first, as it was before the switch, so the
  // server acts on the same lines the person saw.
  async function onChoice(path: string, body: object, before: string) {
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = undefined;
      await post("/api/edit", { text: before, accepted: editor()!.takeAccepted() });
    }
    await post(path, body);
  }

  async function pass() {
    const s = state();
    if (!s || s.working) return;
    await sendAll();
    clearTimeout(editTimer);
    setPassing(true);
    setTimeout(() => setPassing(false), 500);
    // Everything not sent yet goes with the hand-over in one request, but a box only the
    // scan knows has to join the plan first.
    const open = boxes?.take();
    const [id, text] = Object.entries(open ?? {})[0] ?? [];
    if (id && !owned(id)) await editBox(id, text);
    await post("/api/pass", { text: editor()!.text(), accepted: editor()!.takeAccepted(), boxes: id && owned(id) ? open : undefined });
  }

  async function onEvent(next: Snapshot, prev: Pick<Snapshot, "turn" | "working"> | null, turn?: TurnChanges) {
    document.title = `${next.name} · ogidoc`;
    const turnChanged = !prev || prev.turn !== next.turn;
    const agentFinished = !!prev && prev.working && !next.working;
    if (turn) {
      const { animation, boxChanges } = turn;
      const oldLines = editor()!.lines();
      const pulse: Record<string, number> = {};
      animation.filter((o) => o.op === "move").forEach((m, i) => { pulse[(m as { to: string }).to] ??= 500 + i * 40; });
      setBoxAnim({ delay: 250, pulse, changes: boxChanges });
      setWriting(true);
      await editor()!.animate(animation, oldLines, next);
      setWriting(false);
      setBoxAnim(null);
      editor()!.focus();
    } else if (!prev || (!next.working && (turnChanged || agentFinished))) {
      // During the person's turn the browser owns the text; only adopt the server's copy
      // when the turn moved (an undo) or an agent turn ended without changes (an error).
      editor()!.adopt(next);
    }
    // The agent's answer in a thread it left open shows by itself when the turn comes back.
    if (agentFinished && !next.last?.error) {
      const first = next.threads.find(waitingOnYou);
      if (first) setOpenId(first.id);
    }
    // Whatever just closed or went away (a card, a button, the agent's turn), typing goes
    // back to the plan.
    editor()!.focusIfIdle();
  }

  onCleanup(listen(onEvent));

  document.addEventListener("keydown", (e) => {
    if (keys.pass.is(e) && !(e.target as HTMLElement).closest("textarea")) {
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

  const whoseTurn = () => {
    const s = state()!;
    if (writing()) return { cls: "a", label: "agent's turn · writing" };
    if (s.working) return { cls: "a", label: "agent's turn · working", seconds: Math.max(0, Math.round((now() - workStart()) / 1000)) };
    if (s.done && !editor()?.lines().some((l) => l.chg && l.by === "h")) return { cls: "done", label: "done · every line built" };
    const waiting = s.threads.filter(waitingOnYou).length;
    return { cls: "h", label: `your turn${waiting ? ` · ${waiting} comment${waiting > 1 ? "s" : ""} waiting on you` : ""}` };
  };


  return (
    <Show when={state()}>
      {(s) => (
        <Show when={!s().finished} fallback={<Finished state={s()} />}>
          {/* Turn changes, said once to a screen reader; the seconds counting up are left out. */}
          <div class="sr-only" role="status">{whoseTurn().label}</div>
          <TopBar state={s()} turn={whoseTurn()} passing={passing()} onPass={pass} undo={undo} undoKey={live() && editor()!.fresh()} onNext={live() && editor()!.hasStops() ? () => editor()!.jump(1) : undefined} />
          <main class="panes" classList={{ solo: !map.m?.boxes.length }}>
            <section class="pane text-pane" aria-label="Plan">
              <div class="editor">
                <Editor
                  ref={setEditor}
                  editable={editable()}
                  working={s().working}
                  threads={s().threads}
                  onEdit={() => { clearTimeout(editTimer); editTimer = setTimeout(sendEdit, 400); }}
                  onChoose={(choice, option, before) => onChoice("/api/choose", { choice, option }, before)}
                  onSettle={(choice, before) => onChoice("/api/settle", { choice }, before)}
                  onPass={pass}
                  onHint={setHint}
                  onUndo={() => s().canUndo && undo.click()}
                  nameOf={(id) => map.m?.boxes.find((b) => b.id === id)?.name ?? id}
                />
                <StatusCard state={s()} />
              </div>
              <Show when={hint()}>
                <div class="statusbar">{hint()}</div>
              </Show>
              <Underneath last={s().last} />
            </section>
            <Show when={map.m?.boxes.length ? map.m : null}>
              {(m) => (
                <section class="pane box-pane" aria-label="Map">
                  <div class="pane-label">Map</div>
                  <Boxes
                    ref={(api) => (boxes = api)}
                    title={m().title}
                    boxes={m().boxes}
                    edges={m().edges}
                    smells={m().smells}
                    drifted={s().drifted}
                    symbols={s().symbols}
                    editable={editable()}
                    busy={s().working}
                    describing={s().describing}
                    animate={boxAnim()}
                    onEdit={editBox}
                    onPass={pass}
                    onMapEdit={editMap}
                    onDescribe={(id) => post("/api/describe", { id })}
                    onFix={(line) => editor()!.append(line)}
                  />
                  <Show when={!s().working && s().described?.error}>
                    <div class="map-error" role="alert">Couldn't say what {s().described!.id ?? "the map"} does: {s().described!.error}</div>
                  </Show>
                </section>
              )}
            </Show>
          </main>
        </Show>
      )}
    </Show>
  );
}

// What's left once the person removed the built plan: the code, in their repository.
function Finished(props: { state: Snapshot }) {
  return (
    <main class="finished">
      <span class="brand">ogidoc</span>
      <p>{props.state.name} was built and is removed. The code it built stays in your repository.</p>
      <p class="muted">You can close this tab.</p>
    </main>
  );
}

// One card inside the editor carries what the agent is doing, or why something failed.
function StatusCard(props: { state: Snapshot }) {
  const failed = () =>
    notice() || (!props.state.working && props.state.last?.error ? `The agent's turn failed: ${props.state.last.error}\nIt's your turn again.` : "");
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
