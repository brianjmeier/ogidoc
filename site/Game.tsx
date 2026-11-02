import { createSignal } from "solid-js";

const CELLS = [1, 4, 2, 5, 3];

// The page the demo's agent builds, as it is: demo/game/index.html in a frame, with its
// own plain styling. It stays an empty page until the plan is built, then loads and
// plays X across the top row, and is the visitor's to play from there.
export function Game(props: { ref: (api: GameApi) => void }) {
  let frame!: HTMLIFrameElement;
  const [src, setSrc] = createSignal("about:blank");
  let played = false;
  let touched = false;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function play() {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.addEventListener("pointerdown", (e) => { if (e.isTrusted) touched = true; });
    await wait(700);
    for (const n of CELLS) {
      if (touched) return;
      doc.querySelector<HTMLButtonElement>(`button[aria-label="Cell ${n}"]`)?.click();
      await wait(480);
    }
  }

  props.ref({
    // Built: open the page and play it, once.
    built() {
      if (played) return;
      played = true;
      setSrc("/game/index.html");
    },
    // The scene starts over: back to an empty page, unless the visitor is playing.
    reset() {
      if (touched) return;
      played = false;
      setSrc("about:blank");
    },
  });

  return (
    <figure class="built">
      <div class="built-top"><span class="file">index.html</span></div>
      <iframe ref={frame} src={src()} title="The tic-tac-toe page the demo builds" onLoad={() => src() !== "about:blank" && play()} />
    </figure>
  );
}

export interface GameApi {
  built(): void;
  reset(): void;
}
