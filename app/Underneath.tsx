import { For, Show } from "solid-js";
import type { LastTurn } from "../src/types.ts";

// What the last agent turn built underneath the plan: its steps, files and checks.
export function Underneath(props: { last: LastTurn | null; open?: boolean }) {
  const has = () => !!props.last && !!(props.last.summary || props.last.files?.length);
  return (
    <details class="under" open={props.open}>
      <summary>
        <span class="lab">Underneath</span>
        <span>{has() ? `${props.last!.summary || ""}${props.last!.seconds ? ` · ${props.last!.seconds}s` : ""}` : "No code yet"}</span>
      </summary>
      <div class="under-body">
        <Show when={has()} fallback={<p class="why">Nothing has been built yet.</p>}>
          <Show when={props.last!.steps?.length}>
            <div class="tags">
              <For each={props.last!.steps}>{(st) => <><StepTag kind={st.kind} /><span class="why">{st.what}</span></>}</For>
            </div>
          </Show>
          <Show when={props.last!.files?.length}>
            <ul>
              <For each={props.last!.files}>
                {(f) => <li><span class="op">{f.op}</span><span><span class="path">{f.path}</span> <span class="why">{f.why}</span></span></li>}
              </For>
            </ul>
          </Show>
          <Show when={props.last!.checks?.length}>
            <div class="tags">
              <For each={props.last!.checks}>{(c) => <span class="tag" classList={{ bad: !c.ok }}>{c.ok ? "✓" : "✕"} {c.name}</span>}</For>
            </div>
          </Show>
        </Show>
      </div>
    </details>
  );
}

function StepTag(props: { kind: string }) {
  if (props.kind === "red-green") return <><span class="tag r">red</span><span class="tag">green</span></>;
  if (props.kind === "refactor") return <span class="tag">refactor</span>;
  if (props.kind === "stop") return <span class="tag q">? stop</span>;
  if (props.kind === "done") return <span class="tag">done</span>;
  return <span class="tag">{props.kind}</span>;
}
