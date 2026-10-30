import { Show, createMemo } from "solid-js";
import { Button } from "@kobalte/core/button";
import { Select } from "@kobalte/core/select";
import type { Snapshot } from "../src/types.ts";
import { post } from "./api.ts";
import { confirmed, type Confirmed } from "./confirm.ts";
import { keys } from "./text.ts";
const DEFAULT = "default";

interface Props {
  state: Snapshot;
  // `seconds` counts up beside the label while the agent works.
  turn: { cls: string; label: string; seconds?: number };
  passing: boolean;
  onPass: () => void;
  undo: Confirmed;
  // Whether the undo key would undo the agent's turn right now.
  undoKey: boolean;
  // Moves to the next line that waits on the person, when one does.
  onNext?: () => void;
}

export function TopBar(props: Props) {
  const remove = confirmed(() => post("/api/finish"));

  return (
    <header class="top">
      <span class="brand">Ogidoc</span>
      <span class="file">{props.state.planPath} · {props.state.agent}</span>
      <span class="spacer" />
      <Show when={props.state.settingOptions.models.length}>
        <Model state={props.state} />
      </Show>
      <Show when={props.state.settingOptions.efforts.length}>
        <Effort state={props.state} />
      </Show>
      <Show when={props.state.canUndo}>
        <Button class="btn ghost-btn" onClick={props.undo.click}>
          {props.undo.armed() ? "Undo it?" : "Undo agent turn"}
          <Show when={props.undoKey}> <kbd>{keys.undo.label}</kbd></Show>
          <Show when={props.undo.armed()}>{props.undoKey ? " again" : " Click again"}</Show>
        </Button>
      </Show>
      <Show when={props.turn.cls === "done"}>
        <Button class="btn ghost-btn" onClick={remove.click}>{remove.armed() ? "Delete it? Click again" : "Delete the plan"}</Button>
      </Show>
      <Show when={props.onNext}>
        <Button class="btn ghost-btn" onClick={() => props.onNext!()}>
          Next to decide <kbd>{keys.jump.label}</kbd>
        </Button>
      </Show>
      <span class={`turn ${props.turn.cls}`} classList={{ passing: props.passing }}>
        <i class="dot" />
        <span>{props.turn.label}{props.turn.seconds === undefined ? "" : ` ${props.turn.seconds}s`}</span>
      </span>
      <Button class="btn primary" disabled={props.state.working} onClick={props.onPass}>
        Hand over <kbd>{keys.pass.label}</kbd>
      </Button>
    </header>
  );
}

const LABEL: Record<string, string> = { xhigh: "Extra high" };
const label = (v: string) => LABEL[v] ?? v.charAt(0).toUpperCase() + v.slice(1);

// The model the next turn runs with, from the aliases the agent CLI knows. A full
// model name set elsewhere still shows, so picking never loses it.
function Model(props: { state: Snapshot }) {
  const current = () => props.state.settings.model;
  const options = createMemo(() => [...new Set([DEFAULT, ...props.state.settingOptions.models, ...(current() ? [current()] : [])])]);
  return <Picker name="model" state={props.state} options={options()} value={current()} />;
}

// How hard the next turn thinks, in the agent CLI's own levels.
function Effort(props: { state: Snapshot }) {
  const efforts = createMemo(() => [DEFAULT, ...props.state.settingOptions.efforts]);
  return <Picker name="effort" state={props.state} options={efforts()} value={props.state.settings.effort} />;
}

// Empty means the CLI's own default.
function Picker(props: { name: "model" | "effort"; state: Snapshot; options: string[]; value: string }) {
  return (
    <Select<string>
      class="pick"
      options={props.options}
      value={props.value || DEFAULT}
      onChange={(v) => v && post("/api/settings", { [props.name]: v === DEFAULT ? "" : v })}
      disabled={props.state.working}
      gutter={4}
      itemComponent={(p) => (
        <Select.Item item={p.item} class="option">
          <Select.ItemLabel>{label(p.item.rawValue)}</Select.ItemLabel>
        </Select.Item>
      )}
    >
      <Select.Label>{props.name}</Select.Label>
      <Select.Trigger class="select" aria-label={props.name}>
        <Select.Value<string>>{(s) => label(s.selectedOption())}</Select.Value>
        <Select.Icon class="caret">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content class="menu">
          <Select.Listbox />
        </Select.Content>
      </Select.Portal>
    </Select>
  );
}
