import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCode } from "../src/codes.js";
import { store } from "../src/store.js";

// random() that always picks the first ALPHABET char → always "aaaaaa…".
const always = () => 0;

test("makeCode retries while store.find(code) exists", () => {
  let calls = 0;
  const firstTwoTaken = () => (calls++ < 12 ? 0 : 0.99); // two "aaaaaa" tries, then "999999"
  store.save("aaaaaa", "https://taken.example");
  assert.equal(makeCode(firstTwoTaken), "999999");
});

test("after 5 taken tries makeCode grows to 7 chars", () => {
  store.save("aaaaaa", "https://taken.example");
  assert.equal(makeCode(always), "aaaaaaa");
});

test("makeCode never returns a code already taken", () => {
  store.save("aaaaaa", "https://taken.example");
  store.save("aaaaaaa", "https://taken.example");
  assert.equal(makeCode(always), "aaaaaaaa");
});

test("a free 6-char code is returned as is", () => {
  assert.match(makeCode(), /^[a-z2-9]{6}$/);
});
