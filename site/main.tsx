import { render } from "solid-js/web";
import { Scene } from "./Scene.tsx";
import { frames, promptWithCode } from "./scenes.ts";
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
    </main>
  );
}

render(() => <Page />, document.getElementById("root")!);
