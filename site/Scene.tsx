import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Boxes, type BoxAnimation } from "../app/Boxes.tsx";
import { Editor, type EditorApi } from "../app/Editor.tsx";
import { Underneath } from "../app/Underneath.tsx";
import type { Box, LastTurn } from "../src/types.ts";
import type { Plan } from "../src/plan.ts";
import type { Frame } from "./scenes.ts";

const KEY_MS = 45;
const BEFORE_PASS_MS = 700;
const HOLD_MS = 2600;

// One looping scene: the real editor, read-only, playing a scripted session while it
// is on screen. It pauses when scrolled away and picks up where it was.
export function Scene(props: { start: Plan; frames: Frame[]; label: string }) {
  let el!: HTMLDivElement;
  let editor!: EditorApi;
  const [whose, setWhose] = createSignal<"h" | "a">("h");
  const [last, setLast] = createSignal<LastTurn | null>(null);
  const [boxes, setBoxes] = createSignal<Box[]>([]);
  const [boxAnim, setBoxAnim] = createSignal<BoxAnimation | null>(null);
  // Tall enough for the longest plan the scene reaches, so the page doesn't jump.
  const rows = Math.max(props.start.lines.length, ...props.frames.map((f) => f.plan.lines.length));
  const [visible, setVisible] = createSignal(false);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let stopped = false;
  let wake: (() => void) | null = null;

  const shown = () => (visible() ? Promise.resolve() : new Promise<void>((r) => (wake = r)));
  const wait = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    await shown();
  };

  async function play() {
    while (!stopped) {
      editor.adopt(props.start);
      setBoxes(props.start.boxes);
      setLast(null);
      setWhose("h");
      for (const [i, f] of props.frames.entries()) {
        if (stopped) return;
        if (f.kind === "type") {
          if (reduce && props.frames[i + 1]?.kind === "type") continue;
          editor.adopt(f.plan);
          await wait(KEY_MS);
        } else {
          await wait(BEFORE_PASS_MS);
          setWhose("a");
          const old = editor.lines();
          const pulse: Record<string, number> = {};
          f.animation.forEach((o, k) => { if (o.op === "move") pulse[o.to] ??= 500 + k * 40; });
          setBoxAnim({ delay: 250, pulse, changes: f.boxChanges });
          setBoxes(f.plan.boxes);
          await editor.animate(f.animation, old, f.plan);
          setBoxAnim(null);
          setLast(f.last);
          setWhose("h");
          await wait(HOLD_MS);
        }
      }
    }
  }

  onMount(() => {
    const io = new IntersectionObserver(([e]) => {
      setVisible(e.isIntersecting);
      if (e.isIntersecting && wake) { wake(); wake = null; }
    }, { threshold: 0.4 });
    io.observe(el);
    shown().then(play);
    onCleanup(() => { stopped = true; io.disconnect(); });
  });

  return (
    <div class="scene" ref={el} aria-label={props.label}>
      <div class="scene-top">
        <span class="brand">Underpaint</span>
        <span class="spacer" />
        <span class={`turn ${whose()}`}><i class="dot" />{whose() === "a" ? "agent's turn · writing" : "your turn"}</span>
      </div>
      <div class="scene-body" classList={{ split: boxes().length > 0 }}>
        <div class="editor" style={{ height: `${rows * 24 + 28}px` }}>
          <Editor ref={(api) => (editor = api)} editable={false} working={false} threads={[]} onEdit={() => {}} onChoose={() => {}} onSettle={() => {}} onPass={() => {}} onHint={() => {}} />
        </div>
        <Show when={boxes().length}>
          <div class="box-pane">
            <Boxes ref={() => {}} boxes={boxes()} symbols={[]} editable={false} animate={boxAnim()} onEdit={() => {}} onPass={() => {}} />
          </div>
        </Show>
      </div>
      <div class="under-slot">
        <Show when={last()}>{(l) => <div class="slide-in"><Underneath last={l()} open /></div>}</Show>
      </div>
    </div>
  );
}
