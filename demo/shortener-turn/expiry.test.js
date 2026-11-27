import { test } from "node:test";
import assert from "node:assert/strict";
import { shorten, follow, LIFETIME } from "../src/links.js";

test("a link older than 30 days is gone", () => {
  const { code } = shorten({ url: "https://example.com" }, 0).json;
  assert.equal(follow(code, LIFETIME).status, 302);
  assert.equal(follow(code, LIFETIME + 1).status, 410);
});
