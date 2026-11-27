import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { joinLines, splitLines } from "../src/shared/diff.ts";
import type { Box, BoxChanges, BoxEdge, Edit, Pin, Smell, Snapshot } from "../src/types.ts";
import { STATUS_LABEL, decorate, keys, symbolPattern } from "./text.ts";
import { smellIds, tangleWords } from "../src/shared/smells.ts";
import { count, impactOf, namesOf, order, place, ranked, tanglesAt, wirePath, zoomToFit, type Rect, type Size } from "./map/layout.ts";
import { GHOST, ancestorAt, arrowKey, isGhost, trail, visible } from "../src/shared/level.ts";
import { Tangles } from "./Tangles.tsx";

// The map of the repo. One level shows at a time: the boxes inside the box you opened,
// the arrows between them, and ghosts for the ends outside. Boxes sit in columns by what
// they use, so what is used reads before what uses it. Drag to pan, pinch or ⌘-scroll to
// zoom, drag a box's right edge onto another to draw an arrow.

// While an agent turn plays: when the boxes it added or changed animate in, and which
// boxes receive moved lines (id → delay in ms).
export interface BoxAnimation {
  delay: number;
  pulse: Record<string, number>;
  changes: BoxChanges;
}

export interface BoxesApi {
  // Close an open box editor and hand back its text, to go with the hand-over.
  take(): Record<string, string> | undefined;
}

interface Props {
  ref: (api: BoxesApi) => void;
  title: string;
  boxes: Box[];
  edges: BoxEdge[];
  smells: Smell[];
  drifted: string[];
  symbols: Snapshot["symbols"];
  editable: boolean;
  // The agent holds the pen (a turn or a describe).
  busy: boolean;
  describing: Snapshot["describing"];
  animate: BoxAnimation | null;
  onEdit: (id: string, text: string) => void;
  onPass: () => void;
  onMapEdit: (edits: Edit[]) => void;
  onDescribe: (id: string | null) => void;
  // Put a line at the end of the plan.
  onFix: (line: string) => void;
}

type Measured = Size & { ports: Record<string, number> };
const kindLabel = (b: Box) => (b.scan!.kind === "external" ? "outside" : b.scan!.kind === "file" ? "file" : "folder");
const sameSize = (a: Measured | undefined, b: Measured) => !!a && a.w === b.w && a.h === b.h && JSON.stringify(a.ports) === JSON.stringify(b.ports);

