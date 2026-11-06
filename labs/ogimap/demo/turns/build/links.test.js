import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/routes.js";

test("a link is shortened, followed and counted", () => {
  const made = route("POST", "/links", { url: "https://example.com" });
  assert.equal(made.status, 201);
  const code = made.json.code;
  assert.match(code, /^[a-z2-9]{6}$/);
  assert.deepEqual(route("GET", `/${code}`), { status: 302, location: "https://example.com" });
  assert.deepEqual(route("GET", `/${code}/stats`).json, { url: "https://example.com", visits: 1 });
});

test("only http links are shortened", () => {
  assert.equal(route("POST", "/links", { url: "javascript:alert(1)" }).status, 400);
});

test("an unknown code is a 404", () => {
  assert.equal(route("GET", "/nope").status, 404);
});

test("a link older than 7 days is gone: 410, no visit counted", (t) => {
  const code = route("POST", "/links", { url: "https://example.com" }).json.code;
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 7 * 24 * 60 * 60 * 1000 + 1);
  assert.deepEqual(route("GET", `/${code}`), { status: 410, json: { error: "link expired" } });
  assert.equal(route("GET", `/${code}/stats`).status, 410);
});

test("a link just under 7 days old still works", (t) => {
  const code = route("POST", "/links", { url: "https://example.com" }).json.code;
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 7 * 24 * 60 * 60 * 1000 - 1000);
  assert.equal(route("GET", `/${code}`).status, 302);
  assert.equal(route("GET", `/${code}/stats`).json.visits, 1);
});
