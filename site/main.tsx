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

// A terminal beside the editor: the session runs in the background, and the chat keeps
// the terminal for everything that isn't the plan.
const BESIDE: { kind: "cmd" | "out" | "ask" | "tool"; text: string }[] = [
  { kind: "cmd", text: "ogidoc tic-tac-toe --detach" },
  { kind: "out", text: "Ogidoc session tic-tac-toe is open at http://127.0.0.1:4747" },
  { kind: "cmd", text: "claude" },
  { kind: "ask", text: "when the agent's turn is done, run the tests and open a PR" },
  { kind: "tool", text: "ogidoc wait" },
  { kind: "out", text: "Last turn: the board now finds a winner in rows, columns and diagonals." },
  { kind: "out", text: "Commit: 3f9c2a1" },
  { kind: "tool", text: "npm test" },
  { kind: "out", text: "18 passing" },
  { kind: "tool", text: "gh pr create, from a worktree of its own" },
  { kind: "out", text: "https://github.com/you/tic-tac-toe/pull/12" },
];

// What each line is, for a screen reader, since the marks are only drawn.
const SAYS = { cmd: "You run:", ask: "You ask the chat:", tool: "The chat runs:", out: "Output:" };

function Beside() {
  return (
    <figure class="terminal" aria-label="A chat in the terminal works beside a running session">
      <div class="terminal-top"><span>~/tic-tac-toe</span></div>
      <pre>
        {BESIDE.map((l) => (
          <span class={`t-${l.kind}`}>
            <span class="sr-only">{SAYS[l.kind]} </span>
            <span class="t-mark" aria-hidden="true">{{ cmd: "$ ", ask: "› ", tool: "● ", out: "  " }[l.kind]}</span>
            {l.text}
          </span>
        ))}
      </pre>
    </figure>
  );
}

function Page() {
  return (
    <main class="site">
      <header class="hero">
        <h1 class="brand wordmark"><span class="word">ogidoc</span></h1>
        <p class="lede"><span>Write code that wouldn't&nbsp;compile.</span><span> Get a&nbsp;program that&nbsp;does.</span></p>
        <p class="sub">You and an agent take turns on one pseudocode file. You make the structure and architecture decisions; the agent turns each line into real code, test first, and marks it&nbsp;built.</p>
        <div class="get">
          <Install />
          <a class="repo" href={REPO}>Source on GitHub</a>
        </div>
        <p class="run">then <code>ogidoc tic-tac-toe</code></p>
      </header>
      <section class="beat">
        <div class="copy-col">
          <h2><span>The agent codes in&nbsp;seconds.</span><span> You spend minutes describing what you&nbsp;want.</span></h2>
          <p>Write a line of pseudocode and hand over. The agent writes a failing test, makes it pass, and the line is&nbsp;built.</p>
        </div>
        <Scene label="A pseudocode line gets built" start={promptWithCode.start} frames={frames(promptWithCode.start, promptWithCode.beats)} />
      </section>
      <section class="beat">
        <div class="copy-col">
          <h2>When code gets complicated, abstractions get created for&nbsp;you.</h2>
          <p>Once a piece settles, it folds into a named box and leaves one line behind, so the plan stays short enough to think&nbsp;in.</p>
        </div>
        <Scene label="Settled lines fold into a named box" start={abstractions.start} frames={frames(abstractions.start, abstractions.beats)} />
      </section>
      <section class="beat">
        <div class="copy-col">
          <h2><span>When&nbsp;a&nbsp;decision&nbsp;matters, you&nbsp;choose.</span><span> Every option is already in the&nbsp;plan.</span></h2>
          <p>The other way sits on the same lines. Switch to it and hand over, and the agent builds that one&nbsp;instead.</p>
        </div>
        <Scene label="The agent offers another way and builds the one you pick" start={choices.start} frames={frames(choices.start, choices.beats)} />
      </section>
      <section class="beat">
        <div class="copy-col">
          <h2><span>Write pseudocode the way you&nbsp;think.</span><span> The agent writes in your&nbsp;style.</span></h2>
          <p>Python, C, Lisp, or plain words. There is no syntax to learn; the agent's lines read like&nbsp;yours.</p>
        </div>
        <div class="styles">
          <Scene label="Python-like pseudocode, and the agent's line in the same style" under={false} start={styles.python.start} frames={frames(styles.python.start, styles.python.beats)} />
          <Scene label="JavaScript-like pseudocode, and the agent's line in the same style" under={false} start={styles.js.start} frames={frames(styles.js.start, styles.js.beats)} />
          <Scene label="Clojure-like pseudocode, and the agent's line in the same style" under={false} start={styles.clojure.start} frames={frames(styles.clojure.start, styles.clojure.beats)} />
        </div>
      </section>
      <section class="beat">
        <div class="copy-col">
          <h2><span>Keep your&nbsp;chat.</span><span> Ogidoc runs beside&nbsp;it.</span></h2>
          <p>Start a session in the background and your Claude Code or pi chat keeps the terminal for tests, the app and pull requests. It reads the session, and the turns stay between you and the plan&nbsp;agent.</p>
        </div>
        <Beside />
      </section>
      <footer class="end">
        <p class="note"><span>Code exists because prose isn't precise&nbsp;enough.</span><span> Write the parts that matter, wave&nbsp;at&nbsp;the&nbsp;rest, and the agent makes it&nbsp;run.</span></p>
        <Install />
        <p class="links"><span class="brand">ogidoc</span><a href={REPO}>GitHub</a><a href={`${REPO}#readme`}>Read the docs</a><span>MIT licensed</span></p>
      </footer>
    </main>
  );
}

render(() => <Page />, document.getElementById("root")!);
