import { store } from "./store.js";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const TRIES_PER_LENGTH = 5;

// Random characters, without the ones people misread (l, 1, o, 0).
function randomCode(length, random) {
  let code = "";
  for (let i = 0; i < length; i++) code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return code;
}

// A code no link has yet: six chars, retrying while taken; after 5 taken tries, one char longer.
export function makeCode(random = Math.random) {
  for (let length = 6; ; length++) {
    for (let tries = 0; tries < TRIES_PER_LENGTH; tries++) {
      const code = randomCode(length, random);
      if (!store.find(code)) return code;
    }
  }
}
