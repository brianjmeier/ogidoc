import { diffLines, splitLines } from "../src/shared/diff.ts";
import { choose } from "../src/choices.ts";
import { edit, fromReply, type Plan } from "../src/plan.ts";
import type { AnimationOp, BoxChanges, LastTurn, Line, Reply } from "../src/types.ts";

// The site's scenes are written as turns, and played through the same plan code the
// editor runs: the person's typing goes through `edit`, the agent's reply through
// `fromReply`, so marks, authorship and the turn animation are the real ones.

// The person rewrites the plan to `person` or switches the first open choice to `pick`,
// or the agent replies with `agent`.
export type Beat =
  | { person: string }
  | { pick: number }
  | { agent: Partial<Reply> & Pick<Reply, "plan">; last: LastTurn };

export type Frame =
  | { kind: "type"; plan: Plan; picked?: true }
  | { kind: "turn"; plan: Plan; animation: AnimationOp[]; boxChanges: BoxChanges; last: LastTurn };

const NO_REPLY: Omit<Reply, "plan"> = { boxes: [], choices: [], replies: [], symbols: [], suggestions: [], steps: [], files: [], checks: [], summary: "" };

export function frames(start: Plan, beats: Beat[]): Frame[] {
  const out: Frame[] = [];
  let plan = start;
  let turn = 1;
  for (const beat of beats) {
    if ("person" in beat) {
      for (const text of keystrokes(plan.lines.map((l) => l.text), splitLines(beat.person))) {
        plan = edit(plan, { text });
        out.push({ kind: "type", plan });
      }
    } else if ("pick" in beat) {
      plan = { ...plan, ...choose(plan.lines, plan.choices, plan.choices[0].id, beat.pick) };
      out.push({ kind: "type", plan, picked: true });
    } else {
      const r = fromReply(plan, { ...NO_REPLY, ...beat.agent }, turn++);
      plan = r.plan;
      out.push({ kind: "turn", plan, animation: r.animation, boxChanges: r.boxChanges, last: beat.last });
    }
  }
  return out;
}

