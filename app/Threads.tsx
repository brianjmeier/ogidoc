import { For, Show } from "solid-js";
import { Popover } from "@kobalte/core/popover";
import { TextField } from "@kobalte/core/text-field";
import { Button } from "@kobalte/core/button";
import type { Thread, Who } from "../src/types.ts";
import { close, draft, openId, pending, resolve, send, setDraft, setOpenId } from "./threads.ts";
import { passKey } from "./text.ts";

const NAME: Record<Who, string> = { a: "Agent", h: "You" };
const INITIAL: Record<Who, string> = { a: "A", h: "Y" };

// A comment pinned at the end of a plan line, Figma style: the pin shows who asked and
// the start of what they said; clicking it opens the thread with a reply box.
// Without a `thread` it is the person's new comment on that line.
export function ThreadPin(props: { thread?: Thread; editable: boolean; onPass: () => void }) {
  const key = () => props.thread?.id ?? "new";
  const by = () => props.thread?.by ?? "h";
  const isOpen = () => openId() === key();
  const peek = () => {
    const first = props.thread?.messages[0]?.text ?? "";
    return first.length > 52 ? `${first.slice(0, 50)}…` : first;
  };

  const onKeyDown = async (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.altKey) return;
    e.preventDefault();
    await send(key(), props.thread);
    if (e.metaKey || e.ctrlKey) props.onPass();
  };

  return (
    <Popover open={isOpen()} onOpenChange={(o) => (o ? setOpenId(key()) : close())} placement="bottom-start" gutter={6}>
      <Popover.Trigger class={`pin-btn ${by()}`} aria-label={props.thread ? `Comment from ${NAME[by()]}` : "New comment"}>
        <i class={`pin ${by()}`}>{INITIAL[by()]}</i>
        <Show when={props.thread && !isOpen()}>
          <span class="peek">{peek()}</span>
        </Show>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="card">
          <For each={props.thread?.messages ?? []}>{(m) => <Msg by={m.by} text={m.text} />}</For>
          <For each={pending(key(), props.thread)}>{(m) => <Msg by="h" text={m.text} sending />}</For>
          <Show when={props.editable}>
            <TextField class="reply" value={draft(key())} onChange={(v) => setDraft(key(), v)}>
              <TextField.TextArea autoResize rows={1} data-gramm="false" data-enable-grammarly="false" placeholder={props.thread ? "Reply" : "Ask or note something about this line"} onKeyDown={onKeyDown} />
            </TextField>
            <div class="card-acts">
              <Show when={props.thread}>
                <Button class="btn ghost-btn" onClick={() => resolve(props.thread!.id)}>Resolve</Button>
              </Show>
              <Button class="btn primary" disabled={!draft(key()).trim()} onClick={() => send(key(), props.thread)}>
                {props.thread ? "Reply" : "Comment"}
              </Button>
            </div>
            <div class="keys">Enter sends · {passKey} Enter sends and hands over</div>
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}

function Msg(props: { by: Who; text: string; sending?: boolean }) {
  return (
    <div class="msg" classList={{ sending: props.sending }}>
      <i class={`pin ${props.by}`}>{INITIAL[props.by]}</i>
      <div>
        <div class="who">{NAME[props.by]}{props.sending ? " · sending…" : ""}</div>
        <p>{props.text}</p>
      </div>
    </div>
  );
}
