import { For, Show } from "solid-js";
import type { Smell } from "../src/types.ts";
import { smellIds, tangleWords } from "../src/shared/smells.ts";
import { namesOf, type Wire } from "./map/layout.ts";

// The tangles the scan sees on the level on show, each with what makes it true and a way
// into fixing it: a line in the plan for the next turn.

const sameTangle = (a: Smell | null, b: Smell | null) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

export function Tangles(props: {
  smells: Smell[];
  wires: Wire[];
  nameOf: (id: string) => string;
  picked: Smell | null;
  editable: boolean;
  onPick: (s: Smell | null) => void;
  onFix: (line: string) => void;
}) {
  const short = (path: string) => path.split("/").slice(-2).join("/");
  // The imports behind the arrows between the boxes a tangle names, file to file.
  const evidence = (s: Smell) => {
    const ids = smellIds(s);
    return props.wires.filter((w) => ids.includes(w.from) && ids.includes(w.to)).flatMap((w) => w.members).slice(0, 8);
  };
  return (
    <Show when={props.smells.length}>
      <section class="tangles" aria-label="Tangles">
        <div class="pane-label">Tangles</div>
        <ul>
          <For each={props.smells.slice(0, 40)}>
            {(s) => {
              const words = () => tangleWords(s, props.nameOf);
              const on = () => sameTangle(props.picked, s);
              return (
                <li>
                  <button type="button" class="tangle" classList={{ on: on() }} aria-expanded={on()} onClick={() => props.onPick(on() ? null : s)}>
                    <span class="tk">{s.kind}</span>
                    <span class="tw">{words()[0]}</span>
                    <small>{words()[1]}</small>
                  </button>
                  <Show when={on()}>
                    <ul class="evidence">
                      <For each={evidence(s)} fallback={<li>{s.kind === "change together" ? "seen in git history, not in the imports" : "seen in the file itself"}</li>}>
                        {(e) => <li title={`${e.from} imports ${namesOf(e.symbols ?? []) || "it"} from ${e.to}`}>{short(e.from)} → {short(e.to)}</li>}
                      </For>
                    </ul>
                    <button type="button" class="btn fix" disabled={!props.editable} onClick={() => props.onFix(`untangle ${words()[0]}: ${words()[1]}`)}>
                      Fix this
                    </button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Show>
  );
}
