const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

// Six random characters, without the ones people misread (l, 1, o, 0).
export function makeCode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}
