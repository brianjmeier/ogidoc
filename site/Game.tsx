import { For, createSignal } from "solid-js";
// The game the demo's agent builds: the very files `ogidoc --demo` leaves in its folder.
import { click, newGame, over, status } from "../demo/game/src/game.js";

type Game = ReturnType<typeof newGame>;

// What the demo built, running: a window with the board, to play.
export function Game() {
  const [game, setGame] = createSignal<Game>(newGame());
  return (
    <figure class="built" aria-label="The tic-tac-toe game the demo builds, to play">
      <div class="built-top">
        <span class="file">tic-tac-toe · index.html</span>
      </div>
      <div class="built-body">
        <div class="board">
          <For each={game().board}>
            {(mark, i) => (
              <button type="button" aria-label={`Cell ${i() + 1}${mark ? `, ${mark}` : ""}`} onClick={() => setGame(click(game(), i()))}>
                {mark ?? ""}
              </button>
            )}
          </For>
        </div>
        <p class="status" aria-live="polite">{status(game())}</p>
        <button type="button" class="again" style={{ visibility: over(game()) ? "visible" : "hidden" }} onClick={() => setGame(newGame())}>
          Play again
        </button>
      </div>
    </figure>
  );
}