export function Boxes(props: Props) {
  let viewport!: HTMLDivElement;
  let canvas!: HTMLDivElement;
  let editor: HTMLTextAreaElement | undefined;
  const [level, setLevel] = createSignal<string | null>(null);
  // One thing is selected at a time: a box, an arrow, or a tangle.
  const [sel, setSel] = createSignal<{ box: string } | { wire: string } | { tangle: Smell } | null>(null);
  const selected = () => { const s = sel(); return s && "box" in s ? s.box : null; };
  const wireSel = () => { const s = sel(); return s && "wire" in s ? s.wire : null; };
  const tangle = () => { const s = sel(); return s && "tangle" in s ? s.tangle : null; };
  // The selected box after one ⌫: the next one takes it off the map.
  const [crossed, setCrossed] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [sketch, setSketch] = createSignal<{ x: number; y: number } | null>(null);
  const [pinsOpen, setPinsOpen] = createSignal(new Set<string>());
  // Where the person dragged boxes to, for as long as the page is open.
  const [moved, setMoved] = createSignal(new Map<string, { x: number; y: number }>());
  const [sizes, setSizes] = createSignal(new Map<string, Measured>());
  const [room, setRoom] = createSignal<Size>({ w: 0, h: 0 });
  const [view, setView] = createSignal({ x: 0, y: 0, z: 1 });
  const [fitted, setFitted] = createSignal(true);
  const [temp, setTemp] = createSignal<string | null>(null);
  const [drop, setDrop] = createSignal<string | null>(null);
  const symRe = createMemo(() => symbolPattern(props.symbols));
  const asked = new Set<string>();

  const v = createMemo(() => visible(props.boxes, props.edges, level()));
  const byId = () => v().byId as Map<string, Box>;
  const nameOf = (id: string) => byId().get(id)?.name ?? id;
  const rank = createMemo(() => ranked(v().shown.map((b) => b.id), v().ghosts, v().wires));
  const keysInOrder = createMemo(() => order(rank(), v().wires), undefined, { equals: (a, b) => a.join("\n") === b.join("\n") });
  const kids = createMemo(() => {
    const n = new Map<string, number>();
    for (const b of props.boxes) if (b.parent) n.set(b.parent, (n.get(b.parent) ?? 0) + 1);
    return n;
  });
  const drifted = createMemo(() => new Set(props.drifted));
  const shownIds = createMemo(() => new Set(v().shown.map((b) => b.id)));
  const tangles = createMemo(() => tanglesAt(props.smells, shownIds()));
  // A tangle in one file shows on the file's box, as a pin.
  const fileSmells = createMemo(() => {
    const m = new Map<string, Pin[]>();
    for (const s of props.smells) {
      if (s.kind !== "unused" && s.kind !== "pass-through") continue;
      const pin = { kind: s.kind, text: tangleWords(s)[1] };
      const at = m.get(s.a);
      if (at) at.push(pin);
      else m.set(s.a, [pin]);
    }
    return m;
  });

  // The level's box went away (an undo, a rescan): back to the top.
  createEffect(() => {
    const l = level();
    if (l && !props.boxes.some((b) => b.id === l)) setLevel(null);
  });

  // ---------- where everything goes ----------

  const placed = createMemo(() => {
    const ids = keysInOrder();
    const s = sizes();
    if (!ids.every((id) => s.has(id)) || !room().w) return null;
    return place(ids, rank(), s, room());
  });
  const posOf = (key: string) => moved().get(key) ?? placed()?.pos.get(key);
  const rect = (key: string): Rect | null => {
    const p = posOf(key);
    const s = sizes().get(key);
    return p && s ? { ...p, ...s } : null;
  };
  const bounds = createMemo(() => {
    let w = placed()?.width ?? 0;
    let h = placed()?.height ?? 0;
    for (const id of keysInOrder()) {
      const r = rect(id);
      if (r) { w = Math.max(w, r.x + r.w + 8); h = Math.max(h, r.y + r.h + 8); }
    }
    return { width: w, height: h };
  });

  // Measure the boxes that resized; the map only changes when one measures differently.
  function measure(els: Element[]) {
    let next: Map<string, Measured> | null = null;
    for (const el of els) {
      if (!(el instanceof HTMLElement) || !el.dataset.key) continue;
      const ports: Record<string, number> = {};
      for (const p of el.querySelectorAll<HTMLElement>("[data-port]")) ports[p.dataset.port!] = p.offsetTop + p.offsetHeight / 2;
      const m = { w: el.offsetWidth, h: el.offsetHeight, ports };
      if (sameSize((next ?? sizes()).get(el.dataset.key), m)) continue;
      (next ??= new Map(sizes())).set(el.dataset.key, m);
    }
    if (next) setSizes(next);
  }
  const boxRo = new ResizeObserver((entries) => measure(entries.map((e) => e.target)));
  const observe = (el: HTMLElement) => {
    boxRo.observe(el);
    onCleanup(() => boxRo.unobserve(el));
  };

  function fit() {
    const b = bounds();
    if (!b.width) return;
    const w = viewport.clientWidth;
    const z = Math.max(0.35, zoomToFit(b, { w, h: viewport.clientHeight }));
    setView({ z, x: Math.max(0, (w - b.width * z) / 2), y: 0 });
    setFitted(true);
  }
  // Fit when the level, what it shows, its size, or the room changes; not while the
  // person types in a box, or after they panned or zoomed.
  let fittedFor = "";
  createEffect(() => {
    if (!placed() || editing()) return;
    const size = untrack(fitted) ? `${Math.round(bounds().width)}x${Math.round(bounds().height)}` : "";
    const key = `${level()}|${keysInOrder().join(",")}|${size}|${room().w}x${room().h}`;
    if (key !== untrack(() => fittedFor)) {
      fittedFor = key;
      untrack(fit);
    }
  });

  onMount(() => {
    const ro = new ResizeObserver(() => setRoom({ w: viewport.clientWidth, h: Math.max(viewport.clientHeight, 480) }));
    ro.observe(viewport);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      ro.disconnect();
      boxRo.disconnect();
      viewport.removeEventListener("wheel", onWheel);
      document.removeEventListener("keydown", onKey);
    });
  });

  // ---------- the arrows ----------

  const picked = createMemo(() => (tangle() ? new Set(smellIds(tangle()!)) : null));
  const impact = createMemo(() => (picked() ? new Set<string>() : impactOf(selected(), v().wires)));
  const volatile = createMemo(() => new Set(props.smells.flatMap((s) => (s.kind === "volatile import" ? [arrowKey({ from: s.a, to: s.b })] : []))));
  const loopOf = createMemo(() => {
    const m = new Map<string, string>();
    for (const s of props.smells) if (s.kind === "cycle") for (const id of s.ids) m.set(id, s.ids.join("|"));
    return m;
  });
  const down = () => !!placed()?.down;
  const wires = createMemo(() => {
    const all = v().wires;
    return all.flatMap((w) => {
      const a = rect(w.to);
      const b = rect(w.from);
      if (!a || !b) return [];
      // An import leaves the used box at the first seam name it carries.
      const ports = sizes().get(w.to)!.ports;
      const port = w.imports ? w.symbols.map((s) => ports[s]).find((y) => y !== undefined) : undefined;
      const { d, mid } = wirePath({ ...a, port }, b, down());
      const p = picked();
      const lit = p ? p.has(w.from) && p.has(w.to) : impact().has(w.from) && (impact().has(w.to) || w.to === selected());
      const looped = !!loopOf().get(w.from) && loopOf().get(w.from) === loopOf().get(w.to);
      const label = w.imports ? namesOf(w.symbols) : w.members.length > 1 ? `${w.members.length} calls` : w.labels[0];
      return [{
        key: w.key,
        d,
        mid,
        cls: { import: w.imports, volatile: volatile().has(w.key), looped, sel: wireSel() === w.key, lit, dim: !!p && !lit, ghostwire: w.ghost },
        width: w.imports ? Math.min(6, 1.2 + Math.log2(w.members.length)) : undefined,
        label: label && (wireSel() === w.key || lit || !w.imports || all.length <= 12) ? label : "",
      }];
    });
  });
  // Boxes git changes together with no import between them: a dashed line, no arrowhead.
  const together = createMemo(() =>
    props.smells.flatMap((s) => {
      if (s.kind !== "change together") return [];
      const a = rect(s.a);
      const b = rect(s.b);
      if (!a || !b) return [];
      const ax = a.x + a.w / 2, ay = a.y + a.h, bx = b.x + b.w / 2, by = b.y + b.h;
      const p = picked();
      return [{ d: `M${ax},${ay} C${ax},${ay + 60} ${bx},${by + 60} ${bx},${by}`, x: (ax + bx) / 2, y: Math.max(ay, by) + 52, label: `change together ×${s.count}`, dim: !!p && !(p.has(s.a) && p.has(s.b)) }];
    }),
  );

  // ---------- moving around ----------

  function goTo(to: string | null, focus: string | null = null) {
    setLevel(to);
    setSel(focus ? { box: focus } : null);
    setCrossed(null);
    // Opening a box nobody described yet asks the agent what it and its boxes do.
    const undescribed = props.boxes.some((b) => (b.parent ?? null) === to && b.scan && b.scan.kind !== "external" && !b.lines.length);
    if (to && undescribed && props.editable && !props.busy && !asked.has(to)) {
      asked.add(to);
      props.onDescribe(to);
    }
  }

  function select(id: string | null) {
    setSel(id ? { box: id } : null);
    if (crossed() !== id) setCrossed(null);
  }

  const toWorld = (e: MouseEvent) => {
    const r = viewport.getBoundingClientRect();
    const { x, y, z } = view();
    return { x: (e.clientX - r.left - x) / z, y: (e.clientY - r.top - y) / z };
  };

  // Follow the pointer until the button comes up.
  function drag(onMove: (e: MouseEvent) => void, onUp: (e: MouseEvent) => void) {
    const up = (e: MouseEvent) => {
      removeEventListener("mousemove", onMove);
      removeEventListener("mouseup", up);
      onUp(e);
    };
    addEventListener("mousemove", onMove);
    addEventListener("mouseup", up);
  }

  function startPan(e: MouseEvent) {
    // A control on the map handles its own click; a drag anywhere else pans.
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, textarea, select, .bb, .hit")) return;
    const start = { x: e.clientX, y: e.clientY, view: view() };
    let panned = false;
    viewport.classList.add("panning");
    drag(
      (m) => {
        panned ||= Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) > 3;
        if (!panned) return;
        setView({ ...start.view, x: start.view.x + m.clientX - start.x, y: start.view.y + m.clientY - start.y });
        setFitted(false);
      },
      () => {
        viewport.classList.remove("panning");
        if (!panned) select(null);
      },
    );
  }

  function onWheel(e: WheelEvent) {
    const zoom = e.ctrlKey || e.metaKey;
    const { x, y, z } = view();
    const b = bounds();
    const overflows = b.width * z > viewport.clientWidth + 1 || b.height * z > viewport.clientHeight + 1 || x < 0 || y < 0;
    // A map that fits lets the page scroll past it.
    if (!zoom && !overflows) return;
    e.preventDefault();
    setFitted(false);
    if (!zoom) return setView({ z, x: x - e.deltaX, y: y - e.deltaY });
    const r = viewport.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const nz = Math.min(2, Math.max(0.25, z * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01)));
    setView({ z: nz, x: mx - ((mx - x) * nz) / z, y: my - ((my - y) * nz) / z });
  }

  // Focus scrolling the viewport to show a box becomes a pan, so the transform stays the only offset.
  function onScroll() {
    if (!viewport.scrollTop && !viewport.scrollLeft) return;
    setView((w) => ({ ...w, x: w.x - viewport.scrollLeft, y: w.y - viewport.scrollTop }));
    viewport.scrollTop = viewport.scrollLeft = 0;
  }

  function startMove(e: MouseEvent, key: string) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
    e.stopPropagation();
    select(key);
    const from = posOf(key);
    if (!from) return;
    const start = { x: e.clientX, y: e.clientY };
    drag(
      (m) => {
        const z = view().z;
        setMoved((all) => new Map(all).set(key, { x: from.x + (m.clientX - start.x) / z, y: from.y + (m.clientY - start.y) / z }));
      },
      () => {},
    );
  }

  // Drag from a box's right edge onto another box: the other box uses this one.
  function startWire(e: MouseEvent, used: string) {
    if (!props.editable) return;
    e.stopPropagation();
    e.preventDefault();
    const a = toWorld(e);
    let target: string | null = null;
    drag(
      (m) => {
        const b = toWorld(m);
        setTemp(`M${a.x},${a.y} C${a.x + 60},${a.y} ${b.x - 60},${b.y} ${b.x},${b.y}`);
        const over = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>(".box[data-name]");
        target = over && over.dataset.name !== used && canvas.contains(over) ? over.dataset.name! : null;
        setDrop(target);
      },
      () => {
        setTemp(null);
        setDrop(null);
        if (target) props.onMapEdit([{ op: "connect", from: target, to: used }]);
      },
    );
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest?.("input, textarea, select") || (t !== document.body && !viewport.contains(t))) return;
    if (e.key === "Escape") return select(null);
    if ((e.key !== "Backspace" && e.key !== "Delete") || !props.editable) return;
    const w = v().wires.find((x) => x.key === wireSel());
    if (w) {
      e.preventDefault();
      const calls = w.members.filter((m) => m.kind === "call");
      if (calls.length) props.onMapEdit(calls.map((m) => ({ op: "disconnect", from: m.from, to: m.to })));
      setSel(null);
      return;
    }
    const id = selected();
    if (!id || isGhost(id)) return;
    e.preventDefault();
    if (crossed() !== id) return setCrossed(id);
    setCrossed(null);
    setSel(null);
    props.onMapEdit([{ op: "remove", id }]);
  }

  // ---------- editing ----------

  function finish(id: string) {
    if (editing() !== id || !editor) return;
    const text = editor.value;
    setEditing(null);
    props.onEdit(id, text);
  }

  const body = (id: string) => canvas.querySelector<HTMLElement>(`.box[data-name="${CSS.escape(id)}"] .bb`);

  props.ref({
    take: () => {
      const id = editing();
      if (!id || !editor) return undefined;
      setEditing(null);
      return { [id]: editor.value };
    },
  });

  function rename(id: string, name: string) {
    setRenaming(null);
    const b = byId().get(id);
    if (b && name.trim() && name.trim() !== b.name) props.onMapEdit([{ op: "rename", id, name: name.trim() }]);
  }

  function commitSketch(el: HTMLElement) {
    if (!sketch()) return;
    setSketch(null);
    const name = el.querySelector("input")!.value.trim();
    const lines = splitLines(el.querySelector("textarea")!.value).map((l) => l.trimEnd());
    while (lines.length && !lines.at(-1)) lines.pop();
    if (name || lines.length) props.onMapEdit([{ op: "add", key: "new", name: name || "untitled", parent: level(), lines }]);
  }

  // ---------- an agent turn, played ----------

  // A change inside a box shows on the box that holds it here.
  const animOf = (id: string, i: number) => {
    const a = props.animate;
    if (!a) return null;
    if (id in a.pulse) return { cls: "pulse", delay: a.pulse[id] };
    const c = a.changes[id];
    if (c) return { cls: c === "new" ? "pop-in" : "pulse", delay: c === "new" ? a.delay + i * 90 : a.delay };
    const inside = [...Object.keys(a.pulse), ...Object.keys(a.changes)].some((k) => k !== id && ancestorAt(k, level(), byId()) === id);
    return inside ? { cls: "pulse", delay: a.delay } : null;
  };

  // ---------- drawing ----------

  const crumbs = () => trail(level(), byId());
  const styleAt = (key: string) => {
    const p = posOf(key);
    return p ? { left: `${p.x}px`, top: `${p.y}px` } : { visibility: "hidden" as const };
  };

  function BoxCard(p: { b: Box; i: number }) {
    // Read through `p` each time: the card stays while the map is fetched again, so an
    // open box editor survives.
    const b = () => p.b;
    const scanned = () => !!b().scan;
    const described = () => b().lines.length > 0;
    const anim = () => animOf(b().id, p.i);
    const pins = () => [...(b().pins ?? []), ...(fileSmells().get(b().id) ?? [])];
    const pinsShown = () => pinsOpen().has(b().id);
    const pinCounts = () => {
      const n = new Map<string, number>();
      for (const x of pins()) n.set(x.kind, (n.get(x.kind) ?? 0) + 1);
      return [...n].map(([k, c]) => `${c} ${k}`).join(" · ");
    };
    const cls = () =>
      [
        "box", b().status, anim()?.cls,
        scanned() && !described() && "bare",
        b().scan?.kind === "external" && "external",
        (selected() === b().id || picked()?.has(b().id)) && "selected",
        impact().has(b().id) && "impact",
        crossed() === b().id && "crossed",
        drop() === b().id && "drop",
        reading() && "reading",
      ].filter(Boolean).join(" ");
    const reading = () => props.describing && (props.describing.id === b().id || (props.describing.id === level() && scanned() && !described()));
    let cancelRename = false;
    return (
      <div
        class={cls()}
        style={{ ...styleAt(b().id), "--d": `${anim()?.delay ?? 0}ms` }}
        data-name={b().id}
        data-key={b().id}
        ref={observe}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest("button, input, textarea, .port")) return;
          e.stopPropagation();
          select(b().id);
        }}
        onDblClick={(e) => {
          e.stopPropagation();
          if (!props.editable || (e.target as HTMLElement).closest("button, input, textarea, .bb")) return;
          setEditing(b().id);
        }}
      >
        <div class="bt" onMouseDown={(e) => startMove(e, b().id)}>
          <Show
            when={renaming() === b().id}
            fallback={<span class="name" title={b().id} onDblClick={(e) => { e.stopPropagation(); if (props.editable) setRenaming(b().id); }}>{b().name}</span>}
          >
            <input
              class="rename"
              aria-label={`Rename ${b().name}`}
              value={untrack(() => b().name)}
              ref={(el) => { cancelRename = false; queueMicrotask(() => { el.focus(); el.select(); }); }}
              onBlur={(e) => !cancelRename && rename(b().id, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") { cancelRename = true; setRenaming(null); }
              }}
            />
          </Show>
          <Show when={drifted().has(b().id)}><span class="drift">code changed</span></Show>
          <span class="st">{scanned() && !described() ? kindLabel(b()) : STATUS_LABEL[b().status]}</span>
        </div>
        <Show when={scanned() && b().name !== b().id && b().scan!.kind !== "external"}><div class="path">{b().id}</div></Show>
        <Show when={scanned() && b().scan!.kind !== "external"}>
          <div class="facts">
            {[`${count(b().scan!.size)} lines`, `used by ${b().scan!.usedBy}`, `uses ${b().scan!.uses}`, ...(b().scan!.tests ? [`${b().scan!.tests} test${b().scan!.tests === 1 ? "" : "s"}`] : [])].join(" · ")}
          </div>
        </Show>
        <Show when={b().scan?.seam.length}>
          <div class="seam">
            <For each={b().scan!.seam.slice(0, 6)}>
              {(x) => <span data-port={x.name} title={`${x.file} · imported by ${x.users} file${x.users === 1 ? "" : "s"} outside`}>{x.name === "*" ? "the whole module" : x.name}</span>}
            </For>
            <Show when={b().scan!.seamSize - Math.min(6, b().scan!.seam.length) > 0}>
              <span class="more">+{b().scan!.seamSize - Math.min(6, b().scan!.seam.length)} more</span>
            </Show>
          </div>
        </Show>
        <Show
          when={editing() === b().id}
          fallback={
            <Show
              when={described() || !scanned()}
              fallback={
                <Show when={b().scan!.kind !== "external"}>
                  <button type="button" class="describe" disabled={!props.editable || props.busy} onClick={() => props.onDescribe(b().id)}>
                    {reading() ? "the agent is reading it…" : "Say what this does"}
                  </button>
                </Show>
              }
            >
              <div
                class="bb"
                role={props.editable ? "button" : undefined}
                tabIndex={props.editable ? 0 : -1}
                aria-label={props.editable ? `Edit ${b().name}` : undefined}
                title={props.editable ? "Click or press Enter to edit" : ""}
                onClick={() => props.editable && !editing() && setEditing(b().id)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" && !keys.pass.is(e)) || e.key === " ") {
                    e.preventDefault();
                    if (props.editable && !editing()) setEditing(b().id);
                  }
                }}
              >
                <For each={b().lines}>
                  {(l) => <span class={l.chg ? `chg ${l.by}` : ""} innerHTML={decorate(l.text, symRe()) || " "} />}
                </For>
              </div>
            </Show>
          }
        >
          <textarea
            class="box-edit"
            spellcheck={false}
            rows={Math.max(3, b().lines.length + 1)}
            ref={(el) => { editor = el; queueMicrotask(() => el.focus()); }}
            // Read once: an update from the server must not replace the text being typed.
            value={untrack(() => joinLines(b().lines))}
            onBlur={() => finish(b().id)}
            onKeyDown={(e) => {
              if (keys.pass.is(e)) { e.preventDefault(); props.onPass(); }
              // Esc leaves the box like clicking away does, keeping what was typed, and
              // the keyboard stays on the box.
              if (e.key === "Escape") {
                finish(b().id);
                body(b().id)?.focus();
              }
            }}
          />
        </Show>
        <Show when={pins().length}>
          {/* A box stays as short as its description: pins show as counts until opened. */}
          <button
            type="button"
            class="pinsum"
            aria-expanded={pinsShown()}
            onClick={() => setPinsOpen((s) => { const n = new Set(s); n.has(b().id) ? n.delete(b().id) : n.add(b().id); return n; })}
          >
            {pinsShown() ? "▾" : "▸"} {pinCounts()}
          </button>
          <Show when={pinsShown()}>
            <ul class="pins">
              <For each={pins()}>
                {(x) => (
                  <li>
                    <b>{x.kind}</b> {x.text}
                    <Show when={x.file}>{(f) => <span class="where">{` ${f().split("/").at(-1)}${x.line ? `:${x.line}` : ""}`}</span>}</Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <Show when={kids().get(b().id)}>
          <button type="button" class="open" onClick={() => goTo(b().id)}>▸ {kids().get(b().id)} inside</button>
        </Show>
        <Show when={crossed() === b().id}><div class="cross">⌫ again takes it off the map</div></Show>
        <Show when={props.editable}><span class="port" title="Drag onto a box that uses this one" onMouseDown={(e) => startWire(e, b().id)} /></Show>
      </div>
    );
  }

  // A box outside the level that an arrow comes from or goes to; it opens where it lives.
  function GhostCard(p: { key: string }) {
    const id = p.key.slice(GHOST.length);
    const g = () => byId().get(id);
    const side = () => v().ghosts.get(id);
    const label = () => (g()?.scan ? id : `${g()?.parent ? `${nameOf(g()!.parent!)}.` : ""}${g()?.name ?? id}`);
    return (
      <button type="button" class="ghost-box" data-key={p.key} ref={observe} style={styleAt(p.key)} onClick={() => goTo(g()?.parent ?? null, id)}>
        {side() === "in" ? "from " : side() === "out" ? "to " : ""}{label()}
      </button>
    );
  }

  return (
    <div class="map">
      <Show when={level()}>
        <nav class="crumbs" aria-label="Where on the map">
          <button type="button" onClick={() => goTo(null)}>{props.title}</button>
          <For each={crumbs()}>
            {(id, i) => (
              <>
                <span aria-hidden="true">›</span>
                <Show when={i() < crumbs().length - 1} fallback={<span class="here">{nameOf(id)}</span>}>
                  <button type="button" onClick={() => goTo(id)}>{nameOf(id)}</button>
                </Show>
              </>
            )}
          </For>
        </nav>
      </Show>
      <div
        class="viewport"
        ref={viewport}
        style={{ "min-height": `min(${Math.ceil(bounds().height)}px, 60vh)` }}
        onMouseDown={startPan}
        onScroll={onScroll}
        onDblClick={(e) => {
          if (!props.editable || (e.target as HTMLElement).closest(".box, .ghost-box, button")) return;
          setSketch(toWorld(e));
        }}
      >
        <div
          class="canvas"
          ref={canvas}
          style={{ width: `${bounds().width}px`, height: `${bounds().height}px`, transform: `translate(${view().x}px, ${view().y}px) scale(${view().z})` }}
        >
          <svg width={bounds().width} height={bounds().height} aria-hidden="true">
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: "var(--muted)", stroke: "none" }} />
              </marker>
            </defs>
            <Index each={wires()}>
              {(w) => (
                <>
                  <path class="hit" d={w().d} onMouseDown={(e) => { e.stopPropagation(); select(null); setSel({ wire: w().key }); }} />
                  <path class="wire" classList={w().cls} d={w().d} marker-end="url(#arr)" style={{ "stroke-width": w().width }} />
                  <Show when={w().label}><text x={w().mid.x} y={w().mid.y - 5} text-anchor="middle" classList={{ dim: w().cls.dim }}>{w().label}</text></Show>
                </>
              )}
            </Index>
            <Index each={together()}>
              {(t) => (
                <>
                  <path class="together" classList={{ dim: t().dim }} d={t().d} />
                  <text class="together-label" x={t().x} y={t().y} text-anchor="middle">{t().label}</text>
                </>
              )}
            </Index>
            <Show when={temp()}><path class="temp" d={temp()!} /></Show>
          </svg>
          <For each={keysInOrder()}>
            {(key, i) => (isGhost(key) ? <GhostCard key={key} /> : <Show when={byId().get(key)}>{(b) => <BoxCard b={b()} i={i()} />}</Show>)}
          </For>
          <Show when={sketch()}>
            {(s) => (
              <div
                class="box sketch"
                style={{ left: `${s().x}px`, top: `${s().y}px` }}
                onMouseDown={(e) => e.stopPropagation()}
                onFocusOut={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitSketch(e.currentTarget); }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") commitSketch(e.currentTarget);
                  else if (keys.pass.is(e)) { e.preventDefault(); commitSketch(e.currentTarget); props.onPass(); }
                  else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); e.currentTarget.querySelector("textarea")!.focus(); }
                }}
              >
                <input class="rename" placeholder="name" aria-label="Name of the new box" ref={(el) => queueMicrotask(() => el.focus())} />
                <textarea class="box-edit" spellcheck={false} rows={3} placeholder="what it does, a line each" aria-label="What the new box does" />
              </div>
            )}
          </Show>
        </div>
        <Show when={!fitted()}>
          <button type="button" class="btn fit" onClick={fit}>Fit</button>
        </Show>
      </div>
      <Tangles smells={tangles()} wires={v().wires} nameOf={nameOf} picked={tangle()} editable={props.editable} onPick={(s) => { select(null); setSel(s && { tangle: s }); }} onFix={props.onFix} />
    </div>
  );
}
