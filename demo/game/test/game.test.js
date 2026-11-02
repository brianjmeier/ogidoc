import { test } from "node:test";
import assert from "node:assert/strict";
import { click, newGame, status } from "../src/game.js";
import { winner } from "../src/winner.js";

const play = (...cells) => cells.reduce(click, newGame());

test("X then O fill two cells", () => {
  const g = play(0, 4);
  assert.deepEqual([g.board[0], g.board[4], g.turn], ["X", "O", "X"]);
});

test("a taken cell does nothing", () => {
  const g = play(0);
  assert.equal(click(g, 0), g);
});

test("X X X across the top -> X wins", () => {
  assert.equal(winner(["X", "X", "X", "O", "O", null, null, null, null]), "X");
  assert.equal(status(play(0, 3, 1, 4, 2)), "X wins");
});

test("a full board with no winner is a draw", () => {
  assert.equal(status(play(0, 1, 2, 4, 3, 5, 7, 6, 8)), "Draw");
});
