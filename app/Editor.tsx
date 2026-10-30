import { For, Index, Show, createMemo, createSignal } from "solid-js";
import { acceptProposal, anyBuilt, carryMeta, diffLines, joinLines, splitLines } from "../src/shared/diff.ts";
import { choose, follow } from "../src/choices.ts";
import type { AnimationOp, Choice, Line, Thread } from "../src/types.ts";
import { state } from "./api.ts";
import { STATUS_LABEL, STATUS_MARK, altKey, decorate, isPassKey, symbolPattern } from "./text.ts";
import { ThreadPin } from "./Threads.tsx";
import { draftLine, openId, startThread } from "./threads.ts";

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

// What the editor shows: the plan's lines and the choices offered on them.
type Shown = { lines: Line[]; choices?: Choice[] };

export interface EditorApi {
  adopt(next: Shown): void;
  animate(ops: AnimationOp[], oldLines: Line[], next: Shown): Promise<void>;
  text(): string;
  lines(): Line[];
  takeAccepted(): number[];
  focus(): void;
}

interface Props {
  ref: (api: EditorApi) => void;
  editable: boolean;
  working: boolean;
  threads: Thread[];
  onEdit: () => void;
  // Switch a choice; `before` is the plan text from just before the switch.
  onChoose: (choice: string, option: number, before: string) => void;
  onPass: () => void;
  onHint: (hint: string) => void;
}

export function Editor(props: Props) {
  let ta!: HTMLTextAreaElement;
  const [lines, setLines] = createSignal<Line[]>([]);
  // The choices follow the person's typing here the same way they do on the server.
  const [choices, setChoices] = createSignal<Choice[]>([]);
  const symbols = () => state()?.symbols ?? [];
  const suggestions = () => state()?.suggestions ?? [];
  const built = () => !!state() && anyBuilt(state()!.lines, state()!.boxes);
  const [caret, setCaret] = createSignal({ line: 0, col: 0, collapsed: true });
  const [ghostOff, setGhostOff] = createSignal(false);
  const [anim, setAnim] = createSignal<Row[] | null>(null);
  const accepted = new Set<number>();
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

  const rows = (): Row[] => anim() ?? lines().map((line, n) => ({ line, n }));
  // Which choice each line belongs to.
  const choiceAt = createMemo(() => {
    const at = new Map<number, Choice>();
    for (const c of choices()) for (let i = 0; i < c.options[c.current].length; i++) at.set(c.line + i, c);
    return at;
  });
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
    props.onEdit();
  }

  function insert(s: string) {
    ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, "end");
    onInput();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (isPassKey(e)) {
      e.preventDefault();
      props.onPass();
      return;
    }
    if (!props.editable) return;
    // The caret may have moved without a click or a key, from a script or a drop.
    readCaret();
    const c = choiceAt().get(caret().line);
    if (c && e.altKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
      e.preventDefault();
      cycle(c, e.code === "BracketRight" ? 1 : -1);
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      insert(ghost() || "  ");
    } else if (e.key === "Escape" && ghost()) {
      setGhostOff(true);
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      // Keep the indentation of the line above.
      const indent = (lines()[caret().line]?.text.match(/^\s*/) || [""])[0];
      e.preventDefault();
      insert("\n" + indent);
    }
  }

  // ---------- proposals ----------

  function accept(n: number) {
    setLines((ls) => ls.map((l, i) => (i === n ? acceptProposal(l, built()) : l)));
    accepted.add(n);
    props.onEdit();
  }

  function reject(n: number) {
    const texts = lines().map((l) => l.text);
    texts.splice(n, 1);
    ta.value = texts.join("\n");
    onInput();
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
    props.onChoose(c.id, option, before);
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

  function adopt(next: Shown) {
    setLines(next.lines);
    setChoices(next.choices ?? []);
    accepted.clear();
    const text = joinLines(next.lines);
    if (ta.value !== text) ta.value = text;
  }

  props.ref({
    adopt,
    animate,
    text: () => ta.value,
    lines,
    takeAccepted: () => { const a = [...accepted]; accepted.clear(); return a; },
    focus: () => ta.focus({ preventScroll: true }),
  });

  return (
    <div class="scroller">
      <div class="code" classList={{ working: props.working }}>
        <div class="rows">
          <Index each={rows()}>
            {(r) => {
              const l = () => r().line;
              const n = () => r().n;
              const indent = () => l().text.match(/^\s*/)![0];
              const body = () => l().text.slice(indent().length);
              const st = () => (l().text.trim() ? l().status : null);
              const chip = () => (l().kind === "example" ? "becomes a test" : "");
              const deciding = () => l().kind === "proposal" && props.editable && !anim() && n() !== null;
              const choice = () => (anim() || n() === null ? undefined : choiceAt().get(n()!));
              const span = () => choice() && { first: choice()!.line === n(), last: choice()!.line + choice()!.options[choice()!.current].length - 1 === n() };
              return (
                <div
                  class={`row ${l().by || "h"} ${r().cls ?? ""}`}
                  classList={{ chg: !!l().chg, "in-choice": !!span(), "choice-first": !!span()?.first, "choice-last": !!span()?.last }}
                  style={{ "--d": `${r().delay ?? 0}ms` }}
                >
                  <div class="g">
                    <span class="bar" />
                    <Show when={n() !== null} fallback={<span />}>
                      <button type="button" class="no" title="Comment on this line" disabled={!props.editable} onClick={() => startThread(n()!)}>
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
                      <Show when={!anim() && n() === caret().line && ghost()}>
                        <span class="ghost">{ghost()}</span>
                        <span class="tabkey">Tab</span>
                      </Show>
                      <Show when={body() && chip()}><span class="chip">{chip()}</span></Show>
                      <Show when={body() && deciding()}>
                        <span class="decide">
                          <button type="button" title="Keep it as a plain line of the plan" onClick={() => accept(n()!)}>Accept</button>
                          <button type="button" title="Delete it" onClick={() => reject(n()!)}>Reject</button>
                        </span>
                      </Show>
                      <Show when={span()?.first && choice()}>
                        {(c) => (
                          <span class="ways" title={`Other ways to do this · ${altKey}[ and ${altKey}] switch`}>
                            <button type="button" aria-label="Previous way" disabled={!props.editable} onClick={() => cycle(c(), -1)}>‹</button>
                            <span>{c().current + 1} of {c().options.length}</span>
                            <button type="button" aria-label="Next way" disabled={!props.editable} onClick={() => cycle(c(), 1)}>›</button>
                          </span>
                        )}
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
        <textarea
          ref={ta}
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          aria-label="Plan text"
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
          readOnly={!props.editable}
          style={{ visibility: anim() ? "hidden" : "visible" }}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onKeyUp={readCaret}
          onClick={readCaret}
          onSelect={readCaret}
        />
      </div>
    </div>
  );
}
