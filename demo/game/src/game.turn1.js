import { winner } from "./winner.js";

export const newGame = () => ({ board: Array(9).fill(null), turn: "X" });

// A taken cell, or a game that is over, does nothing.
export function click(game, cell) {
  if (game.board[cell] || over(game)) return game;
  return { board: game.board.with(cell, game.turn), turn: game.turn === "X" ? "O" : "X" };
}

export const over = (game) => winner(game.board) !== null;

export const status = (game) => (winner(game.board) ? `${winner(game.board)} wins` : `${game.turn}'s turn`);
