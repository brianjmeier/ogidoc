import { For, Index, Show, createEffect, createMemo, createSelector, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { acceptProposal, anyBuilt, carryMeta, diffLines, joinLines, splitLines } from "../src/shared/diff.ts";
import { choose, follow } from "../src/choices.ts";
import { anyStop, isOpenProposal, nextStop, stops, waitingOnYou } from "../src/shared/stops.ts";
import type { AnimationOp, Choice, Line, Thread } from "../src/types.ts";
import { state } from "./api.ts";
import { STATUS_LABEL, STATUS_MARK, brackets, decorate, keys, symbolPattern } from "./text.ts";
import { ThreadPin } from "./Threads.tsx";
import { draftLine, openId, setOpenId, startThread } from "./threads.ts";

// The plan editor. A transparent textarea sits on top of a rendered copy of the same
// text, so typing stays native while the copy carries color, marks, comment pins and
// the agent's animation. Both wrap the same way, so every rendered row stays under the
// textarea line it copies.

// One rendered row. `n` is its line number, or null for a row that is leaving.
interface Row {
  line: Line;
  n: number | null;
  cls?: string;
  delay?: number;
  pop?: boolean;
  was?: string;
  to?: string;
}

const indentOf = (text: string) => text.match(/^\s*/)![0];

// What the editor shows: the plan's lines and the choices offered on them.
type Shown = { lines: Line[]; choices?: Choice[] };

export interface EditorApi {
  adopt(next: Shown): void;
  animate(ops: AnimationOp[], oldLines: Line[], next: Shown): Promise<void>;
  text(): string;
  lines(): Line[];
  takeAccepted(): number[];
  focus(): void;
  // Typing goes back to the plan when nothing else has the keyboard, as after a card or a button went away.
  focusIfIdle(): void;
  // Nothing typed since the plan last came from the server, so the undo key undoes the agent's turn.
  fresh(): boolean;
  // Whether a line waits on the person, and moving the caret to the next one.
  hasStops(): boolean;
  jump(by: 1 | -1): void;
}

interface Props {
  ref: (api: EditorApi) => void;
  editable: boolean;
  working: boolean;
  threads: Thread[];
  onEdit: () => void;
  // Switch a choice; `before` is the plan text from just before the switch.
  onChoose: (choice: string, option: number, before: string) => void;
  // Keep the option a choice shows now; `before` is the plan text as it is.
  onSettle: (choice: string, before: string) => void;
  onPass: () => void;
  onHint: (hint: string) => void;
  onUndo?: () => void;
}

// The buttons on a row leave the keyboard where it was; they go away once used.
const keepFocus = (e: MouseEvent) => e.preventDefault();

export function Editor(props: Props) {
  let ta!: HTMLTextAreaElement;
  const [lines, setLines] = createSignal<Line[]>([]);
  // The choices follow the person's typing here the same way they do on the server.
  const [choices, setChoices] = createSignal<Choice[]>([]);
  const symbols = () => state()?.symbols ?? [];
  const suggestions = () => state()?.suggestions ?? [];
  const built = () => !!state() && anyBuilt(state()!.lines, state()!.boxes);
  const [caret, setCaret] = createSignal({ line: 0, col: 0, collapsed: true }, { equals: (a, b) => a.line === b.line && a.col === b.col && a.collapsed === b.collapsed });
  const caretLine = createMemo(() => caret().line);
  const onCaretLine = createSelector<number, number | null>(caretLine);
  const [ghostOff, setGhostOff] = createSignal(false);
  const [anim, setAnim] = createSignal<Row[] | null>(null);
  const accepted = new Set<number>();
  const [fresh, setFresh] = createSignal(true);
  // Keys show on the controls they trigger only while typing goes to the plan.
  const [active, setActive] = createSignal(false);
  // After an Esc with nothing to dismiss, the next Tab moves focus on instead of indenting.
  const [tabLeaves, setTabLeaves] = createSignal(false);
  const symRe = createMemo(() => symbolPattern(symbols()));

  // The agent's suggestions are whole lines it expects you to write. Offer the rest of
  // one when what you've typed on this line starts it.
  const ghost = createMemo(() => {
    if (!props.editable || ghostOff() || !suggestions().length) return "";
    const { line, col, collapsed } = caret();
    const cur = lines()[line]?.text ?? "";
    if (!collapsed || col !== cur.length) return "";
    const typed = cur.trimStart();
    if (typed.length < 2) return "";
    for (const s of suggestions()) {
      const t = s.trimStart();
      if (t.length > typed.length && t.toLowerCase().startsWith(typed.toLowerCase()) && !written().has(t)) return t.slice(typed.length);
    }
    return "";
  });
  const written = createMemo(() => new Set(lines().map((l) => l.text.trim())));

  // Whether a line's or a choice's keys work right now.
  const keysOn = (n: number | null) => props.editable && active() && onCaretLine(n);
  const inChoice = (c: Choice) => props.editable && active() && isCaretChoice(c);
  const rows = (): Row[] => anim() ?? lines().map((line, n) => ({ line, n }));
  // Which choice each line belongs to.
  const choiceAt = createMemo(() => {
    const at = new Map<number, Choice>();
    for (const c of choices()) for (let i = 0; i < c.options[c.current].length; i++) at.set(c.line + i, c);
    return at;
  });
  const caretChoice = createMemo(() => choiceAt().get(caretLine()));
  const isCaretChoice = createSelector<Choice | undefined, Choice>(caretChoice);
  // Where each choice's lines sit, so its control stays beside them on the right, still
  // while the text changes. Measured after the rows render, and again when they rewrap.
  let rowsEl!: HTMLDivElement;
  const [wrapped, setWrapped] = createSignal(0);
  const [rail, setRail] = createSignal<{ choice: Choice; top: number; height: number }[]>([]);
  onMount(() => {
    const ro = new ResizeObserver(() => setWrapped((k) => k + 1));
    ro.observe(rowsEl);
    onCleanup(() => ro.disconnect());
  });
  createEffect(() => {
    wrapped();
    rows();
    const els = rowsEl.children as HTMLCollectionOf<HTMLElement>;
    setRail(choices().flatMap((choice) => {
      const first = els[choice.line];
      const last = els[choice.line + choice.options[choice.current].length - 1];
      return first && last ? [{ choice, top: first.offsetTop, height: last.offsetTop + last.offsetHeight - first.offsetTop }] : [];
    }));
  });
  // When a comment card closes, typing goes back to the plan, where the caret was.
  createEffect(on(openId, (id, prev) => {
    if (prev && !id) setTimeout(focusIfIdle);
  }, { defer: true }));
  const openOn = createMemo(() => {
    const by = new Map<number, Thread[]>();
    for (const t of props.threads) if (!t.resolved) by.set(t.line, [...(by.get(t.line) ?? []), t]);
    return by;
  });

  function readCaret() {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const line = before.split("\n").length - 1;
    setCaret({ line, col: pos - before.lastIndexOf("\n") - 1, collapsed: ta.selectionStart === ta.selectionEnd });
    const { line: l, col } = caret();
    const text = lines()[l]?.text || "";
    const re = symRe();
    const hit = re && [...text.matchAll(re)].find((m) => col >= m.index && col <= m.index + m[0].length);
    const sym = hit && symbols().find((s) => s.name === hit[0]);
    props.onHint(sym ? `${sym.name} · ${sym.where}` : "");
  }

  function onInput() {
    const texts = splitLines(ta.value);
    const ops = diffLines(lines().map((l) => l.text), texts);
    const next = carryMeta(lines(), texts, { anyBuilt: built(), ops });
    setLines(next);
    setChoices((cs) => follow(cs, ops, next));
    setGhostOff(false);
    readCaret();
    edited();
  }

  // The person changed the plan, so the undo key goes back to undoing their typing.
  function edited(tell: () => void = props.onEdit) {
    setFresh(false);
    tell();
  }

  function focusIfIdle() {
    const at = document.activeElement;
    if (props.editable && (!at || at === document.body)) ta.focus({ preventScroll: true });
  }

  function insert(s: string) {
    ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, "end");
    onInput();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (keys.pass.is(e)) {
      e.preventDefault();
      props.onPass();
      return;
    }
    if (!props.editable) return;
    const leaving = tabLeaves();
    if (!["Shift", "Meta", "Control", "Alt"].includes(e.key)) setTabLeaves(false);
    if (keys.undo.is(e) && fresh() && props.onUndo) {
      e.preventDefault();
      props.onUndo();
      return;
    }
    // The caret may have moved without a click or a key, from a script or a drop.
    readCaret();
    const n = caret().line;
    const by = keys.jump.by(e);
    if (by) {
      e.preventDefault();
      jump(by);
      return;
    }
    if (keys.comment.is(e)) {
      e.preventDefault();
      const t = openOn().get(n)?.[0];
      if (t) setOpenId(t.id);
      else startThread(n);
      return;
    }
    const c = choiceAt().get(n);
    if (c && (keys.prev.is(e) || keys.next.is(e))) {
      e.preventDefault();
      cycle(c, keys.next.is(e) ? 1 : -1);
      return;
    }
    if (c && keys.keep.is(e)) {
      e.preventDefault();
      settle(c);
      return;
    }
    if (proposalAt(n) && (keys.keep.is(e) || keys.reject.is(e))) {
      e.preventDefault();
      if (keys.keep.is(e)) accept(n);
      else reject(n);
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      if (leaving) return;
      e.preventDefault();
      insert(ghost() || "  ");
    } else if (e.key === "Escape") {
      if (ghost()) setGhostOff(true);
      else setTabLeaves(true);
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      // Keep the indentation of the line above.
      e.preventDefault();
      insert("\n" + indentOf(lines()[caret().line]?.text ?? ""));
    }
  }

  // Put the caret on a line, at a column or the line's end, and bring it into view.
  function place(line: number, col: number) {
    const texts = splitLines(ta.value);
    const l = Math.max(0, Math.min(line, texts.length - 1));
    let at = Math.min(col, texts[l].length);
    for (let i = 0; i < l; i++) at += texts[i].length + 1;
    ta.setSelectionRange(at, at);
    readCaret();
  }
  const placeAtIndent = (n: number) => place(n, indentOf(lines()[n].text).length);

  // The caret goes to the next line that waits on the person; a comment the agent
  // answered there opens.
  const hasStops = createMemo(() => anyStop(lines(), choices(), props.threads));
  function jump(by: 1 | -1) {
    const n = nextStop(stops(lines(), choices(), props.threads), caret().line, by);
    if (n === null) return;
    ta.focus({ preventScroll: true });
    placeAtIndent(n);
    (rowsEl.children[n] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    const t = props.threads.find((t) => t.line === n && waitingOnYou(t));
    if (t) setOpenId(t.id);
  }

  // ---------- proposals ----------

  const proposalAt = (n: number) => !!lines()[n] && isOpenProposal(lines()[n]);

  function accept(n: number) {
    setLines((ls) => ls.map((l, i) => (i === n ? acceptProposal(l, built()) : l)));
    accepted.add(n);
    edited();
  }

  // The caret goes to the start of the line that takes the rejected one's place, or to
  // the end of the plan when it was the last line.
  function reject(n: number) {
    const texts = lines().map((l) => l.text);
    texts.splice(n, 1);
    ta.value = texts.join("\n");
    onInput();
    if (n < texts.length) placeAtIndent(n);
    else place(n, Infinity);
  }

  // ---------- choices ----------

  // Show the next or previous option in place, wrapping around.
  function cycle(c: Choice, by: 1 | -1) {
    const option = (c.current + by + c.options.length) % c.options.length;
    const before = ta.value;
    const { selectionStart, selectionEnd } = ta;
    const next = choose(lines(), choices(), c.id, option);
    setLines(next.lines);
    setChoices(next.choices);
    ta.value = joinLines(next.lines);
    ta.setSelectionRange(selectionStart, selectionEnd);
    readCaret();
    edited(() => props.onChoose(c.id, option, before));
  }

  function settle(c: Choice) {
    setChoices((cs) => cs.filter((x) => x.id !== c.id));
    edited(() => props.onSettle(c.id, ta.value));
  }

  // ---------- the agent's turn, animated ----------

  function animate(ops: AnimationOp[], oldLines: Line[], next: Shown): Promise<void> {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const changed = ops.filter((o) => o.op !== "keep").length;
    const step = reduce ? 0 : Math.min(70, 1100 / Math.max(1, changed));
    adopt(next);
    if (reduce || !ops.length) return Promise.resolve();
    let k = 0;
    let n = 0;
    const out: Row[] = [];
    for (const o of ops) {
      if (o.op === "keep") {
        const l = next.lines[o.b];
        out.push({ line: l, n: n++, delay: k * step, pop: !!l.status && l.status !== oldLines[o.a]?.status });
      } else if (o.op === "add" || o.op === "mod") {
        const l = next.lines[o.b];
        out.push({ line: l, n: n++, cls: `a-${o.op}`, delay: k++ * step, pop: !!l.status, was: o.op === "mod" ? o.old : undefined });
      } else {
        out.push({ line: { text: o.text, by: "h" }, n: null, cls: `a-${o.op}`, delay: k++ * step, to: o.op === "move" ? o.to : undefined });
      }
    }
    setAnim(out);
    return new Promise((resolve) => setTimeout(() => { setAnim(null); resolve(); }, k * step + 1150));
  }

  // Text that comes from the server starts a fresh textarea once the person has typed:
  // the browser's own undo would otherwise take them back into the agent's turn and send
  // that as an edit.
  const [copy, setCopy] = createSignal(1);
  function adopt(next: Shown) {
    const typed = !fresh();
    setLines(next.lines);
    setChoices(next.choices ?? []);
    accepted.clear();
    setFresh(true);
    const text = joinLines(next.lines);
    if (ta.value === text) return;
    const focused = document.activeElement === ta;
    const { line, col } = caret();
    if (typed) setCopy((k) => k + 1);
    ta.value = text;
    place(line, col);
    if (focused) ta.focus({ preventScroll: true });
  }

  // What a screen reader hears about the caret's line: the rows under the textarea carry
  // the suggestion, the choice and the proposal, and the textarea alone can't say them.
  const describeId = createUniqueId();
  const described = createMemo(() => {
    if (!props.editable || !active() || anim()) return "";
    const n = caretLine();
    const c = caretChoice();
    if (ghost()) return `Suggestion: ${ghost()}. Tab accepts.`;
    if (tabLeaves()) return "Tab leaves the plan.";
    if (c) return `A choice, way ${c.current + 1} of ${c.options.length}. ${keys.alt}${brackets().prev} and ${keys.alt}${brackets().next} switch, ${keys.keep.label} uses this way.`;
    if (proposalAt(n)) return `A proposal. ${keys.keep.label} accepts, ${keys.reject.label} rejects.`;
    return "";
  });

  props.ref({
    adopt,
    animate,
    text: () => ta.value,
    lines,
    takeAccepted: () => { const a = [...accepted]; accepted.clear(); return a; },
    focus: () => ta.focus({ preventScroll: true }),
    focusIfIdle,
    fresh,
    hasStops,
    jump,
  });

  return (
    <div class="scroller">
      <div class="code" classList={{ working: props.working, "has-ways": choices().length > 0 }}>
        <div class="rows" ref={rowsEl}>
          <Index each={rows()}>
            {(r) => {
              const l = () => r().line;
              const n = () => r().n;
              const indent = () => indentOf(l().text);
              const body = () => l().text.slice(indent().length);
              const st = () => (l().text.trim() ? l().status : null);
              const chip = () => (l().kind === "example" ? "becomes a test" : "");
              const deciding = () => isOpenProposal(l()) && props.editable && !anim() && n() !== null;
              return (
                <div
                  class={`row ${l().by || "h"} ${r().cls ?? ""}`}
                  classList={{ chg: !!l().chg }}
                  style={{ "--d": `${r().delay ?? 0}ms` }}
                >
                  <div class="g">
                    <span class="bar" />
                    <Show when={n() !== null} fallback={<span />}>
                      <button type="button" class="no" tabIndex={-1} title={`Comment on this line · ${keys.comment.label}`} disabled={!props.editable} onClick={() => startThread(n()!)}>
                        {n()! + 1}
                      </button>
                    </Show>
                    <span class="mk" classList={{ pop: !!r().pop }}>
                      <Show when={st()}>{(s) => <i class={`m m-${s()}`} title={STATUS_LABEL[s()]} aria-label={STATUS_LABEL[s()]}>{STATUS_MARK[s()]}</i>}</Show>
                    </span>
                  </div>
                  <div class={`ln ${l().kind ? `k-${l().kind}` : ""}`}>
                    {indent()}
                    <span class="tx" innerHTML={decorate(body(), symRe())} />
                    <span class="aside">
                      <Show when={!anim() && onCaretLine(n()) && ghost()}>
                        <span class="ghost">{ghost()}</span>
                        <span class="tabkey">Tab</span>
                      </Show>
                      <Show when={tabLeaves() && keysOn(n())}>
                        <span class="tabkey">Tab leaves the plan</span>
                      </Show>
                      <Show when={body() && chip()}><span class="chip">{chip()}</span></Show>
                      <Show when={deciding()}>
                        <span class="decide">
                          <button type="button" tabIndex={-1} title="Keep it as a plain line of the plan" onMouseDown={keepFocus} onClick={() => accept(n()!)}>
                            Accept<Show when={keysOn(n())}> <kbd>{keys.keep.label}</kbd></Show>
                          </button>
                          <button type="button" tabIndex={-1} title="Delete it" onMouseDown={keepFocus} onClick={() => reject(n()!)}>
                            Reject<Show when={keysOn(n())}> <kbd>{keys.reject.label}</kbd></Show>
                          </button>
                        </span>
                      </Show>
                      <Show when={r().to}><span class="chip">→ {r().to}</span></Show>
                      <Show when={!anim() && n() !== null}>
                        <For each={openOn().get(n()!)}>
                          {(t) => <ThreadPin thread={t} editable={props.editable} onPass={props.onPass} />}
                        </For>
                        <Show when={openId() === "new" && draftLine() === n()}>
                          <ThreadPin editable={props.editable} onPass={props.onPass} />
                        </Show>
                      </Show>
                    </span>
                    <Show when={r().was}><span class="was">{r().was}</span></Show>
                  </div>
                </div>
              );
            }}
          </Index>
        </div>
        <div class="rail">
          <Index each={anim() ? [] : rail()}>
            {(w) => (
              <div class="ways" style={{ top: `${w().top}px`, height: `${w().height}px` }}>
                <div class="ways-row">
                  <button type="button" tabIndex={-1} aria-label="Previous way" title="Other ways to do this" disabled={!props.editable} onMouseDown={keepFocus} onClick={() => cycle(w().choice, -1)}>‹</button>
                  <span>{w().choice.current + 1} of {w().choice.options.length}</span>
                  <button type="button" tabIndex={-1} aria-label="Next way" title="Other ways to do this" disabled={!props.editable} onMouseDown={keepFocus} onClick={() => cycle(w().choice, 1)}>›</button>
                  <button type="button" tabIndex={-1} class="use" title="Keep this way and drop the others" disabled={!props.editable} onMouseDown={keepFocus} onClick={() => settle(w().choice)}>
                    Use this<Show when={inChoice(w().choice)}> <kbd>{keys.keep.label}</kbd></Show>
                  </button>
                </div>
                <Show when={inChoice(w().choice)}>
                  <div class="ways-keys"><kbd>{keys.alt}{brackets().prev}</kbd> <kbd>{keys.alt}{brackets().next}</kbd></div>
                </Show>
              </div>
            )}
          </Index>
        </div>
        <div id={describeId} class="sr-only" role="status">{described()}</div>
        <Show when={copy()} keyed>
          {(_copy) => (
            <textarea
              ref={ta}
              spellcheck={false}
              autocapitalize="off"
              autocomplete="off"
              aria-label="Plan text"
              aria-describedby={describeId}
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
              readOnly={!props.editable}
              style={{ visibility: anim() ? "hidden" : "visible" }}
              onInput={onInput}
              onKeyDown={onKeyDown}
              onKeyUp={readCaret}
              onFocus={() => setActive(true)}
              onBlur={() => { setActive(false); setTabLeaves(false); }}
              onClick={readCaret}
              onSelect={readCaret}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
