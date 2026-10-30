import { render } from "solid-js/web";
import { Scene } from "./Scene.tsx";
import { abstractions, choices, frames, promptWithCode } from "./scenes.ts";
import "../app/style.css";
import "./site.css";

function Page() {
  return (
    <main class="site">
      <header class="hero">
        <h1 class="brand">Underpaint</h1>
        <p>Build software by taking turns with an agent on one pseudocode file. The real code is built underneath.</p>
        <code>npm install -g github:brianjmeier/underpaint</code>
      </header>
      <section>
        <h2>Coding is slow but fun. You can prompt with code.</h2>
        <Scene label="A pseudocode line gets built" start={promptWithCode.start} frames={frames(promptWithCode.start, promptWithCode.beats)} />
      </section>
      <section>
        <h2>When code gets complicated, abstractions get created for you.</h2>
        <Scene label="Settled lines fold into a named box" start={abstractions.start} frames={frames(abstractions.start, abstractions.beats)} />
      </section>
      <section>
        <h2>When the agent has a question, it builds its best guess and shows you the other ways.</h2>
        <Scene label="The agent offers another way and builds the one you pick" start={choices.start} frames={frames(choices.start, choices.beats)} />
      </section>
    </main>
  );
}

render(() => <Page />, document.getElementById("root")!);
