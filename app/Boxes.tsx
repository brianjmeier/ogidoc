import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { joinLines } from "../src/shared/diff.ts";
import type { Box, Snapshot } from "../src/types.ts";
import { STATUS_LABEL, decorate, isPassKey, symbolPattern } from "./text.ts";

// The boxes canvas. Boxes are laid out in columns by what they use: a box sits to the
// right of the boxes it uses, so the plan reads left to right like the code runs.

const W = 250;
const GAP_X = 56;
const GAP_Y = 22;

export interface BoxesApi {
  // Close an open box editor and hand back its text, to go with the pen.
  take(): Record<string, string> | undefined;
}

interface Props {
  ref: (api: BoxesApi) => void;
  boxes: Box[];
  symbols: Snapshot["symbols"];
  editable: boolean;
  // While an agent turn plays: when new and changed boxes animate in, and which boxes
  // receive moved lines (name → delay in ms).
  animate: { delay: number; pulse: Record<string, number> } | null;
  onEdit: (name: string, text: string) => void;
  onPass: () => void;
}

export function Boxes(props: Props) {
  let canvas!: HTMLDivElement;
  const [editing, setEditing] = createSignal<string | null>(null);
  const [paths, setPaths] = createSignal<string[]>([]);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const symRe = createMemo(() => symbolPattern(props.symbols));
  let editor: HTMLTextAreaElement | undefined;

  function finish(name: string) {
    if (editing() !== name || !editor) return;
    const text = editor.value;
    setEditing(null);
    props.onEdit(name, text);
  }

  props.ref({
    take: () => {
      const name = editing();
      if (!name || !editor) return undefined;
      setEditing(null);
      return { [name]: editor.value };
    },
  });

  function layout() {
    const list = props.boxes;
    const byName = new Map(list.map((b) => [b.name, b]));
    const depth = new Map<string, number>();
    const visit = (name: string, seen = new Set<string>()): number => {
      if (depth.has(name)) return depth.get(name)!;
      if (seen.has(name)) return 0;
      seen.add(name);
      const uses = (byName.get(name)?.uses || []).filter((u) => byName.has(u) && u !== name);
      const d = uses.length ? 1 + Math.max(...uses.map((u) => visit(u, seen))) : 0;
      depth.set(name, d);
      return d;
    };
    for (const b of list) visit(b.name);
    const cols = new Map<number, string[]>();
    for (const b of list) {
      const d = depth.get(b.name)!;
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d)!.push(b.name);
    }
    const els = new Map([...canvas.querySelectorAll<HTMLElement>(".box")].map((el) => [el.dataset.name!, el]));
    const levels = [...cols.keys()].sort((a, b) => a - b);
    // Read left to right when the chain fits across the pane, otherwise top to bottom.
    const across = levels.length * (W + GAP_X) - GAP_X <= canvas.parentElement!.clientWidth - 32;
    const rect = new Map<string, { x: number; y: number; w: number; h: number }>();
    let width = 0;
    let height = 0;
    let offset = 0;
    for (const d of levels) {
      let along = 0;
      let thickest = 0;
      for (const name of cols.get(d)!) {
        const el = els.get(name);
        if (!el) continue;
        const h = el.offsetHeight;
        const [x, y] = across ? [offset, along] : [along, offset];
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        rect.set(name, { x, y, w: W, h });
        width = Math.max(width, x + W);
        height = Math.max(height, y + h);
        along += across ? h + GAP_Y : W + GAP_Y;
        thickest = Math.max(thickest, across ? W : h);
      }
      offset += thickest + (across ? GAP_X : GAP_X * 0.6);
    }
    const out: string[] = [];
    for (const b of list) {
      for (const u of b.uses || []) {
        const A = rect.get(u);
        const B = rect.get(b.name);
        if (!A || !B || u === b.name) continue;
        if (across) {
          const x1 = A.x + A.w, y1 = A.y + Math.min(A.h / 2, 30);
          const x2 = B.x, y2 = B.y + Math.min(B.h / 2, 30);
          const c = (x1 + x2) / 2;
          out.push(`M${x1},${y1} C${c},${y1} ${c},${y2} ${x2},${y2}`);
        } else {
          const x1 = A.x + A.w / 2, y1 = A.y + A.h;
          const x2 = B.x + B.w / 2, y2 = B.y;
          const c = (y1 + y2) / 2;
          out.push(`M${x1},${y1} C${x1},${c} ${x2},${c} ${x2},${y2}`);
        }
      }
    }
    setSize({ width, height });
    setPaths(out);
  }

  // Lay out after Solid has put the boxes in the DOM, so their heights are real.
  // Updates arrive in place, so watch what sizes and connects the boxes.
  const shape = () => props.boxes.map((b) => `${b.name}|${b.status}|${b.uses.join(",")}|${joinLines(b.lines)}`).join("\n");
  createEffect(on([shape, editing], () => queueMicrotask(layout)));
  onMount(() => {
    const ro = new ResizeObserver(() => layout());
    ro.observe(canvas.parentElement!);
    onCleanup(() => ro.disconnect());
  });

  const boxClass = (b: Box) => {
    const a = props.animate;
    if (!a) return "";
    if (b.name in a.pulse) return "pulse";
    if (b.isNew) return "pop-in";
    return b.changed ? "pulse" : "";
  };
  const boxDelay = (b: Box, i: number) => {
    const a = props.animate;
    if (!a) return "0ms";
    if (b.name in a.pulse) return `${a.pulse[b.name]}ms`;
    return `${b.isNew ? a.delay + i * 90 : a.delay}ms`;
  };

  return (
    <div class="canvas" ref={canvas} style={{ width: `${size().width}px`, height: `${size().height}px` }}>
      <svg width={size().width} height={size().height} aria-hidden="true">
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: "var(--muted)", stroke: "none" }} />
          </marker>
        </defs>
        <For each={paths()}>{(d) => <path d={d} marker-end="url(#arr)" />}</For>
      </svg>
      <For each={props.boxes}>
        {(b, i) => (
          <div class={`box ${b.status} ${boxClass(b)}`} style={{ "--d": boxDelay(b, i()) }} data-name={b.name}>
            <div class="bt">
              <span>{b.name}</span>
              <span class="st">{STATUS_LABEL[b.status]}</span>
            </div>
            <Show
              when={editing() === b.name}
              fallback={
                <div class="bb" title={props.editable ? "Click to edit" : ""} onClick={() => props.editable && !editing() && setEditing(b.name)}>
                  <For each={b.lines}>
                    {(l) => <span class={l.chg ? `chg ${l.by}` : ""} innerHTML={decorate(l.text, symRe()) || " "} />}
                  </For>
                </div>
              }
            >
              <textarea
                class="box-edit"
                spellcheck={false}
                rows={Math.max(3, b.lines.length + 1)}
                ref={(el) => { editor = el; queueMicrotask(() => el.focus()); }}
                // Read once: an update from the server must not replace the text being typed.
                value={untrack(() => joinLines(b.lines))}
                onBlur={() => finish(b.name)}
                onKeyDown={(e) => {
                  if (isPassKey(e)) { e.preventDefault(); props.onPass(); }
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
