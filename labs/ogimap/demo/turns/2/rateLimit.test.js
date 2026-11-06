import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimit } from "../src/rateLimit.js";
import { route } from "../src/routes.js";

test("a client ip gets at most 10 shortens a minute", () => {
  let t = 0;
  const limit = createRateLimit({ now: () => t });
  for (let i = 0; i < 10; i++) assert.equal(limit.allow("1.1.1.1"), true);
  assert.equal(limit.allow("1.1.1.1"), false);
  assert.equal(limit.allow("2.2.2.2"), true, "other ips have their own budget");
  t = 59_999;
  assert.equal(limit.allow("1.1.1.1"), false);
  t = 60_000;
  assert.equal(limit.allow("1.1.1.1"), true, "a minute after the first shorten, one slot frees up");
});

test("over the limit, POST /links answers 429 slow down", () => {
  const ip = "9.9.9.9";
  for (let i = 0; i < 10; i++) assert.equal(route("POST", "/links", { url: "https://example.com" }, ip).status, 201);
  assert.deepEqual(route("POST", "/links", { url: "https://example.com" }, ip), { status: 429, json: { error: "slow down" } });
  assert.equal(route("POST", "/links", { url: "https://example.com" }, "8.8.8.8").status, 201);
});
