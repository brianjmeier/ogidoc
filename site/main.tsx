import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Scene } from "./Scene.tsx";
import { abstractions, choices, frames, promptWithCode, styles } from "./scenes.ts";
import "../app/style.css";
import "./site.css";

const INSTALL = "npm install -g github:brianjmeier/ogidoc";
const REPO = "https://github.com/brianjmeier/ogidoc";

function Install() {
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard (an insecure origin, or the visitor said no): the command stays selectable.
    }
  };
  return (
    <div class="install">
      <code><span class="prompt" aria-hidden="true">$ </span>{INSTALL}</code>
      <button type="button" class="copy" onClick={copy}>{copied() ? "Copied" : "Copy"}</button>
    </div>
  );
}

function Page() {
  return (
    <main class="site">
      <header class="hero">
        <h1 class="brand wordmark"><span class="word">ogidoc</span></h1>
        <p class="lede">Write code that wouldn't compile. Get a program that&nbsp;does.</p>
        <p class="sub">You and an agent take turns on one pseudocode file. You make the structure and architecture decisions; the agent turns each line into real code, test first, and marks it built.</p>
        <div class="get">
          <Install />
          <a class="repo" href={REPO}>Source on GitHub</a>
        </div>
        <p class="run">then <code>ogidoc tic_tac_toe.plan</code></p>
      </header>
      <section class="beat">
        <div class="copy-col">
          <h2>Coding is slow but fun. You can prompt with code.</h2>
          <p>Write a line of pseudocode and hand over. The agent writes a failing test, makes it pass, and the line is built.</p>
        </div>
        <Scene label="A pseudocode line gets built" start={promptWithCode.start} frames={frames(promptWithCode.start, promptWithCode.beats)} />
      </section>
      <section class="beat">
        <div class="copy-col">
          <h2>When code gets complicated, abstractions get created for you.</h2>
          <p>Once a piece settles, it folds into a named box and leaves one line behind, so the plan stays short enough to think in.</p>
        </div>
        <Scene label="Settled lines fold into a named box" start={abstractions.start} frames={frames(abstractions.start, abstractions.beats)} />
      </section>
      <section class="beat">
        <div class="copy-col">
          <h2>When the agent has a question, it builds its best guess and shows you the other ways.</h2>
          <p>The other way sits on the same lines. Switch to it and hand over, and the agent builds that one instead.</p>
        </div>
        <Scene label="The agent offers another way and builds the one you pick" start={choices.start} frames={frames(choices.start, choices.beats)} />
      </section>
      <section class="beat">
        <div class="copy-col">
          <h2>Write pseudocode the way you think. The agent writes in your style.</h2>
          <p>Python, C, Lisp, or plain words. There is no syntax to learn; the agent's lines read like yours.</p>
        </div>
        <div class="styles">
          <Scene label="Python-like pseudocode, and the agent's line in the same style" under={false} start={styles.python.start} frames={frames(styles.python.start, styles.python.beats)} />
          <Scene label="JavaScript-like pseudocode, and the agent's line in the same style" under={false} start={styles.js.start} frames={frames(styles.js.start, styles.js.beats)} />
          <Scene label="Clojure-like pseudocode, and the agent's line in the same style" under={false} start={styles.clojure.start} frames={frames(styles.clojure.start, styles.clojure.beats)} />
        </div>
      </section>
      <footer class="end">
        <p class="note">Code is more precise than prose for software. That's the whole reason it exists. So keep writing code, leave out the parts that bore you, and let the agent make it&nbsp;run.</p>
        <Install />
        <p class="links"><span class="brand">ogidoc</span><a href={REPO}>GitHub</a><a href={`${REPO}#readme`}>Read the docs</a><span>MIT licensed</span></p>
      </footer>
    </main>
  );
}

render(() => <Page />, document.getElementById("root")!);