// The plan text after each keystroke on the way from `old` to `next`: removed lines go
// first, then each new or edited line is typed out one character at a time. An edited
// line first loses whatever differs at its end.
export function keystrokes(old: string[], next: string[]): string[] {
  const ops = diffLines(old, next);
  const shown: (string | null)[] = next.map(() => null);
  for (const o of ops) if (o.op === "eq") shown[o.b] = next[o.b];
  for (const o of ops) if (o.op === "mod") shown[o.b] = old[o.a];
  const text = () => shown.filter((s) => s !== null).join("\n");
  const out = ops.some((o) => o.op === "del") ? [text()] : [];
  for (const o of ops) {
    if (o.op !== "ins" && o.op !== "mod") continue;
    const target = next[o.b];
    const from = o.op === "mod" ? commonPrefix(old[o.a], target) : target.match(/^\s*/)![0].length;
    if (o.op === "mod" && old[o.a].length > from) {
      shown[o.b] = target.slice(0, from);
      out.push(text());
    }
    for (let k = from + 1; k <= target.length; k++) {
      shown[o.b] = target.slice(0, k);
      out.push(text());
    }
  }
  return out;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

const built = (text: string): Line => ({ text, by: "h", kind: null, status: "built" });
const builtReply = (lines: string[]) => lines.map((text) => ({ text, kind: null, status: "built" as const }));

const game = [
  "game tic_tac_toe:",
  "  board = 3x3 grid, all empty",
  "  turn = X",
];
const click = "  click(cell) -> put turn's mark there, swap turn";

// if (coding is slow but fun): you can prompt with code.
export const promptWithCode = {
  start: { lines: game.map(built), boxes: [], threads: [], choices: [] } satisfies Plan,
  beats: [
    { person: [...game, click].join("\n") },
    {
      agent: { plan: builtReply([...game, click]) },
      last: {
        summary: "Clicking a cell puts the current mark there and passes the turn",
        steps: [{ kind: "red-green", what: "X then O fill two cells" }],
        files: [
          { op: "+", path: "src/game.ts", why: "click(board, cell)" },
          { op: "+", path: "test/game.test.ts", why: "X then O fill two cells" },
        ],
        checks: [{ name: "npm test", ok: true }],
      },
    },
  ] satisfies Beat[],
};

const played = [...game, click];
const winnerRules = ["three in a row -> that mark", "three in a column -> that mark", "three on a diagonal -> that mark"];

// When code gets complicated: three settled lines fold into a named box and leave a
// one-line reference behind.
export const abstractions = {
  start: { lines: [...played, "  winner(board):", ...winnerRules.map((r) => `    ${r}`)].map(built), boxes: [], threads: [], choices: [] } satisfies Plan,
  beats: [
    { person: [...played, "  winner(board):", ...winnerRules.map((r) => `    ${r}`), "  game over when winner(board) or board is full"].join("\n") },
    {
      agent: {
        plan: builtReply([...played, "  winner(board) -> see winner", "  game over when winner(board) or board is full"]),
        boxes: [{ name: "winner", lines: winnerRules, status: "built", uses: [] }],
      },
      last: {
        summary: "The game ends on a win or a full board, and the winning lines moved into winner",
        steps: [{ kind: "red-green", what: "a full board with no line is a draw" }, { kind: "refactor", what: "winner holds the winning lines" }],
        files: [
          { op: "~", path: "src/game.ts", why: "gameOver(board)" },
          { op: "+", path: "src/winner.ts", why: "winner(board)" },
          { op: "+", path: "test/winner.test.ts", why: "X across the top wins" },
        ],
        checks: [{ name: "npm test", ok: true }],
      },
    },
  ] satisfies Beat[],
};

// When agents have questions: the agent builds its pick, shows the other way in place,
// and the person switches to it and hands over.
export const choices = {
  start: { lines: played.map(built), boxes: [], threads: [], choices: [] } satisfies Plan,
  beats: [
    { person: [...played, "  restart()"].join("\n") },
    {
      agent: {
        plan: builtReply([...played, "  restart()", "    clear board, X goes first"]),
        choices: [{ line: 5, options: [["    clear board, X goes first"], ["    clear board, loser goes first"]] }],
      },
      last: {
        summary: "Restart clears the board and X starts; the loser starting is the other way",
        steps: [{ kind: "red-green", what: "restart empties every cell" }],
        files: [{ op: "~", path: "src/game.ts", why: "restart(game)" }],
        checks: [{ name: "npm test", ok: true }],
      },
    },
    { pick: 1 },
    {
      agent: { plan: builtReply([...played, "  restart()", "    clear board, loser goes first"]) },
      last: {
        summary: "After a restart, whoever lost goes first",
        steps: [{ kind: "red-green", what: "O starts after X wins" }],
        files: [{ op: "~", path: "src/game.ts", why: "restart remembers the loser" }],
        checks: [{ name: "npm test", ok: true }],
      },
    },
  ] satisfies Beat[],
};

// The agent follows the person's style: the same game written three ways, and in each
// the agent's line reads like the person wrote it.
function inStyle(start: string[], typed: string[], done: string[]) {
  return {
    start: { lines: start.map(built), boxes: [], threads: [], choices: [] } satisfies Plan,
    beats: [
      { person: typed.join("\n") },
      {
        agent: { plan: builtReply(done) },
        last: {
          summary: "Clicking a taken cell does nothing",
          steps: [{ kind: "red-green", what: "a taken cell keeps its mark" }],
          files: [{ op: "~", path: "src/game.ts", why: "click ignores taken cells" }],
          checks: [{ name: "npm test", ok: true }],
        },
      },
    ] satisfies Beat[],
  };
}

export const styles = {
  python: inStyle(
    ["def tic_tac_toe():", "    board = [[None] * 3 for _ in range(3)]", "    turn = 'X'"],
    ["def tic_tac_toe():", "    board = [[None] * 3 for _ in range(3)]", "    turn = 'X'", "    def click(row, col):", "        board[row][col] = turn", "        turn = other(turn)"],
    ["def tic_tac_toe():", "    board = [[None] * 3 for _ in range(3)]", "    turn = 'X'", "    def click(row, col):", "        if board[row][col]: return", "        board[row][col] = turn", "        turn = other(turn)"],
  ),
  js: inStyle(
    ["ticTacToe {", "  board = grid(3, 3);", "  turn = 'X';", "}"],
    ["ticTacToe {", "  board = grid(3, 3);", "  turn = 'X';", "  click(cell) {", "    place(cell, turn);", "    turn = other(turn);", "  }", "}"],
    ["ticTacToe {", "  board = grid(3, 3);", "  turn = 'X';", "  click(cell) {", "    if (taken(cell)) return;", "    place(cell, turn);", "    turn = other(turn);", "  }", "}"],
  ),
  clojure: inStyle(
    ["(defgame tic-tac-toe", "  (board (grid 3 3))", "  (turn :x))"],
    ["(defgame tic-tac-toe", "  (board (grid 3 3))", "  (turn :x)", "  (on-click [cell]", "    (place! cell @turn)", "    (swap! turn other)))"],
    ["(defgame tic-tac-toe", "  (board (grid 3 3))", "  (turn :x)", "  (on-click [cell]", "    (ignore-when (taken? cell))", "    (place! cell @turn)", "    (swap! turn other)))"],
  ),
};
